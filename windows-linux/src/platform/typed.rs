//! Whether text `type_text` sent as keystrokes reached the field.
//!
//! Keystrokes are input events: the system accepting them (SendInput's count)
//! says nothing about what the app did with them. A slow page can still be
//! working through the burst when the foreground goes back to the user, and
//! the tail is lost (#47). Reading the field back is the only check, so the
//! result tells sent from verified, and a short field from both.
//!
//! The field's content is compared here and never returned, logged or put in
//! a message: only lengths leave this module.
#![cfg_attr(not(windows), allow(dead_code))]

/// What reading the field back after typing showed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TypedCheck {
    /// The field now holds the typed text.
    Verified,
    /// The field could be read and does not hold the text. Lengths in
    /// characters, line breaks not counted.
    Incomplete { before: usize, after: usize, sent: usize },
    /// The field holds the typed text and more that was neither typed nor
    /// there before: an autocomplete (Chrome's address bar, a search box)
    /// finished it (#69). Pressing Return would use the completed value.
    Completed { before: usize, after: usize, sent: usize },
    /// Nothing to compare against; the reason says why.
    Unverified(&'static str),
}

/// Characters that count: line breaks are sent as Return, which a multi-line
/// field turns into "\n" or "\r\n" and a single-line one acts on instead.
fn comparable(text: &str) -> String {
    text.chars().filter(|c| *c != '\r' && *c != '\n').collect()
}

/// Compare a field before and after typing `text` into it. `None` is a field
/// that could not be read.
pub fn check_typed(text: &str, before: Option<&str>, after: Option<&str>) -> TypedCheck {
    if text.contains('\t') {
        return TypedCheck::Unverified("the text has a Tab, which moves focus out of the field");
    }
    let wanted = comparable(text);
    if wanted.is_empty() {
        return TypedCheck::Unverified("only line breaks were typed");
    }
    let Some(after) = after else {
        return TypedCheck::Unverified("the focused control does not expose its text");
    };
    let after = comparable(after);
    let before = before.map(comparable);
    let sent = wanted.chars().count();
    let after_len = after.chars().count();
    let before_len = before.as_deref().map_or(0, |b| b.chars().count());
    if after.contains(&wanted) {
        // Text the field already held proves nothing unless the field grew by it.
        let already = before.as_deref().is_some_and(|b| b.contains(&wanted));
        if !already || after_len >= before_len + sent {
            if !explained(&wanted, before.as_deref(), &after) {
                return TypedCheck::Completed { before: before_len, after: after_len, sent };
            }
            return TypedCheck::Verified;
        }
        return TypedCheck::Unverified("the field already held this text");
    }
    TypedCheck::Incomplete { before: before_len, after: after_len, sent }
}

/// Whether everything in `after` besides the typed text was already in the
/// field: typing at a caret keeps the text on either side of it, and typing
/// over a selection keeps what was outside the selection. So the text before
/// the typed text must start the old content and the text after it must end
/// it. A field that could not be read before cannot be judged, and passes.
fn explained(wanted: &str, before: Option<&str>, after: &str) -> bool {
    let Some(before) = before else { return true };
    after.match_indices(wanted).any(|(at, _)| {
        let (lead, trail) = (&after[..at], &after[at + wanted.len()..]);
        lead.len() + trail.len() <= before.len() && before.starts_with(lead) && before.ends_with(trail)
    })
}

/// The sentence `type_text` returns. `sent` is the requested character count;
/// `target` names where the keys went (a window, or empty).
pub fn describe_typed(sent: usize, target: &str, check: &TypedCheck) -> String {
    let into = if target.is_empty() { String::new() } else { format!(" into {target}") };
    match check {
        TypedCheck::Verified => format!("typed {sent} characters{into} (read back: the field holds them)"),
        TypedCheck::Unverified(why) => format!(
            "sent {sent} characters as keystrokes{into}; not read back ({why}), so check the field if it matters"
        ),
        TypedCheck::Completed { before, after, .. } => format!(
            "typed {sent} characters{into}, but the field now holds {after} characters (had {before}): text that was              not typed was added around them, as an autocomplete does (a browser address bar or a search box completing              the entry). Return would act on the completed value. Look at the field first: press Delete to drop a              selected completion, or use set_value to put exactly this text in it."
        ),
        TypedCheck::Incomplete { before, after, .. } => format!(
            "INCOMPLETE: sent {sent} characters as keystrokes{into}, but the field does not hold them — it has {after} \
             characters (had {before}). Keystrokes were dropped, the app changed the text or acted on a Return, or \
             it reports its content late. Look at the field before going on. Do not type the text again on top of what arrived: set_value \
             replaces a field's whole content in one step."
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::{TypedCheck, check_typed, describe_typed};

    #[test]
    fn a_field_holding_the_text_is_verified() {
        assert_eq!(check_typed("hello", Some(""), Some("hello")), TypedCheck::Verified);
        // Typed after what was there, and into a field that could not be read before.
        assert_eq!(check_typed("world", Some("hello "), Some("hello world")), TypedCheck::Verified);
        assert_eq!(check_typed("world", None, Some("hello world")), TypedCheck::Verified);
    }

    #[test]
    fn line_breaks_compare_however_the_field_stores_them() {
        let note = "Hi Alex,\nloved your talk.\n\nBest,\nSam";
        assert_eq!(check_typed(note, Some(""), Some("Hi Alex,\r\nloved your talk.\r\n\r\nBest,\r\nSam")), TypedCheck::Verified);
        assert_eq!(check_typed(note, Some(""), Some(note)), TypedCheck::Verified);
        // A single-line field acts on Return and keeps the rest.
        assert_eq!(check_typed("query\n", Some(""), Some("query")), TypedCheck::Verified);
    }

    #[test]
    fn a_short_field_is_incomplete_with_lengths_only() {
        // #47: 235 characters sent, the field showed 165.
        let note: String = "Long multiline note, ".repeat(11) + "and the end";
        let arrived: String = note.chars().take(165).collect();
        let check = check_typed(&note, Some(""), Some(&arrived));
        assert_eq!(check, TypedCheck::Incomplete { before: 0, after: 165, sent: note.chars().count() });
        let message = describe_typed(note.chars().count(), "\"LinkedIn\" (chrome)", &check);
        assert!(message.starts_with("INCOMPLETE: sent 242 characters"), "{message}");
        assert!(message.contains("it has 165 characters (had 0)"), "{message}");
        assert!(!message.contains("Long multiline"), "the field's content must not reach the message: {message}");
    }

    // #69: Chrome's address bar completes a typed URL to one it has visited.
    #[test]
    fn text_an_autocomplete_added_is_reported() {
        let url = "https://fathom.video/calls/48213";
        let old = "https://example.com/inbox";
        let check = check_typed(url, Some(old), Some("https://fathom.video/calls/482137790"));
        assert_eq!(check, TypedCheck::Completed { before: 25, after: 36, sent: 32 });
        let message = describe_typed(32, "\"Fathom\" (chrome)", &check);
        assert!(message.starts_with("typed 32 characters into \"Fathom\" (chrome), but the field now holds 36"), "{message}");
        assert!(!message.contains("fathom.video"), "the field's content must not reach the message: {message}");
        // Typed over the whole selection, nothing added: verified.
        assert_eq!(check_typed(url, Some(old), Some(url)), TypedCheck::Verified);
        // Typed at a caret in the middle, or over part of the text: the rest was there.
        assert_eq!(check_typed("big ", Some("a cat"), Some("a big cat")), TypedCheck::Verified);
        assert_eq!(check_typed("dog", Some("a cat sat"), Some("a dog sat")), TypedCheck::Verified);
        // A field that could not be read before cannot be judged.
        assert_eq!(check_typed(url, None, Some("https://fathom.video/calls/482137790")), TypedCheck::Verified);
    }

    #[test]
    fn text_already_there_is_not_proof() {
        assert_eq!(check_typed("ok", Some("ok"), Some("ok")), TypedCheck::Unverified("the field already held this text"));
        assert_eq!(check_typed("ok", Some("ok"), Some("okok")), TypedCheck::Verified);
    }

    #[test]
    fn what_cannot_be_compared_is_unverified_not_failed() {
        assert!(matches!(check_typed("a\tb", Some(""), Some("a")), TypedCheck::Unverified(_)));
        assert!(matches!(check_typed("\n", Some(""), Some("")), TypedCheck::Unverified(_)));
        assert!(matches!(check_typed("abc", Some(""), None), TypedCheck::Unverified(_)));
        let message = describe_typed(3, "", &TypedCheck::Unverified("the focused control does not expose its text"));
        assert!(message.starts_with("sent 3 characters as keystrokes; not read back"), "{message}");
    }
}
