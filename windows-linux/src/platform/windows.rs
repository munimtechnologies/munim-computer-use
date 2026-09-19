//! Windows backend, built on UI Automation.
//!
//! UI Automation is the direct counterpart to the macOS Accessibility API: the
//! same tree of roles, names and values, and the same patterns (Invoke, Value,
//! Text) that let us press a button properly instead of guessing at pixels.
//! Coordinates remain available as a fallback for canvas-style UIs that expose
//! nothing useful.

use std::collections::HashMap;

use uiautomation::UIAutomation;
use uiautomation::UIElement;
use uiautomation::inputs::{Keyboard, Mouse, MouseButton};
use uiautomation::patterns::{UIInvokePattern, UIScrollPattern, UITextPattern, UIValuePattern};
use uiautomation::types::{Handle, Point as UIPoint, ScrollAmount};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::core::BOOL;
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL, MOUSEINPUT, MapVirtualKeyW, SendInput, VIRTUAL_KEY,
    VkKeyScanW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, EnumWindows, GetClassNameW,
    GetWindowLongW, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, SW_RESTORE,
    SetForegroundWindow, ShowWindow, WindowFromPoint, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEHWHEEL,
    WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, GWL_STYLE,
};

use super::agent_cursor::AgentCursor;
use super::{Desktop, DesktopError, Point, Result, ScrollDirection, format_app_list};
use crate::apps;
use crate::keys::{self, Key, Named};

/// One wheel notch, as Windows defines it.
const WHEEL_DELTA: i32 = 120;

pub struct WindowsDesktop {
    automation: UIAutomation,
    /// Element handles from the most recent `get_app_state`, keyed by the
    /// numeric part of the `e12` ids handed to the model.
    registry: HashMap<u32, UIElement>,
}

impl WindowsDesktop {
    pub fn new() -> Result<Self> {
        let automation = UIAutomation::new().map_err(|error| {
            DesktopError::new(format!("failed to initialise UI Automation: {error}"))
        })?;
        Ok(Self {
            automation,
            registry: HashMap::new(),
        })
    }

    fn element(&self, id: u32) -> Result<&UIElement> {
        self.registry.get(&id).ok_or_else(|| {
            DesktopError::new(format!(
                "element e{id} is not in the current snapshot — call get_app_state again, ids are per-snapshot"
            ))
        })
    }

    /// Centre of an element in screen coordinates.
    fn center(element: &UIElement) -> Result<(f64, f64)> {
        let rect = element.get_bounding_rectangle().map_err(|error| {
            DesktopError::new(format!("element has no on-screen bounds: {error}"))
        })?;
        let width = rect.get_right() - rect.get_left();
        let height = rect.get_bottom() - rect.get_top();
        if width <= 0 || height <= 0 {
            return Err(DesktopError::new(
                "element is not visible on screen — scroll it into view first",
            ));
        }
        Ok((
            f64::from(rect.get_left()) + f64::from(width) / 2.0,
            f64::from(rect.get_top()) + f64::from(height) / 2.0,
        ))
    }

    fn point_coordinates(&self, target: Point) -> Result<(f64, f64)> {
        match target {
            Point::Screen(x, y) => Ok((x, y)),
            Point::Element(id) => Self::center(self.element(id)?),
        }
    }

    /// Top-level visible windows belonging to `pid`.
    fn top_level_windows(pid: u32) -> Vec<HWND> {
        struct Search {
            pid: u32,
            found: Vec<HWND>,
        }

        unsafe extern "system" fn visit(window: HWND, param: LPARAM) -> BOOL {
            // SAFETY: `param` is the `&mut Search` handed to EnumWindows below,
            // which outlives the enumeration.
            let search = unsafe { &mut *(param.0 as *mut Search) };
            let mut owner = 0u32;
            unsafe { GetWindowThreadProcessId(window, Some(&mut owner)) };
            if owner == search.pid && unsafe { IsWindowVisible(window) }.as_bool() {
                search.found.push(window);
            }
            // Non-zero keeps the enumeration going.
            BOOL(1)
        }

        let mut search = Search {
            pid,
            found: Vec::new(),
        };
        let _ = unsafe {
            EnumWindows(
                Some(visit),
                LPARAM(&mut search as *mut Search as isize),
            )
        };
        search.found
    }

    /// Pack client coordinates into an `lParam` for mouse window messages.
    fn pack_client_lparam(x: i32, y: i32) -> LPARAM {
        let lo = (x as u16) as u32;
        let hi = (y as u16) as u32;
        LPARAM(((hi << 16) | lo) as isize)
    }

    /// Resolve the deepest visible child HWND under a screen point.
    fn hwnd_at_screen(x: i32, y: i32) -> Option<HWND> {
        let point = POINT { x, y };
        let mut hwnd = unsafe { WindowFromPoint(point) };
        if hwnd.0.is_null() {
            return None;
        }
        // Walk into nested children — a single ChildWindowFromPointEx only
        // returns the immediate child, which misses grandchildren (Bot: nested
        // Win32 controls).
        loop {
            let mut client = point;
            if !unsafe { ScreenToClient(hwnd, &mut client) }.as_bool() {
                break;
            }
            let child = unsafe {
                ChildWindowFromPointEx(hwnd, client, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED)
            };
            if child.0.is_null() || child.0 == hwnd.0 {
                break;
            }
            hwnd = child;
        }
        Some(hwnd)
    }

    /// Only post mouse messages to control classes known to honor them.
    /// Everything else (Chromium, Qt, DirectInput, unknown) falls through to
    /// the real cursor path so we never report a false click success.
    fn accepts_posted_mouse(hwnd: HWND) -> bool {
        let mut buf = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) };
        if len == 0 {
            return false;
        }
        let class = String::from_utf16_lossy(&buf[..len as usize]);
        if class.starts_with("Chrome_") || class.starts_with("Chrome_WidgetWin") {
            return false;
        }
        if class == "Static" {
            // Static labels ignore mouse messages unless SS_NOTIFY is set.
            const SS_NOTIFY: i32 = 0x0001_0000;
            let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) };
            return style & SS_NOTIFY != 0;
        }
        matches!(
            class.as_str(),
            "Button"
                | "Edit"
                | "ComboBox"
                | "ComboLBox"
                | "ListBox"
                | "SysListView32"
                | "SysTreeView32"
                | "SysTabControl32"
                | "ToolbarWindow32"
                | "msctls_trackbar32"
                | "msctls_updown32"
                | "ScrollBar"
                | "#32770"
        ) || class.starts_with("WindowsForms")
    }

    /// Deliver a left/right click via posted mouse messages so the system
    /// cursor does not move. Only used for known-good Win32 classes; callers
    /// fall back to the cursor path when this returns false.
    fn background_click(x: f64, y: f64, right: bool) -> bool {
        let sx = x.round() as i32;
        let sy = y.round() as i32;
        let Some(hwnd) = Self::hwnd_at_screen(sx, sy) else {
            return false;
        };
        if !Self::accepts_posted_mouse(hwnd) {
            return false;
        }
        let mut client = POINT { x: sx, y: sy };
        if !unsafe { ScreenToClient(hwnd, &mut client) }.as_bool() {
            return false;
        }
        let lp = Self::pack_client_lparam(client.x, client.y);
        // MK_LBUTTON = 0x0001, MK_RBUTTON = 0x0002
        let (down, up, mk) = if right {
            (WM_RBUTTONDOWN, WM_RBUTTONUP, 0x0002usize)
        } else {
            (WM_LBUTTONDOWN, WM_LBUTTONUP, 0x0001usize)
        };
        // Prime hover state; some controls ignore down without a prior move.
        let _ = unsafe { PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(0), lp) };
        let down_ok = unsafe { PostMessageW(Some(hwnd), down, WPARAM(mk), lp) }.is_ok();
        let up_ok = unsafe { PostMessageW(Some(hwnd), up, WPARAM(0), lp) }.is_ok();
        down_ok && up_ok
    }

    /// Hover counterpart of `background_click`: prime the window under the point
    /// with a mouse-move so it paints hover state, without touching the cursor.
    fn background_hover(x: f64, y: f64) -> bool {
        let sx = x.round() as i32;
        let sy = y.round() as i32;
        let Some(hwnd) = Self::hwnd_at_screen(sx, sy) else {
            return false;
        };
        if !Self::accepts_posted_mouse(hwnd) {
            return false;
        }
        let mut client = POINT { x: sx, y: sy };
        if !unsafe { ScreenToClient(hwnd, &mut client) }.as_bool() {
            return false;
        }
        let lp = Self::pack_client_lparam(client.x, client.y);
        unsafe { PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(0), lp) }.is_ok()
    }

    /// Drag inside one classic Win32 control with posted messages, so the
    /// user's cursor stays put. Both ends must land in the same window.
    fn background_drag(from: (f64, f64), to: (f64, f64)) -> bool {
        let start = (from.0.round() as i32, from.1.round() as i32);
        let end = (to.0.round() as i32, to.1.round() as i32);
        let Some(hwnd) = Self::hwnd_at_screen(start.0, start.1) else {
            return false;
        };
        if !Self::accepts_posted_mouse(hwnd)
            || Self::hwnd_at_screen(end.0, end.1).map(|other| other.0) != Some(hwnd.0)
        {
            return false;
        }
        let client = |x: i32, y: i32| {
            let mut point = POINT { x, y };
            unsafe { ScreenToClient(hwnd, &mut point) }
                .as_bool()
                .then(|| Self::pack_client_lparam(point.x, point.y))
        };
        let (Some(down_at), Some(up_at)) = (client(start.0, start.1), client(end.0, end.1)) else {
            return false;
        };
        const MK_LBUTTON: usize = 0x0001;
        let post = |message, wparam: usize, lparam| unsafe {
            PostMessageW(Some(hwnd), message, WPARAM(wparam), lparam)
        }
        .is_ok();
        let mut delivered = post(WM_MOUSEMOVE, 0, down_at) && post(WM_LBUTTONDOWN, MK_LBUTTON, down_at);
        let steps = 12;
        for step in 1..=steps {
            let t = f64::from(step) / f64::from(steps);
            let x = start.0 + ((end.0 - start.0) as f64 * t).round() as i32;
            let y = start.1 + ((end.1 - start.1) as f64 * t).round() as i32;
            if let Some(at) = client(x, y) {
                delivered &= post(WM_MOUSEMOVE, MK_LBUTTON, at);
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        delivered && post(WM_LBUTTONUP, 0, up_at)
    }

    /// Scroll through UI Automation: the nearest ScrollPattern at or above the
    /// element that can move along the requested axis. No input is synthesised.
    fn uia_scroll(&self, element: &UIElement, horizontal: i32, vertical: i32) -> bool {
        let Ok(walker) = self.automation.create_tree_walker() else {
            return false;
        };
        // Wheel deltas are positive for up/right; ScrollPattern increments move
        // down/right, so the vertical sign flips.
        let amount = |delta: i32, invert: bool| match (delta.signum(), invert) {
            (0, _) => ScrollAmount::NoAmount,
            (1, false) | (-1, true) => ScrollAmount::SmallIncrement,
            _ => ScrollAmount::SmallDecrement,
        };
        let (h, v) = (amount(horizontal, false), amount(vertical, true));
        let steps = horizontal.unsigned_abs().max(vertical.unsigned_abs());
        let mut node = Some(element.clone());
        for _ in 0..24 {
            let Some(current) = node else { break };
            if let Ok(pattern) = current.get_pattern::<UIScrollPattern>()
                && pattern.scroll(h, v).is_ok()
            {
                for _ in 1..steps {
                    if pattern.scroll(h, v).is_err() {
                        break;
                    }
                }
                return true;
            }
            node = walker.get_parent(&current).ok();
        }
        false
    }

    /// Post wheel messages to the classic Win32 control under a point, one per
    /// notch, without moving the cursor. Wheel messages carry screen coordinates.
    fn post_wheel(x: f64, y: f64, horizontal: i32, vertical: i32) -> bool {
        let (sx, sy) = (x.round() as i32, y.round() as i32);
        let Some(hwnd) = Self::hwnd_at_screen(sx, sy) else {
            return false;
        };
        if !Self::accepts_posted_mouse(hwnd) {
            return false;
        }
        let lparam = Self::pack_client_lparam(sx, sy);
        let (message, delta) = if horizontal != 0 {
            (WM_MOUSEHWHEEL, horizontal)
        } else {
            (WM_MOUSEWHEEL, vertical)
        };
        let notch = (delta.signum() * WHEEL_DELTA) as i16 as u16 as usize;
        (0..delta.unsigned_abs()).all(|_| {
            unsafe { PostMessageW(Some(hwnd), message, WPARAM(notch << 16), lparam) }.is_ok()
        })
    }

    fn scroll_wheel(horizontal: bool, notches: i32) -> Result<()> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: (notches * WHEEL_DELTA) as u32,
                    dwFlags: if horizontal {
                        MOUSEEVENTF_HWHEEL
                    } else {
                        MOUSEEVENTF_WHEEL
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let sent = unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
        if sent == 0 {
            return Err(DesktopError::new(
                "the system rejected synthetic scrolling — another app may be holding an input grab",
            ));
        }
        Ok(())
    }

    /// Render one element as an outline row, registering it when it is
    /// interactive enough to be worth an id.
    fn describe(&mut self, element: &UIElement, depth: usize, next_id: &mut u32) -> Option<String> {
        let control_type = element
            .get_control_type()
            .map(|kind| format!("{kind:?}"))
            .unwrap_or_else(|_| "Unknown".to_string());
        let name = element.get_name().unwrap_or_default();
        let value = element
            .get_pattern::<UIValuePattern>()
            .ok()
            .and_then(|pattern| pattern.get_value().ok())
            .filter(|value| !value.is_empty());

        // Rows with nothing to say are noise in an already large tree.
        if name.is_empty() && value.is_none() && control_type == "Pane" {
            return None;
        }

        let interactive = element.is_enabled().unwrap_or(false)
            && matches!(
                control_type.as_str(),
                "Button"
                    | "CheckBox"
                    | "ComboBox"
                    | "Edit"
                    | "Document"
                    | "Hyperlink"
                    | "ListItem"
                    | "MenuItem"
                    | "RadioButton"
                    | "Slider"
                    | "SplitButton"
                    | "Tab"
                    | "TabItem"
                    | "Text"
                    | "Tree"
                    | "TreeItem"
            );

        let mut row = "  ".repeat(depth);
        if interactive {
            *next_id += 1;
            row.push_str(&format!("[e{next_id}] "));
            self.registry.insert(*next_id, element.clone());
        }
        row.push_str(&control_type);
        if !name.is_empty() {
            row.push_str(&format!(" \"{}\"", truncate(&name, 120)));
        }
        if let Some(value) = value {
            row.push_str(&format!(" = \"{}\"", truncate(&value, 120)));
        }
        if !element.is_enabled().unwrap_or(true) {
            row.push_str(" (disabled)");
        }
        Some(row)
    }

    #[allow(clippy::too_many_arguments)]
    fn walk(
        &mut self,
        element: &UIElement,
        depth: usize,
        max_depth: usize,
        max_elements: usize,
        next_id: &mut u32,
        lines: &mut Vec<String>,
    ) {
        if depth > max_depth || lines.len() >= max_elements {
            return;
        }
        if let Some(row) = self.describe(element, depth, next_id) {
            lines.push(row);
        }
        // At max_depth we still describe this node, but skip child enumeration —
        // walking siblings would only waste UIA work with no lines added.
        if depth == max_depth {
            return;
        }

        let walker = match self.automation.create_tree_walker() {
            Ok(walker) => walker,
            Err(_) => return,
        };
        let mut child = walker.get_first_child(element).ok();
        while let Some(current) = child {
            if lines.len() >= max_elements {
                lines.push(format!(
                    "{}… truncated at {max_elements} elements — raise max_elements or target a child",
                    "  ".repeat(depth + 1)
                ));
                return;
            }
            self.walk(&current, depth + 1, max_depth, max_elements, next_id, lines);
            child = walker.get_next_sibling(&current).ok();
        }
    }
}

fn truncate(value: &str, limit: usize) -> String {
    let cleaned = value.replace(['\n', '\r'], " ");
    if cleaned.chars().count() <= limit {
        return cleaned;
    }
    cleaned.chars().take(limit).collect::<String>() + "…"
}

/// What one `press_key` call sends, before it becomes `SendInput` records.
///
/// Built directly from virtual-key codes rather than the `uiautomation` key
/// syntax: that syntax only knows a few dozen names (anything else was typed as
/// literal text, so `pageup` typed "pageup") and treats `{`, `}`, `(` and `)` as
/// markup. Virtual keys have neither problem.
#[derive(Debug, PartialEq, Eq)]
struct KeyPlan {
    /// Virtual keys held for the duration of the press, in press order.
    modifiers: Vec<u16>,
    stroke: Stroke,
}

#[derive(Debug, PartialEq, Eq)]
enum Stroke {
    /// A virtual key; `extended` sets KEYEVENTF_EXTENDEDKEY, which navigation
    /// keys need so they are not read as their numeric-keypad twins.
    Vk { vk: u16, extended: bool },
    /// A character the active layout has no key for; sent as KEYEVENTF_UNICODE.
    Unicode(char),
}

const VK_SHIFT: u16 = 0x10;
const VK_CONTROL: u16 = 0x11;
const VK_MENU: u16 = 0x12;
const VK_LWIN: u16 = 0x5B;

/// Translate the tool's modifier names into virtual keys.
///
/// `cmd` maps to Win rather than failing: models trained on macOS reach for it
/// constantly, and Win is the closest analogue.
///
/// Unknown modifiers are rejected (except `fn`, which has no synthetic
/// equivalent and is intentionally ignored) so a typo like `ctl` cannot
/// silently send the bare key while reporting success.
fn modifier_vks(modifiers: &[String]) -> Result<Vec<u16>> {
    let mut held = Vec::new();
    for modifier in modifiers {
        let vk = match modifier.to_lowercase().as_str() {
            "cmd" | "command" | "win" | "super" | "meta" => VK_LWIN,
            "ctrl" | "control" => VK_CONTROL,
            "alt" | "option" => VK_MENU,
            "shift" => VK_SHIFT,
            // `fn` has no synthetic equivalent on Windows; dropping it is better
            // than refusing an otherwise valid chord.
            "fn" => continue,
            other => {
                return Err(DesktopError::new(format!(
                    "unsupported modifier '{other}' — use ctrl, shift, alt, or cmd"
                )));
            }
        };
        if !held.contains(&vk) {
            held.push(vk);
        }
    }
    Ok(held)
}

/// Virtual key for a named key, and whether it is an extended key.
fn named_vk(named: Named) -> Option<(u16, bool)> {
    Some(match named {
        Named::Return => (0x0D, false),
        Named::Tab => (0x09, false),
        Named::Escape => (0x1B, false),
        Named::Space => (0x20, false),
        Named::Backspace => (0x08, false),
        Named::Delete | Named::ForwardDelete => (0x2E, true),
        Named::PageUp => (0x21, true),
        Named::PageDown => (0x22, true),
        Named::End => (0x23, true),
        Named::Home => (0x24, true),
        Named::Left => (0x25, true),
        Named::Up => (0x26, true),
        Named::Right => (0x27, true),
        Named::Down => (0x28, true),
        Named::Insert => (0x2D, true),
        // VK_F1 is 0x70 and F1–F24 are contiguous.
        Named::F(n) if (1..=24).contains(&n) => (0x70 + u16::from(n) - 1, false),
        Named::F(_) => return None,
        Named::Numpad(digit) if digit <= 9 => (0x60 + u16::from(digit), false),
        Named::Numpad(_) => return None,
        Named::NumpadMultiply => (0x6A, false),
        Named::NumpadAdd => (0x6B, false),
        Named::NumpadSubtract => (0x6D, false),
        Named::NumpadDecimal => (0x6E, false),
        Named::NumpadDivide => (0x6F, true),
        // The keypad Enter is VK_RETURN flagged as extended.
        Named::NumpadEnter => (0x0D, true),
        // PC keypads have no equals key.
        Named::NumpadEquals => return None,
    })
}

/// Resolve a character through the active keyboard layout: its virtual key plus
/// the shift/ctrl/alt state VkKeyScanW says produces it. `None` when the layout
/// has no key for it.
fn layout_vk(character: char) -> Option<(u16, Vec<u16>)> {
    let mut units = [0u16; 2];
    let encoded = character.encode_utf16(&mut units);
    if encoded.len() != 1 {
        return None;
    }
    let scan = unsafe { VkKeyScanW(encoded[0]) };
    if scan == -1 {
        return None;
    }
    let vk = (scan as u16) & 0xFF;
    let state = ((scan as u16) >> 8) & 0xFF;
    let mut extra = Vec::new();
    if state & 0x01 != 0 {
        extra.push(VK_SHIFT);
    }
    if state & 0x02 != 0 {
        extra.push(VK_CONTROL);
    }
    if state & 0x04 != 0 {
        extra.push(VK_MENU);
    }
    Some((vk, extra))
}

fn key_plan(
    key: &str,
    modifiers: &[String],
    layout: impl Fn(char) -> Option<(u16, Vec<u16>)>,
) -> Result<KeyPlan> {
    let mut held = modifier_vks(modifiers)?;
    let parsed = keys::parse(key).ok_or_else(|| {
        DesktopError::new(format!(
            "unsupported key '{key}' — use a single character or a named key (enter, pageup, f5, comma, numpad1, …)"
        ))
    })?;
    let stroke = match parsed {
        Key::Named(named) => {
            let (vk, extended) = named_vk(named).ok_or_else(|| {
                DesktopError::new(format!("'{key}' has no equivalent key on Windows"))
            })?;
            Stroke::Vk { vk, extended }
        }
        Key::Char(character) => {
            // A chord names the key, not the character: ctrl+S means ctrl+s,
            // matching macOS, rather than ctrl+shift+s.
            let character = if held.is_empty() {
                character
            } else {
                character.to_ascii_lowercase()
            };
            match layout(character) {
                Some((vk, extra)) => {
                    for modifier in extra {
                        if !held.contains(&modifier) {
                            held.push(modifier);
                        }
                    }
                    Stroke::Vk { vk, extended: false }
                }
                None if held.is_empty() => Stroke::Unicode(character),
                None => {
                    return Err(DesktopError::new(format!(
                        "'{key}' is not on the current keyboard layout, so it cannot be combined with modifiers"
                    )));
                }
            }
        }
    };
    Ok(KeyPlan { modifiers: held, stroke })
}

fn keyboard_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn vk_input(vk: u16, extended: bool, up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } as u16;
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if extended || vk == VK_LWIN {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    keyboard_input(vk, scan, flags)
}

/// Send a plan as one `SendInput` batch, so the user's own keystrokes cannot
/// interleave with the chord and modifiers are always released.
fn send_key_plan(plan: &KeyPlan) -> Result<()> {
    let mut inputs = Vec::new();
    for vk in &plan.modifiers {
        inputs.push(vk_input(*vk, false, false));
    }
    match plan.stroke {
        Stroke::Vk { vk, extended } => {
            inputs.push(vk_input(vk, extended, false));
            inputs.push(vk_input(vk, extended, true));
        }
        Stroke::Unicode(character) => {
            let mut units = [0u16; 2];
            for unit in character.encode_utf16(&mut units).iter() {
                inputs.push(keyboard_input(0, *unit, KEYEVENTF_UNICODE));
                inputs.push(keyboard_input(0, *unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
        }
    }
    for vk in plan.modifiers.iter().rev() {
        inputs.push(vk_input(*vk, false, true));
    }
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(DesktopError::new(
            "the system rejected the synthetic key press — a higher-integrity window (an elevated \
             app or UAC prompt) may have focus",
        ));
    }
    Ok(())
}

impl Desktop for WindowsDesktop {
    fn list_apps(&mut self) -> Result<String> {
        Ok(format_app_list(apps::list_apps()?))
    }

    fn resolve_pid(&mut self, app: &str) -> Result<u32> {
        apps::resolve_pid(app)
    }

    fn get_app_state(&mut self, app: &str, max_depth: usize, max_elements: usize) -> Result<String> {
        // Ids are per-snapshot, so previous handles must not resolve — clear
        // before resolve_pid so a failed lookup cannot leave stale ids.
        self.registry.clear();
        let pid = apps::resolve_pid(app)?;
        let windows = Self::top_level_windows(pid);
        if windows.is_empty() {
            return Err(DesktopError::new(format!(
                "{app} (pid {pid}) has no visible window"
            )));
        }

        let mut next_id = 0u32;
        let mut lines = vec![format!("{app} (pid {pid}), {} window(s)", windows.len())];
        // One shared element budget across every window — recreating the walk
        // buffer per window would let multi-window apps emit
        // windows.len() * max_elements rows.
        let mut element_lines = Vec::new();

        for (index, window) in windows.iter().enumerate() {
            let element = match self
                .automation
                .element_from_handle(Handle::from(window.0 as isize))
            {
                Ok(element) => element,
                Err(_) => continue,
            };
            let title = element.get_name().unwrap_or_default();
            lines.push(String::new());
            lines.push(format!("── window {index}: \"{title}\""));
            let window_start = element_lines.len();
            self.walk(
                &element,
                0,
                max_depth,
                max_elements,
                &mut next_id,
                &mut element_lines,
            );
            lines.extend(element_lines[window_start..].iter().cloned());
        }

        if next_id == 0 {
            lines.push(String::new());
            lines.push(
                "no interactive elements found — the app may render its own UI, so use screenshot \
                 and click with coordinates"
                    .to_string(),
            );
        }
        Ok(lines.join("\n"))
    }

    fn activate_app(&mut self, app: &str) -> Result<String> {
        let pid = apps::resolve_pid(app)?;
        let windows = Self::top_level_windows(pid);
        let window = windows.first().ok_or_else(|| {
            DesktopError::new(format!("{app} (pid {pid}) has no window to activate"))
        })?;
        unsafe {
            let _ = ShowWindow(*window, SW_RESTORE);
        }
        let raised = unsafe { SetForegroundWindow(*window) };
        if !raised.as_bool() {
            // Windows refuses foreground changes from background processes in
            // some states; say so rather than claim a success the model can see
            // is false in the next screenshot.
            return Err(DesktopError::new(format!(
                "Windows refused to bring {app} forward — click its taskbar button, or try again \
                 after interacting with the desktop"
            )));
        }
        Ok(format!("activated {app} (pid {pid})"))
    }

    fn click(&mut self, target: Point, click_count: u32) -> Result<String> {
        // An element press goes through the control's own Invoke handler, which
        // is far more reliable than a synthetic click landing on the right pixel.
        if let Point::Element(id) = target
            && click_count == 1
            && let Ok(element) = self.element(id)
            && let Ok(invoke) = element.get_pattern::<UIInvokePattern>()
        {
            // Wait for the agent pointer to land before invoking, matching Mac.
            if let Ok((x, y)) = Self::center(element) {
                AgentCursor::shared().press(x, y);
            }
            if invoke.invoke().is_ok() {
                return Ok(format!("pressed e{id}"));
            }
        }

        let (x, y) = self.point_coordinates(target)?;
        AgentCursor::shared().press(x, y);
        // Prefer window-message delivery so the user's cursor stays put.
        if click_count <= 1 && Self::background_click(x, y, false) {
            return Ok(format!("clicked at ({x:.0}, {y:.0}) in background"));
        }

        let mouse = Mouse::default();
        let point = UIPoint::new(x as i32, y as i32);
        for _ in 0..click_count.max(1) {
            mouse
                .click(&point)
                .map_err(|error| DesktopError::new(format!("click failed: {error}")))?;
        }
        Ok(format!(
            "clicked at ({:.0}, {:.0}) via cursor{}",
            x,
            y,
            if click_count > 1 {
                format!(" x{click_count}")
            } else {
                String::new()
            }
        ))
    }

    fn right_click(&mut self, target: Point) -> Result<String> {
        let (x, y) = self.point_coordinates(target)?;
        AgentCursor::shared().press(x, y);
        if Self::background_click(x, y, true) {
            return Ok(format!("right-clicked at ({x:.0}, {y:.0}) in background"));
        }
        Mouse::default()
            .right_click(&UIPoint::new(x as i32, y as i32))
            .map_err(|error| DesktopError::new(format!("right click failed: {error}")))?;
        Ok(format!("right-clicked at ({x:.0}, {y:.0}) via cursor"))
    }

    fn hover(&mut self, target: Point) -> Result<String> {
        let (x, y) = self.point_coordinates(target)?;
        AgentCursor::shared().show(x, y);
        // A posted WM_MOUSEMOVE lets hover-revealed controls (menus, toolbars,
        // tooltips) react without moving the user's cursor.
        if Self::background_hover(x, y) {
            return Ok(format!(
                "hovering at ({x:.0}, {y:.0}) in background — call get_app_state or screenshot to see what appeared"
            ));
        }
        Mouse::default()
            .move_to(&UIPoint::new(x as i32, y as i32))
            .map_err(|error| DesktopError::new(format!("hover failed: {error}")))?;
        Ok(format!(
            "hovering at ({x:.0}, {y:.0}) via cursor — call get_app_state or screenshot to see what appeared"
        ))
    }

    fn drag(&mut self, from: Point, to: Point) -> Result<String> {
        let (from_x, from_y) = self.point_coordinates(from)?;
        let (to_x, to_y) = self.point_coordinates(to)?;
        AgentCursor::shared().show(from_x, from_y);
        if Self::background_drag((from_x, from_y), (to_x, to_y)) {
            AgentCursor::shared().press(to_x, to_y);
            return Ok(format!(
                "dragged ({from_x:.0}, {from_y:.0}) → ({to_x:.0}, {to_y:.0}) in background"
            ));
        }
        // Everything else (Chromium, WPF, UWP, drags between windows) only
        // responds to real mouse input, which moves the user's pointer.
        let mouse = Mouse::default();
        mouse
            .move_to(&UIPoint::new(from_x as i32, from_y as i32))
            .map_err(|error| DesktopError::new(format!("could not reach the drag origin: {error}")))?;
        // Fly overlay to the end before the real drag starts (button still up).
        AgentCursor::shared().press(to_x, to_y);
        mouse
            .drag_to(MouseButton::LEFT, &UIPoint::new(to_x as i32, to_y as i32))
            .map_err(|error| DesktopError::new(format!("drag failed: {error}")))?;
        Ok(format!(
            "dragged ({from_x:.0}, {from_y:.0}) → ({to_x:.0}, {to_y:.0}) via cursor"
        ))
    }

    fn type_text(&mut self, text: &str, element: Option<u32>) -> Result<String> {
        if let Some(id) = element {
            self.element(id)?
                .set_focus()
                .map_err(|error| DesktopError::new(format!("could not focus e{id}: {error}")))?;
        }
        Keyboard::default()
            .send_text(text)
            .map_err(|error| DesktopError::new(format!("typing failed: {error}")))?;
        Ok(format!("typed {} characters", text.chars().count()))
    }

    fn press_key(&mut self, key: &str, modifiers: &[String]) -> Result<String> {
        let plan = key_plan(key, modifiers, layout_vk)?;
        send_key_plan(&plan)?;
        Ok(if modifiers.is_empty() {
            format!("pressed {key}")
        } else {
            format!("pressed {}+{key}", modifiers.join("+"))
        })
    }

    fn scroll(
        &mut self,
        direction: ScrollDirection,
        amount: i32,
        element: Option<u32>,
    ) -> Result<String> {
        let (horizontal, vertical) = direction.deltas(amount);
        let label = format!("scrolled {direction:?} by {amount}").to_lowercase();
        if let Some(id) = element {
            let target = self.element(id)?.clone();
            let (x, y) = Self::center(&target)?;
            AgentCursor::shared().show(x, y);
            // Neither of these touches the user's cursor: the control's own
            // ScrollPattern first, then wheel messages posted to its window.
            if self.uia_scroll(&target, horizontal, vertical) {
                return Ok(format!("{label} in background (UI Automation)"));
            }
            if Self::post_wheel(x, y, horizontal, vertical) {
                return Ok(format!("{label} in background"));
            }
            // Last resort: the wheel goes to whatever is under the real
            // pointer, so the pointer has to move there.
            Mouse::default()
                .move_to(&UIPoint::new(x as i32, y as i32))
                .map_err(|error| DesktopError::new(format!("could not move cursor: {error}")))?;
            if horizontal != 0 {
                Self::scroll_wheel(true, horizontal)?;
            }
            if vertical != 0 {
                Self::scroll_wheel(false, vertical)?;
            }
            return Ok(format!("{label} via cursor"));
        }
        // No element: scroll whatever is under the pointer where it already is.
        if horizontal != 0 {
            Self::scroll_wheel(true, horizontal)?;
        }
        if vertical != 0 {
            Self::scroll_wheel(false, vertical)?;
        }
        Ok(format!("{label} at the pointer"))
    }

    fn set_value(&mut self, element: u32, value: &str) -> Result<String> {
        let target = self.element(element)?;
        let pattern = target.get_pattern::<UIValuePattern>().map_err(|_| {
            DesktopError::new(format!(
                "e{element} does not accept a value directly — click it and use type_text"
            ))
        })?;
        pattern
            .set_value(value)
            .map_err(|error| DesktopError::new(format!("could not set e{element}: {error}")))?;
        Ok(format!("set e{element} to \"{}\"", truncate(value, 80)))
    }

    fn select_text(&mut self, element: u32, start: usize, length: Option<usize>) -> Result<String> {
        let target = self.element(element)?;
        let pattern = target.get_pattern::<UITextPattern>().map_err(|_| {
            DesktopError::new(format!("e{element} does not expose selectable text"))
        })?;
        let document = pattern
            .get_document_range()
            .map_err(|error| DesktopError::new(format!("could not read e{element}: {error}")))?;
        let text = document.get_text(-1).map_err(|error| {
            DesktopError::new(format!("could not read e{element}: {error}"))
        })?;
        let total = text.chars().count();
        let start = start.min(total);
        let end = length.map_or(total, |count| (start + count).min(total));

        let range = document.clone();
        range
            .move_endpoint_by_unit(
                uiautomation::types::TextPatternRangeEndpoint::Start,
                uiautomation::types::TextUnit::Character,
                start as i32,
            )
            .and_then(|_| {
                range.move_endpoint_by_unit(
                    uiautomation::types::TextPatternRangeEndpoint::End,
                    uiautomation::types::TextUnit::Character,
                    -((total - end) as i32),
                )
            })
            .and_then(|_| range.select())
            .map_err(|error| DesktopError::new(format!("could not select in e{element}: {error}")))?;
        Ok(format!("selected {} characters in e{element}", end - start))
    }
}

#[cfg(test)]
mod tests {
    use super::{KeyPlan, Stroke, key_plan, truncate};

    /// A US layout stand-in so the tests do not depend on the machine's layout.
    fn us(character: char) -> Option<(u16, Vec<u16>)> {
        match character {
            'a'..='z' => Some((character.to_ascii_uppercase() as u16, vec![])),
            'A'..='Z' => Some((character as u16, vec![0x10])),
            '{' => Some((0xDB, vec![0x10])),
            '(' => Some((0x39, vec![0x10])),
            '/' => Some((0xBF, vec![])),
            ',' => Some((0xBC, vec![])),
            _ => None,
        }
    }

    fn plan(key: &str, modifiers: &[&str]) -> KeyPlan {
        let modifiers: Vec<String> = modifiers.iter().map(|m| m.to_string()).collect();
        key_plan(key, &modifiers, us).unwrap()
    }

    #[test]
    fn cmd_is_translated_to_the_windows_key() {
        // Models trained on macOS send cmd constantly; refusing it would make
        // every save and copy fail on Windows.
        assert_eq!(plan("s", &["cmd"]).modifiers, vec![0x5B]);
        assert_eq!(plan("s", &["ctrl"]).modifiers, vec![0x11]);
        assert_eq!(plan("s", &["ctrl"]).stroke, Stroke::Vk { vk: 'S' as u16, extended: false });
    }

    #[test]
    fn navigation_keys_are_virtual_keys_not_text() {
        assert_eq!(plan("pageup", &[]).stroke, Stroke::Vk { vk: 0x21, extended: true });
        assert_eq!(plan("pagedown", &[]).stroke, Stroke::Vk { vk: 0x22, extended: true });
        assert_eq!(plan("home", &[]).stroke, Stroke::Vk { vk: 0x24, extended: true });
        assert_eq!(plan("end", &[]).stroke, Stroke::Vk { vk: 0x23, extended: true });
        assert_eq!(plan("forwarddelete", &[]).stroke, Stroke::Vk { vk: 0x2E, extended: true });
        assert_eq!(plan("return", &[]).stroke, Stroke::Vk { vk: 0x0D, extended: false });
        assert_eq!(plan("Escape", &[]).stroke, Stroke::Vk { vk: 0x1B, extended: false });
    }

    #[test]
    fn function_and_numpad_keys_map_to_their_virtual_keys() {
        assert_eq!(plan("f1", &[]).stroke, Stroke::Vk { vk: 0x70, extended: false });
        assert_eq!(plan("F12", &[]).stroke, Stroke::Vk { vk: 0x7B, extended: false });
        assert_eq!(plan("f20", &[]).stroke, Stroke::Vk { vk: 0x83, extended: false });
        assert_eq!(plan("numpad0", &[]).stroke, Stroke::Vk { vk: 0x60, extended: false });
        assert_eq!(plan("numpadenter", &[]).stroke, Stroke::Vk { vk: 0x0D, extended: true });
        assert!(key_plan("numpadequals", &[], us).is_err());
    }

    #[test]
    fn key_syntax_characters_are_sent_as_keys() {
        // `{` and `(` were markup in the old key-sequence syntax.
        let brace = plan("{", &[]);
        assert_eq!(brace.stroke, Stroke::Vk { vk: 0xDB, extended: false });
        assert_eq!(brace.modifiers, vec![0x10]);
        assert_eq!(plan("(", &["ctrl"]).modifiers, vec![0x11, 0x10]);
        assert_eq!(plan("comma", &[]).stroke, Stroke::Vk { vk: 0xBC, extended: false });
    }

    #[test]
    fn a_chord_uses_the_unshifted_letter() {
        let chord = plan("S", &["ctrl"]);
        assert_eq!(chord.modifiers, vec![0x11]);
        // Without modifiers the capital is typed with shift.
        assert_eq!(plan("S", &[]).modifiers, vec![0x10]);
    }

    #[test]
    fn characters_off_the_layout_fall_back_to_unicode_only_without_modifiers() {
        assert_eq!(plan("é", &[]).stroke, Stroke::Unicode('é'));
        assert!(key_plan("é", &["ctrl".to_string()], us).is_err());
    }

    #[test]
    fn fn_modifier_is_dropped_rather_than_breaking_the_chord() {
        assert_eq!(plan("c", &["fn", "ctrl"]).modifiers, vec![0x11]);
    }

    #[test]
    fn unrecognized_modifiers_and_keys_are_rejected() {
        let error = key_plan("c", &["ctl".to_string()], us).unwrap_err();
        assert!(error.0.contains("unsupported modifier"));
        assert!(error.0.contains("ctl"));
        assert!(key_plan("pagedwn", &[], us).is_err());
    }

    #[test]
    fn truncation_collapses_newlines_and_marks_elision() {
        assert_eq!(truncate("one\ntwo", 40), "one two");
        let long = truncate(&"x".repeat(200), 10);
        assert_eq!(long.chars().count(), 11, "10 chars plus the ellipsis");
        assert!(long.ends_with('…'));
    }
}
