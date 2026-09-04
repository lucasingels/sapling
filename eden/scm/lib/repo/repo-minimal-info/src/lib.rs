/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

pub mod constants;
pub mod requirements;

use std::path::Path;
use std::path::PathBuf;

use anyhow::Result;
use anyhow::bail;
use fs_err as fs;
use identity::dotgit::follow_dotgit_path;
use identity::dotgit::read_git_common_dir;
pub use requirements::Requirements;

/// RepoMinimalInfo contains:
/// - Identity.
/// - Shared path and shared identity.
/// - Repo requirements.
///
/// It can be useful by the config loader to decide extra config
/// per requirement.
#[derive(Clone)]
pub struct RepoMinimalInfo {
    pub path: PathBuf,
    pub ident: identity::Identity,
    pub shared_path: PathBuf,
    pub shared_ident: identity::Identity,
    pub store_path: PathBuf,
    pub dot_hg_path: PathBuf,
    pub shared_dot_hg_path: PathBuf,
    pub requirements: Requirements,
    pub store_requirements: Requirements,
}

impl RepoMinimalInfo {
    /// Load the minimal info from a given path.
    ///
    /// If there is no supported repo at the given path, return `None`.
    /// Does not look at ancestor directories.
    pub fn from_repo_root(mut path: PathBuf) -> Result<Self> {
        if !path.is_absolute() {
            path = fs::canonicalize(path)?;
        }
        let ident = match identity::sniff_dir(&path)? {
            Some(ident) => ident,
            None => bail!("repository {} not found!", path.display()),
        };

        // `dotgit_common` is `Some((common .git dir, main repo root))` when `path` is a linked
        // git worktree: its own git dir `<main>/.git/worktrees/<name>` holds only per-worktree
        // state, and the `commondir` file inside it points at the main `.git`.
        let (dot_git_path, dot_hg_path, dotgit_common) = if ident.is_dot_git() {
            let dot_git_path = follow_dotgit_path(path.join(".git"));
            let common_git_path = read_git_common_dir(&dot_git_path);
            let dot_dir = "sl";
            let dot_sl_path = dot_git_path.join(dot_dir);
            let dotgit_common = if common_git_path != dot_git_path {
                // The main checkout root is the parent of a `.git` common dir. A bare repo or a
                // `--separate-git-dir` layout has no checkout; use the common dir itself then.
                let main_root = match common_git_path.parent() {
                    Some(parent) if common_git_path.file_name().is_some_and(|n| n == ".git") => {
                        parent.to_path_buf()
                    }
                    _ => common_git_path.clone(),
                };
                Some((common_git_path.join(dot_dir), main_root))
            } else {
                None
            };
            (Some(dot_git_path), dot_sl_path, dotgit_common)
        } else if ident.is_dot_repo() {
            let dot_git_path = path.join(".repo/manifests/.git");
            let dot_sl_path = path.join(ident.dot_dir());
            (Some(dot_git_path), dot_sl_path, None)
        } else {
            (None, path.join(ident.dot_dir()), None)
        };

        let (shared_dot_hg_path, shared_path, shared_ident) = match dotgit_common {
            // Linked git worktree: git's `commondir` is authoritative. The `sharedpath` file
            // that `maybe_init_inside_dotgit` writes exists for the Python side and says the
            // same thing.
            Some((common_dot_hg_path, main_root)) => (common_dot_hg_path, main_root, ident),
            None => match (read_sharedpath(&dot_hg_path)?, dot_git_path) {
                (Some((shared_dot_hg_path, path, ident)), _) => (shared_dot_hg_path, path, ident),
                (None, None) => (path.join(ident.dot_dir()), path.clone(), ident),
                (None, Some(_dot_git_path)) => (dot_hg_path.clone(), path.clone(), ident),
            },
        };
        let store_path = shared_dot_hg_path.join("store");

        let requirements = Requirements::load_repo_requirements(&dot_hg_path)?;
        let store_requirements = Requirements::load_store_requirements(&store_path)?;

        let info = Self {
            path,
            ident,
            shared_path,
            shared_ident,
            store_path,
            dot_hg_path,
            shared_dot_hg_path,
            requirements,
            store_requirements,
        };

        Ok(info)
    }
}

/// Read the `sharedpath` file in `dot_path`, if any.
///
/// The file names the shared repo's dot dir (for example `/repo/.sl`, or
/// `/repo/.git/sl` for a dotgit repo). Returns
/// `(shared dot dir, shared repo root, shared identity)`.
pub fn read_sharedpath(dot_path: &Path) -> Result<Option<(PathBuf, PathBuf, identity::Identity)>> {
    let sharedpath = match fs::read_to_string(dot_path.join("sharedpath")) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    // Tolerate a trailing newline. sharedpath can be relative to our dot dir.
    let shared_dot_path = dot_path.join(sharedpath.trim_end_matches(['\n', '\r']));

    // Common case: `/repo/.sl` -> root `/repo`.
    if let Some(root) = shared_dot_path.parent() {
        if let Some(ident) = identity::sniff_dir(root)? {
            return Ok(Some((
                ident.resolve_full_dot_dir(root),
                root.to_path_buf(),
                ident,
            )));
        }
        // dotgit case: `/repo/.git/sl` -> root `/repo`. The parent (`/repo/.git`) is
        // not itself a repo root, so look one level further up.
        if root.file_name().is_some_and(|n| n == ".git") {
            if let Some(grandparent) = root.parent() {
                let grandparent = grandparent.to_path_buf();
                if let Some(ident) = identity::sniff_dir(&grandparent)? {
                    if ident.is_dot_git() {
                        return Ok(Some((shared_dot_path, grandparent, ident)));
                    }
                }
            }
        }
    }

    bail!(
        "sharedpath points to nonexistent directory {}!",
        shared_dot_path
            .parent()
            .unwrap_or(&shared_dot_path)
            .display()
    )
}
