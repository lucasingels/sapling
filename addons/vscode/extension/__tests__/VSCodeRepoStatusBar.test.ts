/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Repository} from 'isl-server/src/Repository';
import type {ServerPlatform} from 'isl-server/src/serverPlatform';
import type {RepositoryContext} from 'isl-server/src/serverTypes';
import type {
  CommitInfo,
  MergeConflicts,
  RepoInfo,
  RunnableOperation,
  ValidatedRepoInfo,
} from 'isl/src/types';
import type {EnabledSCMApiFeature} from '../types';

import {repositoryCache} from 'isl-server/src/RepositoryCache';
import {makeServerSideTracker} from 'isl-server/src/analytics/serverSideTracker';
import {Logger} from 'isl-server/src/logger';
import {TypedEventEmitter} from 'shared/TypedEventEmitter';
import {nextTick} from 'shared/testUtils';
import * as vscode from 'vscode';
import {VSCodeReposList} from '../VSCodeRepo';

class MockLogger extends Logger {
  write() {
    // noop
  }
}
const mockLogger = new MockLogger();

const mockTracker = makeServerSideTracker(
  mockLogger,
  {platformName: 'test'} as ServerPlatform,
  '0.1',
  jest.fn(),
);

type Listener = () => void;

jest.mock('isl-server/src/Repository', () => {
  class MockRepository implements Partial<Repository> {
    static instances: Array<MockRepository> = [];

    static getRepoInfo = jest.fn((ctx: RepositoryContext): Promise<RepoInfo> => {
      let root: string;
      if (ctx.cwd.includes('/path/to/repo1')) {
        root = '/path/to/repo1';
      } else if (ctx.cwd.includes('/path/to/repo2')) {
        root = '/path/to/repo2';
      } else {
        return Promise.resolve({type: 'cwdNotARepository', cwd: ctx.cwd});
      }
      return Promise.resolve({
        type: 'success',
        repoRoot: root,
        dotdir: root + '/.sl',
        command: 'sl',
        preferredSubmitCommand: 'pr',
        codeReviewSystem: {type: 'unknown', path: ''},
        pullRequestDomain: undefined,
        isEdenFs: false,
      });
    });

    constructor(public info: ValidatedRepoInfo) {
      MockRepository.instances.push(this);
    }

    public disposables: Array<() => void> = [];
    public dispose() {
      this.disposables.forEach(d => d());
    }
    public onDidDispose = (cb: () => void) => this.disposables.push(cb);

    public getUncommittedChanges = jest.fn();
    private uncommittedListeners: Array<Listener> = [];
    public subscribeToUncommittedChanges = jest.fn((cb: Listener) => {
      this.uncommittedListeners.push(cb);
      return {
        dispose: () => {
          this.uncommittedListeners = this.uncommittedListeners.filter(l => l !== cb);
        },
      };
    });

    public mergeConflicts: MergeConflicts | undefined = undefined;
    private conflictListeners: Array<Listener> = [];
    public getMergeConflicts = jest.fn(() => this.mergeConflicts);
    public onChangeConflictState = jest.fn((cb: Listener) => {
      this.conflictListeners.push(cb);
      return {
        dispose: () => {
          this.conflictListeners = this.conflictListeners.filter(l => l !== cb);
        },
      };
    });
    public triggerConflictChange() {
      this.conflictListeners.forEach(l => l());
    }

    public headCommit: CommitInfo | undefined = undefined;
    private headCommitListeners: Array<Listener> = [];
    public getHeadCommit = jest.fn(() => this.headCommit);
    public subscribeToHeadCommit = jest.fn((cb: Listener) => {
      this.headCommitListeners.push(cb);
      return {
        dispose: () => {
          this.headCommitListeners = this.headCommitListeners.filter(l => l !== cb);
        },
      };
    });
    public triggerHeadCommitChange() {
      this.headCommitListeners.forEach(l => l());
    }

    public subscribeToSmartlogCommitsBeginFetching = jest.fn(() => ({dispose: jest.fn()}));

    public runningOperation: RunnableOperation | undefined = undefined;
    public getRunningOperation = jest.fn(() => this.runningOperation);

    public getAllDiffIds = jest.fn(() => []);
    public codeReviewProvider = undefined;
  }
  return {
    Repository: MockRepository as unknown as Repository,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MockRepositoryClass = jest.requireMock('isl-server/src/Repository').Repository as any;

describe('VSCodeRepo status bar', () => {
  let foldersEmitter: TypedEventEmitter<'value', vscode.WorkspaceFoldersChangeEvent>;
  const ENABLED = new Set<EnabledSCMApiFeature>(['blame', 'sidebar']);

  beforeEach(() => {
    foldersEmitter = new TypedEventEmitter();
    (vscode.workspace.onDidChangeWorkspaceFolders as jest.Mock).mockImplementation(cb => {
      foldersEmitter.on('value', cb);
      return {dispose: () => foldersEmitter.off('value', cb)};
    });
    MockRepositoryClass.instances = [];
  });

  afterEach(() => {
    jest.clearAllMocks();
    repositoryCache.clearCache();
    foldersEmitter.removeAllListeners();
  });

  const addRepo = (path: string) => {
    foldersEmitter.emit('value', {
      added: [{name: 'folder', index: 0, uri: vscode.Uri.file(path)}],
      removed: [],
    });
  };

  const sourceControls = () =>
    (vscode.scm.createSourceControl as jest.Mock).mock.results.map(r => r.value);

  // The status bar refresh is debounced; give it a moment to settle on real timers.
  const flush = () => new Promise(resolve => setTimeout(resolve, 350));

  it('shows only the pull action before any commit is loaded', async () => {
    const repos = new VSCodeReposList(mockLogger, mockTracker, ENABLED);
    addRepo('/path/to/repo1');
    await nextTick();

    const [sourceControl] = sourceControls();
    expect(sourceControl.statusBarCommands).toEqual([
      expect.objectContaining({command: 'sapling.pull'}),
    ]);

    repos.dispose();
  });

  it('shows the head commit once it loads, and updates on change', async () => {
    const repos = new VSCodeReposList(mockLogger, mockTracker, ENABLED);
    addRepo('/path/to/repo1');
    await nextTick();

    const [sourceControl] = sourceControls();
    const [repoInstance] = MockRepositoryClass.instances;

    repoInstance.headCommit = {
      title: 'My change',
      hash: 'abc123',
      bookmarks: ['my-bookmark'],
      remoteBookmarks: [],
      isDot: true,
    };
    repoInstance.triggerHeadCommitChange();
    await flush();

    expect(sourceControl.statusBarCommands[0]).toEqual(
      expect.objectContaining({title: expect.stringContaining('my-bookmark')}),
    );

    repos.dispose();
  });

  it('prioritizes unresolved merge conflicts over the head commit', async () => {
    const repos = new VSCodeReposList(mockLogger, mockTracker, ENABLED);
    addRepo('/path/to/repo1');
    await nextTick();

    const [sourceControl] = sourceControls();
    const [repoInstance] = MockRepositoryClass.instances;

    repoInstance.headCommit = {
      title: 'My change',
      hash: 'abc123',
      bookmarks: ['my-bookmark'],
      remoteBookmarks: [],
      isDot: true,
    };
    // `files` is left empty here: populating it would exercise `updateResourceGroups`'s
    // resource-decoration code, which needs more of the real `vscode` API than the test
    // mock provides. `computeStatusBarInfoCommand` itself (including unresolved-count math)
    // is covered directly in statusBar.test.ts; this test only cares about priority ordering.
    repoInstance.mergeConflicts = {
      state: 'loaded',
      files: [],
    };
    repoInstance.triggerConflictChange();
    await flush();

    expect(sourceControl.statusBarCommands[0]).toEqual(
      expect.objectContaining({title: expect.stringContaining('warning')}),
    );

    repos.dispose();
  });

  it('gives each repo in a multi-root workspace its own independent status bar commands', async () => {
    const repos = new VSCodeReposList(mockLogger, mockTracker, ENABLED);
    addRepo('/path/to/repo1');
    addRepo('/path/to/repo2');
    await nextTick();

    const [sourceControl1, sourceControl2] = sourceControls();
    const [repo1] = MockRepositoryClass.instances;
    expect(sourceControl1).not.toBe(sourceControl2);

    repo1.headCommit = {
      title: 'Repo 1 change',
      hash: 'aaa111',
      bookmarks: ['repo1-bookmark'],
      remoteBookmarks: [],
      isDot: true,
    };
    repo1.triggerHeadCommitChange();
    await flush();

    // repo2 never changed, so it should still only show the pull action -
    // repo1's update must not leak into repo2's statusBarCommands.
    expect(sourceControl1.statusBarCommands[0].title).toContain('repo1-bookmark');
    expect(sourceControl2.statusBarCommands).toEqual([
      expect.objectContaining({command: 'sapling.pull'}),
    ]);

    repos.dispose();
  });

  it('cleans up its interval and subscriptions on dispose', async () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const repos = new VSCodeReposList(mockLogger, mockTracker, ENABLED);
    addRepo('/path/to/repo1');
    await nextTick();

    const [sourceControl] = sourceControls();
    const [repoInstance] = MockRepositoryClass.instances;
    const commandsBeforeDispose = sourceControl.statusBarCommands;

    repos.dispose();
    expect(clearIntervalSpy).toHaveBeenCalled();

    // events firing after dispose must not throw, and must not affect the (now-defunct) item.
    repoInstance.headCommit = {
      title: 'Late change',
      hash: 'def456',
      bookmarks: [],
      remoteBookmarks: [],
      isDot: true,
    };
    expect(() => repoInstance.triggerHeadCommitChange()).not.toThrow();
    await flush();
    expect(sourceControl.statusBarCommands).toBe(commandsBeforeDispose);

    clearIntervalSpy.mockRestore();
  });
});
