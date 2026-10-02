import AppKit
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import VideoToolbox

// Live display capture for MT Code's Computer View.
//
// A one-shot screenshot sets up a capture, takes one image and tears it down,
// which costs ~100 ms a frame and caps a live viewer at a few frames a second.
// A ScreenCaptureKit stream sets up once, and the system hands over a frame
// only when something on screen changed, so the viewer waits for the next
// change instead of capturing and diffing on a timer.
//
// While the stream runs, macOS shows its purple screen-recording indicator in
// the menu bar. That is accurate: someone is watching this screen. The stream
// stops a few seconds after the last request, so a viewer that crashes or
// loses its connection cannot leave it (or the indicator) running.
//
// Requested as `screenshot { display, live: true, after?, wait_ms? }`.
// Deliberately not in the tool schema: it serves that viewer, not agents, the
// same as the Windows server's `cursor: true`.

/// Answers one live screenshot call. The image result gains a `live:` text line
/// carrying the frame's sequence number; when nothing changed within `wait_ms`
/// the result is that line alone, with no image.
func liveScreenshotResult(
    _ args: [String: Any], display: Int, maxWidth: Int, encoding: ImageEncoding
) -> [String: Any] {
    let after = (args["after"] as? NSNumber).map { $0.uint64Value }
    let waitMs = min(max((args["wait_ms"] as? Int) ?? 1000, 0), 5000)
    switch LiveCapture.shared.frame(
        display: display, maxWidth: maxWidth, encoding: encoding, after: after, waitMs: waitMs)
    {
    case .frame(let shot, let seq):
        var result = imageResult(shot, label: "display \(display)")
        if var content = result["content"] as? [[String: Any]] {
            content.append(["type": "text", "text": liveLine(seq: seq, changed: true)])
            result["content"] = content
        }
        return result
    case .unchanged(let seq):
        return textResult(liveLine(seq: seq, changed: false), isError: false)
    case .failed(let message):
        return textResult(message, isError: true)
    }
}

private func liveLine(seq: UInt64, changed: Bool) -> String {
    "live: {\"seq\":\(seq),\"changed\":\(changed)}"
}

final class LiveCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    static let shared = LiveCapture()

    enum Outcome {
        case frame(CaptureShot, seq: UInt64)
        case unchanged(seq: UInt64)
        case failed(String)
    }

    /// No request for this long and the stream stops.
    private static let idleStop: TimeInterval = 5
    /// Upper bound on delivered frames; the viewer paces itself below this.
    private static let maxFramesPerSecond: Int32 = 30
    /// How long a fresh stream gets to deliver its first frame.
    private static let firstFrameWait: TimeInterval = 3

    private let sampleQueue = DispatchQueue(label: "munim-computer-use.live-capture")
    private let condition = NSCondition()

    // Guarded by `condition`.
    private var stream: SCStream?
    private var display: SCDisplay?
    private var displayIndex = -1
    private var streamWidth = 0
    private var latest: CVPixelBuffer?
    /// Never reset, so a frame number from before a restart is always older.
    private var seq: UInt64 = 0
    private var lastRequest = Date.distantPast
    private var screensChanged = false
    /// Set when the person at the Mac stopped sharing from the menu bar. Honoured
    /// for the life of the process: a viewer must not quietly start it again.
    private var userStopped = false
    private var encoded: (seq: UInt64, encoding: ImageEncoding, shot: CaptureShot)?
    private var reaper: DispatchSourceTimer?

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            self.condition.lock()
            self.screensChanged = true
            self.condition.unlock()
        }
    }

    func frame(
        display index: Int, maxWidth: Int, encoding: ImageEncoding, after: UInt64?, waitMs: Int
    ) -> Outcome {
        condition.lock()
        lastRequest = Date()
        if userStopped {
            condition.unlock()
            return .failed(
                "error: screen sharing was stopped from this Mac's menu bar, so live capture stays off "
                + "until the viewer is reopened")
        }
        let restart = stream == nil || displayIndex != index || screensChanged
        let width = Self.streamWidth(display: display, maxWidth: maxWidth)
        let resize = !restart && width != streamWidth
        condition.unlock()

        if restart {
            if let failure = start(index: index, maxWidth: maxWidth) { return .failed(failure) }
        } else if resize {
            resizeStream(maxWidth: maxWidth)
        }

        condition.lock()
        let hadFrame = latest != nil
        let wait = hadFrame ? TimeInterval(waitMs) / 1000 : max(TimeInterval(waitMs) / 1000, Self.firstFrameWait)
        let deadline = Date().addingTimeInterval(wait)
        while stream != nil, latest == nil || after.map({ seq <= $0 }) == true {
            if !condition.wait(until: deadline) { break }
        }
        guard let buffer = latest, let frame = display?.frame else {
            let stopped = userStopped
            condition.unlock()
            return .failed(stopped
                ? "error: screen sharing was stopped from this Mac's menu bar"
                : "error: the live capture delivered no frame — check Screen Recording permission")
        }
        let current = seq
        if let after, current <= after {
            condition.unlock()
            return .unchanged(seq: current)
        }
        if let cached = encoded, cached.seq == current, cached.encoding == encoding {
            condition.unlock()
            return .frame(cached.shot, seq: current)
        }
        condition.unlock()

        // Encode outside the lock so new frames keep landing meanwhile.
        var image: CGImage?
        VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &image)
        guard let image, let data = encoding.encode(image) else {
            return .failed("error: could not encode the live frame")
        }
        let shot = CaptureShot(
            data: data, mimeType: encoding.mimeType, frame: frame,
            pixelWidth: image.width, pixelHeight: image.height, title: nil)
        condition.lock()
        encoded = (current, encoding, shot)
        condition.unlock()
        return .frame(shot, seq: current)
    }

    // MARK: Stream lifecycle

    /// Starts a stream on display `index`, replacing any running one. Returns an
    /// error message on failure.
    private func start(index: Int, maxWidth: Int) -> String? {
        stop()
        let semaphore = DispatchSemaphore(value: 0)
        let found = DisplayBox()
        let lookup = Task.detached {
            defer { semaphore.signal() }
            found.displays = try? await DisplayCache.shared.current(fresh: true)
        }
        if semaphore.wait(timeout: .now() + 10) == .timedOut {
            lookup.cancel()
            return "error: could not enumerate displays for the live capture"
        }
        guard let displays = found.displays, index >= 0, index < displays.count else {
            return "error: display \(index) does not exist — call list_displays"
        }
        let display = displays[index]
        let config = Self.configuration(display: display, maxWidth: maxWidth)
        let stream = SCStream(
            filter: SCContentFilter(display: display, excludingWindows: []),
            configuration: config, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        } catch {
            return "error: could not start the live capture: \(error.localizedDescription)"
        }

        // Publish the stream before it starts so its first frame is not dropped
        // as belonging to some other stream.
        condition.lock()
        self.stream = stream
        self.display = display
        displayIndex = index
        streamWidth = config.width
        screensChanged = false
        latest = nil
        encoded = nil
        condition.unlock()

        let started = DispatchSemaphore(value: 0)
        let failure = ErrorBox()
        stream.startCapture { error in
            failure.error = error
            started.signal()
        }
        let timedOut = started.wait(timeout: .now() + 10) == .timedOut
        if timedOut || failure.error != nil {
            stop()
            let reason = failure.error?.localizedDescription ?? "it did not start within 10 s"
            return "error: could not start the live capture (\(reason)) — check Screen Recording permission"
        }
        startReaper()
        fputs("munim-computer-use: live capture started on display \(index) at \(config.width)×\(config.height)\n", stderr)
        return nil
    }

    private func resizeStream(maxWidth: Int) {
        condition.lock()
        guard let stream, let display else {
            condition.unlock()
            return
        }
        let config = Self.configuration(display: display, maxWidth: maxWidth)
        streamWidth = config.width
        condition.unlock()
        // Frames at the old size keep coming until this lands; both map back to
        // screen points through the display frame, so either is correct.
        stream.updateConfiguration(config) { _ in }
    }

    /// Stops the stream, if any, without waiting for ScreenCaptureKit to finish.
    private func stop(reason: String? = nil) {
        condition.lock()
        let running = stream
        stream = nil
        latest = nil
        encoded = nil
        condition.broadcast()
        condition.unlock()
        guard let running else { return }
        running.stopCapture { _ in }
        if let reason { fputs("munim-computer-use: live capture stopped (\(reason))\n", stderr) }
    }

    private func startReaper() {
        condition.lock()
        defer { condition.unlock() }
        guard reaper == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.condition.lock()
            let idle = self.stream != nil && -self.lastRequest.timeIntervalSinceNow > Self.idleStop
            self.condition.unlock()
            if idle { self.stop(reason: "no viewer for \(Int(Self.idleStop)) s") }
        }
        timer.resume()
        reaper = timer
    }

    private static func streamWidth(display: SCDisplay?, maxWidth: Int) -> Int {
        guard let display else { return 0 }
        let scale = maxWidth > 0 ? min(1.0, Double(maxWidth) / max(1.0, Double(display.width))) : 1.0
        return max(1, Int((Double(display.width) * scale).rounded()))
    }

    /// Same size rules as a one-shot display capture, so a viewer gets the same
    /// pixels-per-point either way.
    private static func configuration(display: SCDisplay, maxWidth: Int) -> SCStreamConfiguration {
        let config = SCStreamConfiguration()
        let width = streamWidth(display: display, maxWidth: maxWidth)
        config.width = width
        config.height = max(1, Int((Double(display.height) * Double(width) / max(1.0, Double(display.width))).rounded()))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: maxFramesPerSecond)
        config.queueDepth = 5
        config.showsCursor = false
        return config
    }

    // MARK: SCStreamOutput / SCStreamDelegate

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // Idle frames repeat the previous image; only complete ones are news.
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(
                  sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let buffer = sampleBuffer.imageBuffer
        else { return }
        condition.lock()
        if stream === self.stream {
            latest = buffer
            seq += 1
            condition.broadcast()
        }
        condition.unlock()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        condition.lock()
        if stream === self.stream {
            self.stream = nil
            latest = nil
            encoded = nil
            // The menu-bar indicator's Stop, or the system's own privacy stop.
            if (error as NSError).code == SCStreamError.Code.userStopped.rawValue {
                userStopped = true
            }
            fputs("munim-computer-use: live capture stopped (\(error.localizedDescription))\n", stderr)
            condition.broadcast()
        }
        condition.unlock()
    }
}

private final class DisplayBox: @unchecked Sendable {
    var displays: [SCDisplay]?
}

private final class ErrorBox: @unchecked Sendable {
    var error: Error?
}
