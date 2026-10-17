/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

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

use crate::WorktreeOpts;

#[derive(Serialize)]
struct ListOutputEntry {
    path: PathBuf,
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
        if self.stale {
            write!(writer, "   (stale)")?;
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

    formatter.begin_list()?;
    for entry in entries {
        formatter.format_item(&output_entry(repo, entry))?;
    }
    formatter.end_list()?;

    Ok(0)
}

fn output_entry(repo: &Repo, entry: ListedWorktree) -> ListOutputEntry {
    // Read the way `whereami -R <path>` does; a checkout mid-checkout or gone
    // behind git's back just has no node.
    let parents = workingcopy::fast_path_wdir_parents(&entry.path, repo.ident())
        .map(|parents| parents.to_vec())
        .unwrap_or_default();
    let node = parents
        .first()
        .filter(|p1| !p1.is_null())
        .map(|p1| p1.to_hex());
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
    ListOutputEntry {
        path: entry.path,
        role: if entry.is_main { "main" } else { "linked" },
        label: entry.label,
        current: entry.current,
        node,
        stale: stale.is_some(),
        stale_reason: stale.map(|state| state.message(repo)),
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
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(mock_output(&w), "  linked  /repos/linked   dev   (stale)\n");
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
        };
        let mut w = MockWriter(Vec::new());
        entry
            .format_plain(&FormatOptions::default(), &mut w)
            .unwrap();
        assert_eq!(mock_output(&w), "* linked  /repos/linked   dev\n");
    }
}
