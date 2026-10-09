import AppKit
import ApplicationServices

// MARK: - Batched attribute reads
//
// Every attribute read is a request the target app answers on its main thread,
// so reading eleven attributes one at a time costs eleven round trips per
// element. AXUIElementCopyMultipleAttributeValues answers them in one.

/// What the outline needs to know about one element, from a single request.
struct AXFacts {
    var role: String
    var subrole: String?
    var title: String?
    var description: String?
    var value: String?
    var enabled: Bool?
    var focused: Bool?
    var modal: Bool
    var frame: CGRect?
    var children: [AXUIElement]

    /// The text a person would call this element by.
    var label: String? { title ?? description ?? value }
}

let factAttributes: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXValueAttribute, kAXEnabledAttribute, kAXFocusedAttribute, "AXModal",
    kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
]

/// Read several attributes in one cross-process call. Missing attributes come
/// back as nil. Returns nil when the element is gone or the app refuses batch
/// reads, so the caller can fall back to single reads.
func axCopyMultiple(_ el: AXUIElement, _ names: [String]) -> [AnyObject?]? {
    var values: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(
        el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    guard err == .success, let array = values as [AnyObject]?, array.count == names.count else { return nil }
    return array.map { value in
        // An attribute the element does not have arrives as an AXValue holding an AXError.
        if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { return nil }
        if value is NSNull { return nil }
        return value
    }
}

private func stringValue(_ v: AnyObject?) -> String? {
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

private func pointValue(_ v: AnyObject?) -> CGPoint? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

private func sizeValue(_ v: AnyObject?) -> CGSize? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

func readFacts(_ el: AXUIElement) -> AXFacts {
    let v = axCopyMultiple(el, factAttributes)
        ?? factAttributes.map { axCopy(el, $0) }
    let frame: CGRect? =
        if let origin = pointValue(v[8]), let size = sizeValue(v[9]) {
            CGRect(origin: origin, size: size)
        } else {
            nil
        }
    return AXFacts(
        role: stringValue(v[0]) ?? "AXUnknown",
        subrole: stringValue(v[1]),
        title: stringValue(v[2]),
        description: stringValue(v[3]),
        value: stringValue(v[4]),
        enabled: (v[5] as? NSNumber)?.boolValue,
        focused: (v[6] as? NSNumber)?.boolValue,
        modal: (v[7] as? NSNumber)?.boolValue ?? false,
        frame: frame,
        children: (v[10] as? [AXUIElement]) ?? []
    )
}

// MARK: - Electron and Chromium

/// Chromium-based apps (Electron: Slack, VS Code, Discord, Spotify, Notion) build
/// their accessibility tree only for a client that asks for it, and drop it again
/// later, so it is asked for on every read. Apps that do not know the attribute
/// say so once and are not asked again.
enum FullTreeRequest {
    private static var unsupported: Set<pid_t> = []
    private static var acceptedAt: [pid_t: Date] = [:]
    /// A background Electron window took about five seconds to build its tree.
    static let buildTime: TimeInterval = 8

    /// Ask `pid` for its full tree. Returns true the first time it accepted.
    @discardableResult
    static func ask(_ pid: pid_t) -> Bool {
        guard !unsupported.contains(pid) else { return false }
        let app = AXUIElementCreateApplication(pid)
        let err = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if err == .attributeUnsupported {
            unsupported.insert(pid)
            return false
        }
        guard err == .success, acceptedAt[pid] == nil else { return false }
        acceptedAt[pid] = Date()
        return true
    }

    /// Whether `pid` was asked recently enough that its tree may still be building.
    static func mayStillBeBuilding(_ pid: pid_t) -> Bool {
        acceptedAt[pid].map { -$0.timeIntervalSinceNow < buildTime } ?? false
    }
}

// MARK: - Dialogs

/// Elements that block the rest of their window, and the window subroles of
/// app-wide dialogs and alerts.
let modalRoles: Set<String> = ["AXSheet", "AXDialog", "AXPopover"]
let dialogSubroles: Set<String> = ["AXDialog", "AXSystemDialog"]

func isModal(_ facts: AXFacts) -> Bool {
    modalRoles.contains(facts.role) || facts.modal
        || facts.subrole.map { dialogSubroles.contains($0) } == true
}

/// The windows a dialog leaves usable: an app-modal alert or a modal window
/// blocks every other window of the app, so only it is read. A dialog-like
/// window that is not modal (an inspector, an About box) only counts when it is
/// the window the user is in.
func blockingWindows(_ app: AXUIElement, _ windows: [AXUIElement]) -> [AXUIElement] {
    let focused = axElement(app, kAXFocusedWindowAttribute as String)
    return windows.filter { window in
        if axBool(window, "AXModal") == true { return true }
        guard let subrole = axString(window, kAXSubroleAttribute as String) else { return false }
        if subrole == "AXSystemDialog" { return true }
        return subrole == "AXDialog" && focused.map { CFEqual($0, window) } == true
    }
}

// MARK: - Outline walk

/// Lists, tables and outlines report which rows are on screen. Web areas answer
/// with an empty list, so an empty answer falls back to every child.
let listRoles: Set<String> = ["AXTable", "AXOutline", "AXList", "AXBrowser", "AXGrid"]
/// Descendants are clipped to these elements' bounds.
let clippingRoles: Set<String> = ["AXScrollArea", "AXWebArea"]
/// Never skipped as off-screen: popovers and menus can extend past their window.
let unclippedRoles: Set<String> = modalRoles.union(["AXMenu"])
/// Roles that count as the app's own controls when deciding whether to OCR.
let controlRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXLink",
    "AXMenuItem", "AXMenuButton", "AXSlider", "AXSegmentedControl", "AXDisclosureTriangle",
    "AXTextField", "AXTextArea", "AXSearchField", "AXIncrementor",
]
let textInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]
/// Title-bar buttons: part of the window, not of the app's content.
let windowControlSubroles: Set<String> = [
    "AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton",
]

/// One read of a window into outline lines. Every interactive element is
/// registered while walking; what gets printed is decided afterwards (a dialog
/// narrows it), so ids stay stable either way.
final class OutlineWalk {
    let maxDepth: Int
    /// Also walk what is scrolled out of view.
    let offscreen: Bool
    var budget: Int
    var lines: [String] = []
    /// Subtrees skipped because they are out of view, plus list rows not read.
    var skipped = 0
    /// Line ranges of dialogs, sheets and popovers found inside the window.
    var modalRanges: [Range<Int>] = []
    /// Enabled, labelled, actionable controls of the app itself. Zero means the
    /// app describes itself poorly, and its text is worth reading with OCR.
    var appControls = 0
    /// Labels and frames of listed elements, so OCR does not repeat them.
    var labelled: [(frame: CGRect, text: String)] = []
    /// The walk stopped at `maxDepth` somewhere, so a missing control may just
    /// be deeper than it looked.
    var depthLimited = false
    /// Web areas, whose pages post their notifications there and not on the app.
    var webAreas: [AXUIElement] = []

    init(maxDepth: Int, budget: Int, offscreen: Bool) {
        self.maxDepth = maxDepth
        self.budget = budget
        self.offscreen = offscreen
    }

    func walk(_ el: AXUIElement, depth: Int, clip: CGRect?) {
        guard budget > 0 else { return }
        guard depth <= maxDepth else {
            depthLimited = true
            return
        }
        let facts = readFacts(el)
        let role = facts.role

        // Out of view: skip it and everything inside. Zero-size elements are
        // kept, because web content overflows zero-size wrappers.
        if !offscreen, depth > 1, let frame = facts.frame, frame.width > 0, frame.height > 0,
           !unclippedRoles.contains(role), let clip, !frame.intersects(clip)
        {
            skipped += 1
            return
        }

        let actions = interactiveRoles.contains(role) ? [] : axActions(el).filter { $0 != "AXShowMenu" }
        let isInteractive = interactiveRoles.contains(role) || !actions.isEmpty
        let label = facts.label
        let modalStart = depth > 1 && isModal(facts) ? lines.count : nil

        // Emit a node only if it carries information: something actionable, or text.
        // Pure layout containers are traversed but not printed, which keeps the
        // outline small enough to be worth putting in a prompt.
        if isInteractive || label != nil {
            var parts = ["\(String(repeating: "  ", count: depth))"]
            if isInteractive {
                parts.append("[\(Registry.add(el, facts))] ")
            } else {
                parts.append("     ")
            }
            parts.append(role.replacingOccurrences(of: "AX", with: ""))
            if let l = label { parts.append(" \"\(truncate(l, 120))\"") }
            // Show the current contents whenever they are not already the label.
            // Fields commonly label themselves with AXDescription ("Address and
            // search bar") and keep the typed text in AXValue, so gating this on
            // AXTitle hid what the field actually contains.
            if let v = facts.value, v != label {
                parts.append(" value=\"\(truncate(v, 80))\"")
            }
            if facts.enabled == false { parts.append(" (disabled)") }
            if facts.focused == true { parts.append(" (focused)") }
            lines.append(parts.joined())
            budget -= 1
            if let frame = facts.frame, let label { labelled.append((frame, label)) }
        }
        if controlRoles.contains(role), facts.enabled != false,
           !(facts.subrole.map { windowControlSubroles.contains($0) } ?? false),
           textInputRoles.contains(role) || (label != nil && (isInteractive || !actions.isEmpty))
        {
            appControls += 1
        }
        if role == "AXWebArea" { webAreas.append(el) }

        var childClip = clip
        if depth == 1 || clippingRoles.contains(role), let frame = facts.frame, frame.width > 0, frame.height > 0 {
            childClip = clip.map { $0.intersection(frame) } ?? frame
            if childClip?.isNull == true { childClip = .zero }
        }
        if unclippedRoles.contains(role) { childClip = nil }

        for child in children(el, facts) {
            walk(child, depth: depth + 1, clip: childClip)
        }
        if let modalStart { modalRanges.append(modalStart..<lines.count) }
    }

    /// The children to follow: a list's header and on-screen rows instead of
    /// every row it holds (columns repeat the rows' cells and are skipped).
    private func children(_ el: AXUIElement, _ facts: AXFacts) -> [AXUIElement] {
        guard !offscreen, listRoles.contains(facts.role),
              let v = axCopyMultiple(el, ["AXVisibleRows", "AXVisibleChildren", "AXHeader"])
        else { return facts.children }
        var count: CFIndex = 0
        if let rows = v[0] as? [AXUIElement], !rows.isEmpty {
            if AXUIElementGetAttributeValueCount(el, kAXRowsAttribute as CFString, &count) == .success {
                skipped += max(0, count - rows.count)
            }
            let header = v[2].flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
            return (header.map { [$0] } ?? []) + rows
        }
        if let visible = v[1] as? [AXUIElement], !visible.isEmpty {
            skipped += max(0, facts.children.count - visible.count)
            return visible
        }
        return facts.children
    }

    /// Lines to print for the window read from `start`: only its dialogs when
    /// one is open.
    func narrowToDialogs(from start: Int) -> Bool {
        let ranges = modalRanges.filter { $0.lowerBound >= start && !$0.isEmpty }
        guard !ranges.isEmpty else { return false }
        var keep = IndexSet()
        for range in ranges { keep.insert(integersIn: range) }
        lines = Array(lines[..<start]) + keep.sorted().map { lines[$0] }
        return true
    }
}
