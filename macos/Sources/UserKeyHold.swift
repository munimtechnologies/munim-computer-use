import ApplicationServices
import Foundation

/// Stamped on every event the agent makes (see `agentEventSource`), so a tap
/// can tell the agent's keys from the person's.
let agentEventMark: Int64 = 0x4D55_4E49_4D43  // "MUNIMC"

/// Set on a held key when it is replayed, so the tap lets it pass. A high bit
/// over the event's own user data: hardware keys carry none.
let replayedKeyFlag: Int64 = 0x0100_0000_0000_0000

/// Keeps the person's own keystrokes out of the agent's window.
///
/// To deliver keys or a click to a background app, the server lends that app
/// keyboard focus for the length of one action (`SkyLight.borrowFocus`). It
/// waits for a pause in the person's typing first, but a key they press while
/// the loan lasts (up to about a second and a half for long text) would go to
/// the agent's window: lost to them, and typed into the agent's text. For the
/// length of the loan this holds those keys in a session event tap, and once
/// their window has focus again it replays them to it, in order, so typing
/// elsewhere carries on while the agent types.
///
/// The tap exists only while a loan does, and passes everything through if
/// macOS disables it. Without permission to create it (no Accessibility
/// access), loans work as before.
final class UserKeyHold {
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var held: [CGEvent] = []
    private var passing = false
    private let lock = NSLock()
    /// Past this many held events, let the rest through rather than sit on a
    /// long burst: the loan is about to end anyway.
    private static let limit = 400

    /// Start holding, or nil when the tap cannot be created. Returns once the
    /// tap is live, so nothing slips through before the loan begins.
    static func start() -> UserKeyHold? {
        if ProcessInfo.processInfo.environment["MUNIM_COMPUTER_USE_HOLD_USER_KEYS"] == "0" { return nil }
        let hold = UserKeyHold()
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread {
            let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
                | (1 << CGEventType.flagsChanged.rawValue)
            let info = Unmanaged.passUnretained(hold).toOpaque()
            guard let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                eventsOfInterest: CGEventMask(mask), callback: userKeyHoldCallback, userInfo: info)
            else {
                ready.signal()
                return
            }
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            hold.tap = tap
            hold.runLoop = CFRunLoopGetCurrent()
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            ready.signal()
            CFRunLoopRun()
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .commonModes)
            CFMachPortInvalidate(tap)
        }
        thread.name = "user-key-hold"
        thread.start()
        guard ready.wait(timeout: .now() + 1) == .success, hold.tap != nil else { return nil }
        return hold
    }

    /// What the tap does with one event: nil holds it.
    fileprivate func filter(_ type: CGEventType, _ event: CGEvent) -> CGEvent? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // macOS turned the tap off (a slow callback). Turn it back on.
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return event
        }
        guard type == .keyDown || type == .keyUp || type == .flagsChanged else { return event }
        let mark = event.getIntegerValueField(.eventSourceUserData)
        if mark == agentEventMark || mark & replayedKeyFlag != 0 { return event }
        lock.lock()
        defer { lock.unlock() }
        if passing || held.count >= Self.limit { return event }
        guard let copy = event.copy() else { return event }
        held.append(copy)
        return nil
    }

    /// Stop holding. With `replay`, the held keys are posted again, once the
    /// person's window has its focus back, and go to it as typed. Returns how
    /// many were held.
    @discardableResult
    func finish(replay: Bool) -> Int {
        defer {
            if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
            if let runLoop { CFRunLoopStop(runLoop) }
        }
        guard replay else {
            lock.lock()
            passing = true
            let dropped = held.count
            held = []
            lock.unlock()
            if dropped > 0 {
                FileHandle.standardError.write(Data(
                    "munim-computer-use: \(dropped) key events typed during the agent's action were dropped: the agent's window kept focus\n".utf8))
            }
            return dropped
        }
        // The focus change is asynchronous: give their window a moment to
        // become key before its keys arrive.
        usleep(50_000)
        // Drain in order. Keys pressed while the replay runs join the end of
        // the queue rather than jump ahead of it; only once it is empty does
        // the tap let keys straight through.
        var replayed = 0
        while true {
            lock.lock()
            if held.isEmpty {
                passing = true
                lock.unlock()
                break
            }
            let event = held.removeFirst()
            lock.unlock()
            event.setIntegerValueField(.eventSourceUserData,
                value: event.getIntegerValueField(.eventSourceUserData) | replayedKeyFlag)
            event.post(tap: .cgSessionEventTap)
            replayed += 1
            usleep(1_500)
        }
        return replayed
    }
}

private func userKeyHoldCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, info: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let info else { return Unmanaged.passUnretained(event) }
    let hold = Unmanaged<UserKeyHold>.fromOpaque(info).takeUnretainedValue()
    return hold.filter(type, event).map { Unmanaged.passUnretained($0) }
}
