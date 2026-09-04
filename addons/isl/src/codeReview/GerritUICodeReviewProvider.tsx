/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {GerritDiffSummary} from 'isl-server/src/gerrit/gerritCodeReviewProvider';
import type {JSX, ReactNode} from 'react';
import {GerritPublishOperation} from '../operations/GerritPublishOperation';
import type {Operation} from '../operations/Operation';
import type {Dag} from '../previews';
import type {CodeReviewSystem, CommitInfo, DiffId, DiffSummary, Hash} from '../types';
import type {UICodeReviewProvider} from './UICodeReviewProvider';
import type {SyncStatus} from './syncStatus';

import {Button} from 'isl-components/Button';
import {Icon} from 'isl-components/Icon';
import {Tooltip} from 'isl-components/Tooltip';
import {useAtomValue} from 'jotai';
import {useState} from 'react';
import {MS_PER_DAY} from 'shared/constants';
import serverAPI from '../ClientToServerAPI';
import {OSSCommitMessageFieldSchema} from '../CommitInfoView/OSSCommitMessageFieldsSchema';
import {t, T} from '../i18n';
import {showModal} from '../useModal';
import {allDiffSummaries, codeReviewProvider} from './CodeReviewInfo';
import './GerritBadge.css';

/**
 * Effective display status for a Gerrit change. `state` (MERGED/ABANDONED) is a
 * terminal Gerrit outcome and always wins; otherwise, for changes still open,
 * Private takes precedence over Work-In-Progress since it's the more restrictive
 * (and more surprising, if missed) of the two.
 */
type DisplayStatus = 'MERGED' | 'ABANDONED' | 'PRIVATE' | 'DRAFT' | 'NEW';

function displayStatusForSummary(summary: GerritDiffSummary): DisplayStatus {
  if (summary.state === 'MERGED' || summary.state === 'ABANDONED') {
    return summary.state;
  }
  if (summary.isPrivate) {
    return 'PRIVATE';
  }
  if (summary.isWorkInProgress) {
    return 'DRAFT';
  }
  return 'NEW';
}

function iconForStatus(status: DisplayStatus): string {
  switch (status) {
    case 'MERGED':
      return 'git-merge';
    case 'ABANDONED':
      return 'git-pull-request-closed';
    case 'PRIVATE':
      return 'lock';
    default:
      return 'git-pull-request';
  }
}

function badgeClass(status: DisplayStatus): string {
  return `gerrit-diff-status-${status}`;
}

function tooltipForSummary(summary: GerritDiffSummary): string {
  switch (displayStatusForSummary(summary)) {
    case 'MERGED':
      return t('Merged on Gerrit');
    case 'ABANDONED':
      return t('Abandoned on Gerrit');
    case 'PRIVATE':
      return t('Private on Gerrit');
    case 'DRAFT':
      return t('Work-in-progress on Gerrit');
    default:
      return t('Open on Gerrit');
  }
}

export class GerritUICodeReviewProvider implements UICodeReviewProvider {
  name = 'gerrit';
  label = t('Gerrit');

  constructor(public system: CodeReviewSystem & {type: 'gerrit'}) {}

  DiffBadgeContent({
    diff,
    children,
  }: {
    diff?: DiffSummary;
    children?: ReactNode;
    syncStatus?: SyncStatus;
  }): JSX.Element | null {
    if (diff != null && diff.type !== 'gerrit') {
      return null;
    }
    const summary = diff as GerritDiffSummary | undefined;
    const className = summary ? badgeClass(displayStatusForSummary(summary)) : 'gerrit-diff-status-NEW';
    const tooltip = summary ? tooltipForSummary(summary) : t('Click to open change in Gerrit');
    return (
      <div className="gerrit-diff-info">
        <div className={`gerrit-diff-status ${className}`}>
          <Tooltip title={tooltip} delayMs={500}>
            {summary && (
              <Icon
                className="gerrit-diff-badge-icon"
                icon={iconForStatus(displayStatusForSummary(summary))}
              />
            )}
            {summary && <GerritStateLabel summary={summary} />}
            {children}
          </Tooltip>
        </div>
        {summary && summary.state === 'NEW' && <GerritReviewDecision summary={summary} />}
      </div>
    );
  }

  formatDiffNumber(diffId: DiffId, summary?: DiffSummary): string {
    const gerritSummary = summary as GerritDiffSummary | undefined;
    return gerritSummary?.number ? `#${gerritSummary.number}` : `#${diffId.substring(0, 8)}`;
  }

  getSyncStatuses(
    _commits: CommitInfo[],
    _allDiffSummaries: Map<string, DiffSummary>,
  ): Map<string, SyncStatus> {
    return new Map();
  }

  RepoInfo = () => {
    let host = '';
    let project = '';
    try {
      const parsed = new URL(this.system.remoteUrl);
      host = parsed.hostname;
      project = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    } catch {}
    return (
      <span>
        {host}/{project}
      </span>
    );
  };

  getRemoteTrackingBranch(): string | null {
    return null;
  }

  getRemoteTrackingBranchFromDiffSummary(): string | null {
    return null;
  }

  isSplitSuggestionSupported(): boolean {
    return false;
  }

  submitOperation(_commits: Array<CommitInfo>, options?: {draft?: boolean}): Operation {
    return new GerritPublishOperation(options);
  }

  submitCommandName(): string {
    return 'gerrit publish';
  }

  submitButtonLabel(): string {
    return 'Publish';
  }

  hasSubmittedDiff(
    diffId: DiffId | undefined,
    summary: DiffSummary | null | undefined,
  ): boolean {
    // Gerrit stamps a Change-Id (our diffId) onto every commit at creation time
    // via the commit-msg hook, so a diffId alone does NOT mean the change has
    // been pushed for review. Only treat it as submitted once the change is
    // known to exist on the server (a non-null summary). `undefined` means the
    // summaries are still loading, so err towards "submitted" to avoid flashing
    // the inline button for changes that are actually already up for review.
    return diffId != null && summary !== null;
  }

  getSupportedStackActions(
    _hash: Hash,
    _dag: Dag,
    _diffSummaries: Map<string, DiffSummary>,
  ): {resubmittableStack?: Array<CommitInfo>; submittableStack?: Array<CommitInfo>} {
    return {};
  }

  getSubmittableDiffs(
    commits: Array<CommitInfo>,
    allDiffSummaries: Map<string, DiffSummary>,
  ): CommitInfo[] {
    // A commit is submittable if it's never been pushed (no summary on the server
    // yet — including still-loading, to avoid hiding the button on uncertainty),
    // or if it has but the change is still open (so re-submitting sends an update).
    return commits.filter(commit => {
      if (commit.diffId == null) {
        return true;
      }
      const summary = allDiffSummaries.get(commit.diffId) as GerritDiffSummary | undefined;
      return summary == null || (summary.state !== 'MERGED' && summary.state !== 'ABANDONED');
    });
  }

  isDiffClosed(summary: DiffSummary): boolean {
    return (summary as GerritDiffSummary).state === 'ABANDONED';
  }

  isDiffEligibleForCleanup(summary: DiffSummary): boolean {
    const s = summary as GerritDiffSummary;
    return s.state === 'MERGED' || s.state === 'ABANDONED';
  }

  getUpdateDiffActions(_summary: DiffSummary) {
    return [];
  }

  commitMessageFieldsSchema = OSSCommitMessageFieldSchema;
  // Gerrit supports WIP state on any push, not just the first one
  supportSubmittingAsDraft = 'always' as const;
  supportsUpdateMessage = false;
  supportBranchingPrs = false;
  enableMessageSyncing = false;
  supportsSuggestedReviewers = false;
  supportsComparingSinceLastSubmit = false;
  supportsRenderingMarkup = false;
  gotoDistanceWarningAgeCutoff = 30 * MS_PER_DAY;
}

function GerritReviewDecision({summary}: {summary: GerritDiffSummary}) {
  const {codeReview, codeReviewAttribution} = summary;
  let className: string;
  let label: JSX.Element;
  if (codeReview === 'rejected') {
    className = 'gerrit-review-decision-rejected';
    label = <T>Rejected</T>;
  } else if (codeReview === 'disliked') {
    className = 'gerrit-review-decision-needs-work';
    label = <T>Needs Work</T>;
  } else if (codeReview === 'approved') {
    className = 'gerrit-review-decision-approved';
    label = <T>Approved</T>;
  } else if (codeReview === 'recommended') {
    className = 'gerrit-review-decision-recommended';
    label = <T>Recommended</T>;
  } else {
    className = 'gerrit-review-decision-required';
    label = <T>Review Required</T>;
  }
  const pill = <span className={`gerrit-review-decision ${className}`}>{label}</span>;
  if (codeReviewAttribution == null) {
    return pill;
  }
  return (
    <Tooltip title={codeReviewAttribution} delayMs={500}>
      {pill}
    </Tooltip>
  );
}

function GerritStateLabel({summary}: {summary: GerritDiffSummary}) {
  switch (displayStatusForSummary(summary)) {
    case 'MERGED':
      return <T>Merged</T>;
    case 'ABANDONED':
      return <T>Abandoned</T>;
    case 'PRIVATE':
      return <T>Private</T>;
    case 'DRAFT':
      return <T>Draft</T>;
    default:
      return <T>Open</T>;
  }
}

/**
 * Top-bar button that appears when Gerrit has an auth error and disappears
 * once diffs load successfully. Completely self-contained — reads its own atoms.
 */
export function GerritSetupButton() {
  const provider = useAtomValue(codeReviewProvider);
  const summaries = useAtomValue(allDiffSummaries);

  if (provider?.name !== 'gerrit' || summaries.error == null) {
    return null;
  }

  const webUrl = provider.system.type === 'gerrit' ? (provider.system.webUrl ?? '') : '';

  return (
    <Tooltip title={t('Gerrit authentication required. Click to configure credentials.')} placement="bottom">
      <Button
        className="gerrit-setup-button"
        onClick={() =>
          showModal({
            type: 'custom',
            title: t('Configure Gerrit Credentials'),
            component: ({returnResultAndDismiss}) => (
              <GerritCredentialForm webUrl={webUrl} onDismiss={returnResultAndDismiss} />
            ),
          })
        }>
        <Icon icon="warning" slot="start" />
        <T>Gerrit</T>
      </Button>
    </Tooltip>
  );
}

export function GerritConfigureCredentialsButton({webUrl}: {webUrl: string}) {
  return (
    <Button
      onClick={() =>
        showModal({
          type: 'custom',
          title: t('Configure Gerrit Credentials'),
          component: ({returnResultAndDismiss}) => (
            <GerritCredentialForm webUrl={webUrl} onDismiss={returnResultAndDismiss} />
          ),
        })
      }>
      <T>Configure credentials</T>
    </Button>
  );
}

function GerritCredentialForm({
  webUrl,
  onDismiss,
}: {
  webUrl: string;
  onDismiss: (result: boolean) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    serverAPI.postMessage({type: 'gerritSetCredentials', webUrl, username, password});
    const result = await serverAPI.nextMessageMatching('gerritCredentialsResult', () => true);
    if (result.success) {
      serverAPI.postMessage({type: 'fetchDiffSummaries'});
      onDismiss(true);
    } else {
      setError(result.error ?? t('Invalid credentials'));
      setLoading(false);
    }
  };

  return (
    <div className="gerrit-credential-form">
      <p>
        <T>Enter your Gerrit HTTP password to authenticate.</T>{' '}
        {webUrl && (
          <a href={`${webUrl}/settings/#HTTPCredentials`} target="_blank" rel="noreferrer">
            <T>Generate HTTP password</T>
          </a>
        )}
      </p>
      <div className="gerrit-credential-fields">
        <input
          placeholder={t('Username')}
          value={username}
          onChange={e => setUsername(e.target.value)}
          disabled={loading}
          autoFocus
        />
        <input
          type="password"
          placeholder={t('HTTP password')}
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={loading}
          onKeyDown={e => e.key === 'Enter' && !loading && username && password && handleSubmit()}
        />
      </div>
      {error && <p className="gerrit-credential-error">{error}</p>}
      <div className="gerrit-credential-actions">
        <Button onClick={() => onDismiss(false)} disabled={loading}>
          <T>Cancel</T>
        </Button>
        <Button
          kind="primary"
          onClick={handleSubmit}
          disabled={loading || !username || !password}>
          {loading ? <T>Verifying...</T> : <T>Save</T>}
        </Button>
      </div>
    </div>
  );
}

