/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {UICodeReviewProvider} from './codeReview/UICodeReviewProvider';
import type {Operation} from './operations/Operation';
import type {CommitInfo, DiffSummary, Hash} from './types';

import {Button} from 'isl-components/Button';
import {Icon} from 'isl-components/Icon';
import {Tooltip} from 'isl-components/Tooltip';
import {useAtomValue} from 'jotai';
import {OperationDisabledButton} from './OperationDisabledButton';
import {allDiffSummaries, codeReviewProvider} from './codeReview/CodeReviewInfo';
import {t, T} from './i18n';
import {HideOperation} from './operations/HideOperation';
import {PullOperation} from './operations/PullOperation';
import {useRunOperation} from './operationsState';
import {type Dag, dagWithPreviews} from './previews';
import {latestSuccessorUnlessExplicitlyObsolete} from './successionUtils';
import {exactRevset} from './types';

export function isStackEligibleForCleanup(
  hash: Hash,
  dag: Dag,
  diffMap: Map<string, DiffSummary>,
  provider: UICodeReviewProvider,
): boolean {
  return dag
    .descendants(hash)
    .toSeq()
    .every(h => {
      const info = dag.get(h);
      // don't allow hiding a stack you're checked out on
      if (info == null || info.isDot) {
        return false;
      }
      // allow clean up obsoleted commits regardless of review state
      if (info.successorInfo != null) {
        return true;
      }
      // if not obsoleted, still allow cleanup for "Closed" diffs
      if (info.diffId != null) {
        const diffInfo = diffMap.get(info.diffId);
        if (diffInfo != null && provider.isDiffEligibleForCleanup(diffInfo)) {
          return true;
        }
      }
      // no cleanup otherwise
      return false;
    });
}

/** Stack roots that Clean up already pulled for; see `cleanupOperations`. */
const pulledForCleanup = new Set<Hash>();

/**
 * The operations that clean up the stacks starting at `hashes`.
 *
 * Commits whose diffs landed but that a pull has not yet marked as landed are pulled
 * instead of hidden: pulling marks them landed, which hides them and moves worktrees
 * on them onto the landed versions, while hiding them would leave such worktrees on
 * hidden commits. A stack with other commits too is hidden after the pull, by its
 * exact hash, since its root's successor is then the landed, public commit.
 *
 * The pull leaves a draft alone when it may hold work that did not land, so a stack
 * that is still there after its pull is hidden the next time it is cleaned up.
 */
export function cleanupOperations(
  hashes: ReadonlyArray<Hash>,
  dag: Dag,
  diffMap: Map<string, DiffSummary>,
  provider: UICodeReviewProvider,
): Array<Operation> {
  const isUnpulledLanding = (h: Hash): boolean => {
    const info = dag.get(h);
    if (info == null || info.successorInfo != null || info.diffId == null) {
      return false;
    }
    const diffInfo = diffMap.get(info.diffId);
    return diffInfo != null && provider.isDiffLanded?.(diffInfo) === true;
  };

  let pull = false;
  const hides: Array<Operation> = [];
  for (const hash of hashes) {
    const info = dag.get(hash);
    if (info == null) {
      continue;
    }
    const stack = dag.descendants(hash).toArray();
    const landed = stack.filter(isUnpulledLanding);
    if (landed.length === 0 || pulledForCleanup.has(hash)) {
      hides.push(new HideOperation(latestSuccessorUnlessExplicitlyObsolete(info)));
      continue;
    }
    pulledForCleanup.add(hash);
    pull = true;
    if (landed.length < stack.length) {
      hides.push(new HideOperation(exactRevset(hash)));
    }
  }
  return pull ? [new PullOperation(), ...hides] : hides;
}

export function CleanupButton({commit, hasChildren}: {commit: CommitInfo; hasChildren: boolean}) {
  const runOperation = useRunOperation();
  const dag = useAtomValue(dagWithPreviews);
  const reviewProvider = useAtomValue(codeReviewProvider);
  const diffMap = useAtomValue(allDiffSummaries)?.value;
  return (
    <Tooltip
      title={
        hasChildren
          ? t('You can safely "clean up" by hiding this stack of commits.')
          : t('You can safely "clean up" by hiding this commit.')
      }
      placement="bottom">
      <Button
        icon
        onClick={() => {
          const operations =
            diffMap == null || reviewProvider == null
              ? [new HideOperation(latestSuccessorUnlessExplicitlyObsolete(commit))]
              : cleanupOperations([commit.hash], dag, diffMap, reviewProvider);
          for (const operation of operations) {
            runOperation(operation);
          }
        }}>
        <Icon icon="eye-closed" slot="start" />
        {hasChildren ? <T>Clean up stack</T> : <T>Clean up</T>}
      </Button>
    </Tooltip>
  );
}

export function CleanupAllButton() {
  const dag = useAtomValue(dagWithPreviews);
  const reviewProvider = useAtomValue(codeReviewProvider);
  const diffMap = useAtomValue(allDiffSummaries)?.value;
  if (diffMap == null || reviewProvider == null) {
    return null;
  }

  const stackBases = dag.roots(dag.draft()).toArray();
  const cleanableStacks = stackBases.filter(hash =>
    isStackEligibleForCleanup(hash, dag, diffMap, reviewProvider),
  );

  const disabled = cleanableStacks.length === 0;
  return (
    <Tooltip
      title={
        disabled
          ? t('No landed or closed commits to hide')
          : t('Hide all commits for landed or closed Diffs')
      }>
      <OperationDisabledButton
        contextKey="cleanup-all"
        runOperation={() => cleanupOperations(cleanableStacks, dag, diffMap, reviewProvider)}
        icon={<Icon icon="eye-closed" slot="start" />}
        disabled={disabled}>
        <T>Clean up all</T>
      </OperationDisabledButton>
    </Tooltip>
  );
}
