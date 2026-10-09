import AppKit
import ApplicationServices
import VirtualDisplay

// MARK: - Background control of minimized and hidden windows
//
// Accessibility actions (AXPress, setting a value) work on a minimized window
// as it is. Anything that needs events or pixels does not: a minimized window
// takes no clicks or keys and has nothing to capture, and neither do the
// windows of a hidden app. Bringing them back on screen would put them in the
// user's way, so they are moved to an invisible display instead, where they
// render and take input while nobody sees them.
//
// Windows move only while out of sight (minimized or hidden), so the user
// never sees them travel. They go back the way they were when the agent turns
// to another app or has been idle for a while. If the user brings the app up
// themselves, the windows come back to where they were, on screen, because
// that is what the user asked for.

final class WindowParking: @unchecked Sendable {
    static let shared = WindowParking()

    /// Put the windows back after this long without an action on them.
    static let idleRestore: TimeInterval = 20

    private struct Parked {
        let window: AXUIElement
        let wid: UInt32
        let home: CGPoint
        let parkedAt: CGPoint
    }

    private let lock = NSRecursiveLock()
    private var display: CGDirectDisplayID = 0
    private var pid: pid_t?
    private var parked: [Parked] = []
    private var unminimized: AXUIElement?
    private var unhid = false
    private var lastUse = Date.distantPast
    private var idleTimer: DispatchSourceTimer?
    private var activationObserver: NSObjectProtocol?
    /// The app in front when windows were parked, which an app that activates
    /// itself in reaction to the agent's input hands the front back to.
    private var front: NSRunningApplication?

    private init() {}

    /// The invisible display, while one exists; kept out of display listings.
    var displayID: CGDirectDisplayID? { lock.withLock { display == 0 ? nil : display } }

    var enabled: Bool { !envFlagDisabled("PARK_WINDOWS") }

    /// Make `pid`'s window reachable by events and capture. Returns nil when it
    /// is (on screen already, or parked now), otherwise why not.
    func reach(pid: pid_t, window: AXUIElement?) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            return "the app is no longer running"
        }
        let name = app.localizedName ?? "The app"
        if self.pid == pid, !parked.isEmpty {
            lastUse = Date()
            return nil
        }
        let windows = (axCopy(AXUIElementCreateApplication(pid), kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        let hidden = app.isHidden
        let minimized = { (w: AXUIElement) in axBool(w, kAXMinimizedAttribute as String) == true }
        // The window to bring: the one asked for, else any when none is open.
        let wanted = window.flatMap { minimized($0) ? $0 : nil }
            ?? (windows.contains { !minimized($0) } ? nil : windows.first)
        guard hidden || wanted != nil else { return nil }
        guard enabled else {
            return "\(name)'s window is \(hidden ? "hidden" : "minimized"); restore it, or use an action that works through accessibility"
        }
        restoreLocked()

        // A hidden app shows all its open windows when unhidden, so they all
        // move; otherwise the one minimized window comes back.
        let moving = hidden ? windows.filter { !minimized($0) } : []
        let bringing = moving.isEmpty ? (wanted ?? windows.first(where: minimized)) : nil
        let all = moving + (bringing.map { [$0] } ?? [])
        guard !all.isEmpty else {
            return "\(name) has no window to work in; its windows may be closed or on another desktop"
        }
        let size = all.compactMap { axSize($0, kAXSizeAttribute as String) }
            .reduce(CGSize(width: 1280, height: 800)) { CGSize(width: max($0.width, $1.width), height: max($0.height, $1.height)) }
        guard let bounds = makeDisplay(width: Int(size.width) + 80, height: Int(size.height) + 80) else {
            return "\(name)'s window is \(hidden ? "hidden" : "minimized"), and this Mac could not create the invisible display used to work in it; restore the window, or use an action that works through accessibility"
        }

        front = NSWorkspace.shared.frontmostApplication
        for (index, window) in all.enumerated() {
            guard let wid = SkyLight.windowID(window), let home = axPoint(window, kAXPositionAttribute as String)
            else { continue }
            let target = CGPoint(x: bounds.minX + 40 + CGFloat(index * 30), y: bounds.minY + 40 + CGFloat(index * 30))
            move(window, to: target)
            parked.append(Parked(window: window, wid: wid, home: home, parkedAt: target))
        }
        guard !parked.isEmpty else {
            releaseDisplay()
            return "\(name)'s window could not be moved for background control"
        }
        self.pid = pid
        if hidden {
            DispatchQueue.main.sync { _ = app.unhide() }
            unhid = true
        }
        if let bringing {
            AXUIElementSetAttributeValue(bringing, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            unminimized = bringing
        }
        // Unhiding can put windows back near the main screen; move them again
        // until every one is on the invisible display.
        let landed = waitUntil(3) { [self] in
            let pending = parked.filter { entry in
                guard let frame = windowFrame(entry.wid) else { return true }
                return !bounds.contains(frame.origin)
            }
            for entry in pending { move(entry.window, to: entry.parkedAt) }
            return pending.isEmpty
        }
        guard landed else {
            restoreLocked()
            return "\(name)'s window did not open for background control"
        }
        // The window brought back becomes the app's main window, so keys the
        // agent sends go to it rather than to another of the app's windows.
        if let main = bringing ?? window ?? parked.first?.window {
            AXUIElementSetAttributeValue(main, kAXMainAttribute as CFString, kCFBooleanTrue)
        }
        fputs("munim-computer-use: parked \(parked.count) window(s) of \(name) on the invisible display at "
            + "(\(Int(bounds.minX)), \(Int(bounds.minY)))\n", stderr)
        // Let the window draw before it is captured or clicked.
        usleep(150_000)
        lastUse = Date()
        watch()
        return nil
    }

    /// Note an action on the parked app, which keeps it parked a while longer.
    func touch(_ pid: pid_t) {
        lock.withLock { if self.pid == pid { lastUse = Date() } }
    }

    /// Minimize or hide again, then move the windows back while out of sight.
    func restore() {
        lock.withLock { restoreLocked() }
    }

    private func restoreLocked(userAsked: Bool = false) {
        defer {
            parked = []
            unminimized = nil
            unhid = false
            pid = nil
            front = nil
            stopWatching()
            releaseDisplay()
        }
        guard !parked.isEmpty else { return }
        if userAsked {
            // The user brought the app up: show its windows where they were.
            for entry in parked { move(entry.window, to: entry.home) }
            return
        }
        if let window = unminimized {
            AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
            _ = waitUntil(2) { axBool(window, kAXMinimizedAttribute as String) == true }
        }
        if unhid, let pid, let app = NSRunningApplication(processIdentifier: pid) {
            DispatchQueue.main.sync { _ = app.hide() }
            _ = waitUntil(2) { app.isHidden }
        }
        for entry in parked { move(entry.window, to: entry.home) }
    }

    // MARK: Watching for idleness and the user

    private func watch() {
        if idleTimer == nil {
            let timer = DispatchSource.makeTimerSource(queue: .global())
            timer.schedule(deadline: .now() + 1, repeating: 1)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                self.lock.withLock {
                    if !self.parked.isEmpty, -self.lastUse.timeIntervalSinceNow > Self.idleRestore {
                        self.restoreLocked()
                    }
                }
            }
            timer.resume()
            idleTimer = timer
        }
        if activationObserver == nil {
            activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
            ) { [weak self] note in
                guard let self,
                      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                else { return }
                DispatchQueue.global().async { self.activated(app) }
            }
        }
    }

    private func activated(_ app: NSRunningApplication) {
        lock.withLock {
            guard !parked.isEmpty, app.processIdentifier == pid else { return }
            if -lastUse.timeIntervalSinceNow < 1.5, let front, front.processIdentifier != pid {
                // The app activated itself in reaction to the agent's input:
                // hand the front back to the user's app and stay parked.
                DispatchQueue.main.async { _ = front.activate(options: []) }
                return
            }
            restoreLocked(userAsked: true)
        }
    }

    private func stopWatching() {
        idleTimer?.cancel()
        idleTimer = nil
        if let activationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
        }
        activationObserver = nil
    }

    // MARK: The invisible display

    private func makeDisplay(width: Int, height: Int) -> CGRect? {
        releaseDisplay()
        let id = MCUVirtualDisplayCreate("Munim Computer Use", UInt32(max(width, 1280)), UInt32(max(height, 800)))
        guard id != 0 else { return nil }
        display = id
        guard waitUntil(3, { CGDisplayBounds(id).width > 0 }) else {
            releaseDisplay()
            return nil
        }
        placeOutOfReach(id)
        DisplayCache.shared.invalidate()
        return CGDisplayBounds(id)
    }

    /// Put the display diagonally off the bottom-right corner of the others, so
    /// the user's pointer does not wander onto it from a shared edge.
    private func placeOutOfReach(_ id: CGDirectDisplayID) {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        let others = ids.prefix(Int(count)).filter { $0 != id }.map { CGDisplayBounds($0) }
        guard let union = others.reduce(nil, { (sum: CGRect?, r: CGRect) in sum?.union(r) ?? r }) else { return }
        var config: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&config) == .success else { return }
        CGConfigureDisplayOrigin(config, id, Int32(union.maxX), Int32(union.maxY))
        if CGCompleteDisplayConfiguration(config, .forSession) != .success {
            CGCancelDisplayConfiguration(config)
            return
        }
        _ = waitUntil(1) { CGDisplayBounds(id).minX >= union.maxX - 1 }
    }

    private func releaseDisplay() {
        guard display != 0 else { return }
        MCUVirtualDisplayDestroy(display)
        display = 0
        DisplayCache.shared.invalidate()
    }

    private func move(_ window: AXUIElement, to point: CGPoint) {
        var p = point
        guard let value = AXValueCreate(.cgPoint, &p) else { return }
        AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, value)
    }
}

/// Poll `condition` until it holds or `timeout` passes.
func waitUntil(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        usleep(30_000)
    }
    return condition()
}
