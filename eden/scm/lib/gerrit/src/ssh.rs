/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Gerrit over SSH: `ssh -p 29418 host gerrit query ...`.
//!
//! The transport a Gerrit checkout already has, since the key that pushes a
//! change is the one that can query it.

use std::io::Write;
use std::process::Command;
use std::process::Stdio;

use anyhow::Result;
use anyhow::bail;
use serde_json::Value;

use crate::change::Change;
use crate::change::keep_dominant;

/// Gerrit's conventional SSH port. Its clone URLs carry it explicitly, but a
/// remote written without one still means this rather than 22.
pub const DEFAULT_PORT: u16 = 29418;

#[derive(Clone, Debug)]
pub struct Ssh {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    /// Seconds to wait for the connection. Applied as ssh's own
    /// ConnectTimeout: a Gerrit that is unreachable should fail the command,
    /// not hang it.
    pub connect_timeout: u64,
}

impl Ssh {
    fn target(&self) -> String {
        match &self.user {
            Some(user) => format!("{}@{}", user, self.host),
            None => self.host.clone(),
        }
    }

    /// Run `gerrit <args>` on the server and return its stdout.
    pub fn run(&self, args: &[&str], stdin: Option<&str>) -> Result<String> {
        let mut cmd = Command::new("ssh");
        cmd.arg("-p")
            .arg(self.port.to_string())
            .arg("-o")
            .arg(format!("ConnectTimeout={}", self.connect_timeout))
            .arg(self.target())
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        tracing::debug!("gerrit ssh: {:?}", args);
        let mut child = cmd.spawn()?;
        if let Some(data) = stdin {
            child
                .stdin
                .as_mut()
                .expect("stdin was piped")
                .write_all(data.as_bytes())?;
        }
        let out = child.wait_with_output()?;
        if !out.status.success() {
            bail!(
                "gerrit ssh failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn query(&self, query: &str) -> Result<Vec<Change>> {
        let raw = self.run(
            &[
                "gerrit",
                "query",
                "--format=JSON",
                "--current-patch-set",
                "--dependencies",
                query,
            ],
            None,
        )?;
        let mut changes = Vec::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            // Gerrit closes the stream with a row of counters, not a change.
            if value.get("type").and_then(Value::as_str) == Some("stats") {
                continue;
            }
            changes.push(parse(&value));
        }
        Ok(changes)
    }
}

/// Turn one row of `gerrit query --format=JSON` into a [`Change`].
pub fn parse(value: &Value) -> Change {
    let patchset = value.get("currentPatchSet");
    let (code_review, verified) = votes(patchset);
    let number = value
        .get("number")
        .and_then(as_u64)
        .unwrap_or_default();
    let patchset_number = patchset
        .and_then(|p| p.get("number"))
        .and_then(as_u64)
        .unwrap_or(1);
    let depends = value
        .get("dependsOn")
        .and_then(Value::as_array)
        .and_then(|deps| deps.first());
    Change {
        number,
        // On the SSH API `id` is the Change-Id; `number` is the change number.
        change_id: string(value.get("id")),
        subject: string(value.get("subject")),
        status: string(value.get("status")),
        owner: patchset_owner(value),
        updated: value
            .get("lastUpdated")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        wip: value.get("wip").and_then(Value::as_bool).unwrap_or(false),
        private: value
            .get("private")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        submittable: value
            .get("submittable")
            .and_then(Value::as_bool)
            .unwrap_or(string(value.get("status")) == "NEW" && code_review >= 2 && verified >= 1),
        code_review,
        verified,
        patchset: patchset_number,
        revision: string(patchset.and_then(|p| p.get("revision"))),
        fetch_ref: match patchset.and_then(|p| p.get("ref")).and_then(Value::as_str) {
            Some(r) => r.to_string(),
            None => Change::default_fetch_ref(number, patchset_number),
        },
        parents: patchset
            .and_then(|p| p.get("parents"))
            .and_then(Value::as_array)
            .map(|ps| ps.iter().filter_map(|p| p.as_str()).map(str::to_string).collect())
            .unwrap_or_default(),
        depends_on: depends.and_then(|d| d.get("number")).and_then(as_u64),
        depends_on_open: depends
            .and_then(|d| d.get("open"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

fn votes(patchset: Option<&Value>) -> (i32, i32) {
    let (mut code_review, mut verified) = (0, 0);
    let approvals = patchset
        .and_then(|p| p.get("approvals"))
        .and_then(Value::as_array);
    for approval in approvals.into_iter().flatten() {
        let value = approval
            .get("value")
            .and_then(as_i32)
            .unwrap_or_default();
        match approval.get("type").and_then(Value::as_str) {
            Some("Code-Review") => keep_dominant(&mut code_review, value),
            Some("Verified") => keep_dominant(&mut verified, value),
            _ => {}
        }
    }
    (code_review, verified)
}

fn patchset_owner(value: &Value) -> String {
    value
        .get("owner")
        .and_then(|o| o.get("username").or_else(|| o.get("name")))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_string()
}

/// Gerrit writes numbers as numbers in some fields and as strings in others.
fn as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

fn as_i32(value: &Value) -> Option<i32> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .map(|v| v as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_query_row() {
        let row = serde_json::json!({
            "number": 142,
            "id": "I1111111111111111111111111111111111111111",
            "subject": "do a thing",
            "status": "NEW",
            "owner": {"username": "alice"},
            "lastUpdated": 1136214245i64,
            "dependsOn": [{"number": 141, "open": true}],
            "currentPatchSet": {
                "number": 3,
                "revision": "abc",
                "ref": "refs/changes/42/142/3",
                "parents": ["def"],
                "approvals": [
                    {"type": "Code-Review", "value": "2"},
                    {"type": "Code-Review", "value": "-1"},
                    {"type": "Verified", "value": "1"},
                ],
            },
        });
        let change = parse(&row);
        assert_eq!(change.number, 142);
        assert_eq!(change.change_id, "I1111111111111111111111111111111111111111");
        assert_eq!(change.owner, "alice");
        assert_eq!(change.patchset, 3);
        assert_eq!(change.fetch_ref, "refs/changes/42/142/3");
        assert_eq!(change.parents, vec!["def".to_string()]);
        assert_eq!(change.depends_on, Some(141));
        assert!(change.depends_on_open);
        // The vote of the largest magnitude wins, so +2 survives the -1.
        assert_eq!(change.code_review, 2);
        assert_eq!(change.verified, 1);
    }

    #[test]
    fn falls_back_to_the_conventional_ref() {
        let row = serde_json::json!({
            "number": 7,
            "currentPatchSet": {"number": 2, "revision": "abc"},
        });
        assert_eq!(parse(&row).fetch_ref, "refs/changes/07/7/2");
    }
}
