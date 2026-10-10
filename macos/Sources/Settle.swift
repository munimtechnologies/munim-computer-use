import AppKit
import ApplicationServices

// MARK: - Settling after an action
//
// return_state used to sleep a fixed 300 ms before reading the app again: too
// long for a button that reacts in 10 ms, too short for a sheet sliding in or
// a page loading. An app announces its changes through accessibility
// notifications within milliseconds of reacting and goes quiet once it is
// idle, so the wait follows those instead, without any screen capture.
//
// Some apps never go quiet: a ticking clock, a progress spinner or a playing
// video post notifications all the time. Each one names the element and kind
// that posted it, and a source that was already posting before the action is
// background, not the app reacting, so it is left out of the count. The app is
// watched from get_app_state on, so the time before an action shows which.

/// Records the accessibility notifications one app posts, on a thread of its own
/// whose run loop delivers them.
final class AXEventMonitor: @unchecked Sendable {
    struct Event {
        let at: TimeInterval
        /// The element and the kind of notification.
        let source: Int
    }

    /// Notifications older than this are no use to a wait, which looks back
    /// `backgroundWindow` and forward at most its timeout.
    static let keep: TimeInterval = 4
    static let most = 8192
    /// How far back before an action a source must have posted to be background.
    static let backgroundWindow: TimeInterval = 1.5

    static let shared = AXEventMonitor()

    static let appNotifications = [
        "AXFocusedUIElementChanged", "AXFocusedWindowChanged", "AXMainWindowChanged", "AXWindowCreated",
        "AXCreated", "AXUIElementDestroyed", "AXValueChanged", "AXTitleChanged", "AXSelectedChildrenChanged",
        "AXSelectedRowsChanged", "AXSelectedTextChanged", "AXRowCountChanged", "AXLayoutChanged",
        "AXMenuOpened", "AXMenuClosed", "AXWindowMoved", "AXWindowResized", "AXSheetCreated",
    ]
    /// A web page posts its notifications on its web area, not on the app.
    static let webNotifications = [
        "AXLoadComplete", "AXLayoutChanged", "AXValueChanged", "AXFocusedUIElementChanged",
        "AXSelectedChildrenChanged", "AXSelectedTextChanged", "AXCreated", "AXUIElementDestroyed",
    ]

    private let lock = NSLock()
    private var events: [Event] = []
    private var watched: pid_t?
    private var observer: AXObserver?
    private var webAreas: [AXUIElement] = []
    private var runLoop: CFRunLoop?
    private let started = DispatchSemaphore(value: 0)

    private init() {}

    /// Sources that kept posting through the `backgroundWindow` before now.
    func background() -> Set<Int> {
        let now = ProcessInfo.processInfo.systemUptime
        return lock.withLock { Self.background(events, before: now, window: Self.backgroundWindow) }
    }

    /// Notifications since `since` from sources that are not background. A
    /// source that keeps posting through the wait is background too, for an app
    /// read too recently to have shown it before the action.
    func reactions(since: TimeInterval, excluding background: Set<Int>) -> Int {
        let after = lock.withLock { events.filter { $0.at > since && !background.contains($0.source) } }
        var slices: [Int: Set<Int>] = [:]
        for event in after { slices[event.source, default: []].insert(Int((event.at - since) / 0.1)) }
        return after.filter { (slices[$0.source]?.count ?? 0) < Self.backgroundSlices }.count
    }

    /// A background source posted in at least this many separate 100 ms
    /// slices of the window: a ticker or spinner does, while the bursts of a
    /// few earlier actions on the same control do not.
    static let backgroundSlices = 5

    static func background(_ events: [Event], before: TimeInterval, window: TimeInterval) -> Set<Int> {
        var slices: [Int: Set<Int>] = [:]
        for event in events where event.at >= before - window && event.at <= before {
            slices[event.source, default: []].insert(Int((event.at - (before - window)) / 0.1))
        }
        return Set(slices.filter { $0.value.count >= backgroundSlices }.keys)
    }

    private func record(_ element: AXUIElement, _ notification: CFString) {
        var hasher = Hasher()
        hasher.combine(Int(bitPattern: CFHash(element)))
        hasher.combine(notification as String)
        let event = Event(at: ProcessInfo.processInfo.systemUptime, source: hasher.finalize())
        lock.withLock {
            let stale = events.firstIndex { event.at - $0.at <= Self.keep } ?? events.count
            if stale > 0 { events.removeFirst(stale) }
            if events.count >= Self.most { events.removeFirst(events.count - Self.most + 1) }
            events.append(event)
        }
    }

    /// Watch `pid`. Returns false when its notifications cannot be observed, in
    /// which case the caller falls back to a fixed pause.
    func watch(_ pid: pid_t) -> Bool {
        guard let loop = startIfNeeded() else { return false }
        if lock.withLock({ watched == pid && observer != nil }) { return true }
        let done = DispatchSemaphore(value: 0)
        var ok = false
        CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue) { [self] in
            ok = subscribe(pid)
            done.signal()
        }
        CFRunLoopWakeUp(loop)
        return done.wait(timeout: .now() + 0.5) == .success && ok
    }

    /// Also count notifications from the pages inside `pid`'s web views.
    func watchWebAreas(_ areas: [AXUIElement], pid: pid_t) {
        guard !areas.isEmpty, watch(pid), let loop = runLoop else { return }
        CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue) { [self] in
            guard let observer, watched == pid else { return }
            for area in areas where !webAreas.contains(where: { CFEqual($0, area) }) {
                for name in Self.webNotifications {
                    AXObserverAddNotification(observer, area, name as CFString, nil)
                }
                webAreas.append(area)
            }
        }
        CFRunLoopWakeUp(loop)
    }

    private func startIfNeeded() -> CFRunLoop? {
        if let runLoop { return runLoop }
        let thread = Thread { [self] in
            runLoop = CFRunLoopGetCurrent()
            // A run loop with no sources returns at once; this timer keeps it parked.
            let keepAlive = CFRunLoopTimerCreateWithHandler(nil, .infinity, 1e9, 0, 0) { _ in }
            CFRunLoopAddTimer(runLoop, keepAlive, .defaultMode)
            started.signal()
            while true { CFRunLoopRunInMode(.defaultMode, 1e9, false) }
        }
        thread.name = "ax-event-monitor"
        thread.start()
        started.wait()
        return runLoop
    }

    /// Runs on the monitor thread.
    private func subscribe(_ pid: pid_t) -> Bool {
        if let observer {
            CFRunLoopRemoveSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        observer = nil
        webAreas = []
        lock.withLock {
            watched = pid
            events = []
        }
        var created: AXObserver?
        let callback: AXObserverCallback = { _, element, notification, refcon in
            guard let refcon else { return }
            Unmanaged<AXEventMonitor>.fromOpaque(refcon).takeUnretainedValue().record(element, notification)
        }
        guard AXObserverCreate(pid, callback, &created) == .success, let created else { return false }
        let app = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var subscribed = 0
        for name in Self.appNotifications
        where AXObserverAddNotification(created, app, name as CFString, refcon) == .success {
            subscribed += 1
        }
        guard subscribed > 0 else { return false }
        CFRunLoopAddSource(runLoop, AXObserverGetRunLoopSource(created), .defaultMode)
        observer = created
        return true
    }
}

/// How long to wait for an app to react and then go quiet. From arc-cua's
/// settling, which measured these on native and Electron apps.
struct SettleTiming {
    /// Give up this soon when nothing changes.
    var reaction: TimeInterval = 0.6
    /// After a change, done once nothing more changed for this long.
    var quiet: TimeInterval = 0.15
    /// Never wait longer.
    var timeout: TimeInterval = 2.0
    var poll: TimeInterval = 0.02
    /// How often `look` is asked.
    var lookEvery: TimeInterval = 0.1
}

struct Settled: Equatable {
    var reacted: Bool
    var timedOut: Bool
    var elapsed: TimeInterval
}

/// Poll `probe` until the app reacted and went quiet, or did not react in time.
/// `look`, for apps that change only their pixels, reports whether the window
/// image changed since it was last asked; a change counts like a notification.
func waitForQuiet<P: Equatable>(
    before: P, timing: SettleTiming = SettleTiming(), probe: () -> P, look: (() -> Bool)? = nil
) -> Settled {
    let started = Date()
    var previous = before
    var changed = false
    var quietSince = started
    var lookedAt = started
    while true {
        Thread.sleep(forTimeInterval: timing.poll)
        let current = probe()
        var now = Date()
        if current != previous {
            changed = true
            quietSince = now
        }
        if let look, now.timeIntervalSince(lookedAt) >= timing.lookEvery {
            lookedAt = now
            if look() {
                changed = true
                now = Date()
                quietSince = now
            }
        }
        previous = current
        let elapsed = now.timeIntervalSince(started)
        if changed, now.timeIntervalSince(quietSince) >= timing.quiet {
            return Settled(reacted: true, timedOut: false, elapsed: elapsed)
        }
        if !changed, elapsed >= timing.reaction {
            return Settled(reacted: false, timedOut: false, elapsed: elapsed)
        }
        if elapsed >= timing.timeout {
            return Settled(reacted: changed, timedOut: true, elapsed: elapsed)
        }
    }
}

/// Watches a window's pixels through a tiny capture, for apps whose changes
/// accessibility does not announce.
final class WindowLook {
    private let pid: pid_t
    private var last: Data?

    init(pid: pid_t) {
        self.pid = pid
        last = thumbnail()
    }

    private func thumbnail() -> Data? {
        captureWindow(pid: pid, maxWidth: 96, encoding: .png)?.data
    }

    func changed() -> Bool {
        let now = thumbnail()
        defer { last = now }
        return now != nil && now != last
    }
}
