/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

use std::path::Path;
use std::path::PathBuf;

use clidispatch::ReqCtx;
use cmdutil::Result;
use cmdutil::get_formatter;
use formatter::FormatOptions;
use formatter::Formattable;
use formatter::StyleWrite;
use repo::repo::Repo;
use serde::Serialize;
use worktree::ListedWorktree;
use worktree::Worktrees;
use worktree_stale::Finished;

use crate::WorktreeOpts;
use crate::dot_dir;
use crate::remove::uncommitted_changes;
use crate::shelves;

#[derive(Default, Serialize)]
pub(crate) struct ListOutputEntry {
    pub(crate) path: PathBuf,
    role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    current: bool,
    /// The checked out commit (hex), when the checkout has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<String>,
    /// Whether another worktree rewrote the checked out commit or one below it.
    stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stale_reason: Option<String>,
    /// Why `prune` would consider the checkout done with: "landed",
    /// "abandoned" or "idle". Left out for the main and the current
    /// checkout, which `prune` never removes, and during a merge.
    #[serde(skip_serializing_if = "Option::is_none")]
    finished: Option<&'static str>,
    /// Whether a merge, rebase, graft, ... is unfinished there.
    #[serde(skip_serializing_if = "Option::is_none")]
    unfinished: Option<bool>,
    /// The number of draft commits in the checked out stack.
    #[serde(skip_serializing_if = "Option::is_none")]
    drafts: Option<u64>,
    /// The number of shelves (`sl shelve`) kept with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    shelved: Option<u64>,
    /// Whether its directory was deleted behind sl's back.
    missing: bool,
    /// Whether `git worktree lock` locked it, and why.
    locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    lock_reason: Option<String>,
    /// Whether it has uncommitted changes, untracked files included; only
    /// with `--status`.
    #[serde(skip_serializing_if = "Option::is_none")]
    dirty: Option<bool>,
}

impl Formattable for ListOutputEntry {
    fn format_plain(
        &self,
        _options: &FormatOptions,
        writer: &mut dyn StyleWrite,
    ) -> Result<(), anyhow::Error> {
        let marker = if self.current { "*" } else { " " };
        write!(
            writer,
            "{} {:<6}  {}",
            marker,
            self.role,
            self.path.display()
        )?;
        if let Some(label) = &self.label {
            write!(writer, "   {label}")?;
        }
        if self.missing {
            write!(writer, "   (missing)")?;
        }
        if self.stale {
            write!(writer, "   (stale)")?;
        }
        if self.locked {
            write!(writer, "   (locked)")?;
        }
        writeln!(writer)?;
        Ok(())
    }
}

pub(crate) fn run(ctx: &ReqCtx<WorktreeOpts>, repo: &Repo, worktrees: &Worktrees) -> Result<u8> {
    let mut formatter = get_formatter(
        repo.config(),
        "worktree",
        &ctx.opts.formatter_opts.template,
        ctx.global_opts(),
        Box::new(ctx.io().output()),
    )?;
    let output_empty = |formatter: &mut Box<dyn formatter::ListFormatter>| -> Result<()> {
        if formatter.is_plain() {
            ctx.io().write("this worktree is not part of a group\n")?;
        } else {
            formatter.begin_list()?;
            formatter.end_list()?;
        }
        Ok(())
    };

    let entries = worktrees.list()?;
    if entries.is_empty() {
        output_empty(&mut formatter)?;
        return Ok(0);
    }

    // The plain format shows none of the details.
    let wdir_parents = (!formatter.is_plain()).then(|| current_parents(repo));
    formatter.begin_list()?;
    for entry in entries {
        formatter.format_item(&output_entry(
            ctx,
            repo,
            entry,
            wdir_parents.as_deref(),
        )?)?;
    }
    formatter.end_list()?;

    Ok(0)
}

/// The working copy parents of the checkout running the command.
pub(crate) fn current_parents(repo: &Repo) -> Vec<types::HgId> {
    workingcopy::fast_path_wdir_parents(repo.path(), repo.ident())
        .map(|parents| parents.to_vec())
        .unwrap_or_default()
}

/// The `list` entry of `entry`. With `wdir_parents` (those of the checkout
/// running the command), also what `prune` would make of it, and with
/// `--status`, whether it is dirty.
pub(crate) fn output_entry(
    ctx: &ReqCtx<WorktreeOpts>,
    repo: &Repo,
    entry: ListedWorktree,
    wdir_parents: Option<&[types::HgId]>,
) -> Result<ListOutputEntry> {
    // Read the way `whereami -R <path>` does; a checkout mid-checkout or gone
    // behind git's back just has no node.
    let parents = workingcopy::fast_path_wdir_parents(&entry.path, repo.ident())
        .map(|parents| parents.to_vec())
        .unwrap_or_default();
    let p1 = parents.first().filter(|p1| !p1.is_null());
    let node = p1.map(|p1| p1.to_hex());
    let stale = if entry.current {
        worktree_stale::checkout_state(repo, &parents)
    } else {
        worktree_stale::other_checkout_state(repo, &entry.path, &parents)
    }
    .unwrap_or_else(|err| {
        tracing::warn!(
            "cannot check whether {} is stale: {err:?}",
            entry.path.display()
        );
        None
    });
    let mut output = ListOutputEntry {
        path: entry.path.clone(),
        role: if entry.is_main { "main" } else { "linked" },
        label: entry.label.clone(),
        current: entry.current,
        node,
        stale: stale.is_some(),
        stale_reason: stale.map(|state| state.message(repo)),
        missing: entry.missing,
        locked: entry.locked.is_some(),
        lock_reason: entry.locked.clone().filter(|reason| !reason.is_empty()),
        ..Default::default()
    };
    let Some(wdir_parents) = wdir_parents else {
        return Ok(output);
    };

    // The missing checkout's dot dir survives in its admin dir.
    let dot_dir = dot_dir(&entry)
        .or_else(|| (!entry.missing).then(|| repo.ident().resolve_full_dot_dir(&entry.path)));
    output.shelved = dot_dir.map(|dot_dir| shelves(&dot_dir).len() as u64);
    if entry.missing {
        return Ok(output);
    }

    if let Some(p1) = p1 {
        match worktree_stale::other_checkout_summary(repo, &entry.path, p1, wdir_parents) {
            Ok(summary) => {
                let in_merge = parents.get(1).is_some_and(|p2| !p2.is_null());
                // Like prune, no verdict during a merge, nor for checkouts it
                // never removes.
                if !(entry.is_main || entry.current || in_merge) {
                    output.finished = summary.finished.map(Finished::as_str);
                }
                output.unfinished = Some(summary.unfinished);
                output.drafts = Some(summary.drafts);
            }
            Err(err) => tracing::warn!(
                "cannot check whether {} is done with: {err:?}",
                entry.path.display()
            ),
        }
    }

    if ctx.opts.status {
        output.dirty = dirty(ctx, repo, &entry.path);
    }
    Ok(output)
}

/// Whether the checkout at `path` has uncommitted changes, or None, with a
/// warning, when that cannot be told. Unlike `remove` and `prune`, a plain
/// list does not set up sl's state in a worktree that has none yet.
fn dirty(ctx: &ReqCtx<WorktreeOpts>, repo: &Repo, path: &Path) -> Option<bool> {
    if !repo.ident().resolve_full_dot_dir(path).exists() {
        ctx.logger().warn(format!(
            "cannot check {} for uncommitted changes: sl has not used it yet",
            path.display()
        ));
        return None;
    }
    match uncommitted_changes(ctx, repo, path) {
        Ok(changes) => Some(!changes.is_empty()),
        Err(err) => {
            ctx.logger().warn(format!(
                "cannot check {} for uncommitted changes: {err}",
                path.display()
            ));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;

    struct MockWriter(Vec<u8>);

    impl std::io::Write for MockWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl formatter::StyleWrite for MockWriter {
        fn write_styled(&mut self, _style: &str, text: &str) -> anyhow::Result<()> {
            self.0.write_all(text.as_bytes())?;
            Ok(())
        }
    }

    fn mock_output(writer: &MockWriter) -> String {
        String::from_utf8(writer.0.clone()).unwrap()
    }

    #[test]
    fn test_format_plain_main() {
        let entry = ListOutputEntry {
            path: PathBuf::from("/repos/main"),
            role: "main",
            label: None,
            current: false,
            node: None,
            stale: false,
            stale_reason: None,
            ..Default::default()
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(mock_output(&w), "  main    /repos/main\n");
    }

    #[test]
    fn test_format_plain_linked() {
        let entry = ListOutputEntry {
            path: PathBuf::from("/repos/linked"),
            role: "linked",
            label: None,
            current: false,
            node: None,
            stale: false,
            stale_reason: None,
            ..Default::default()
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(mock_output(&w), "  linked  /repos/linked\n");
    }

    #[test]
    fn test_format_plain_with_label() {
        let entry = ListOutputEntry {
            path: PathBuf::from("/repos/main"),
            role: "main",
            label: Some("my-label".to_string()),
            current: false,
            node: None,
            stale: false,
            stale_reason: None,
            ..Default::default()
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(mock_output(&w), "  main    /repos/main   my-label\n");
    }

    #[test]
    fn test_format_plain_current() {
        let entry = ListOutputEntry {
            path: PathBuf::from("/repos/main"),
            role: "main",
            label: None,
            current: true,
            node: None,
            stale: false,
            stale_reason: None,
            ..Default::default()
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(mock_output(&w), "* main    /repos/main\n");
    }

    #[test]
    fn test_format_plain_stale() {
        let entry = ListOutputEntry {
            path: PathBuf::from("/repos/linked"),
            role: "linked",
            label: Some("dev".to_string()),
            current: false,
            node: Some("1".repeat(40)),
            stale: true,
            stale_reason: Some("rewritten".to_string()),
            ..Default::default()
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(mock_output(&w), "  linked  /repos/linked   dev   (stale)\n");
    }

    #[test]
    fn test_format_plain_missing() {
        let entry = ListOutputEntry {
            path: PathBuf::from("/repos/linked"),
            role: "linked",
            label: Some("dev".to_string()),
            missing: true,
            ..Default::default()
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(
            mock_output(&w),
            "  linked  /repos/linked   dev   (missing)\n"
        );
    }

    #[test]
    fn test_format_plain_missing_and_locked() {
        let entry = ListOutputEntry {
            path: PathBuf::from("/repos/linked"),
            role: "linked",
            missing: true,
            locked: true,
            ..Default::default()
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(
            mock_output(&w),
            "  linked  /repos/linked   (missing)   (locked)\n"
        );
    }

    #[test]
    fn test_format_plain_current_with_label() {
        let entry = ListOutputEntry {
            path: PathBuf::from("/repos/linked"),
            role: "linked",
            label: Some("dev".to_string()),
            current: true,
            node: None,
            stale: false,
            stale_reason: None,
            ..Default::default()
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(mock_output(&w), "* linked  /repos/linked   dev\n");
    }
}
