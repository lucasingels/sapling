/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use std::fs;
use std::path::Path;
use std::path::PathBuf;

/// Usually `.git` is a directory. However, submodule repo created by `git`
/// uses a file `.git` with the content `gitdir: ...`. This function attempts
/// to follow the file to get a directory. Best-effort.
pub fn follow_dotgit_path(mut git_dir: PathBuf) -> PathBuf {
    for _patience in 0..4 {
        let metadata = match fs::metadata(&git_dir) {
            Err(_) => break,
            Ok(v) => v,
        };
        if metadata.is_file() {
            let content = match fs::read_to_string(&git_dir) {
                Err(_) => break,
                Ok(v) => v,
            };
            if let (Some(path), Some(root)) =
                (content.trim().strip_prefix("gitdir: "), git_dir.parent())
            {
                let new_git_dir = root.join(path);
                tracing::trace!(
                    "follow dotgit {} => {}",
                    git_dir.display(),
                    new_git_dir.display()
                );
                git_dir = new_git_dir;
                continue;
            }
        }
        break;
    }
    util::path::normalize(&git_dir)
}

/// Resolve the "common" git dir for a (followed) git dir.
///
/// A linked git worktree has its own git dir at `<main>/.git/worktrees/<name>`
/// holding only per-worktree state (`HEAD`, `index`, `refs/bisect`, ...).
/// That directory contains a `commondir` file pointing (usually relatively) at
/// the main `.git`, which holds the shared state (`objects`, `refs/heads`,
/// `packed-refs`, `config`, ...). This mirrors `git rev-parse --git-common-dir`.
///
/// Returns `git_dir` unchanged when there is no `commondir` file.
pub fn read_git_common_dir(git_dir: &Path) -> PathBuf {
    let commondir_path = git_dir.join("commondir");
    match fs::read_to_string(&commondir_path) {
        Ok(content) => {
            let content = content.trim();
            if content.is_empty() {
                return git_dir.to_path_buf();
            }
            let common = git_dir.join(content);
            tracing::trace!(
                "git common dir {} => {}",
                git_dir.display(),
                common.display()
            );
            util::path::normalize(&common)
        }
        Err(_) => git_dir.to_path_buf(),
    }
}

/// `.git` mode specific logic to resolve `dot_dir`.
pub fn resolve_dot_dir_func(root: &Path, dot_dir: &'static str) -> PathBuf {
    assert!(dot_dir.starts_with(".git"));
    let dot_git_path = &follow_dotgit_path(root.join(".git"));
    dot_git_path.join("sl")
}
