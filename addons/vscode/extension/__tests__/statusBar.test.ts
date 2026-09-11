/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {DiffSummaries} from 'isl-server/src/CodeReviewProvider';
import type {GerritDiffSummary} from 'isl-server/src/gerrit/gerritCodeReviewProvider';
import type {GitHubDiffSummary} from 'isl-server/src/github/githubCodeReviewProvider';
import type {MergeConflicts, RunnableOperation} from 'isl/src/types';
import type {SaplingCommitInfo} from '../api/types';

import {PullRequestState} from 'isl-server/src/github/generated/graphql';
import {CommandRunner, ConflictType} from 'isl/src/types';
import {buildPullStatusBarCommand, computeStatusBarInfoCommand} from '../statusBar';

const NO_SUMMARIES: DiffSummaries = new Map();

function makeCommit(overrides: Partial<SaplingCommitInfo> = {}): SaplingCommitInfo {
  return {
    title: 'Add feature',
    hash: 'abcdef0123456789',
    author: 'someone',
    date: new Date(),
    parents: [],
    phase: 'draft',
    isDot: true,
    description: 'Add feature',
    bookmarks: [],
    remoteBookmarks: [],
    filePathsSample: [],
    totalFileCount: 0,
    ...overrides,
  };
}

function makeOperation(overrides: Partial<RunnableOperation> = {}): RunnableOperation {
  return {
    args: ['pull'],
    id: 'op1',
    runner: CommandRunner.Sapling,
    trackEventName: 'PullOperation',
    ...overrides,
  };
}

describe('computeStatusBarInfoCommand', () => {
  it('returns undefined when nothing is loaded yet', () => {
    expect(
      computeStatusBarInfoCommand({
        conflicts: undefined,
        runningOperation: undefined,
        headCommit: undefined,
        diffSummaries: NO_SUMMARIES,
      }),
    ).toBeUndefined();
  });

  it('prioritizes unresolved merge conflicts over a running operation and the head commit', () => {
    const conflicts: MergeConflicts = {
      state: 'loaded',
      command: 'rebase',
      toContinue: 'rebase --continue',
      toAbort: 'rebase --abort',
      files: [
        {path: 'a.txt', status: 'U', conflictType: ConflictType.BothChanged},
        {path: 'b.txt', status: 'Resolved', conflictType: ConflictType.BothChanged},
      ],
      fetchStartTimestamp: 0,
      fetchCompletedTimestamp: 0,
    };
    const command = computeStatusBarInfoCommand({
      conflicts,
      runningOperation: makeOperation(),
      headCommit: makeCommit(),
      diffSummaries: NO_SUMMARIES,
    });
    expect(command?.command).toBe('sapling.open-isl');
    expect(command?.title).toContain('$(warning)');
    expect(command?.title).toContain('1');
  });

  it('shows a generic conflict message while conflicts are still loading', () => {
    const conflicts: MergeConflicts = {state: 'loading'} as MergeConflicts;
    const command = computeStatusBarInfoCommand({
      conflicts,
      runningOperation: undefined,
      headCommit: undefined,
      diffSummaries: NO_SUMMARIES,
    });
    expect(command?.title).toBe('$(warning) Merge conflicts');
  });

  it('shows a running operation over the head commit when there are no conflicts', () => {
    const command = computeStatusBarInfoCommand({
      conflicts: undefined,
      runningOperation: makeOperation({args: ['rebase', '-d', 'main']}),
      headCommit: makeCommit(),
      diffSummaries: NO_SUMMARIES,
    });
    expect(command?.title).toBe('$(sync~spin) rebase');
  });

  it('falls back to the track event name when the operation has no leading string arg', () => {
    const command = computeStatusBarInfoCommand({
      conflicts: undefined,
      runningOperation: makeOperation({
        args: [{type: 'config', key: 'ui.foo', value: 'bar'}],
        trackEventName: 'CommitOperation',
      }),
      headCommit: undefined,
      diffSummaries: NO_SUMMARIES,
    });
    expect(command?.title).toBe('$(sync~spin) Commit');
  });

  it('prefers a bookmark name over the short hash for the head commit', () => {
    const command = computeStatusBarInfoCommand({
      conflicts: undefined,
      runningOperation: undefined,
      headCommit: makeCommit({bookmarks: ['my-feature'], hash: 'abcdef0123456789'}),
      diffSummaries: NO_SUMMARIES,
    });
    expect(command?.title).toBe('$(git-commit) my-feature');
  });

  it('falls back to short hash + truncated title when there is no bookmark', () => {
    const command = computeStatusBarInfoCommand({
      conflicts: undefined,
      runningOperation: undefined,
      headCommit: makeCommit({hash: 'abcdef0123456789', title: 'A short title'}),
      diffSummaries: NO_SUMMARIES,
    });
    expect(command?.title).toContain('A short title');
    expect(command?.title).not.toContain('abcdef0123456789');
  });

  it('appends github review status for the head commit diff', () => {
    const summary: GitHubDiffSummary = {
      type: 'github',
      title: 'Add feature',
      commitMessage: 'Add feature',
      state: PullRequestState.Open,
      number: '123',
      url: 'https://github.com/foo/bar/pull/123',
      commentCount: 0,
      anyUnresolvedComments: false,
    };
    const diffSummaries: DiffSummaries = new Map([['123', summary]]);
    const command = computeStatusBarInfoCommand({
      conflicts: undefined,
      runningOperation: undefined,
      headCommit: makeCommit({bookmarks: ['my-feature'], diffId: '123'}),
      diffSummaries,
    });
    expect(command?.title).toBe('$(git-commit) my-feature  $(git-pull-request) Open');
  });

  it('appends gerrit review status for the head commit diff', () => {
    const summary: GerritDiffSummary = {
      type: 'gerrit',
      title: 'Add feature',
      commitMessage: 'Add feature',
      state: 'MERGED',
      number: '456',
      url: 'https://gerrit.example.com/c/456',
      codeReview: 'approved',
      commentCount: 0,
      anyUnresolvedComments: false,
      submittable: true,
      isWorkInProgress: false,
      isPrivate: false,
    };
    const diffSummaries: DiffSummaries = new Map([['456', summary]]);
    const command = computeStatusBarInfoCommand({
      conflicts: undefined,
      runningOperation: undefined,
      headCommit: makeCommit({bookmarks: ['my-feature'], diffId: '456'}),
      diffSummaries,
    });
    expect(command?.title).toBe('$(git-commit) my-feature  $(git-merge) Merged');
  });

  it('does not show review status when the diff summary has not been fetched yet', () => {
    const command = computeStatusBarInfoCommand({
      conflicts: undefined,
      runningOperation: undefined,
      headCommit: makeCommit({bookmarks: ['my-feature'], diffId: '999'}),
      diffSummaries: NO_SUMMARIES,
    });
    expect(command?.title).toBe('$(git-commit) my-feature');
  });
});

describe('buildPullStatusBarCommand', () => {
  it('binds the sync command to the given source control', () => {
    const sourceControl = {id: 'sapling'} as never;
    const command = buildPullStatusBarCommand(sourceControl);
    expect(command.command).toBe('sapling.pull');
    expect(command.arguments).toEqual([sourceControl]);
  });
});
