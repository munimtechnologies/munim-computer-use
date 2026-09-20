import CoreGraphics
import Foundation

/// Remote-desktop input: the opposite contract from the rest of this server.
///
/// Everywhere else, events are addressed to one process so the agent can click
/// in a background window while the user keeps their own mouse and keyboard
/// (see `post(_:to:)`). Remote control exists for the other case: a person is
/// watching this machine's screen from another one and the pointer they are
/// steering *is* this machine's pointer. So events go to the global HID tap,
/// the real cursor moves, and keystrokes land in whatever is focused — the way
/// Chrome Remote Desktop or Screen Sharing behave.
///
/// Off unless `COMPUTER_USE_REMOTE_CONTROL=1` (or the embedder's prefixed
/// equivalent) is set for the process. A host that runs both an agent and a
/// viewer runs them as two processes, so turning this on for the viewer never
/// takes the pointer away from the user on the agent's behalf.
enum RemoteControl {
    static var isEnabled: Bool { envFlagEnabled("REMOTE_CONTROL") }

    /// Real input carries the session's live modifier state, so a key the
    /// viewer is holding combines with the event the way physical input does.
    /// (The agent's own source is a private state for exactly the opposite
    /// reason.)
    private static func source() -> CGEventSource? {
        CGEventSource(stateID: .combinedSessionState)
    }

    static func post(_ event: CGEvent?) {
        event?.post(tap: .cghidEventTap)
    }

    /// Moving the cursor is a posted move, not `CGWarpMouseCursorPosition`:
    /// the warp teleports the pointer without telling anything it moved, so
    /// hover states and drag tracking never update.
    static func move(to point: CGPoint) {
        post(
            CGEvent(
                mouseEventSource: source(), mouseType: .mouseMoved,
                mouseCursorPosition: point, mouseButton: .left))
    }

    static func click(at point: CGPoint, button: CGMouseButton = .left, clickCount: Int = 1) {
        let (downType, upType): (CGEventType, CGEventType) =
            button == .right ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
        move(to: point)
        let source = source()
        for index in 1...max(1, clickCount) {
            let down = CGEvent(
                mouseEventSource: source, mouseType: downType,
                mouseCursorPosition: point, mouseButton: button)
            let up = CGEvent(
                mouseEventSource: source, mouseType: upType,
                mouseCursorPosition: point, mouseButton: button)
            // The click count is what turns two clicks into a double click;
            // without it the second one starts a fresh selection instead.
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(index))
            post(down)
            post(up)
            // Comfortably inside the system double-click interval.
            if index < clickCount { usleep(40_000) }
        }
    }

    static func drag(from start: CGPoint, to end: CGPoint) {
        let source = source()
        move(to: start)
        usleep(40_000)
        post(
            CGEvent(
                mouseEventSource: source, mouseType: .leftMouseDown,
                mouseCursorPosition: start, mouseButton: .left))
        usleep(40_000)
        // Interpolate: a single jump reads as a click in views that only begin
        // drag tracking once intermediate moves arrive.
        let steps = 24
        for index in 1...steps {
            let progress = Double(index) / Double(steps)
            let point = CGPoint(
                x: start.x + (end.x - start.x) * progress,
                y: start.y + (end.y - start.y) * progress)
            post(
                CGEvent(
                    mouseEventSource: source, mouseType: .leftMouseDragged,
                    mouseCursorPosition: point, mouseButton: .left))
            usleep(8_000)
        }
        usleep(40_000)
        post(
            CGEvent(
                mouseEventSource: source, mouseType: .leftMouseUp,
                mouseCursorPosition: end, mouseButton: .left))
    }

    /// The wheel acts wherever the pointer is, so a viewer that scrolls over a
    /// particular spot gets the pointer moved there first.
    static func scroll(at point: CGPoint?, dx: Int32, dy: Int32, steps: Int) {
        if let point { move(to: point) }
        let source = source()
        for _ in 0..<max(1, steps) {
            let wheel = CGEvent(
                scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
                wheel1: dy, wheel2: dx, wheel3: 0)
            if let point { wheel?.location = point }
            post(wheel)
            usleep(15_000)
        }
    }

    static func typeText(_ text: String) {
        synthesizeTypedText(text, deliver: post)
    }

    static func pressKey(_ key: String, modifiers: [String]) -> String? {
        synthesizeKeyPress(key, modifiers: modifiers, deliver: post)
    }
}
