/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Worktree backends.
//!
//! `sl worktree` was written for EdenFS: a linked worktree is an `eden clone`
//! of the backing repo. For dotgit repos (a plain `.git` with sl state under
//! `.git/sl`) the same commands are implemented on top of `git worktree`, which
//! already gives every checkout its own `HEAD` and index while sharing objects,
//! refs and, through `.git/sl/store`, sl's own metadata.
//!
//! Registry, labels, locks and `list` output are shared between the two; only
//! creating and tearing down a checkout differs.

use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use fs_err as fs;
use gitcompat::GitCmd;
use gitcompat::RepoGit;
use repo::repo::Repo;
use types::HgId;
use worktree::Group;
use worktree::WorktreeEntry;
use worktree::group_id_for_main_path;
use worktree::with_registry_lock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Backend {
    /// EdenFS checkouts of a shared backing repo.
    #[cfg_attr(not(feature = "eden"), allow(dead_code))]
    Eden,
    /// Linked git worktrees of a dotgit repo.
    Git,
}

impl Backend {
    pub(crate) fn detect(repo: &Repo) -> Result<Self> {
        if repo.requirements.contains("eden") {
            #[cfg(feature = "eden")]
            {
                return Ok(Backend::Eden);
            }
            #[cfg(not(feature = "eden"))]
            {
                bail!(
                    "this build of {} has no EdenFS support; worktree commands need it for EdenFS-backed repositories",
                    identity::cli_name()
                );
            }
        }
        if repo.requirements.contains("dotgit") || repo.store_requirements.contains("dotgit") {
            return Ok(Backend::Git);
        }
        bail!("worktree commands require an EdenFS-backed or git-backed (.git) repository");
    }

    /// The command a user would run by hand to remove a checkout this backend made.
    pub(crate) fn remove_hint(self) -> &'static str {
        match self {
            Backend::Eden => "eden rm",
            Backend::Git => "git worktree remove",
        }
    }
}

fn repo_git(repo: &Repo) -> RepoGit {
    RepoGit::from_root_and_config(repo.path().to_path_buf(), repo.config().as_ref())
}

fn canonical(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path)
        .ok()
        .map(util::path::strip_unc_prefix)
}

/// Create a linked git worktree at `dest` with a detached `HEAD` at `target`
/// (or the current `HEAD` when `target` is `None`), then initialise sl's
/// per-worktree dot dir under `<common>/.git/worktrees/<name>/sl` so the label
/// marker and ISL have something to read before the first `sl` command runs there.
pub(crate) fn git_worktree_add(repo: &Repo, dest: &Path, target: Option<HgId>) -> Result<()> {
    let git = repo_git(repo);
    let mut args = vec![
        "add".to_string(),
        "--detach".to_string(),
        dest.display().to_string(),
    ];
    if let Some(target) = target {
        args.push(target.to_hex());
    }
    git.call("worktree", &args)
        .with_context(|| format!("git worktree add {}", dest.display()))?;
    gitcompat::init::maybe_init_inside_dotgit(dest, repo.ident())
        .with_context(|| format!("initializing sl state for {}", dest.display()))?;
    exclude_nested_worktree(repo, dest)?;
    Ok(())
}

/// A worktree created inside the main checkout (e.g. `<root>/.worktrees/<name>`)
/// would otherwise show up as an untracked directory in the main checkout's
/// status. Add its parent directory (or the worktree itself when created directly
/// under the root) to the common git dir's `info/exclude`, which every worktree of
/// the repo reads and which is not a tracked file.
fn exclude_nested_worktree(repo: &Repo, dest: &Path) -> Result<()> {
    let main_root = match canonical(repo.shared_path()) {
        Some(root) => root,
        None => return Ok(()),
    };
    let dest = canonical(dest).unwrap_or_else(|| dest.to_path_buf());
    let Ok(rel) = dest.strip_prefix(&main_root) else {
        return Ok(());
    };
    // Exclude the containing directory when the worktree is one level down (the
    // usual `.worktrees/<name>` layout), so later siblings are covered too.
    let excluded: &Path = match rel.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => rel,
    };
    let mut pattern = String::from("/");
    for component in excluded.components() {
        pattern.push_str(&component.as_os_str().to_string_lossy());
        pattern.push('/');
    }

    // The common git dir is the parent of the shared sl dot dir (`<common>/sl`).
    let Some(common_git_dir) = repo.shared_dot_hg_path().parent() else {
        return Ok(());
    };
    let info_dir = common_git_dir.join("info");
    let exclude_path = info_dir.join("exclude");
    let existing = match fs::read_to_string(&exclude_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    if existing.lines().any(|line| line.trim() == pattern) {
        return Ok(());
    }
    fs::create_dir_all(&info_dir)?;
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str("# sl worktree: linked worktrees created inside this checkout\n");
    content.push_str(&pattern);
    content.push('\n');
    fs::write(&exclude_path, content)
        .with_context(|| format!("updating {}", exclude_path.display()))?;
    Ok(())
}

/// Remove the linked git worktree at `path`, including its admin dir under
/// `.git/worktrees/`. `--force` because the point of `sl worktree remove` is
/// to discard the checkout; the caller has already confirmed with the user.
/// If the directory is already gone, only the stale admin dir is pruned.
pub(crate) fn git_worktree_remove(repo: &Repo, path: &Path) -> Result<()> {
    let git = repo_git(repo);
    if path.exists() {
        git.call(
            "worktree",
            &["remove", "--force", &path.display().to_string()],
        )
        .with_context(|| format!("git worktree remove {}", path.display()))?;
    } else {
        git_worktree_prune(&git)?;
    }
    Ok(())
}

/// Drop admin dirs of worktrees whose directory is gone. Without `--expire now`
/// git keeps them for `gc.worktreePruneExpire` (three months by default).
fn git_worktree_prune(git: &RepoGit) -> Result<()> {
    git.call("worktree", &["prune", "--expire", "now"])
        .context("git worktree prune")?;
    Ok(())
}

/// One entry of `git worktree list --porcelain`: the checkout path, or the
/// git dir itself for a bare main repo.
pub(crate) struct GitWorktree {
    pub(crate) path: PathBuf,
}

/// Worktrees git knows about, main (or bare) first.
pub(crate) fn git_worktree_list(repo: &Repo) -> Result<Vec<GitWorktree>> {
    let git = repo_git(repo);
    let output = git
        .call("worktree", &["list", "--porcelain"])
        .context("git worktree list")?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut result = Vec::new();
    let mut saw_prunable = false;
    for block in text.split("\n\n") {
        let mut path = None;
        let mut prunable = false;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(p));
            } else if line.starts_with("prunable") {
                prunable = true;
            }
        }
        if let Some(path) = path {
            if prunable {
                saw_prunable = true;
            } else {
                result.push(GitWorktree { path });
            }
        }
    }
    if saw_prunable {
        // A worktree directory removed behind our back: `list` drops it from the
        // registry, so drop git's admin dir for it too.
        git_worktree_prune(&git)?;
    }
    Ok(result)
}

/// Make the registry agree with git. Worktrees created with plain
/// `git worktree add` join the group (unlabelled) and entries git no longer
/// knows about are dropped, so `list`, `label` and `remove` see the same set of
/// checkouts `git worktree list` does. Labels of known entries are kept.
pub(crate) fn sync_registry_from_git(repo: &Repo) -> Result<()> {
    let git_worktrees = git_worktree_list(repo)?;
    let Some(main) = git_worktrees.first() else {
        return Ok(());
    };
    let Some(main_path) = canonical(&main.path) else {
        return Ok(());
    };
    let paths: BTreeSet<PathBuf> = git_worktrees
        .iter()
        .filter_map(|wt| canonical(&wt.path))
        .collect();

    with_registry_lock(repo.store_path(), |registry| {
        let group_id = registry
            .find_group_for_path(&main_path)
            .unwrap_or_else(|| group_id_for_main_path(&main_path));
        let group = registry
            .groups
            .entry(group_id)
            .or_insert_with(|| Group::new(main_path.clone()));
        group.worktrees.retain(|path, _| paths.contains(path));
        for path in &paths {
            group
                .worktrees
                .entry(path.clone())
                .or_insert_with(|| WorktreeEntry {
                    added: chrono::Utc::now().to_rfc3339(),
                    label: None,
                });
        }
        Ok(())
    })
}

/// Directory name for a new worktree derived from its label: runs of characters
/// outside `[A-Za-z0-9._-]` become a single `-`, leading and trailing `-` or `.`
/// are dropped, case is kept. `None` when nothing usable is left.
pub(crate) fn dir_name_from_label(label: &str) -> Option<String> {
    let mut name = String::new();
    let mut pending_dash = false;
    for ch in label.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            if pending_dash && !name.is_empty() {
                name.push('-');
            }
            pending_dash = false;
            name.push(ch);
        } else {
            pending_dash = true;
        }
    }
    let name = name.trim_matches(|c| c == '-' || c == '.');
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// The default destination when `sl worktree add` is given no PATH and no
/// `worktree.path-generator`: `<main root>/.worktrees/<label>`, or `wt_N` without a
/// label, with `_2`, `_3`, ... appended when the name is taken on disk. Nested
/// because that is what `git worktree add <name>` does at the repo root; the
/// directory is excluded from status by `git_worktree_add`.
pub(crate) fn default_nested_dest(repo: &Repo, label: &str) -> Result<PathBuf> {
    let main_root =
        canonical(repo.shared_path()).unwrap_or_else(|| repo.shared_path().to_path_buf());
    let dir = main_root.join(".worktrees");
    let taken = |name: &str| dir.join(name).exists();
    let name = match dir_name_from_label(label) {
        Some(base) => {
            if !taken(&base) {
                base
            } else {
                let mut n = 2;
                while taken(&format!("{base}_{n}")) {
                    n += 1;
                }
                format!("{base}_{n}")
            }
        }
        None => {
            let mut n = 2;
            while taken(&format!("wt_{n}")) {
                n += 1;
            }
            format!("wt_{n}")
        }
    };
    Ok(dir.join(name))
}

#[cfg(test)]
mod tests {
    use super::dir_name_from_label;

    #[test]
    fn label_to_dir_name() {
        assert_eq!(
            dir_name_from_label("ledger-fix").as_deref(),
            Some("ledger-fix")
        );
        assert_eq!(
            dir_name_from_label("  Ledger fix  ").as_deref(),
            Some("Ledger-fix")
        );
        assert_eq!(dir_name_from_label("a / b // c").as_deref(), Some("a-b-c"));
        assert_eq!(dir_name_from_label("..hidden..").as_deref(), Some("hidden"));
        assert_eq!(dir_name_from_label("v1.2_rc").as_deref(), Some("v1.2_rc"));
        assert_eq!(dir_name_from_label("---"), None);
        assert_eq!(dir_name_from_label(""), None);
        assert_eq!(dir_name_from_label("日本語"), None);
    }
}
