//! Plain-text clipboard for `clipboard_read` and `clipboard_write`.
//!
//! Neither tool needs the accessibility backend, so they answer even when it
//! failed to start. Windows uses the Win32 clipboard and Linux the X11
//! CLIPBOARD selection, both through `arboard`.

use crate::platform::{DesktopError, Result};

/// Characters `clipboard_read` returns when the caller does not say.
pub const DEFAULT_MAX_CHARS: usize = 20_000;
/// Upper bound on `max_chars`, so one read cannot flood the model's context.
pub const MAX_CHARS_LIMIT: usize = 200_000;

/// Render clipboard text for the model, truncating to `max_chars` characters.
pub fn describe_read(text: Option<String>, max_chars: usize) -> String {
    let Some(text) = text.filter(|text| !text.is_empty()) else {
        return "(the clipboard holds no text)".to_string();
    };
    let total = text.chars().count();
    if total <= max_chars {
        return text;
    }
    let mut shown: String = text.chars().take(max_chars).collect();
    shown.push_str(&format!(
        "\n… truncated: showing {max_chars} of {total} characters; raise max_chars to read more"
    ));
    shown
}

#[cfg(any(windows, target_os = "linux"))]
mod imp {
    use std::sync::{Mutex, OnceLock};

    use super::{DesktopError, Result};

    /// One handle for the life of the process. On X11 the owner of a selection
    /// has to stay alive to answer paste requests, so a handle dropped after
    /// each write would take the text with it.
    static CLIPBOARD: OnceLock<Mutex<Option<arboard::Clipboard>>> = OnceLock::new();

    fn with<T>(body: impl FnOnce(&mut arboard::Clipboard) -> Result<T>) -> Result<T> {
        let cell = CLIPBOARD.get_or_init(|| Mutex::new(None));
        let mut guard = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            let clipboard = arboard::Clipboard::new().map_err(|error| {
                DesktopError::new(format!("the clipboard is unavailable: {error}"))
            })?;
            *guard = Some(clipboard);
        }
        match guard.as_mut() {
            Some(clipboard) => body(clipboard),
            None => Err(DesktopError::new("the clipboard is unavailable")),
        }
    }

    pub fn read() -> Result<Option<String>> {
        with(|clipboard| match clipboard.get_text() {
            Ok(text) => Ok(Some(text)),
            // Empty, or holding an image or files: not an error for the model.
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(error) => Err(DesktopError::new(format!("could not read the clipboard: {error}"))),
        })
    }

    pub fn write(text: &str) -> Result<()> {
        with(|clipboard| {
            clipboard
                .set_text(text.to_owned())
                .map_err(|error| DesktopError::new(format!("could not write the clipboard: {error}")))
        })
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::{DesktopError, Result};

    const UNSUPPORTED: &str = "this build has no clipboard backend; macOS uses the Swift server";

    pub fn read() -> Result<Option<String>> {
        Err(DesktopError::new(UNSUPPORTED))
    }

    pub fn write(_text: &str) -> Result<()> {
        Err(DesktopError::new(UNSUPPORTED))
    }
}

pub use imp::{read, write};

#[cfg(test)]
mod tests {
    use super::describe_read;

    #[test]
    fn empty_and_missing_text_are_reported_plainly() {
        assert_eq!(describe_read(None, 10), "(the clipboard holds no text)");
        assert_eq!(describe_read(Some(String::new()), 10), "(the clipboard holds no text)");
    }

    #[test]
    fn text_is_returned_verbatim_within_the_limit() {
        assert_eq!(describe_read(Some("a\nb".into()), 10), "a\nb");
    }

    #[test]
    fn long_text_is_truncated_by_characters_with_a_note() {
        let shown = describe_read(Some("é".repeat(30)), 5);
        assert!(shown.starts_with("ééééé\n"), "{shown}");
        assert!(shown.contains("showing 5 of 30 characters"), "{shown}");
    }
}
