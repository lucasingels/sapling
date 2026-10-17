/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use clidispatch::ReqCtx;
use clidispatch::abort;
use cmdutil::Result;
use repo::repo::Repo;
use workingcopy::workingcopy::WorkingCopy;
use worktree::WorktreeKind;
use worktree::Worktrees;
use worktree_stale::Finished;

use crate::WorktreeOpts;
use crate::canonical;
use crate::remove::remove_and_update_registry;
use crate::remove::uncommitted_changes;
use crate::require_group;

/// Remove the linked worktrees that are done with: clean, and on a commit that
/// landed or was abandoned. Never the main checkout or the current one.
pub(crate) fn run(
    ctx: &ReqCtx<WorktreeOpts>,
    repo: &Repo,
    _wc: &WorkingCopy,
    worktrees: &Worktrees,
) -> Result<u8> {
    if ctx.opts.args.len() > 1 {
        abort!("usage: sl worktree prune [--dry-run] [-y]");
    }
    if ctx.opts.force {
        abort!("--force cannot be used with 'worktree prune'");
    }
    if worktrees.kind() != WorktreeKind::Git {
        abort!("'worktree prune' only supports git worktrees");
    }

    let current_group = require_group(repo, worktrees)?;
    let current = canonical(repo.path());
    // Commits under the current checkout are not abandoned while it builds on them.
    let wdir_parents = workingcopy::fast_path_wdir_parents(repo.path(), repo.ident())?.to_vec();

    let mut reasons: BTreeMap<PathBuf, &str> = BTreeMap::new();
    for path in current_group.linked() {
        if *path == current {
            continue;
        }
        let Some(finished) = finished_state(repo, path, &wdir_parents) else {
            continue;
        };
        let changes = uncommitted_changes(ctx, repo, path)?;
        if !changes.is_empty() {
            ctx.io().write_err(format!(
                "keeping {} ({}): it has uncommitted changes\n",
                path.display(),
                finished.as_str()
            ))?;
            continue;
        }
        reasons.insert(path.clone(), finished.as_str());
    }

    if reasons.is_empty() {
        ctx.logger().info("no worktrees to prune");
        return Ok(0);
    }
    if ctx.opts.dry_run {
        for (path, reason) in &reasons {
            ctx.io()
                .write(format!("would remove {} ({reason})\n", path.display()))?;
        }
        return Ok(0);
    }

    let targets: Vec<&Path> = reasons.keys().map(|path| path.as_path()).collect();
    remove_and_update_registry(ctx, repo, &current_group, &targets, &reasons, worktrees)?;
    Ok(0)
}

/// Whether the checkout at `path` is on a landed or abandoned commit. A
/// checkout in the middle of a merge, rebase, ..., without a commit, or that
/// cannot be read is kept.
fn finished_state(repo: &Repo, path: &Path, wdir_parents: &[types::HgId]) -> Option<Finished> {
    let parents = match workingcopy::fast_path_wdir_parents(path, repo.ident()) {
        Ok(parents) => parents,
        Err(err) => {
            tracing::warn!("cannot read the commit of {}: {err:?}", path.display());
            return None;
        }
    };
    if parents.p2().is_some() {
        return None;
    }
    let p1 = parents.p1()?;
    worktree_stale::other_checkout_finished(repo, path, p1, wdir_parents).unwrap_or_else(|err| {
        tracing::warn!(
            "cannot check whether {} is done with: {err:?}",
            path.display()
        );
        None
    })
}
