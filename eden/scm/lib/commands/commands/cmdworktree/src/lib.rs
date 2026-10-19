/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

mod add;
mod default_dest;
mod label;
mod list;
mod path;
mod prune;
mod remove;

use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use clidispatch::ReqCtx;
use clidispatch::abort;
use cmdutil::ConfigExt;
use cmdutil::FormatterOpts;
use cmdutil::Result;
use cmdutil::define_flags;
use repo::repo::Repo;
use workingcopy::workingcopy::WorkingCopy;
use worktree::WorktreeKind;
use worktree::Worktrees;
use worktree::group_id_for_main_path;

define_flags! {
    pub struct WorktreeOpts {
        /// a short label for the worktree (for 'add' and 'label')
        #[argtype("TEXT")]
        label: String,

        /// create a snapshot of the current working copy, then restore it in the new worktree (for 'add')
        snapshot: bool,

        /// revision to check out (for 'add')
        #[short('r')]
        #[argtype("REV")]
        rev: String,

        /// remove all linked worktrees (for 'remove')
        all: bool,

        /// remove the label instead of setting it (for 'label')
        remove: bool,

        /// remove worktrees even if they have uncommitted changes (for 'remove')
        #[short('f')]
        force: bool,

        /// list the worktrees that would be removed, without removing them (for 'prune')
        #[short('n')]
        dry_run: bool,

        formatter_opts: FormatterOpts,

        #[args]
        args: Vec<String>,
    }
}

pub fn run(ctx: ReqCtx<WorktreeOpts>, repo: &Repo, wc: &WorkingCopy) -> Result<u8> {
    let subcmd = ctx.opts.args.first().map(|s| s.as_str()).unwrap_or("");
    if !ctx.opts.rev.is_empty() && subcmd != "add" {
        abort!("--rev can only be used with 'worktree add'");
    }
    let runner: fn(&ReqCtx<WorktreeOpts>, &Repo, &WorkingCopy, &Worktrees) -> Result<u8> =
        match subcmd {
            "list" | "ls" => |ctx, repo, _wc, worktrees| list::run(ctx, repo, worktrees),
            "add" => add::run,
            "remove" | "rm" => remove::run,
            "label" => label::run,
            "path" => path::run,
            "prune" => prune::run,
            "" => abort!("you need to specify a subcommand (run with --help to see a list)"),
            other => abort!("unknown worktree subcommand '{}'", other),
        };

    let worktrees = Worktrees::open(repo, repo.config().as_ref())?;
    runner(&ctx, repo, wc, &worktrees)
}

pub(crate) struct CurrentGroup {
    pub(crate) shared_store_path: PathBuf,
    pub(crate) kind: WorktreeKind,
    /// Registry id of the group. For git it may not be in the registry yet.
    pub(crate) group_id: String,
    pub(crate) main: PathBuf,
    /// Every checkout of the group, main included, as canonical paths.
    pub(crate) members: BTreeSet<PathBuf>,
}

impl CurrentGroup {
    pub(crate) fn linked(&self) -> impl Iterator<Item = &PathBuf> {
        self.members.iter().filter(|path| **path != self.main)
    }
}

/// Read the configured slot-reservation TTL in seconds. Reservations older than
/// this are treated as orphaned by a crashed `worktree add` and pruned. Defaults
/// to [`worktree::DEFAULT_RESERVATION_TTL_SECONDS`] (1 hour); override with the
/// `worktree.reservation-ttl` config (accepts durations like `30m` or `2h`).
pub(crate) fn reservation_ttl_seconds(repo: &Repo) -> Result<i64> {
    let ttl: Duration = repo.config().get_or("worktree", "reservation-ttl", || {
        Duration::from_secs(worktree::DEFAULT_RESERVATION_TTL_SECONDS as u64)
    })?;
    Ok(ttl.as_secs() as i64)
}

/// The group of the current checkout. Git is the source of truth for which git
/// worktrees exist, so their group always exists and the registry only keeps
/// labels. EdenFS groups come from the registry, including entries whose
/// checkout is gone so `remove` can clean them up.
pub(crate) fn require_group(repo: &Repo, worktrees: &Worktrees) -> Result<CurrentGroup> {
    let shared_store_path = repo.store_path().to_path_buf();
    let mut registry = worktree::load_registry(&shared_store_path)?;
    let kind = worktrees.kind();
    let (group_id, main, members) = match kind {
        WorktreeKind::Git => {
            let listed = worktrees.list()?;
            let Some(main) = listed.iter().find(|wt| wt.is_main) else {
                abort!("this worktree is not part of a group");
            };
            let main = canonical(&main.path);
            let group_id = registry
                .find_group_for_path(&main)
                .unwrap_or_else(|| group_id_for_main_path(&main));
            let members = listed.iter().map(|wt| canonical(&wt.path)).collect();
            (group_id, main, members)
        }
        WorktreeKind::Eden => {
            let current = canonical(repo.path());
            let Some((group_id, group)) = registry
                .find_group_for_path(&current)
                .and_then(|group_id| registry.groups.remove_entry(&group_id))
            else {
                abort!("this worktree is not part of a group");
            };
            (group_id, group.main, group.worktrees.into_keys().collect())
        }
    };
    Ok(CurrentGroup {
        shared_store_path,
        kind,
        group_id,
        main,
        members,
    })
}

pub(crate) fn canonical(path: &Path) -> PathBuf {
    util::path::strip_unc_prefix(
        util::path::canonicalize_best_effort(path).unwrap_or_else(|_| path.to_path_buf()),
    )
}

pub fn aliases() -> &'static str {
    "worktree|wt"
}

pub fn doc() -> &'static str {
    r#"manage multiple linked worktrees sharing the same repository

    worktree groups allow multiple working copies to share the same
    backing store. One worktree is designated as the main worktree, and
    additional linked worktrees can be created, listed, labeled, and
    removed.

    For EdenFS-backed repositories each linked worktree is an EdenFS
    checkout of the backing repo. For git-backed repositories (a ".git"
    directory) each linked worktree is a "git worktree", so plain git
    commands work in it too, and worktrees created with "git worktree add"
    show up in "list".

    Subcommands::

      list [-Tjson]                                     List all worktrees in the group, marking stale ones
      add [PATH] [-r REV] [--label TEXT] [--snapshot]   Create a new linked worktree
      remove PATH [PATH...] [--all] [-f] [-y]           Remove linked worktree(s)
      label [PATH] TEXT [--remove]                      Set or remove a worktree label
      path LABEL [-Tjson]                               Print the path of the worktree labeled LABEL
      prune [--dry-run] [-y]                            Remove linked worktrees that landed, were abandoned or are missing

    `remove` refuses to remove a worktree with uncommitted changes, untracked
    files included, unless `--force` is given; the confirmation prompt then
    lists the changes that will be lost.

    `path` prints the absolute path of the worktree with that label, so
    `cd "$(sl worktree path LABEL)"` works; with -Tjson it prints that
    worktree's `list -Tjson` entry.

    `prune` (git worktrees only) removes the linked worktrees that have no
    uncommitted changes and whose commit is done with: landed (the commit, or
    a later version of it, is public) or abandoned (the commit is hidden and
    no later version of it is visible), and the missing ones (see below).
    The main checkout and the current one are never removed, and neither is
    a stale worktree whose commit was rewritten into a visible draft commit,
    nor one that cannot be read. `--dry-run` lists what would be removed and
    why. Removal works as in `remove`, including the confirmation prompt
    (skipped with `-y`) and the pre-worktree-remove hooks.

    A linked git worktree whose directory was deleted behind sl's back stays
    in `list`, marked missing, until `remove PATH` or `prune` removes what is
    left of it; `add` at its path replaces it. A directory that exists but
    cannot be read is not missing.

    With -Tjson, `list` also gives each worktree's checked out commit
    ("node"), whether it is stale ("stale", "stale_reason"): another
    worktree rewrote that commit or one below it (see `update-stale`), and
    whether it is missing ("missing").

    If PATH is omitted from `add`, `worktree.path-generator` is used to
    choose the destination path when configured. Otherwise, for git-backed
    repositories, the worktree is created at `<main root>/.worktrees/<label>`
    (or `wt_N` without a label), the way `git worktree add <name>` nests by
    default; the directory is excluded from the main checkout's status.

    Config options::

      worktree.max-count=N                     Hard limit on linked worktrees per repo group (0 = unlimited, the default)
      worktree.max-count-message=TEXT          Message shown instead of the default when max-count is reached
      worktree.reservation-ttl=DURATION        How long an in-flight add holds a slot before it is treated as stale (default 1h)
      worktree.require-generated-path=true     Require path generator, disallow manual PATH
      worktree.path-generator=CMD              Shell command to generate PATH when omitted
      worktree.snapshot-direct-copy=true       Use direct copy for --snapshot (always on for git worktrees)
      worktree.git-enabled=true                Enable worktree commands in native Git repositories"#
}

pub fn synopsis() -> Option<&'static str> {
    Some("SUBCOMMAND [OPTIONS] [ARGS]")
}
