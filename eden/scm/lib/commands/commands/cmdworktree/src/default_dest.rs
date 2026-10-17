/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Default destination of `sl worktree add` for git worktrees.

use std::path::Path;
use std::path::PathBuf;

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
/// git backend excludes the directory from status.
pub(crate) fn default_nested_dest(main_root: &Path, label: &str) -> PathBuf {
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
    dir.join(name)
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
