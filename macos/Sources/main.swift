import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ScreenCaptureKit

// Swift 6: Result's Failure must be Error. Keep stringly failures for MCP replies.
extension String: @retroactive Error {}

// munim-computer-use — a macOS munim-computer-use MCP server built on the Accessibility API.
//
// Design notes:
//  * Speaks newline-delimited JSON-RPC over stdio (MCP stdio transport).
//  * Uses AXUIElement directly, never AppleScript/System Events. AppleScript would
//    require a per-target-app kTCCServiceAppleEvents grant that macOS frequently
//    refuses to prompt for; AX needs only Accessibility.
//  * Ships as a bare executable so it runs as a child of the host app and inherits
//    the host's TCC grants. A separate .app bundle would get its own TCC identity
//    and require its own permissions. The agent-cursor overlay is the exception:
//    it is a minimal LSUIElement .app (no Accessibility needed) launched via
//    NSWorkspace — a bare Process child never gets a real window.

// MARK: - AX helpers

/// Host settings pass `COMPUTER_USE_AGENT_CURSOR=0` / `COMPUTER_USE_BROWSER=0` when
/// the matching Computer Use toggle is off. Missing or empty means enabled.
/// `name` is the tunable without its prefix (`BROWSER`); an embedder's
/// `envPrefix` is read first (see Identity.swift).
func envFlagDisabled(_ name: String) -> Bool {
    guard let raw = Identity.current.tunable(name)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased(),
        !raw.isEmpty
    else {
        return false
    }
    return raw == "0" || raw == "false" || raw == "off" || raw == "no"
}

/// The opt-in counterpart of `envFlagDisabled`, for tunables that are off
/// unless the host asks for them.
func envFlagEnabled(_ name: String) -> Bool {
    guard let raw = Identity.current.tunable(name)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased(),
        !raw.isEmpty
    else {
        return false
    }
    return raw == "1" || raw == "true" || raw == "on" || raw == "yes"
}

/// Remote control drives the real pointer, so the agent's overlay cursor would
/// be a second pointer chasing the first one.
var agentCursorEnabled: Bool { !envFlagDisabled("AGENT_CURSOR") && !RemoteControl.isEnabled }
var browserControlEnabled: Bool { !envFlagDisabled("BROWSER") }

func axCopy(_ el: AXUIElement, _ attr: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, attr as CFString, &value) == .success ? value : nil
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    guard let v = axCopy(el, attr) else { return nil }
    if let s = v as? String { return s.isEmpty ? nil : s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
    (axCopy(el, attr) as? NSNumber)?.boolValue
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    (axCopy(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func axActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

func axPoint(_ el: AXUIElement, _ attr: String) -> CGPoint? {
    guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
}

func axSize(_ el: AXUIElement, _ attr: String) -> CGSize? {
    guard let v = axCopy(el, attr), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
}

/// Read an attribute that should hold another element, checking the type first.
/// A blind `as!` here would crash on any app that returns something unexpected.
func axElement(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
    guard let v = axCopy(el, attr), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func elementCenter(_ el: AXUIElement) -> CGPoint? {
    guard let p = axPoint(el, kAXPositionAttribute as String),
          let s = axSize(el, kAXSizeAttribute as String) else { return nil }
    return CGPoint(x: p.x + s.width / 2, y: p.y + s.height / 2)
}

// MARK: - Element registry
//
// Snapshots hand out short ids ("e12") that later calls reference, so the model
// clicks a named element instead of guessing pixel coordinates.

final class Registry {
    static var map: [String: AXUIElement] = [:]
    static var counter = 0
    /// App most recently inspected. Subsequent input is delivered to this
    /// process by default, so interaction stays in the background.
    static var targetPid: pid_t?

    static func reset() {
        map.removeAll()
        counter = 0
        targetPid = nil
    }

    static func add(_ el: AXUIElement) -> String {
        counter += 1
        let id = "e\(counter)"
        map[id] = el
        return id
    }

    static func get(_ id: String) -> AXUIElement? { map[id] }
}

// MARK: - App resolution

struct ResolvedApp {
    let app: NSRunningApplication
    let note: String?
}

/// Resolve an app by name, bundle id, or pid.
///
/// A single bundle id can have several running instances — Chrome routinely does.
/// Only some of them own windows, so prefer an instance that actually has one;
/// picking blindly is what makes System Events report "Invalid index".
func resolveApp(_ query: String) -> ResolvedApp? {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let running = NSWorkspace.shared.runningApplications
    let lowered = trimmed.lowercased()

    var matches: [NSRunningApplication]
    if let pid = Int32(trimmed), running.contains(where: { $0.processIdentifier == pid }) {
        matches = running.filter { $0.processIdentifier == pid }
    } else if Int32(trimmed) != nil {
        // Numeric query that is not a live PID (e.g. app name "2048"): exact name
        // only — never substring, or short pids like "1" bind unrelated apps.
        matches = running.filter { ($0.localizedName ?? "").lowercased() == lowered }
    } else {
        matches = running.filter { $0.bundleIdentifier?.lowercased() == lowered }
        if matches.isEmpty {
            matches = running.filter { ($0.localizedName ?? "").lowercased() == lowered }
        }
        if matches.isEmpty {
            matches = running.filter { ($0.localizedName ?? "").lowercased().contains(lowered) }
        }
    }
    guard !matches.isEmpty else { return nil }
    if matches.count == 1 { return ResolvedApp(app: matches[0], note: nil) }

    // Count windows only. An app element always has children (the menu bar, at
    // minimum), so testing children here would happily select a windowless instance.
    func windowCount(_ instance: NSRunningApplication) -> Int {
        let ax = AXUIElementCreateApplication(instance.processIdentifier)
        return ((axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []).count
    }

    // Prefer frontmost among instances that own windows, so the choice matches
    // what the user is actually looking at.
    let withWindows = matches.filter { windowCount($0) > 0 }
    let chosen = withWindows.first(where: { $0.isActive }) ?? withWindows.first ?? matches.first!
    let n = windowCount(chosen)
    let note = "\(matches.count) running instances of \(query); selected pid \(chosen.processIdentifier) "
        + (n > 0 ? "(\(n) window\(n == 1 ? "" : "s"))" : "(no instance has windows)")
    return ResolvedApp(app: chosen, note: note)
}

// MARK: - Tree walking

let interactiveRoles: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuItem", "AXMenuButton", "AXLink", "AXComboBox",
    "AXSlider", "AXDisclosureTriangle", "AXSegmentedControl", "AXSearchField",
    "AXTabGroup", "AXIncrementor", "AXColorWell", "AXCell",
]

func truncate(_ s: String, _ n: Int) -> String {
    let flat = s.replacingOccurrences(of: "\n", with: " ")
    return flat.count <= n ? flat : String(flat.prefix(n)) + "…"
}

func walk(_ el: AXUIElement, depth: Int, lines: inout [String], budget: inout Int, maxDepth: Int) {
    guard budget > 0, depth <= maxDepth else { return }

    let role = axString(el, kAXRoleAttribute as String) ?? "AXUnknown"
    let title = axString(el, kAXTitleAttribute as String)
    let desc = axString(el, kAXDescriptionAttribute as String)
    let value = axString(el, kAXValueAttribute as String)
    let actions = axActions(el).filter { $0 != "AXShowMenu" }
    let isInteractive = interactiveRoles.contains(role) || !actions.isEmpty
    let label = title ?? desc ?? value

    // Emit a node only if it carries information: something actionable, or text.
    // Pure layout containers are traversed but not printed, which keeps the
    // outline small enough to be worth putting in a prompt.
    if isInteractive || label != nil {
        var parts = ["\(String(repeating: "  ", count: depth))"]
        if isInteractive {
            parts.append("[\(Registry.add(el))] ")
        } else {
            parts.append("     ")
        }
        parts.append(role.replacingOccurrences(of: "AX", with: ""))
        if let l = label { parts.append(" \"\(truncate(l, 120))\"") }
        // Show the current contents whenever they are not already the label.
        // Fields commonly label themselves with AXDescription ("Address and
        // search bar") and keep the typed text in AXValue, so gating this on
        // AXTitle hid what the field actually contains.
        if let v = value, v != label {
            parts.append(" value=\"\(truncate(v, 80))\"")
        }
        if axBool(el, kAXEnabledAttribute as String) == false { parts.append(" (disabled)") }
        if axBool(el, kAXFocusedAttribute as String) == true { parts.append(" (focused)") }
        lines.append(parts.joined())
        budget -= 1
    }

    for child in axChildren(el) {
        walk(child, depth: depth + 1, lines: &lines, budget: &budget, maxDepth: maxDepth)
    }
}

// MARK: - Input synthesis

// MOUSE_TARGETING
//
// Coordinate mouse events reach a background window through SkyLight, so the
// agent can click in one app while the user works in another and the physical
// cursor never moves. Three things are all required — miss any one and the event
// is silently dropped:
//
//   1. Window addressing. The event carries the target window id in fields
//      51/91/92 plus window-local coordinates via CGEventSetWindowLocation.
//   2. SLEventSetIntegerValueField, NOT CGEvent.setIntegerValueField. The public
//      setter takes a CGEventField enum and CGEventField(rawValue:) returns nil
//      for the undocumented fields (51/58/91/92), so those stamps vanish.
//   3. activate_without_raise. A background window will not accept routed input
//      until its AppKit-active state is flipped, which is done without raising
//      the window or switching Spaces.
//
// Delivery goes through both SLEventPostToPid (reaches Chromium/Catalyst, which
// ignore the public path because it skips the activity-monitor tickle) and
// CGEvent.postToPid (lands on AppKit targets where the SkyLight path drops).
//
// Ported from trycua/cua's cua-driver, which in turn takes focus-without-raise
// from yabai. These are private SPIs resolved by dlsym: if any fail to resolve
// we fall back to the global HID tap, which works but moves the user's cursor.
//
// Summary:
//   * type_text / press_key      -> postToPid, background-safe
//   * click by element_id        -> AXPress, background-safe, no cursor movement
//   * click/drag by coordinates  -> SkyLight background path, cursor stays put
//   * any of the above, degraded -> global HID tap, takes over the pointer

/// Deliver an event to one process.
///
/// Every synthetic event this server makes is addressed to a specific pid.
/// Nothing is ever posted to the global HID or session event tap and the real
/// cursor is never warped, so the user keeps their own mouse and keyboard — and
/// can go on clicking and typing elsewhere — while the agent works. When no
/// target process is known, callers refuse instead of falling back to a global
/// takeover.
func post(_ event: CGEvent?, to pid: pid_t) {
    event?.postToPid(pid)
}

/// Source for every synthetic event. A private state keeps the user's own held
/// modifiers and buttons out of the agent's events (a combined-session source
/// would turn the agent's click into a cmd-click while the user holds cmd).
func agentEventSource() -> CGEventSource? {
    CGEventSource(stateID: .privateState)
}

/// Why an action was refused rather than taking over the user's pointer.
func refuseGlobalInput(_ action: String, _ hint: String) -> String {
    "error: cannot \(action) without taking over the user's mouse pointer, which this server never "
        + "does — the user may be working at the same time. \(hint)"
}

func pidOf(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(element, &pid) == .success ? pid : nil
}

// MARK: - SkyLight background input

/// Private SPIs behind background mouse delivery. All optional: when a symbol
/// stops resolving on a future macOS the caller degrades to the global HID tap
/// rather than failing.
enum SkyLight {
    typealias PostToPidFn = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Void
    typealias SetIntFieldFn = @convention(c) (UnsafeMutableRawPointer, UInt32, Int64) -> Void
    typealias SetWindowLocFn = @convention(c) (UnsafeMutableRawPointer, CGPoint) -> Void
    typealias PostEventRecordFn = @convention(c) (UnsafeMutableRawPointer, UnsafeMutablePointer<UInt8>) -> Int32
    typealias GetFrontProcessFn = @convention(c) (UnsafeMutableRawPointer) -> Int32
    typealias GetProcessForPIDFn = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> OSStatus
    typealias AXGetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<UInt32>) -> AXError

    static let skyHandle = dlopen(
        "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/SkyLight", RTLD_LAZY)
    static let appServices = dlopen(
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)

    static let postToPid: PostToPidFn? = load("SLEventPostToPid", skyHandle)
    static let setIntField: SetIntFieldFn? = load("SLEventSetIntegerValueField", skyHandle)
    static let setWindowLocation: SetWindowLocFn? = load("CGEventSetWindowLocation", skyHandle)
        ?? load("CGEventSetWindowLocation", dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY))
    static let postEventRecord: PostEventRecordFn? = load("SLPSPostEventRecordTo", skyHandle)
    static let getFrontProcess: GetFrontProcessFn? = load("_SLPSGetFrontProcess", skyHandle)
    static let getProcessForPID: GetProcessForPIDFn? = load("GetProcessForPID", appServices)
    static let axGetWindow: AXGetWindowFn? = load("_AXUIElementGetWindow", appServices)

    static func load<T>(_ name: String, _ handle: UnsafeMutableRawPointer?) -> T? {
        guard let handle, let sym = dlsym(handle, name) else { return nil }
        return unsafeBitCast(sym, to: T.self)
    }

    static var available: Bool {
        // setWindowLocation is required: without window-local coordinates,
        // background mouse events are delivered but never hit-test, so callers
        // would report success while clicks/scrolls do nothing.
        postToPid != nil && setIntField != nil && setWindowLocation != nil
            && postEventRecord != nil && getFrontProcess != nil
            && getProcessForPID != nil && axGetWindow != nil
    }

    static func windowID(_ window: AXUIElement) -> UInt32? {
        guard let fn = axGetWindow else { return nil }
        var wid: UInt32 = 0
        return fn(window, &wid) == .success ? wid : nil
    }

    /// Make the target window able to accept routed input without raising it or
    /// switching Spaces. Deliberately skips SLPSSetFrontProcessWithOptions —
    /// omitting it keeps Chromium's user-activation gate open.
    @discardableResult
    static func activateWithoutRaise(pid: pid_t, wid: UInt32) -> Bool {
        guard let post = postEventRecord, let front = getFrontProcess, let forPID = getProcessForPID
        else { return false }

        // PSNs are 8 raw bytes here, not the Swift struct's layout guarantees.
        var previous = [UInt8](repeating: 0, count: 8)
        var target = [UInt8](repeating: 0, count: 8)
        let gotPrevious = previous.withUnsafeMutableBufferPointer {
            front(UnsafeMutableRawPointer($0.baseAddress!)) == 0
        }
        guard gotPrevious else { return false }

        var psn = ProcessSerialNumber()
        guard forPID(pid, &psn) == 0 else { return false }
        withUnsafeBytes(of: &psn) { raw in for i in 0..<8 { target[i] = raw[i] } }

        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        record[0x3C] = UInt8(wid & 0xFF)
        record[0x3D] = UInt8((wid >> 8) & 0xFF)
        record[0x3E] = UInt8((wid >> 16) & 0xFF)
        record[0x3F] = UInt8((wid >> 24) & 0xFF)

        record[0x8A] = 0x02  // defocus the outgoing front process
        let defocused = previous.withUnsafeMutableBufferPointer { p in
            record.withUnsafeMutableBufferPointer { r in
                post(UnsafeMutableRawPointer(p.baseAddress!), r.baseAddress!) == 0
            }
        }
        record[0x8A] = 0x01  // focus the target
        let focused = target.withUnsafeMutableBufferPointer { p in
            record.withUnsafeMutableBufferPointer { r in
                post(UnsafeMutableRawPointer(p.baseAddress!), r.baseAddress!) == 0
            }
        }
        return defocused && focused
    }

    /// Stamp the window-routing fields and deliver down both paths.
    static func postMouse(
        _ event: CGEvent, pid: pid_t, wid: UInt32, windowOrigin: CGPoint,
        screen: CGPoint, clickState: Int64, button: Int64, subtype: Int64, groupID: Int64
    ) {
        guard let post = postToPid, let setField = setIntField, let setWindowLocation else { return }
        let ptr = Unmanaged.passUnretained(event).toOpaque()
        setWindowLocation(ptr, CGPoint(x: screen.x - windowOrigin.x, y: screen.y - windowOrigin.y))
        let w = Int64(wid)
        setField(ptr, 1, clickState)   // click state
        setField(ptr, 3, button)       // button number
        setField(ptr, 7, subtype)      // subtype: 3 touch for clicks, 0 for drags
        setField(ptr, 51, w)           // window number
        setField(ptr, 58, groupID)     // click-group id, coalesces the gesture
        setField(ptr, 91, w)           // window under mouse pointer
        setField(ptr, 92, w)           // ...that can handle this event
        setField(ptr, 40, Int64(pid))  // target pid (Chromium synthetic filter)
        post(pid, ptr)
        event.postToPid(pid)
    }
}

/// A window that background mouse events can be addressed to.
struct WindowTarget {
    let pid: pid_t
    let wid: UInt32
    let frame: CGRect
    var origin: CGPoint { frame.origin }
}

func makeWindowTarget(pid: pid_t, window: AXUIElement) -> WindowTarget? {
    guard let wid = SkyLight.windowID(window) else { return nil }
    guard let origin = axPoint(window, kAXPositionAttribute as String) else { return nil }
    guard let size = axSize(window, kAXSizeAttribute as String),
          size.width > 0, size.height > 0
    else { return nil }
    return WindowTarget(pid: pid, wid: wid, frame: CGRect(origin: origin, size: size))
}

func windowTarget(for element: AXUIElement) -> WindowTarget? {
    guard let pid = pidOf(element) else { return nil }
    let window = axElement(element, kAXWindowAttribute as String)
        ?? (axCopy(AXUIElementCreateApplication(pid), kAXWindowsAttribute as String) as? [AXUIElement])?.first
    guard let window else { return nil }
    return makeWindowTarget(pid: pid, window: window)
}

/// The frontmost on-screen window containing `point`.
///
/// `CGWindowListCopyWindowInfo` returns windows front to back, so the first
/// hit is the one a person clicking there would reach.
func windowTarget(under point: CGPoint) -> WindowTarget? {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for window in windows {
        // These arrive as NSNumber, which does not bridge straight to pid_t or
        // UInt32 — casting directly returns nil and the lookup silently fails.
        guard let bounds = window[kCGWindowBounds as String] as? [String: Any],
            let pidValue = window[kCGWindowOwnerPID as String] as? NSNumber,
            let numberValue = window[kCGWindowNumber as String] as? NSNumber,
            let x = (bounds["X"] as? NSNumber)?.doubleValue,
            let y = (bounds["Y"] as? NSNumber)?.doubleValue,
            let width = (bounds["Width"] as? NSNumber)?.doubleValue,
            let height = (bounds["Height"] as? NSNumber)?.doubleValue
        else { continue }
        let pid = pid_t(pidValue.int32Value)
        let number = numberValue.uint32Value
        // Skip this process and the separate agent-cursor overlay, which sits
        // above the click point by design and would steal hit-testing.
        if pid == getpid() { continue }
        let overlayName = Identity.current.agentCursorName
        if let owner = window[kCGWindowOwnerName as String] as? String,
           owner == overlayName || owner.hasPrefix(overlayName)
        {
            continue
        }
        if let app = NSRunningApplication(processIdentifier: pid),
           app.bundleIdentifier == Identity.current.agentCursorBundleId
        {
            continue
        }
        if CGRect(x: x, y: y, width: width, height: height).contains(point) {
            return WindowTarget(
                pid: pid,
                wid: number,
                frame: CGRect(x: x, y: y, width: width, height: height)
            )
        }
    }
    return nil
}

func windowTarget(forPid pid: pid_t, containing point: CGPoint? = nil) -> WindowTarget? {
    let windows = (axCopy(AXUIElementCreateApplication(pid), kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    if let point {
        for window in windows {
            guard let target = makeWindowTarget(pid: pid, window: window) else { continue }
            if target.frame.contains(point) {
                return target
            }
        }
    }
    guard let window = windows.first else { return nil }
    return makeWindowTarget(pid: pid, window: window)
}

/// Whether an element lives inside rendered web content.
///
/// Chromium exposes AXPress on web elements and returns success without doing
/// anything, so callers need to know when to bypass it and click for real.
func isInWebContent(_ element: AXUIElement) -> Bool {
    var node: AXUIElement? = element
    while let current = node {
        if let role = axString(current, kAXRoleAttribute as String),
           role == "AXWebArea" { return true }
        node = axElement(current, kAXParentAttribute as String)
    }
    return false
}

/// Centre of the part of an element that is actually on screen.
///
/// A scrollable element reports its *content* frame, which can be far taller
/// than the window showing it — the raw centre of a long document's text area
/// lands below the window entirely, and the click misses. Clipping to the
/// window keeps the point somewhere clickable.
func visibleCenter(of element: AXUIElement) -> CGPoint? {
    guard let position = axPoint(element, kAXPositionAttribute as String),
          let size = axSize(element, kAXSizeAttribute as String) else { return nil }
    let elementRect = CGRect(origin: position, size: size)
    guard let target = windowTarget(for: element), !target.frame.isEmpty else {
        return CGPoint(x: elementRect.midX, y: elementRect.midY)
    }
    let visible = elementRect.intersection(target.frame)
    // Entirely off-window (scrolled away / off-screen) — no clickable target.
    guard !visible.isNull, !visible.isEmpty else { return nil }
    return CGPoint(x: visible.midX, y: visible.midY)
}

var clickGroupCounter: Int64 = 0x4000

/// Background click. Returns false if the SkyLight path is unavailable, so the
/// caller can fall back to the cursor-moving global tap.
func backgroundClick(_ target: WindowTarget, at point: CGPoint, clickCount: Int) -> Bool {
    guard SkyLight.available else { return false }
    CursorOverlay.shared.press(at: point)
    guard SkyLight.activateWithoutRaise(pid: target.pid, wid: target.wid) else { return false }
    usleep(80_000)

    clickGroupCounter += 1
    let group = clickGroupCounter
    let src = agentEventSource()

    // A background window has stale cursor-tracking state, so a bare mouseDown
    // hit-tests "outside" the control and never fires.
    if let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        SkyLight.postMouse(move, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: 0, button: 0, subtype: 3, groupID: group)
    }
    usleep(12_000)
    var delivered = false
    guard clickCount > 0 else { return false }
    for i in 1...clickCount {
        if let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left) {
            SkyLight.postMouse(down, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                               screen: point, clickState: Int64(i), button: 0, subtype: 3, groupID: group)
            delivered = true
        }
        usleep(28_000)
        if let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) {
            SkyLight.postMouse(up, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                               screen: point, clickState: Int64(i), button: 0, subtype: 3, groupID: group)
            delivered = true
        }
        if i < clickCount { usleep(80_000) }
    }
    return delivered
}

func backgroundScroll(_ target: WindowTarget, at point: CGPoint, dx: Int32, dy: Int32, steps: Int) -> Bool {
    guard SkyLight.available, let post = SkyLight.postToPid, let setField = SkyLight.setIntField,
          let setWindowLocation = SkyLight.setWindowLocation
    else { return false }
    CursorOverlay.shared.show(at: point)
    guard SkyLight.activateWithoutRaise(pid: target.pid, wid: target.wid) else { return false }
    usleep(80_000)
    clickGroupCounter += 1
    let group = clickGroupCounter

    // Prime the window's hit-test location. A background window keeps a stale
    // one, and the wheel then lands on nothing even though it is delivered.
    if let move = CGEvent(mouseEventSource: agentEventSource(),
                          mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        SkyLight.postMouse(move, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: 0, button: 0, subtype: 3, groupID: group)
    }
    usleep(12_000)

    let local = CGPoint(x: point.x - target.origin.x, y: point.y - target.origin.y)
    var delivered = 0
    for _ in 0..<max(1, steps) {
        guard let wheel = CGEvent(scrollWheelEvent2Source: agentEventSource(),
                                  units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
        else { continue }
        // Scroll events are created at (0, 0) and the receiver hit-tests the
        // wheel against the event location, so it must be anchored at the
        // target. Missing this is why a delivered scroll appears to do nothing.
        wheel.location = point

        let ptr = Unmanaged.passUnretained(wheel).toOpaque()
        setWindowLocation(ptr, local)
        let w = Int64(target.wid)
        setField(ptr, 51, w)
        setField(ptr, 91, w)
        setField(ptr, 92, w)
        setField(ptr, 40, Int64(target.pid))
        post(target.pid, ptr)
        wheel.postToPid(target.pid)
        delivered += 1
        usleep(30_000)
    }
    return delivered > 0
}

func backgroundRightClick(_ target: WindowTarget, at point: CGPoint) -> Bool {
    guard SkyLight.available else { return false }
    CursorOverlay.shared.press(at: point)
    guard SkyLight.activateWithoutRaise(pid: target.pid, wid: target.wid) else { return false }
    usleep(80_000)
    clickGroupCounter += 1
    let group = clickGroupCounter
    let src = agentEventSource()
    // Prime hit-testing the same way left-click and scroll do; a bare
    // rightMouseDown against a background window often lands outside the control.
    if let moved = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        SkyLight.postMouse(moved, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: 0, button: 0, subtype: 3, groupID: group)
    }
    usleep(12_000)
    var delivered = false
    if let down = CGEvent(mouseEventSource: src, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right) {
        SkyLight.postMouse(down, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: 1, button: 1, subtype: 3, groupID: group)
        delivered = true
    }
    usleep(28_000)
    if let up = CGEvent(mouseEventSource: src, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) {
        SkyLight.postMouse(up, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: 1, button: 1, subtype: 3, groupID: group)
        delivered = true
    }
    return delivered
}

func backgroundDrag(_ target: WindowTarget, from start: CGPoint, to end: CGPoint) -> Bool {
    guard SkyLight.available else { return false }
    // SkyLight posts are addressed to one window. A mouseUp aimed at another
    // window (or the desktop) would still be delivered to `target`, so refuse
    // cross-window background drags instead of mis-routing the release.
    if !target.frame.contains(end) {
        guard let dest = windowTarget(under: end), dest.wid == target.wid, dest.pid == target.pid else {
            return false
        }
    }
    CursorOverlay.shared.press(at: start)
    guard SkyLight.activateWithoutRaise(pid: target.pid, wid: target.wid) else { return false }
    usleep(80_000)
    clickGroupCounter += 1
    let group = clickGroupCounter
    let src = agentEventSource()
    var delivered = false

    func send(_ type: CGEventType, _ point: CGPoint, _ clickState: Int64, _ subtype: Int64) {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: point, mouseButton: .left)
        else { return }
        SkyLight.postMouse(e, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                           screen: point, clickState: clickState, button: 0, subtype: subtype, groupID: group)
        delivered = true
    }

    send(.mouseMoved, start, 0, 3)
    usleep(12_000)
    send(.leftMouseDown, start, 1, 3)
    usleep(28_000)
    // Drags carry the normal subtype rather than touch.
    let steps = 24
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let step = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        send(.leftMouseDragged, step, 1, 0)
        if i % 4 == 0 { CursorOverlay.shared.glide(at: step) }
        usleep(15_000)
    }
    usleep(40_000)
    send(.leftMouseUp, end, 1, 3)
    CursorOverlay.shared.press(at: end)
    return delivered
}

/// Plain per-process click, for when SkyLight window routing is unavailable.
/// The app hit-tests the event's screen location itself; the cursor stays put.
func postClick(at point: CGPoint, clickCount: Int = 1, pid: pid_t) {
    CursorOverlay.shared.press(at: point)
    let src = agentEventSource()
    for i in 1...clickCount {
        let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
        let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        post(down, to: pid)
        post(up, to: pid)
        if i < clickCount { usleep(80_000) }
    }
}

/// Build the keystrokes for `text` and hand each one to `deliver`, which
/// decides where it goes: a single process (the agent) or the global HID tap
/// (remote control).
func synthesizeTypedText(_ text: String, deliver: (CGEvent?) -> Void) {
    let src = agentEventSource()
    // Send in small UTF-16 chunks: keyboardSetUnicodeString has a length cap,
    // and per-chunk events keep long strings from being dropped.
    for chunk in Array(text).chunked(into: 16) {
        var utf16 = Array(String(chunk).utf16)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        deliver(down)
        deliver(up)
        usleep(8_000)
    }
}

func typeText(_ text: String, pid: pid_t) {
    synthesizeTypedText(text) { post($0, to: pid) }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

// MARK: - Key names
//
// The same names are accepted on every platform (see keys.rs in the Rust
// server). Named keys map to fixed virtual key codes; characters resolve
// through the user's current keyboard layout so that "z" on a German layout,
// or "/" on AZERTY, presses the key that actually produces it. The ANSI table
// is the fallback when the layout cannot be read.

/// Fixed-position keys: their codes do not depend on the layout.
let namedKeyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "spacebar": 49,
    // "delete" is the Mac key of that name, which deletes backwards.
    "delete": 51, "backspace": 51, "del": 51,
    "forwarddelete": 117, "fwddelete": 117, "deleteforward": 117,
    "escape": 53, "esc": 53,
    "left": 123, "leftarrow": 123, "arrowleft": 123,
    "right": 124, "rightarrow": 124, "arrowright": 124,
    "down": 125, "downarrow": 125, "arrowdown": 125,
    "up": 126, "uparrow": 126, "arrowup": 126,
    "home": 115, "end": 119, "pageup": 116, "pgup": 116, "pagedown": 121, "pgdn": 121, "pgdown": 121,
    // Insert shares the Help key's code on Mac keyboards.
    "insert": 114, "ins": 114, "help": 114,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
    "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90,
]

/// Keypad keys, looked up after stripping a numpad/keypad/kp prefix.
let numpadKeyCodes: [String: CGKeyCode] = [
    "0": 82, "1": 83, "2": 84, "3": 85, "4": 86, "5": 87, "6": 88, "7": 89, "8": 91, "9": 92,
    "add": 69, "plus": 69, "+": 69,
    "subtract": 78, "minus": 78, "-": 78, "": 78,
    "multiply": 67, "times": 67, "*": 67,
    "divide": 75, "/": 75,
    "decimal": 65, "period": 65, "dot": 65, ".": 65,
    "enter": 76, "return": 76,
    "equal": 81, "equals": 81, "=": 81,
]

/// Spelled-out punctuation, for models that avoid sending bare symbols.
let punctuationNames: [String: Character] = [
    "minus": "-", "hyphen": "-", "dash": "-", "equal": "=", "equals": "=", "plus": "+",
    "leftbracket": "[", "bracketleft": "[", "openbracket": "[",
    "rightbracket": "]", "bracketright": "]", "closebracket": "]",
    "backslash": "\\", "semicolon": ";", "quote": "'", "apostrophe": "'", "singlequote": "'",
    "comma": ",", "period": ".", "dot": ".", "fullstop": ".", "slash": "/", "forwardslash": "/",
    "grave": "`", "backtick": "`", "backquote": "`",
]

/// US ANSI positions, used when the current layout cannot be read.
let ansiKeyCodes: [Character: CGKeyCode] = [
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38,
    "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1,
    "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
    "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39, ",": 43, ".": 47,
    "/": 44, "`": 50,
]

enum KeySpec: Equatable {
    case code(CGKeyCode)
    case character(Character)
}

/// Parse a press_key name. nil means the name is not recognised.
func parseKeyName(_ raw: String) -> KeySpec? {
    if raw.count == 1, let only = raw.first {
        switch only {
        case " ": return .code(49)
        case "\n", "\r": return .code(36)
        case "\t": return .code(48)
        default: return .character(only)
        }
    }
    // Case-insensitive, and "Page_Down" / "page down" / "page-down" all match.
    let compact = raw.trimmingCharacters(in: .whitespaces).lowercased()
        .filter { $0 != "_" && $0 != " " }
    for prefix in ["numpad", "keypad", "kp"] where compact.hasPrefix(prefix) {
        var rest = String(compact.dropFirst(prefix.count))
        while rest.hasPrefix("-") && rest.count > 1 { rest.removeFirst() }
        if rest == "-" { rest = "" }
        return numpadKeyCodes[rest].map { .code($0) }
    }
    let name = compact.filter { $0 != "-" }
    if let code = namedKeyCodes[name] { return .code(code) }
    if let character = punctuationNames[name] { return .character(character) }
    return nil
}

/// Map every character the current keyboard layout can type (unshifted or with
/// Shift) to the key that types it. Text Input Sources must be read on the main
/// thread on macOS 14 and later.
func currentLayoutKeyMap() -> [String: (code: CGKeyCode, shift: Bool)] {
    var map: [String: (code: CGKeyCode, shift: Bool)] = [:]
    let build = {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
            ?? TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
            let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
        guard let bytes = CFDataGetBytePtr(data) else { return }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        let keyboardType = UInt32(LMGetKbdType())
        let shiftState = UInt32((shiftKey >> 8) & 0xFF)
        for code in 0..<128 {
            for (shift, state) in [(false, UInt32(0)), (true, shiftState)] {
                var deadKeys: UInt32 = 0
                var length = 0
                var chars = [UniChar](repeating: 0, count: 4)
                let status = UCKeyTranslate(
                    layout, UInt16(code), UInt16(kUCKeyActionDown), state, keyboardType,
                    OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeys, chars.count, &length, &chars)
                guard status == noErr, length > 0 else { continue }
                let typed = String(utf16CodeUnits: chars, count: length)
                // Lowest key code wins, which prefers the main block over the keypad.
                if map[typed] == nil { map[typed] = (CGKeyCode(code), shift) }
            }
        }
    }
    if Thread.isMainThread { build() } else { DispatchQueue.main.sync(execute: build) }
    return map
}

/// Resolve a key name to a key code plus whether Shift must be held.
func resolveKey(_ key: String) -> Result<(code: CGKeyCode, shift: Bool), String> {
    guard let spec = parseKeyName(key) else {
        return .failure("unknown key: \(key) — use a single character or a named key (return, pageup, f5, comma, numpad1, …)")
    }
    switch spec {
    case .code(let code):
        return .success((code, false))
    case .character(let raw):
        // Letters name the key, not the case: "S" with cmd is cmd+s, as before.
        let character = raw.isLetter ? Character(raw.lowercased()) : raw
        if let hit = currentLayoutKeyMap()[String(character)] { return .success(hit) }
        if let code = ansiKeyCodes[character] { return .success((code, false)) }
        return .failure("'\(key)' is not on the current keyboard layout")
    }
}

/// Key-press counterpart of `synthesizeTypedText`. Returns a message when the
/// key or a modifier cannot be resolved, and nothing when it was sent.
func synthesizeKeyPress(_ key: String, modifiers: [String], deliver: (CGEvent?) -> Void) -> String? {
    var flags: CGEventFlags = []
    for m in modifiers.map({ $0.lowercased() }) {
        switch m {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: return "unknown modifier: \(m)"
        }
    }
    let resolved: (code: CGKeyCode, shift: Bool)
    switch resolveKey(key) {
    case .failure(let message): return message
    case .success(let hit): resolved = hit
    }
    if resolved.shift { flags.insert(.maskShift) }
    let src = CGEventSource(stateID: .privateState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: resolved.code, keyDown: true)
    let up = CGEvent(keyboardEventSource: src, virtualKey: resolved.code, keyDown: false)
    down?.flags = flags
    up?.flags = flags
    deliver(down)
    deliver(up)
    return nil
}

func pressKey(_ key: String, modifiers: [String], pid: pid_t) -> String? {
    synthesizeKeyPress(key, modifiers: modifiers) { $0?.postToPid(pid) }
}

// MARK: - Tool implementations

func toolListApps() -> String {
    var out: [String] = []
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }

    for app in apps {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        let windows = (axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        var line = "\(app.localizedName ?? "?")  [\(app.bundleIdentifier ?? "-")]  pid=\(app.processIdentifier)  windows=\(windows.count)"
        if app.isActive { line += "  FRONTMOST" }
        out.append(line)
    }
    return out.isEmpty ? "No apps found." : out.joined(separator: "\n")
}

/// `max_width` for screenshot and zoom, bounded like the Rust server. 0 keeps
/// full resolution.
func clampedMaxWidth(_ args: [String: Any]) -> Int {
    min(max((args["max_width"] as? Int) ?? 1400, 0), 8000)
}

func toolGetAppState(_ args: [String: Any]) -> String {
    guard let query = args["app"] as? String else { return "error: missing required argument 'app'" }
    guard let resolved = resolveApp(query) else { return "error: no running app matching \(query)" }

    let app = resolved.app
    // Same bounds as the Rust server: a huge depth or budget can walk an
    // Electron app's tree for minutes and blow the client's context.
    let maxDepth = min(max((args["max_depth"] as? Int) ?? 18, 1), 60)
    var budget = min(max((args["max_elements"] as? Int) ?? 800, 1), 5000)

    Registry.reset()
    Registry.targetPid = app.processIdentifier
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var windows = (axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []

    var header = "\(app.localizedName ?? "?") [\(app.bundleIdentifier ?? "-")] pid=\(app.processIdentifier) frontmost=\(app.isActive) windows=\(windows.count)"
    if let note = resolved.note { header += "\nnote: \(note)" }

    // Narrow to one window. "agent" is the Chrome window this server owns, which
    // keeps the tree (and any clicks derived from it) off the user's own tabs.
    if let scope = args["window"] {
        if let name = scope as? String, name == "agent" {
            guard let agent = Chrome.agentAXWindow() else {
                return header + "\n\n(no agent window yet — call browser_open_tab first)"
            }
            windows = [agent.element]
            Registry.targetPid = agent.pid
            header += "\nscope: agent window only"
        } else if let index = scope as? Int {
            guard index >= 0, index < windows.count else {
                return header + "\n\n(window \(index) is out of range)"
            }
            windows = [windows[index]]
            header += "\nscope: window \(index) only"
        }
    }

    if windows.isEmpty {
        return header + "\n\n(this process has no accessibility windows — if you expected one, another instance of the same app may own it; check list_apps)"
    }

    var lines: [String] = []
    for (i, w) in windows.enumerated() {
        let title = axString(w, kAXTitleAttribute as String) ?? "<untitled>"
        lines.append("── window \(i): \"\(title)\"")
        walk(w, depth: 1, lines: &lines, budget: &budget, maxDepth: maxDepth)
    }
    if budget <= 0 {
        lines.append("… element budget reached; raise max_elements for more")
    }
    // A filtered outline keeps the same ids: every element was registered while
    // walking, only the printout is narrowed. Window headers stay for context.
    if let query = (args["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
       !query.isEmpty
    {
        let needle = query.lowercased()
        let matching = lines.filter { $0.hasPrefix("── window") || $0.lowercased().contains(needle) }
        let count = matching.filter { !$0.hasPrefix("── window") }.count
        header += "\nfilter: \"\(query)\" — \(count) matching element\(count == 1 ? "" : "s")"
        if count == 0 {
            return header + "\n\n(no elements match; drop the query or scroll the content into view)"
        }
        return header + "\n\n" + matching.joined(separator: "\n")
    }
    return header + "\n\n" + lines.joined(separator: "\n")
}

/// Which process should receive synthetic input.
///
/// Order matters: an element knows its own owner, an explicit `app` argument is
/// the caller's intent, and the last inspected app is the sensible default.
/// Returning nil means global delivery, which moves the real cursor.
/// An explicit `app` that does not resolve is an error — never fall through.
func resolveTargetPid(_ args: [String: Any], element: AXUIElement? = nil) -> Result<pid_t?, String> {
    if let element, let pid = pidOf(element) { return .success(pid) }
    if let query = args["app"] as? String {
        guard let resolved = resolveApp(query) else {
            return .failure("error: no running app matching \(query)")
        }
        return .success(resolved.app.processIdentifier)
    }
    return .success(Registry.targetPid)
}

func toolClick(_ args: [String: Any]) -> String {
    let clickCount = (args["click_count"] as? Int) ?? 1
    guard clickCount > 0, clickCount <= 3 else {
        return "error: click_count must be an integer between 1 and 3"
    }

    if let id = args["element_id"] as? String {
        guard let el = Registry.get(id) else {
            return "error: unknown element_id \(id) — call get_app_state again to refresh ids"
        }
        // Prefer the semantic action; it works even when the element is scrolled
        // out of view or overlapped, where a synthetic click would hit the wrong thing.
        //
        // Web content is the exception: Blink reports AXPress as supported and
        // returns success, but does not act on it — a link "pressed" this way
        // never navigates. Inside a web area, go straight to a real click.
        // Show the pointer before acting, not after: AXPress returns early, so
        // placing this later meant the overlay never appeared for the common
        // case of pressing a button.
        let elementCenter = visibleCenter(of: el)
        // Point the overlay at the element's own frame, not its visible rect:
        // visibleCenter is nil whenever the window is occluded, which is the
        // normal case for background control and meant the pointer never showed.
        if let origin = axPoint(el, kAXPositionAttribute as String),
            let size = axSize(el, kAXSizeAttribute as String), size.width > 0, size.height > 0
        {
            AgentCursor.shared.press(
                at: CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
            )
        } else if let elementCenter {
            AgentCursor.shared.press(at: elementCenter)
        }
        if axActions(el).contains(kAXPressAction as String), clickCount == 1, !isInWebContent(el) {
            if AXUIElementPerformAction(el, kAXPressAction as CFString) == .success {
                let label = axString(el, kAXTitleAttribute as String) ?? axString(el, kAXDescriptionAttribute as String) ?? id
                return "pressed \(id) \"\(label)\" via AXPress"
            }
        }
        // Coordinate fallback: see MOUSE_TARGETING.
        guard let center = elementCenter else {
            return "error: \(id) is not visible in its window — scroll it into view and call get_app_state again"
        }
        if let target = windowTarget(for: el), backgroundClick(target, at: center, clickCount: clickCount) {
            return "clicked \(id) at (\(Int(center.x)), \(Int(center.y))) in background"
        }
        guard let pid = pidOf(el) else {
            return refuseGlobalInput("click \(id)", "Its app could not be identified; call get_app_state again.")
        }
        postClick(at: center, clickCount: clickCount, pid: pid)
        return "clicked \(id) at (\(Int(center.x)), \(Int(center.y))) by posting to its app"
    }

    if let x = args["x"] as? Double, let y = args["y"] as? Double {
        guard Int(exactly: x.rounded(.towardZero)) != nil,
              Int(exactly: y.rounded(.towardZero)) != nil else {
            return "error: coordinates must be finite and representable as integers"
        }
        let point = CGPoint(x: x, y: y)
        if RemoteControl.isEnabled {
            RemoteControl.click(at: point, clickCount: clickCount)
            return "clicked at (\(Int(x)), \(Int(y)))"
        }
        AgentCursor.shared.press(at: point)
        // Prefer the window under the point. Only constrain to an app PID when the
        // caller passed `app` explicitly — Registry.targetPid from get_app_state
        // must not discard a same-desktop under-point window.
        let under = windowTarget(under: point)
        let target: WindowTarget?
        if let query = args["app"] as? String {
            guard let resolved = resolveApp(query) else {
                return "error: no running app matching \(query)"
            }
            let appPid = resolved.app.processIdentifier
            target = under.flatMap { $0.pid == appPid ? $0 : nil }
                ?? windowTarget(forPid: appPid, containing: point)
        } else {
            switch resolveTargetPid(args) {
            case .failure(let message):
                return message
            case .success(let pid):
                target = under ?? pid.flatMap { windowTarget(forPid: $0, containing: point) }
            }
        }
        if let target, backgroundClick(target, at: point, clickCount: clickCount) {
            return "clicked at (\(Int(x)), \(Int(y))) in background"
        }
        guard let pid = target?.pid else {
            return refuseGlobalInput(
                "click (\(Int(x)), \(Int(y)))",
                "No app window was found at that point. Pass `app`, or click an element_id from get_app_state.")
        }
        postClick(at: point, clickCount: clickCount, pid: pid)
        return "clicked at (\(Int(x)), \(Int(y))) by posting to pid \(pid)"
    }
    return "error: provide either element_id, or both x and y"
}

func toolTypeText(_ args: [String: Any]) -> String {
    guard let text = args["text"] as? String else { return "error: missing required argument 'text'" }
    // Remote control types into whatever the machine has focused, which is
    // what the person watching its screen expects: they just clicked there.
    if RemoteControl.isEnabled {
        RemoteControl.typeText(text)
        return "typed \(text.count) characters"
    }
    var element: AXUIElement?
    if let id = args["element_id"] as? String {
        guard let el = Registry.get(id) else { return "error: unknown element_id \(id)" }
        if let refusal = refuseSecureFieldInput(el, id) { return refusal }
        element = el
        // Focus the field within its own app rather than raising the app, so a
        // background window still receives the text.
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(60_000)
    }
    let pid: pid_t
    switch resolveTargetPid(args, element: element) {
    case .failure(let message):
        return message
    case .success(let resolved):
        // No resolved app means post() would fall through to the global HID
        // tap, which types into whatever window the USER currently has
        // focused — the one outcome background control exists to avoid.
        // Coordinate clicks still degrade that way by design; keystrokes
        // never should, so refuse and tell the caller how to target.
        guard let resolved else {
            return "error: no target app to type into — call get_app_state (or pass `app`) first. Refusing to send keystrokes through the global input tap, which would type into whatever window the user is working in."
        }
        pid = resolved
    }
    typeText(text, pid: pid)
    return "typed \(text.count) characters"
}

func toolPressKey(_ args: [String: Any]) -> String {
    guard let key = args["key"] as? String else { return "error: missing required argument 'key'" }
    let mods = (args["modifiers"] as? [String]) ?? []
    if RemoteControl.isEnabled {
        if let err = RemoteControl.pressKey(key, modifiers: mods) { return "error: \(err)" }
        return "pressed \(mods.isEmpty ? key : mods.joined(separator: "+") + "+" + key)"
    }
    let pid: pid_t
    switch resolveTargetPid(args) {
    case .failure(let message):
        return message
    case .success(let resolved):
        // No resolved app means post() would fall through to the global HID
        // tap, which types into whatever window the USER currently has
        // focused — the one outcome background control exists to avoid.
        // Coordinate clicks still degrade that way by design; keystrokes
        // never should, so refuse and tell the caller how to target.
        guard let resolved else {
            return "error: no target app to type into — call get_app_state (or pass `app`) first. Refusing to send keystrokes through the global input tap, which would type into whatever window the user is working in."
        }
        pid = resolved
    }
    if let err = pressKey(key, modifiers: mods, pid: pid) { return "error: \(err)" }
    return "pressed \(mods.isEmpty ? key : mods.joined(separator: "+") + "+" + key)"
}

/// Scroll through accessibility when events cannot be routed: step the scroll
/// bar of the nearest scroll area around `element`.
func axScroll(_ element: AXUIElement, vertical: Bool, towardStart: Bool, lines: Int) -> Bool {
    var node: AXUIElement? = element
    while let current = node {
        if axString(current, kAXRoleAttribute as String) == (kAXScrollAreaRole as String) {
            let barAttribute = vertical ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute
            guard let bar = axElement(current, barAttribute as String) else { return false }
            let action = (towardStart ? kAXDecrementAction : kAXIncrementAction) as String
            if axActions(bar).contains(action) {
                for _ in 0..<lines { AXUIElementPerformAction(bar, action as CFString) }
                return true
            }
            if let value = axCopy(bar, kAXValueAttribute as String) as? Double {
                let step = 0.02 * Double(lines)
                let next = min(1, max(0, value + (towardStart ? -step : step)))
                return AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, next as CFNumber) == .success
            }
            return false
        }
        node = axElement(current, kAXParentAttribute as String)
    }
    return false
}

func toolScroll(_ args: [String: Any]) -> String {
    let direction = ((args["direction"] as? String) ?? "down").lowercased()
    let requested = (args["amount"] as? Int) ?? 5
    guard requested > 0 else { return "error: amount must be a positive number of lines" }
    // Same ceiling as the Rust server.
    let amount = min(requested, 100)

    var dy: Int32 = 0
    var dx: Int32 = 0
    switch direction {
    case "up": dy = 1
    case "down": dy = -1
    case "left": dx = 1
    case "right": dx = -1
    default: return "error: direction must be up, down, left, or right"
    }

    if RemoteControl.isEnabled {
        // The wheel goes wherever the pointer is; `x`/`y` move it there first
        // so a viewer scrolling over a pane scrolls that pane.
        let point: CGPoint? =
            if let x = args["x"] as? Double, let y = args["y"] as? Double {
                CGPoint(x: x, y: y)
            } else {
                nil
            }
        RemoteControl.scroll(at: point, dx: dx, dy: dy, steps: amount)
        return "scrolled \(direction) by \(amount)"
    }
    if let elementID = args["element_id"] as? String, Registry.get(elementID) == nil {
        return "error: unknown element_id \(elementID) — call get_app_state again to refresh ids"
    }
    let element = (args["element_id"] as? String).flatMap { Registry.get($0) }
    let target: WindowTarget?
    let pid: pid_t?
    if let element {
        target = windowTarget(for: element)
        pid = pidOf(element)
    } else {
        switch resolveTargetPid(args) {
        case .failure(let message):
            return message
        case .success(let resolved):
            target = resolved.flatMap { windowTarget(forPid: $0) }
            pid = resolved
        }
    }

    // Scroll follows the pointer, so aim at the element when given one and
    // otherwise at the middle of the window.
    let point = element.flatMap { visibleCenter(of: $0) }
        ?? target.map { CGPoint(x: $0.frame.midX, y: $0.frame.midY) }
    if let target, let point, backgroundScroll(target, at: point, dx: dx, dy: dy, steps: amount) {
        return "scrolled \(direction) by \(amount) in background"
    }
    if let element, axScroll(element, vertical: dy != 0, towardStart: dy > 0 || dx > 0, lines: amount) {
        return "scrolled \(direction) by \(amount) through its scroll bar"
    }
    guard let pid, let point else {
        return refuseGlobalInput(
            "scroll", "Call get_app_state first (or pass `app` or element_id) so the scroll can go to that app.")
    }
    let src = agentEventSource()
    for _ in 0..<amount {
        let wheel = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
                            wheel1: dy, wheel2: dx, wheel3: 0)
        wheel?.location = point
        post(wheel, to: pid)
        usleep(15_000)
    }
    return "scrolled \(direction) by \(amount) by posting to pid \(pid)"
}

func toolActivateApp(_ args: [String: Any]) -> String {
    guard let query = args["app"] as? String else { return "error: missing required argument 'app'" }
    guard let resolved = resolveApp(query) else { return "error: no running app matching \(query)" }
    // Requests are handled off the main thread; NSRunningApplication.activate is
    // AppKit and belongs on main.
    DispatchQueue.main.sync { resolved.app.activate(options: []) }
    usleep(250_000)
    return "activated \(resolved.app.localizedName ?? query) (pid \(resolved.app.processIdentifier))"
}

// MARK: - Screen capture

/// Synchronizes capture results so a timed-out waiter never races a late write.
/// One capture plus the geometry a model needs to turn image pixels back into
/// the screen coordinates that click/hover/zoom accept.
struct CaptureShot {
    let data: Data
    /// Captured area in global screen points (the coordinate space of click x/y).
    let frame: CGRect
    let pixelWidth: Int
    let pixelHeight: Int
    let title: String?
}

private final class CaptureBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: CaptureShot?
    func set(_ shot: CaptureShot?) {
        lock.lock()
        value = shot
        lock.unlock()
    }
    func get() -> CaptureShot? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

/// The text block that rides with every screenshot/zoom image. Models read the
/// image in pixels but every pointer tool takes screen points; without this
/// line a coordinate click from a downscaled or Retina capture lands off-target.
func captureMappingText(_ shot: CaptureShot, label: String) -> String {
    let sx = Double(shot.pixelWidth) / max(1.0, shot.frame.width)
    let sy = Double(shot.pixelHeight) / max(1.0, shot.frame.height)
    let ox = Int(shot.frame.origin.x.rounded())
    let oy = Int(shot.frame.origin.y.rounded())
    let title = shot.title.map { " \"\($0)\"" } ?? ""
    return "\(label)\(title): screen origin (\(ox), \(oy)), size \(Int(shot.frame.width.rounded()))×\(Int(shot.frame.height.rounded())) pt; "
        + "image \(shot.pixelWidth)×\(shot.pixelHeight) px (\(String(format: "%.3f", sx)) px per pt). "
        + "To act on something seen at image pixel (px, py): x = \(ox) + px / \(String(format: "%.3f", sx)), "
        + "y = \(oy) + py / \(String(format: "%.3f", sy)). Prefer element ids from get_app_state when the "
        + "target is listed there; use zoom on a region to read small text."
}

func imageResult(_ shot: CaptureShot, label: String) -> [String: Any] {
    return [
        "content": [
            ["type": "image", "data": shot.data.base64EncodedString(), "mimeType": "image/png"],
            ["type": "text", "text": captureMappingText(shot, label: label)],
        ],
        "isError": false,
    ]
}

/// Backing scale of the screen that owns an SCDisplay (2 on Retina). Needed so
/// a zoom can ask ScreenCaptureKit for every physical pixel of a region.
func backingScale(for display: SCDisplay) -> CGFloat {
    let key = NSDeviceDescriptionKey("NSScreenNumber")
    return NSScreen.screens.first {
        ($0.deviceDescription[key] as? NSNumber)?.uint32Value == display.displayID
    }?.backingScaleFactor ?? 2
}

/// Capture a window as PNG. Runs the async ScreenCaptureKit call on a background
/// executor and blocks the JSON-RPC loop until it lands, with a timeout so a
/// wedged capture can never hang the server.
func captureWindowPNG(pid: pid_t, maxWidth: Int) -> CaptureShot? {
    let semaphore = DispatchSemaphore(value: 0)
    let box = CaptureBox()

    let task = Task.detached {
        defer { semaphore.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            // Largest on-screen window belonging to the target process; smaller
            // ones are usually palettes or overlays rather than the main UI.
            let candidates = content.windows
                .filter { $0.owningApplication?.processID == pid }
                .sorted { ($0.frame.width * $0.frame.height) > ($1.frame.width * $1.frame.height) }
            guard let window = candidates.first else { return }

            let config = SCStreamConfiguration()
            let scale: Double
            if maxWidth > 0 {
                scale = min(1.0, Double(maxWidth) / max(1.0, Double(window.frame.width)))
            } else {
                scale = 1.0
            }
            config.width = Int(window.frame.width * scale)
            config.height = Int(window.frame.height * scale)
            config.showsCursor = false

            let image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: window),
                configuration: config)
            guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
            else { return }
            box.set(CaptureShot(
                data: png, frame: window.frame, pixelWidth: image.width, pixelHeight: image.height,
                title: window.title))
        } catch {
            box.set(nil)
        }
    }

    let waited = semaphore.wait(timeout: .now() + 15)
    if waited == .timedOut {
        task.cancel()
        // Do not read `box` after cancel — the task may still be writing.
        return nil
    }
    return box.get()
}

/// Capture a whole display. Window capture covers one app; this is for seeing
/// the desktop as a whole, including every monitor the user has attached.
func captureDisplayPNG(index: Int, maxWidth: Int) -> CaptureShot? {
    let semaphore = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var result: CaptureShot?
    Task.detached {
        defer { semaphore.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            let displays = content.displays
            guard index >= 0, index < displays.count else { return }
            let display = displays[index]
            let config = SCStreamConfiguration()
            let scale: Double
            if maxWidth > 0 {
                scale = min(1.0, Double(maxWidth) / max(1.0, Double(display.width)))
            } else {
                scale = 1.0
            }
            config.width = Int(Double(display.width) * scale)
            config.height = Int(Double(display.height) * scale)
            config.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(display: display, excludingWindows: []),
                configuration: config)
            if let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
                lock.lock()
                result = CaptureShot(
                    data: png, frame: display.frame, pixelWidth: image.width, pixelHeight: image.height,
                    title: nil)
                lock.unlock()
            }
        } catch {
            lock.lock()
            result = nil
            lock.unlock()
        }
    }
    // On timeout the task may still write `result` — do not read it.
    if semaphore.wait(timeout: .now() + 20) == .timedOut {
        return nil
    }
    lock.lock()
    defer { lock.unlock() }
    return result
}

/// Capture one region of the screen at full physical resolution. `rect` is in
/// global screen points, the same space click/hover take, so a model can zoom
/// straight from the coordinates it already knows.
func captureRegionPNG(rect: CGRect, maxWidth: Int) -> CaptureShot? {
    let semaphore = DispatchSemaphore(value: 0)
    let box = CaptureBox()
    let task = Task.detached {
        defer { semaphore.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true)
            let center = CGPoint(x: rect.midX, y: rect.midY)
            guard let display = content.displays.first(where: { $0.frame.contains(center) })
                ?? content.displays.first
            else { return }
            let clipped = rect.intersection(display.frame)
            guard clipped.width >= 4, clipped.height >= 4 else { return }
            let scale = backingScale(for: display)
            var width = clipped.width * scale
            var height = clipped.height * scale
            if maxWidth > 0, width > CGFloat(maxWidth) {
                let ratio = CGFloat(maxWidth) / width
                width *= ratio
                height *= ratio
            }
            let config = SCStreamConfiguration()
            config.sourceRect = CGRect(
                x: clipped.origin.x - display.frame.origin.x,
                y: clipped.origin.y - display.frame.origin.y,
                width: clipped.width, height: clipped.height)
            config.width = max(1, Int(width.rounded()))
            config.height = max(1, Int(height.rounded()))
            config.showsCursor = false
            if #available(macOS 14.0, *) { config.captureResolution = .best }
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(display: display, excludingWindows: []),
                configuration: config)
            guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
            else { return }
            box.set(CaptureShot(
                data: png, frame: clipped, pixelWidth: image.width, pixelHeight: image.height, title: nil))
        } catch {
            box.set(nil)
        }
    }
    if semaphore.wait(timeout: .now() + 15) == .timedOut {
        task.cancel()
        return nil
    }
    return box.get()
}

func toolListDisplays(_ args: [String: Any]) -> String {
    let semaphore = DispatchSemaphore(value: 0)
    let lock = NSLock()
    var lines: [String]?
    let task = Task.detached {
        defer { semaphore.signal() }
        var collected: [String] = []
        if let content = try? await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true) {
            for (i, display) in content.displays.enumerated() {
                let frame = display.frame
                collected.append("[\(i)] \(display.width)x\(display.height) "
                    + "at (\(Int(frame.origin.x)), \(Int(frame.origin.y)))")
            }
        }
        lock.lock()
        lines = collected
        lock.unlock()
    }
    if semaphore.wait(timeout: .now() + 20) == .timedOut {
        task.cancel()
        // On timeout the task may still write `lines` — do not read it.
        return "error: could not enumerate displays"
    }
    lock.lock()
    let snapshot = lines
    lock.unlock()
    guard let snapshot, !snapshot.isEmpty else {
        return "error: could not enumerate displays"
    }
    return "\(snapshot.count) display\(snapshot.count == 1 ? "" : "s"):\n" + snapshot.joined(separator: "\n")
}

// MARK: - Additional input synthesis

func postRightClick(at point: CGPoint, pid: pid_t) {
    CursorOverlay.shared.press(at: point)
    let src = agentEventSource()
    post(CGEvent(mouseEventSource: src, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right), to: pid)
    post(CGEvent(mouseEventSource: src, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right), to: pid)
}

func postDrag(from start: CGPoint, to end: CGPoint, pid: pid_t) {
    let src = agentEventSource()
    // Deliver a move to the press location first: many views only begin drag
    // tracking when the press arrives where the pointer already is, and without
    // it the gesture degrades into a plain click. It is a synthetic move sent
    // to that app only, so the user's real cursor stays put.
    post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left), to: pid)
    usleep(80_000)
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left), to: pid)
    usleep(80_000)
    // Interpolate: a single jump often reads as a click, since many views need
    // intermediate drag events to start tracking.
    let steps = 24
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let point = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left), to: pid)
        usleep(15_000)
    }
    usleep(80_000)
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left), to: pid)
}

// MARK: - Additional tools

func resolvePoint(_ args: [String: Any], xKey: String, yKey: String, idKey: String) -> Result<CGPoint, String> {
    if let id = args[idKey] as? String {
        guard let el = Registry.get(id) else {
            return .failure("error: unknown element_id \(id) — call get_app_state again to refresh ids")
        }
        guard let point = visibleCenter(of: el) else {
            return .failure(
                "error: \(id) is not visible in its window — scroll it into view and call get_app_state again"
            )
        }
        return .success(point)
    }
    if let x = args[xKey] as? Double, let y = args[yKey] as? Double {
        guard x.isFinite, y.isFinite,
              Int(exactly: x.rounded(.towardZero)) != nil,
              Int(exactly: y.rounded(.towardZero)) != nil else {
            return .failure("error: coordinates must be finite and representable as integers")
        }
        return .success(CGPoint(x: x, y: y))
    }
    return .failure("error: provide either \(idKey), or both \(xKey) and \(yKey)")
}

func toolRightClick(_ args: [String: Any]) -> String {
    let point: CGPoint
    switch resolvePoint(args, xKey: "x", yKey: "y", idKey: "element_id") {
    case .failure(let message):
        return message
    case .success(let resolved):
        point = resolved
    }
    if RemoteControl.isEnabled {
        RemoteControl.click(at: point, button: .right)
        return "right-clicked at (\(Int(point.x)), \(Int(point.y)))"
    }
    let element = (args["element_id"] as? String).flatMap { Registry.get($0) }
    let target: WindowTarget?
    if let element {
        target = windowTarget(for: element)
    } else {
        switch resolveTargetPid(args) {
        case .failure(let message):
            return message
        case .success(let pid):
            target = pid.flatMap { windowTarget(forPid: $0, containing: point) }
        }
    }
    if let target, backgroundRightClick(target, at: point) {
        return "right-clicked at (\(Int(point.x)), \(Int(point.y))) in background"
    }
    // The accessibility way to open a context menu, with no pointer at all.
    if let element, axActions(element).contains(kAXShowMenuAction as String),
       AXUIElementPerformAction(element, kAXShowMenuAction as CFString) == .success
    {
        return "opened the context menu of \(args["element_id"] as? String ?? "the element") via AXShowMenu"
    }
    guard let pid = target?.pid ?? element.flatMap({ pidOf($0) }) else {
        return refuseGlobalInput(
            "right-click (\(Int(point.x)), \(Int(point.y)))",
            "No app window was found there. Pass `app`, or use an element_id from get_app_state.")
    }
    postRightClick(at: point, pid: pid)
    return "right-clicked at (\(Int(point.x)), \(Int(point.y))) by posting to pid \(pid)"
}

/// Move the pointer without pressing. Hover-revealed UI (menus, toolbars that
/// appear on mouse-over, tooltips) has no accessibility action to invoke, so a
/// model needs a way to park the pointer and then look again.
func backgroundHover(_ target: WindowTarget, at point: CGPoint) -> Bool {
    guard SkyLight.available else { return false }
    CursorOverlay.shared.show(at: point)
    guard SkyLight.activateWithoutRaise(pid: target.pid, wid: target.wid) else { return false }
    usleep(60_000)
    clickGroupCounter += 1
    let src = agentEventSource()
    guard let move = CGEvent(mouseEventSource: src, mouseType: .mouseMoved,
                             mouseCursorPosition: point, mouseButton: .left)
    else { return false }
    SkyLight.postMouse(move, pid: target.pid, wid: target.wid, windowOrigin: target.origin,
                       screen: point, clickState: 0, button: 0, subtype: 3, groupID: clickGroupCounter)
    return true
}

func toolHover(_ args: [String: Any]) -> String {
    let point: CGPoint
    switch resolvePoint(args, xKey: "x", yKey: "y", idKey: "element_id") {
    case .failure(let message):
        return message
    case .success(let resolved):
        point = resolved
    }
    if RemoteControl.isEnabled {
        RemoteControl.move(to: point)
        return "moved the pointer to (\(Int(point.x)), \(Int(point.y)))"
    }
    let element = (args["element_id"] as? String).flatMap { Registry.get($0) }
    let target: WindowTarget?
    if let element {
        target = windowTarget(for: element)
    } else if let under = windowTarget(under: point) {
        target = under
    } else {
        switch resolveTargetPid(args) {
        case .failure(let message):
            return message
        case .success(let pid):
            target = pid.flatMap { windowTarget(forPid: $0, containing: point) }
        }
    }
    if let target, backgroundHover(target, at: point) {
        return "hovering at (\(Int(point.x)), \(Int(point.y))) in background — call get_app_state or screenshot to see what appeared"
    }
    guard let pid = target?.pid ?? element.flatMap({ pidOf($0) }) else {
        return refuseGlobalInput(
            "hover at (\(Int(point.x)), \(Int(point.y)))",
            "No app window was found there. Pass `app`, or use an element_id from get_app_state.")
    }
    CursorOverlay.shared.show(at: point)
    post(CGEvent(mouseEventSource: agentEventSource(), mouseType: .mouseMoved,
                 mouseCursorPosition: point, mouseButton: .left), to: pid)
    return "hovering at (\(Int(point.x)), \(Int(point.y))) by posting to pid \(pid) — call get_app_state or screenshot to see what appeared"
}

/// Blocks the request loop on purpose: the client is waiting on this call, and
/// a pause the model asked for is exactly the time nothing else should happen.
func toolWait(_ args: [String: Any]) -> String {
    let requested = (args["seconds"] as? Double) ?? 1
    guard requested.isFinite, requested > 0 else { return "error: seconds must be a positive number" }
    let seconds = min(requested, 30)
    usleep(useconds_t(seconds * 1_000_000))
    return "waited \(String(format: "%.1f", seconds))s" + (seconds < requested ? " (capped at 30s)" : "")
}

func toolDrag(_ args: [String: Any]) -> String {
    let start: CGPoint
    switch resolvePoint(args, xKey: "from_x", yKey: "from_y", idKey: "from_element_id") {
    case .failure(let message):
        return message
    case .success(let resolved):
        start = resolved
    }
    let end: CGPoint
    switch resolvePoint(args, xKey: "to_x", yKey: "to_y", idKey: "to_element_id") {
    case .failure(let message):
        return message
    case .success(let resolved):
        end = resolved
    }
    if RemoteControl.isEnabled {
        RemoteControl.drag(from: start, to: end)
        return "dragged (\(Int(start.x)), \(Int(start.y))) → (\(Int(end.x)), \(Int(end.y)))"
    }
    let element = (args["from_element_id"] as? String).flatMap { Registry.get($0) }
    let underStart = windowTarget(under: start)
    let target: WindowTarget?
    if let element {
        target = windowTarget(for: element)
    } else if let query = args["app"] as? String {
        // Resolve the named app directly — never fall through to Registry.targetPid.
        guard let resolved = resolveApp(query) else {
            return "error: no running app matching \(query)"
        }
        let appPid = resolved.app.processIdentifier
        target = underStart.flatMap { $0.pid == appPid ? $0 : nil }
            ?? windowTarget(forPid: appPid, containing: start)
    } else {
        target = underStart
    }
    // Reject element→element drags across windows even when the destination
    // center still lies inside the source frame (overlapping windows).
    if let target,
       let toElementID = args["to_element_id"] as? String,
       let destinationElement = Registry.get(toElementID),
       let destination = windowTarget(for: destinationElement),
       destination.pid != target.pid || destination.wid != target.wid
    {
        return "error: cross-window drag is not supported — keep the drag inside one window"
    }
    // Only treat as cross-window when the endpoint is outside the source frame.
    // `windowTarget(under:)` is frontmost-first, so using it for every drag would
    // reject legitimate background drags under an occluding window.
    if let target, !target.frame.contains(end) {
        if let dest = windowTarget(under: end), dest.wid != target.wid || dest.pid != target.pid {
            return "error: cross-window drag is not supported — keep the drag inside one window"
        }
        if windowTarget(under: end) == nil {
            return "error: drag destination is outside the source window"
        }
    }
    if let target, backgroundDrag(target, from: start, to: end) {
        return "dragged from (\(Int(start.x)), \(Int(start.y))) to (\(Int(end.x)), \(Int(end.y))) in background"
    }
    guard let pid = target?.pid else {
        return refuseGlobalInput(
            "drag there",
            "Drags must start in a window of a known app and stay inside it; dragging between apps or "
                + "onto the desktop needs the real pointer. Use from_element_id, or pass `app`.")
    }
    postDrag(from: start, to: end, pid: pid)
    return "dragged from (\(Int(start.x)), \(Int(start.y))) to (\(Int(end.x)), \(Int(end.y))) by posting to pid \(pid)"
}

/// Refuse to write into a macOS password field unless explicitly allowed.
///
/// `AXSecureTextField` is the role AppKit gives password inputs. Driving one
/// from an agent means a credential is being produced by a model and typed
/// somewhere the user cannot see it echoed, and the transcript may keep it —
/// so the default is to stop and let the human type it. Operator-style agents
/// take the same line and hand control back at password prompts.
///
/// Set `COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT=1` to opt out.
func refuseSecureFieldInput(_ element: AXUIElement, _ id: String) -> String? {
    if Identity.current.tunable("ALLOW_SECURE_FIELD_INPUT") == "1" {
        return nil
    }
    guard axString(element, kAXRoleAttribute as String) == "AXSecureTextField" else { return nil }

    // Hand back rather than just refusing. Operator-class agents solve password
    // prompts by pausing and giving the human the keyboard — the credential is
    // never produced by the model and never lands in the transcript — and a
    // refusal the user cannot act on just strands the task. So put the caret in
    // the field and bring its app forward: the user can type immediately, and
    // the agent picks the task back up afterwards.
    AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    var handedBackTo = "the app"
    if let pid = pidOf(element),
        let app = NSRunningApplication(processIdentifier: pid)
    {
        DispatchQueue.main.sync { app.activate(options: []) }
        handedBackTo = app.localizedName ?? handedBackTo
    }
    return "handed control to the user: \(id) is a password field, so it was focused in "
        + "\(handedBackTo) and brought to the front for them to type into. The credential is "
        + "deliberately not routed through the model. Tell the user it is ready, wait for them to "
        + "say they are done, then continue — do not retry this call. "
        + "(COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT=1 lets the agent type throwaway credentials.)"
}

func toolSetValue(_ args: [String: Any]) -> String {
    guard let id = args["element_id"] as? String else { return "error: missing required argument 'element_id'" }
    guard let value = args["value"] as? String else { return "error: missing required argument 'value'" }
    guard let el = Registry.get(id) else { return "error: unknown element_id \(id)" }
    if let refusal = refuseSecureFieldInput(el, id) { return refusal }
    // Setting AXValue replaces field contents atomically, which is far more
    // reliable than select-all-then-type for long strings.
    let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
    if err != .success {
        return "error: could not set value on \(id) (AX error \(err.rawValue)); try click + type_text instead"
    }
    return "set \(id) to \(value.count) characters"
}

func toolSelectText(_ args: [String: Any]) -> String {
    guard let id = args["element_id"] as? String else { return "error: missing required argument 'element_id'" }
    guard let el = Registry.get(id) else { return "error: unknown element_id \(id)" }

    let text = axString(el, kAXValueAttribute as String) ?? ""
    let start = (args["start"] as? Int) ?? 0
    let length = (args["length"] as? Int) ?? max(0, text.count - start)
    var range = CFRange(location: start, length: length)
    guard let axRange = AXValueCreate(.cfRange, &range) else { return "error: could not build range" }

    let err = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, axRange)
    if err != .success { return "error: could not select text on \(id) (AX error \(err.rawValue))" }
    let selected = axString(el, kAXSelectedTextAttribute as String) ?? ""
    return "selected \(selected.count) characters in \(id)"
}

// MARK: - Chrome agent window
//
// The agent gets its own Chrome window and only ever drives tabs inside it, so
// the user can keep browsing their own tabs undisturbed. Tab management goes
// through Chrome's scripting interface (the same surface a browser extension
// would use); page interaction stays on the AX + SkyLight path, addressed to the
// agent window's id, so it never touches the user's window.

/// A script result. `Result` is not used because its failure type must conform
/// to `Error`, and these are human-readable messages headed straight into a
/// tool response.
enum ScriptOutcome {
    case success(String)
    case failure(String)
}

enum WindowOutcome {
    case success(Int)
    case failure(String)
}

enum Chrome {
    /// Persisted so a restarted server reattaches to the same window instead of
    /// stranding it and opening another. MCP servers are spawned per session;
    /// the browser window outlives them.
    static let stateURL: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let dir = base.appendingPathComponent("computer-use", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("agent-window")
    }()

    private static var cachedWindowID: Int?
    private static var cachedChromePid: pid_t?
    /// Process start time for `cachedChromePid` — PIDs alone are reusable after relaunch.
    private static var cachedChromeLaunch: TimeInterval?
    /// CGWindowID from `_AXUIElementGetWindow`. Scripting ids and AX elements share
    /// no handle; frame matching alone fails when Chrome stacks maximized windows
    /// on the same display (identical origins and sizes → tied). This id is how
    /// the agent window is reattached unambiguously after create.
    private static var cachedAXWindowID: UInt32?
    private static var didLoadState = false

    private static func chromePid() -> pid_t? {
        NSWorkspace.shared.runningApplications
            .first(where: { $0.bundleIdentifier == "com.google.Chrome" })?
            .processIdentifier
    }

    private static func chromeApp(pid: pid_t) -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first {
            $0.processIdentifier == pid && $0.bundleIdentifier == "com.google.Chrome"
        }
    }

    private static func launchInterval(for app: NSRunningApplication) -> TimeInterval? {
        app.launchDate?.timeIntervalSince1970
    }

    private static func loadState() {
        guard !didLoadState else { return }
        didLoadState = true
        guard
            let data = try? Data(contentsOf: stateURL),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let windowId = object["windowId"] as? Int,
            let chromePid = object["chromePid"] as? Int,
            chromePid >= Int(pid_t.min), chromePid <= Int(pid_t.max)
        else {
            // Legacy plain-integer files from older builds are intentionally
            // discarded: a reused window id after Chrome restart is unsafe.
            // Out-of-range chromePid would trap on pid_t conversion.
            try? FileManager.default.removeItem(at: stateURL)
            cachedWindowID = nil
            cachedChromePid = nil
            cachedChromeLaunch = nil
            cachedAXWindowID = nil
            return
        }
        cachedWindowID = windowId
        cachedChromePid = pid_t(chromePid)
        cachedChromeLaunch = object["chromeLaunch"] as? TimeInterval
        if let axId = object["axWindowId"] as? Int, axId > 0, axId <= Int(UInt32.max) {
            cachedAXWindowID = UInt32(axId)
        } else {
            cachedAXWindowID = nil
        }
    }

    private static func persistState() {
        guard let windowId = cachedWindowID, let chromePid = cachedChromePid else {
            try? FileManager.default.removeItem(at: stateURL)
            return
        }
        var payload: [String: Any] = ["windowId": windowId, "chromePid": Int(chromePid)]
        if let launch = cachedChromeLaunch {
            payload["chromeLaunch"] = launch
        }
        if let axWindowId = cachedAXWindowID {
            payload["axWindowId"] = Int(axWindowId)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        try? data.write(to: stateURL, options: .atomic)
    }

    static var agentWindowID: Int? {
        get {
            withStateLock {
                loadState()
                return cachedWindowID
            }
        }
        set {
            withStateLock {
                didLoadState = true
                cachedWindowID = newValue
                if let id = newValue {
                    // Prefer the Chrome process that owns this window, not the first
                    // com.google.Chrome in the process list (multi-instance safe).
                    if let match = resolveAXWindow(scriptingID: id) {
                        cachedChromePid = match.pid
                        cachedAXWindowID = match.cgWindowID
                        if let app = chromeApp(pid: match.pid) {
                            cachedChromeLaunch = launchInterval(for: app)
                        } else {
                            cachedChromeLaunch = nil
                        }
                    } else {
                        cachedChromePid = nil
                        cachedChromeLaunch = nil
                        cachedAXWindowID = nil
                    }
                } else {
                    cachedChromePid = nil
                    cachedChromeLaunch = nil
                    cachedAXWindowID = nil
                }
                persistState()
            }
        }
    }

    private static func clearAgentWindowState() {
        cachedWindowID = nil
        cachedChromePid = nil
        cachedChromeLaunch = nil
        cachedAXWindowID = nil
        try? FileManager.default.removeItem(at: stateURL)
    }

    /// The stored id, or nil if that window (or this Chrome instance) is gone.
    /// Caller must hold the agent-window state lock.
    private static func liveAgentWindowIDLocked() -> Int? {
        loadState()
        guard let id = cachedWindowID else { return nil }
        guard let expectedPid = cachedChromePid, let app = chromeApp(pid: expectedPid) else {
            clearAgentWindowState()
            return nil
        }
        guard let expectedLaunch = cachedChromeLaunch,
              let liveLaunch = launchInterval(for: app),
              abs(expectedLaunch - liveLaunch) <= 0.5
        else {
            clearAgentWindowState()
            return nil
        }
        guard windowExists(id) else {
            clearAgentWindowState()
            return nil
        }
        if let match = resolveAXWindow(scriptingID: id, pid: expectedPid) {
            cachedChromePid = match.pid
            cachedAXWindowID = match.cgWindowID
            cachedChromeLaunch = launchInterval(for: app)
            return id
        }
        // AX can miss briefly while AppleScript still sees the window — keep it
        // so Computer Use does not drop ownership and spawn orphans on retry.
        return id
    }

    /// The stored id, or nil if that window (or this Chrome instance) is gone.
    static func liveAgentWindowID() -> Int? {
        withStateLock { liveAgentWindowIDLocked() }
    }

    /// NSAppleScript is not thread-safe and the JSON-RPC loop runs off-main.
    static func run(_ source: String) -> ScriptOutcome {
        var result: ScriptOutcome = .failure("script did not run")
        let work = {
            guard let script = NSAppleScript(source: source) else {
                result = .failure("could not compile script")
                return
            }
            var error: NSDictionary?
            let value = script.executeAndReturnError(&error)
            if let error {
                result = .failure((error[NSAppleScript.errorMessage] as? String) ?? "\(error)")
            } else {
                result = .success(value.stringValue ?? "")
            }
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
        return result
    }

    /// Run browser work without leaving Chrome in front. Chrome raises itself on
    /// window creation and on tab changes, so every browser tool restores the
    /// app the user was in and pushes the agent window back down the stack.
    static func preservingFocus<T>(_ body: () -> T) -> T {
        let previous = NSWorkspace.shared.frontmostApplication
        let previousWindow = frontWindowID()
        let result = body()
        if let previousWindow, previousWindow != agentWindowID {
            raiseWindow(previousWindow)
        }
        if let previous,
           previous.processIdentifier != NSWorkspace.shared.frontmostApplication?.processIdentifier {
            DispatchQueue.main.sync { previous.activate(options: []) }
            usleep(220_000)
        }
        return result
    }

    /// Chrome's scripting `index` property does not actually reorder windows, so
    /// the user's window is brought back to the front with the accessibility
    /// raise action instead. That reorders within Chrome without activating it.
    static func raiseWindow(_ id: Int) {
        guard let match = resolveAXWindow(scriptingID: id) else { return }
        AXUIElementPerformAction(match.element, kAXRaiseAction as CFString)
    }

    static func frontWindowID() -> Int? {
        guard case .success(let s) = run("""
        tell application "Google Chrome"
            if (count windows) is 0 then return ""
            return (id of window 1) as string
        end tell
        """) else { return nil }
        return Int(s.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines))
    }

    static func windowExists(_ id: Int) -> Bool {
        if case .success(let s) = run("""
        tell application "Google Chrome" to return (exists window id \(id)) as string
        """) { return s == "true" }
        return false
    }

    /// Cross-process lock around agent-window state so concurrent MCP servers
    /// cannot each create a window after both observing a missing one.
    private static func withStateLock<T>(_ body: () -> T) -> T {
        let lockPath = stateURL.path + ".lock"
        let lockFd = open(lockPath, O_CREAT | O_RDWR, 0o600)
        guard lockFd >= 0 else { return body() }
        _ = flock(lockFd, LOCK_EX)
        defer {
            flock(lockFd, LOCK_UN)
            close(lockFd)
        }
        return body()
    }

    /// Return the agent's window id, creating the window if needed.
    static func ensureAgentWindow() -> WindowOutcome {
        withStateLock {
            // Another MCP process may have created and persisted a window while
            // this process held a stale in-memory cache — reload under the lock.
            didLoadState = false
            if let id = liveAgentWindowIDLocked() { return .success(id) }

            // Snapshot CGWindowIDs before create so the new AX window can be
            // identified even when it shares a frame with an existing maximized
            // window (frame matching alone returns a tie and used to fail here).
            let beforeIDs = Set(chromeAXWindows().map(\.cgWindowID))

            let created = run("""
            tell application "Google Chrome"
                set w to make new window
                return id of w as string
            end tell
            """)
            switch created {
            case .failure(let e): return .failure(e)
            case .success(let s):
                guard let id = Int(s.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)) else {
                    return .failure("unexpected window id: \(s)")
                }
                didLoadState = true
                cachedWindowID = id
                if let match = pairCreatedWindow(scriptingID: id, beforeIDs: beforeIDs) {
                    cachedChromePid = match.pid
                    cachedAXWindowID = match.cgWindowID
                    if let app = chromeApp(pid: match.pid) {
                        cachedChromeLaunch = launchInterval(for: app)
                    } else {
                        cachedChromeLaunch = nil
                    }
                } else {
                    // Close the orphan so the next retry does not create another window.
                    _ = run("tell application \"Google Chrome\" to close window id \(id)")
                    clearAgentWindowState()
                    return .failure(
                        "created agent window \(id) but could not pair it with accessibility — retry ensureAgentWindow"
                    )
                }
                persistState()
                return .success(id)
            }
        }
    }

    /// Screen frame of the agent window, used to pair it with its AX window.
    static func agentWindowFrame() -> CGRect? {
        guard let id = liveAgentWindowID() else { return nil }
        return boundsOf(id)
    }

    static func boundsOf(_ id: Int) -> CGRect? {
        guard case .success(let s) = run("""
        tell application "Google Chrome"
            set b to bounds of window id \(id)
            return ((item 1 of b) as string) & "," & ((item 2 of b) as string) & "," ¬
                & ((item 3 of b) as string) & "," & ((item 4 of b) as string)
        end tell
        """) else { return nil }
        let parts = s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: CharacterSet.whitespaces)) }
        guard parts.count == 4 else { return nil }
        return CGRect(x: parts[0], y: parts[1], width: parts[2] - parts[0], height: parts[3] - parts[1])
    }

    /// The AX window for the agent's Chrome window.
    ///
    /// Prefer the persisted CGWindowID — scripting ids and accessibility elements
    /// are separate worlds, and frame matching is ambiguous when Chrome stacks
    /// maximized windows on the same display.
    static func agentAXWindow() -> (element: AXUIElement, pid: pid_t)? {
        loadState()
        if let axID = cachedAXWindowID,
           let match = axWindow(cgWindowID: axID, pid: cachedChromePid)
        {
            return (match.element, match.pid)
        }
        guard let id = liveAgentWindowID() ?? cachedWindowID else { return nil }
        guard let match = resolveAXWindow(scriptingID: id, pid: cachedChromePid) else { return nil }
        cachedAXWindowID = match.cgWindowID
        cachedChromePid = match.pid
        return (match.element, match.pid)
    }

    /// Every on-screen Chrome AX window with its CGWindowID (when resolvable).
    static func chromeAXWindows(pid: pid_t? = nil) -> [(
        element: AXUIElement, pid: pid_t, cgWindowID: UInt32
    )] {
        var result: [(AXUIElement, pid_t, UInt32)] = []
        for app in NSWorkspace.shared.runningApplications
        where app.bundleIdentifier == "com.google.Chrome" {
            if let pid, app.processIdentifier != pid { continue }
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            for window in (axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] {
                guard let wid = SkyLight.windowID(window) else { continue }
                result.append((window, app.processIdentifier, wid))
            }
        }
        return result
    }

    static func axWindow(cgWindowID: UInt32, pid: pid_t? = nil) -> (
        element: AXUIElement, pid: pid_t
    )? {
        for entry in chromeAXWindows(pid: pid) where entry.cgWindowID == cgWindowID {
            return (entry.element, entry.pid)
        }
        return nil
    }

    /// Pair a just-created scripting window with its AX element.
    ///
    /// The AX window that appeared after `beforeIDs` was snapshotted is preferred
    /// — frame matching alone fails when Chrome stacks maximized windows on the
    /// same display (identical origins and sizes → tied).
    static func pairCreatedWindow(scriptingID: Int, beforeIDs: Set<UInt32>) -> (
        element: AXUIElement, pid: pid_t, cgWindowID: UInt32
    )? {
        for _ in 0..<12 {
            let windows = chromeAXWindows()
            let newcomers = windows.filter { !beforeIDs.contains($0.cgWindowID) }
            if newcomers.count == 1 {
                let n = newcomers[0]
                return (n.element, n.pid, n.cgWindowID)
            }
            if newcomers.count > 1, let frame = boundsOf(scriptingID) {
                var best: (AXUIElement, pid_t, UInt32, CGFloat)?
                for n in newcomers {
                    guard let origin = axPoint(n.element, kAXPositionAttribute as String),
                          let size = axSize(n.element, kAXSizeAttribute as String)
                    else { continue }
                    let distance = hypot(origin.x - frame.origin.x, origin.y - frame.origin.y)
                        + hypot(size.width - frame.width, size.height - frame.height)
                    if best == nil || distance < best!.3 {
                        best = (n.element, n.pid, n.cgWindowID, distance)
                    }
                }
                if let best, best.3 < 12 {
                    return (best.0, best.1, best.2)
                }
            }
            // Unambiguous frame match (only one window at that rect) — covers
            // the case where CGWindowID was not yet published for the newcomer.
            if let frame = boundsOf(scriptingID),
               let match = axWindow(matching: frame),
               let wid = SkyLight.windowID(match.element)
            {
                return (match.element, match.pid, wid)
            }
            usleep(50_000)
        }
        return nil
    }

    /// Resolve a Chrome scripting window to its AX element.
    /// Prefers the persisted CGWindowID when this is the agent window.
    static func resolveAXWindow(scriptingID: Int, pid: pid_t? = nil) -> (
        element: AXUIElement, pid: pid_t, cgWindowID: UInt32
    )? {
        if scriptingID == cachedWindowID,
           let axID = cachedAXWindowID,
           let match = axWindow(cgWindowID: axID, pid: pid ?? cachedChromePid)
        {
            return (match.element, match.pid, axID)
        }
        guard let frame = boundsOf(scriptingID),
              let match = axWindow(matching: frame, pid: pid)
        else { return nil }
        guard let wid = SkyLight.windowID(match.element) else {
            return nil
        }
        return (match.element, match.pid, wid)
    }

    /// Pair a scripting window with its accessibility element by screen frame.
    /// Chrome cascades new windows only ~28px apart, so origin alone is not
    /// enough to tell them apart — size is folded into the distance and the
    /// tolerance is tight. When `pid` is set, only that Chrome process is searched.
    ///
    /// Returns nil when two windows sit at the same frame (maximized stack) —
    /// callers that just created a window should use `pairCreatedWindow` instead.
    static func axWindow(matching frame: CGRect, pid: pid_t? = nil) -> (element: AXUIElement, pid: pid_t)? {
        var best: (AXUIElement, pid_t, CGFloat)?
        var tied = false
        for app in NSWorkspace.shared.runningApplications
        where app.bundleIdentifier == "com.google.Chrome" {
            if let pid, app.processIdentifier != pid { continue }
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            for window in (axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] {
                guard let origin = axPoint(window, kAXPositionAttribute as String),
                      let size = axSize(window, kAXSizeAttribute as String) else { continue }
                let distance = hypot(origin.x - frame.origin.x, origin.y - frame.origin.y)
                    + hypot(size.width - frame.width, size.height - frame.height)
                if best == nil || distance + 0.5 < best!.2 {
                    best = (window, app.processIdentifier, distance)
                    tied = false
                } else if let current = best, abs(distance - current.2) <= 0.5 {
                    tied = true
                }
            }
        }
        // Equal-distance matches are ambiguous (stacked / identical frames).
        guard let best, !tied, best.2 < 12 else { return nil }
        return (best.0, best.1)
    }
}

func toolBrowserOpenTab(_ args: [String: Any]) -> String {
    let url = (args["url"] as? String) ?? "about:blank"
    // The extension is the good path: it opens an inactive tab in a labelled
    // group inside the user's own signed-in Chrome. Without it, fall back to a
    // separate window driven through the accessibility API.
    if BrowserBridge.shared.isConnected {
        return bridgeText(BrowserBridge.shared.call("open_tab", ["url": url])) { payload in
            "opened \(url) in the agent tab group (tab_id=\(payload["tabId"] as? Int ?? -1))"
        }
    }
    return Chrome.preservingFocus {
        switch Chrome.ensureAgentWindow() {
        case .failure(let e):
            return "error: could not open the agent window: \(e)"
        case .success(let id):
            let escaped = url
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            switch Chrome.run("""
            tell application "Google Chrome"
                set w to window id \(id)
                make new tab at end of tabs of w with properties {URL:"\(escaped)"}
                set active tab index of w to (count tabs of w)
                return ((count tabs of w) as string)
            end tell
            """) {
            case .failure(let e):
                return "error: \(e)"
            case .success(let count):
                let n = count.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
                return "opened \(url) as tab \(n) in the agent window (id \(id))"
            }
        }
    }
}

func toolBrowserListTabs(_ args: [String: Any]) -> String {
    let all = args["all"] as? Bool ?? false
    if BrowserBridge.shared.isConnected {
        return bridgeText(BrowserBridge.shared.call("list_tabs", ["all": all]), describeTabs)
    }
    if all { return listEveryChromeTabViaAppleScript() }
    guard let id = Chrome.liveAgentWindowID() else {
        return "no agent window yet — call browser_open_tab first"
    }
    return Chrome.preservingFocus {
        switch Chrome.run("""
        tell application "Google Chrome"
            set w to window id \(id)
            set activeIndex to active tab index of w
            set out to ""
            repeat with i from 1 to (count tabs of w)
                set t to tab i of w
                set marker to "  "
                if i is activeIndex then set marker to "* "
                set out to out & marker & (i as string) & ". " & (title of t) & "  [" & (URL of t) & "]" & linefeed
            end repeat
            return out
        end tell
        """) {
        case .failure(let e):
            return "error: \(e)"
        case .success(let s):
            return "agent window \(id) (* = active):\n" + (s.isEmpty ? "  (no tabs)" : s)
        }
    }
}

func toolBrowserSelectTab(_ args: [String: Any]) -> String {
    if BrowserBridge.shared.isConnected {
        guard let tabId = args["tab_id"] as? Int ?? args["index"] as? Int else {
            return "error: missing required argument 'tab_id'"
        }
        return bridgeText(BrowserBridge.shared.call("select_tab", ["tabId": tabId])) { _ in
            "switched the agent group to tab \(tabId)"
        }
    }
    guard let index = args["index"] as? Int else { return "error: missing required argument 'index'" }
    guard let id = Chrome.liveAgentWindowID() else {
        return "error: no agent window yet — call browser_open_tab first"
    }
    return Chrome.preservingFocus {
        switch Chrome.run("""
        tell application "Google Chrome"
            set w to window id \(id)
            if \(index) < 1 or \(index) > (count tabs of w) then return "out of range"
            set active tab index of w to \(index)
            return title of active tab of w
        end tell
        """) {
        case .failure(let e):
            return "error: \(e)"
        case .success(let title):
            return title == "out of range"
                ? "error: tab \(index) is out of range for the agent window"
                : "switched the agent window to tab \(index): \(title)"
        }
    }
}

func toolBrowserCloseTab(_ args: [String: Any]) -> String {
    if BrowserBridge.shared.isConnected {
        guard let tabId = args["tab_id"] as? Int ?? args["index"] as? Int else {
            return "error: missing required argument 'tab_id'"
        }
        return bridgeText(BrowserBridge.shared.call("close_tab", ["tabId": tabId])) { _ in
            "closed tab \(tabId)"
        }
    }
    guard let index = args["index"] as? Int else { return "error: missing required argument 'index'" }
    guard let id = Chrome.liveAgentWindowID() else {
        return "error: no agent window yet"
    }
    return Chrome.preservingFocus {
        switch Chrome.run("""
        tell application "Google Chrome"
            set w to window id \(id)
            if \(index) < 1 or \(index) > (count tabs of w) then return "out of range"
            close tab \(index) of w
            return "ok"
        end tell
        """) {
        case .failure(let e):
            return "error: \(e)"
        case .success(let s):
            return s == "out of range" ? "error: tab \(index) is out of range" : "closed tab \(index)"
        }
    }
}


// MARK: - Browser tools over the extension

/// Render a bridge reply as tool text, or the failure as an error line.
func bridgeText(_ result: BridgeOutcome, _ describe: ([String: Any]) -> String) -> String {
    switch result {
    case .failure(let message): return "error: \(message)"
    case .success(let payload): return describe(payload)
    }
}

func toolBrowserSnapshot(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    return bridgeText(BrowserBridge.shared.call("snapshot", ["tabId": tabId])) { payload in
        let elements = payload["elements"] as? [[String: Any]] ?? []
        var lines = ["\(payload["title"] as? String ?? "?")  [\(payload["url"] as? String ?? "")]"]
        for element in elements {
            let index = element["i"] as? Int ?? -1
            let tag = element["tag"] as? String ?? "?"
            let label = element["label"] as? String ?? ""
            let offscreen = (element["inView"] as? Bool == false) ? "  (scrolled out of view)" : ""
            lines.append("  [\(index)] \(tag)\(label.isEmpty ? "" : " \"\(label)\"")\(offscreen)")
        }
        return lines.joined(separator: "\n")
    }
}

func toolBrowserClick(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    var params: [String: Any] = ["tabId": tabId]
    if let index = args["index"] as? Int {
        params["index"] = index
    } else if let x = args["x"] as? Double, let y = args["y"] as? Double {
        params["x"] = x
        params["y"] = y
    } else {
        return "error: provide either index (from browser_snapshot), or both x and y"
    }
    // The Chrome extension paints the same agent pointer into the page. Keep
    // that as the source of truth for tab clicks — background tabs are not
    // composited, so a desktop overlay at guessed screen coords would lie.
    return bridgeText(BrowserBridge.shared.call("click", params)) { payload in
        var line = "clicked in tab \(tabId)"
        if let cursor = payload["cursor"] as? [String: Any] {
            if cursor["ok"] as? Bool == true {
                let glow = cursor["hasGlow"] as? Bool == true ? "glow" : "no-glow"
                let fill = cursor["darkFill"] as? Bool == true ? "dark-fill" : "fill"
                line += " (pointer \(glow), \(fill))"
            } else if let reason = cursor["reason"] as? String {
                line += " (pointer missing: \(reason))"
            }
        }
        return line
    }
}

func toolBrowserType(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    guard let text = args["text"] as? String else { return "error: missing required argument 'text'" }
    return bridgeText(BrowserBridge.shared.call("type", ["tabId": tabId, "text": text])) { _ in
        "typed \(text.count) characters into tab \(tabId)"
    }
}

func toolBrowserPressKey(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    guard let key = args["key"] as? String else { return "error: missing required argument 'key'" }
    return bridgeText(BrowserBridge.shared.call("press", ["tabId": tabId, "key": key])) { _ in
        "pressed \(key) in tab \(tabId)"
    }
}

func toolBrowserCloseAllTabs(_ args: [String: Any]) -> String {
    guard BrowserBridge.shared.isConnected else {
        return "error: the MT Desktop MCP Chrome extension is not connected"
    }
    return bridgeText(BrowserBridge.shared.call("close_all_tabs")) { payload in
        let closed = payload["closed"] as? Int ?? 0
        let released = payload["released"] as? Int ?? 0
        var parts: [String] = []
        if closed > 0 { parts.append("closed \(closed) agent tab\(closed == 1 ? "" : "s") and removed the tab group") }
        if released > 0 { parts.append("released \(released) of the user's tab\(released == 1 ? "" : "s") back to them") }
        return parts.isEmpty ? "nothing to clean up — the agent had no tabs open" : parts.joined(separator: ", ")
    }
}

func toolBrowserNavigate(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    guard let url = args["url"] as? String else { return "error: missing required argument 'url'" }
    return bridgeText(BrowserBridge.shared.call("navigate", ["tabId": tabId, "url": url])) { _ in
        "navigated tab \(tabId) to \(url)"
    }
}

/// Whole-browser tab list for the no-extension path. The accessibility
/// fallback cannot hand a tab to the agent, but showing what is open still
/// tells the model (and the user) what is there.
func listEveryChromeTabViaAppleScript() -> String {
    return Chrome.preservingFocus {
        switch Chrome.run("""
        tell application "Google Chrome"
            set out to ""
            repeat with w in windows
                set out to out & "window " & (id of w as string) & ":" & linefeed
                set activeIndex to active tab index of w
                repeat with i from 1 to (count tabs of w)
                    set t to tab i of w
                    set marker to "  "
                    if i is activeIndex then set marker to "* "
                    set out to out & marker & (i as string) & ". " & (title of t) & "  [" & (URL of t) & "]" & linefeed
                end repeat
            end repeat
            return out
        end tell
        """) {
        case .failure(let e):
            return "error: \(e)"
        case .success(let s):
            let body = s.isEmpty ? "  (no tabs)" : s
            return "every Chrome tab (* = active in its window):\n" + body
                + "\nthe Chrome extension is not connected, so the agent cannot take one of these over"
        }
    }
}

func toolBrowserUseTab(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    guard BrowserBridge.shared.isConnected else {
        return "error: taking over one of the user's tabs needs the MT Desktop MCP Chrome extension, "
            + "which is not connected. Without it, use browser_open_tab, or drive Chrome with "
            + "get_app_state + click."
    }
    return bridgeText(BrowserBridge.shared.call("use_tab", ["tabId": tabId])) { payload in
        let title = payload["title"] as? String ?? ""
        let url = payload["url"] as? String ?? ""
        let adopted = payload["adopted"] as? Bool ?? false
        if !adopted {
            return "tab \(tabId) was already the agent's — nothing to take over"
        }
        return "now driving the user's tab \(tabId) — \(title)  [\(url)]. It stayed where it was; "
            + "call browser_release_tab when done, and never browser_close_tab it."
    }
}

func toolBrowserReleaseTab(_ args: [String: Any]) -> String {
    guard let tabId = args["tab_id"] as? Int else { return "error: missing required argument 'tab_id'" }
    guard BrowserBridge.shared.isConnected else {
        return "error: the MT Desktop MCP Chrome extension is not connected"
    }
    return bridgeText(BrowserBridge.shared.call("release_tab", ["tabId": tabId])) { _ in
        "released tab \(tabId) back to the user"
    }
}

func describeTabs(_ payload: [String: Any]) -> String {
    let tabs = payload["tabs"] as? [[String: Any]] ?? []
    let everyTab = (payload["scope"] as? String) == "all"
    if tabs.isEmpty {
        return everyTab ? "Chrome has no tabs open" : "the agent has no tabs open yet — call browser_open_tab"
    }
    let count = "\(tabs.count) tab\(tabs.count == 1 ? "" : "s")"
    var lines = [everyTab ? "every Chrome tab (\(count)):" : "agent tab group (\(count)):"]
    for tab in tabs {
        let marker = (tab["active"] as? Bool == true) ? "* " : "  "
        var line = "\(marker)tab_id=\(tab["tabId"] as? Int ?? -1)  \(tab["title"] as? String ?? "")"
            + "  [\(tab["url"] as? String ?? "")]"
        // Only the whole-browser view mixes ownership, so only it needs the tag.
        if everyTab {
            if tab["adopted"] as? Bool == true {
                line += "  (agent is driving this — the user's tab)"
            } else if tab["owned"] as? Bool == true {
                line += "  (agent's own tab)"
            } else if tab["otherAgent"] as? Bool == true {
                line += "  (another agent's tab)"
            } else if tab["attachable"] as? Bool == false {
                line += "  (Chrome page — cannot be automated)"
            } else {
                line += "  (the user's — browser_use_tab to drive it)"
            }
        }
        lines.append(line)
    }
    if everyTab {
        lines.append("* = active in its window")
    }
    return lines.joined(separator: "\n")
}

// MARK: - Tool schemas

func obj(_ d: [String: Any]) -> [String: Any] { d }

let toolDefs: [[String: Any]] = [
    [
        "name": "list_apps",
        "description": "List running applications with their bundle id, pid, window count, and which one is frontmost. Call it first to learn the exact `app` value that get_app_state, screenshot and activate_app accept. One app can have several running instances and only some own windows, so prefer the instance that has windows. Read-only: no window or input is touched.",
        "inputSchema": [
            "type": "object",
            "properties": [:] as [String: Any],
        ],
        "annotations": [
            "title": "List running apps",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "get_app_state",
        "description": "Read an app's accessibility tree as an indented outline in which interactive elements carry ids like [e12] that click, type_text, set_value, scroll, hover and select_text accept. Use it instead of screenshot whenever you intend to act: it is far cheaper in tokens and gives exact targets. Call it before interacting and again after the UI changes, because ids are per-snapshot and a stale id fails. Read-only; it describes the app's visible windows and does not change focus.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "app": [
                    "type": "string",
                    "description": "App name, bundle id, or pid exactly as reported by list_apps",
                ],
                "max_depth": [
                    "type": "integer",
                    "description": "Maximum nesting depth to descend (default 18). Lower it for a quick overview of a large window.",
                ],
                "max_elements": [
                    "type": "integer",
                    "description": "Maximum elements to emit before the outline is truncated (default 800). Prefer `query` over raising this.",
                ],
                "window": [
                    "type": ["integer", "string"],
                    "description": "Limit to one window: a 0-based index, or \"agent\" for the browser window this agent owns",
                ],
                "query": [
                    "type": "string",
                    "description": "Only list elements whose role, label or value contains this text (case-insensitive). Ids stay valid. Use it instead of raising max_elements when you know what you are looking for.",
                ],
            ],
            "required": ["app"],
        ],
        "annotations": [
            "title": "Read accessibility tree",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "click",
        "description": "Click an element by element_id (preferred: it uses the accessibility press action, so it works even when the element is scrolled out of view) or at absolute screen coordinates taken from a screenshot or zoom. Pass element_id or x and y, not both. Use browser_click for pages in the agent's Chrome tabs, right_click for context menus, and drag for press-move-release. The click reaches the target app for real and can trigger any action the user could, so read the target with get_app_state first. The agent's own pointer overlay moves to the target. On macOS the user's mouse pointer never moves; on Windows and Linux a target that ignores background input gets real mouse input, which moves the user's pointer, and the result then says via cursor.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "element_id": [
                    "type": "string",
                    "description": "Element id from the most recent get_app_state snapshot, e.g. e12. Preferred over coordinates.",
                ],
                "x": [
                    "type": "number",
                    "description": "Screen x coordinate in points, used together with y when no element_id is given",
                ],
                "y": [
                    "type": "number",
                    "description": "Screen y coordinate in points, used together with x when no element_id is given",
                ],
                "click_count": [
                    "type": "integer",
                    "description": "1 for a single click (default), 2 for a double-click",
                ],
            ],
        ],
        "annotations": [
            "title": "Click",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "type_text",
        "description": "Type literal text as keystrokes into the field that currently has focus, optionally focusing element_id first. Use it for short entries and for fields that reject set_value; use set_value to replace a long value in one step, and press_key for shortcuts or keys such as return and tab. Text is inserted at the caret without clearing what is already there. Typing into password fields is refused by default (see COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT).",
        "inputSchema": [
            "type": "object",
            "properties": [
                "text": [
                    "type": "string",
                    "description": "Exact text to type, character by character",
                ],
                "element_id": [
                    "type": "string",
                    "description": "Element to focus before typing, from get_app_state. Omit to type into whatever currently has focus.",
                ],
            ],
            "required": ["text"],
        ],
        "annotations": [
            "title": "Type text",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "press_key",
        "description": "Press one named key, optionally with modifiers held, e.g. key='s' modifiers=['cmd'] to save or key='return' to submit. Use it for shortcuts and navigation keys; use type_text for literal text and browser_press_key inside the agent's Chrome tabs. The key goes to the focused app, so call activate_app or click first when focus is uncertain. Shortcuts can close windows or delete content, so confirm the target before pressing.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "key": [
                    "type": "string",
                    "description": "Key name: a single character such as 's' or '/' (resolved through the current keyboard layout), or a named key: return, tab, escape, space, delete, backspace, forwarddelete, up, down, left, right, home, end, pageup, pagedown, insert, f1 to f20, punctuation names (minus, equal, leftbracket, rightbracket, backslash, semicolon, quote, comma, period, slash, grave), numpad0 to numpad9, numpadadd, numpadsubtract, numpadmultiply, numpaddivide, numpaddecimal, numpadenter",
                ],
                "modifiers": [
                    "type": "array",
                    "items": [
                        "type": "string",
                    ],
                    "description": "Modifier keys to hold while pressing: any of cmd, shift, alt, ctrl, fn. cmd maps to the Windows/Super key off macOS.",
                ],
            ],
            "required": ["key"],
        ],
        "annotations": [
            "title": "Press key",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "scroll",
        "description": "Scroll up, down, left or right by a number of lines, over element_id when given so the right pane scrolls. Use it to bring off-screen content into view before get_app_state or screenshot. It only scrolls; nothing is clicked or selected. On macOS it scrolls the target app in the background without moving the user's pointer. On Windows and Linux, without element_id it scrolls whatever is under the user's pointer, and an element with no background route gets the real pointer moved onto it (the result then says via cursor).",
        "inputSchema": [
            "type": "object",
            "properties": [
                "direction": [
                    "type": "string",
                    "enum": ["up", "down", "left", "right"],
                    "description": "Scroll direction (default down)",
                ],
                "amount": [
                    "type": "integer",
                    "description": "Number of scroll lines, 1 to 100 (default 5)",
                ],
                "element_id": [
                    "type": "string",
                    "description": "Element to scroll, from get_app_state; the nearest scrollable area around it moves. Omit to scroll the last inspected app (macOS) or whatever is under the pointer (Windows, Linux).",
                ],
                "x": [
                    "type": "number",
                    "description": "Screen x to scroll over. Remote control only: the pointer moves there first. Ignored otherwise.",
                ],
                "y": [
                    "type": "number",
                    "description": "Screen y to scroll over. Remote control only: the pointer moves there first. Ignored otherwise.",
                ],
            ],
        ],
        "annotations": [
            "title": "Scroll",
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": false,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "activate_app",
        "description": "Bring an app's windows to the foreground and give it keyboard focus. Call it before press_key or type_text when the target app is not frontmost; element-id actions such as click and set_value do not need it. Side effect: the window the user was working in loses focus.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "app": [
                    "type": "string",
                    "description": "App name, bundle id, or pid exactly as reported by list_apps",
                ],
            ],
            "required": ["app"],
        ],
        "annotations": [
            "title": "Activate app",
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "screenshot",
        "description": "Capture an app's largest window, or a whole display, as an image. The result text states the capture's screen origin and pixels-per-point so an image pixel can be converted into click or hover coordinates. Prefer get_app_state for interaction, which is cheaper and returns clickable element ids; use screenshot to verify an outcome or to see content the accessibility tree cannot describe (canvas, video, custom drawing), and zoom to read small text. Read-only; the captured window is not raised or focused.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "app": [
                    "type": "string",
                    "description": "App name, bundle id, or pid exactly as reported by list_apps. Captures that app's largest window. Provide either app or display.",
                ],
                "display": [
                    "type": "integer",
                    "description": "0-based display index from list_displays. Captures the whole display instead of an app window.",
                ],
                "max_width": [
                    "type": "integer",
                    "description": "Downscale the image to this width in pixels (default 1400). Lower it to save tokens.",
                ],
            ],
        ],
        "annotations": [
            "title": "Screenshot",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "list_displays",
        "description": "List every attached display with its index, resolution and position, for use with screenshot(display: N) and for interpreting screen coordinates on multi-monitor setups. Read-only.",
        "inputSchema": [
            "type": "object",
            "properties": [:] as [String: Any],
        ],
        "annotations": [
            "title": "List displays",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "right_click",
        "description": "Right-click (secondary click) an element or screen position to open its context menu. Follow with get_app_state to read the menu items, then click one. Use click for normal activation. Pass element_id or x and y, not both. The user's pointer is treated as for click.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "element_id": [
                    "type": "string",
                    "description": "Element id from the most recent get_app_state snapshot, e.g. e12",
                ],
                "x": [
                    "type": "number",
                    "description": "Screen x coordinate in points, used together with y when no element_id is given",
                ],
                "y": [
                    "type": "number",
                    "description": "Screen y coordinate in points, used together with x when no element_id is given",
                ],
            ],
        ],
        "annotations": [
            "title": "Right-click",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "drag",
        "description": "Press at one point, move, and release at another to drag and drop, move a slider, or select a range. Give each end as an element id or as screen coordinates; the two ends may use different forms. A drop can move or reorder items in the app, so verify the result with get_app_state. On macOS a drag must stay inside one app window and never moves the user's pointer; on Windows and Linux most drags use real mouse input, which moves the user's pointer (the result then says via cursor).",
        "inputSchema": [
            "type": "object",
            "properties": [
                "from_element_id": [
                    "type": "string",
                    "description": "Element to start the drag on, from get_app_state",
                ],
                "to_element_id": [
                    "type": "string",
                    "description": "Element to release on, from get_app_state",
                ],
                "from_x": [
                    "type": "number",
                    "description": "Screen x to start at, used with from_y when no from_element_id is given",
                ],
                "from_y": [
                    "type": "number",
                    "description": "Screen y to start at, used with from_x when no from_element_id is given",
                ],
                "to_x": [
                    "type": "number",
                    "description": "Screen x to release at, used with to_y when no to_element_id is given",
                ],
                "to_y": [
                    "type": "number",
                    "description": "Screen y to release at, used with to_x when no to_element_id is given",
                ],
            ],
        ],
        "annotations": [
            "title": "Drag",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "set_value",
        "description": "Replace a text field's entire contents in one step through the accessibility API, without keystrokes. Prefer it over type_text for long values or when the field already holds text; fall back to click plus type_text if the field rejects it, which the result reports. The previous value is discarded.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "element_id": [
                    "type": "string",
                    "description": "Text field to set, from get_app_state",
                ],
                "value": [
                    "type": "string",
                    "description": "New complete value for the field",
                ],
            ],
            "required": ["element_id", "value"],
        ],
        "annotations": [
            "title": "Set field value",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "zoom",
        "description": "Capture one region of the screen at full resolution, to read small text, dense tables, file names or tiny controls that a normal screenshot blurs. Give the region as two corners in screen coordinates (the same space click uses); the result text explains how to map pixels in the zoomed image back to screen coordinates. Use screenshot for a whole window and get_app_state when the text is exposed by accessibility. Read-only.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "x0": [
                    "type": "number",
                    "description": "Left edge, screen coordinates",
                ],
                "y0": [
                    "type": "number",
                    "description": "Top edge, screen coordinates",
                ],
                "x1": [
                    "type": "number",
                    "description": "Right edge, screen coordinates",
                ],
                "y1": [
                    "type": "number",
                    "description": "Bottom edge, screen coordinates",
                ],
                "max_width": [
                    "type": "integer",
                    "description": "Downscale the zoomed image to this width in pixels (default 1400)",
                ],
            ],
            "required": ["x0", "y0", "x1", "y1"],
        ],
        "annotations": [
            "title": "Zoom into region",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "hover",
        "description": "Move the agent pointer over an element or screen position without clicking, to reveal hover menus, toolbars, tooltips or drag handles. Follow with get_app_state or screenshot to see what appeared. Use click to activate. Pass element_id or x and y, not both. On macOS the user's own mouse pointer is not moved; on Windows and Linux it may be, and the result then says via cursor.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "element_id": [
                    "type": "string",
                    "description": "Element id from the most recent get_app_state snapshot, e.g. e12",
                ],
                "x": [
                    "type": "number",
                    "description": "Screen x coordinate in points, used together with y when no element_id is given",
                ],
                "y": [
                    "type": "number",
                    "description": "Screen y coordinate in points, used together with x when no element_id is given",
                ],
            ],
        ],
        "annotations": [
            "title": "Hover",
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "wait",
        "description": "Pause before the next action so the UI can catch up: page loads, animations, dialogs opening, apps launching. Follow with get_app_state or screenshot to confirm the new state instead of guessing. Sends no input.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "seconds": [
                    "type": "number",
                    "description": "Seconds to wait (default 1, maximum 30)",
                ],
            ],
        ],
        "annotations": [
            "title": "Wait",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "select_text",
        "description": "Select a character range inside a text element through the accessibility API, for example to copy part of a value or to replace just that part with type_text. Defaults to selecting from `start` to the end of the value. Use set_value to replace the whole value instead. Only the selection changes; the text is not modified.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "element_id": [
                    "type": "string",
                    "description": "Text element to select in, from get_app_state",
                ],
                "start": [
                    "type": "integer",
                    "description": "Zero-based character offset to start the selection at (default 0)",
                ],
                "length": [
                    "type": "integer",
                    "description": "Number of characters to select (default: through the end of the value)",
                ],
            ],
            "required": ["element_id"],
        ],
        "annotations": [
            "title": "Select text",
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "clipboard_read",
        "description": "Read the plain text on the system clipboard, for example after press_key cmd+c (ctrl+c off macOS) copied a selection, or when the user says they copied something for you. Prefer get_app_state, browser_snapshot or screenshot to read what is on screen; use this for text that was deliberately copied. Images and files on the clipboard are reported as no text. Read-only, but the clipboard can hold private data the user copied, such as passwords, so do not repeat it beyond what the task needs.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "max_chars": [
                    "type": "integer",
                    "description": "Maximum characters to return (default 20000, maximum 200000). Longer text is cut off with a note giving its full length.",
                ],
            ],
        ],
        "annotations": [
            "title": "Read clipboard",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "clipboard_write",
        "description": "Replace the system clipboard with plain text, typically so a long or multi-line value can be pasted with press_key cmd+v (ctrl+v off macOS) where set_value is rejected and type_text would be slow. This tool does not paste anything itself. Side effect: whatever the user had on the clipboard is overwritten and not restored, so tell the user when you use it. Prefer set_value or type_text when they work.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "text": [
                    "type": "string",
                    "description": "Exact text to place on the clipboard, replacing its current contents",
                ],
            ],
            "required": ["text"],
        ],
        "annotations": [
            "title": "Write clipboard",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "browser_open_tab",
        "description": "Open a URL in a new background tab inside the agent's own labelled tab group in the user's signed-in Chrome, and return its tab_id for browser_snapshot, browser_click, browser_type and browser_navigate. The tab opens in the background, so the user's browsing is not interrupted. Use browser_use_tab instead when the user already has the page open and signed in. Requires the Computer Use Chrome extension; a limited fallback mode applies without it.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "url": [
                    "type": "string",
                    "description": "Absolute URL to open (default about:blank)",
                ],
            ],
        ],
        "annotations": [
            "title": "Open browser tab",
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": false,
            "openWorldHint": true,
        ],
    ],
    [
        "name": "browser_list_tabs",
        "description": "List the tabs in the agent's own Chrome tab group, marking the active one, with the tab_id each other browser tool needs. Pass all=true to see every tab open in the browser, including the user's, so you can pick one to drive with browser_use_tab. Read-only.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "all": [
                    "type": "boolean",
                    "description": "List every tab in the browser, not just the agent's (default false)",
                ],
            ],
        ],
        "annotations": [
            "title": "List browser tabs",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "browser_use_tab",
        "description": "Take over a tab the user already has open, instead of opening a new one. Use this when the page is already signed in or mid-flow — a checkout, a draft, a dashboard behind SSO — and re-opening the URL would lose that state. Find the tab_id with browser_list_tabs all=true. The tab stays exactly where it is in the user's window; it is not moved into the agent's group, not activated, and not reloaded. It is never closed by cleanup — call browser_release_tab to hand it back. Ask the user before taking over a tab they are actively working in.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": [
                    "type": "integer",
                    "description": "tab_id of the user's tab, from browser_list_tabs all=true",
                ],
            ],
            "required": ["tab_id"],
        ],
        "annotations": [
            "title": "Adopt user's tab",
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
        ],
    ],
    [
        "name": "browser_release_tab",
        "description": "Hand a tab taken over with browser_use_tab back to the user: the agent stops driving it and the page is left exactly as it is. Call it as soon as you are done with an adopted tab. Use browser_close_tab for tabs the agent opened itself.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": [
                    "type": "integer",
                    "description": "tab_id of a tab previously adopted with browser_use_tab",
                ],
            ],
            "required": ["tab_id"],
        ],
        "annotations": [
            "title": "Release adopted tab",
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "browser_select_tab",
        "description": "Make one of the agent's tabs the visible one in its window, for example before capturing it with screenshot. browser_snapshot, browser_click and browser_type work on background tabs, so most tasks never need this. The agent's group lives in the user's Chrome window, so this changes which tab that window shows; use it sparingly. The user's own tabs are never selected.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": [
                    "type": "integer",
                    "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs",
                ],
                "index": [
                    "type": "integer",
                    "description": "1-based position within the agent's tabs; fallback mode only, when tab_id is unavailable",
                ],
            ],
        ],
        "annotations": [
            "title": "Select browser tab",
            "readOnlyHint": false,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "browser_close_tab",
        "description": "Close one of the agent's tabs, discarding any unsaved page state. A tab taken over with browser_use_tab is released rather than closed — it belongs to the user. Use browser_close_all_tabs to clean up everything at the end of a task.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": [
                    "type": "integer",
                    "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs",
                ],
                "index": [
                    "type": "integer",
                    "description": "1-based position within the agent's tabs; fallback mode only, when tab_id is unavailable",
                ],
            ],
        ],
        "annotations": [
            "title": "Close browser tab",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "browser_snapshot",
        "description": "List the interactive elements (links, buttons, inputs) on the page in one of the agent's tabs, with the index each one has for browser_click, plus the page title and URL. Works on a background tab, so the user can be looking at something else. Use it before every browser_click, because indices change when the page changes. Read-only.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": [
                    "type": "integer",
                    "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs",
                ],
            ],
            "required": ["tab_id"],
        ],
        "annotations": [
            "title": "Snapshot page elements",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": true,
        ],
    ],
    [
        "name": "browser_click",
        "description": "Click in one of the agent's tabs, either an element by its index from browser_snapshot (preferred) or a point given in page coordinates. Pass index or x and y, not both. Works on a background tab. Use click for native app windows. A click can submit forms or follow links, so snapshot first.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": [
                    "type": "integer",
                    "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs",
                ],
                "index": [
                    "type": "integer",
                    "description": "Element index from the latest browser_snapshot of this tab. Preferred over coordinates.",
                ],
                "x": [
                    "type": "number",
                    "description": "Page x coordinate in CSS pixels, used together with y when no index is given",
                ],
                "y": [
                    "type": "number",
                    "description": "Page y coordinate in CSS pixels, used together with x when no index is given",
                ],
            ],
            "required": ["tab_id"],
        ],
        "annotations": [
            "title": "Click in browser",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": true,
        ],
    ],
    [
        "name": "browser_type",
        "description": "Type text into the field that currently has focus in one of the agent's tabs; browser_click the field first. Text is inserted at the caret without clearing existing content. Use browser_press_key for Enter, Tab, Escape or Backspace, and type_text for native apps.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": [
                    "type": "integer",
                    "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs",
                ],
                "text": [
                    "type": "string",
                    "description": "Exact text to type into the focused field",
                ],
            ],
            "required": ["tab_id", "text"],
        ],
        "annotations": [
            "title": "Type in browser",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "browser_press_key",
        "description": "Press Enter, Tab, Escape or Backspace in one of the agent's tabs, for example Enter to submit a form after browser_type. Only these four keys are supported; use browser_type for characters. Enter can submit forms and Backspace deletes, so check the page state with browser_snapshot first.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": [
                    "type": "integer",
                    "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs",
                ],
                "key": [
                    "type": "string",
                    "enum": ["Enter", "Tab", "Escape", "Backspace"],
                    "description": "Key to press",
                ],
            ],
            "required": ["tab_id", "key"],
        ],
        "annotations": [
            "title": "Press key in browser",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "browser_close_all_tabs",
        "description": "Close every tab the agent opened and remove its tab group. Tabs taken over with browser_use_tab are released back to the user, not closed. Call this when finished with the browser so no empty group is left in the user's tab strip. The MCP process also runs this automatically when the Computer Use session ends. Unsaved state in the agent's tabs is lost.",
        "inputSchema": [
            "type": "object",
            "properties": [:] as [String: Any],
        ],
        "annotations": [
            "title": "Close all agent tabs",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": true,
            "openWorldHint": false,
        ],
    ],
    [
        "name": "browser_navigate",
        "description": "Point one of the agent's tabs at a different URL, replacing the current page; unsaved page state is lost. Use browser_open_tab to keep the current page and open another. Follow with browser_snapshot, since element indices reset after navigation.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "tab_id": [
                    "type": "integer",
                    "description": "tab_id of one of the agent's tabs, from browser_open_tab or browser_list_tabs",
                ],
                "url": [
                    "type": "string",
                    "description": "Absolute URL to load in the tab",
                ],
            ],
            "required": ["tab_id", "url"],
        ],
        "annotations": [
            "title": "Navigate browser tab",
            "readOnlyHint": false,
            "destructiveHint": true,
            "idempotentHint": false,
            "openWorldHint": true,
        ],
    ],
]

func advertisedToolDefs() -> [[String: Any]] {
    let visible = browserControlEnabled ? toolDefs : toolDefs.filter { tool in
        guard let name = tool["name"] as? String else { return true }
        return !name.hasPrefix("browser_")
    }
    // Newer protocol revisions read a top-level title; older clients read
    // annotations.title. Derive one from the other so they cannot drift.
    return visible.map { tool in
        var tool = tool
        if let title = (tool["annotations"] as? [String: Any])?["title"] { tool["title"] = title }
        return tool
    }
}

// MARK: - Server identity

let serverVersion = "0.4.1"
/// Protocol revisions this server speaks. A client asking for one gets it
/// echoed back; anything else gets the oldest, which every client understands.
let supportedProtocolVersions: Set<String> = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]
let fallbackProtocolVersion = "2024-11-05"

func negotiatedProtocolVersion(_ params: [String: Any]) -> String {
    if let requested = params["protocolVersion"] as? String, supportedProtocolVersions.contains(requested) {
        return requested
    }
    return fallbackProtocolVersion
}

/// Returned in the `initialize` result; identical in the Rust server.
let serverInstructions = "Munim Computer Use operates this computer's desktop apps and, through the browser_* tools, the user's signed-in Chrome. Look, act, verify: call list_apps to find the app, then get_app_state (narrow it with query) before acting, and act on element ids such as e12 rather than screen coordinates. Ids belong to one snapshot, so call get_app_state again after the UI changes. Use screenshot to check a result or to see content the accessibility tree cannot describe, and zoom to read small text. Where the platform allows, input is delivered to the target app in the background and the agent has its own pointer, so the user can keep working; call activate_app only when a keystroke needs keyboard focus. For web pages prefer the browser_* tools, which work in the agent's own tab group, and release any tab adopted with browser_use_tab when done. Ask the user before anything irreversible, such as sending, deleting, purchasing or submitting forms on their behalf."

// MARK: - Clipboard

func toolClipboardRead(_ args: [String: Any]) -> String {
    let maxChars = min(max((args["max_chars"] as? Int) ?? 20_000, 1), 200_000)
    // NSPasteboard is AppKit; keep it on the main thread like activate.
    let text = DispatchQueue.main.sync { NSPasteboard.general.string(forType: .string) }
    guard let text, !text.isEmpty else { return "(the clipboard holds no text)" }
    let total = text.count
    if total <= maxChars { return text }
    return String(text.prefix(maxChars))
        + "\n… truncated: showing \(maxChars) of \(total) characters; raise max_chars to read more"
}

func toolClipboardWrite(_ args: [String: Any]) -> String {
    guard let text = args["text"] as? String else { return "error: missing required argument 'text'" }
    let written = DispatchQueue.main.sync { () -> Bool in
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        return pasteboard.setString(text, forType: .string)
    }
    guard written else { return "error: could not write the clipboard" }
    return "copied \(text.count) characters to the clipboard, replacing what was there"
}

func dispatch(_ name: String, _ args: [String: Any]) -> String {
    if name.hasPrefix("browser_"), !browserControlEnabled {
        return "error: browser control is disabled in Computer Use settings"
    }
    switch name {
    case "list_apps": return toolListApps()
    case "get_app_state": return toolGetAppState(args)
    case "click": return toolClick(args)
    case "type_text": return toolTypeText(args)
    case "press_key": return toolPressKey(args)
    case "scroll": return toolScroll(args)
    case "activate_app": return toolActivateApp(args)
    case "list_displays": return toolListDisplays(args)
    case "right_click": return toolRightClick(args)
    case "drag": return toolDrag(args)
    case "set_value": return toolSetValue(args)
    case "select_text": return toolSelectText(args)
    case "hover": return toolHover(args)
    case "wait": return toolWait(args)
    case "clipboard_read": return toolClipboardRead(args)
    case "clipboard_write": return toolClipboardWrite(args)
    case "browser_open_tab": return toolBrowserOpenTab(args)
    case "browser_list_tabs": return toolBrowserListTabs(args)
    case "browser_use_tab": return toolBrowserUseTab(args)
    case "browser_release_tab": return toolBrowserReleaseTab(args)
    case "browser_select_tab": return toolBrowserSelectTab(args)
    case "browser_close_tab": return toolBrowserCloseTab(args)
    case "browser_snapshot": return toolBrowserSnapshot(args)
    case "browser_click": return toolBrowserClick(args)
    case "browser_type": return toolBrowserType(args)
    case "browser_press_key": return toolBrowserPressKey(args)
    case "browser_navigate": return toolBrowserNavigate(args)
    case "browser_close_all_tabs": return toolBrowserCloseAllTabs(args)
    default: return "error: unknown tool \(name)"
    }
}

// MARK: - Agent cursor overlay
//
// The drawing lives in the MunimAgentCursor.app child (see AgentCursor.swift).
// This facade keeps the older call sites (`CursorOverlay.shared.press`) pointed
// at the bundle that actually puts a window up.

final class CursorOverlay {
    static let shared = CursorOverlay()

    /// Move the agent cursor to a Quartz screen point.
    func show(at point: CGPoint) { AgentCursor.shared.show(at: point) }

    /// Move the agent pointer.
    func press(at point: CGPoint) { AgentCursor.shared.press(at: point) }

    /// Non-blocking hop for mid-drag visuals.
    func glide(at point: CGPoint) { AgentCursor.shared.glide(at: point) }
}

// MARK: - JSON-RPC over stdio

func send(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func respond(id: Any, result: [String: Any]) {
    send(["jsonrpc": "2.0", "id": id, "result": result])
}

func respondError(id: Any, code: Int, message: String) {
    send(["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]])
}

func textResult(_ s: String, isError: Bool = false) -> [String: Any] {
    ["content": [["type": "text", "text": s]], "isError": isError]
}

// `--profile` may appear anywhere; it is consumed first so every mode below
// (server, native host, history recorder, overlay) runs under one identity.
let cliArguments = Identity.bootstrap(CommandLine.arguments)
let cliMode = cliArguments.count > 1 ? cliArguments[1] : nil

// Chrome launches this same binary as its native messaging host; in that mode
// it is a relay, not an MCP server.
if cliArguments.contains("native-host") { NativeHost.run() }
// Register this binary with Chrome for the current identity.
if cliMode == "install-native-host" { NativeHostInstaller.run(Array(cliArguments.dropFirst(2))) }
// Print the resolved identity (paths, names) as JSON, for embedders to check.
if cliMode == "identity" {
    if let data = try? JSONSerialization.data(
        withJSONObject: Identity.current.describe(),
        options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
        let text = String(data: data, encoding: .utf8)
    {
        print(text)
    }
    exit(0)
}
// Computer History background recorder (Skysight-style interaction events).
if cliArguments.contains("computer-history") {
    let args = cliArguments
    if let flag = args.firstIndex(of: "--root"), args.index(after: flag) < args.endIndex {
        ComputerHistoryDaemon.run(root: args[args.index(after: flag)])
    }
    if let root = Identity.current.historyDirectory { ComputerHistoryDaemon.run(root: root) }
    fputs("munim-computer-use: computer-history requires --root <dir> (or a historyDir in the profile)\n", stderr)
    exit(2)
}
// Ask macOS for the permissions Computer Use needs, from inside the app bundle
// so TCC records them against the app rather than whatever spawned us.
//
// This exists because a TCC row can outlive the signature it was granted to:
// after a re-sign, System Settings still shows the app enabled while tccd logs
// "Failed to match existing code requirement" and every AX call is refused.
// Prompting re-creates the row against the signature running now.
if cliArguments.contains("request-permissions") {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.accessory)
    let prompted = AXIsProcessTrustedWithOptions(
        [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
    )
    // Screen Recording has no prompt API; macOS only lists an app once it has
    // actually attempted a capture, so attempt one.
    let screen = CGPreflightScreenCaptureAccess()
    if !screen { _ = CGRequestScreenCaptureAccess() }
    let payload: [String: Any] = [
        "accessibility": prompted,
        "screenRecording": CGPreflightScreenCaptureAccess(),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
    exit(prompted ? 0 : 1)
}

// The agent pointer is a separate LSUIElement .app (see AgentCursor.swift)
// launched via NSWorkspace with `--socket <path>` for move/hide commands.
if cliArguments.contains("cursor-overlay") {
    let args = cliArguments
    if let flag = args.firstIndex(of: "--socket"), args.index(after: flag) < args.endIndex {
        AgentCursorOverlay.run(socketPath: args[args.index(after: flag)])
    }
    fputs("munim-computer-use: cursor-overlay requires --socket <path>\n", stderr)
    exit(2)
}

BrowserBridge.shared.start()

/// Best-effort: drop the agent Chrome tab group when this MCP process is going
/// away so aborted / unfinished Computer Use turns do not leave an empty
/// "MT Code" / "MT Code" group in the user's tab strip.
func cleanupAgentBrowserTabsOnExit() {
    guard browserControlEnabled, BrowserBridge.shared.isConnected else { return }
    _ = BrowserBridge.shared.call("close_all_tabs", timeout: 2)
}

/// SIGTERM/SIGINT often arrive before stdin EOF when the host tears down the
/// MCP child. Handle them on a Dispatch queue (not a raw signal handler) so we
/// can still talk to the Chrome bridge.
var exitCleanupSignalSources: [DispatchSourceSignal] = []
func installExitCleanupSignals() {
    for sig in [SIGTERM, SIGINT] as [Int32] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .global(qos: .userInitiated))
        source.setEventHandler {
            cleanupAgentBrowserTabsOnExit()
            AgentCursor.shared.hide()
            exit(0)
        }
        source.resume()
        exitCleanupSignalSources.append(source)
    }
}
installExitCleanupSignals()

// ScreenCaptureKit talks to the window server, which asserts (did_initialize)
// unless the process has been initialised as a GUI app. `.accessory` keeps it
// out of the Dock and app switcher while still allowing the cursor overlay
// panel; `.prohibited` would forbid windows entirely.
_ = NSApplication.shared
NSApp.setActivationPolicy(.accessory)

setvbuf(stdout, nil, _IOLBF, 0)

// The JSON-RPC loop blocks on readLine, so it cannot own the main thread: AppKit
// needs the main run loop to draw the overlay. Requests are handled on a
// background queue and UI work hops back to main.
func runJSONRPCLoop() {
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: CharacterSet.whitespaces).isEmpty { continue }
    let parsed: Any
    do {
        parsed = try JSONSerialization.jsonObject(with: Data(line.utf8))
    } catch {
        // Same reply as the Rust server: a client that sent garbage should
        // hear about it rather than wait forever on a request it thinks is live.
        fputs("munim-computer-use: malformed JSON: \(error.localizedDescription)\n", stderr)
        respondError(id: NSNull(), code: -32700, message: "Parse error: \(error.localizedDescription)")
        continue
    }
    guard let msg = parsed as? [String: Any], let method = msg["method"] as? String else {
        // Valid JSON that is not a request. Answer only when there is an id to
        // answer to (or no way to tell), never a notification.
        let id = (parsed as? [String: Any])?["id"]
        if (parsed as? [String: Any]) == nil || id != nil {
            respondError(id: id ?? NSNull(), code: -32600, message: "Invalid Request: expected a JSON-RPC object with a method")
        }
        continue
    }

    let id = msg["id"]

    switch method {
    case "initialize":
        respond(id: id ?? NSNull(), result: [
            "protocolVersion": negotiatedProtocolVersion(msg["params"] as? [String: Any] ?? [:]),
            "capabilities": ["tools": ["listChanged": false]],
            "serverInfo": [
                "name": "mt-desktop",
                "title": "Munim Computer Use",
                "version": serverVersion,
                "websiteUrl": "https://munimtech.com/computer-use",
            ],
            "instructions": serverInstructions,
        ])

    case "tools/list":
        respond(id: id ?? NSNull(), result: ["tools": advertisedToolDefs()])

    case "tools/call":
        // Pointer fade is keyed to Computer Use tool traffic: stay up while
        // tools are in flight / chained, fade once the task stops calling.
        do {
            AgentCursor.shared.noteDesktopToolStarted()
            defer { AgentCursor.shared.noteDesktopToolFinished() }

            guard let id else { break }
            let params = msg["params"] as? [String: Any] ?? [:]
            guard let name = params["name"] as? String else {
                respondError(id: id, code: -32602, message: "missing tool name")
                break
            }
            let args = params["arguments"] as? [String: Any] ?? [:]

            // Handled ahead of the Accessibility check: screen capture is gated by
            // Screen Recording, a separate permission, so screenshots should still
            // work if only that one is granted.
            if name == "wait" {
                let out = toolWait(args)
                respond(id: id, result: textResult(out, isError: out.hasPrefix("error:")))
                break
            }
            if name == "zoom" {
                guard let x0 = args["x0"] as? Double, let y0 = args["y0"] as? Double,
                      let x1 = args["x1"] as? Double, let y1 = args["y1"] as? Double,
                      x0.isFinite, y0.isFinite, x1.isFinite, y1.isFinite
                else {
                    respond(id: id, result: textResult(
                        "error: zoom needs x0, y0, x1, y1 in screen coordinates (the space click uses)",
                        isError: true))
                    break
                }
                let rect = CGRect(x: min(x0, x1), y: min(y0, y1), width: abs(x1 - x0), height: abs(y1 - y0))
                guard rect.width >= 4, rect.height >= 4 else {
                    respond(id: id, result: textResult(
                        "error: zoom region must be at least 4×4 points", isError: true))
                    break
                }
                let maxWidth = clampedMaxWidth(args)
                guard let shot = captureRegionPNG(rect: rect, maxWidth: maxWidth) else {
                    respond(id: id, result: textResult(
                        "error: could not capture that region — check Screen Recording permission and "
                        + "that the region lies on an attached display (list_displays).", isError: true))
                    break
                }
                respond(id: id, result: imageResult(shot, label: "zoomed region"))
                break
            }
            if name == "screenshot" {
                if let display = args["display"] as? Int {
                    let maxWidth = clampedMaxWidth(args)
                    guard let shot = captureDisplayPNG(index: display, maxWidth: maxWidth) else {
                        respond(id: id, result: textResult(
                            "error: could not capture display \(display) — check Screen Recording "
                            + "permission, or call list_displays for valid indices.", isError: true))
                        break
                    }
                    respond(id: id, result: imageResult(shot, label: "display \(display)"))
                    break
                }
                guard let query = args["app"] as? String, let resolved = resolveApp(query) else {
                    respond(id: id, result: textResult(
                        "error: no running app matching \(args["app"] as? String ?? "<missing app argument>")",
                        isError: true))
                    break
                }
                let maxWidth = clampedMaxWidth(args)
                guard let shot = captureWindowPNG(pid: resolved.app.processIdentifier, maxWidth: maxWidth) else {
                    respond(id: id, result: textResult(
                        "error: screen capture failed. The host app may be missing Screen Recording "
                        + "permission, or this app may have no on-screen window.",
                        isError: true))
                    break
                }
                respond(id: id, result: imageResult(
                    shot, label: "window of \(resolved.app.localizedName ?? query)"))
                break
            }

            // list_displays / browser_* do not need Accessibility — Screen
            // Recording / Chrome bridge only. Keep them ahead of the AX gate so
            // the Screen Recording-only flow can still recover (Bot finding).
            if name == "list_displays" || name.hasPrefix("browser_") || name.hasPrefix("clipboard_") {
                let out = dispatch(name, args)
                respond(id: id, result: textResult(out, isError: out.hasPrefix("error:")))
                break
            }

            if !AXIsProcessTrusted() {
                respond(id: id, result: textResult(
                    "Accessibility permission is not granted to the host app. Enable it in "
                    + "System Settings → Privacy & Security → Accessibility, then restart the app.",
                    isError: true))
                break
            }
            let out = dispatch(name, args)
            respond(id: id, result: textResult(out, isError: out.hasPrefix("error:")))
        }

    case "ping":
        respond(id: id ?? NSNull(), result: [:])

    case "notifications/cancelled":
        // Host aborted the turn — drop the pointer immediately.
        AgentCursor.shared.hide()

    default:
        // Notifications carry no id and require no reply.
        if let id { respondError(id: id, code: -32601, message: "method not found: \(method)") }
    }
}
    // stdin closed: the client is gone, so the process should follow.
    cleanupAgentBrowserTabsOnExit()
    AgentCursor.shared.hide()
    exit(0)
}

DispatchQueue.global(qos: .userInitiated).async { runJSONRPCLoop() }
NSApp.run()
