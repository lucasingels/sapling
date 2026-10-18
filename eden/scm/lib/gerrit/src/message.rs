/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This software may be used and distributed according to the terms of the
 * GNU General Public License version 2.
 */

//! Commit message prose, kept as one line per paragraph.
//!
//! Gerrit renders a commit message at 72 columns and soft-wraps anything
//! longer, so a body hard-wrapped at ~80 shows as a full line, a one-word
//! stub, then the next full line. [`unwrap_prose`] joins those wraps back up
//! and leaves wrapping to whatever displays the message.

/// Runs narrower than this are deliberate short lines, not a filler's output.
const MIN_WRAP_COLUMN: usize = 60;
/// Lines wider than this were never wrapped; they are paragraphs already.
const MAX_WRAP_COLUMN: usize = 100;

/// Join hard-wrapped lines within the body's prose paragraphs.
///
/// Only breaks that look like fixed-column wrapping are joined, so deliberate
/// short lines survive. Lists, indented lines, fenced blocks, section headers
/// and trailers are left untouched, and the subject line is never joined.
pub fn unwrap_prose(message: &str) -> String {
    let mut lines = message.split('\n');
    let mut out: Vec<String> = lines.next().map(str::to_string).into_iter().collect();
    let mut run: Vec<&str> = Vec::new();
    let mut in_fence = false;
    for line in lines {
        if line.starts_with("```") {
            in_fence = !in_fence;
        } else if !in_fence && is_prose_line(line.trim_end()) {
            run.push(line.trim_end());
            continue;
        }
        out.extend(unwrap_run(&run));
        run.clear();
        out.push(line.to_string());
    }
    out.extend(unwrap_run(&run));
    out.join("\n")
}

/// A line that can be joined with its prose neighbours.
fn is_prose_line(line: &str) -> bool {
    let Some(first) = line.chars().next() else {
        return false;
    };
    if first.is_whitespace() || line.starts_with("```") {
        return false;
    }
    if is_list_item(line) || is_trailer(line) {
        return false;
    }
    // Section headers such as "Description:" stay on their own line.
    !line.ends_with(':')
}

/// `- item`, `* item`, `+ item`, `> quote`, `| table`, `1. item`, `2) item`.
fn is_list_item(line: &str) -> bool {
    let rest = match line.strip_prefix(['-', '*', '+', '>', '|']) {
        Some(rest) => rest,
        None => {
            let after_digits = line.trim_start_matches(|c: char| c.is_ascii_digit());
            if after_digits.len() == line.len() {
                return false;
            }
            match after_digits.strip_prefix(['.', ')']) {
                Some(rest) => rest,
                None => return false,
            }
        }
    };
    rest.chars().next().is_none_or(char::is_whitespace)
}

/// A git trailer such as `Change-Id: I...` or `Signed-off-by: alice`.
fn is_trailer(line: &str) -> bool {
    let mut chars = line.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let rest = chars.as_str();
    let token_end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .unwrap_or(rest.len());
    rest[token_end..]
        .strip_prefix(": ")
        .and_then(|value| value.chars().next())
        .is_some_and(|c| !c.is_whitespace())
}

/// Join the fixed-column wraps in a run of adjacent prose lines.
fn unwrap_run(run: &[&str]) -> Vec<String> {
    // The wrap column is the widest line a filler could have produced; lines
    // past it are already-unwrapped paragraphs.
    let column = run
        .iter()
        .map(|line| width(line))
        .filter(|&w| w <= MAX_WRAP_COLUMN)
        .max()
        .unwrap_or(0);
    if column < MIN_WRAP_COLUMN {
        return run.iter().map(|line| line.to_string()).collect();
    }
    let mut out: Vec<String> = Vec::with_capacity(run.len());
    for (i, line) in run.iter().enumerate() {
        match out.last_mut() {
            Some(last) if is_wrap_break(run[i - 1], line, column) => {
                last.push(' ');
                last.push_str(line);
            }
            _ => out.push(line.to_string()),
        }
    }
    out
}

/// Whether the break after `line` is a fixed-column wrap, not a deliberate one.
///
/// A filler breaks only where the next word would overflow the column. A line
/// that stops short with room for the next word was broken on purpose.
fn is_wrap_break(line: &str, next: &str, column: usize) -> bool {
    let next_word = next.split_whitespace().next().unwrap_or("");
    let line_width = width(line);
    line_width <= column && column < line_width + 1 + width(next_word)
}

/// Columns a line takes, counted in characters as the message is read.
fn width(text: &str) -> usize {
    text.chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A paragraph filled at `column`, the way an editor's hard wrap does it.
    fn fill(text: &str, column: usize) -> String {
        let mut lines: Vec<String> = Vec::new();
        for word in text.split(' ') {
            match lines.last_mut() {
                Some(line) if width(line) + 1 + width(word) <= column => {
                    line.push(' ');
                    line.push_str(word);
                }
                _ => lines.push(word.to_string()),
            }
        }
        lines.join("\n")
    }

    const PARAGRAPH: &str = "The commit checks ran as a pretxncommit hook, which sl runs while it holds the store lock that every worktree shares, so a check that took minutes held up every other agent's commits, amends and rebases for that long.";

    #[test]
    fn joins_a_paragraph_filled_at_a_fixed_column() {
        for column in [72, 80] {
            let message = format!("gerrit: Subject\n\n{}\n", fill(PARAGRAPH, column));
            assert_eq!(
                unwrap_prose(&message),
                format!("gerrit: Subject\n\n{}\n", PARAGRAPH)
            );
        }
    }

    #[test]
    fn keeps_deliberate_short_lines() {
        let message = "subject\n\nFirst line of a poem\nsecond line\nthird line";
        assert_eq!(unwrap_prose(message), message);
    }

    #[test]
    fn keeps_a_break_that_left_room_for_the_next_word() {
        // Two paragraphs with no blank line between them: the first one's last
        // line stops with room for the second one's first word, so that break
        // was made on purpose and survives.
        let first = fill(PARAGRAPH, 72);
        let second = "Now they run as command hooks, before the command takes any lock, so a slow check holds up only the commit it is checking.";
        let last_line = first.rsplit('\n').next().unwrap();
        assert!(width(last_line) + 1 + width("Now") <= 72);
        let message = format!("subject\n\n{}\n{}", first, fill(second, 72));
        assert_eq!(
            unwrap_prose(&message),
            format!("subject\n\n{}\n{}", PARAGRAPH, second)
        );
    }

    #[test]
    fn never_joins_the_subject() {
        let subject = "x".repeat(70);
        let message = format!("{}\n{}", subject, fill(PARAGRAPH, 72));
        assert!(unwrap_prose(&message).starts_with(&format!("{}\n", subject)));
    }

    #[test]
    fn leaves_lists_trailers_headers_and_fences_alone() {
        let message = [
            "subject",
            "",
            "Description:",
            "- a list item that is long enough to look like it was wrapped at",
            "  seventy-two columns by somebody's editor before being committed",
            "1. a numbered item that is long enough to look like it was wrapped",
            "2) another numbered item",
            "> a quote",
            "```",
            "code that is long enough to look like it was wrapped at seventy-two",
            "columns but must be left exactly as it is because it is code",
            "```",
            "",
            "Signed-off-by: alice <alice@example.com>",
            "Change-Id: I0123456789abcdef0123456789abcdef01234567",
        ]
        .join("\n");
        assert_eq!(unwrap_prose(&message), message);
    }

    #[test]
    fn leaves_already_unwrapped_paragraphs_alone() {
        let message = format!("subject\n\n{}\n\n{}", PARAGRAPH, PARAGRAPH);
        assert_eq!(unwrap_prose(&message), message);
    }

    #[test]
    fn strips_trailing_whitespace_from_joined_prose_only() {
        let wrapped = fill(PARAGRAPH, 72).replace('\n', "  \n");
        let message = format!("subject  \n\n{}", wrapped);
        assert_eq!(
            unwrap_prose(&message),
            format!("subject  \n\n{}", PARAGRAPH)
        );
    }

    #[test]
    fn handles_empty_and_subject_only_messages() {
        assert_eq!(unwrap_prose(""), "");
        assert_eq!(unwrap_prose("subject"), "subject");
        assert_eq!(unwrap_prose("subject\n"), "subject\n");
    }

    #[test]
    fn recognises_list_markers_and_trailers() {
        assert!(is_list_item("- x"));
        assert!(is_list_item("-"));
        assert!(is_list_item("12. x"));
        assert!(is_list_item("3) x"));
        assert!(!is_list_item("-x"));
        assert!(!is_list_item("12 x"));
        assert!(!is_list_item("word"));
        assert!(is_trailer("Change-Id: Iabc"));
        assert!(is_trailer("Signed-off-by: alice"));
        assert!(!is_trailer("Note:"));
        assert!(!is_trailer("note:  two spaces"));
        assert!(!is_trailer("1x: y"));
    }
}
