//! Platform-neutral parsing of `press_key` key names.
//!
//! The tool accepts the same names on every platform (the Swift server keeps an
//! equivalent table). Parsing lives here so each backend only has to map a
//! [`Key`] to its own virtual-key code or keysym, and so the name handling can be
//! unit-tested on any host.

/// A key the model asked for, before any platform mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// A printable character, resolved through the active keyboard layout.
    Char(char),
    Named(Named),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    Return,
    Tab,
    Escape,
    Space,
    Backspace,
    /// `delete`: forward delete on Windows and Linux, backspace on macOS (the
    /// key labelled "delete" on a Mac keyboard). Kept for compatibility.
    Delete,
    ForwardDelete,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Insert,
    /// F1–F24; each backend rejects the ones its platform cannot send.
    F(u8),
    /// Numeric keypad digit 0–9.
    Numpad(u8),
    NumpadAdd,
    NumpadSubtract,
    NumpadMultiply,
    NumpadDivide,
    NumpadDecimal,
    NumpadEnter,
    NumpadEquals,
}

/// Parse a key name as documented on the `press_key` tool.
///
/// Returns `None` for names that are neither a single character nor a known
/// named key, so the caller can report the name back to the model.
pub fn parse(raw: &str) -> Option<Key> {
    let mut chars = raw.chars();
    let first = chars.next()?;
    if chars.next().is_none() {
        return Some(match first {
            ' ' => Key::Named(Named::Space),
            '\n' | '\r' => Key::Named(Named::Return),
            '\t' => Key::Named(Named::Tab),
            other => Key::Char(other),
        });
    }

    // Names are case-insensitive and tolerate separators: "Page_Down",
    // "page down" and "page-down" all mean pagedown.
    let lowered = raw.trim().to_lowercase();
    let compact: String = lowered.chars().filter(|ch| !matches!(ch, '_' | ' ')).collect();

    if let Some(rest) = ["numpad", "keypad", "kp"]
        .iter()
        .find_map(|prefix| compact.strip_prefix(prefix))
    {
        return numpad(rest.trim_start_matches('-')).map(Key::Named);
    }

    let name: String = compact.chars().filter(|ch| *ch != '-').collect();
    if let Some(number) = name.strip_prefix('f')
        && let Ok(n) = number.parse::<u8>()
        && (1..=24).contains(&n)
    {
        return Some(Key::Named(Named::F(n)));
    }

    let named = match name.as_str() {
        "return" | "enter" => Named::Return,
        "tab" => Named::Tab,
        "escape" | "esc" => Named::Escape,
        "space" | "spacebar" => Named::Space,
        "backspace" => Named::Backspace,
        "delete" | "del" => Named::Delete,
        "forwarddelete" | "fwddelete" | "deleteforward" => Named::ForwardDelete,
        "up" | "uparrow" | "arrowup" => Named::Up,
        "down" | "downarrow" | "arrowdown" => Named::Down,
        "left" | "leftarrow" | "arrowleft" => Named::Left,
        "right" | "rightarrow" | "arrowright" => Named::Right,
        "home" => Named::Home,
        "end" => Named::End,
        "pageup" | "pgup" => Named::PageUp,
        "pagedown" | "pgdn" | "pgdown" => Named::PageDown,
        "insert" | "ins" | "help" => Named::Insert,
        other => return punctuation(other).map(Key::Char),
    };
    Some(Key::Named(named))
}

/// Spelled-out punctuation, for models that avoid sending bare symbols.
fn punctuation(name: &str) -> Option<char> {
    Some(match name {
        "minus" | "hyphen" | "dash" => '-',
        "equal" | "equals" => '=',
        "plus" => '+',
        "leftbracket" | "bracketleft" | "openbracket" => '[',
        "rightbracket" | "bracketright" | "closebracket" => ']',
        "backslash" => '\\',
        "semicolon" => ';',
        "quote" | "apostrophe" | "singlequote" => '\'',
        "comma" => ',',
        "period" | "dot" | "fullstop" => '.',
        "slash" | "forwardslash" => '/',
        "grave" | "backtick" | "backquote" => '`',
        _ => return None,
    })
}

fn numpad(rest: &str) -> Option<Named> {
    if let Ok(digit) = rest.parse::<u8>() {
        return (digit <= 9).then_some(Named::Numpad(digit));
    }
    Some(match rest {
        "add" | "plus" | "+" => Named::NumpadAdd,
        "subtract" | "minus" | "-" | "" => Named::NumpadSubtract,
        "multiply" | "times" | "*" => Named::NumpadMultiply,
        "divide" | "/" => Named::NumpadDivide,
        "decimal" | "period" | "dot" | "." => Named::NumpadDecimal,
        "enter" | "return" => Named::NumpadEnter,
        "equal" | "equals" | "=" => Named::NumpadEquals,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::{Key, Named, parse};

    #[test]
    fn single_characters_stay_characters() {
        assert_eq!(parse("s"), Some(Key::Char('s')));
        assert_eq!(parse("{"), Some(Key::Char('{')));
        assert_eq!(parse("("), Some(Key::Char('(')));
        assert_eq!(parse("-"), Some(Key::Char('-')));
        assert_eq!(parse(" "), Some(Key::Named(Named::Space)));
    }

    #[test]
    fn navigation_names_are_named_keys_not_text() {
        // These used to reach Windows as literal text: "pageup" typed p-a-g-e-u-p.
        assert_eq!(parse("pageup"), Some(Key::Named(Named::PageUp)));
        assert_eq!(parse("Page_Down"), Some(Key::Named(Named::PageDown)));
        assert_eq!(parse("page-down"), Some(Key::Named(Named::PageDown)));
        assert_eq!(parse("forwarddelete"), Some(Key::Named(Named::ForwardDelete)));
        assert_eq!(parse("Home"), Some(Key::Named(Named::Home)));
        assert_eq!(parse("end"), Some(Key::Named(Named::End)));
        assert_eq!(parse("insert"), Some(Key::Named(Named::Insert)));
    }

    #[test]
    fn function_keys_cover_f1_to_f24() {
        assert_eq!(parse("f1"), Some(Key::Named(Named::F(1))));
        assert_eq!(parse("F12"), Some(Key::Named(Named::F(12))));
        assert_eq!(parse("f20"), Some(Key::Named(Named::F(20))));
        assert_eq!(parse("f25"), None);
        assert_eq!(parse("f0"), None);
    }

    #[test]
    fn punctuation_names_resolve_to_characters() {
        assert_eq!(parse("comma"), Some(Key::Char(',')));
        assert_eq!(parse("left_bracket"), Some(Key::Char('[')));
        assert_eq!(parse("backslash"), Some(Key::Char('\\')));
        assert_eq!(parse("grave"), Some(Key::Char('`')));
    }

    #[test]
    fn numpad_names_accept_common_spellings() {
        assert_eq!(parse("numpad0"), Some(Key::Named(Named::Numpad(0))));
        assert_eq!(parse("numpad_9"), Some(Key::Named(Named::Numpad(9))));
        assert_eq!(parse("kp5"), Some(Key::Named(Named::Numpad(5))));
        assert_eq!(parse("numpadadd"), Some(Key::Named(Named::NumpadAdd)));
        assert_eq!(parse("numpad-"), Some(Key::Named(Named::NumpadSubtract)));
        assert_eq!(parse("numpadenter"), Some(Key::Named(Named::NumpadEnter)));
        assert_eq!(parse("numpad10"), None);
    }

    #[test]
    fn unknown_names_are_rejected() {
        assert_eq!(parse("nonsense"), None);
        assert_eq!(parse(""), None);
    }
}
