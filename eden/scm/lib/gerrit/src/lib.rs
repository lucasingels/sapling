/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! A client for a Gerrit server, over SSH or over its REST API.
//!
//! Which one depends on how the repo was cloned: an `ssh://` remote is
//! queried with `ssh ... gerrit query`, an `http(s)://` one through the REST
//! API with the credentials git already holds. Everything above this speaks
//! in [`Change`], so no caller has to care which answered.
//!
//! This crate is the whole of the fork's Gerrit knowledge on the Rust side;
//! nothing Gerrit-specific belongs outside it.

pub mod change;
pub mod http;
pub mod ssh;
pub mod time;

use anyhow::Result;
use anyhow::anyhow;
use anyhow::bail;
use configmodel::Config;
use configmodel::ConfigExt;
use serde_json::Value;
use url::Url;

pub use crate::change::Change;

#[derive(Clone, Debug)]
pub enum Transport {
    Ssh(ssh::Ssh),
    Http(http::Http),
}

#[derive(Clone, Debug)]
pub struct Client {
    transport: Transport,
    /// The Gerrit web root, for building the URL of a change.
    web_url: String,
    /// The project a change belongs to, for the same reason.
    project: String,
}

impl Client {
    /// Build a client from the repo's config.
    ///
    /// `paths.default` decides the transport, since that is how the repo
    /// actually talks to the server. `gerrit.url` is the web root, which
    /// `detect.isgerrit` writes the first time a remote is probed and which
    /// ISL reads too.
    pub fn from_config(config: &dyn Config) -> Result<Self> {
        let remote = config
            .get("paths", "default")
            .ok_or_else(|| anyhow!("no default path configured for this repo"))?;
        let url = Url::parse(&remote)
            .map_err(|e| anyhow!("cannot read the default path {}: {}", remote, e))?;
        let web_url = web_url(config, &url)?;
        let timeout: u64 = config.get_opt("gerrit", "timeout")?.unwrap_or(15);

        let transport = match url.scheme() {
            "ssh" => Transport::Ssh(ssh::Ssh {
                host: url
                    .host_str()
                    .ok_or_else(|| anyhow!("the default path has no host to reach Gerrit on"))?
                    .to_string(),
                port: url.port().unwrap_or(ssh::DEFAULT_PORT),
                user: match url.username() {
                    "" => None,
                    user => Some(user.to_string()),
                },
                connect_timeout: timeout,
            }),
            "http" | "https" => Transport::Http(http::Http {
                base: web_url.clone(),
            }),
            other => bail!(
                "cannot reach Gerrit over '{}'; the remote has to be ssh or https",
                other
            ),
        };

        Ok(Self {
            transport,
            project: project(config, &url)?,
            web_url,
        })
    }

    pub fn web_url(&self) -> &str {
        &self.web_url
    }

    pub fn project(&self) -> &str {
        &self.project
    }

    /// The web URL of a change, which is where Gerrit serves it.
    pub fn change_url(&self, number: u64) -> String {
        format!("{}/c/{}/+/{}", self.web_url, self.project, number)
    }

    pub fn query(&self, query: &str) -> Result<Vec<Change>> {
        match &self.transport {
            Transport::Ssh(ssh) => ssh.query(query),
            Transport::Http(http) => http.query(query),
        }
    }

    /// One change by number or Change-Id, or None if the server has no such one.
    pub fn change(&self, id: &str) -> Result<Option<Change>> {
        Ok(self.query(&format!("change:{}", id))?.into_iter().next())
    }

    /// The changes a user has open.
    pub fn open_changes(&self, user: &str) -> Result<Vec<Change>> {
        self.query(&format!("owner:{} status:open", user))
    }

    /// A change and the open changes below it, root first.
    ///
    /// The walk stops at the first parent that is no longer open: its commits
    /// are in the trunk already, so an ordinary pull of the branch has them.
    pub fn stack_for(&self, id: &str) -> Result<Vec<Change>> {
        let mut stack: Vec<Change> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut cursor = Some(id.to_string());
        while let Some(current) = cursor {
            if !seen.insert(current.clone()) {
                break;
            }
            let mut change = self
                .change(&current)?
                .ok_or_else(|| anyhow!("change {} is not on Gerrit", current))?;
            // Resolved here rather than left to the caller so that a stack
            // reads the same whichever API answered: only SSH reports
            // `dependsOn`, and over REST it has to be looked up by commit.
            let parent = self.parent_change(&change)?;
            if let Some((number, open)) = parent {
                change.depends_on = Some(number);
                change.depends_on_open = open;
                cursor = open.then(|| number.to_string());
            } else {
                cursor = None;
            }
            stack.insert(0, change);
        }
        Ok(stack)
    }

    /// The change this one is stacked on, and whether it is still open.
    fn parent_change(&self, change: &Change) -> Result<Option<(u64, bool)>> {
        if let Some(number) = change.depends_on {
            return Ok(Some((number, change.depends_on_open)));
        }
        for parent in &change.parents {
            if let Some(found) = self.query(&format!("commit:{}", parent))?.into_iter().next() {
                return Ok(Some((found.number, found.status == "NEW")));
            }
        }
        Ok(None)
    }

    /// Post a review. `input` is Gerrit's ReviewInput, the same body both
    /// APIs take -- work-in-progress and ready are fields of it rather than
    /// flags, on either transport.
    pub fn review(&self, change: &Change, input: Value) -> Result<()> {
        match &self.transport {
            Transport::Ssh(ssh) => {
                let revision = format!("{},{}", change.number, change.patchset);
                ssh.run(
                    &["gerrit", "review", "--json", &revision],
                    Some(&serde_json::to_string(&input)?),
                )?;
                Ok(())
            }
            Transport::Http(http) => http.review(change.number, &change.revision, input),
        }
    }

    pub fn set_topic(&self, change: &Change, topic: &str) -> Result<()> {
        match &self.transport {
            Transport::Ssh(ssh) => {
                ssh.run(
                    &["gerrit", "set-topic", "-t", topic, &change.number.to_string()],
                    None,
                )?;
                Ok(())
            }
            Transport::Http(http) => http.set_topic(change.number, topic),
        }
    }

    pub fn add_reviewer(&self, change: &Change, reviewer: &str) -> Result<()> {
        match &self.transport {
            Transport::Ssh(ssh) => {
                ssh.run(
                    &[
                        "gerrit",
                        "set-reviewers",
                        "-a",
                        reviewer,
                        &change.number.to_string(),
                    ],
                    None,
                )?;
                Ok(())
            }
            Transport::Http(http) => http.add_reviewer(change.number, reviewer),
        }
    }
}

fn web_url(config: &dyn Config, remote: &Url) -> Result<String> {
    if let Some(url) = config.get("gerrit", "url") {
        return Ok(url.trim_end_matches('/').to_string());
    }
    // An http remote is already the web root; an ssh one is not, and guessing
    // from it is what `detect.isgerrit` does once and writes down.
    match remote.scheme() {
        "http" | "https" => Ok(format!(
            "{}://{}",
            remote.scheme(),
            remote
                .host_str()
                .ok_or_else(|| anyhow!("the default path has no host"))?
        )),
        _ => bail!("no Gerrit server configured; set gerrit.url"),
    }
}

/// The Gerrit project name, which its URLs are built from.
///
/// Gerrit serves a change at `/c/<project>/+/<number>`, and the project is
/// the path of the clone URL. `gerrit.project` overrides that, for a remote
/// that is an alias or goes through a mirror.
fn project(config: &dyn Config, remote: &Url) -> Result<String> {
    if let Some(project) = config.get("gerrit", "project") {
        return Ok(project.trim_matches('/').to_string());
    }
    let path = remote.path().trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    // Gerrit's own HTTP clone URLs are served under /a/ when authenticated.
    let path = path.strip_prefix("a/").unwrap_or(path);
    if path.is_empty() {
        bail!("cannot tell the Gerrit project from the remote URL; set gerrit.project");
    }
    Ok(path.to_string())
}

/// Group changes into stacks, each ordered parent first.
///
/// A change sits on another when its patchset's parent commit is that
/// change's current revision. That is readable from either API, unlike the
/// SSH-only `dependsOn`, so stacks come out the same over HTTP.
pub fn stacks(changes: &[Change]) -> Vec<Vec<Change>> {
    let mut by_revision = std::collections::HashMap::new();
    for (i, change) in changes.iter().enumerate() {
        if !change.revision.is_empty() {
            by_revision.insert(change.revision.clone(), i);
        }
    }
    let by_number: std::collections::HashMap<u64, usize> = changes
        .iter()
        .enumerate()
        .map(|(i, c)| (c.number, i))
        .collect();

    let parent_of = |i: usize| -> Option<usize> {
        let change = &changes[i];
        // Prefer what the server said outright, when it said anything.
        if let Some(number) = change.depends_on {
            if change.depends_on_open {
                if let Some(&j) = by_number.get(&number) {
                    return Some(j);
                }
            }
            return None;
        }
        change
            .parents
            .iter()
            .find_map(|p| by_revision.get(p).copied())
    };

    // Depth first from the lowest number up, so a parent is always emitted
    // before the children stacked on it.
    let mut order: Vec<usize> = (0..changes.len()).collect();
    order.sort_by_key(|&i| changes[i].number);
    let mut visited = vec![false; changes.len()];
    let mut flat: Vec<usize> = Vec::with_capacity(changes.len());
    for &start in &order {
        let mut chain = Vec::new();
        let mut cursor = Some(start);
        while let Some(i) = cursor {
            if visited[i] {
                break;
            }
            visited[i] = true;
            chain.push(i);
            cursor = parent_of(i);
        }
        // Collected child first; a parent has to be emitted before its child.
        chain.reverse();
        flat.extend(chain);
    }

    let mut stacks: Vec<Vec<Change>> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for &i in &flat {
        let starts_new = match (current.last(), parent_of(i)) {
            (Some(&previous), Some(parent)) => parent != previous,
            (Some(_), None) => true,
            (None, _) => false,
        };
        if starts_new && !current.is_empty() {
            stacks.push(current.iter().map(|&i| changes[i].clone()).collect());
            current = Vec::new();
        }
        current.push(i);
    }
    if !current.is_empty() {
        stacks.push(current.iter().map(|&i| changes[i].clone()).collect());
    }
    stacks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(number: u64, revision: &str, parent: &str) -> Change {
        Change {
            number,
            revision: revision.to_string(),
            parents: vec![parent.to_string()],
            status: "NEW".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn a_chain_of_parents_is_one_stack() {
        let changes = vec![
            change(101, "aaa", "base"),
            change(102, "bbb", "aaa"),
            change(103, "ccc", "bbb"),
        ];
        let stacks = stacks(&changes);
        assert_eq!(stacks.len(), 1);
        let numbers: Vec<u64> = stacks[0].iter().map(|c| c.number).collect();
        assert_eq!(numbers, vec![101, 102, 103]);
    }

    #[test]
    fn unrelated_changes_are_separate_stacks() {
        let changes = vec![
            change(101, "aaa", "base"),
            change(102, "bbb", "aaa"),
            change(201, "zzz", "base"),
        ];
        let stacks = stacks(&changes);
        assert_eq!(stacks.len(), 2);
        assert_eq!(stacks[0].len(), 2);
        assert_eq!(stacks[1][0].number, 201);
    }

    #[test]
    fn dependson_is_used_when_the_server_gave_it() {
        // No usable parent revisions, the way the SSH API reports them when
        // an older server omits `parents`.
        let mut a = change(101, "", "");
        a.parents.clear();
        let mut b = change(102, "", "");
        b.parents.clear();
        b.depends_on = Some(101);
        b.depends_on_open = true;
        let stacks = stacks(&[a, b]);
        assert_eq!(stacks.len(), 1);
        assert_eq!(stacks[0].len(), 2);
    }

    #[test]
    fn a_closed_parent_starts_a_new_stack() {
        let mut b = change(102, "bbb", "aaa");
        b.depends_on = Some(101);
        b.depends_on_open = false;
        let stacks = stacks(&[b]);
        assert_eq!(stacks.len(), 1);
        assert_eq!(stacks[0][0].number, 102);
    }
}
