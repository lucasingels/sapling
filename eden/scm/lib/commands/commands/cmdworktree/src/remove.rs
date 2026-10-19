/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Error;
use clidispatch::ReqCtx;
use clidispatch::abort;
use cmdutil::Result;
use pathmatcher::AlwaysMatcher;
use repo::repo::Repo;
use workingcopy::workingcopy::WorkingCopy;
use worktree::WorktreeKind;
use worktree::Worktrees;
use worktree::dissolve_group_if_empty;
use worktree::lock_worktree_path_op;
use worktree::with_registry_lock;
use worktree::with_worktree_path_op_lock;

use crate::CurrentGroup;
use crate::WorktreeOpts;
use crate::require_group;

pub(crate) fn run(
    ctx: &ReqCtx<WorktreeOpts>,
    repo: &Repo,
    _wc: &WorkingCopy,
    worktrees: &Worktrees,
) -> Result<u8> {
    let current_group = require_group(repo, worktrees)?;

    if ctx.opts.all {
        return run_remove_all(ctx, repo, &current_group, worktrees);
    }

    let path_args = &ctx.opts.args[1..];
    if path_args.is_empty() {
        abort!("usage: sl worktree remove PATH [PATH...]");
    }

    let targets: BTreeSet<PathBuf> = path_args
        .iter()
        .map(|s| -> Result<PathBuf> {
            Ok(util::path::strip_unc_prefix(
                util::path::canonical_path_allow_missing(s)?,
            ))
        })
        .collect::<Result<_>>()?;
    let target_refs: Vec<&Path> = targets.iter().map(|p| p.as_path()).collect();
    validate_targets(&current_group, &target_refs)?;

    remove_and_update_registry(
        ctx,
        repo,
        &current_group,
        &target_refs,
        &BTreeMap::new(),
        worktrees,
    )?;

    // NOTE: Add post-worktree-remove hook if the need arises. Note that the
    // hook's cwd (repo.path()) may not exist if the user removed the worktree
    // they were standing in (see D98226466).

    Ok(0)
}

/// Validate that all user-specified paths are removable linked worktrees.
fn validate_targets(current_group: &CurrentGroup, targets: &[&Path]) -> Result<()> {
    for target in targets {
        if !current_group.members.contains(*target) {
            if let Some(parent_wt) = current_group.members.iter().find(|wt| target.starts_with(wt)) {
                abort!(
                    "{} is not the root of checkout {}, not removing",
                    target.display(),
                    parent_wt.display()
                );
            }
            abort!(
                "{} is not in this worktree group, use `{}` instead",
                target.display(),
                current_group.kind.remove_command()
            );
        }
        if *target == current_group.main {
            abort!("cannot remove a main worktree with linked worktrees");
        }
    }
    Ok(())
}

/// Confirm, run hooks, tear down EdenFS mounts, and update the worktree registry.
/// `reasons` says why some targets go, for the prompt and the report.
pub(crate) fn remove_and_update_registry(
    ctx: &ReqCtx<WorktreeOpts>,
    repo: &Repo,
    current_group: &CurrentGroup,
    targets: &[&Path],
    reasons: &BTreeMap<PathBuf, &str>,
    worktrees: &Worktrees,
) -> Result<()> {
    if targets.is_empty() {
        return Ok(());
    }

    let logger = ctx.logger();

    let changes = check_uncommitted_changes(ctx, repo, targets)?;
    confirm_remove(ctx, targets, &changes, reasons)?;

    let pre_hooks = hook::Hooks::from_config(repo.config(), ctx.io(), "pre-worktree-remove");
    let multi_target = targets.len() > 1;
    let mut removed_paths = Vec::new();
    let mut remove_error: Option<Error> = None;
    for &target in targets {
        let result = with_worktree_path_op_lock(&current_group.shared_store_path, target, || {
            pre_hooks.run_hooks(
                Some(repo),
                false,
                Some(&HashMap::from([(
                    "path".to_string(),
                    target.display().to_string(),
                )])),
            )?;
            remove_checkout(ctx, repo, worktrees, target)?;
            Ok(())
        });
        match result {
            Ok(()) => {
                removed_paths.push(target);
                logger.info(format!(
                    "removed {}{}",
                    target.display(),
                    reason_suffix(reasons, target)
                ));
            }
            Err(err) if multi_target => {
                logger.warn(format!("failed to remove {}: {}", target.display(), err));
                if remove_error.is_none() {
                    remove_error = Some(err);
                }
            }
            Err(err) => return Err(err),
        }
    }

    finalize_registry_removal(current_group, &removed_paths)?;

    if let Some(err) = remove_error {
        return Err(err);
    }

    Ok(())
}

fn finalize_registry_removal(current_group: &CurrentGroup, removed_paths: &[&Path]) -> Result<()> {
    if removed_paths.is_empty() {
        return Ok(());
    }

    with_registry_lock(&current_group.shared_store_path, |registry| {
        if let Some(grp) = registry.groups.get_mut(&current_group.group_id) {
            for path in removed_paths {
                grp.worktrees.remove(*path);
            }
        }
        // A git group outlives its linked worktrees: it keeps the main checkout's label.
        if current_group.kind == WorktreeKind::Eden {
            dissolve_group_if_empty(registry, &current_group.group_id);
        }
        Ok(())
    })?;

    Ok(())
}

fn run_remove_all(
    ctx: &ReqCtx<WorktreeOpts>,
    repo: &Repo,
    current_group: &CurrentGroup,
    worktrees: &Worktrees,
) -> Result<u8> {
    let logger = ctx.logger();
    let candidate_paths: Vec<PathBuf> = current_group.linked().cloned().collect();
    if candidate_paths.is_empty() {
        logger.info("no linked worktrees to remove");
        return Ok(0);
    }

    // Lock all target worktrees in a stable order so overlapping bulk removes
    // cannot deadlock and no target can change underneath this operation.
    let mut sorted_paths = candidate_paths.clone();
    sorted_paths.sort();
    let _path_locks = sorted_paths
        .iter()
        .map(|path| lock_worktree_path_op(&current_group.shared_store_path, path))
        .collect::<Result<Vec<_>>>()?;

    // Some selected paths may have been removed while this command waited for
    // their path locks. Filter those stale candidates out before prompting.
    // There is still a possible race if a worktree is quickly removed and
    // re-added at the same path before we acquire the path lock; the registry
    // currently tracks worktrees by path, not by per-entry generation.
    let still_present = require_group(repo, worktrees)
        .map(|group| group.members)
        .unwrap_or_default();
    let linked_paths: Vec<PathBuf> = candidate_paths
        .into_iter()
        .filter(|path| still_present.contains(path))
        .collect();
    if linked_paths.is_empty() {
        logger.info("no linked worktrees to remove");
        return Ok(0);
    }

    let path_refs: Vec<&Path> = linked_paths.iter().map(|p| p.as_path()).collect();
    let changes = check_uncommitted_changes(ctx, repo, &path_refs)?;
    confirm_remove(ctx, &path_refs, &changes, &BTreeMap::new())?;

    let pre_hooks = hook::Hooks::from_config(repo.config(), ctx.io(), "pre-worktree-remove");
    let mut removed_paths = Vec::new();
    let mut remove_error: Option<Error> = None;
    for path in &linked_paths {
        pre_hooks.run_hooks(
            Some(repo),
            false,
            Some(&HashMap::from([(
                "path".to_string(),
                path.display().to_string(),
            )])),
        )?;
        match remove_checkout(ctx, repo, worktrees, path) {
            Ok(()) => {}
            Err(err) => {
                logger.warn(format!("failed to remove {}: {}", path.display(), err));
                if remove_error.is_none() {
                    remove_error = Some(err);
                }
                continue;
            }
        }
        removed_paths.push(path.clone());
    }

    let removed_path_refs: Vec<&Path> = removed_paths.iter().map(|p| p.as_path()).collect();
    finalize_registry_removal(current_group, &removed_path_refs)?;
    for path in &removed_paths {
        logger.info(format!("removed {}", path.display()));
    }

    if let Some(err) = remove_error {
        return Err(err);
    }

    // NOTE: Add post-worktree-remove hook if the need arises. See single-remove
    // path above for cwd caveat.

    Ok(0)
}

/// Tear down the checkout at `path` with the backend that created it.
///
/// EdenFS: run `eden remove`. If the checkout directory is already gone (e.g.
/// removed externally via `eden rm`), skip the call and return Ok so the caller
/// can proceed to clean the worktree registry.
///
/// Git: see `Worktrees::remove`.
fn remove_checkout(
    ctx: &ReqCtx<WorktreeOpts>,
    repo: &Repo,
    worktrees: &Worktrees,
    path: &Path,
) -> Result<()> {
    match worktrees.kind() {
        WorktreeKind::Git => Ok(worktrees.remove(path)?),
        WorktreeKind::Eden => {
            if !path.exists() {
                ctx.logger().warn(format!(
                    "eden checkout {} not found on disk, continuing to remove from registry",
                    path.display()
                ));
                return Ok(());
            }
            #[cfg(feature = "eden")]
            {
                edenfs_client::run_eden_remove(repo.config().as_ref(), path)
            }
            #[cfg(not(feature = "eden"))]
            {
                let _ = repo;
                abort!("EdenFS support is not compiled in");
            }
        }
    }
}

/// `sl status` lines of each checkout in `paths` that has uncommitted changes.
/// Untracked files count: they go with the checkout. Without `--force`, list
/// them and abort; with it, return them for the confirmation prompt (skipped
/// with `-y`, which has no prompt).
fn check_uncommitted_changes(
    ctx: &ReqCtx<WorktreeOpts>,
    repo: &Repo,
    paths: &[&Path],
) -> Result<BTreeMap<PathBuf, Vec<String>>> {
    let mut changes = BTreeMap::new();
    if ctx.opts.force && ctx.global_opts().noninteractive {
        return Ok(changes);
    }
    for &path in paths {
        let lines = uncommitted_changes(ctx, repo, path)?;
        if !lines.is_empty() {
            changes.insert(path.to_path_buf(), lines);
        }
    }
    if !ctx.opts.force && !changes.is_empty() {
        for (path, lines) in &changes {
            ctx.io()
                .write_err(format!("{} has uncommitted changes:\n", path.display()))?;
            for line in lines {
                ctx.io().write_err(format!("  {line}\n"))?;
            }
        }
        abort!("not removing worktrees with uncommitted changes (use --force to remove them anyway)");
    }
    Ok(changes)
}

/// The `sl status` lines of the checkout at `path`, untracked files included.
pub(crate) fn uncommitted_changes(
    ctx: &ReqCtx<WorktreeOpts>,
    repo: &Repo,
    path: &Path,
) -> Result<Vec<String>> {
    // A checkout already gone behind our back has nothing left to lose. One
    // that cannot be read is not gone: the status below fails for it.
    if worktree::is_missing(path) {
        return Ok(Vec::new());
    }
    // A git worktree made with plain git has no sl state until the first `sl`
    // command there; set it up the way that command would.
    gitcompat::init::maybe_init_inside_dotgit(path, repo.ident())?;
    let wc = Repo::load(path, &[])?.working_copy()?;
    let status = wc
        .read()
        .status(&ctx.core, Arc::new(AlwaysMatcher::new()), false)?;
    // In `sl status` order.
    let mut lines = Vec::new();
    for (letter, mut files) in [
        ("M", status.modified().collect::<Vec<_>>()),
        ("A", status.added().collect()),
        ("R", status.removed().collect()),
        ("!", status.deleted().collect()),
        ("?", status.unknown().collect()),
    ] {
        files.sort();
        lines.extend(files.into_iter().map(|file| format!("{letter} {file}")));
    }
    Ok(lines)
}

fn reason_suffix(reasons: &BTreeMap<PathBuf, &str>, path: &Path) -> String {
    reasons
        .get(path)
        .map(|reason| format!(" ({reason})"))
        .unwrap_or_default()
}

fn confirm_remove(
    ctx: &ReqCtx<WorktreeOpts>,
    paths: &[&Path],
    changes: &BTreeMap<PathBuf, Vec<String>>,
    reasons: &BTreeMap<PathBuf, &str>,
) -> Result<()> {
    if ctx.global_opts().noninteractive {
        return Ok(());
    }

    let is_interactive = ctx.io().with_input(|input| input.is_tty());
    if !is_interactive {
        abort!("running non-interactively, use -y instead");
    }

    let write_changes = |path: &Path, indent: &str| -> Result<()> {
        if let Some(lines) = changes.get(path) {
            ctx.io()
                .write(format!("{indent}uncommitted changes that will be lost:\n"))?;
            for line in lines {
                ctx.io().write(format!("{indent}  {line}\n"))?;
            }
        }
        Ok(())
    };
    if paths.len() == 1 {
        ctx.io().write(format!(
            "will remove {}{}\n",
            paths[0].display(),
            reason_suffix(reasons, paths[0])
        ))?;
        write_changes(paths[0], "")?;
    } else {
        ctx.io()
            .write(format!("will remove {} worktrees:\n", paths.len()))?;
        for p in paths {
            ctx.io()
                .write(format!("  {}{}\n", p.display(), reason_suffix(reasons, p)))?;
            write_changes(p, "    ")?;
        }
    }
    ctx.io().write("proceed? [y/N] ")?;
    ctx.io().flush()?;

    let mut input = ctx.io().input();
    let mut line = String::new();
    let mut reader = std::io::BufReader::new(&mut input);
    reader.read_line(&mut line)?;
    let answer = line.trim();
    if !(answer.eq_ignore_ascii_case("y") || answer.eq_ignore_ascii_case("yes")) {
        abort!("aborted by user");
    }
    Ok(())
}
