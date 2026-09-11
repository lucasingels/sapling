/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

mod view;

use clidispatch::ReqCtx;
use clidispatch::abort;
use clidispatch::abort_if;
use cmdpy::HgPython;
use cmdutil::Result;
use cmdutil::define_flags;
use identity;
use repo::repo::Repo;

define_flags! {
    pub struct GerritOpts {
        /// mark the change as work-in-progress (WIP)
        #[short('w')]
        wip: bool,

        /// alias for --wip
        draft: bool,

        /// mark the change as ready for review (removes WIP)
        ready: bool,

        /// mark the change as private
        private: bool,

        /// unmark the change as private
        remove_private: bool,

        /// publish pending draft comments
        publish_comments: bool,

        /// set topic for the change
        #[short('t')]
        topic: String,

        /// add hashtag to the change
        hashtag: String,

        /// set label (e.g. Verified+1)
        #[short('l')]
        label: Vec<String>,

        /// Gerrit user to show open changes for
        #[short('u')]
        user: String,

        /// add a reviewer to the change (repeatable)
        #[short('r')]
        reviewer: Vec<String>,

        #[args]
        args: Vec<String>,
    }
}

/// The options each subcommand takes, for rejecting one that was meant for
/// another. Sharing a single flag struct across the subcommands is what makes
/// `gerrit` a single native command; without this, `gerrit refresh --wip`
/// would silently do nothing.
const PUBLISH_OPTS: &[&str] = &[
    "wip",
    "draft",
    "ready",
    "private",
    "remove-private",
    "publish-comments",
    "topic",
    "hashtag",
    "label",
];
const VIEW_OPTS: &[&str] = &["user"];
const PULL_OPTS: &[&str] = &[];
const REVIEW_OPTS: &[&str] = &["wip", "ready", "reviewer", "topic"];
const REFRESH_OPTS: &[&str] = &[];

pub fn run(ctx: ReqCtx<GerritOpts>, repo: &Repo) -> Result<u8> {
    let subcmd = ctx.opts.args.first().cloned().unwrap_or_default();
    match subcmd.as_str() {
        "publish" => {
            check_opts(&ctx, "publish", PUBLISH_OPTS)?;
            run_publish(ctx, repo)
        }
        "view" => {
            check_opts(&ctx, "view", VIEW_OPTS)?;
            abort_if!(
                ctx.opts.user.is_empty(),
                "specify a user with --user (-u)"
            );
            view::run(&ctx, repo.config().as_ref())
        }
        "pull" => {
            check_opts(&ctx, "pull", PULL_OPTS)?;
            run_python(ctx, repo, pull_args)
        }
        "review" => {
            check_opts(&ctx, "review", REVIEW_OPTS)?;
            run_python(ctx, repo, review_args)
        }
        "refresh" => {
            check_opts(&ctx, "refresh", REFRESH_OPTS)?;
            run_python(ctx, repo, refresh_args)
        }
        "" => abort!("you need to specify a subcommand (run with --help to see a list)"),
        other => abort!("unknown gerrit subcommand '{}'", other),
    }
}

/// The options that were given, by their long name.
fn given_opts(opts: &GerritOpts) -> Vec<&'static str> {
    let mut given = Vec::new();
    for (name, set) in [
        ("wip", opts.wip),
        ("draft", opts.draft),
        ("ready", opts.ready),
        ("private", opts.private),
        ("remove-private", opts.remove_private),
        ("publish-comments", opts.publish_comments),
        ("topic", !opts.topic.is_empty()),
        ("hashtag", !opts.hashtag.is_empty()),
        ("user", !opts.user.is_empty()),
        ("label", !opts.label.is_empty()),
        ("reviewer", !opts.reviewer.is_empty()),
    ] {
        if set {
            given.push(name);
        }
    }
    given
}

fn check_opts(ctx: &ReqCtx<GerritOpts>, subcmd: &str, allowed: &[&str]) -> Result<()> {
    for name in given_opts(&ctx.opts) {
        abort_if!(
            !allowed.contains(&name),
            "gerrit {} does not take --{}",
            subcmd,
            name
        );
    }
    Ok(())
}

fn run_publish(ctx: ReqCtx<GerritOpts>, repo: &Repo) -> Result<u8> {
    let is_wip = ctx.opts.wip || ctx.opts.draft;

    // Build push args, delegating branch resolution to sl push. The
    // `--to-prefix refs/for/` turns the guessed bookmark (e.g. `master`)
    // into a Gerrit review ref (`refs/for/master`) rather than a direct
    // branch push.
    let mut args = vec![
        identity::cli_name().to_string(),
        "push".to_string(),
        "--to-prefix".to_string(),
        "refs/for/".to_string(),
    ];

    // Collect Gerrit push options as %key or %key=value suffixes.
    let mut suffixes: Vec<String> = Vec::new();
    if is_wip {
        suffixes.push("%wip".to_string());
    }
    if ctx.opts.ready {
        suffixes.push("%ready".to_string());
    }
    if ctx.opts.private {
        suffixes.push("%private".to_string());
    }
    if ctx.opts.remove_private {
        suffixes.push("%remove-private".to_string());
    }
    if ctx.opts.publish_comments {
        suffixes.push("%publish-comments".to_string());
    }
    if !ctx.opts.topic.is_empty() {
        suffixes.push(format!("%topic={}", ctx.opts.topic));
    }
    if !ctx.opts.hashtag.is_empty() {
        suffixes.push(format!("%hashtag={}", ctx.opts.hashtag));
    }
    for l in &ctx.opts.label {
        suffixes.push(format!("%l={}", l));
    }

    if !suffixes.is_empty() {
        args.push("--to-suffix".to_string());
        args.push(suffixes.join(""));
    }

    run_hg(ctx, repo, args)
}

fn pull_args(_opts: &GerritOpts) -> Vec<String> {
    vec!["pull".to_string()]
}

fn review_args(opts: &GerritOpts) -> Vec<String> {
    let mut args = vec!["review".to_string()];
    if opts.wip {
        args.push("--wip".to_string());
    }
    if opts.ready {
        args.push("--ready".to_string());
    }
    if !opts.topic.is_empty() {
        args.push("--topic".to_string());
        args.push(opts.topic.clone());
    }
    for reviewer in &opts.reviewer {
        args.push("--reviewer".to_string());
        args.push(reviewer.clone());
    }
    args
}

fn refresh_args(_opts: &GerritOpts) -> Vec<String> {
    vec!["refresh".to_string()]
}

/// Hand a subcommand to the Python side of the extension.
///
/// The commit graph itself is reachable from here -- `repo.dag_commits()`,
/// `ReadCommitText` and the `renderdag` crate are all Rust. What is not is
/// the revset language: `revsets::utils::resolve_single` resolves one name or
/// hash, and these subcommands evaluate expressions (`draft()`, a user's
/// `-r`, `roots(children(x) & draft())`). `pull` then drives the pull,
/// rebase, bookmark and goto commands, which are Python. The native command
/// exists to own the `gerrit` name, which Rust resolves before extensions
/// load.
fn run_python(
    ctx: ReqCtx<GerritOpts>,
    repo: &Repo,
    build: fn(&GerritOpts) -> Vec<String>,
) -> Result<u8> {
    let mut args = vec![identity::cli_name().to_string(), "debuggerrit".to_string()];
    args.extend(build(&ctx.opts));
    // Whatever followed the subcommand, e.g. the REV of `gerrit review REV`.
    args.extend(ctx.opts.args.iter().skip(1).cloned());
    run_hg(ctx, repo, args)
}

fn run_hg(ctx: ReqCtx<GerritOpts>, repo: &Repo, mut args: Vec<String>) -> Result<u8> {
    // Forward global opts.
    for c in ctx.global_opts().config.iter() {
        args.push("--config".into());
        args.push(c.into());
    }
    if ctx.global_opts().quiet {
        args.push("-q".into());
    }
    if ctx.global_opts().verbose {
        args.push("-v".into());
    }
    if ctx.global_opts().debug {
        args.push("--debug".into());
    }

    // The command that ran has already said why it failed; its exit code is
    // passed through rather than wrapped in a second "gerrit ... failed".
    let hg_python = HgPython::new(&args);
    let exit_code = hg_python.run_hg(args, ctx.io(), repo.config(), false);
    Ok(exit_code.clamp(0, u8::MAX as i32) as u8)
}

pub fn aliases() -> &'static str {
    "gerrit"
}

pub fn doc() -> &'static str {
    r#"interact with Gerrit code review

    Subcommands::

      publish [OPTIONS]   Push commits to Gerrit for review
      view -u USER        Show a user's open changes as a graph
      pull CHANGE         Pull a change and its open ancestors
      review [REV]        Show or update the change for a commit
      refresh [REV]       Update the local cache of review status

    ``publish`` pushes the current commit to Gerrit for review. Branch
    resolution is delegated to ``sl push``; the destination is rewritten to
    ``refs/for/<branch>`` via ``--to-prefix`` so the change lands in Gerrit's
    review queue rather than being pushed directly to the branch. Gerrit push
    options are appended as ``%key`` or ``%key=value`` suffixes to the
    destination ref via ``--to-suffix``.

    ``view`` draws the changes a user has open, grouped into stacks by the
    dependencies Gerrit records between them. It only looks; ``pull`` brings
    one of the changes it showed into the repo, along with the open changes
    it depends on, and moves the checkout to the top of them.

    ``review`` prints a change's review status and URL, or sets its topic,
    reviewers, or work-in-progress state.

    ``refresh`` updates the cache smartlog reads a change's review status
    from. It is refreshed after a push and after a pull already; run it to
    refresh now.

    Examples::

      sl gerrit publish                          push current commit for review
      sl gerrit publish --wip                    push as work-in-progress
      sl gerrit publish --topic my-feature       set topic
      sl gerrit publish -l Verified+1            set a label
      sl gerrit publish --ready --publish-comments  mark ready and publish drafts
      sl gerrit view -u alice                    show alice's open changes
      sl gerrit pull 142                         pull change 142 and its ancestors
      sl gerrit review -r alice                  add alice as a reviewer
      sl gerrit refresh                          refresh every draft's status"#
}

pub fn synopsis() -> Option<&'static str> {
    Some("SUBCOMMAND [OPTIONS]")
}
