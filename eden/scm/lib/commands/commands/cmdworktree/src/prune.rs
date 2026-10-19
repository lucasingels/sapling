/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::SystemTime;

use clidispatch::ReqCtx;
use clidispatch::abort;
use cmdutil::ConfigExt;
use cmdutil::Result;
use repo::repo::Repo;
use workingcopy::workingcopy::WorkingCopy;
use worktree::ListedWorktree;
use worktree::WorktreeKind;
use worktree::Worktrees;
use worktree_stale::Finished;

use crate::WorktreeOpts;
use crate::canonical;
use crate::dot_dir;
use crate::last_used;
use crate::remove::lock_reason_suffix;
use crate::remove::remove_and_update_registry;
use crate::remove::uncommitted_changes;
use crate::require_group;
use crate::shelves;

/// How long `prune` keeps an idle worktree after it was made or last moved.
const DEFAULT_PRUNE_MIN_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Remove the linked worktrees that are done with: clean, without shelves,
/// and on a commit that landed or was abandoned, idle for long enough, or
/// deleted behind sl's back. Never the main checkout, the current one, or a
/// locked one.
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
    let min_age: Duration = repo
        .config()
        .get_or("worktree", "prune-min-age", || DEFAULT_PRUNE_MIN_AGE)?;
    let now = SystemTime::now();

    let listed: BTreeMap<PathBuf, ListedWorktree> = worktrees
        .list()?
        .into_iter()
        .map(|wt| (canonical(&wt.path), wt))
        .collect();

    let mut reasons: BTreeMap<PathBuf, &str> = BTreeMap::new();
    for path in current_group.linked() {
        if *path == current {
            continue;
        }
        let keep = |why: String| -> Result<()> {
            ctx.io()
                .write_err(format!("keeping {}{why}\n", path.display()))?;
            Ok(())
        };
        let Some(entry) = listed.get(path) else {
            continue;
        };
        let finished = if entry.missing {
            None
        } else {
            if let Err(err) = std::fs::symlink_metadata(path) {
                keep(format!(": cannot read it: {err}"))?;
                continue;
            }
            match finished_state(repo, path, &wdir_parents) {
                Some(finished) => Some(finished),
                None => continue,
            }
        };
        // Deleted behind sl's back: nothing is left to lose but shelves.
        let reason = finished.map_or("missing", Finished::as_str);
        // A lock says the worktree is in use, e.g. by an agent.
        if let Some(lock) = &entry.locked {
            keep(format!(
                " ({reason}): it is locked{}",
                lock_reason_suffix(lock)
            ))?;
            continue;
        }
        // Shelves live in the worktree's admin dir, which goes with it.
        if dot_dir(entry).is_some_and(|dot_dir| !shelves(&dot_dir).is_empty()) {
            keep(format!(" ({reason}): it has shelved changes"))?;
            continue;
        }
        if finished.is_some_and(Finished::needs_age) {
            let used = entry.admin_dir.as_deref().and_then(last_used);
            if let Some(why) = too_young(used, now, min_age) {
                keep(format!(" ({reason}): {why}"))?;
                continue;
            }
        }
        match uncommitted_changes(ctx, repo, path) {
            Ok(changes) if changes.is_empty() => {}
            Ok(_) => {
                keep(format!(" ({reason}): it has uncommitted changes"))?;
                continue;
            }
            Err(err) => {
                keep(format!(
                    " ({reason}): cannot check for uncommitted changes: {err}"
                ))?;
                continue;
            }
        }
        reasons.insert(path.clone(), reason);
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

/// Whether the checkout at `path` is on a landed or abandoned commit, or
/// idle. A checkout in the middle of a merge, rebase, ..., without a commit,
/// or that cannot be read is kept.
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

/// Why a worktree that is only done with once unused for `min_age` stays, if
/// it does: it was made or moved, at `used`, less than `min_age` before
/// `now`, or that time is unknown.
fn too_young(used: Option<SystemTime>, now: SystemTime, min_age: Duration) -> Option<String> {
    match used {
        None => Some("cannot tell when it was last used".to_string()),
        Some(used) if now.duration_since(used).unwrap_or_default() < min_age => Some(format!(
            "it was made or moved less than {} ago",
            format_duration(min_age)
        )),
        Some(_) => None,
    }
}

/// "1d", "12h", "90s", ...: the largest unit that divides `duration`.
fn format_duration(duration: Duration) -> String {
    let secs = duration.as_secs();
    for (unit, size) in [("d", 86400), ("h", 3600), ("m", 60)] {
        if secs >= size && secs % size == 0 {
            return format!("{}{unit}", secs / size);
        }
    }
    format!("{secs}s")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_too_young() {
        let now = SystemTime::now();
        let day = Duration::from_secs(86400);
        assert_eq!(
            too_young(None, now, day).as_deref(),
            Some("cannot tell when it was last used")
        );
        assert_eq!(
            too_young(Some(now - Duration::from_secs(60)), now, day).as_deref(),
            Some("it was made or moved less than 1d ago")
        );
        // A clock that went back counts as just used.
        assert!(too_young(Some(now + Duration::from_secs(60)), now, day).is_some());
        assert_eq!(too_young(Some(now - 2 * day), now, day), None);
        assert_eq!(
            too_young(None, now, Duration::ZERO).as_deref(),
            Some("cannot tell when it was last used")
        );
    }

    #[test]
    fn test_format_duration() {
        assert_eq!(format_duration(Duration::from_secs(86400)), "1d");
        assert_eq!(format_duration(Duration::from_secs(7200)), "2h");
        assert_eq!(format_duration(Duration::from_secs(90)), "90s");
        assert_eq!(format_duration(Duration::from_secs(0)), "0s");
    }
}
