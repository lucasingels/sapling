/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Reading and writing the times Gerrit reports.
//!
//! Gerrit timestamps are UTC, and so is everything shown for them, so the two
//! civil-date conversions here are each other's inverse and stay together.

/// Parse Gerrit's `"2026-09-11 08:20:49.000000000"` (always UTC) to epoch
/// seconds. Its own API reference pins that format, so this parses it rather
/// than pulling in a date library for one field.
pub fn parse_timestamp(text: &str) -> Option<i64> {
    let (date, time) = text.trim().split_once(' ')?;
    let mut date = date.split('-');
    let year: i64 = date.next()?.parse().ok()?;
    let month: i64 = date.next()?.parse().ok()?;
    let day: i64 = date.next()?.parse().ok()?;
    let time = time.split('.').next()?;
    let mut time = time.split(':');
    let hour: i64 = time.next()?.parse().ok()?;
    let minute: i64 = time.next()?.parse().ok()?;
    let second: i64 = time.next()?.parse().ok()?;
    Some(days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second)
}

/// `YYYY-MM-DD` in UTC.
pub fn date(epoch: i64) -> String {
    let (year, month, day) = civil_from_days(epoch.div_euclid(86400));
    format!("{:04}-{:02}-{:02}", year, month, day)
}

/// How long ago, the way smartlog puts it.
///
/// Mirrors the `age` template filter, which switches to a plain date once a
/// relative one has stopped being informative.
pub fn age(then: i64) -> String {
    age_at(now(), then)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn age_at(now: i64, then: i64) -> String {
    const SCALES: &[(&str, i64)] = &[
        ("year", 3600 * 24 * 365),
        ("month", 3600 * 24 * 30),
        ("week", 3600 * 24 * 7),
        ("day", 3600 * 24),
        ("hour", 3600),
        ("minute", 60),
        ("second", 1),
    ];
    let delta = (now - then).max(1);
    if delta > SCALES[0].1 * 2 {
        return date(then);
    }
    for (unit, scale) in SCALES {
        let n = delta / scale;
        if n >= 2 || *scale == 1 {
            return format!("{} {}{} ago", n, unit, if n == 1 { "" } else { "s" });
        }
    }
    date(then)
}

/// Days between 1970-01-01 and the given date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Its inverse.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_utc_epoch_seconds() {
        assert_eq!(
            parse_timestamp("2006-01-02 22:04:05.000000000"),
            Some(1136239445)
        );
        assert_eq!(parse_timestamp("1970-01-01 00:00:00.000000000"), Some(0));
        assert_eq!(parse_timestamp("nonsense"), None);
    }

    #[test]
    fn dates_are_the_inverse_of_timestamps() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(1136239445), "2006-01-02");
        for epoch in [0, 1, 951782400, 1136239445, 4102444800] {
            let text = format!("{} 00:00:00.0", date(epoch));
            assert_eq!(date(parse_timestamp(&text).unwrap()), date(epoch));
        }
    }

    #[test]
    fn an_old_change_shows_a_date_rather_than_an_age() {
        let now = 1700000000;
        assert_eq!(age_at(now, 1136239445), "2006-01-02");
    }

    #[test]
    fn a_recent_change_shows_how_long_ago() {
        let now = 1700000000;
        assert_eq!(age_at(now, now - 3 * 3600), "3 hours ago");
        assert_eq!(age_at(now, now - 5 * 86400), "5 days ago");
        // Fewer than two of a unit falls through to the next one down.
        assert_eq!(age_at(now, now - 90 * 60), "90 minutes ago");
        assert_eq!(age_at(now, now), "1 second ago");
    }
}
