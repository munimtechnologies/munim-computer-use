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
use uiautomation::core::{UICacheRequest, UICondition};
use uiautomation::inputs::{Keyboard, Mouse, MouseButton};
use uiautomation::patterns::{
    UIInvokePattern, UIScrollPattern, UISelectionItemPattern, UITextPattern, UITogglePattern, UIValuePattern,
};
use uiautomation::types::{Handle, Point as UIPoint, ScrollAmount, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::core::BOOL;
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    IsWindowEnabled, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
    MOUSE_EVENT_FLAGS, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, MapVirtualKeyW, SendInput, VIRTUAL_KEY, VkKeyScanW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, EnumWindows, GW_OWNER, GetClassNameW,
    GA_ROOT, GetAncestor, GetWindow, GetWindowLongW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    PostMessageW, SW_RESTORE,
    SetForegroundWindow, ShowWindow, WindowFromPoint, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEHWHEEL,
    WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, GWL_STYLE,
};

use super::agent_cursor::AgentCursor;
use super::outline::{self, Bounds, Fingerprint, Listed, OcrMode, OcrText, truncate};
use super::{Desktop, DesktopError, Point, Result, ScrollDirection, StateOptions, format_app_list};
use crate::apps;
use crate::identity;
use crate::keys::{self, Key, Named};

/// One wheel notch, as Windows defines it.
const WHEEL_DELTA: i32 = 120;

/// What an id from the latest `get_app_state` stands for.
enum Entry {
    /// An accessibility element, with what it was when listed and the
    /// top-level window it lives in.
    Element { element: UIElement, fingerprint: Fingerprint, window: HWND },
    /// A line of on-screen text OCR found in `window`, acted on at its centre.
    Ocr { center: (f64, f64), window: HWND },
}

/// A registry entry that passed the freshness check.
enum Target {
    Element { element: UIElement, window: HWND, minimized: bool },
    Ocr { x: f64, y: f64, window: HWND },
}

pub struct WindowsDesktop {
    automation: UIAutomation,
    /// Entries from the most recent `get_app_state`, keyed by the numeric
    /// part of the `e12` ids handed to the model.
    registry: HashMap<u32, Entry>,
    /// Fetches a parent's children with every property the walk reads in one
    /// cross-process call, instead of a round trip per property per element.
    /// `None` if the request could not be built; the walk then reads live.
    batch: Option<Batch>,
}

struct Batch {
    request: UICacheRequest,
    all: UICondition,
    /// Children of a scroll container minus the rows UIA reports scrolled
    /// away, so a long list costs its visible rows rather than all of them.
    without_hidden_rows: UICondition,
    /// Just those hidden rows, to count them without fetching their properties.
    hidden_rows: UICondition,
}

/// The properties `Node::cached` reads.
const BATCHED: [UIProperty; 10] = [
    UIProperty::ControlType,
    UIProperty::Name,
    UIProperty::IsEnabled,
    UIProperty::IsOffscreen,
    UIProperty::BoundingRectangle,
    UIProperty::ValueValue,
    UIProperty::IsScrollPatternAvailable,
    UIProperty::IsWindowPatternAvailable,
    UIProperty::WindowIsModal,
    UIProperty::IsDialog,
];

impl WindowsDesktop {
    pub fn new() -> Result<Self> {
        let automation = UIAutomation::new().map_err(|error| {
            DesktopError::new(format!("failed to initialise UI Automation: {error}"))
        })?;
        let batch = Self::batch_request(&automation);
        Ok(Self {
            automation,
            registry: HashMap::new(),
            batch,
        })
    }

    fn batch_request(automation: &UIAutomation) -> Option<Batch> {
        let request = automation.create_cache_request().ok()?;
        for property in BATCHED {
            // IsDialog needs Windows 10 1809; older systems just go without it.
            if request.add_property(property).is_err() && property != UIProperty::IsDialog {
                return None;
            }
        }
        // Rows as `Node::is_row` defines them: ListItem, TreeItem, DataItem.
        let row_type = |id: i32| automation.create_property_condition(UIProperty::ControlType, Variant::from(id), None);
        let rows = automation.create_or_condition(
            automation.create_or_condition(row_type(50007).ok()?, row_type(50024).ok()?).ok()?,
            row_type(50029).ok()?,
        ).ok()?;
        let offscreen = || automation.create_property_condition(UIProperty::IsOffscreen, Variant::from(true), None);
        let hidden_rows = automation.create_and_condition(offscreen().ok()?, rows).ok()?;
        let without_hidden_rows = automation.create_not_condition(hidden_rows.clone()).ok()?;
        Some(Batch { request, all: automation.create_true_condition().ok()?, without_hidden_rows, hidden_rows })
    }

    /// Resolve an id, rechecking that the element is still what was listed:
    /// acting on whatever now sits at a stale handle is worse than failing.
    fn resolve(&self, id: u32) -> Result<Target> {
        let entry = self.registry.get(&id).ok_or_else(|| {
            DesktopError::new(format!(
                "element e{id} is not in the current snapshot — call get_app_state again, ids are per-snapshot"
            ))
        })?;
        match entry {
            Entry::Ocr { center, window } => Ok(Target::Ocr { x: center.0, y: center.1, window: *window }),
            Entry::Element { element, fingerprint, window } => {
                // A destroyed window's controls can still answer from a
                // proxy's cache, so check the window itself first.
                let current = if unsafe { IsWindow(Some(*window)) }.as_bool() { Self::fingerprint(element) } else { None };
                outline::check_fresh(id, fingerprint, current.as_ref())?;
                Ok(Target::Element {
                    element: element.clone(),
                    window: *window,
                    minimized: unsafe { IsIconic(*window) }.as_bool(),
                })
            }
        }
    }

    /// The element's role and name as it is now; `None` once it is gone.
    fn fingerprint(element: &UIElement) -> Option<Fingerprint> {
        let role = element.get_control_type().ok()?;
        let name = element.get_name().ok()?;
        Some(Fingerprint { role: format!("{role:?}"), name })
    }

    /// Where a coordinate action aims at a resolved target.
    fn target_point(id: u32, target: &Target) -> Result<(f64, f64)> {
        let (x, y, window) = match target {
            Target::Ocr { x, y, window } => (*x, *y, *window),
            // A minimized window's controls sit far off screen: a click there
            // would land on whatever is actually at those coordinates.
            Target::Element { minimized: true, .. } => return Err(outline::minimized_error(id)),
            Target::Element { element, window, .. } => {
                let (x, y) = Self::center(element)?;
                (x, y, *window)
            }
        };
        Self::check_uncovered(id, window, x, y)?;
        Ok((x, y))
    }

    /// A coordinate action reaches whatever window is on top at the point:
    /// the real cursor clicks it, and posted messages go to it. When another
    /// app's window covers the target there, refuse rather than act on it.
    fn check_uncovered(id: u32, window: HWND, x: f64, y: f64) -> Result<()> {
        let owner = |hwnd: HWND| {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            pid
        };
        let at = unsafe { WindowFromPoint(POINT { x: x.round() as i32, y: y.round() as i32 }) };
        if at.0.is_null() {
            return Ok(());
        }
        let top = owner(unsafe { GetAncestor(at, GA_ROOT) });
        if top == owner(window) || top == std::process::id() {
            return Ok(());
        }
        Err(DesktopError::new(format!(
            "e{id} is covered by another window — bring it forward with activate_app, or use an action that works through accessibility"
        )))
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
            Point::Element(id) => Self::target_point(id, &self.resolve(id)?),
        }
    }

    /// Press an element through its own patterns rather than a pointer. Invoke
    /// is the control's own click handler. A minimized window cannot take a
    /// pointer click at all, so there Toggle and SelectionItem stand in for
    /// the click on checkboxes, list rows and tabs.
    fn press_through_patterns(id: u32, element: &UIElement, minimized: bool) -> Option<String> {
        if let Ok(invoke) = element.get_pattern::<UIInvokePattern>() {
            // Wait for the agent pointer to land before invoking, matching Mac.
            if !minimized && let Ok((x, y)) = Self::center(element) {
                AgentCursor::shared().press(x, y);
            }
            if invoke.invoke().is_ok() {
                return Some(format!("pressed e{id}"));
            }
        }
        if minimized {
            if let Ok(toggle) = element.get_pattern::<UITogglePattern>()
                && toggle.toggle().is_ok()
            {
                return Some(format!("toggled e{id}"));
            }
            if let Ok(item) = element.get_pattern::<UISelectionItemPattern>()
                && item.select().is_ok()
            {
                return Some(format!("selected e{id}"));
            }
        }
        None
    }

    /// A password field the agent must not write into (UIA `IsPassword`),
    /// unless the user opted in.
    fn refuses_secure_input(element: &UIElement) -> bool {
        !super::secure_field_input_allowed() && element.is_password().unwrap_or(false)
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

    /// Remote control puts the real cursor exactly where the viewer's pointer
    /// is, at once. uiautomation's `move_to` glides there over 500 ms, which
    /// left every streamed pointer move half a second behind the viewer and
    /// queued the rest behind it; it also normalises absolute coordinates
    /// against the primary screen only, so a second monitor was unreachable.
    /// `SetCursorPos` takes virtual-desktop coordinates and posts the
    /// mouse-move itself, so hover states still follow. Every path that moves
    /// the real cursor uses it for the same reason: `move_to`, `click`,
    /// `right_click` and `drag_to` all clamp to the primary display.
    fn jump_cursor(x: f64, y: f64) -> Result<()> {
        Mouse::set_cursor_pos(&UIPoint::new(x.round() as i32, y.round() as i32))
            .map_err(|error| DesktopError::new(format!("could not move cursor: {error}")))
    }

    /// Press or release a mouse button where the cursor already is.
    fn mouse_button(flags: MOUSE_EVENT_FLAGS) -> Result<()> {
        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        };
        if unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) } == 0 {
            return Err(DesktopError::new(
                "the system rejected the synthetic mouse button — a higher-integrity window may have focus",
            ));
        }
        Ok(())
    }

    /// Drag with the real cursor: press at `from`, move there in steps, release
    /// at `to`. The button is always released, even if a move fails, so it is
    /// never left held down.
    fn cursor_drag(from: (f64, f64), to: (f64, f64)) -> Result<()> {
        Self::jump_cursor(from.0, from.1)?;
        Self::mouse_button(MOUSEEVENTF_LEFTDOWN)?;
        let steps = 12;
        let mut moved = Ok(());
        for step in 1..=steps {
            std::thread::sleep(std::time::Duration::from_millis(10));
            let t = f64::from(step) / f64::from(steps);
            moved = Self::jump_cursor(from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
            if moved.is_err() {
                break;
            }
        }
        let released = Self::mouse_button(MOUSEEVENTF_LEFTUP);
        moved.and(released)
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

    /// The children of `element`, with their properties. With `skip_hidden_rows`,
    /// rows UIA reports scrolled away are left out on the provider's side and
    /// only counted; the second number is that count.
    fn children(&self, element: &UIElement, skip_hidden_rows: bool) -> (Vec<Node>, usize) {
        if let Some(batch) = &self.batch {
            if skip_hidden_rows
                && let Ok(found) = element.find_all_build_cache(TreeScope::Children, &batch.without_hidden_rows, &batch.request)
            {
                // Counting needs no properties, which is what makes it cheap:
                // 3,000 ListBox rows count in about a fifth of the time it
                // takes to fetch them.
                let hidden = element.find_all(TreeScope::Children, &batch.hidden_rows).map_or(0, |rows| rows.len());
                return (found.into_iter().map(Node::cached).collect(), hidden);
            }
            // A provider that cannot answer FindAll has no children to offer
            // a walker either.
            let found = element
                .find_all_build_cache(TreeScope::Children, &batch.all, &batch.request)
                .map(|found| found.into_iter().map(Node::cached).collect())
                .unwrap_or_default();
            return (found, 0);
        }
        let Ok(walker) = self.automation.create_tree_walker() else {
            return (Vec::new(), 0);
        };
        let mut nodes = Vec::new();
        let mut child = walker.get_first_child(element).ok();
        while let Some(current) = child {
            child = walker.get_next_sibling(&current).ok();
            nodes.push(Node::live(current));
        }
        (nodes, 0)
    }

    /// A top-level window as the root of a walk.
    fn window_node(&self, window: HWND) -> Option<Node> {
        let handle = Handle::from(window.0 as isize);
        if let Some(batch) = &self.batch
            && let Ok(element) = self.automation.element_from_handle_build_cache(handle, &batch.request)
        {
            return Some(Node::cached(element));
        }
        self.automation.element_from_handle(Handle::from(window.0 as isize)).ok().map(Node::live)
    }

    /// Render one element as an outline row, registering it when it is
    /// interactive enough to be worth an id.
    fn describe(&mut self, walk: &mut Walk, node: &Node, depth: usize, window: HWND, chrome: bool) -> Option<String> {
        let control_type = node.control_type.as_str();
        // Rows with nothing to say are noise in an already large tree.
        if node.name.is_empty() && node.value.is_none() && control_type == "Pane" {
            return None;
        }

        let enabled = node.enabled.unwrap_or(false);
        let interactive = enabled
            && matches!(
                control_type,
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
        if !chrome && is_app_control(control_type, &node.name, enabled) {
            walk.app_control = true;
        }
        if let Some(bounds) = node.bounds {
            walk.listed.push(Listed {
                bounds,
                name: node.name.clone(),
                value: node.value.clone().unwrap_or_default(),
                chrome: control_type == "TitleBar",
            });
        }

        let mut row = "  ".repeat(depth);
        if interactive {
            walk.next_id += 1;
            row.push_str(&format!("[e{}] ", walk.next_id));
            self.registry.insert(
                walk.next_id,
                Entry::Element {
                    element: node.element.clone(),
                    fingerprint: Fingerprint { role: node.control_type.clone(), name: node.name.clone() },
                    window,
                },
            );
        }
        row.push_str(control_type);
        if !node.name.is_empty() {
            row.push_str(&format!(" \"{}\"", truncate(&node.name, 120)));
        }
        if let Some(value) = &node.value {
            row.push_str(&format!(" = \"{}\"", truncate(value, 120)));
        }
        if !node.enabled.unwrap_or(true) {
            row.push_str(" (disabled)");
        }
        Some(row)
    }

    /// Walk one top-level window, or a dialog inside one.
    fn walk_root(&mut self, walk: &mut Walk, root: &Node, window: &WindowInfo) {
        // A minimized window reports every control as off screen, so nothing
        // is left out of one.
        let clip = if window.minimized { None } else { root.bounds.filter(Bounds::has_area) };
        self.walk(walk, root, 0, clip, window, false);
    }

    /// `clip` is the visible part of the window and the scroll containers
    /// around `node`. Children outside it are skipped with their subtrees,
    /// unless `offscreen` asked for everything.
    fn walk(&mut self, walk: &mut Walk, node: &Node, depth: usize, clip: Option<Bounds>, window: &WindowInfo, chrome: bool) {
        let limits = walk.options;
        if depth > limits.max_depth || walk.rows.len() >= limits.max_elements {
            return;
        }
        if let Some(row) = self.describe(walk, node, depth, window.hwnd, chrome) {
            walk.rows.push(row);
        }
        // At max_depth we still describe this node, but skip child enumeration —
        // walking siblings would only waste UIA work with no lines added.
        if depth == limits.max_depth {
            walk.cut_short = true;
            return;
        }

        let chrome = chrome || node.control_type == "TitleBar";
        let clip = if node.floats() {
            node.bounds.filter(Bounds::has_area)
        } else if node.scrolls {
            outline::narrow_clip(clip, node.bounds)
        } else {
            clip
        };
        let prune = !limits.offscreen && !window.minimized;
        // Long lists live in scroll containers: leave their hidden rows to
        // the provider rather than fetching every one.
        let (children, hidden_rows) = self.children(&node.element, prune && node.scrolls);
        walk.skipped += hidden_rows;
        for child in children {
            if walk.rows.len() >= limits.max_elements {
                walk.rows.push(format!(
                    "{}… truncated at {} elements — raise max_elements or target a child",
                    "  ".repeat(depth + 1),
                    limits.max_elements
                ));
                return;
            }
            if prune && outline::is_off_screen(child.bounds, clip, child.offscreen, child.floats(), child.is_row()) {
                walk.skipped += 1;
                continue;
            }
            if walk.find_dialogs && child.dialog {
                walk.dialogs.push((window.clone(), child.element.clone()));
            }
            self.walk(walk, &child, depth + 1, clip, window, chrome);
        }
    }

    /// Top-level dialogs that disable the window that owns them, the way a
    /// modal dialog does: its owner is one of the app's windows and no longer
    /// takes input.
    fn blocking_dialogs(windows: &[HWND]) -> Vec<HWND> {
        windows
            .iter()
            .copied()
            .filter(|window| {
                let Ok(owner) = (unsafe { GetWindow(*window, GW_OWNER) }) else {
                    return false;
                };
                !owner.0.is_null()
                    && windows.iter().any(|other| other.0 == owner.0)
                    && !unsafe { IsWindowEnabled(owner) }.as_bool()
            })
            .collect()
    }

    /// Run OCR on one of `pid`'s windows (the largest when `window` is None).
    fn read_text(pid: u32, window: Option<HWND>) -> std::result::Result<Vec<OcrText>, String> {
        let wanted = window.map(|window| window.0 as usize as u32);
        let (image, frame) = crate::capture::capture_window_image(pid, wanted).map_err(|error| error.0)?;
        super::ocr::recognize(&image, &frame)
    }
}

/// One element's properties, read in a batch (`cached`) or one by one (`live`).
struct Node {
    element: UIElement,
    control_type: String,
    name: String,
    value: Option<String>,
    enabled: Option<bool>,
    /// UIA's IsOffscreen: scrolled out of view or collapsed away.
    offscreen: bool,
    bounds: Option<Bounds>,
    /// Has a ScrollPattern, so it clips its children to its own bounds.
    scrolls: bool,
    /// A modal window or dialog: blocks the window it is in.
    dialog: bool,
}

fn variant_bool(value: uiautomation::Result<Variant>) -> bool {
    value.ok().and_then(|value| TryInto::<bool>::try_into(value).ok()).unwrap_or(false)
}

fn bounds_of(rect: uiautomation::Result<uiautomation::types::Rect>) -> Option<Bounds> {
    rect.ok().map(|rect| {
        Bounds::from_edges(
            f64::from(rect.get_left()),
            f64::from(rect.get_top()),
            f64::from(rect.get_right()),
            f64::from(rect.get_bottom()),
        )
    })
}

impl Node {
    fn cached(element: UIElement) -> Self {
        let control_type = element
            .get_cached_control_type()
            .map(|kind| format!("{kind:?}"))
            .unwrap_or_else(|_| "Unknown".to_string());
        let modal = variant_bool(element.get_cached_property_value(UIProperty::IsWindowPatternAvailable))
            && variant_bool(element.get_cached_property_value(UIProperty::WindowIsModal));
        let dialog = (control_type == "Window" && modal)
            || variant_bool(element.get_cached_property_value(UIProperty::IsDialog));
        Self {
            name: element.get_cached_name().unwrap_or_default(),
            value: element
                .get_cached_property_value(UIProperty::ValueValue)
                .ok()
                .and_then(|value| TryInto::<String>::try_into(value).ok())
                .filter(|value| !value.is_empty()),
            enabled: element.is_cached_enabled().ok(),
            offscreen: element.is_cached_offscreen().unwrap_or(false),
            bounds: bounds_of(element.get_cached_bounding_rectangle()),
            scrolls: variant_bool(element.get_cached_property_value(UIProperty::IsScrollPatternAvailable)),
            dialog,
            control_type,
            element,
        }
    }

    fn live(element: UIElement) -> Self {
        let control_type = element
            .get_control_type()
            .map(|kind| format!("{kind:?}"))
            .unwrap_or_else(|_| "Unknown".to_string());
        let modal = variant_bool(element.get_property_value(UIProperty::IsWindowPatternAvailable))
            && variant_bool(element.get_property_value(UIProperty::WindowIsModal));
        let dialog = (control_type == "Window" && modal) || element.is_dialog().unwrap_or(false);
        Self {
            name: element.get_name().unwrap_or_default(),
            value: element
                .get_pattern::<UIValuePattern>()
                .ok()
                .and_then(|pattern| pattern.get_value().ok())
                .filter(|value| !value.is_empty()),
            enabled: element.is_enabled().ok(),
            offscreen: element.is_offscreen().unwrap_or(false),
            bounds: bounds_of(element.get_bounding_rectangle()),
            scrolls: variant_bool(element.get_property_value(UIProperty::IsScrollPatternAvailable)),
            dialog,
            control_type,
            element,
        }
    }

    fn is_row(&self) -> bool {
        matches!(self.control_type.as_str(), "ListItem" | "TreeItem" | "DataItem")
    }

    /// Menus, tooltips, popups and dialogs float outside their parents, so
    /// they are never skipped as off screen and start a clip of their own.
    fn floats(&self) -> bool {
        self.dialog || matches!(self.control_type.as_str(), "Menu" | "ToolTip" | "Window")
    }
}

/// The top-level window a walk is in.
#[derive(Clone)]
struct WindowInfo {
    hwnd: HWND,
    index: usize,
    title: String,
    minimized: bool,
}

/// Running totals of one `get_app_state` walk.
struct Walk {
    options: StateOptions,
    next_id: u32,
    rows: Vec<String>,
    /// Subtree roots left out as off screen.
    skipped: usize,
    /// Every listed element with bounds, so OCR does not repeat them.
    listed: Vec<Listed>,
    /// A labelled control of the app itself was listed (`ocr: auto`).
    app_control: bool,
    /// max_depth stopped the walk somewhere, so controls may lie deeper:
    /// too little is known to call the app inaccessible (`ocr: auto`).
    cut_short: bool,
    /// Collect modal dialogs met inside windows (first pass only).
    find_dialogs: bool,
    dialogs: Vec<(WindowInfo, UIElement)>,
}

impl Walk {
    fn new(options: StateOptions, find_dialogs: bool) -> Self {
        Self {
            options,
            next_id: 0,
            rows: Vec::new(),
            skipped: 0,
            listed: Vec::new(),
            app_control: false,
            cut_short: false,
            find_dialogs,
            dialogs: Vec::new(),
        }
    }
}

/// Whether an element is a control of the app itself, for `ocr: auto`: an
/// enabled control with a label (text inputs need none). Static text and bare
/// groups or panes do not count, and the caller leaves out the title bar's
/// own buttons.
fn is_app_control(control_type: &str, name: &str, enabled: bool) -> bool {
    enabled
        && match control_type {
            "Edit" | "Document" => true,
            "Button" | "CheckBox" | "ComboBox" | "DataItem" | "Hyperlink" | "ListItem" | "MenuItem"
            | "RadioButton" | "Slider" | "Spinner" | "SplitButton" | "TabItem" | "TreeItem" => {
                !name.trim().is_empty()
            }
            _ => false,
        }
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

    fn get_app_state(&mut self, app: &str, options: &StateOptions) -> Result<String> {
        // Ids are per-snapshot, so previous handles must not resolve — clear
        // before resolve_pid so a failed lookup cannot leave stale ids.
        self.registry.clear();
        let pid = apps::resolve_pid(app)?;
        let all = Self::top_level_windows(pid);
        if all.is_empty() {
            return Err(DesktopError::new(format!(
                "{app} (pid {pid}) has no visible window"
            )));
        }

        // A modal dialog blocks the window that owns it: list only the dialog,
        // since nothing behind it takes input until it is dismissed.
        let blocking = Self::blocking_dialogs(&all);
        let mut scoped = !blocking.is_empty();
        let windows: Vec<WindowInfo> = if scoped { blocking } else { all.clone() }
            .into_iter()
            .enumerate()
            .map(|(index, hwnd)| WindowInfo {
                hwnd,
                index,
                title: String::new(),
                minimized: unsafe { IsIconic(hwnd) }.as_bool(),
            })
            .collect();

        // One shared walk across every window: its element budget caps the
        // whole outline, not each window.
        let mut walk = Walk::new(*options, !scoped);
        let mut sections: Vec<(String, usize)> = Vec::new();
        for window in &windows {
            let Some(root) = self.window_node(window.hwnd) else { continue };
            let window = WindowInfo { title: root.name.clone(), ..window.clone() };
            sections.push((format!("── window {}: \"{}\"", window.index, window.title), walk.rows.len()));
            self.walk_root(&mut walk, &root, &window);
        }

        // A dialog inside a window (a XAML ContentDialog, a modal web dialog)
        // blocks it the same way. Start again, listing only the dialogs.
        let mut ocr_window = scoped.then(|| windows[0].hwnd);
        let mut ocr_clip: Option<Bounds> = None;
        if !walk.dialogs.is_empty() {
            let dialogs = std::mem::take(&mut walk.dialogs);
            self.registry.clear();
            walk = Walk::new(*options, false);
            sections.clear();
            scoped = true;
            for (window, dialog) in dialogs {
                let root = match &self.batch {
                    Some(batch) => dialog.build_updated_cache(&batch.request).map(Node::cached).unwrap_or_else(|_| Node::live(dialog)),
                    None => Node::live(dialog),
                };
                if ocr_window.is_none() {
                    ocr_window = Some(window.hwnd);
                    ocr_clip = root.bounds.filter(Bounds::has_area);
                }
                sections.push((
                    format!("── window {}: \"{}\" — dialog \"{}\"", window.index, window.title, truncate(&root.name, 120)),
                    walk.rows.len(),
                ));
                self.walk_root(&mut walk, &root, &window);
            }
        }

        let mut notes = Vec::new();
        if scoped {
            notes.push(outline::DIALOG_NOTE.to_string());
        }
        let mut ocr_rows = Vec::new();
        let run_ocr = match options.ocr {
            OcrMode::Always => true,
            OcrMode::Never => false,
            OcrMode::Auto => !walk.app_control && !walk.cut_short,
        };
        if run_ocr {
            // Any of the app's windows identifies the pid for the covered check.
            let ocr_target = ocr_window.unwrap_or(all[0]);
            match Self::read_text(pid, ocr_window) {
                Ok(found) => {
                    let found = found
                        .into_iter()
                        .filter(|line| {
                            let (x, y) = line.bounds.center();
                            ocr_clip.is_none_or(|clip| clip.contains(x, y))
                        })
                        .collect();
                    for line in outline::dedupe_ocr(found, &walk.listed) {
                        walk.next_id += 1;
                        self.registry.insert(walk.next_id, Entry::Ocr { center: line.bounds.center(), window: ocr_target });
                        ocr_rows.push(outline::ocr_row(walk.next_id, &line.text));
                    }
                }
                Err(reason) if options.ocr == OcrMode::Always => notes.push(outline::ocr_unavailable_note(&reason)),
                // Under auto, OCR is a bonus: say nothing when it cannot run.
                Err(_) => {}
            }
        }

        let mut lines = vec![format!("{app} (pid {pid}), {} window(s)", all.len())];
        lines.extend(notes);
        for (index, (header, start)) in sections.iter().enumerate() {
            let end = sections.get(index + 1).map_or(walk.rows.len(), |next| next.1);
            lines.push(String::new());
            lines.push(header.clone());
            lines.extend(walk.rows[*start..end].iter().cloned());
        }
        if walk.skipped > 0 {
            lines.push(outline::offscreen_line(walk.skipped));
        }
        if !ocr_rows.is_empty() {
            lines.push(String::new());
            lines.push(outline::OCR_HEADER.to_string());
            lines.extend(ocr_rows);
        }

        if walk.next_id == 0 {
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
        let (x, y) = match target {
            Point::Screen(x, y) => (x, y),
            Point::Element(id) => {
                let resolved = self.resolve(id)?;
                // An element press goes through the control's own Invoke
                // handler, which is far more reliable than a synthetic click
                // landing on the right pixel. Remote control skips it: the
                // viewer is aiming at a pixel they can see, and an Invoke would
                // fire a different control than the one under them.
                if let Target::Element { element, minimized, .. } = &resolved
                    && !identity::remote_control()
                    && click_count == 1
                    && let Some(done) = Self::press_through_patterns(id, element, *minimized)
                {
                    return Ok(done);
                }
                Self::target_point(id, &resolved)?
            }
        };
        AgentCursor::shared().press(x, y);
        // Prefer window-message delivery so the user's cursor stays put --
        // unless this is remote control, where moving the cursor is the point.
        if !identity::remote_control() && click_count <= 1 && Self::background_click(x, y, false) {
            return Ok(format!("clicked at ({x:.0}, {y:.0}) in background"));
        }

        let mouse = Mouse::default();
        Self::jump_cursor(x, y)?;
        for _ in 0..click_count.max(1) {
            mouse
                .click_button(MouseButton::LEFT)
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
        if !identity::remote_control() && Self::background_click(x, y, true) {
            return Ok(format!("right-clicked at ({x:.0}, {y:.0}) in background"));
        }
        Self::jump_cursor(x, y)?;
        Mouse::default()
            .click_button(MouseButton::RIGHT)
            .map_err(|error| DesktopError::new(format!("right click failed: {error}")))?;
        Ok(format!("right-clicked at ({x:.0}, {y:.0}) via cursor"))
    }

    fn hover(&mut self, target: Point) -> Result<String> {
        let (x, y) = self.point_coordinates(target)?;
        AgentCursor::shared().show(x, y);
        // A posted WM_MOUSEMOVE lets hover-revealed controls (menus, toolbars,
        // tooltips) react without moving the user's cursor.
        if !identity::remote_control() && Self::background_hover(x, y) {
            return Ok(format!(
                "hovering at ({x:.0}, {y:.0}) in background — call get_app_state or screenshot to see what appeared"
            ));
        }
        Self::jump_cursor(x, y)?;
        Ok(format!(
            "hovering at ({x:.0}, {y:.0}) via cursor — call get_app_state or screenshot to see what appeared"
        ))
    }

    fn drag(&mut self, from: Point, to: Point) -> Result<String> {
        let (from_x, from_y) = self.point_coordinates(from)?;
        let (to_x, to_y) = self.point_coordinates(to)?;
        AgentCursor::shared().show(from_x, from_y);
        if !identity::remote_control() && Self::background_drag((from_x, from_y), (to_x, to_y)) {
            AgentCursor::shared().press(to_x, to_y);
            return Ok(format!(
                "dragged ({from_x:.0}, {from_y:.0}) → ({to_x:.0}, {to_y:.0}) in background"
            ));
        }
        // Everything else (Chromium, WPF, UWP, drags between windows) only
        // responds to real mouse input, which moves the user's pointer.
        // Fly overlay to the end before the real drag starts (button still up).
        AgentCursor::shared().press(to_x, to_y);
        Self::cursor_drag((from_x, from_y), (to_x, to_y))
            .map_err(|error| DesktopError::new(format!("drag failed: {error}")))?;
        Ok(format!(
            "dragged ({from_x:.0}, {from_y:.0}) → ({to_x:.0}, {to_y:.0}) via cursor"
        ))
    }

    fn type_text(&mut self, text: &str, element: Option<u32>) -> Result<String> {
        if let Some(id) = element {
            match self.resolve(id)? {
                // OCR text has no focus to take: click it, as a person would.
                ocr @ Target::Ocr { .. } => {
                    let (x, y) = Self::target_point(id, &ocr)?;
                    self.click(Point::Screen(x, y), 1)?;
                    std::thread::sleep(std::time::Duration::from_millis(60));
                }
                Target::Element { element: target, minimized, .. } => {
                    if Self::refuses_secure_input(&target) {
                        let _ = target.set_focus();
                        return Ok(super::secure_field_handback(id));
                    }
                    // Keystrokes go to the foreground window, which a
                    // minimized one is not.
                    if minimized {
                        return Err(outline::minimized_error(id));
                    }
                    target
                        .set_focus()
                        .map_err(|error| DesktopError::new(format!("could not focus e{id}: {error}")))?;
                }
            }
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
            let resolved = self.resolve(id)?;
            let point = Self::target_point(id, &resolved);
            if let Ok((x, y)) = point {
                AgentCursor::shared().show(x, y);
            }
            // Neither of these touches the user's cursor: the control's own
            // ScrollPattern first (which works in a minimized window too), then
            // wheel messages posted to its window.
            if !identity::remote_control() {
                if let Target::Element { element: target, .. } = &resolved
                    && self.uia_scroll(target, horizontal, vertical)
                {
                    return Ok(format!("{label} in background (UI Automation)"));
                }
                if let Ok((x, y)) = point
                    && Self::post_wheel(x, y, horizontal, vertical)
                {
                    return Ok(format!("{label} in background"));
                }
            }
            // Last resort: the wheel goes to whatever is under the real
            // pointer, so the pointer has to move there.
            let (x, y) = point?;
            Self::jump_cursor(x, y)?;
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
        let Target::Element { element: target, .. } = self.resolve(element)? else {
            return Err(outline::ocr_id_error(element));
        };
        if Self::refuses_secure_input(&target) {
            let _ = target.set_focus();
            return Ok(super::secure_field_handback(element));
        }
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
        let Target::Element { element: target, .. } = self.resolve(element)? else {
            return Err(outline::ocr_id_error(element));
        };
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
    use super::{KeyPlan, Stroke, is_app_control, key_plan, truncate};

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
    fn only_labelled_enabled_controls_keep_ocr_away() {
        assert!(is_app_control("Button", "Play", true));
        // Unlabelled buttons and disabled ones say nothing about the app.
        assert!(!is_app_control("Button", "  ", true));
        assert!(!is_app_control("Button", "Play", false));
        // Text inputs need no label.
        assert!(is_app_control("Edit", "", true));
        // Static text, groups and panes are not controls.
        assert!(!is_app_control("Text", "Now playing", true));
        assert!(!is_app_control("Group", "Sidebar", true));
        assert!(!is_app_control("Pane", "Main", true));
    }

    #[test]
    fn truncation_collapses_newlines_and_marks_elision() {
        assert_eq!(truncate("one\ntwo", 40), "one two");
        let long = truncate(&"x".repeat(200), 10);
        assert_eq!(long.chars().count(), 11, "10 chars plus the ellipsis");
        assert!(long.ends_with('…'));
    }
}
