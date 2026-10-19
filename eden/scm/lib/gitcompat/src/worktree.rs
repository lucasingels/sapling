/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use std::io;
use std::path::PathBuf;

use encoding::shell_output_bytes_to_path;

use crate::GitCmd;
use crate::RepoGit;

#[derive(Debug, Eq, PartialEq)]
/// A working tree reported by `git worktree list`.
pub struct GitWorktree {
    /// Absolute path to the working tree.
    pub path: PathBuf,
    /// Whether this is the repository's main working tree.
    pub is_main: bool,
    /// Set when `git worktree lock` locked it: the reason, empty without one.
    pub locked: Option<String>,
}

impl RepoGit {
    /// List the worktrees registered with Git.
    pub fn list_worktrees(&self) -> io::Result<Vec<GitWorktree>> {
        let output = self.call("worktree", &["list", "--porcelain", "-z"])?;
        parse_worktrees(&output.stdout)
    }
}

fn parse_worktrees(output: &[u8]) -> io::Result<Vec<GitWorktree>> {
    // Git guarantees that the main worktree is listed first, before the
    // path-sorted linked worktrees. Each worktree is a "worktree <path>" field
    // followed by attribute fields.
    let mut worktrees: Vec<GitWorktree> = Vec::new();
    for field in output.split(|byte| *byte == 0) {
        if let Some(path) = field.strip_prefix(b"worktree ") {
            worktrees.push(GitWorktree {
                path: shell_output_bytes_to_path(path)?.into_owned(),
                is_main: worktrees.is_empty(),
                locked: None,
            });
        } else if let Some(worktree) = worktrees.last_mut() {
            if field == b"locked" {
                worktree.locked = Some(String::new());
            } else if let Some(reason) = field.strip_prefix(b"locked ") {
                worktree.locked = Some(String::from_utf8_lossy(reason).into_owned());
            }
        }
    }
    Ok(worktrees)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_worktrees() {
        let output = b"worktree /repo/main\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /repo/linked\0HEAD 2222222222222222222222222222222222222222\0detached\0locked reason with spaces\0\0";

        assert_eq!(
            parse_worktrees(output).expect("valid porcelain output"),
            vec![
                GitWorktree {
                    path: PathBuf::from("/repo/main"),
                    is_main: true,
                    locked: None,
                },
                GitWorktree {
                    path: PathBuf::from("/repo/linked"),
                    is_main: false,
                    locked: Some("reason with spaces".to_string()),
                },
            ]
        );
    }

    #[test]
    fn test_parse_locked_without_reason() {
        let output = b"worktree /repo/main\0HEAD 1111\0\0worktree /repo/a\0HEAD 2222\0detached\0locked\0\0worktree /repo/b\0HEAD 3333\0detached\0prunable gitdir file points to non-existent location\0\0";
        let locked: Vec<_> = parse_worktrees(output)
            .expect("valid porcelain output")
            .into_iter()
            .map(|wt| wt.locked)
            .collect();
        assert_eq!(locked, vec![None, Some(String::new()), None]);
    }

    #[test]
    fn test_parse_empty_worktree_list() {
        assert!(
            parse_worktrees(b"")
                .expect("empty output is valid")
                .is_empty()
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_parse_non_utf8_worktree_path() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let worktrees = parse_worktrees(b"worktree /repo/non-utf8-\xff\0HEAD 1111\0\0")
            .expect("non-UTF-8 paths are valid on Unix");

        assert_eq!(
            worktrees[0].path,
            PathBuf::from(OsStr::from_bytes(b"/repo/non-utf8-\xff"))
        );
    }
}
