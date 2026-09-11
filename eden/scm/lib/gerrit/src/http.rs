/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Gerrit over its REST API.
//!
//! The transport for a checkout cloned over HTTPS, where there is no SSH key
//! to query with. Credentials come from the git credential helper, so the
//! same secret that clones and pushes is the one that queries -- nothing new
//! to configure, and no password in sapling's config. This is what ISL's
//! provider does too (`addons/isl-server/src/gerrit`).

use std::io::Write;
use std::process::Command;
use std::process::Stdio;

use anyhow::Result;
use anyhow::anyhow;
use anyhow::bail;
use http_client::HttpClient;
use http_client::Method;
use serde_json::Value;
use url::Url;

use crate::change::Change;
use crate::change::keep_dominant;
use crate::time::parse_timestamp;

/// Gerrit prefixes every JSON response with this so a browser cannot execute
/// it as a script. It has to come off before the body will parse.
const XSSI_PREFIX: &str = ")]}'";

#[derive(Clone, Debug)]
pub struct Http {
    /// The Gerrit web root, e.g. `https://gerrit.example.com`.
    pub base: String,
}

impl Http {
    /// Endpoints under `/a/` are the authenticated ones; everything this
    /// does needs to be, since a change may not be world-readable and
    /// reviewing is never anonymous.
    fn endpoint(&self, path: &str) -> Result<Url> {
        let joined = format!("{}/a/{}", self.base.trim_end_matches('/'), path.trim_start_matches('/'));
        Url::parse(&joined).map_err(|e| anyhow!("bad Gerrit URL {}: {}", joined, e))
    }

    fn send(&self, method: Method, path: &str, body: Option<Value>) -> Result<Vec<u8>> {
        let url = self.endpoint(path)?;
        // Through HttpClient so the request picks up sapling's own HTTP
        // config -- proxies, TLS settings, timeouts.
        let mut request = HttpClient::new().new_request(url.clone(), method);
        if let Some((user, password)) = credentials(&url)? {
            // Basic auth over TLS, which is what Gerrit's HTTP password is.
            let encoded = base64_encode(format!("{}:{}", user, password).as_bytes());
            request = request.header("Authorization", format!("Basic {}", encoded));
        }
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(&body)?);
        }
        tracing::debug!("gerrit http: {} {}", method_name(method), url);
        let response = request.send()?;
        let status = response.status();
        if !status.is_success() {
            bail!(
                "Gerrit answered {} for {}{}",
                status.as_u16(),
                url,
                match status.as_u16() {
                    401 | 403 => " (check your Gerrit HTTP password in the git credential helper)",
                    _ => "",
                }
            );
        }
        Ok(response.body().to_vec())
    }

    fn get_json(&self, path: &str) -> Result<Value> {
        parse_body(&self.send(Method::Get, path, None)?)
    }

    pub fn query(&self, query: &str) -> Result<Vec<Change>> {
        // CURRENT_COMMIT is what carries the parent commits, which is how a
        // stack is recognised here: the SSH API's `dependsOn` has no REST
        // equivalent that does not cost a request per change.
        let path = format!(
            "changes/?q={}&o=CURRENT_REVISION&o=CURRENT_COMMIT&o=DETAILED_LABELS&o=SUBMITTABLE",
            urlencode(query)
        );
        let value = self.get_json(&path)?;
        let rows = value
            .as_array()
            .ok_or_else(|| anyhow!("Gerrit returned {} where a list of changes was expected", value))?;
        Ok(rows.iter().map(parse).collect())
    }

    pub fn review(&self, change: u64, revision: &str, input: Value) -> Result<()> {
        self.send(
            Method::Post,
            &format!("changes/{}/revisions/{}/review", change, revision),
            Some(input),
        )?;
        Ok(())
    }

    pub fn set_topic(&self, change: u64, topic: &str) -> Result<()> {
        self.send(
            Method::Put,
            &format!("changes/{}/topic", change),
            Some(serde_json::json!({ "topic": topic })),
        )?;
        Ok(())
    }

    pub fn add_reviewer(&self, change: u64, reviewer: &str) -> Result<()> {
        self.send(
            Method::Post,
            &format!("changes/{}/reviewers", change),
            Some(serde_json::json!({ "reviewer": reviewer })),
        )?;
        Ok(())
    }
}

/// Strip Gerrit's XSSI prefix and parse what is left.
pub fn parse_body(body: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(body)?.trim_start();
    let text = text.strip_prefix(XSSI_PREFIX).unwrap_or(text);
    Ok(serde_json::from_str(text.trim_start())?)
}

/// Turn one entry of `GET /changes/` into a [`Change`].
pub fn parse(value: &Value) -> Change {
    let (code_review, verified) = votes(value.get("labels"));
    let number = value.get("_number").and_then(Value::as_u64).unwrap_or_default();
    let current = value
        .get("current_revision")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let revision = value
        .get("revisions")
        .and_then(|r| r.get(current));
    let patchset = revision
        .and_then(|r| r.get("_number"))
        .and_then(Value::as_u64)
        .unwrap_or(1);
    Change {
        number,
        change_id: value
            .get("change_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        subject: value
            .get("subject")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        owner: value
            .get("owner")
            .and_then(|o| o.get("username").or_else(|| o.get("name")))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        updated: value
            .get("updated")
            .and_then(Value::as_str)
            .and_then(parse_timestamp)
            .unwrap_or_default(),
        wip: value
            .get("work_in_progress")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        private: value
            .get("is_private")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        submittable: value
            .get("submittable")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        code_review,
        verified,
        patchset,
        revision: current.to_string(),
        fetch_ref: match revision.and_then(|r| r.get("ref")).and_then(Value::as_str) {
            Some(r) => r.to_string(),
            None => Change::default_fetch_ref(number, patchset),
        },
        parents: revision
            .and_then(|r| r.get("commit"))
            .and_then(|c| c.get("parents"))
            .and_then(Value::as_array)
            .map(|ps| {
                ps.iter()
                    .filter_map(|p| p.get("commit").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        // REST has no cheap equivalent; the stack is read off `parents`.
        depends_on: None,
        depends_on_open: false,
    }
}

fn votes(labels: Option<&Value>) -> (i32, i32) {
    let (mut code_review, mut verified) = (0, 0);
    let Some(labels) = labels.and_then(Value::as_object) else {
        return (0, 0);
    };
    for (name, label) in labels {
        let target = match name.as_str() {
            "Code-Review" => &mut code_review,
            "Verified" => &mut verified,
            _ => continue,
        };
        let votes = label.get("all").and_then(Value::as_array);
        for vote in votes.into_iter().flatten() {
            if let Some(value) = vote.get("value").and_then(Value::as_i64) {
                keep_dominant(target, value as i32);
            }
        }
    }
    (code_review, verified)
}

/// Ask the git credential helper for the URL's username and password.
///
/// Whatever the user already has configured answers -- the macOS keychain, a
/// credential manager, a helper script -- so a Gerrit HTTP password never has
/// to be written into sapling's config.
fn credentials(url: &Url) -> Result<Option<(String, String)>> {
    let Some(host) = url.host_str() else {
        return Ok(None);
    };
    let mut input = format!("protocol={}\nhost={}", url.scheme(), host);
    if let Some(port) = url.port() {
        input.push_str(&format!(":{}", port));
    }
    input.push_str("\n\n");

    let mut child = match Command::new("git")
        .args(["credential", "fill"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        // No git on PATH is not fatal: an anonymous read may still work.
        Err(_) => return Ok(None),
    };
    child
        .stdin
        .as_mut()
        .expect("stdin was piped")
        .write_all(input.as_bytes())?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut user = None;
    let mut password = None;
    for line in text.lines() {
        match line.split_once('=') {
            Some(("username", value)) => user = Some(value.to_string()),
            Some(("password", value)) => password = Some(value.to_string()),
            _ => {}
        }
    }
    Ok(match (user, password) {
        (Some(user), Some(password)) => Some((user, password)),
        _ => None,
    })
}

fn urlencode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn method_name(method: Method) -> &'static str {
    match method {
        Method::Get => "GET",
        Method::Post => "POST",
        Method::Put => "PUT",
        Method::Head => "HEAD",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_xssi_prefix() {
        let body = b")]}'\n[{\"_number\": 1}]";
        let value = parse_body(body).unwrap();
        assert_eq!(value[0]["_number"], 1);
    }

    #[test]
    fn parses_a_rest_change() {
        let row = serde_json::json!({
            "_number": 142,
            "change_id": "I1111111111111111111111111111111111111111",
            "subject": "do a thing",
            "status": "NEW",
            "owner": {"username": "alice"},
            "updated": "2006-01-02 22:04:05.000000000",
            "work_in_progress": true,
            "submittable": false,
            "current_revision": "abc",
            "revisions": {
                "abc": {
                    "_number": 3,
                    "ref": "refs/changes/42/142/3",
                    "commit": {"parents": [{"commit": "def"}]},
                },
            },
            "labels": {
                "Code-Review": {"all": [{"value": 2}, {"value": -1}]},
                "Verified": {"all": [{"value": -1}]},
            },
        });
        let change = parse(&row);
        assert_eq!(change.number, 142);
        assert_eq!(change.owner, "alice");
        assert_eq!(change.patchset, 3);
        assert_eq!(change.revision, "abc");
        assert_eq!(change.fetch_ref, "refs/changes/42/142/3");
        assert_eq!(change.parents, vec!["def".to_string()]);
        assert!(change.wip);
        assert_eq!(change.code_review, 2);
        assert_eq!(change.verified, -1);
        assert_eq!(change.review_state(), "WIP");
    }

    #[test]
    fn encodes_a_query_for_a_url() {
        assert_eq!(urlencode("owner:alice status:open"), "owner%3Aalice%20status%3Aopen");
    }

    #[test]
    fn encodes_basic_auth() {
        assert_eq!(base64_encode(b"alice:secret"), "YWxpY2U6c2VjcmV0");
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
    }
}
