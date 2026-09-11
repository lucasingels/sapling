/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {DiffSummaries} from 'isl-server/src/CodeReviewProvider';
import type {DiffSummary, MergeConflicts, RunnableOperation} from 'isl/src/types';
import type {SaplingCommitInfo} from './api/types';

import type * as vscode from 'vscode';

import {PullRequestState} from 'isl-server/src/github/generated/graphql';
import {short} from 'isl/src/utils';
import {truncate} from 'shared/utils';
import {t} from './i18n';

const OPEN_ISL_COMMAND = 'sapling.open-isl';

export type StatusBarRepoState = {
  conflicts: MergeConflicts | undefined;
  runningOperation: RunnableOperation | undefined;
  headCommit: SaplingCommitInfo | undefined;
  diffSummaries: DiffSummaries;
};

type ReviewStatus = {icon: string; label: string};

/**
 * Short human label for a code review summary, generic across providers.
 * Only github/gerrit are realistic in this OSS fork (Phabricator is Internal-only),
 * so anything else falls back to a generic "In review" label.
 */
function describeReviewStatus(summary: DiffSummary): ReviewStatus {
  if (summary.type === 'github') {
    switch (summary.state) {
      case PullRequestState.Open:
        return {icon: 'git-pull-request', label: t('Open')};
      case PullRequestState.Merged:
        return {icon: 'git-merge', label: t('Merged')};
      case PullRequestState.Closed:
        return {icon: 'git-pull-request-closed', label: t('Closed')};
      case 'DRAFT':
        return {icon: 'git-pull-request', label: t('Draft')};
      case 'MERGE_QUEUED':
        return {icon: 'git-pull-request', label: t('Merge Queued')};
    }
  } else if (summary.type === 'gerrit') {
    switch (summary.state) {
      case 'MERGED':
        return {icon: 'git-merge', label: t('Merged')};
      case 'ABANDONED':
        return {icon: 'git-pull-request-closed', label: t('Abandoned')};
      default:
        return {icon: 'git-pull-request', label: t('Open')};
    }
  }
  return {icon: 'git-pull-request', label: t('In review')};
}

/** Best-effort human name for a running operation, e.g. `pull`, `rebase`, `goto`. */
function operationLabel(op: RunnableOperation): string {
  const first = op.args[0];
  if (typeof first === 'string') {
    return first;
  }
  return op.trackEventName.replace(/Operation$/, '');
}

/**
 * Build the `vscode.Command` used to display repo state in a `SourceControl`'s
 * `statusBarCommands`. Priority order (most urgent first): unresolved merge conflicts,
 * a running `sl` operation, then the head commit (bookmark or short hash + title) with its
 * review status. Returns `undefined` when there's nothing loaded yet to show.
 */
export function computeStatusBarInfoCommand(state: StatusBarRepoState): vscode.Command | undefined {
  const {conflicts, runningOperation, headCommit, diffSummaries} = state;

  if (conflicts != null) {
    const unresolvedCount =
      conflicts.state === 'loaded'
        ? conflicts.files.filter(file => file.status === 'U').length
        : undefined;
    const title =
      unresolvedCount != null
        ? `$(warning) ${unresolvedCount} ${t('unresolved')}`
        : `$(warning) ${t('Merge conflicts')}`;
    return {
      command: OPEN_ISL_COMMAND,
      title,
      tooltip: t('This repository has unresolved merge conflicts. Click to open Interactive Smartlog.'),
    };
  }

  if (runningOperation != null) {
    const label = operationLabel(runningOperation);
    return {
      command: OPEN_ISL_COMMAND,
      title: `$(sync~spin) ${label}`,
      tooltip: t('Running "$op". Click to open Interactive Smartlog.').replace('$op', label),
    };
  }

  if (headCommit == null) {
    return undefined;
  }

  const commitLabel =
    headCommit.bookmarks[0] ?? `${short(headCommit.hash)} ${truncate(headCommit.title, 40)}`;
  const summary = headCommit.diffId != null ? diffSummaries.get(headCommit.diffId) : undefined;
  const review = summary != null ? describeReviewStatus(summary) : undefined;
  const reviewSuffix = review != null ? `  $(${review.icon}) ${review.label}` : '';

  const tooltipLines = [
    `${short(headCommit.hash)}: ${headCommit.title}`,
    ...(headCommit.bookmarks.length > 0
      ? [t('Bookmarks: $bookmarks').replace('$bookmarks', headCommit.bookmarks.join(', '))]
      : []),
    ...(review != null ? [review.label] : []),
    t('Click to open Interactive Smartlog.'),
  ];

  return {
    command: OPEN_ISL_COMMAND,
    title: `$(git-commit) ${commitLabel}${reviewSuffix}`,
    tooltip: tooltipLines.join('\n'),
  };
}

/**
 * The sync action for the status bar. This is a `statusBarCommands` entry rather than a
 * standalone `window.createStatusBarItem` so VS Code scopes and activates it the same way it
 * does for other SCM providers (e.g. builtin git's "Sync Changes"), with no bespoke
 * active-repo tracking on our side.
 */
export function buildPullStatusBarCommand(sourceControl: vscode.SourceControl): vscode.Command {
  return {
    command: 'sapling.pull',
    title: `$(sync) ${t('Pull')}`,
    tooltip: t('Pull the latest commits from the remote.'),
    arguments: [sourceControl],
  };
}
