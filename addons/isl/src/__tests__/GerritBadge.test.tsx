/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {DiffId, DiffSummary} from '../types';

import {act, render, screen, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import {
  COMMIT,
  closeCommitInfoSidebar,
  expectMessageSentToServer,
  resetTestMessages,
  simulateCommits,
  simulateMessageFromServer,
  suppressReactErrorBoundaryErrorMessages,
} from '../testUtils';

const CHANGE_ID_A = 'Iabc1234567890abcdef1234567890abcdef12345';
const CHANGE_ID_B = 'Idef1234567890abcdef1234567890abcdef12345';

const GERRIT_REPO_INFO = {
  type: 'success' as const,
  command: 'sl',
  repoRoot: '/path/to/testrepo',
  dotdir: '/path/to/testrepo/.sl',
  codeReviewSystem: {
    type: 'gerrit' as const,
    remoteUrl: 'https://code.example.com/my-repo',
  },
  pullRequestDomain: undefined,
  preferredSubmitCommand: undefined,
  isEdenFs: false,
};

function gerritSummary(
  changeId: string,
  overrides?: Partial<DiffSummary & {type: 'gerrit'}>,
): [DiffId, DiffSummary] {
  return [
    changeId,
    {
      type: 'gerrit',
      title: 'My feature',
      commitMessage: '',
      state: 'NEW',
      number: '142',
      url: 'https://code.example.com/c/my-repo/+/142',
      branchName: 'main',
      codeReview: null,
      commentCount: 0,
      anyUnresolvedComments: false,
      submittable: false,
      isWorkInProgress: false,
      isPrivate: false,
      ...overrides,
    } as DiffSummary,
  ];
}

describe('GerritBadge', () => {
  beforeEach(() => {
    resetTestMessages();
    render(<App />);
    act(() => {
      closeCommitInfoSidebar();
      simulateCommits({
        value: [
          COMMIT('1', 'some public base', '0', {phase: 'public'}),
          COMMIT('a', 'Commit A', '1', {diffId: CHANGE_ID_A}),
          COMMIT('b', 'Commit B', 'a', {isDot: true, diffId: CHANGE_ID_B}),
          COMMIT('c', 'Commit C', '1'), // no diffId — not pushed
        ],
      });
    });
  });

  it("doesn't render any gerrit badge when repo provider is unknown", () => {
    expect(screen.queryAllByTestId('diff-spinner')).toHaveLength(0);
  });

  describe('in gerrit repo', () => {
    beforeEach(() => {
      act(() => {
        simulateMessageFromServer({type: 'repoInfo', info: GERRIT_REPO_INFO});
      });
    });

    it('requests a diff fetch on mount', () => {
      expectMessageSentToServer({type: 'fetchDiffSummaries'});
    });

    it('renders spinners for commits with Change-Ids while loading', () => {
      expect(screen.queryAllByTestId('diff-spinner')).toHaveLength(2);
    });

    it('shows nothing for commits without a Change-Id', () => {
      expect(within(screen.getByTestId('commit-c')).queryByTestId('diff-spinner')).toBeNull();
      expect(within(screen.getByTestId('commit-c')).queryByTestId('gerrit-diff-info')).toBeNull();
    });

    describe('after summaries loaded', () => {
      beforeEach(() => {
        act(() => {
          simulateMessageFromServer({
            type: 'fetchedDiffSummaries',
            summaries: {
              value: new Map<DiffId, DiffSummary>([
                gerritSummary(CHANGE_ID_A, {
                  state: 'NEW',
                  codeReview: 'approved',
                  signalSummary: 'pass',
                  submittable: true,
                }),
                gerritSummary(CHANGE_ID_B, {state: 'MERGED', number: '143'}),
              ]),
            },
          });
        });
      });

      it("doesn't show spinners anymore", () => {
        expect(screen.queryByTestId('diff-spinner')).not.toBeInTheDocument();
      });

      it('renders gerrit diff badges', () => {
        expect(screen.queryAllByTestId('gerrit-diff-info')).toHaveLength(2);
      });

      it('shows Open for NEW state', () => {
        expect(
          within(within(screen.getByTestId('commit-a')).getByTestId('gerrit-diff-info')).queryByText('Open'),
        ).toBeInTheDocument();
      });

      it('shows Merged for MERGED state', () => {
        expect(
          within(within(screen.getByTestId('commit-b')).getByTestId('gerrit-diff-info')).queryByText('Merged'),
        ).toBeInTheDocument();
      });

      it('shows the Approved decision label and passing CI signal', () => {
        const badgeA = within(screen.getByTestId('commit-a')).getByTestId('gerrit-diff-info');
        expect(badgeA.querySelector('.gerrit-review-decision-approved')).not.toBeNull();
        expect(within(badgeA).queryByText('Approved')).toBeInTheDocument();
        expect(badgeA.querySelector('.diff-signal-pass')).not.toBeNull();
      });

      it('shows nothing for commits whose Change-Id is not in the loaded summaries', () => {
        // commit-c has no diffId at all → no badge ever
        expect(within(screen.getByTestId('commit-c')).queryByTestId('gerrit-diff-info')).toBeNull();
      });

      it('does not render a badge for public commits', () => {
        expect(within(screen.getByTestId('commit-1')).queryByTestId('gerrit-diff-info')).toBeNull();
      });
    });

    describe('after error', () => {
      suppressReactErrorBoundaryErrorMessages();

      beforeEach(() => {
        act(() => {
          simulateMessageFromServer({
            type: 'fetchedDiffSummaries',
            summaries: {error: new Error('Gerrit auth failed')},
          });
        });
      });

      it('shows error state for commits with Change-Ids', () => {
        const errorBadges = screen.queryAllByTestId('gerrit-error');
        expect(errorBadges).toHaveLength(2);
        // The outer badge is itself wrapped in a "click to open" tooltip, so take the
        // innermost .tooltip-creator — the one directly wrapping the error icon.
        const tooltipCreators = errorBadges[0].querySelectorAll('.tooltip-creator');
        const tooltipTrigger = tooltipCreators[tooltipCreators.length - 1] as HTMLElement;
        userEvent.hover(tooltipTrigger);
        expect(screen.getByText('Gerrit auth failed')).toBeInTheDocument();
      });
    });

    describe('ABANDONED state', () => {
      beforeEach(() => {
        act(() => {
          simulateMessageFromServer({
            type: 'fetchedDiffSummaries',
            summaries: {
              value: new Map<DiffId, DiffSummary>([
                gerritSummary(CHANGE_ID_A, {state: 'ABANDONED'}),
                gerritSummary(CHANGE_ID_B, {state: 'NEW'}),
              ]),
            },
          });
        });
      });

      it('shows Abandoned label', () => {
        expect(
          within(within(screen.getByTestId('commit-a')).getByTestId('gerrit-diff-info')).queryByText(
            'Abandoned',
          ),
        ).toBeInTheDocument();
      });
    });

    describe('work-in-progress and private state', () => {
      it('shows Draft for a work-in-progress change', () => {
        act(() => {
          simulateMessageFromServer({
            type: 'fetchedDiffSummaries',
            summaries: {
              value: new Map<DiffId, DiffSummary>([
                gerritSummary(CHANGE_ID_A, {isWorkInProgress: true}),
                gerritSummary(CHANGE_ID_B, {state: 'NEW'}),
              ]),
            },
          });
        });
        expect(
          within(within(screen.getByTestId('commit-a')).getByTestId('gerrit-diff-info')).queryByText(
            'Draft',
          ),
        ).toBeInTheDocument();
      });

      it('shows Private for a private change', () => {
        act(() => {
          simulateMessageFromServer({
            type: 'fetchedDiffSummaries',
            summaries: {
              value: new Map<DiffId, DiffSummary>([
                gerritSummary(CHANGE_ID_A, {isPrivate: true}),
                gerritSummary(CHANGE_ID_B, {state: 'NEW'}),
              ]),
            },
          });
        });
        expect(
          within(within(screen.getByTestId('commit-a')).getByTestId('gerrit-diff-info')).queryByText(
            'Private',
          ),
        ).toBeInTheDocument();
      });

      it('prefers Private over Draft when a change is both private and work-in-progress', () => {
        act(() => {
          simulateMessageFromServer({
            type: 'fetchedDiffSummaries',
            summaries: {
              value: new Map<DiffId, DiffSummary>([
                gerritSummary(CHANGE_ID_A, {isPrivate: true, isWorkInProgress: true}),
                gerritSummary(CHANGE_ID_B, {state: 'NEW'}),
              ]),
            },
          });
        });
        const badgeA = within(screen.getByTestId('commit-a')).getByTestId('gerrit-diff-info');
        expect(within(badgeA).queryByText('Private')).toBeInTheDocument();
        expect(within(badgeA).queryByText('Draft')).not.toBeInTheDocument();
      });

      it('still shows Merged even if a merged change retained work-in-progress/private flags', () => {
        act(() => {
          simulateMessageFromServer({
            type: 'fetchedDiffSummaries',
            summaries: {
              value: new Map<DiffId, DiffSummary>([
                gerritSummary(CHANGE_ID_A, {
                  state: 'MERGED',
                  isPrivate: true,
                  isWorkInProgress: true,
                }),
                gerritSummary(CHANGE_ID_B, {state: 'NEW'}),
              ]),
            },
          });
        });
        expect(
          within(within(screen.getByTestId('commit-a')).getByTestId('gerrit-diff-info')).queryByText(
            'Merged',
          ),
        ).toBeInTheDocument();
      });
    });

    describe('negative votes', () => {
      beforeEach(() => {
        act(() => {
          simulateMessageFromServer({
            type: 'fetchedDiffSummaries',
            summaries: {
              value: new Map<DiffId, DiffSummary>([
                gerritSummary(CHANGE_ID_A, {codeReview: 'rejected', signalSummary: 'failed'}),
                gerritSummary(CHANGE_ID_B, {state: 'NEW'}),
              ]),
            },
          });
        });
      });

      it('shows the Rejected decision label and failing CI signal', () => {
        const badgeA = within(screen.getByTestId('commit-a')).getByTestId('gerrit-diff-info');
        expect(badgeA.querySelector('.gerrit-review-decision-rejected')).not.toBeNull();
        expect(within(badgeA).queryByText('Rejected')).toBeInTheDocument();
        expect(badgeA.querySelector('.diff-signal-failed')).not.toBeNull();
      });
    });
  });
});
