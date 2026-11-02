/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {DiffId, DiffSummary, Hash} from '../types';

import {cleanupOperations, isStackEligibleForCleanup} from '../Cleanup';
import {GerritUICodeReviewProvider} from '../codeReview/GerritUICodeReviewProvider';
import {Dag, DagCommitInfo} from '../dag/dag';

/**
 * A linear stack on a public root: each commit's hash, diffId, whether it is obsolete and
 * whether it is checked out. The public root may carry remote bookmarks.
 */
function stackDag(
  commits: Array<{hash: Hash; diffId?: DiffId; obsolete?: boolean; isDot?: boolean}>,
  remoteBookmarks: Array<string> = [],
): Dag {
  return new Dag().add([
    DagCommitInfo.fromCommitInfo({hash: 'public', parents: [], phase: 'public', remoteBookmarks}),
    ...commits.map(({hash, diffId, obsolete, isDot}, i) =>
      DagCommitInfo.fromCommitInfo({
        hash,
        parents: [i === 0 ? 'public' : commits[i - 1].hash],
        phase: 'draft',
        diffId,
        isDot,
        successorInfo: obsolete ? {hash: `${hash}-succ`, type: 'amend'} : undefined,
      }),
    ),
  ]);
}

function summaries(states: Record<string, 'NEW' | 'MERGED' | 'ABANDONED'>) {
  return new Map<string, DiffSummary>(
    Object.entries(states).map(([id, state]) => [id, {type: 'gerrit', state} as DiffSummary]),
  );
}

const provider = new GerritUICodeReviewProvider({
  type: 'gerrit',
  remoteUrl: 'https://code.example.com/my-repo',
});

function argsOf(dag: Dag, roots: Array<Hash>, diffs: Map<string, DiffSummary>) {
  return cleanupOperations(roots, dag, diffs, provider).map(op => op.getArgs());
}

describe('cleanupOperations', () => {
  it('hides an abandoned stack', () => {
    const dag = stackDag([
      {hash: 'abandoned1', diffId: 'I1'},
      {hash: 'abandoned2', diffId: 'I2'},
    ]);
    expect(argsOf(dag, ['abandoned1'], summaries({I1: 'ABANDONED', I2: 'ABANDONED'}))).toEqual([
      ['hide', '--rev', {type: 'succeedable-revset', revset: 'abandoned1'}],
    ]);
  });

  it('pulls instead of hiding a stack that landed but is not marked as landed yet', () => {
    const dag = stackDag([
      {hash: 'landed1', diffId: 'I1'},
      {hash: 'landed2', diffId: 'I2'},
    ]);
    expect(argsOf(dag, ['landed1'], summaries({I1: 'MERGED', I2: 'MERGED'}))).toEqual([['pull']]);
  });

  it('hides a stack that is still there after its pull', () => {
    const dag = stackDag([{hash: 'kept1', diffId: 'I1'}]);
    const diffs = summaries({I1: 'MERGED'});
    expect(argsOf(dag, ['kept1'], diffs)).toEqual([['pull']]);
    expect(argsOf(dag, ['kept1'], diffs)).toEqual([
      ['hide', '--rev', {type: 'succeedable-revset', revset: 'kept1'}],
    ]);
  });

  it('pulls, then hides by exact hash, a stack with landed and abandoned commits', () => {
    const dag = stackDag([
      {hash: 'mixed1', diffId: 'I1'},
      {hash: 'mixed2', diffId: 'I2'},
    ]);
    expect(argsOf(dag, ['mixed1'], summaries({I1: 'MERGED', I2: 'ABANDONED'}))).toEqual([
      ['pull'],
      ['hide', '--rev', {type: 'exact-revset', revset: 'mixed1'}],
    ]);
  });

  it('pulls once for several stacks', () => {
    const dag = new Dag().add([
      DagCommitInfo.fromCommitInfo({hash: 'public', parents: [], phase: 'public'}),
      DagCommitInfo.fromCommitInfo({hash: 'x', parents: ['public'], diffId: 'I1'}),
      DagCommitInfo.fromCommitInfo({hash: 'y', parents: ['public'], diffId: 'I2'}),
      DagCommitInfo.fromCommitInfo({hash: 'z', parents: ['public'], diffId: 'I3'}),
    ]);
    expect(
      argsOf(dag, ['x', 'y', 'z'], summaries({I1: 'MERGED', I2: 'MERGED', I3: 'ABANDONED'})),
    ).toEqual([['pull'], ['hide', '--rev', {type: 'succeedable-revset', revset: 'z'}]]);
  });

  it('hides commits already marked as landed', () => {
    const dag = stackDag([{hash: 'marked1', diffId: 'I1', obsolete: true}]);
    expect(argsOf(dag, ['marked1'], summaries({I1: 'MERGED'}))).toEqual([
      ['hide', '--rev', {type: 'exact-revset', revset: 'marked1'}],
    ]);
  });

  it('pulls, then moves to the base bookmark, for a landed stack you are checked out on', () => {
    const dag = stackDag(
      [
        {hash: 'onLanded1', diffId: 'I1'},
        {hash: 'onLanded2', diffId: 'I2', isDot: true},
      ],
      ['remote/main'],
    );
    expect(argsOf(dag, ['onLanded1'], summaries({I1: 'MERGED', I2: 'MERGED'}))).toEqual([
      ['pull'],
      ['goto', '--rev', {type: 'succeedable-revset', revset: 'remote/main'}],
    ]);
  });

  it('moves to the base, then hides, an abandoned stack you are checked out on', () => {
    const dag = stackDag([{hash: 'onAbandoned1', diffId: 'I1', isDot: true}]);
    expect(argsOf(dag, ['onAbandoned1'], summaries({I1: 'ABANDONED'}))).toEqual([
      ['goto', '--rev', {type: 'exact-revset', revset: 'public'}],
      ['hide', '--rev', {type: 'succeedable-revset', revset: 'onAbandoned1'}],
    ]);
  });
});

describe('isStackEligibleForCleanup', () => {
  it('allows a landed stack you are checked out on', () => {
    const dag = stackDag([{hash: 'dot1', diffId: 'I1', isDot: true}]);
    expect(isStackEligibleForCleanup('dot1', dag, summaries({I1: 'MERGED'}), provider)).toBe(true);
  });

  it('refuses a stack with an open diff', () => {
    const dag = stackDag([
      {hash: 'open1', diffId: 'I1'},
      {hash: 'open2', diffId: 'I2'},
    ]);
    expect(
      isStackEligibleForCleanup('open1', dag, summaries({I1: 'MERGED', I2: 'NEW'}), provider),
    ).toBe(false);
  });
});
