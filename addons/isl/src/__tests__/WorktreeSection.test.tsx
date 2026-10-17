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
  resetTestMessages,
  simulateCommits,
  simulateRepoConnected,
  simulateWorktreeInfo,
} from '../testUtils';

describe('WorktreeSection', () => {
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
        ],
      });
    });
  });

  const openWorktreeDropdown = () => {
    act(() => {
      fireEvent.click(screen.getByTestId('worktree-button'));
    });
  };

  it('marks stale worktrees, with the reason and how to update them', () => {
    simulateWorktreeInfo('/path/to/repo', [
      {path: '/path/to/repo', role: 'main', node: 'a'},
      {
        path: '/path/to/repo/.worktrees/fresh',
        role: 'linked',
        label: 'fresh',
        node: '1',
        stale: false,
      },
      {
        path: '/path/to/repo/.worktrees/old',
        role: 'linked',
        label: 'old',
        node: 'b',
        stale: true,
        staleReason: "this worktree's commit b was rewritten in another worktree",
      },
    ]);
    openWorktreeDropdown();

    const badges = screen.getAllByTestId('worktree-stale-badge');
    expect(badges).toHaveLength(1);
    const staleRow = screen.getByText('old').parentElement as HTMLElement;
    expect(within(staleRow).getByTestId('worktree-stale-badge')).toBeInTheDocument();
    const freshRow = screen.getByText('fresh').parentElement as HTMLElement;
    expect(within(freshRow).queryByTestId('worktree-stale-badge')).not.toBeInTheDocument();

    act(() => {
      fireEvent.mouseEnter(badges[0].parentElement as HTMLElement);
    });
    expect(
      screen.getByText("this worktree's commit b was rewritten in another worktree"),
    ).toBeInTheDocument();
    expect(screen.getByText('sl update-stale')).toBeInTheDocument();
  });
});
