/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! `sl gerrit view`: a user's open changes, drawn the way smartlog draws
//! commits.
//!
//! Native because it needs nothing from the repo but two config values: it is
//! a query, a grouping and a graph, all of which are Rust already.

use std::io::Write;

use clidispatch::ReqCtx;
use cmdutil::Result;
use configmodel::Config;
use configmodel::ConfigExt;
use gerrit::Change;
use gerrit::Client;
use io::IsTty;
use renderdag::Ancestor;
use renderdag::GraphRowRenderer;
use renderdag::Renderer;
use termstyle::Styler;

use crate::GerritOpts;

/// The node standing for the branch the changes are reviewed against. Every
/// stack roots at it, so they are drawn side by side rather than as unrelated
/// fragments. Gerrit change numbers start at 1, so 0 is free.
const TRUNK: u64 = 0;

pub(crate) fn run(ctx: &ReqCtx<GerritOpts>, config: &dyn Config) -> Result<u8> {
    let user = &ctx.opts.user;
    let client = Client::from_config(config)?;
    let changes = client.open_changes(user)?;
    let stacks = gerrit::stacks(&changes);
    if stacks.is_empty() {
        ctx.logger()
            .info(|| format!("no open changes found for {}", user));
        return Ok(0);
    }

    let mut painter = Painter::new(config, ctx.should_color());
    let mut renderer = GraphRowRenderer::new()
        .output()
        .with_min_row_height(3)
        .build_box_drawing();

    let mut out = Vec::new();
    ctx.logger().info(|| format!("open changes for {}:", user));
    for stack in &stacks {
        // Tip first, the way smartlog reads: newest at the top.
        for (i, change) in stack.iter().rev().enumerate() {
            let parent = stack
                .iter()
                .rev()
                .nth(i + 1)
                .map(|p| p.number)
                .unwrap_or(TRUNK);
            let row = renderer.next_row(
                change.number,
                vec![Ancestor::Parent(parent)],
                "o".to_string(),
                describe(&client, change, &mut painter, ctx),
            );
            indent(&mut out, &row);
        }
    }
    let row = renderer.next_row(
        TRUNK,
        vec![Ancestor::Anonymous],
        "o".to_string(),
        painter.paint("sl.remote", &trunk_name(config)) + "\n",
    );
    indent(&mut out, &row);
    ctx.io().write(out)?;
    Ok(0)
}

/// The two lines shown for one change.
fn describe(
    client: &Client,
    change: &Change,
    painter: &mut Painter,
    ctx: &ReqCtx<GerritOpts>,
) -> String {
    let mut head = vec![painter.paint("sl.draft", short(&change.revision))];
    if change.updated != 0 {
        head.push(gerrit::time::age(change.updated));
    }
    let number = painter.paint("log.changeset", &format!("#{}", change.number));
    head.push(if hyperlinks(ctx) {
        hyperlink(&client.change_url(change.number), &number)
    } else {
        number
    });
    let summary = change.summary();
    if !summary.is_empty() {
        head.push(painter.paint(change.style_label(), &format!("[{}]", summary)));
    }
    format!("{}\n{}\n", head.join("  "), change.subject)
}

fn short(revision: &str) -> &str {
    &revision[..revision.len().min(12)]
}

/// Line the graph up with smartlog, which leaves room for the "@" column.
fn indent(out: &mut Vec<u8>, row: &str) {
    for line in row.trim_end_matches('\n').split('\n') {
        if line.is_empty() {
            out.push(b'\n');
        } else {
            let _ = writeln!(out, "  {}", line);
        }
    }
}

/// The name of the branch changes are reviewed against, as smartlog shows it.
fn trunk_name(config: &dyn Config) -> String {
    let hoist = config
        .get("remotenames", "hoist")
        .unwrap_or_else(|| "remote".into());
    let main = config
        .get_opt::<Vec<String>>("remotenames", "selectivepulldefault")
        .ok()
        .flatten()
        .and_then(|names| names.first().cloned())
        .unwrap_or_else(|| "main".to_string());
    format!("{}/{}", hoist, main)
}

/// Whether a terminal hyperlink would be understood, gated the way the
/// templater's `hyperlink()` is so escapes never reach a pipe or a test.
fn hyperlinks(ctx: &ReqCtx<GerritOpts>) -> bool {
    ctx.io().output().is_tty() && ctx.config().get_or("ui", "hyperlink", || false).unwrap_or(false)
}

fn hyperlink(url: &str, text: &str) -> String {
    format!("\x1b]8;;{}\x1b\\{}\x1b]8;;\x1b\\", url, text)
}

/// Applies the `[color]` styles smartlog uses, or nothing when the output is
/// not a terminal that wants them.
struct Painter<'a> {
    config: &'a dyn Config,
    styler: Option<Styler>,
}

impl<'a> Painter<'a> {
    fn new(config: &'a dyn Config, color: bool) -> Self {
        Self {
            config,
            styler: color.then(Styler::new).and_then(|s| s.ok()),
        }
    }

    fn paint(&mut self, label: &str, text: &str) -> String {
        let Some(styler) = self.styler.as_mut() else {
            return text.to_string();
        };
        // A label is a name in `[color]`; its value is the style to draw with.
        let Some(spec) = self.config.get("color", label) else {
            return text.to_string();
        };
        match styler.render_bytes(&spec, text) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => text.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_revision_is_shortened_for_display() {
        assert_eq!(short("aaaaaaaaaaaaaaaaaaaa"), "aaaaaaaaaaaa");
        assert_eq!(short("abc"), "abc");
        assert_eq!(short(""), "");
    }

    #[test]
    fn graph_rows_line_up_with_smartlog() {
        let mut out = Vec::new();
        indent(&mut out, "o  first\n\u{2502}  second\n");
        assert_eq!(String::from_utf8(out).unwrap(), "  o  first\n  \u{2502}  second\n");
    }

    #[test]
    fn a_blank_graph_line_stays_blank() {
        let mut out = Vec::new();
        indent(&mut out, "o\n\n");
        assert_eq!(String::from_utf8(out).unwrap(), "  o\n\n");
    }
}
