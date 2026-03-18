/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

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
        topic: String,

        /// add hashtag to the change
        hashtag: String,

        /// set label (e.g. Verified+1)
        #[short('l')]
        label: Vec<String>,

        #[args]
        args: Vec<String>,
    }
}

pub fn run(ctx: ReqCtx<GerritOpts>, repo: &Repo) -> Result<u8> {
    let subcmd = ctx.opts.args.first().map(|s| s.as_str()).unwrap_or("");
    match subcmd {
        "publish" => run_publish(ctx, repo),
        "" => abort!("you need to specify a subcommand (run with --help to see a list)"),
        other => abort!("unknown gerrit subcommand '{}'", other),
    }
}

fn run_publish(ctx: ReqCtx<GerritOpts>, repo: &Repo) -> Result<u8> {
    let config = repo.config();
    let is_wip = ctx.opts.wip || ctx.opts.draft;

    // Build push args, delegating branch resolution to sl push.
    let mut args = vec![
        identity::cli_name().to_string(),
        "push".to_string(),
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

    let hg_python = HgPython::new(&args);
    let exit_code = hg_python.run_hg(args, ctx.io(), config, false);
    abort_if!(exit_code != 0, "gerrit publish failed");
    Ok(0)
}

pub fn aliases() -> &'static str {
    "gerrit"
}

pub fn doc() -> &'static str {
    r#"interact with Gerrit code review

    Use ``sl gerrit publish`` to push commits for review.

    Subcommands::

      publish [OPTIONS]   Push commits to Gerrit for review

    The ``publish`` subcommand pushes the current commit to Gerrit for
    code review. Branch resolution and refspec construction are handled
    by ``sl push`` — the user's push path config should include
    ``refs/for/`` as appropriate.

    Gerrit push options are appended as ``%key`` or ``%key=value`` suffixes
    to the destination ref via ``--to-suffix``.

    Examples::

      sl gerrit publish                          push current commit for review
      sl gerrit publish --wip                    push as work-in-progress
      sl gerrit publish --topic my-feature       set topic
      sl gerrit publish -l Verified+1            set a label
      sl gerrit publish --ready --publish-comments  mark ready and publish drafts"#
}

pub fn synopsis() -> Option<&'static str> {
    Some("SUBCOMMAND [OPTIONS]")
}
