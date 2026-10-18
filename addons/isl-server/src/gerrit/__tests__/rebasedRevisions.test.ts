/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {changedLines, RebasedRevisionFinder} from '../rebasedRevisions';

type FakeCommit = {
  node: string;
  phase: 'public' | 'draft';
  parent?: string;
  changeId?: string;
  message?: string;
  diff?: string;
  obsolete?: boolean;
  /** Known to the graph but its content is not local, so reading it aborts. */
  missingContent?: boolean;
};

const desc = (c: FakeCommit) =>
  `${c.message ?? 'title'}\n` + (c.changeId == null ? '' : `\nChange-Id: ${c.changeId}\n`);

function patch(lines: Array<string>, at = 1): string {
  return [
    'diff --git a/f b/f',
    '--- a/f',
    '+++ b/f',
    `@@ -${at},3 +${at},4 @@`,
    ' context',
    ...lines,
  ].join('\n');
}

/**
 * Answers the `sl log` and `sl diff` calls the finder makes from a list of commits, aborting
 * like sl does when one needs the content of a commit that is missing it.
 */
function fakeSl(commits: Array<FakeCommit>) {
  const byNode = new Map(commits.map(c => [c.node, c]));
  const json = (cs: Array<FakeCommit>) =>
    JSON.stringify(
      cs.map(c => ({
        node: c.node,
        phase: c.phase,
        desc: desc(c),
        parents: c.parent == null ? [] : [c.parent],
      })),
    );
  return jest.fn(async (args: Array<string>) => {
    const abortIfMissing = (cs: Array<FakeCommit>) => {
      const missing = cs.find(c => c.missingContent);
      if (missing != null) {
        throw new Error(`abort: 00changelog.i@${missing.node}: no node!`);
      }
      return cs;
    };
    if (args[0] === 'diff') {
      const commit = byNode.get(args[2]);
      return commit == null ? '' : (abortIfMissing([commit])[0].diff ?? '');
    }
    const revset = args[2];
    if (revset === 'draft() - obsolete()') {
      return json(commits.filter(c => c.phase === 'draft' && !c.obsolete));
    }
    const present = [...revset.matchAll(/present\(([^)]+)\)/g)]
      .map(m => byNode.get(m[1]))
      .filter((c): c is FakeCommit => c != null);
    if (args[3] === '-T') {
      return present.map(c => `${c.node} ${c.phase}\n`).join('');
    }
    return json(abortIfMissing(present));
  });
}

const IA = 'I' + 'a'.repeat(40);
const IB = 'I' + 'b'.repeat(40);

describe('changedLines', () => {
  it('ignores context lines and where the hunks fall', () => {
    expect(changedLines(patch(['+added'], 1))).toEqual(changedLines(patch(['+added'], 40)));
  });

  it('tells apart different changes', () => {
    expect(changedLines(patch(['+added']))).not.toEqual(changedLines(patch(['+other'])));
  });
});

describe('RebasedRevisionFinder', () => {
  // A two-commit stack published on old trunk, then rebased onto new trunk.
  const base: Array<FakeCommit> = [
    {node: 'old-trunk', phase: 'public'},
    {node: 'new-trunk', phase: 'public', parent: 'old-trunk'},
    {
      node: 'up-a',
      phase: 'draft',
      parent: 'old-trunk',
      changeId: IA,
      diff: patch(['+a']),
      obsolete: true,
    },
    {
      node: 'up-b',
      phase: 'draft',
      parent: 'up-a',
      changeId: IB,
      diff: patch(['+b']),
      obsolete: true,
    },
  ];
  const uploaded = new Map([
    [IA, 'up-a'],
    [IB, 'up-b'],
  ]);

  it('finds a stack moved onto newer trunk with nothing else changed', async () => {
    const sl = fakeSl([
      ...base,
      {node: 'a', phase: 'draft', parent: 'new-trunk', changeId: IA, diff: patch(['+a'], 9)},
      {node: 'b', phase: 'draft', parent: 'a', changeId: IB, diff: patch(['+b'], 9)},
    ]);
    const found = await new RebasedRevisionFinder(sl).find(uploaded);
    expect([...found.entries()]).toEqual([
      [IA, ['a']],
      [IB, ['b']],
    ]);
  });

  it('leaves out a commit whose changes differ, and the commits above it', async () => {
    const sl = fakeSl([
      ...base,
      {node: 'a', phase: 'draft', parent: 'new-trunk', changeId: IA, diff: patch(['+a', '+more'])},
      {node: 'b', phase: 'draft', parent: 'a', changeId: IB, diff: patch(['+b'])},
    ]);
    expect((await new RebasedRevisionFinder(sl).find(uploaded)).size).toBe(0);
  });

  it('leaves out a commit whose message changed', async () => {
    const sl = fakeSl([
      ...base,
      {
        node: 'a',
        phase: 'draft',
        parent: 'new-trunk',
        changeId: IA,
        diff: patch(['+a']),
        message: 'reworded',
      },
    ]);
    expect((await new RebasedRevisionFinder(sl).find(uploaded)).size).toBe(0);
  });

  it('leaves out commits reordered within the stack', async () => {
    const sl = fakeSl([
      ...base,
      {node: 'b', phase: 'draft', parent: 'old-trunk', changeId: IB, diff: patch(['+b'])},
      {node: 'a', phase: 'draft', parent: 'b', changeId: IA, diff: patch(['+a'])},
    ]);
    expect((await new RebasedRevisionFinder(sl).find(uploaded)).size).toBe(0);
  });

  it('leaves out commits whose uploaded patchset is not in the local repo', async () => {
    const sl = fakeSl([
      {node: 'new-trunk', phase: 'public'},
      {node: 'a', phase: 'draft', parent: 'new-trunk', changeId: IA, diff: patch(['+a'])},
    ]);
    expect((await new RebasedRevisionFinder(sl).find(uploaded)).size).toBe(0);
  });

  it('still finds the rest when one uploaded patchset is missing its content', async () => {
    const sl = fakeSl([
      ...base.map(c => (c.node === 'up-b' ? {...c, missingContent: true} : c)),
      {node: 'a', phase: 'draft', parent: 'new-trunk', changeId: IA, diff: patch(['+a'])},
      {node: 'b', phase: 'draft', parent: 'a', changeId: IB, diff: patch(['+b'])},
    ]);
    const found = await new RebasedRevisionFinder(sl).find(uploaded);
    expect([...found.entries()]).toEqual([[IA, ['a']]]);
  });

  it('runs no diffs when every commit is already the uploaded patchset', async () => {
    const sl = fakeSl(base.map(c => ({...c, obsolete: false})));
    expect((await new RebasedRevisionFinder(sl).find(uploaded)).size).toBe(0);
    expect(sl.mock.calls.map(call => call[0][0])).toEqual(['log']);
  });
});
