/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {WorktreeEntry} from './types';

import {Badge} from 'isl-components/Badge';
import {Button} from 'isl-components/Button';
import {Icon} from 'isl-components/Icon';
import {Subtle} from 'isl-components/Subtle';
import {TextField} from 'isl-components/TextField';
import {Tooltip} from 'isl-components/Tooltip';
import {useAtomValue} from 'jotai';
import {useCallback, useState} from 'react';
import {useContextMenu} from 'shared/ContextMenu';
import {basename, dirname, guessPathSep, pathsAreIdentical} from 'shared/utils';
import {defaultWorktreesDir, pickWorktreeDirName} from 'shared/worktreePaths';
import serverAPI from './ClientToServerAPI';
import {Row} from './ComponentUtils';
import css from './CwdSelector.module.css';
import {DropdownField, DropdownFields} from './DropdownFields';
import {Internal} from './Internal';
import {useFailsafeFeatureFlagSync} from './featureFlags';
import {T, t} from './i18n';
import {AddWorktreeOperation} from './operations/AddWorktreeOperation';
import {RemoveWorktreeOperation} from './operations/RemoveWorktreeOperation';
import {RenameWorktreeOperation} from './operations/RenameWorktreeOperation';
import {useRunOperation} from './operationsState';
import platform from './platform';
import {applicationinfo, repositoryInfo, worktreeInfoData} from './serverAPIState';
import {useModal} from './useModal';

function useWorktreesEnabled(): boolean {
  const worktreesEnabled = useFailsafeFeatureFlagSync(Internal.featureFlags?.Worktrees);
  const info = useAtomValue(repositoryInfo);

  // Show worktrees wherever `sl worktree` can host them: EdenFS checkouts, or git-backed
  // repos where it delegates to `git worktree`. GitHub is still excluded for EdenFS.
  return (
    worktreesEnabled &&
    info?.worktreesSupported === true &&
    !(info?.isEdenFs === true && info?.codeReviewSystem.type === 'github')
  );
}

/** Top-bar button, next to the branches button, showing the same worktree info as the repo dropdown. */
export function WorktreeButton() {
  const enabled = useWorktreesEnabled();
  if (!enabled) {
    return null;
  }
  return (
    <Tooltip
      title={<T>Worktrees</T>}
      trigger="click"
      placement="bottom"
      group="topbar"
      component={dismiss => (
        <DropdownFields
          title={<T>Worktrees</T>}
          icon="worktree"
          data-testid="worktree-details-dropdown">
          <WorktreeSection dismiss={dismiss} />
        </DropdownFields>
      )}>
      <Button icon data-testid="worktree-button">
        <Icon icon="worktree" />
      </Button>
    </Tooltip>
  );
}

export function WorktreeSection({dismiss}: {dismiss: () => unknown}) {
  const enabled = useWorktreesEnabled();
  if (!enabled) {
    return null;
  }
  return (
    <DropdownField
      title={
        <Tooltip
          title={t(
            'Worktrees are lightweight copies of your repository, like branches with their own working copy. Useful for working in parallel on the same machine.',
          )}>
          <Row>
            <T>Available Worktrees</T> <Icon icon="question" />
          </Row>
        </Tooltip>
      }>
      <WorktreeDropdown dismiss={dismiss} />
    </DropdownField>
  );
}

function WorktreeDropdown({dismiss}: {dismiss: () => unknown}) {
  const info = useAtomValue(repositoryInfo);
  const worktreeInfo = useAtomValue(worktreeInfoData);
  const repoRoot = info?.repoRoot ?? '';
  const runOperation = useRunOperation();
  const showModal = useModal();

  const allWorktrees = worktreeInfo?.worktrees ?? [];
  const sortedWorktrees = [...allWorktrees].sort((a, b) => {
    if (a.role === 'main') {
      return -1;
    }
    if (b.role === 'main') {
      return 1;
    }
    return basename(a.path, guessPathSep(a.path)).localeCompare(
      basename(b.path, guessPathSep(b.path)),
    );
  });

  const renderWorktreeRow = (wt: WorktreeEntry) => {
    const isCurrent = pathsAreIdentical(wt.path, repoRoot);
    const wtBasename = basename(wt.path, guessPathSep(wt.path));
    const rowClass = isCurrent ? css.worktreeRowCurrent : css.worktreeRow;
    const hasLabel = wt.label != null && wt.label !== '';
    return (
      <WorktreeRowWithHover
        key={wt.path}
        rowClass={rowClass}
        isCurrent={isCurrent}
        wt={wt}
        wtBasename={wtBasename}
        hasLabel={hasLabel}
        runOperation={runOperation}
        showModal={showModal}
        dismiss={dismiss}
      />
    );
  };

  return (
    <div className={css.worktreeSection} data-testid="worktree-section">
      {sortedWorktrees.map(wt => renderWorktreeRow(wt))}
      <AddWorktreeButton
        dismiss={dismiss}
        repoRoot={sortedWorktrees.find(wt => wt.role === 'main')?.path ?? repoRoot}
        existingWorktreePaths={allWorktrees.map(wt => wt.path)}
      />
    </div>
  );
}

function WorktreeRowWithHover({
  rowClass,
  isCurrent,
  wt,
  wtBasename,
  hasLabel,
  runOperation,
  showModal,
  dismiss,
}: {
  rowClass: string;
  isCurrent: boolean | undefined;
  wt: WorktreeEntry;
  wtBasename: string;
  hasLabel: boolean;
  runOperation: ReturnType<typeof useRunOperation>;
  showModal: ReturnType<typeof useModal>;
  dismiss: () => unknown;
}) {
  const appInfo = useAtomValue(applicationinfo);
  const isBasecamp = appInfo?.isBasecamp === true;
  // Right-click on the switch button offers a separate window instead.
  const switchMenu = useContextMenu<HTMLButtonElement>(() =>
    platform.platformName === 'vscode' && !isBasecamp
      ? [{label: t('Open in New Window'), onClick: () => openWorktreeInWindow(wt.path, true)}]
      : [],
  );
  return (
    <div
      key={wt.path}
      className={rowClass}
      data-testid={isCurrent ? 'current-worktree' : 'sibling-worktree'}>
      <code className={css.worktreePath} title={wt.path}>
        {hasLabel ? wt.label : wtBasename}
      </code>
      {isCurrent ? (
        <Badge className={css.activeBadge}>Active</Badge>
      ) : (
        <div className={css.worktreeActions}>
          <Tooltip title={t('Rename this worktree')}>
            <Button
              icon
              data-testid="worktree-rename-button"
              onClick={async () => {
                dismiss();
                const result = await showModal<string | undefined>({
                  type: 'custom',
                  title: <T>Rename Worktree</T>,
                  icon: 'worktree',
                  component: ({returnResultAndDismiss}) => (
                    <RenameWorktreeModal
                      returnResultAndDismiss={returnResultAndDismiss}
                      currentLabel={wt.label ?? ''}
                      wtBasename={wtBasename}
                    />
                  ),
                });
                if (result !== undefined) {
                  await runOperation(
                    new RenameWorktreeOperation(wt.path, result || undefined),
                    true,
                  );
                }
              }}>
              <Icon icon="edit" />
            </Button>
          </Tooltip>
          <Tooltip
            title={
              isBasecamp ? t('Open this worktree in a new tile') : t('Switch to this worktree')
            }>
            <Button
              icon
              data-testid="worktree-switch-button"
              onClick={() => {
                dismiss();
                if (isBasecamp) {
                  // Basecamp has no shared workspace to add the worktree to.
                  openWorktreeInWindow(wt.path, true);
                  return;
                }
                switchToWorktree(wt.path);
              }}
              onContextMenu={switchMenu}>
              <Icon icon="arrow-swap" />
            </Button>
          </Tooltip>
          {wt.role === 'main' ? (
            <Tooltip title={t('The main worktree cannot be removed')}>
              <Button icon disabled data-testid="worktree-remove-button">
                <Icon icon="trash" />
              </Button>
            </Tooltip>
          ) : (
            <Tooltip title={t('Remove this worktree at $path', {replace: {$path: wt.path}})}>
              <Button
                icon
                data-testid="worktree-remove-button"
                onClick={async () => {
                  dismiss();
                  const confirmed = await showModal({
                    type: 'confirm',
                    title: <T>Remove Worktree</T>,
                    icon: 'worktree',
                    message: (
                      <span>
                        <Row>
                          <T replace={{$path: <code>{hasLabel ? wt.label : wtBasename}</code>}}>
                            Are you sure you want to remove the worktree $path?
                          </T>
                        </Row>
                        <Row style={{marginTop: 'var(--pad)'}}>
                          <Subtle>
                            <T>
                              Any uncommitted changes and shelves in this worktree will be lost
                              forever.
                            </T>
                          </Subtle>
                        </Row>
                      </span>
                    ),
                    buttons: [{label: t('Cancel')}, {label: t('Remove'), primary: true}],
                  });
                  if (confirmed?.label === t('Remove')) {
                    await runOperation(new RemoveWorktreeOperation(wt.path), true);
                    forgetWorktreeInWorkspace(wt.path);
                  }
                }}>
                <Icon icon="trash" />
              </Button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

function AddWorktreeButton({
  dismiss,
  repoRoot,
  existingWorktreePaths,
}: {
  dismiss: () => unknown;
  repoRoot: string;
  existingWorktreePaths: string[];
}) {
  const showModal = useModal();
  const runOperation = useRunOperation();
  const sep = guessPathSep(repoRoot);
  const worktreesDir = defaultWorktreesDir(repoRoot, sep);

  // New worktrees go in a hidden directory inside the main worktree, named after the label.
  const defaultDestForLabel = useCallback(
    (label: string) => {
      const takenNames = new Set(
        existingWorktreePaths
          .filter(p => pathsAreIdentical(dirname(p, guessPathSep(p)), worktreesDir))
          .map(p => basename(p, guessPathSep(p))),
      );
      return `${worktreesDir}${sep}${pickWorktreeDirName(label, name => takenNames.has(name))}`;
    },
    [existingWorktreePaths, worktreesDir, sep],
  );

  const onClickAdd = useCallback(async () => {
    dismiss();
    const result = await showModal<AddWorktreeResult>({
      type: 'custom',
      title: (
        <Row>
          <T>Add Worktree</T>{' '}
          <Tooltip
            title={t(
              'Worktrees are lightweight copies of your repository, like branches with their own working copy. Useful for working in parallel on the same machine.',
            )}>
            <Icon icon="question" />
          </Tooltip>
        </Row>
      ),
      icon: 'worktree',
      maxWidth: 500,
      component: ({returnResultAndDismiss}) => (
        <AddWorktreeModal
          returnResultAndDismiss={returnResultAndDismiss}
          defaultDestForLabel={defaultDestForLabel}
        />
      ),
    });
    if (result != null) {
      // Creating a worktree never opens or switches to it: the worktree panel is
      // the way in, and the operation list already shows the progress.
      await runOperation(new AddWorktreeOperation(result.destPath, result.label || undefined), true);
    }
  }, [dismiss, showModal, runOperation, defaultDestForLabel]);

  return (
    <Button
      data-testid="add-worktree-button"
      className={css.addWorktreeButton}
      onClick={onClickAdd}>
      <Icon icon="plus" /> <T>Add Worktree</T>
    </Button>
  );
}

type AddWorktreeResult = {
  destPath: string;
  label: string;
};

function AddWorktreeModal({
  returnResultAndDismiss,
  defaultDestForLabel,
}: {
  returnResultAndDismiss: (result: AddWorktreeResult) => void;
  defaultDestForLabel: (label: string) => string;
}) {
  // Until the path is edited by hand, it follows the label as the user types.
  const [customDest, setCustomDest] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const destPath = customDest ?? defaultDestForLabel(label);
  const [isEditingPath, setIsEditingPath] = useState(false);

  return (
    <div className={css.addWorktreeForm} data-testid="add-worktree-form">
      <TextField
        data-testid="add-worktree-label"
        placeholder={t('Label (optional)')}
        value={label}
        onInput={e => setLabel(e.currentTarget?.value ?? '')}
      />
      <div className={css.worktreeLocationSection}>
        <Subtle className={css.worktreeLocationLabel}>
          <Tooltip title={<T>Location on disk where the worktree files will be created</T>}>
            <T>Worktree root path</T>
          </Tooltip>
        </Subtle>
        {isEditingPath ? (
          <TextField
            data-testid="add-worktree-path"
            value={destPath}
            onInput={e => setCustomDest(e.currentTarget?.value ?? '')}
            onBlur={() => setIsEditingPath(false)}
            autoFocus
          />
        ) : (
          <div
            className={css.worktreePathDisplay}
            onClick={() => setIsEditingPath(true)}
            data-testid="add-worktree-edit-path">
            <code className={css.worktreePathText}>{destPath}</code>
            <Icon icon="edit" className={css.worktreePathEditIcon} />
          </div>
        )}
      </div>
      <div className={css.addWorktreeFormActions}>
        <Button
          primary
          data-testid="add-worktree-submit"
          disabled={destPath.trim() === ''}
          onClick={() =>
            returnResultAndDismiss({
              destPath: destPath.trim(),
              label: label.trim(),
            })
          }>
          <T>Create</T>
        </Button>
      </div>
    </div>
  );
}

export function RenameWorktreeModal({
  returnResultAndDismiss,
  currentLabel,
  wtBasename,
}: {
  returnResultAndDismiss: (result: string | undefined) => void;
  currentLabel: string;
  wtBasename: string;
}) {
  const [newLabel, setNewLabel] = useState(currentLabel);

  return (
    <div className={css.addWorktreeForm} data-testid="rename-worktree-form">
      <Subtle>
        <T replace={{$path: <code>{wtBasename}</code>}}>Set a display label for worktree $path</T>
      </Subtle>
      <TextField
        data-testid="rename-worktree-label"
        placeholder={t('Label (leave empty to remove)')}
        value={newLabel}
        onInput={e => setNewLabel(e.currentTarget?.value ?? '')}
        autoFocus
      />
      <div className={css.addWorktreeFormActions}>
        <Button
          primary
          data-testid="rename-worktree-submit"
          onClick={() => returnResultAndDismiss(newLabel.trim())}>
          {newLabel.trim() === '' ? t('Remove label') : t('Save')}
        </Button>
      </div>
    </div>
  );
}

export function changeCwd(newCwd: string) {
  serverAPI.postMessage({
    type: 'changeCwd',
    cwd: newCwd,
  });
  serverAPI.cwdChanged();
}

/**
 * Show the worktree at `path` in this ISL. In VS Code the worktree is first added
 * to the current workspace as a folder (a no-op if it already is one), so the
 * editor keeps its windows and workspace instead of reloading onto a bare folder.
 */
export function switchToWorktree(path: string) {
  if (platform.platformName === 'vscode') {
    serverAPI.postMessage({type: 'platform/addToWorkspace', path});
  }
  changeCwd(path);
}

/** After a worktree is removed, drop its folder from the VS Code workspace too. */
export function forgetWorktreeInWorkspace(path: string) {
  if (platform.platformName === 'vscode') {
    serverAPI.postMessage({type: 'platform/removeFromWorkspace', path});
  }
}

/** Ask the host platform to open `path` either in the current window or a new one. */
export function openWorktreeInWindow(path: string, newWindow: boolean) {
  if (newWindow) {
    serverAPI.postMessage({type: 'platform/openInNewWindow', path});
  } else {
    serverAPI.postMessage({type: 'platform/openFolder', path});
  }
}
