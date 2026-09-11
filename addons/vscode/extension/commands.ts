/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Repository} from 'isl-server/src/Repository';
import type {RepositoryContext} from 'isl-server/src/serverTypes';
import type {PartiallySelectedDiffCommit} from 'isl/src/stackEdit/diffSplitTypes';
import type {
  AbsolutePath,
  CommandArg,
  OperationProgress,
  RepoRelativePath,
  WorktreeInfo,
} from 'isl/src/types';
import type {Comparison} from 'shared/Comparison';

import {repoRelativePathForAbsolutePath} from 'isl-server/src/Repository';
import {repositoryCache} from 'isl-server/src/RepositoryCache';
import {findPublicAncestor} from 'isl-server/src/utils';
import {Operation} from 'isl/src/operations/Operation';
import {AddWorktreeOperation} from 'isl/src/operations/AddWorktreeOperation';
import {PullOperation} from 'isl/src/operations/PullOperation';
import {RemoveWorktreeOperation} from 'isl/src/operations/RemoveWorktreeOperation';
import {RenameWorktreeOperation} from 'isl/src/operations/RenameWorktreeOperation';
import {RevertOperation} from 'isl/src/operations/RevertOperation';
import fs from 'node:fs';
import path from 'node:path';
import {
  beforeRevsetForComparison,
  ComparisonType,
  currRevsetForComparison,
  labelForComparison,
} from 'shared/Comparison';
import {pathsAreIdentical} from 'shared/utils';
import {pickWorktreeDirName, WORKTREES_DIR_NAME} from 'shared/worktreePaths';
import * as vscode from 'vscode';
import {shouldOpenBeside} from './config';
import {
  DELETED_FILE_DIFF_VIEW_PROVIDER_SCHEME,
  encodeDeletedFileUri,
} from './DeletedFileContentProvider';
import {
  decodeSaplingDiffUri,
  encodeSaplingDiffUri,
  SAPLING_DIFF_PROVIDER_SCHEME,
} from './DiffContentProvider';
import {t} from './i18n';
import {Internal} from './Internal';
import {VSCodeRepo} from './VSCodeRepo';

/**
 * Open a folder in the current window, a new window, or (inside Basecamp) a new tile
 * in the current window.
 */
export async function openFolderInWindowOrTile(
  path: string,
  forceNewWindow: boolean,
  label?: string,
): Promise<void> {
  if (Internal.isBasecamp?.() === true) {
    const openedTile = await Internal.basecampOpenFolderAsNewTile?.(path, label);
    if (openedTile !== true) {
      vscode.window.showErrorMessage(
        t('Failed to open $path as a new Basecamp tile').replace('$path', path),
      );
    }
    return;
  }
  try {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), {
      forceNewWindow,
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      t('Failed to open folder ($path)').replace('$path', path) + `: ${err}`,
    );
  }
}

/**
 * Add `path` to the current workspace as another folder, keeping every folder already
 * there. Unlike `vscode.openFolder` this neither reloads the window nor replaces a
 * multi-root workspace. Returns false if VS Code refused the change.
 */
export function addFolderToWorkspace(path: string, label?: string): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const uri = vscode.Uri.file(path);
  if (folders.some(folder => pathsAreIdentical(folder.uri.fsPath, uri.fsPath))) {
    return true;
  }
  const added = vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
    uri,
    name: label || undefined,
  });
  if (!added) {
    vscode.window.showErrorMessage(
      t('Failed to add $path to the workspace').replace('$path', path),
    );
  }
  return added;
}

/** Remove `path` from the current workspace, if it is one of its folders. */
export function removeFolderFromWorkspace(path: string): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const index = folders.findIndex(folder => pathsAreIdentical(folder.uri.fsPath, path));
  if (index >= 0) {
    vscode.workspace.updateWorkspaceFolders(index, 1);
  }
}

/** Add the worktree to the workspace and show it in ISL, without reloading the window. */
async function switchToWorktreeInWorkspace(path: string, label?: string): Promise<void> {
  if (!addFolderToWorkspace(path, label)) {
    return;
  }
  await vscode.commands.executeCommand('sapling.open-isl', vscode.Uri.file(path));
}

/**
 * Runs `sl commit`, committing all (or a subset of) uncommitted changes.
 *
 * This deliberately does NOT reuse `isl/src/operations/CommitOperation`: that class (via
 * `CommitBaseOperation`) reads jotai atoms transitively through `isl/src/serverAPIState`,
 * which imports `isl/src/platform`. `platform.ts` reads `window.islPlatform` at module load
 * time, and there is no `window` global in the extension host - importing it crashes the
 * extension outright (verified: `ReferenceError: location is not defined` from
 * `BrowserPlatform.ts`, pulled in transitively). `getArgs()` itself doesn't depend on any of
 * that state, but the import graph does, so we mirror the command construction here instead.
 */
class VSCodeCommitOperation extends Operation {
  constructor(
    private message: string,
    private filePathsToCommit?: Array<RepoRelativePath>,
  ) {
    super(filePathsToCommit ? 'CommitFileSubsetOperation' : 'CommitOperation');
  }

  getArgs(): Array<CommandArg> {
    const args: Array<CommandArg> = ['commit', '--addremove', '--message', this.message];
    if (this.filePathsToCommit != null) {
      args.push(
        ...this.filePathsToCommit.map(file => ({type: 'repo-relative-file' as const, path: file})),
      );
    }
    return args;
  }
}

/**
 * Runs `sl amend`, amending all (or a subset of) uncommitted changes into the current commit.
 *
 * Same import-safety reasoning as `VSCodeCommitOperation` applies to
 * `isl/src/operations/AmendOperation`. It's worth calling out specifically here because,
 * unlike `CommitOperation`, its `getArgs()` DOES depend on the atom it reads
 * (`restackBehaviorAtom`, surfaced as `--config amend.autorestack=...`). Reusing the class
 * would silently apply ISL's hardcoded default restack behavior instead of the user's actual
 * `sl` config, changing real amend behavior. So this omits that flag entirely and lets `sl
 * amend` fall back to whatever the user has configured (or its own default).
 */
class VSCodeAmendOperation extends Operation {
  constructor(
    private message: string | undefined,
    private filePathsToAmend?: Array<RepoRelativePath>,
  ) {
    super(filePathsToAmend ? 'AmendFileSubsetOperation' : 'AmendOperation');
  }

  getArgs(): Array<CommandArg> {
    const args: Array<CommandArg> = ['amend', '--addremove'];
    if (this.filePathsToAmend != null) {
      args.push(
        ...this.filePathsToAmend.map(file => ({type: 'repo-relative-file' as const, path: file})),
      );
    }
    // `this.message == null` means "keep the existing commit message" - not the same as `''`.
    if (this.message != null) {
      args.push('--message', this.message);
    }
    return args;
  }
}

function hasUnresolvedConflicts(repo: Repository): boolean {
  return repo.getMergeConflicts()?.files?.some(file => file.status === 'U') ?? false;
}

/**
 * Wrap a command implementation invoked from the SCM input box (`acceptInputCommand`) or the
 * `scm/title` menu, both of which VS Code invokes with the relevant `vscode.SourceControl`.
 */
function commandWithSourceControl(
  handler: (this: RepositoryContext, vscodeRepo: VSCodeRepo) => unknown | Thenable<unknown>,
) {
  return function (this: RepositoryContext, sourceControl: vscode.SourceControl | undefined) {
    if (sourceControl == null) {
      return;
    }
    const vscodeRepo = VSCodeRepo.repoForSourceControl(sourceControl);
    if (vscodeRepo == null) {
      return;
    }
    return handler.apply(this, [vscodeRepo]);
  };
}

/**
 * Wrap a command implementation invoked from `scm/resourceState/context`. VS Code invokes the
 * command once with the clicked resource state plus the full array of selected resource
 * states (which includes the clicked one).
 */
function commandWithResourceStates(
  handler: (
    this: RepositoryContext,
    repo: Repository,
    vscodeRepo: VSCodeRepo,
    filePaths: Array<RepoRelativePath>,
  ) => unknown | Thenable<unknown>,
) {
  return function (
    this: RepositoryContext,
    resourceState: vscode.SourceControlResourceState | undefined,
    resourceStates: Array<vscode.SourceControlResourceState> | undefined,
  ) {
    const states = resourceStates?.length
      ? resourceStates
      : resourceState != null
        ? [resourceState]
        : [];
    if (states.length === 0) {
      return;
    }
    const {fsPath} = states[0].resourceUri;
    const repo = repositoryCache.cachedRepositoryForPath(fsPath);
    if (repo == null) {
      vscode.window.showErrorMessage(t(`No repository found for file ${fsPath}`));
      return;
    }
    const vscodeRepo = VSCodeRepo.repoForRepository(repo);
    if (vscodeRepo == null) {
      return;
    }
    const filePaths = states.map(state =>
      repoRelativePathForAbsolutePath(state.resourceUri.fsPath, repo),
    );
    return handler.apply(this, [repo, vscodeRepo, filePaths]);
  };
}

/**
 * VS Code Commands registered by the Sapling extension.
 */
export const vscodeCommands = {
  ['sapling.open-file-diff-uncommitted']: commandWithUriOrResourceState((_, uri: vscode.Uri) =>
    openDiffView(uri, {type: ComparisonType.UncommittedChanges}),
  ),
  ['sapling.open-file-diff-head']: commandWithUriOrResourceState((_, uri: vscode.Uri) =>
    openDiffView(uri, {type: ComparisonType.HeadChanges}),
  ),
  ['sapling.open-file-diff-stack']: commandWithUriOrResourceState((_, uri: vscode.Uri) =>
    openDiffView(uri, {type: ComparisonType.StackChanges}),
  ),
  ['sapling.open-file-diff']: (uri: vscode.Uri, comparison: Comparison) =>
    openDiffView(uri, comparison),

  ['sapling.open-remote-file-link']: commandWithUriOrResourceState(
    (repo: Repository, uri, path: RepoRelativePath) => openRemoteFileLink(repo, uri, path),
  ),
  ['sapling.copy-remote-file-link']: commandWithUriOrResourceState(
    (repo: Repository, uri, path: RepoRelativePath) => openRemoteFileLink(repo, uri, path, true),
  ),

  ['sapling.revert-file']: commandWithUriOrResourceState(async function (
    this: RepositoryContext,
    repo: Repository,
    _,
    path: RepoRelativePath,
  ) {
    const choice = await vscode.window.showWarningMessage(
      'Are you sure you want to revert this file?',
      'Cancel',
      'Revert',
    );
    if (choice !== 'Revert') {
      return;
    }
    return runOperation(this, repo, new RevertOperation([path]));
  }),

  ['sapling.commit']: commandWithSourceControl(async function (
    this: RepositoryContext,
    vscodeRepo: VSCodeRepo,
  ) {
    const {repo} = vscodeRepo;
    const message = vscodeRepo.getCommitMessage().trim();
    if (message === '') {
      vscode.window.showWarningMessage(t('Cannot commit with an empty commit message'));
      return;
    }
    if (hasUnresolvedConflicts(repo)) {
      vscode.window.showWarningMessage(
        t('Cannot commit while there are unresolved merge conflicts'),
      );
      return;
    }
    if (vscodeRepo.getUncommittedChanges().length === 0) {
      vscode.window.showWarningMessage(t('There are no uncommitted changes to commit'));
      return;
    }
    await runOperation(this, repo, new VSCodeCommitOperation(message));
    vscodeRepo.setCommitMessage('');
  }),

  ['sapling.amend']: commandWithSourceControl(async function (
    this: RepositoryContext,
    vscodeRepo: VSCodeRepo,
  ) {
    const {repo} = vscodeRepo;
    if (hasUnresolvedConflicts(repo)) {
      vscode.window.showWarningMessage(
        t('Cannot amend while there are unresolved merge conflicts'),
      );
      return;
    }
    if (vscodeRepo.getUncommittedChanges().length === 0) {
      vscode.window.showWarningMessage(t('There are no uncommitted changes to amend'));
      return;
    }
    const inputMessage = vscodeRepo.getCommitMessage().trim();
    const message = inputMessage === '' ? undefined : inputMessage;
    await runOperation(this, repo, new VSCodeAmendOperation(message));
    if (message != null) {
      vscodeRepo.setCommitMessage('');
    }
  }),

  ['sapling.pull']: commandWithSourceControl(async function (
    this: RepositoryContext,
    vscodeRepo: VSCodeRepo,
  ) {
    await runOperation(this, vscodeRepo.repo, new PullOperation());
  }),

  ['sapling.commit-selected-files']: commandWithResourceStates(async function (
    this: RepositoryContext,
    repo: Repository,
    vscodeRepo: VSCodeRepo,
    filePaths: Array<RepoRelativePath>,
  ) {
    const message = vscodeRepo.getCommitMessage().trim();
    if (message === '') {
      vscode.window.showWarningMessage(t('Cannot commit with an empty commit message'));
      return;
    }
    if (hasUnresolvedConflicts(repo)) {
      vscode.window.showWarningMessage(
        t('Cannot commit while there are unresolved merge conflicts'),
      );
      return;
    }
    await runOperation(this, repo, new VSCodeCommitOperation(message, filePaths));
    vscodeRepo.setCommitMessage('');
  }),

  ['sapling.amend-selected-files']: commandWithResourceStates(async function (
    this: RepositoryContext,
    repo: Repository,
    vscodeRepo: VSCodeRepo,
    filePaths: Array<RepoRelativePath>,
  ) {
    if (hasUnresolvedConflicts(repo)) {
      vscode.window.showWarningMessage(
        t('Cannot amend while there are unresolved merge conflicts'),
      );
      return;
    }
    const inputMessage = vscodeRepo.getCommitMessage().trim();
    const message = inputMessage === '' ? undefined : inputMessage;
    await runOperation(this, repo, new VSCodeAmendOperation(message, filePaths));
    if (message != null) {
      vscodeRepo.setCommitMessage('');
    }
  }),

  ['sapling.worktree.switch']: async function (this: RepositoryContext) {
    const resolved = await resolveWorktreeRepo();
    if (resolved == null) {
      return;
    }
    const {repo, worktreeInfo} = resolved;
    const others = worktreeInfo.worktrees.filter(wt => wt.path !== repo.info.repoRoot);
    if (others.length === 0) {
      vscode.window.showInformationMessage(t('No other worktrees to switch to'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      others.map(wt => ({
        label: wt.label || path.basename(wt.path),
        description: wt.path,
        worktree: wt,
      })),
      {placeHolder: t('Select a worktree to switch to')},
    );
    if (picked == null) {
      return;
    }
    const isBasecamp = Internal.isBasecamp?.() === true;
    if (isBasecamp) {
      // Basecamp always opens worktrees as a new tile; there's no shared workspace to add to.
      await openFolderInWindowOrTile(picked.worktree.path, true, picked.worktree.label);
      return;
    }
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: t('Add to Workspace'),
          description: t('Keeps the current window and workspace'),
          action: 'workspace' as const,
        },
        {label: t('Open in New Window'), action: 'new' as const},
        {
          label: t('Open in Current Window'),
          description: t('Reloads the window and replaces the workspace'),
          action: 'current' as const,
        },
      ],
      {placeHolder: t('How do you want to open the worktree?')},
    );
    if (choice == null) {
      return;
    }
    if (choice.action === 'workspace') {
      await switchToWorktreeInWorkspace(picked.worktree.path, picked.worktree.label);
      return;
    }
    await openFolderInWindowOrTile(
      picked.worktree.path,
      choice.action === 'new',
      picked.worktree.label,
    );
  },

  ['sapling.worktree.add']: async function (this: RepositoryContext) {
    const resolved = await resolveWorktreeRepo();
    if (resolved == null) {
      return;
    }
    const {repo, worktreeInfo} = resolved;

    const label = await vscode.window.showInputBox({prompt: t('Label (optional)')});
    if (label == null) {
      return;
    }

    const mainRoot =
      worktreeInfo.worktrees.find(wt => wt.role === 'main')?.path ?? repo.info.repoRoot;
    // New worktrees go in a hidden directory inside the main worktree, named after the label.
    const worktreesDir = path.join(mainRoot, WORKTREES_DIR_NAME);
    const taken = new Set(
      worktreeInfo.worktrees
        .filter(wt => path.dirname(wt.path) === worktreesDir)
        .map(wt => path.basename(wt.path)),
    );
    const MAX_WORKTREE_SUFFIX = 25;
    // Pick a name that's free among the known worktrees in that dir, then confirm nothing
    // exists on disk under it; a name that does exist is marked taken and we pick again.
    // Suffixes 2..MAX_WORKTREE_SUFFIX inclusive are tried.
    let dirName = pickWorktreeDirName(label, name => taken.has(name), MAX_WORKTREE_SUFFIX);
    while (dirName != null) {
      // eslint-disable-next-line no-await-in-loop
      const existsOnDisk = await fileExists(vscode.Uri.file(path.join(worktreesDir, dirName)));
      if (!existsOnDisk) {
        break;
      }
      taken.add(dirName);
      dirName = pickWorktreeDirName(label, name => taken.has(name), MAX_WORKTREE_SUFFIX);
    }
    if (dirName == null) {
      throw new Error(t('Could not add worktree, exceeded maximum allowed worktrees.'));
    }
    const defaultDest = path.join(worktreesDir, dirName);

    const destPath = await vscode.window.showInputBox({
      prompt: t('Worktree root path'),
      value: defaultDest,
    });
    if (destPath == null) {
      return;
    }
    const trimmedDestPath = destPath.trim();
    if (trimmedDestPath === '') {
      return;
    }

    await runOperationWithProgress(
      this,
      repo,
      new AddWorktreeOperation(trimmedDestPath, label.trim() || undefined),
      t('Creating worktree...'),
    );
  },

  ['sapling.worktree.remove']: async function (this: RepositoryContext) {
    const resolved = await resolveWorktreeRepo();
    if (resolved == null) {
      return;
    }
    const {repo, worktreeInfo} = resolved;
    const removable = worktreeInfo.worktrees.filter(
      wt => wt.role !== 'main' && wt.path !== repo.info.repoRoot,
    );
    if (removable.length === 0) {
      vscode.window.showInformationMessage(t('No worktrees to remove'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      removable.map(wt => ({
        label: wt.label || path.basename(wt.path),
        description: wt.path,
        worktree: wt,
      })),
      {placeHolder: t('Select a worktree to remove')},
    );
    if (picked == null) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      t('Are you sure you want to remove this worktree?'),
      t('Cancel'),
      t('Remove'),
    );
    if (choice !== t('Remove')) {
      return;
    }
    await runOperationWithProgress(
      this,
      repo,
      new RemoveWorktreeOperation(picked.worktree.path),
      t('Removing worktree...'),
    );
    removeFolderFromWorkspace(picked.worktree.path);
  },

  ['sapling.worktree.rename']: async function (this: RepositoryContext) {
    const resolved = await resolveWorktreeRepo();
    if (resolved == null) {
      return;
    }
    const {repo, worktreeInfo} = resolved;
    const picked = await vscode.window.showQuickPick(
      worktreeInfo.worktrees.map(wt => ({
        label: wt.label || path.basename(wt.path),
        description: wt.path,
        worktree: wt,
      })),
      {placeHolder: t('Select a worktree to rename')},
    );
    if (picked == null) {
      return;
    }
    const newLabel = await vscode.window.showInputBox({
      prompt: t('Label (leave empty to remove)'),
      value: picked.worktree.label ?? '',
    });
    if (newLabel == null) {
      return;
    }
    return runOperationWithProgress(
      this,
      repo,
      new RenameWorktreeOperation(picked.worktree.path, newLabel.trim() || undefined),
      t('Renaming worktree...'),
    );
  },

  // Open the working-copy / head version of a file row in VS Code's native multi-diff
  // editor. Only contributed for committed comparisons: there the editor's built-in
  // "Open File" button opens the read-only in-diff version, so this provides access to the
  // editable working-copy file. (For uncommitted comparisons the built-in button already
  // opens the working copy, so no extra button is needed.)
  ['sapling.open-multi-diff-file-head']: async (arg: MultiDiffResourceArg) => {
    const modified = modifiedUriFromMultiDiffArg(arg);
    if (modified == null) {
      vscode.window.showErrorMessage(t(`No file found`));
      return;
    }
    const fileUri = workingCopyUriForModifiedUri(modified);
    if (!(await fileExists(fileUri))) {
      vscode.window.showInformationMessage(t(`This file does not exist in the working copy`));
      return;
    }
    return openInPreferredColumn(fileUri);
  },
};

/**
 * Argument shape passed to commands invoked from the `multiDiffEditor/resource/title`
 * menu. The Meta VS Code build (T223719719) passes a 2-element array
 * `[modifiedUri ?? originalUri, modifiedUri]`; upstream passes a single `vscode.Uri`.
 * Handle both defensively.
 */
type MultiDiffResourceArg =
  vscode.Uri | [vscode.Uri | undefined, vscode.Uri | undefined] | undefined;

function modifiedUriFromMultiDiffArg(arg: MultiDiffResourceArg): vscode.Uri | undefined {
  if (arg == null) {
    return undefined;
  }
  if (Array.isArray(arg)) {
    return arg[1] ?? arg[0];
  }
  return arg;
}

/** Recover the working-copy `file://` URI from a multi-diff editor's modified resource URI. */
export function workingCopyUriForModifiedUri(uri: vscode.Uri): vscode.Uri {
  if (uri.scheme === SAPLING_DIFF_PROVIDER_SCHEME) {
    return decodeSaplingDiffUri(uri).originalUri;
  }
  if (uri.scheme === DELETED_FILE_DIFF_VIEW_PROVIDER_SCHEME) {
    return uri.with({scheme: 'file', query: ''});
  }
  return uri;
}

function openInPreferredColumn(uri: vscode.Uri): Thenable<unknown> {
  return vscode.window.showTextDocument(uri, {
    viewColumn: shouldOpenBeside() ? vscode.ViewColumn.Beside : undefined,
  });
}

type surveyMetaData = {
  diffId: string | undefined;
};

/** Type definitions for built-in or third-party VS Code commands we want to execute programmatically. */
type ExternalVSCodeCommands = {
  'vscode.diff': (
    left: vscode.Uri,
    right: vscode.Uri,
    title: string,
    opts?: vscode.TextDocumentShowOptions,
  ) => Thenable<unknown>;
  'workbench.action.closeSidebar': () => Thenable<void>;
  'fb.survey.initStateUIByNamespace': (
    surveyID: string,
    namespace: string,
    metadata: surveyMetaData,
  ) => Thenable<void>;
  'workbench.action.pinEditor': () => Thenable<void>;
  'sapling.open-isl': () => Thenable<void>;
  'sapling.close-isl': () => Thenable<void>;
  'sapling.isl.focus': () => Thenable<void>;
  'sapling.open-isl-with-commit-message': (
    title: string,
    description: string,
    mode?: 'commit' | 'amend',
    hash?: string,
  ) => Thenable<void>;
  'sapling.open-split-view-with-commits': (
    commits: Array<PartiallySelectedDiffCommit>,
    commitHash?: string,
  ) => Thenable<void>;
  'sapling.open-comparison-view': (comparison: Comparison) => Thenable<void>;
  setContext: (key: string, value: unknown) => Thenable<void>;
  'fb-hg.open-or-focus-interactive-smartlog': (
    _: unknown,
    __?: unknown,
    forceNoSapling?: boolean,
  ) => Thenable<void>;
};

export type VSCodeCommand = typeof vscodeCommands & ExternalVSCodeCommands;

/**
 * Type-safe programmatic execution of VS Code commands (via `vscode.commands.executeCommand`).
 * Sapling-provided commands are defined in vscodeCommands.
 * Built-in or third-party commands may also be typed through this function,
 * just define them in ExternalVSCodeCommands.
 */
export function executeVSCodeCommand<K extends keyof VSCodeCommand>(
  id: K,
  ...args: Parameters<VSCodeCommand[K]>
): ReturnType<VSCodeCommand[K]> {
  // In tests 'vscode.commands' is not defined.
  return vscode.commands?.executeCommand(id, ...args) as ReturnType<VSCodeCommand[K]>;
}

const runOperation = async (
  ctx: RepositoryContext,
  repo: Repository,
  operation: Operation,
): Promise<void> => {
  let exitCode: number | undefined;
  let errorMessage: string | undefined;

  const result = await repo.runOrQueueOperation(
    ctx,
    {
      args: operation.getArgs(),
      id: operation.id,
      runner: operation.runner,
      trackEventName: operation.trackEventName,
    },
    (progress: OperationProgress) => {
      // TODO: Send this progress info to any existing ISL webview if there is one
      if (progress.kind === 'exit') {
        exitCode = progress.exitCode;
      } else if (progress.kind === 'error') {
        errorMessage = progress.error;
      }
    },
  );

  if (errorMessage != null) {
    throw new Error(errorMessage);
  }
  if (result === 'skipped') {
    throw new Error(t('Operation was skipped because a previous operation failed'));
  }
  if (exitCode != null && exitCode !== 0) {
    throw new Error(t('Command exited with code $code').replace('$code', String(exitCode)));
  }
};

/**
 * Like `runOperation`, but shows a progress notification while the operation runs.
 * Palette-invoked worktree operations otherwise give no feedback until they finish.
 */
async function runOperationWithProgress(
  ctx: RepositoryContext,
  repo: Repository,
  operation: Operation,
  title: string,
): Promise<void> {
  await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title}, () =>
    runOperation(ctx, repo, operation),
  );
}

export function registerCommands(ctx: RepositoryContext): Array<vscode.Disposable> {
  const disposables: Array<vscode.Disposable> = Object.entries(vscodeCommands).map(
    ([id, handler]) =>
      vscode.commands.registerCommand(id, (...args: Parameters<typeof handler>) =>
        ctx.tracker.operation(
          'RunVSCodeCommand',
          'VSCodeCommandError',
          {extras: {command: id}},
          () => {
            return (handler as (...args: Array<unknown>) => unknown).apply(ctx, args);
          },
        ),
      ),
  );
  return disposables;
}

function fileExists(uri: vscode.Uri): Promise<boolean> {
  return fs.promises
    .access(uri.fsPath)
    .then(() => true)
    .catch(() => false);
}

async function openDiffView(uri: vscode.Uri, comparison: Comparison): Promise<unknown> {
  const leftUri = getLeftUri(uri, comparison);
  const rightUri = await getRightUri(uri, comparison);
  const title = `${path.basename(uri.fsPath)} (${t(labelForComparison(comparison))})`;
  const opts = {viewColumn: shouldOpenBeside() ? vscode.ViewColumn.Beside : undefined};
  return executeVSCodeCommand('vscode.diff', leftUri, rightUri, title, opts);
}

function getLeftUri(uri: vscode.Uri, comparison: Comparison): vscode.Uri {
  const leftRev = beforeRevsetForComparison(comparison);
  return encodeSaplingDiffUri(uri, leftRev);
}

/**
 * Get the right side URI of the diff view.
 *
 * A raw file:// URI without encoding lets vscode directly open the file on disk.
 * This is desirable as users can edit the file on the right side of the diff view.
 *
 * There are cases, however, where editable right side does NOT make sense:
 * - comparing against a history commit (since changes on the right side may not be present)
 * - comparing submodule changes (since both side are commit hashes instead of file content)
 */
async function getRightUri(uri: vscode.Uri, comparison: Comparison): Promise<vscode.Uri> {
  const rightRev = currRevsetForComparison(comparison);
  if (
    comparison.type === ComparisonType.Committed ||
    comparison.type === ComparisonType.CommitRange ||
    isSubmodule(uri.fsPath)
  ) {
    return encodeSaplingDiffUri(uri, rightRev);
  }
  return (await fileExists(uri)) ? uri : encodeDeletedFileUri(uri);
}

function isSubmodule(path: AbsolutePath): boolean {
  const repo = repositoryCache.cachedRepositoryForPath(path);
  if (repo === undefined) {
    return false;
  }
  const submodulePaths = repo.getSubmodulePathCache();
  const relPath = repoRelativePathForAbsolutePath(path, repo);
  return submodulePaths?.has(relPath) ?? false;
}

function openRemoteFileLink(
  repo: Repository,
  uri: vscode.Uri,
  path: RepoRelativePath,
  copyToClipboard = false,
): void {
  {
    if (!repo.codeReviewProvider?.getRemoteFileURL) {
      vscode.window.showErrorMessage(
        t(`Remote link unsupported for this code review provider ($provider)`).replace(
          '$provider',
          repo.codeReviewProvider?.getSummaryName() ?? t('none'),
        ),
      );
      return;
    }

    // Grab the selection if the command is for the active file (may not be true if triggered via file explorer)
    const selection =
      vscode.window.activeTextEditor?.document.uri.fsPath === uri.fsPath
        ? vscode.window.activeTextEditor?.selection
        : null;

    const commits = repo.getSmartlogCommits()?.commits.value;
    const head = repo.getHeadCommit();
    if (!commits || !head) {
      vscode.window.showErrorMessage(t(`No commits loaded in this repository yet`));
      return;
    }
    const publicCommit = findPublicAncestor(commits, head);
    const url = repo.codeReviewProvider.getRemoteFileURL(
      path,
      publicCommit?.hash ?? null,
      selection ? {line: selection.start.line, char: selection.start.character} : undefined,
      selection ? {line: selection.end.line, char: selection.end.character} : undefined,
    );

    if (copyToClipboard) {
      vscode.env.clipboard.writeText(url);
    } else {
      vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }
}

/**
 * Resolve a `Repository` for a command invoked from the palette with no file/URI argument,
 * by listing every repository currently known to the cache and prompting via quick pick
 * if there's more than one.
 */
async function resolveRepoForWorktreeCommand(): Promise<Repository | undefined> {
  const repos = repositoryCache.getAllRepositories();

  if (repos.length === 0) {
    vscode.window.showErrorMessage(t('No Sapling repository found in the current workspace'));
    return undefined;
  }
  if (repos.length === 1) {
    return repos[0];
  }

  const picked = await vscode.window.showQuickPick(
    repos.map(repo => ({
      label: path.basename(repo.info.repoRoot),
      description: repo.info.repoRoot,
      repo,
    })),
    {placeHolder: t('Select a repository')},
  );
  return picked?.repo;
}

/**
 * Resolve a `Repository` and its `WorktreeInfo` for a worktree palette command, checking
 * that worktrees are supported/available for the resolved repo and showing an error
 * message otherwise.
 */
async function resolveWorktreeRepo(): Promise<
  {repo: Repository; worktreeInfo: WorktreeInfo} | undefined
> {
  const repo = await resolveRepoForWorktreeCommand();
  if (repo == null) {
    return undefined;
  }
  if (repo.info.worktreesSupported !== true) {
    vscode.window.showErrorMessage(
      t(
        'Worktrees are not supported for this repository (needs EdenFS or a git-backed repository)',
      ),
    );
    return undefined;
  }
  if (repo.info.isEdenFs === true && repo.info.codeReviewSystem.type === 'github') {
    vscode.window.showErrorMessage(t('Worktrees are not supported for GitHub repositories'));
    return undefined;
  }
  try {
    await repo.refreshWorktreeInfo();
  } catch (err) {
    repo.initialConnectionContext.logger.error('Failed to refresh worktree info:', err);
    vscode.window.showErrorMessage(t('Failed to refresh worktree info'));
    return undefined;
  }
  const worktreeInfo = repo.getWorktreeInfo();
  if (worktreeInfo == null) {
    vscode.window.showErrorMessage(t('Worktrees are not available for this repository'));
    return undefined;
  }
  return {repo, worktreeInfo};
}

/**
 * Wrap a command implementation so it can be called with any of:
 * - current active file Uri for use from the command palette
 * - a vscode Uri for programmatic invocations
 * - a SourceControlResourceState for use from the VS Code SCM sidebar API
 */
function commandWithUriOrResourceState(
  handler: (
    repo: Repository,
    uri: vscode.Uri,
    path: RepoRelativePath,
  ) => unknown | Thenable<unknown>,
) {
  return function (
    this: RepositoryContext,
    uriOrResource: vscode.Uri | vscode.SourceControlResourceState | undefined,
  ) {
    const uri =
      uriOrResource == null
        ? vscode.window.activeTextEditor?.document.uri
        : uriOrResource instanceof vscode.Uri
          ? uriOrResource
          : uriOrResource.resourceUri;
    if (uri == null) {
      vscode.window.showErrorMessage(t(`No active file found`));
      return;
    }

    const {fsPath} = uri;
    const repo = repositoryCache.cachedRepositoryForPath(fsPath);
    if (repo == null) {
      vscode.window.showErrorMessage(t(`No repository found for file ${fsPath}`));
      return;
    }

    const repoRelativePath = repoRelativePathForAbsolutePath(uri.fsPath, repo);
    return handler.apply(this, [repo, uri, repoRelativePath]);
  };
}
