//! Platform-specific desktop control.
//!
//! Each backend returns finished tool text rather than structured data, matching
//! the macOS server: the text *is* the contract the model reads, so keeping it
//! next to the platform quirks that shape it avoids a lossy intermediate layer.
//!
//! Screen capture and display enumeration are shared (see [`crate::capture`]);
//! only the accessibility tree and synthetic input genuinely differ.

use std::fmt;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(any(windows, target_os = "linux"))]
pub mod agent_cursor;
#[cfg(windows)]
mod ocr;
// OCR exists only on Windows; Linux uses the rest, macOS builds only test it.
#[cfg_attr(not(windows), allow(dead_code))]
pub mod outline;
#[cfg(windows)]
pub mod session;
#[cfg(windows)]
mod user_keys;
#[cfg(windows)]
pub mod windows;

/// A tool failure that is worth showing the model verbatim.
///
/// These are expected outcomes — a missing window, a refused permission — not
/// bugs, so they render as `error: ...` tool text instead of JSON-RPC errors.
/// The model can usually recover by picking a different target.
#[derive(Debug)]
pub struct DesktopError(pub String);

impl fmt::Display for DesktopError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

impl std::error::Error for DesktopError {}

impl DesktopError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

pub type Result<T> = std::result::Result<T, DesktopError>;

/// Why this process may not see the signed-in user's desktop, when its token
/// or desktop says so; attached to results that came back empty or black.
pub fn desktop_access_warning() -> Option<String> {
    #[cfg(windows)]
    {
        session::desktop_warning()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Where a pointer action should land.
#[derive(Debug, Clone, Copy)]
pub enum Point {
    /// An element from the most recent `get_app_state` snapshot.
    Element(u32),
    /// Absolute screen coordinates in logical pixels.
    Screen(f64, f64),
}

/// Scroll axis and sign, already normalised away from the tool's string enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

impl ScrollDirection {
    pub fn parse(raw: &str) -> Result<Self> {
        match raw.to_ascii_lowercase().as_str() {
            "up" | "u" => Ok(Self::Up),
            "down" | "d" => Ok(Self::Down),
            "left" | "l" => Ok(Self::Left),
            "right" | "r" => Ok(Self::Right),
            other => Err(DesktopError::new(format!(
                "unknown direction '{other}' — use up, down, left, or right"
            ))),
        }
    }

    /// Horizontal and vertical deltas in wheel notches for `amount` lines.
    pub fn deltas(self, amount: i32) -> (i32, i32) {
        match self {
            Self::Up => (0, amount),
            Self::Down => (0, -amount),
            Self::Left => (-amount, 0),
            Self::Right => (amount, 0),
        }
    }
}

/// A running application, as reported by `list_apps`.
pub struct AppInfo {
    pub name: String,
    /// Bundle-id equivalent: executable path stem on Windows, desktop id on Linux.
    pub id: String,
    pub pid: u32,
    pub windows: usize,
    pub frontmost: bool,
    /// Title of the window that best identifies this instance; may be empty.
    pub title: String,
}

/// Escape app name/id tokens so `format_app_list` lines stay one line and
/// `parse_app_line` can locate the trailing `  [id]` marker reliably.
pub fn escape_app_field(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '[' => out.push_str("\\["),
            ']' => out.push_str("\\]"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            other => out.push(other),
        }
    }
    out
}

/// Reverse `escape_app_field` after splitting a `format_app_list` line.
pub fn unescape_app_field(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('\\') => out.push('\\'),
                Some('[') => out.push('['),
                Some(']') => out.push(']'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Renders `list_apps` output identically to the macOS server so the model sees
/// one format everywhere.
///
/// Several instances of one app (two Chrome profiles, say) share a name, so the
/// name alone is ambiguous: each such row also carries its main window title,
/// and a closing note says to pick by pid (#29). FRONTMOST stays the last token.
pub fn format_app_list(mut apps: Vec<AppInfo>) -> String {
    if apps.is_empty() {
        return "no running applications with windows".to_string();
    }
    apps.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    let instances = |id: &str| apps.iter().filter(|app| app.id == id).count();
    let mut lines: Vec<String> = apps
        .iter()
        .map(|app| {
            let window = if instances(&app.id) > 1 && !app.title.trim().is_empty() {
                format!("  window=\"{}\"", escape_app_field(&outline::truncate(&app.title, 80)))
            } else {
                String::new()
            };
            format!(
                "{}  [{}]  pid={}  windows={}{window}{}",
                escape_app_field(&app.name),
                escape_app_field(&app.id),
                app.pid,
                app.windows,
                if app.frontmost { "  FRONTMOST" } else { "" }
            )
        })
        .collect();
    let mut noted: Vec<&str> = Vec::new();
    for app in &apps {
        if instances(&app.id) < 2 || noted.contains(&app.id.as_str()) {
            continue;
        }
        noted.push(&app.id);
        let pids: Vec<String> = apps
            .iter()
            .filter(|other| other.id == app.id)
            .map(|other| other.pid.to_string())
            .collect();
        lines.push(format!(
            "note: {} instances of {} are running (pids {}); its name matches all of them, so pass the pid",
            pids.len(),
            escape_app_field(&app.name),
            pids.join(", ")
        ));
    }
    lines.join("\n")
}

/// Whether the user opted in to typing into password fields
/// (`COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT=1`). Off by default, as on macOS: a
/// credential typed by an agent is produced by the model and can stay in the
/// transcript, so a password field is handed to the user instead.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub fn secure_field_input_allowed() -> bool {
    secure_field_flag_allows(crate::identity::env_var("ALLOW_SECURE_FIELD_INPUT").as_deref())
}

fn secure_field_flag_allows(value: Option<&str>) -> bool {
    value == Some("1")
}

/// What `type_text` / `set_value` say after focusing a password field for the
/// user instead of writing into it. Worded as the macOS server words it.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub fn secure_field_handback(id: u32) -> String {
    format!(
        "handed control to the user: e{id} is a password field, so it was focused for them to type \
         into. The credential is deliberately not routed through the model. Tell the user it is \
         ready, wait for them to say they are done, then continue — do not retry this call. \
         (COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT=1 lets the agent type throwaway credentials.)"
    )
}

/// How `get_app_state` reads an app, from the tool's arguments.
#[derive(Clone, Copy, Debug)]
pub struct StateOptions {
    pub max_depth: usize,
    pub max_elements: usize,
    /// List elements scrolled out of view too (the old full walk).
    pub offscreen: bool,
    pub ocr: outline::OcrMode,
}

/// The operations every backend must provide.
///
/// `&mut self` throughout because `get_app_state` refreshes the element
/// registry that later calls resolve ids against.
pub trait Desktop {
    fn list_apps(&mut self) -> Result<String>;
    fn get_app_state(&mut self, app: &str, options: &StateOptions) -> Result<String>;
    fn activate_app(&mut self, app: &str) -> Result<String>;
    fn click(&mut self, target: Point, click_count: u32) -> Result<String>;
    fn right_click(&mut self, target: Point) -> Result<String>;
    /// Park the pointer on a target without pressing, for hover-revealed UI.
    fn hover(&mut self, target: Point) -> Result<String>;
    fn drag(&mut self, from: Point, to: Point) -> Result<String>;
    fn type_text(&mut self, text: &str, element: Option<u32>) -> Result<String>;
    fn press_key(&mut self, key: &str, modifiers: &[String]) -> Result<String>;
    fn scroll(
        &mut self,
        direction: ScrollDirection,
        amount: i32,
        element: Option<u32>,
    ) -> Result<String>;
    fn set_value(&mut self, element: u32, value: &str) -> Result<String>;
    fn select_text(&mut self, element: u32, start: usize, length: Option<usize>) -> Result<String>;
    /// Resolve an app query to a pid so shared capture can find its windows.
    fn resolve_pid(&mut self, app: &str) -> Result<u32>;
}

/// Build the backend for the host platform.
pub fn backend() -> Result<Box<dyn Desktop>> {
    #[cfg(windows)]
    {
        Ok(Box::new(windows::WindowsDesktop::new()?))
    }
    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(linux::LinuxDesktop::new()?))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Err(DesktopError::new(
            "munim-computer-use-native supports Windows and Linux; macOS uses the Swift munim-computer-use server",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{AppInfo, ScrollDirection, format_app_list};

    #[test]
    fn scroll_directions_accept_short_and_long_forms() {
        assert_eq!(ScrollDirection::parse("up").unwrap(), ScrollDirection::Up);
        assert_eq!(ScrollDirection::parse("D").unwrap(), ScrollDirection::Down);
        assert!(ScrollDirection::parse("sideways").is_err());
    }

    #[test]
    fn scrolling_down_moves_content_up() {
        // Wheel deltas are inverted relative to the direction the content moves;
        // getting this backwards is an easy and very confusing bug.
        assert_eq!(ScrollDirection::Down.deltas(5), (0, -5));
        assert_eq!(ScrollDirection::Up.deltas(5), (0, 5));
        assert_eq!(ScrollDirection::Right.deltas(3), (3, 0));
    }

    #[test]
    fn app_list_sorts_case_insensitively_and_marks_frontmost() {
        let rendered = format_app_list(vec![
            AppInfo {
                name: "zed".into(),
                id: "zed".into(),
                pid: 2,
                windows: 1,
                frontmost: false,
                title: String::new(),
            },
            AppInfo {
                name: "Chrome".into(),
                id: "chrome".into(),
                pid: 1,
                windows: 3,
                frontmost: true,
                title: "Docs".into(),
            },
        ]);

        let lines: Vec<&str> = rendered.lines().collect();
        assert!(lines[0].starts_with("Chrome  [chrome]  pid=1  windows=3  FRONTMOST"));
        assert!(lines[1].starts_with("zed"));
    }

    // #29: two instances of one app must be told apart in the inventory itself.
    #[test]
    fn app_list_tells_instances_of_one_app_apart() {
        let instance = |pid, title: &str, frontmost| AppInfo {
            name: "Google Chrome".into(),
            id: "google-chrome".into(),
            pid,
            windows: 1,
            frontmost,
            title: title.into(),
        };
        let rendered = format_app_list(vec![
            instance(28400, "New Tab - Google Chrome", true),
            instance(14756, "GitHub [beta] - Google Chrome", false),
            AppInfo { name: "Notepad".into(), id: "notepad".into(), pid: 7, windows: 1, frontmost: false, title: "notes.txt".into() },
        ]);
        let lines: Vec<&str> = rendered.lines().collect();
        assert!(
            lines.contains(&"Google Chrome  [google-chrome]  pid=28400  windows=1  window=\"New Tab - Google Chrome\"  FRONTMOST"),
            "{rendered}"
        );
        // Brackets are escaped, so parse_app_line still finds the real `  [id]`.
        assert!(rendered.contains("pid=14756  windows=1  window=\"GitHub \\[beta\\] - Google Chrome\""), "{rendered}");
        assert!(lines.contains(&"Notepad  [notepad]  pid=7  windows=1"), "a single instance needs no title: {rendered}");
        assert!(rendered.contains("note: 2 instances of Google Chrome are running (pids 28400, 14756)"), "{rendered}");
        assert_eq!(rendered.matches("note: ").count(), 1, "{rendered}");
    }

    #[test]
    fn password_fields_are_refused_unless_the_user_opts_in() {
        use super::{secure_field_flag_allows, secure_field_handback};
        assert!(!secure_field_flag_allows(None));
        assert!(!secure_field_flag_allows(Some("0")));
        assert!(!secure_field_flag_allows(Some("")));
        assert!(secure_field_flag_allows(Some("1")));
        let message = secure_field_handback(7);
        assert!(message.contains("e7 is a password field"), "{message}");
        assert!(message.contains("do not retry"), "{message}");
        assert!(message.contains("COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT=1"), "{message}");
    }

    #[test]
    fn app_list_escapes_newlines_in_names() {
        let rendered = format_app_list(vec![AppInfo {
            name: "Foo\nBar".into(),
            id: "com.foo".into(),
            pid: 1,
            windows: 1,
            frontmost: false,
            title: String::new(),
        }]);
        assert!(!rendered.contains('\n') || rendered.lines().count() == 1);
        assert!(rendered.contains("Foo\\nBar"));
    }
}
