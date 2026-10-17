/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

use clidispatch::ReqCtx;
use clidispatch::abort;
use cmdutil::Result;
use cmdutil::get_formatter;
use repo::repo::Repo;
use workingcopy::workingcopy::WorkingCopy;
use worktree::Worktrees;

use crate::WorktreeOpts;
use crate::list::output_entry;

/// Print the path of the worktree labeled LABEL, so `cd "$(sl wt path LABEL)"`
/// works. With -Tjson, print its `list -Tjson` entry instead.
pub(crate) fn run(
    ctx: &ReqCtx<WorktreeOpts>,
    repo: &Repo,
    _wc: &WorkingCopy,
    worktrees: &Worktrees,
) -> Result<u8> {
    let label = match &ctx.opts.args[1..] {
        [label] => label,
        _ => abort!("usage: sl worktree path LABEL"),
    };

    let mut matches: Vec<_> = worktrees
        .list()?
        .into_iter()
        .filter(|entry| entry.label.as_deref() == Some(label.as_str()))
        .collect();
    let entry = match matches.len() {
        0 => abort!("no worktree in this group is labeled '{label}'"),
        1 => matches.remove(0),
        _ => {
            let paths: Vec<String> = matches
                .iter()
                .map(|entry| entry.path.display().to_string())
                .collect();
            abort!(
                "several worktrees are labeled '{label}': {}",
                paths.join(", ")
            );
        }
    };

    let mut formatter = get_formatter(
        repo.config(),
        "worktree",
        &ctx.opts.formatter_opts.template,
        ctx.global_opts(),
        Box::new(ctx.io().output()),
    )?;
    if formatter.is_plain() {
        ctx.io().write(format!("{}\n", entry.path.display()))?;
    } else {
        formatter.begin_list()?;
        formatter.format_item(&output_entry(repo, entry))?;
        formatter.end_list()?;
    }
    Ok(0)
}
