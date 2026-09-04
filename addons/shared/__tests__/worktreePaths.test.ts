/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {defaultWorktreesDir, pickWorktreeDirName, worktreeDirNameFromLabel} from '../worktreePaths';

const nothingTaken = () => false;

describe('worktreeDirNameFromLabel', () => {
  it('keeps a plain label as-is, preserving case', () => {
    expect(worktreeDirNameFromLabel('my-label')).toEqual('my-label');
    expect(worktreeDirNameFromLabel('MyLabel_1.2')).toEqual('MyLabel_1.2');
  });

  it('collapses spaces and slashes into single dashes', () => {
    expect(worktreeDirNameFromLabel('  My   Feature / Fix  ')).toEqual('My-Feature-Fix');
    expect(worktreeDirNameFromLabel('user/branch')).toEqual('user-branch');
  });

  it('strips leading and trailing dashes and dots', () => {
    expect(worktreeDirNameFromLabel('...hidden..')).toEqual('hidden');
    expect(worktreeDirNameFromLabel('(wip) fix!')).toEqual('wip-fix');
  });

  it('returns undefined when nothing usable is left', () => {
    expect(worktreeDirNameFromLabel('')).toEqual(undefined);
    expect(worktreeDirNameFromLabel('   ')).toEqual(undefined);
    expect(worktreeDirNameFromLabel('!!!')).toEqual(undefined);
    expect(worktreeDirNameFromLabel('日本語 ✨')).toEqual(undefined);
  });
});

describe('pickWorktreeDirName', () => {
  it('uses the label when the name is free', () => {
    expect(pickWorktreeDirName('my-label', nothingTaken)).toEqual('my-label');
    expect(pickWorktreeDirName('My Feature', nothingTaken)).toEqual('My-Feature');
  });

  it('falls back to wt_2 when the label yields nothing', () => {
    expect(pickWorktreeDirName('', nothingTaken)).toEqual('wt_2');
    expect(pickWorktreeDirName('  ✨  ', nothingTaken)).toEqual('wt_2');
  });

  it('suffixes a taken label name', () => {
    const taken = new Set(['my-label', 'my-label_2']);
    expect(pickWorktreeDirName('my-label', name => taken.has(name))).toEqual('my-label_3');
  });

  it('skips taken names in the numbered fallback', () => {
    const taken = new Set(['wt_2', 'wt_3']);
    expect(pickWorktreeDirName('', name => taken.has(name))).toEqual('wt_4');
  });

  it('returns undefined once maxSuffix is exhausted', () => {
    expect(pickWorktreeDirName('my-label', () => true, 3)).toEqual(undefined);
    expect(pickWorktreeDirName('', () => true, 3)).toEqual(undefined);
    expect(pickWorktreeDirName('my-label', name => name === 'my-label', 3)).toEqual('my-label_2');
  });
});

describe('defaultWorktreesDir', () => {
  it('nests a hidden directory inside the main worktree', () => {
    expect(defaultWorktreesDir('/path/to/repo', '/')).toEqual('/path/to/repo/.worktrees');
    expect(defaultWorktreesDir('C:\\repo', '\\')).toEqual('C:\\repo\\.worktrees');
  });
});
