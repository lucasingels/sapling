/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  ClientToServerMessage,
  CodeReviewProviderSpecificClientToServerMessages,
  CodeReviewSystem,
  DiffComment,
  DiffId,
  DiffSignalSummary,
  Disposable,
  Result,
  ServerToClientMessage,
} from 'isl/src/types';
import type {CodeReviewProvider, DiffSummaries} from '../CodeReviewProvider';
import type {Logger} from '../logger';

import {execFile} from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import {TypedEventEmitter} from 'shared/TypedEventEmitter';
import {debounce} from 'shared/debounce';

/** Escape plain text for safe HTML embedding, preserving line breaks. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

/** File paths that are Gerrit meta-files, not real source files. */
const GERRIT_META_FILES = new Set(['/COMMIT_MSG', '/MERGE_LIST', '/PATCHSET_LEVEL']);

export type GerritDiffSummary = {
  type: 'gerrit';
  title: string;
  commitMessage: string;
  state: 'NEW' | 'MERGED' | 'ABANDONED';
  /** Numeric Gerrit change number, for URL construction and display. */
  number: DiffId;
  url: string;
  /** Target branch for this change (e.g. "main"). */
  branchName?: string;
  /** Gerrit's precedence-resolved Code-Review decision. */
  codeReview: 'approved' | 'rejected' | 'recommended' | 'disliked' | null;
  /** CI signal derived from the Verified label. */
  signalSummary?: DiffSignalSummary;
  /** Total number of comments on the change. */
  commentCount: number;
  /** Whether the change has unresolved comments. */
  anyUnresolvedComments: boolean;
  /** Whether the change is ready to submit, as reported by the Gerrit REST API. */
  submittable: boolean;
  /** Vote description of the dominant Code-Review vote (e.g. "Looks good to me, approved"). */
  codeReviewAttribution?: string;
};

type GerritCodeReviewSystem = CodeReviewSystem & {
  type: 'gerrit';
  remoteUrl: string;
  webUrl?: string;
};

type Credentials = {username: string; password: string};

/**
 * Look up credentials for a URL via the Git credential helper.
 * This delegates to whatever the user has configured (macOS Keychain,
 * Git Credential Manager, etc.) — no passwords in plain config.
 * Returns null if no credentials are found or the helper fails.
 */
function getCredentials(url: string): Promise<Credentials | null> {
  return new Promise(resolve => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    const input = `protocol=${parsed.protocol.replace(':', '')}\nhost=${parsed.host}\n\n`;
    const proc = execFile('git', ['credential', 'fill'], (err, stdout) => {
      if (err || !stdout) {
        resolve(null);
        return;
      }
      const get = (key: string) => stdout.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1] ?? '';
      const username = get('username');
      const password = get('password');
      resolve(username && password ? {username, password} : null);
    });
    proc.stdin?.end(input);
  });
}

/** Run `git credential approve` or `reject` for a given URL and credentials. */
function runGitCredential(
  action: 'approve' | 'reject',
  url: string,
  username: string,
  password: string,
): Promise<void> {
  return new Promise(resolve => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve();
      return;
    }
    const input = `protocol=${parsed.protocol.replace(':', '')}\nhost=${parsed.host}\nusername=${username}\npassword=${password}\n`;
    const proc = execFile('git', ['credential', action], () => resolve());
    proc.stdin?.end(input);
  });
}

/** Fetch a URL with optional Basic auth and return the response body. */
function fetchUrl(
  url: string,
  credentials?: Credentials | null,
  timeoutMs = 8_000,
): Promise<string> {
  // Use Promise.race to guarantee the timeout fires even if the TCP connection
  // never establishes (req.setTimeout only fires after the socket is connected).
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Gerrit REST request timed out')), timeoutMs),
  );
  const requestPromise = new Promise<string>((resolve, reject) => {
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: credentials
        ? {
            Authorization:
              'Basic ' +
              Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'),
          }
        : {},
    };
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(options, res => {
      const status = res.statusCode ?? 0;
      if (status === 401 || status === 403) {
        req.destroy();
        reject(
          new Error(
            `Gerrit authentication failed (HTTP ${status}). ` +
              `Generate an HTTP password at ${parsed.protocol}//${parsed.host}/settings/#HTTPCredentials`,
          ),
        );
        return;
      }
      if (status >= 400) {
        req.destroy();
        reject(new Error(`Gerrit REST request failed: HTTP ${status}`));
        return;
      }
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  return Promise.race([requestPromise, timeoutPromise]);
}

/**
 * Parse a Gerrit REST API JSON response, stripping the ")]}'" XSSI prefix.
 * Returns null if the response cannot be parsed as an array.
 */
function parseGerritJsonArray(raw: string): Array<Record<string, unknown>> | null {
  try {
    const stripped = raw.replace(/^\)\]}'\n/, '');
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) {
      return parsed as Array<Record<string, unknown>>;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Parse a Gerrit REST API JSON object response, stripping the ")]}'" XSSI prefix.
 * Returns null if the response cannot be parsed as an object.
 */
function parseGerritJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const stripped = raw.replace(/^\)\]}'\n/, '');
    const parsed = JSON.parse(stripped);
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

type LabelInfo = {
  all?: Array<{value?: number}>;
  /** Gerrit's precedence-correct shorthands from DETAILED_LABELS */
  approved?: Record<string, unknown>;
  rejected?: Record<string, unknown>;
  recommended?: Record<string, unknown>;
  disliked?: Record<string, unknown>;
  /** Human-readable descriptions keyed by formatted vote value (e.g. "+2", "-1", " 0") */
  values?: Record<string, string>;
};

/**
 * Returns Gerrit's precedence-resolved decision for a label.
 */
function labelDecision(label: LabelInfo | undefined): 'approved' | 'rejected' | 'recommended' | 'disliked' | null {
  if (label?.rejected != null) return 'rejected';
  if (label?.approved != null) return 'approved';
  if (label?.disliked != null) return 'disliked';
  if (label?.recommended != null) return 'recommended';
  return null;
}

/**
 * Returns the reviewer attribution (name + vote description) for the dominant
 * vote on a label, for use in tooltips. Uses Gerrit's precedence-resolved
 * shorthand fields to determine the vote value, then looks up the human-readable
 * description from the label's `values` map.
 */
function labelAttribution(label: LabelInfo | undefined): string | undefined {
  let voteKey: string;
  if (label?.rejected != null) {
    voteKey = '-2';
  } else if (label?.approved != null) {
    voteKey = '+2';
  } else if (label?.disliked != null) {
    voteKey = '-1';
  } else if (label?.recommended != null) {
    voteKey = '+1';
  } else {
    return undefined;
  }
  return label?.values?.[voteKey] ?? undefined;
}

/**
 * Derive host, project, and web URL from a Gerrit remote URL.
 * For SSH remotes (ssh://user@ssh.host:29418/project), strips the "ssh." prefix
 * to construct the HTTPS web URL. For HTTPS remotes, uses the origin directly.
 */
export function parseGerritRemote(remoteUrl: string): {
  host: string;
  project: string;
  webUrl: string;
} {
  let host = '';
  let project = '';
  let webUrl = '';
  try {
    const parsed = new URL(remoteUrl);
    host = parsed.hostname;
    project = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    webUrl =
      parsed.protocol === 'ssh:'
        ? `https://${host.replace(/^ssh\./, '')}`
        : `${parsed.protocol}//${parsed.host}`;
  } catch {
    // leave defaults
  }
  return {host, project, webUrl};
}

/**
 * Server-side Gerrit code review provider.
 *
 * Fetches change status and comments via the Gerrit REST API, authenticated
 * with credentials from the Git credential helper. The web URL is always
 * derived from the remote URL (SSH remotes have their "ssh." prefix stripped).
 * Follows the same TypedEventEmitter + debounce pattern as the GitHub provider.
 *
 * diffIds passed to triggerDiffSummariesFetch are Gerrit Change-Ids (e.g. "Iabc123…"),
 * extracted from commit descriptions by parseCommitInfoOutput in templates.ts.
 */
export class GerritCodeReviewProvider implements CodeReviewProvider {
  private diffSummaries = new TypedEventEmitter<'data', Map<DiffId, GerritDiffSummary>>();

  constructor(
    private codeReviewSystem: GerritCodeReviewSystem,
    private logger: Logger,
    _repoRoot: string, // kept for constructor-signature compatibility
  ) {}

  onChangeDiffSummaries(callback: (result: Result<DiffSummaries>) => unknown): Disposable {
    const handleData = (data: Map<DiffId, GerritDiffSummary>) => callback({value: data});
    const handleError = (error: Error) => callback({error});
    this.diffSummaries.on('data', handleData);
    this.diffSummaries.on('error', handleError);
    return {
      dispose: () => {
        this.diffSummaries.off('data', handleData);
        this.diffSummaries.off('error', handleError);
      },
    };
  }

  /**
   * Query the Gerrit REST API for the current user's changes and emit updated
   * summaries. Like the GitHub provider, this ignores the diffs argument and
   * fetches all owned changes so it works even before smartlog commits arrive.
   */
  triggerDiffSummariesFetch = debounce(
    async (_diffs: Array<DiffId>) => {
      try {
        const {project} = parseGerritRemote(this.codeReviewSystem.remoteUrl);
        const webUrl = this.getWebUrl();

        const credentials = await getCredentials(webUrl);

        // Fetch all open changes owned by the authenticated user for this project,
        // matching the GitHub provider's approach of fetching author:@me PRs.
        const query = credentials
          ? `owner:self+project:${encodeURIComponent(project)}+status:open`
          : `project:${encodeURIComponent(project)}+status:open`;
        // Use /a/ prefix when credentials are available — Gerrit authenticates Basic auth
        // only on the /a/ path; requests to /changes/ are treated as anonymous even with
        // an Authorization header.
        const changesBase = credentials ? `${webUrl}/a/changes/` : `${webUrl}/changes/`;
        const url = `${changesBase}?q=${query}&o=DETAILED_LABELS&o=SUBMIT_REQUIREMENTS`;
        this.logger.info(`Gerrit: fetching changes for project ${project} from REST API`);
        const raw = await fetchUrl(url, credentials);
        const results = parseGerritJsonArray(raw);

        if (results == null) {
          this.diffSummaries.emit(
            'error',
            new Error(
              'Gerrit: failed to parse REST API response — ' +
                `check that ${webUrl} is reachable and returns valid JSON`,
            ),
          );
          return;
        }

        // If we got no results back without credentials, Gerrit may be silently
        // filtering changes due to missing authentication (some instances return []
        // instead of 401 for unauthenticated requests).
        if (results.length === 0 && credentials == null) {
          this.diffSummaries.emit(
            'error',
            new Error(
              `Gerrit authentication required. ` +
                `Generate an HTTP password at ${webUrl}/settings/#HTTPCredentials ` +
                `and configure your credentials in ISL.`,
            ),
          );
          return;
        }

        const summaries = new Map<DiffId, GerritDiffSummary>();
        for (const change of results) {
          // The key is the Change-Id so the map matches the diffIds on commits.
          const changeId = change.change_id as string | undefined;
          if (!changeId) {
            continue;
          }
          const number = String(change._number ?? '');
          const status = (change.status as string | undefined) ?? 'NEW';
          const state: GerritDiffSummary['state'] =
            status === 'MERGED' ? 'MERGED' : status === 'ABANDONED' ? 'ABANDONED' : 'NEW';

          type LabelMap = Record<string, LabelInfo>;
          const rawLabels = (change.labels ?? {}) as LabelMap;
          const codeReview = labelDecision(rawLabels['Code-Review']);
          const codeReviewAttribution = labelAttribution(rawLabels['Code-Review']);

          let signalSummary: DiffSignalSummary | undefined;
          if (rawLabels['Verified'] != null) {
            const verified = labelDecision(rawLabels['Verified']);
            signalSummary = verified === 'approved' || verified === 'recommended'
              ? 'pass'
              : verified === 'rejected' || verified === 'disliked'
              ? 'failed'
              : 'no-signal';
          }

          const commentCount =
            typeof change.total_comment_count === 'number' ? change.total_comment_count : 0;
          const unresolvedCount =
            typeof change.unresolved_comment_count === 'number'
              ? change.unresolved_comment_count
              : 0;
          const branchName = typeof change.branch === 'string' ? change.branch : undefined;

          summaries.set(changeId, {
            type: 'gerrit',
            title: (change.subject as string | undefined) ?? '',
            commitMessage: '',
            state,
            number,
            url: this.changeUrl(Number(number), project),
            branchName,
            codeReview,
            codeReviewAttribution,
            signalSummary,
            commentCount,
            anyUnresolvedComments: unresolvedCount > 0,
            submittable: Boolean(change.submittable),
          });
        }

        this.logger.info(`Gerrit: fetched ${summaries.size} change(s)`);
        this.diffSummaries.emit('data', summaries);
      } catch (err) {
        this.logger.warn(`Gerrit: failed to fetch changes: ${err}`);
        this.diffSummaries.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    },
    2000,
    undefined,
    /* leading */ true,
  );

  async fetchComments(diffId: DiffId): Promise<Array<DiffComment>> {
    const webUrl = this.getWebUrl();
    const credentials = await getCredentials(webUrl);
    const changesBase = credentials ? `${webUrl}/a/changes/` : `${webUrl}/changes/`;
    const url = `${changesBase}${encodeURIComponent(diffId)}/comments`;

    let raw: string;
    try {
      raw = await fetchUrl(url, credentials);
    } catch (err) {
      this.logger.warn(`Gerrit: fetchComments failed: ${err}`);
      return [];
    }

    const parsed = parseGerritJsonObject(raw);
    if (parsed == null) {
      return [];
    }

    type RawComment = {
      id?: string;
      author?: {name?: string; email?: string};
      message?: string;
      line?: number;
      updated?: string;
      unresolved?: boolean;
    };

    const comments: Array<DiffComment> = [];
    for (const [filename, fileComments] of Object.entries(parsed)) {
      if (GERRIT_META_FILES.has(filename)) {
        continue;
      }
      for (const c of fileComments as Array<RawComment>) {
        comments.push({
          id: c.id,
          author: c.author?.name ?? c.author?.email ?? '',
          html: escapeHtml(c.message ?? ''),
          content: c.message,
          created: c.updated ? new Date(c.updated) : new Date(0),
          filename,
          line: c.line,
          reactions: [],
          replies: [],
          // Gerrit REST: unresolved=true means still open, unresolved=false means resolved
          isResolved: c.unresolved == null ? undefined : !c.unresolved,
        });
      }
    }
    return comments;
  }

  /** Returns the effective web URL: gerrit.url config takes priority over the derived URL. */
  private getWebUrl(): string {
    return (
      this.codeReviewSystem.webUrl ?? parseGerritRemote(this.codeReviewSystem.remoteUrl).webUrl
    );
  }

  private changeUrl(number: number, project: string): string {
    return `${this.getWebUrl()}/c/${project}/+/${number}`;
  }

  handleClientToServerMessage(
    message: ClientToServerMessage,
    postMessage: (message: ServerToClientMessage) => void,
  ): message is CodeReviewProviderSpecificClientToServerMessages {
    if (message.type === 'gerritSetCredentials') {
      const {webUrl, username, password} = message;
      const credentials = {username, password};
      fetchUrl(`${webUrl}/a/accounts/self`, credentials)
        .then(async () => {
          await runGitCredential('approve', webUrl, username, password);
          postMessage({type: 'gerritCredentialsResult', success: true});
          // The client will re-send fetchDiffSummaries on success
        })
        .catch(async err => {
          await runGitCredential('reject', webUrl, username, password);
          postMessage({
            type: 'gerritCredentialsResult',
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }
    return false;
  }

  dispose(): void {
    this.diffSummaries.removeAllListeners();
    this.triggerDiffSummariesFetch.dispose();
  }

  getSummaryName(): string {
    const {host, project} = parseGerritRemote(this.codeReviewSystem.remoteUrl);
    return `gerrit:${host}/${project}`;
  }

  getDiffUrlMarkdown(diffId: DiffId): string {
    return `[${diffId.substring(0, 8)}](${this.getWebUrl()}/q/${diffId})`;
  }

  getCommitHashUrlMarkdown(hash: string): string {
    return `\`${hash.slice(0, 12)}\``;
  }
}
