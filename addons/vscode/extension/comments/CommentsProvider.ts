/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Logger} from 'isl-server/src/logger';
import type {DiffComment, DiffCommentReaction} from 'isl/src/types';
import type {VSCodeRepo, VSCodeReposList} from '../VSCodeRepo';

import * as vscode from 'vscode';
import {t} from '../i18n';

const CONFIG_KEY = 'sapling.showDiffComments';

const REACTION_EMOJI: Record<DiffCommentReaction['reaction'], string> = {
  LIKE: '👍',
  WOW: '😮',
  SORRY: '🤗',
  LOVE: '❤️',
  HAHA: '😆',
  ANGER: '😡',
  SAD: '😢',
  // GitHub reactions
  CONFUSED: '😕',
  EYES: '👀',
  HEART: '❤️',
  HOORAY: '🎉',
  LAUGH: '😄',
  ROCKET: '🚀',
  THUMBS_DOWN: '👎',
  THUMBS_UP: '👍',
};

/**
 * `DiffComment.line` is 1-based in both providers: Gerrit's `fetchComments` copies it straight
 * from the Gerrit REST comments API's `line` field (1-based), and GitHub's copies
 * `PullRequestReviewComment.line`, GitHub's 1-based diff line number. `openFile.ts` already
 * relies on this (`line - 1`) when jumping to a comment from the ISL webview, so we convert the
 * same way here. `vscode.Range`/`vscode.Position` are 0-based.
 */
function toZeroIndexedLine(line: number): number {
  return line - 1;
}

/** Flattens a comment and its (possibly nested) replies into one chronological list for a single thread. */
function flattenWithReplies(comment: DiffComment): Array<DiffComment> {
  return [comment, ...comment.replies.flatMap(flattenWithReplies)];
}

/**
 * `content` is provider-supplied plain text (Gerrit always sets it, copied straight from the raw
 * comment message). `html` (e.g. GitHub's `bodyHTML`) is real HTML: rendering it as a
 * `MarkdownString` wouldn't execute it, but also wouldn't render it as intended, and sanitizing
 * arbitrary HTML ourselves is out of scope for a read-only viewer. So when `content` is missing,
 * fall back to a plain-text rendering of `html` with tags stripped, rather than rendering it as
 * either raw HTML or as Markdown.
 */
function commentBody(comment: DiffComment): string {
  return comment.content ?? comment.html.replace(/<[^>]+>/g, '');
}

function emojiIconUri(emoji: string): vscode.Uri {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">` +
    `<text y="13" font-size="13">${emoji}</text></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

/** Reactions are display-only: there is no write API to toggle them, so no `reactionHandler` is registered. */
function toCommentReactions(
  reactions: ReadonlyArray<DiffCommentReaction>,
): Array<vscode.CommentReaction> | undefined {
  if (reactions.length === 0) {
    return undefined;
  }
  const counts = new Map<DiffCommentReaction['reaction'], number>();
  for (const reaction of reactions) {
    counts.set(reaction.reaction, (counts.get(reaction.reaction) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reaction, count]) => ({
    label: reaction,
    iconPath: emojiIconUri(REACTION_EMOJI[reaction]),
    count,
    authorHasReacted: false,
  }));
}

export function toVSCodeComment(comment: DiffComment): vscode.Comment {
  return {
    body: commentBody(comment),
    mode: vscode.CommentMode.Preview,
    author: {
      name: comment.authorName ?? comment.author,
      iconPath:
        comment.authorAvatarUri == null ? undefined : vscode.Uri.parse(comment.authorAvatarUri),
    },
    timestamp: comment.created,
    reactions: toCommentReactions(comment.reactions),
  };
}

/**
 * `isResolved` is deliberately tri-state: `true`/`false` map to a resolved/unresolved thread
 * state; `undefined` (not resolvable) means no resolution UI should be shown at all, so `state`
 * is left unset in that case. If comments in the same thread disagree, prefer "unresolved" so an
 * open discussion isn't hidden as resolved.
 */
export function threadState(
  comments: ReadonlyArray<DiffComment>,
): vscode.CommentThreadState | undefined {
  if (comments.some(comment => comment.isResolved === false)) {
    return vscode.CommentThreadState.Unresolved;
  }
  if (comments.some(comment => comment.isResolved === true)) {
    return vscode.CommentThreadState.Resolved;
  }
  return undefined;
}

export type InlineCommentLocation = {
  filename: string;
  /** 1-based, matching `DiffComment.line`. */
  line: number;
  comments: Array<DiffComment>;
};

/**
 * Groups comments (with their replies flattened in) by inline location (filename + line), so
 * multiple top-level comments at the same location become one thread rather than one each.
 *
 * Comments with no `filename`/`line` are diff-level (general PR/change comments, not attached to
 * a line of code), so they have no editor location to attach to. They're skipped here; the ISL
 * webview comment viewer (`DiffComments.tsx`) still shows them.
 */
export function groupCommentsByLocation(
  comments: ReadonlyArray<DiffComment>,
): Array<InlineCommentLocation> {
  const groups = new Map<string, InlineCommentLocation>();
  for (const comment of comments) {
    if (comment.filename == null || comment.line == null) {
      continue;
    }
    const key = `${comment.filename}:${comment.line}`;
    let group = groups.get(key);
    if (group == null) {
      group = {filename: comment.filename, line: comment.line, comments: []};
      groups.set(key, group);
    }
    group.comments.push(...flattenWithReplies(comment));
  }
  for (const group of groups.values()) {
    group.comments.sort((a, b) => a.created.getTime() - b.created.getTime());
  }
  return [...groups.values()];
}

/**
 * Renders Gerrit/GitHub code review comments as native `vscode.CommentThread`s in the editor
 * gutter, alongside (not replacing) the ISL webview's own comment viewer.
 *
 * Comments are read-only: `CodeReviewProvider.fetchComments` is the only comment API, there is no
 * post/reply/resolve method, so threads are created with `canReply = false` and no
 * `commentingRangeProvider`, meaning VS Code never offers a way to write a comment here.
 */
export class CommentsProvider implements vscode.Disposable {
  private controller: vscode.CommentController;
  private disposables: Array<vscode.Disposable> = [];
  private repoSubscription: vscode.Disposable;

  private threadsByRepo = new Map<VSCodeRepo, Array<vscode.CommentThread>>();
  private lastDiffIdByRepo = new Map<VSCodeRepo, string | undefined>();
  private generationByRepo = new Map<VSCodeRepo, number>();

  constructor(
    private reposList: VSCodeReposList,
    private logger: Logger,
  ) {
    this.controller = vscode.comments.createCommentController(
      'sapling.diffComments',
      t('Sapling Code Review Comments'),
    );

    this.disposables.push(
      vscode.commands.registerCommand('sapling.refresh-comments', () => this.refreshAll(true)),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(CONFIG_KEY)) {
          this.refreshAll(true);
        }
      }),
    );

    this.repoSubscription = this.reposList.subscribeWithinAllRepos(repo =>
      this.subscribeToRepo(repo),
    );
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(CONFIG_KEY, true) ?? true;
  }

  private refreshAll(force: boolean): void {
    for (const repo of this.reposList.getCurrentActiveRepos()) {
      this.refreshForRepo(repo, repo.getDotCommit()?.diffId, force);
    }
  }

  private subscribeToRepo(repo: VSCodeRepo): vscode.Disposable {
    const headSubscription = repo.onChangeDotCommit(head => {
      this.refreshForRepo(repo, head?.diffId);
    });
    this.refreshForRepo(repo, repo.getDotCommit()?.diffId);
    return new vscode.Disposable(() => {
      headSubscription.dispose();
      this.disposeThreadsForRepo(repo);
      this.lastDiffIdByRepo.delete(repo);
      this.generationByRepo.delete(repo);
    });
  }

  private async refreshForRepo(
    repo: VSCodeRepo,
    diffId: string | undefined,
    force: boolean = false,
  ): Promise<void> {
    if (!force && this.lastDiffIdByRepo.get(repo) === diffId) {
      return;
    }
    this.lastDiffIdByRepo.set(repo, diffId);

    // Threads are cleared eagerly (rather than only on success) so a stale thread is never left
    // pinned to the wrong line while the new head's comments are still loading.
    this.disposeThreadsForRepo(repo);

    if (!this.isEnabled() || diffId == null) {
      return;
    }
    const provider = repo.repo.codeReviewProvider;
    if (provider?.fetchComments == null) {
      return;
    }

    const generation = (this.generationByRepo.get(repo) ?? 0) + 1;
    this.generationByRepo.set(repo, generation);

    let comments: Array<DiffComment>;
    try {
      comments = await provider.fetchComments(diffId);
    } catch (err) {
      this.logger.warn(`Sapling: failed to fetch code review comments for ${diffId}: ${err}`);
      return;
    }

    // A newer refresh for this repo started (and will render) while this fetch was in flight.
    if (this.generationByRepo.get(repo) !== generation) {
      return;
    }

    const threads = groupCommentsByLocation(comments).map(location =>
      this.createThread(repo, location),
    );
    this.threadsByRepo.set(repo, threads);
  }

  private createThread(repo: VSCodeRepo, location: InlineCommentLocation): vscode.CommentThread {
    const uri = vscode.Uri.joinPath(repo.rootUri, location.filename);
    const line = toZeroIndexedLine(location.line);
    const range = new vscode.Range(line, 0, line, 0);
    const thread = this.controller.createCommentThread(
      uri,
      range,
      location.comments.map(toVSCodeComment),
    );
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    const state = threadState(location.comments);
    if (state != null) {
      thread.state = state;
    }
    return thread;
  }

  private disposeThreadsForRepo(repo: VSCodeRepo): void {
    for (const thread of this.threadsByRepo.get(repo) ?? []) {
      thread.dispose();
    }
    this.threadsByRepo.delete(repo);
  }

  dispose(): void {
    this.repoSubscription.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.controller.dispose();
  }
}
