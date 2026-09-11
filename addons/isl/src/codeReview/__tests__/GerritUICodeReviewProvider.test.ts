/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommitInfo, DiffId, DiffSummary, Hash} from '../../types';

import {Dag, DagCommitInfo} from '../../dag/dag';
import {GerritUICodeReviewProvider} from '../GerritUICodeReviewProvider';

function commit(diffId?: DiffId): CommitInfo {
  return {diffId} as CommitInfo;
}

/**
 * A linear stack `a -- b -- c ...` on top of a public root, one entry per
 * commit: its hash, the diffId the commit-msg hook stamped on it, and whether
 * it has been obsoleted.
 */
function stackDag(commits: Array<{hash: Hash; diffId?: DiffId; obsolete?: boolean}>): Dag {
  const root = DagCommitInfo.fromCommitInfo({
    hash: 'public',
    parents: [],
    phase: 'public',
  });
  return new Dag().add([
    root,
    ...commits.map(({hash, diffId, obsolete}, i) =>
      DagCommitInfo.fromCommitInfo({
        hash,
        parents: [i === 0 ? 'public' : commits[i - 1].hash],
        phase: 'draft',
        diffId,
        successorInfo: obsolete ? {hash: `${hash}-succ`, type: 'amend'} : undefined,
      }),
    ),
  ]);
}

function hashes(commits?: Array<CommitInfo>): Array<Hash> {
  return (commits ?? []).map(c => c.hash);
}

function gerritSummary(state: 'NEW' | 'MERGED' | 'ABANDONED'): DiffSummary {
  return {
    type: 'gerrit',
    title: '',
    commitMessage: '',
    state,
    number: '1',
    url: '',
    codeReview: null,
    commentCount: 0,
    anyUnresolvedComments: false,
    submittable: false,
    isWorkInProgress: false,
    isPrivate: false,
  } as DiffSummary;
}

describe('GerritUICodeReviewProvider', () => {
  const provider = new GerritUICodeReviewProvider({
    type: 'gerrit',
    remoteUrl: 'https://code.example.com/my-repo',
  });

  describe('getSubmittableDiffs', () => {
    it('includes commits that have never been pushed (no diffId)', () => {
      const commits = [commit(undefined)];
      expect(provider.getSubmittableDiffs(commits, new Map())).toEqual(commits);
    });

    it('includes commits with a diffId not yet found on the server (never pushed)', () => {
      const commits = [commit('Iabc123' as DiffId)];
      // diffSummaries map has no entry for this diffId (loaded but not found, or still loading)
      expect(provider.getSubmittableDiffs(commits, new Map())).toEqual(commits);
    });

    it('includes commits whose change is still open (can push an update)', () => {
      const commits = [commit('Iabc123' as DiffId)];
      const summaries = new Map<DiffId, DiffSummary>([['Iabc123' as DiffId, gerritSummary('NEW')]]);
      expect(provider.getSubmittableDiffs(commits, summaries)).toEqual(commits);
    });

    it('excludes commits whose change is already merged', () => {
      const commits = [commit('Iabc123' as DiffId)];
      const summaries = new Map<DiffId, DiffSummary>([
        ['Iabc123' as DiffId, gerritSummary('MERGED')],
      ]);
      expect(provider.getSubmittableDiffs(commits, summaries)).toEqual([]);
    });

    it('excludes commits whose change is abandoned', () => {
      const commits = [commit('Iabc123' as DiffId)];
      const summaries = new Map<DiffId, DiffSummary>([
        ['Iabc123' as DiffId, gerritSummary('ABANDONED')],
      ]);
      expect(provider.getSubmittableDiffs(commits, summaries)).toEqual([]);
    });
  });

  describe('getSupportedStackActions', () => {
    const summaries = (entries: Array<[DiffId, 'NEW' | 'MERGED' | 'ABANDONED']>) =>
      new Map<DiffId, DiffSummary>(entries.map(([id, state]) => [id, gerritSummary(state)]));

    it('offers the whole stack when nothing has been pushed yet', () => {
      // A Change-Id is stamped at commit time, so having one is not being pushed.
      const dag = stackDag([
        {hash: 'a', diffId: 'Ia' as DiffId},
        {hash: 'b', diffId: 'Ib' as DiffId},
      ]);
      const actions = provider.getSupportedStackActions('a', dag, new Map());
      expect(hashes(actions.submittableStack)).toEqual(['a', 'b']);
      expect(hashes(actions.resubmittableStack)).toEqual([]);
    });

    it('offers a new patchset for a stack already up for review', () => {
      const dag = stackDag([
        {hash: 'a', diffId: 'Ia' as DiffId},
        {hash: 'b', diffId: 'Ib' as DiffId},
      ]);
      const actions = provider.getSupportedStackActions(
        'a',
        dag,
        summaries([
          ['Ia' as DiffId, 'NEW'],
          ['Ib' as DiffId, 'NEW'],
        ]),
      );
      expect(hashes(actions.resubmittableStack)).toEqual(['a', 'b']);
      expect(hashes(actions.submittableStack)).toEqual(['a', 'b']);
    });

    it('counts a not-yet-pushed commit on top of an open change as submittable only', () => {
      const dag = stackDag([
        {hash: 'a', diffId: 'Ia' as DiffId},
        {hash: 'b', diffId: 'Ib' as DiffId},
      ]);
      const actions = provider.getSupportedStackActions(
        'a',
        dag,
        summaries([['Ia' as DiffId, 'NEW']]),
      );
      expect(hashes(actions.resubmittableStack)).toEqual(['a']);
      expect(hashes(actions.submittableStack)).toEqual(['a', 'b']);
    });

    it('leaves out changes that are already merged or abandoned', () => {
      const dag = stackDag([
        {hash: 'a', diffId: 'Ia' as DiffId},
        {hash: 'b', diffId: 'Ib' as DiffId},
        {hash: 'c', diffId: 'Ic' as DiffId},
      ]);
      const actions = provider.getSupportedStackActions(
        'a',
        dag,
        summaries([
          ['Ia' as DiffId, 'MERGED'],
          ['Ib' as DiffId, 'ABANDONED'],
          ['Ic' as DiffId, 'NEW'],
        ]),
      );
      expect(hashes(actions.resubmittableStack)).toEqual(['c']);
      expect(hashes(actions.submittableStack)).toEqual(['c']);
    });

    it('leaves out obsolete commits, which a push would not send', () => {
      const dag = stackDag([{hash: 'a'}, {hash: 'b', obsolete: true}]);
      const actions = provider.getSupportedStackActions('a', dag, new Map());
      expect(hashes(actions.submittableStack)).toEqual(['a']);
    });

    it('starts from the commit it was asked about, not the root of the stack', () => {
      const dag = stackDag([{hash: 'a'}, {hash: 'b'}, {hash: 'c'}]);
      const actions = provider.getSupportedStackActions('b', dag, new Map());
      expect(hashes(actions.submittableStack)).toEqual(['b', 'c']);
    });
  });

  describe('submitOperation', () => {
    it('publishes the top of the stack, so `sl push` sends this stack and not `.`', () => {
      const stack = [{hash: 'a'}, {hash: 'b'}] as Array<CommitInfo>;
      const op = provider.submitOperation(stack);
      expect(op.getArgs()).toEqual([
        'gerrit',
        'publish',
        {type: 'succeedable-revset', revset: 'b'},
      ]);
    });

    it('passes --wip before the revision when publishing as a draft', () => {
      const op = provider.submitOperation([{hash: 'a'} as CommitInfo], {draft: true});
      expect(op.getArgs()).toEqual([
        'gerrit',
        'publish',
        '--wip',
        {type: 'succeedable-revset', revset: 'a'},
      ]);
    });

    it('falls back to the current stack when given no commits', () => {
      expect(provider.submitOperation([]).getArgs()).toEqual(['gerrit', 'publish']);
    });
  });
});
