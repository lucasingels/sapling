/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as ejeca from 'shared/ejeca';
import {mockLogger} from 'shared/testUtils';
import {makeServerSideTracker} from '../analytics/serverSideTracker';
import {listWorktrees} from '../commands';
import {type ServerPlatform} from '../serverPlatform';
import {type RepositoryContext} from '../serverTypes';

function mockWorktreeList(entries: Array<Record<string, unknown>>) {
  return jest.spyOn(ejeca, 'ejeca').mockImplementation((() => ({
    kill: jest.fn(),
    on: jest.fn((event, cb) => {
      if (event === 'exit') {
        cb();
      }
    }),
    stdout: JSON.stringify(entries),
  })) as unknown as typeof ejeca.ejeca);
}

describe('listWorktrees', () => {
  const ctx: RepositoryContext = {
    cmd: 'sl',
    cwd: '/repo',
    logger: mockLogger,
    tracker: makeServerSideTracker(
      mockLogger,
      {platformName: 'test'} as ServerPlatform,
      '0.1',
      jest.fn(),
    ),
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('leaves out worktrees whose directory is missing', async () => {
    mockWorktreeList([
      {path: '/repo', role: 'main', current: true, node: 'a'.repeat(40), stale: false},
      {path: '/repo/.worktrees/gone', role: 'linked', current: false, stale: false, missing: true},
      {
        path: '/repo/.worktrees/here',
        role: 'linked',
        current: false,
        node: 'b'.repeat(40),
        stale: true,
        stale_reason: 'rewritten',
        missing: false,
      },
    ]);

    const worktrees = await listWorktrees(ctx);

    expect(worktrees.map(entry => entry.path)).toEqual(['/repo', '/repo/.worktrees/here']);
    expect(worktrees[1]).toMatchObject({stale: true, staleReason: 'rewritten'});
  });

  it('maps lock_reason to lockReason', async () => {
    mockWorktreeList([
      {path: '/repo', role: 'main'},
      {
        path: '/repo/.worktrees/agent',
        role: 'linked',
        locked: true,
        lock_reason: 'claude-session:1234',
        missing: false,
      },
    ]);

    const [, agent] = await listWorktrees(ctx);

    expect(agent).toMatchObject({locked: true, lockReason: 'claude-session:1234'});
    expect(agent).not.toHaveProperty('lock_reason');
  });

  it('keeps entries from older sl versions without a missing field', async () => {
    mockWorktreeList([{path: '/repo', role: 'main'}]);

    expect(await listWorktrees(ctx)).toEqual([{path: '/repo', role: 'main'}]);
  });
});
