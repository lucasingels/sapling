/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! One shape for a Gerrit change, whichever API it came back from.
//!
//! Gerrit's SSH and REST APIs report the same change quite differently --
//! `number` against `_number`, an `approvals` list against a `labels` map, an
//! epoch against a formatted timestamp -- so each transport parses into this,
//! and nothing above the transport has to know which one answered.

use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Change {
    /// The number Gerrit shows in its URLs, e.g. 142.
    pub number: u64,
    /// The `Change-Id` trailer the commit carries.
    pub change_id: String,
    pub subject: String,
    /// `NEW`, `MERGED` or `ABANDONED`.
    pub status: String,
    pub owner: String,
    /// When the change last moved, as epoch seconds.
    pub updated: i64,
    pub wip: bool,
    pub private: bool,
    pub submittable: bool,
    /// The dominant Code-Review and Verified votes on the current patchset.
    pub code_review: i32,
    pub verified: i32,
    pub patchset: u64,
    /// The commit the current patchset is, and the ref it can be fetched from.
    pub revision: String,
    pub fetch_ref: String,
    /// The commits the current patchset sits on. What makes a stack a stack:
    /// a change whose parent is another change's revision is stacked on it.
    pub parents: Vec<String>,
    /// The change this one is stacked on, when the server said so outright.
    /// SSH reports it; REST is left to match `parents` up instead.
    pub depends_on: Option<u64>,
    pub depends_on_open: bool,
}

impl Change {
    /// The ref a patchset is published as, when the server did not say.
    pub fn default_fetch_ref(number: u64, patchset: u64) -> String {
        format!("refs/changes/{:02}/{}/{}", number % 100, number, patchset)
    }

    /// Where the change stands, as one word.
    ///
    /// Folds "where is this change" and "what did review say about it"
    /// together, because only one of the two is interesting at a time -- a
    /// merged change's votes no longer matter.
    pub fn review_state(&self) -> &'static str {
        match self.status.as_str() {
            "MERGED" => return "MERGED",
            "ABANDONED" => return "ABANDONED",
            _ => {}
        }
        if self.private {
            return "PRIVATE";
        }
        if self.wip {
            return "WIP";
        }
        match self.code_review {
            v if v <= -2 => "REJECTED",
            v if v < 0 => "CHANGES_REQUESTED",
            v if v >= 2 => "APPROVED",
            v if v > 0 => "RECOMMENDED",
            _ => "REVIEW_REQUIRED",
        }
    }

    /// The smartlog color label a change is drawn in.
    pub fn style_label(&self) -> &'static str {
        match self.review_state() {
            "MERGED" => "ssl.committed",
            "ABANDONED" => "ssl.abandoned",
            "APPROVED" => "ssl.accepted",
            "REJECTED" | "CHANGES_REQUESTED" => "ssl.revision",
            "WIP" | "PRIVATE" => "ssl.unpublished",
            _ => "ssl.review",
        }
    }

    /// The Verified label as a CI signal, or "" when nothing has voted.
    ///
    /// An absent Verified vote is not a pending one -- plenty of projects
    /// have no Verified label at all -- so it earns no glyph.
    pub fn verified_state(&self) -> &'static str {
        match self.verified {
            v if v > 0 => "VERIFIED",
            v if v < 0 => "FAILED",
            _ => "",
        }
    }

    /// The change as JSON, with the derived state folded in.
    ///
    /// Callers above this crate -- the status cache smartlog reads, the
    /// template keywords -- want the conclusions, not the votes, and deriving
    /// them here is what keeps a second copy of the rules out of Python.
    pub fn to_json(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).unwrap_or_default();
        if let Some(object) = value.as_object_mut() {
            object.insert("review_state".into(), self.review_state().into());
            object.insert("verified_state".into(), self.verified_state().into());
            object.insert("summary".into(), self.summary().into());
        }
        value
    }

    /// A short human-readable status, e.g. `CR+2 V+1` or `MERGED`.
    pub fn summary(&self) -> String {
        if self.status == "MERGED" || self.status == "ABANDONED" {
            return self.status.clone();
        }
        let mut parts: Vec<String> = Vec::new();
        if self.wip {
            parts.push("WIP".to_string());
        }
        if self.code_review != 0 {
            parts.push(format!("CR{:+}", self.code_review));
        }
        if self.verified != 0 {
            parts.push(format!("V{:+}", self.verified));
        }
        if parts.is_empty() {
            "NEW".to_string()
        } else {
            parts.join(" ")
        }
    }
}

/// Keep the vote of the largest magnitude, so a single -1 outweighs a +1 the
/// way Gerrit's own label precedence does.
pub fn keep_dominant(current: &mut i32, value: i32) {
    if value.abs() > current.abs() {
        *current = value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change() -> Change {
        Change {
            number: 1,
            status: "NEW".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn review_state_prefers_where_the_change_is() {
        let mut c = change();
        c.code_review = 2;
        c.status = "MERGED".to_string();
        assert_eq!(c.review_state(), "MERGED");
        c.status = "NEW".to_string();
        assert_eq!(c.review_state(), "APPROVED");
        c.wip = true;
        assert_eq!(c.review_state(), "WIP");
        c.private = true;
        assert_eq!(c.review_state(), "PRIVATE");
    }

    #[test]
    fn a_rejection_outranks_an_approval() {
        let mut c = change();
        c.code_review = -1;
        assert_eq!(c.review_state(), "CHANGES_REQUESTED");
        c.code_review = -2;
        assert_eq!(c.review_state(), "REJECTED");
    }

    #[test]
    fn summary_reads_as_votes() {
        let mut c = change();
        assert_eq!(c.summary(), "NEW");
        c.code_review = 2;
        c.verified = 1;
        assert_eq!(c.summary(), "CR+2 V+1");
        c.code_review = -1;
        assert_eq!(c.summary(), "CR-1 V+1");
        c.status = "ABANDONED".to_string();
        assert_eq!(c.summary(), "ABANDONED");
    }

    #[test]
    fn verified_is_only_a_signal_when_someone_voted() {
        let mut c = change();
        assert_eq!(c.verified_state(), "");
        c.verified = 1;
        assert_eq!(c.verified_state(), "VERIFIED");
        c.verified = -1;
        assert_eq!(c.verified_state(), "FAILED");
    }

    #[test]
    fn dominant_vote_wins_by_magnitude() {
        let mut v = 0;
        keep_dominant(&mut v, 1);
        keep_dominant(&mut v, -2);
        keep_dominant(&mut v, 1);
        assert_eq!(v, -2);
    }

    #[test]
    fn states_map_to_smartlog_styles() {
        let mut c = change();
        c.code_review = 2;
        assert_eq!(c.style_label(), "ssl.accepted");
        c.code_review = -1;
        assert_eq!(c.style_label(), "ssl.revision");
        c.code_review = 0;
        assert_eq!(c.style_label(), "ssl.review");
        c.status = "MERGED".to_string();
        assert_eq!(c.style_label(), "ssl.committed");
    }

    #[test]
    fn json_carries_the_derived_state() {
        let mut c = change();
        c.code_review = 2;
        c.verified = 1;
        let value = c.to_json();
        assert_eq!(value["review_state"], "APPROVED");
        assert_eq!(value["verified_state"], "VERIFIED");
        assert_eq!(value["summary"], "CR+2 V+1");
        assert_eq!(value["number"], 1);
    }

    #[test]
    fn fetch_ref_is_gerrits_shape() {
        assert_eq!(
            Change::default_fetch_ref(142, 3),
            "refs/changes/42/142/3".to_string()
        );
        assert_eq!(
            Change::default_fetch_ref(7, 1),
            "refs/changes/07/7/1".to_string()
        );
    }
}
