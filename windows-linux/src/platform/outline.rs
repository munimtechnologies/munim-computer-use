//! Rules for the `get_app_state` outline that both backends share: what counts
//! as on screen, how a stale id is reported, and how OCR text joins the tree.
//!
//! Everything here is pure so it can be tested on any host. The wording of the
//! notes and errors is part of the tool contract and matches the macOS server
//! word for word, so a model sees one dialect everywhere.

use super::{DesktopError, Result};

/// A screen rectangle, in the coordinates click and hover take.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn from_edges(left: f64, top: f64, right: f64, bottom: f64) -> Self {
        Self {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        }
    }

    /// Zero-size elements have no area to be on or off screen. Web content
    /// routinely overflows zero-size wrappers, so those are never skipped.
    pub fn has_area(&self) -> bool {
        self.width > 0.0 && self.height > 0.0
    }

    pub fn overlaps(&self, other: &Bounds) -> bool {
        self.x < other.x + other.width
            && self.x + self.width > other.x
            && self.y < other.y + other.height
            && self.y + self.height > other.y
    }

    /// The overlap of two rectangles; empty (zero-size) when they do not meet.
    pub fn intersect(&self, other: &Bounds) -> Bounds {
        let left = self.x.max(other.x);
        let top = self.y.max(other.y);
        let right = (self.x + self.width).min(other.x + other.width);
        let bottom = (self.y + self.height).min(other.y + other.height);
        Bounds::new(left, top, (right - left).max(0.0), (bottom - top).max(0.0))
    }

    pub fn union(&self, other: &Bounds) -> Bounds {
        let left = self.x.min(other.x);
        let top = self.y.min(other.y);
        let right = (self.x + self.width).max(other.x + other.width);
        let bottom = (self.y + self.height).max(other.y + other.height);
        Bounds::from_edges(left, top, right, bottom)
    }

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }

    /// Intersection over union: how much two detections are the same box.
    pub fn iou(&self, other: &Bounds) -> f64 {
        let overlap = self.intersect(other);
        let shared = overlap.width * overlap.height;
        if shared <= 0.0 {
            return 0.0;
        }
        let total = self.width * self.height + other.width * other.height - shared;
        if total <= 0.0 { 0.0 } else { shared / total }
    }
}

/// Narrow the visible area as the walk enters a scroll container (or the
/// window itself). Without bounds the clip is unchanged.
pub fn narrow_clip(clip: Option<Bounds>, bounds: Option<Bounds>) -> Option<Bounds> {
    match (clip, bounds.filter(Bounds::has_area)) {
        (Some(clip), Some(bounds)) => Some(clip.intersect(&bounds)),
        (None, bounds) => bounds,
        (clip, None) => clip,
    }
}

/// Whether the walk leaves an element (and its subtree) out as off screen:
/// the platform says it is scrolled away, or its rectangle lies wholly outside
/// the window and every scroll container around it. `exempt` covers menus,
/// popups and dialogs, which float outside their parents by design.
///
/// Zero-size elements are kept, since web content overflows zero-size
/// wrappers, with one exception: a list or tree `row` the platform reports
/// off screen. Classic list controls report a scrolled-out row as an empty
/// rectangle, and a row is an item, not a wrapper.
pub fn is_off_screen(
    bounds: Option<Bounds>,
    clip: Option<Bounds>,
    reported_offscreen: bool,
    exempt: bool,
    row: bool,
) -> bool {
    if exempt {
        return false;
    }
    let Some(bounds) = bounds.filter(Bounds::has_area) else {
        return row && reported_offscreen;
    };
    reported_offscreen || clip.is_some_and(|clip| !bounds.overlaps(&clip))
}

/// The line appended when the walk left anything out. `skipped` counts subtree
/// roots, not every descendant.
pub fn offscreen_line(skipped: usize) -> String {
    format!("… {skipped} off-screen elements skipped; scroll, or pass offscreen=true to list them")
}

/// Header line when a modal dialog scoped the outline to its own controls.
pub const DIALOG_NOTE: &str = "note: a dialog is open — only its controls are listed; dismiss it (for example with Escape) to reach the window behind";

/// What an id pointed at when `get_app_state` handed it out. Only the name is
/// kept, not the value, so typing into a field does not invalidate its id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    pub role: String,
    pub name: String,
}

/// Compare an element as registered with what it is now. `current` is `None`
/// when the element can no longer be read at all.
pub fn check_fresh(id: u32, recorded: &Fingerprint, current: Option<&Fingerprint>) -> Result<()> {
    let Some(current) = current else {
        return Err(DesktopError::new(format!(
            "e{id} no longer exists — the app changed; call get_app_state again"
        )));
    };
    if current == recorded {
        return Ok(());
    }
    Err(DesktopError::new(format!(
        "e{id} changed since get_app_state (was {} \"{}\", now {} \"{}\"); call get_app_state again",
        recorded.role,
        truncate(&recorded.name, 80),
        current.role,
        truncate(&current.name, 80)
    )))
}

/// Coordinate actions cannot reach a minimized window: its controls sit far
/// off screen, so a click there would land on something else.
pub fn minimized_error(id: u32) -> DesktopError {
    DesktopError::new(format!(
        "e{id} is in a minimized window — restore it, or use an action that works through accessibility"
    ))
}

/// When to read on-screen text with OCR (`get_app_state`'s `ocr`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OcrMode {
    /// Only when the app exposes no labelled controls to accessibility.
    #[default]
    Auto,
    Always,
    Never,
}

impl OcrMode {
    pub fn parse(raw: Option<&str>) -> Result<Self> {
        match raw
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            None | Some("") | Some("auto") => Ok(Self::Auto),
            Some("always") => Ok(Self::Always),
            Some("never") => Ok(Self::Never),
            Some(other) => Err(DesktopError::new(format!(
                "unknown ocr mode '{other}' — use auto, always, or never"
            ))),
        }
    }
}

/// Section header for OCR text, printed after the accessibility tree.
pub const OCR_HEADER: &str = "── on-screen text (OCR)";

pub fn ocr_unavailable_note(reason: &str) -> String {
    format!("note: OCR unavailable: {reason}")
}

pub fn ocr_row(id: u32, text: &str) -> String {
    format!("  [e{id}] Text \"{}\"", truncate(text, 120))
}

/// set_value and select_text need an accessibility element; OCR text is pixels.
pub fn ocr_id_error(id: u32) -> DesktopError {
    DesktopError::new(format!(
        "e{id} is text read by OCR — click it, then use type_text"
    ))
}

/// One line of text OCR found, in screen coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct OcrText {
    pub text: String,
    pub bounds: Bounds,
}

/// An element the outline already lists, for dropping OCR text that repeats it.
#[derive(Clone, Debug)]
pub struct Listed {
    pub bounds: Bounds,
    pub name: String,
    pub value: String,
    /// Window chrome (the title bar): any OCR text centred in it is dropped,
    /// such as the glyphs on the minimize and close buttons.
    pub chrome: bool,
}

/// Case- and punctuation-insensitive text, so `Save…` and `save` compare equal.
pub fn normalize(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character.to_lowercase().next().unwrap_or(character)
            } else {
                ' '
            }
        })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Merge overlapping OCR detections of the same text (IoU at least 0.55), keeping
/// the longer reading, then drop text the outline already lists: a line centred
/// inside an element whose name contains it, or whose value it mostly covers,
/// and anything on the title bar.
/// A document's value holds all of its text, so its individual lines stay
/// targetable through OCR. Lines read top to bottom, left to right.
pub fn dedupe_ocr(lines: Vec<OcrText>, listed: &[Listed]) -> Vec<OcrText> {
    let mut ordered: Vec<OcrText> = lines
        .into_iter()
        .filter(|line| !line.text.trim().is_empty())
        .collect();
    ordered.sort_by_key(|line| std::cmp::Reverse(line.text.chars().count()));
    let mut kept: Vec<OcrText> = Vec::new();
    for candidate in ordered {
        if let Some(existing) = kept
            .iter_mut()
            .find(|existing| existing.bounds.iou(&candidate.bounds) >= 0.55)
        {
            existing.bounds = existing.bounds.union(&candidate.bounds);
            continue;
        }
        kept.push(candidate);
    }

    let listed: Vec<(Bounds, String, String, bool)> = listed
        .iter()
        .filter(|element| element.bounds.has_area())
        .map(|element| {
            (
                element.bounds,
                normalize(&element.name),
                normalize(&element.value),
                element.chrome,
            )
        })
        .collect();
    kept.retain(|line| {
        let text = normalize(&line.text);
        let (cx, cy) = line.bounds.center();
        !listed.iter().any(|(bounds, name, value, chrome)| {
            bounds.contains(cx, cy)
                && (*chrome
                    || (text.chars().count() >= 3
                        && (name.contains(&text)
                            || (value.contains(&text) && 2 * text.len() >= value.len()))))
        })
    });
    reading_order(kept)
}

/// Top to bottom, then left to right within a row. A line joins the current
/// row when its top is within half a line of the row's first line.
fn reading_order(mut lines: Vec<OcrText>) -> Vec<OcrText> {
    lines.sort_by(|left, right| left.bounds.y.total_cmp(&right.bounds.y));
    let mut ordered = Vec::with_capacity(lines.len());
    let mut row: Vec<OcrText> = Vec::new();
    for line in lines {
        if let Some(first) = row.first()
            && line.bounds.y - first.bounds.y > first.bounds.height.min(line.bounds.height) / 2.0
        {
            row.sort_by(|left, right| left.bounds.x.total_cmp(&right.bounds.x));
            ordered.append(&mut row);
        }
        row.push(line);
    }
    row.sort_by(|left, right| left.bounds.x.total_cmp(&right.bounds.x));
    ordered.append(&mut row);
    ordered
}

pub fn truncate(value: &str, limit: usize) -> String {
    let cleaned = value.replace(['\n', '\r'], " ");
    if cleaned.chars().count() <= limit {
        return cleaned;
    }
    cleaned.chars().take(limit).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(x: f64, y: f64, w: f64, h: f64) -> Bounds {
        Bounds::new(x, y, w, h)
    }

    #[test]
    fn elements_outside_the_clip_are_off_screen() {
        let window = Some(b(0.0, 0.0, 800.0, 600.0));
        assert!(!is_off_screen(
            Some(b(10.0, 10.0, 50.0, 20.0)),
            window,
            false,
            false,
            false
        ));
        // Partly visible still counts as on screen.
        assert!(!is_off_screen(
            Some(b(780.0, 590.0, 50.0, 20.0)),
            window,
            false,
            false,
            false
        ));
        assert!(is_off_screen(
            Some(b(10.0, 900.0, 50.0, 20.0)),
            window,
            false,
            false,
            false
        ));
        // Touching edges do not overlap.
        assert!(is_off_screen(
            Some(b(800.0, 0.0, 50.0, 20.0)),
            window,
            false,
            false,
            false
        ));
        // The platform's own flag wins even inside the clip.
        assert!(is_off_screen(
            Some(b(10.0, 10.0, 50.0, 20.0)),
            window,
            true,
            false,
            false
        ));
    }

    #[test]
    fn zero_size_and_exempt_elements_are_never_skipped() {
        let window = Some(b(0.0, 0.0, 800.0, 600.0));
        // Web content overflows zero-size wrappers.
        assert!(!is_off_screen(
            Some(b(5000.0, 5000.0, 0.0, 0.0)),
            window,
            true,
            false,
            false
        ));
        assert!(!is_off_screen(None, window, true, false, false));
        // Menus and dialogs float outside their parents.
        assert!(!is_off_screen(
            Some(b(900.0, 0.0, 200.0, 300.0)),
            window,
            true,
            true,
            false
        ));
        // A list row scrolled out of a classic list control has no rectangle.
        assert!(is_off_screen(
            Some(b(0.0, 0.0, 0.0, 0.0)),
            window,
            true,
            false,
            true
        ));
        assert!(!is_off_screen(
            Some(b(0.0, 0.0, 0.0, 0.0)),
            window,
            false,
            false,
            true
        ));
    }

    #[test]
    fn scroll_containers_narrow_the_clip() {
        let window = Some(b(0.0, 0.0, 800.0, 600.0));
        let list = narrow_clip(window, Some(b(100.0, 100.0, 300.0, 200.0)));
        assert_eq!(list, Some(b(100.0, 100.0, 300.0, 200.0)));
        // A row below the list's viewport is off screen though inside the window.
        assert!(is_off_screen(
            Some(b(100.0, 320.0, 300.0, 20.0)),
            list,
            false,
            false,
            false
        ));
        // A zero-size container does not collapse the clip.
        assert_eq!(narrow_clip(window, Some(b(5.0, 5.0, 0.0, 0.0))), window);
        assert_eq!(
            narrow_clip(None, Some(b(1.0, 2.0, 3.0, 4.0))),
            Some(b(1.0, 2.0, 3.0, 4.0))
        );
        // Disjoint rectangles intersect to nothing, which then overlaps nothing.
        let none = b(0.0, 0.0, 10.0, 10.0).intersect(&b(20.0, 20.0, 5.0, 5.0));
        assert!(!none.has_area());
    }

    #[test]
    fn the_offscreen_line_and_dialog_note_match_the_macos_wording() {
        assert_eq!(
            offscreen_line(42),
            "… 42 off-screen elements skipped; scroll, or pass offscreen=true to list them"
        );
        assert!(DIALOG_NOTE.starts_with("note: a dialog is open — only its controls are listed"));
    }

    #[test]
    fn freshness_compares_role_and_name_only() {
        let saved = Fingerprint {
            role: "Button".into(),
            name: "Save".into(),
        };
        assert!(check_fresh(3, &saved, Some(&saved.clone())).is_ok());

        let gone = check_fresh(3, &saved, None).unwrap_err().0;
        assert_eq!(
            gone,
            "e3 no longer exists — the app changed; call get_app_state again"
        );

        let renamed = Fingerprint {
            role: "Button".into(),
            name: "Save As".into(),
        };
        let changed = check_fresh(3, &saved, Some(&renamed)).unwrap_err().0;
        assert_eq!(
            changed,
            "e3 changed since get_app_state (was Button \"Save\", now Button \"Save As\"); call get_app_state again"
        );

        let retyped = Fingerprint {
            role: "MenuItem".into(),
            name: "Save".into(),
        };
        assert!(
            check_fresh(3, &saved, Some(&retyped))
                .unwrap_err()
                .0
                .contains("now MenuItem \"Save\"")
        );
    }

    #[test]
    fn ocr_modes_parse_with_auto_as_the_default() {
        assert_eq!(OcrMode::parse(None).unwrap(), OcrMode::Auto);
        assert_eq!(OcrMode::parse(Some("Always")).unwrap(), OcrMode::Always);
        assert_eq!(OcrMode::parse(Some("never")).unwrap(), OcrMode::Never);
        assert!(OcrMode::parse(Some("sometimes")).is_err());
    }

    fn line(text: &str, x: f64, y: f64, w: f64, h: f64) -> OcrText {
        OcrText {
            text: text.into(),
            bounds: b(x, y, w, h),
        }
    }

    #[test]
    fn overlapping_detections_merge_into_the_longer_reading() {
        let lines = vec![
            line("Get Luck", 100.0, 100.0, 80.0, 20.0),
            line("Get Lucky", 101.0, 101.0, 82.0, 20.0),
            line("Daft Punk", 100.0, 130.0, 80.0, 20.0),
        ];
        let kept = dedupe_ocr(lines, &[]);
        let texts: Vec<&str> = kept.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, ["Get Lucky", "Daft Punk"]);
        assert_eq!(kept[0].bounds, b(100.0, 100.0, 83.0, 21.0));
    }

    #[test]
    fn ocr_text_an_element_already_lists_is_dropped() {
        let listed = [
            Listed {
                bounds: b(0.0, 0.0, 200.0, 40.0),
                name: "Save document".into(),
                value: String::new(),
                chrome: false,
            },
            Listed {
                bounds: b(0.0, 100.0, 400.0, 300.0),
                name: String::new(),
                value: "first line\nsecond line\nthird line".into(),
                chrome: false,
            },
        ];
        let lines = vec![
            // Inside the button and contained in its name (OCR often truncates).
            line("Save", 10.0, 10.0, 40.0, 20.0),
            // Same words, but outside the button: kept.
            line("Save", 300.0, 10.0, 40.0, 20.0),
            // One line of a document whose value holds all of its text: kept.
            line("second line", 10.0, 150.0, 100.0, 20.0),
            // Too short to judge.
            line("OK", 20.0, 20.0, 20.0, 10.0),
        ];
        let kept = dedupe_ocr(lines, &listed);
        let texts: Vec<&str> = kept.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, ["Save", "OK", "second line"]);

        // A field whose whole value the OCR line covers is a duplicate.
        let field = [Listed {
            bounds: b(0.0, 0.0, 200.0, 30.0),
            name: String::new(),
            value: "hello world".into(),
            chrome: false,
        }];
        assert!(dedupe_ocr(vec![line("Hello, world", 5.0, 5.0, 100.0, 20.0)], &field).is_empty());

        // The close button's glyph on the title bar is chrome, however short.
        let title = [Listed {
            bounds: b(0.0, 0.0, 600.0, 30.0),
            name: "Player".into(),
            value: String::new(),
            chrome: true,
        }];
        let kept = dedupe_ocr(
            vec![
                line("x", 580.0, 8.0, 10.0, 12.0),
                line("Now playing", 10.0, 50.0, 90.0, 20.0),
            ],
            &title,
        );
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].text, "Now playing");
    }

    #[test]
    fn ocr_rows_read_top_to_bottom_then_left_to_right() {
        let kept = dedupe_ocr(
            vec![
                line("right", 200.0, 12.0, 40.0, 20.0),
                line("below", 0.0, 60.0, 40.0, 20.0),
                line("left", 0.0, 10.0, 40.0, 20.0),
            ],
            &[],
        );
        let texts: Vec<&str> = kept.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, ["left", "right", "below"]);
        assert_eq!(ocr_row(40, "Get Lucky"), "  [e40] Text \"Get Lucky\"");
        assert_eq!(
            ocr_id_error(40).0,
            "e40 is text read by OCR — click it, then use type_text"
        );
        assert_eq!(
            minimized_error(7).0,
            "e7 is in a minimized window — restore it, or use an action that works through accessibility"
        );
    }

    #[test]
    fn iou_is_zero_for_disjoint_boxes_and_one_for_equal_ones() {
        let a = b(0.0, 0.0, 10.0, 10.0);
        assert_eq!(a.iou(&a), 1.0);
        assert_eq!(a.iou(&b(20.0, 0.0, 10.0, 10.0)), 0.0);
        assert!((a.iou(&b(5.0, 0.0, 10.0, 10.0)) - 50.0 / 150.0).abs() < 1e-9);
    }
}
