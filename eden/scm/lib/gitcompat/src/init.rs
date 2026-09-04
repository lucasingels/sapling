/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use std::collections::BTreeMap;
use std::env;
use std::io;
use std::path::MAIN_SEPARATOR_STR as SEP;
use std::path::Path;
use std::path::PathBuf;

use anyhow::Result;
use filetime::FileTime;
use filetime::set_file_mtime;
use fs_err as fs;
use identity::Identity;
use identity::dotgit::follow_dotgit_path;
use identity::dotgit::read_git_common_dir;
use tracing::debug;
use types::HgId;

use crate::BareGit;
use crate::refs::ReferenceValue;

/// Initialize and update Sapling's dotdir inside `.git/`.
/// - Write requirements, on demand.
/// - Update config files from translated Git config, on demand.
/// - Update "bookmarks.current".
///
/// Skip if `ident` is not using `.git/sl` dot dir.
///
/// `dot_dir` is expected to be something like `<prefix>/.git/sl`.
pub fn maybe_init_inside_dotgit(root_path: &Path, ident: Identity) -> Result<()> {
    if !ident.is_dot_git() {
        return Ok(());
    }

    let dot_git_path = follow_dotgit_path(root_path.join(".git"));
    // For a linked git worktree, `dot_git_path` is `<main>/.git/worktrees/<name>` (per-worktree
    // state: HEAD, index) and `common_git_path` is `<main>/.git` (objects, shared refs). The
    // per-worktree sl dot dir (dirstate, bookmarks.current, wlock) lives under the former; the
    // shared store (metalog, segments, mutation) under the latter, exactly like `sl share`.
    let common_git_path = read_git_common_dir(&dot_git_path);
    let is_linked_worktree = common_git_path != dot_git_path;
    let dot_dir = dot_git_path.join("sl");
    let shared_dot_dir = common_git_path.join("sl");
    let store_dir = shared_dot_dir.join("store");

    // Shared store. Check for existence of "requires" file so we can fix repo dirs that already
    // exist but are missing requires file.
    if !store_dir.join("requires").exists() {
        fs::create_dir_all(&store_dir)?;
        fs::write(shared_dot_dir.join("requires"), "store\ndotgit\n")?;
        fs::write(
            store_dir.join("requires"),
            "narrowheads\nvisibleheads\ngit\ngit-store\ndotgit\n",
        )?;
        fs::write(store_dir.join("gitdir"), format!("..{SEP}.."))?;
    }

    // Per-checkout dot dir. For the main checkout this is `shared_dot_dir` itself. Kept
    // independent of the block above: the first `sl` run may happen in a linked worktree,
    // which creates the shared store but must not leave the main checkout half-initialized.
    if is_linked_worktree {
        // Keyed on `sharedpath`, not `requires`: an `sl` that predates worktree support left
        // `requires` (without `shared`) and an empty private store here. Rewriting `requires`
        // and adding `sharedpath` repairs that; the stale store dir is simply ignored.
        if !dot_dir.join("sharedpath").exists() {
            fs::create_dir_all(&dot_dir)?;
            fs::write(dot_dir.join("requires"), "store\ndotgit\nshared\n")?;
            // Point at the shared dot dir, like `sl share` does. Both the Rust
            // (`repo-minimal-info`) and Python (`localrepo`) readers accept the
            // shared dot dir itself as the value.
            fs::write(
                dot_dir.join("sharedpath"),
                shared_dot_dir.to_string_lossy().as_bytes(),
            )?;
        }
    } else if !dot_dir.join("requires").exists() {
        fs::create_dir_all(&dot_dir)?;
        fs::write(dot_dir.join("requires"), "store\ndotgit\n")?;
    }
    if !dot_dir.join("dirstate").exists() {
        // Write an empty eden dirstate so it can be loaded.
        init_empty_dirstate(&dot_dir)?;
    }

    // Sync git config to "config-git-user", "config-git-repo".
    // Skip if file mtime is up to date (since shelling out to `git config` might take time).
    let user_config_path = translated_git_user_config_path(&dot_dir, ident);
    let repo_config_path = translated_git_repo_config_path(&dot_dir, ident);
    let git_repo_mtime = git_repo_config_mtime(&common_git_path);
    let git_user_mtime = git_user_config_mtime();

    // NOTE: At this point no sapling config is loaded. For simplicity, this does not respect `ui.git`.
    let git = BareGit::from_git_dir_and_config(dot_git_path, &BTreeMap::<String, String>::new());

    if git_repo_mtime != try_mtime(&repo_config_path)
        || git_user_mtime != try_mtime(&user_config_path)
    {
        debug!("translating git configs");
        let (user_config, repo_config) = git.translate_git_config()?;
        fs::write(&user_config_path, user_config)?;
        fs::write(&repo_config_path, repo_config)?;
        set_file_mtime(&user_config_path, git_user_mtime)?;
        set_file_mtime(&repo_config_path, git_repo_mtime)?;
    } else {
        debug!("skipped translating git configs");
    }

    // Sync git "current branch" to "bookmarks.current".
    let head_ref_value = git.lookup_reference("HEAD")?;
    let current_bookmark = match &head_ref_value {
        Some(ReferenceValue::Sym(name)) => name.strip_prefix("refs/heads/"),
        _ => None,
    };

    // NOTE: This could be racy.
    let current_bookmark_path = dot_dir.join("bookmarks.current");
    if let Some(bookmark) = current_bookmark {
        debug!(bookmark, "writing bookmarks.current");
        fs::write(current_bookmark_path, bookmark.as_bytes())?;
    } else {
        debug!("removing bookmarks.current");
        match fs::remove_file(current_bookmark_path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }

    Ok(())
}

pub fn init_empty_dirstate(dot_dir: &Path) -> Result<()> {
    treestate::overlay_dirstate::write_overlay_dirstate(
        &dot_dir.join("dirstate"),
        std::iter::once(("p1".to_owned(), HgId::null_id().to_hex())).collect(),
        Default::default(),
    )
}

fn git_repo_config_mtime(dot_git_path: &Path) -> FileTime {
    try_mtime(&dot_git_path.join("config"))
}

// NOTE: This currently does not consider corner cases, including:
// - XDG_CONFIG_HOME config file changes
// - system config file changes
// - "(conditional) include" config files (https://git-scm.com/docs/git-config#_includes)
fn git_user_config_mtime() -> FileTime {
    let home = match env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        Err(_) => return FileTime::zero(),
        Ok(v) => v,
    };
    try_mtime(Path::new(&format!("{home}{SEP}.gitconfig")))
}

fn try_mtime(path: &Path) -> FileTime {
    match fs::metadata(path) {
        Err(_) => FileTime::zero(),
        Ok(m) => FileTime::from_last_modification_time(&m),
    }
}

/// Obtain path to the sapling config translated from git's user config.
pub fn translated_git_user_config_path(dot_sl_path: &Path, ident: Identity) -> PathBuf {
    dot_sl_path.join(format!("{}-git-user", ident.config_repo_file()))
}

/// Obtain path to the sapling config translated from git's repo config.
pub fn translated_git_repo_config_path(dot_sl_path: &Path, ident: Identity) -> PathBuf {
    dot_sl_path.join(format!("{}-git-repo", ident.config_repo_file()))
}
