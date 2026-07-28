/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {CommitInfo, DiffId, DiffSummary} from '../../types';

import {GerritUICodeReviewProvider} from '../GerritUICodeReviewProvider';

function commit(diffId?: DiffId): CommitInfo {
  return {diffId} as CommitInfo;
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
});
