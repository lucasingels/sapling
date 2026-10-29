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

function gerritSummary(
  state: 'NEW' | 'MERGED' | 'ABANDONED',
  currentRevision?: Hash,
  rebasedRevisions?: Array<Hash>,
): DiffSummary {
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
    currentRevision,
    rebasedRevisions,
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

    it('publishes the whole stack when a not-yet-pushed commit sits on top of an open change', () => {
      const dag = stackDag([
        {hash: 'a', diffId: 'Ia' as DiffId},
        {hash: 'b', diffId: 'Ib' as DiffId},
      ]);
      const actions = provider.getSupportedStackActions(
        'a',
        dag,
        summaries([['Ia' as DiffId, 'NEW']]),
      );
      // Republishing would push only up to a and leave b behind.
      expect(hashes(actions.resubmittableStack)).toEqual([]);
      expect(hashes(actions.submittableStack)).toEqual(['a', 'b']);
    });

    it('publishes the whole stack when an unpublished commit sits below an open change', () => {
      const dag = stackDag([
        {hash: 'a', diffId: 'Ia' as DiffId},
        {hash: 'b', diffId: 'Ib' as DiffId},
      ]);
      const actions = provider.getSupportedStackActions(
        'a',
        dag,
        summaries([['Ib' as DiffId, 'NEW']]),
      );
      expect(hashes(actions.resubmittableStack)).toEqual([]);
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

    describe('compared with the uploaded patchsets', () => {
      const dag = stackDag([
        {hash: 'a', diffId: 'Ia' as DiffId},
        {hash: 'b', diffId: 'Ib' as DiffId},
      ]);
      const uploaded = (revisions: [Hash, Hash]) =>
        new Map<DiffId, DiffSummary>([
          ['Ia' as DiffId, gerritSummary('NEW', revisions[0])],
          ['Ib' as DiffId, gerritSummary('NEW', revisions[1])],
        ]);

      it("offers nothing when every commit is its change's latest patchset", () => {
        expect(provider.getSupportedStackActions('a', dag, uploaded(['a', 'b']))).toEqual({});
      });

      it('offers a new patchset once any commit differs from what was uploaded', () => {
        const actions = provider.getSupportedStackActions('a', dag, uploaded(['a', 'old-b']));
        expect(hashes(actions.resubmittableStack)).toEqual(['a', 'b']);
      });

      it('offers nothing when the only difference is a rebase of the uploaded patchsets', () => {
        const rebased = new Map<DiffId, DiffSummary>([
          ['Ia' as DiffId, gerritSummary('NEW', 'old-a', ['a'])],
          ['Ib' as DiffId, gerritSummary('NEW', 'old-b', ['b'])],
        ]);
        expect(provider.getSupportedStackActions('a', dag, rebased)).toEqual({});
      });

      it('still offers to publish a new commit on top of an uploaded stack', () => {
        const withNewTop = stackDag([
          {hash: 'a', diffId: 'Ia' as DiffId},
          {hash: 'b', diffId: 'Ib' as DiffId},
          {hash: 'c', diffId: 'Ic' as DiffId},
        ]);
        const actions = provider.getSupportedStackActions('a', withNewTop, uploaded(['a', 'b']));
        expect(hashes(actions.submittableStack)).toEqual(['a', 'b', 'c']);
        // Republishing would push only up to b, which is unchanged, and leave c behind.
        expect(hashes(actions.resubmittableStack)).toEqual([]);
      });

      it('offers nothing when the only change not up to date is merged and not yet pulled', () => {
        const withMergedBase = stackDag([
          {hash: 'm', diffId: 'Im' as DiffId},
          {hash: 'a', diffId: 'Ia' as DiffId},
          {hash: 'b', diffId: 'Ib' as DiffId},
        ]);
        const summaries = uploaded(['a', 'b']);
        summaries.set('Im' as DiffId, gerritSummary('MERGED', 'm'));
        expect(provider.getSupportedStackActions('m', withMergedBase, summaries)).toEqual({});
      });
    });
  });

  describe('getSyncStatuses', () => {
    it('marks commits by whether they are the latest uploaded patchset or a rebase of it', () => {
      const commits = [
        {hash: 'a', diffId: 'Ia'},
        {hash: 'b', diffId: 'Ib'},
        {hash: 'c', diffId: 'Ic'},
        {hash: 'd'},
        {hash: 'e', diffId: 'Ie'},
      ] as Array<CommitInfo>;
      const statuses = provider.getSyncStatuses(
        commits,
        new Map<DiffId, DiffSummary>([
          ['Ia' as DiffId, gerritSummary('NEW', 'a')],
          ['Ib' as DiffId, gerritSummary('NEW', 'old-b')],
          // Gerrit did not report a revision, or the change is closed: unknown.
          ['Ic' as DiffId, gerritSummary('MERGED', 'c')],
          ['Ie' as DiffId, gerritSummary('NEW', 'old-e', ['e'])],
        ]),
      );
      expect([...statuses.entries()]).toEqual([
        ['a', 'inSync'],
        ['b', 'localIsNewer'],
        ['e', 'inSync'],
      ]);
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
