/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {act, fireEvent, render, screen, within} from '@testing-library/react';
import App from '../App';
import {
  closeCommitInfoSidebar,
  COMMIT,
  expectMessageSentToServer,
  resetTestMessages,
  simulateCommits,
  simulateRepoConnected,
  simulateWorktreeInfo,
} from '../testUtils';

describe('worktree labels in the commit graph', () => {
  beforeEach(() => {
    resetTestMessages();
    render(<App />);
    act(() => {
      simulateRepoConnected();
      closeCommitInfoSidebar();
      simulateCommits({
        value: [
          COMMIT('1', 'some public base', '0', {phase: 'public'}),
          COMMIT('a', 'My Commit', '1', {isDot: true}),
          COMMIT('bbbbbb', 'Another Commit', '1'),
        ],
      });
    });
  });

  it('labels a commit one worktree has checked out with its name', () => {
    simulateWorktreeInfo('/path/to/repo', [
      {path: '/path/to/repo', role: 'main', node: 'a'},
      {path: '/path/to/wt/solo', role: 'linked', label: 'solo', node: 'bbbbbb'},
    ]);

    const row = screen.getByTestId('commit-bbbbbb');
    expect(within(row).getByTestId('checked-out-elsewhere-badge')).toHaveTextContent('solo');
    expect(screen.queryByTestId('checked-out-elsewhere-group-badge')).not.toBeInTheDocument();
  });

  it('gives several worktrees on one commit a single label that lists them', () => {
    simulateWorktreeInfo('/path/to/repo', [
      {path: '/path/to/repo', role: 'main', node: 'a'},
      {path: '/path/to/wt/one', role: 'linked', label: 'one', node: 'bbbbbb'},
      {path: '/path/to/wt/two', role: 'linked', label: 'two', node: 'bbbbbb'},
      {
        path: '/path/to/wt/three',
        role: 'linked',
        label: 'three',
        node: 'bbbbbb',
        stale: true,
        staleReason: "this worktree's commit b was rewritten in another worktree",
      },
    ]);

    const group = within(screen.getByTestId('commit-bbbbbb')).getByTestId(
      'checked-out-elsewhere-group-badge',
    );
    expect(group).toHaveTextContent('3 worktrees');
    expect(group).toHaveTextContent('1 stale');
    expect(screen.queryByTestId('checked-out-elsewhere-badge')).not.toBeInTheDocument();

    act(() => {
      fireEvent.click(group);
    });
    const dropdown = screen.getByTestId('checked-out-elsewhere-group-dropdown');
    const badges = within(dropdown).getAllByTestId('checked-out-elsewhere-badge');
    expect(badges.map(badge => badge.textContent)).toEqual(['one', 'two', 'three']);
    expect(within(dropdown).getAllByTestId('checked-out-elsewhere-open-button')).toHaveLength(3);
    expect(within(dropdown).getAllByTestId('worktree-stale-badge')).toHaveLength(1);
  });

  it('shows a worktree on a hidden stack, as abandoned, on the commit the stack was built on', () => {
    simulateWorktreeInfo('/path/to/repo', [
      {path: '/path/to/repo', role: 'main', node: 'a'},
      {path: '/path/to/wt/gone', role: 'linked', label: 'gone', node: 'cccccc', hiddenBase: '1'},
    ]);

    const row = screen.getByTestId('commit-1');
    expect(within(row).getByTestId('checked-out-elsewhere-badge')).toHaveTextContent('gone');
    expect(within(row).getByTestId('worktree-abandoned-badge')).toBeInTheDocument();

    fireEvent.click(within(row).getByTestId('checked-out-elsewhere-goto-button'));
    expectMessageSentToServer({
      type: 'runOperation',
      operation: expect.objectContaining({
        args: [{type: 'worktree-cwd', path: '/path/to/wt/gone'}, 'goto', '--check', '1'],
        trackEventName: 'GotoInWorktreeOperation',
      }),
    });
  });

  it('counts abandoned worktrees in a shared label', () => {
    simulateWorktreeInfo('/path/to/repo', [
      {path: '/path/to/repo', role: 'main', node: 'a'},
      {path: '/path/to/wt/here', role: 'linked', label: 'here', node: 'bbbbbb'},
      {
        path: '/path/to/wt/gone',
        role: 'linked',
        label: 'gone',
        node: 'cccccc',
        hiddenBase: 'bbbbbb',
      },
    ]);

    const group = within(screen.getByTestId('commit-bbbbbb')).getByTestId(
      'checked-out-elsewhere-group-badge',
    );
    expect(group).toHaveTextContent('2 worktrees');
    expect(group).toHaveTextContent('1 abandoned');
  });
});
