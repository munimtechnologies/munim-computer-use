import AppKit
import ScreenCaptureKit
import Vision

// MARK: - On-screen text
//
// Some apps describe almost nothing to accessibility: Spotify exposes unlabelled
// groups, games and canvases expose nothing. For those the window is captured
// locally and Apple Vision reads its text, which is listed with ids like any
// element. The image never leaves the machine; the model only sees the text.

enum ScreenText {
    /// Read `window`'s text and register each piece. Returns the outline lines.
    static func read(pid: pid_t, window: AXUIElement, labelled: [(frame: CGRect, text: String)],
                     limit: Int) -> Result<[String], String> {
        guard limit > 0 else { return .success([]) }
        guard CGPreflightScreenCaptureAccess() else {
            return .failure("Screen Recording permission is not granted")
        }
        // A minimized window or a hidden app has no pixels until it is shown
        // somewhere; background control parks it on an invisible display.
        if let refusal = WindowParking.shared.reach(pid: pid, window: window) { return .failure(refusal) }
        guard let wid = SkyLight.windowID(window) else { return .failure("the window has no window number") }
        guard let (image, frame) = captureWindowImage(windowID: wid) else {
            return .failure("the window could not be captured")
        }
        let found: [Recognized]
        switch recognize(image, in: frame, timeout: 5) {
        case .failure(let reason):
            return .failure(reason)
        case .success(let pieces):
            found = pieces
        }
        let kept = readingOrder(dedupe(found, against: labelled)).prefix(limit)
        return .success(kept.map { piece in
            let id = Registry.add(OCRText(
                text: piece.text, pid: pid, windowID: wid,
                offset: piece.frame.offsetBy(dx: -frame.minX, dy: -frame.minY)))
            return "  [\(id)] Text \"\(truncate(piece.text, 120))\""
        })
    }

    struct Recognized: Equatable {
        let text: String
        /// Global screen points.
        let frame: CGRect
        let confidence: Float
    }

    /// The first recognition on a Mac compiles Vision's text model for this
    /// program, about a minute once per macOS version (cached in
    /// ~/Library/Caches/munim-computer-use). Until that is done, reads report it
    /// instead of waiting; afterwards a window reads in a few hundred ms.
    static let preparingMessage =
        "on-screen text recognition is preparing for first use on this Mac (about a minute, once); call get_app_state again then"
    private static let lock = NSLock()
    private static var preparing = false

    /// Recognize text, giving up on waiting after `timeout`. A request that
    /// outlasts it is left to finish rather than cancelled, because cancelling
    /// the first one would throw the model compile away and start over next time.
    static func recognize(_ image: CGImage, in frame: CGRect, timeout: TimeInterval) -> Result<[Recognized], String> {
        if lock.withLock({ preparing }) { return .failure(preparingMessage) }
        let request = VNRecognizeTextRequest()
        // The accurate level reads "Sneaky Snitch" where the fast one reads
        // "Sn8aky SNitch", at about 95 ms against 30 ms per window.
        request.recognitionLevel = .accurate
        // On the CPU: with the invisible display up, the Neural Engine never
        // answers Vision and recognition waits forever.
        if let stages = try? request.supportedComputeStageDevices {
            for (stage, devices) in stages {
                if let cpu = devices.first(where: { if case .cpu = $0 { true } else { false } }) {
                    request.setComputeDevice(cpu, for: stage)
                }
            }
        }
        let done = DispatchSemaphore(value: 0)
        final class Outcome: @unchecked Sendable { var error: Error? }
        let outcome = Outcome()
        DispatchQueue.global(qos: .userInitiated).async {
            do { try VNImageRequestHandler(cgImage: plainBitmap(image) ?? image).perform([request]) } catch { outcome.error = error }
            lock.withLock { preparing = false }
            done.signal()
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            lock.withLock { preparing = true }
            return .failure(preparingMessage)
        }
        if let error = outcome.error {
            return .failure("Vision could not read the window: \(error.localizedDescription)")
        }
        return .success(results(request, in: frame))
    }

    static func results(_ request: VNRecognizeTextRequest, in frame: CGRect) -> [Recognized] {
        (request.results ?? []).compactMap { observation in
            guard let best = observation.topCandidates(1).first else { return nil }
            let text = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.contains(where: { $0.isLetter || $0.isNumber }) else { return nil }
            // Vision's boxes are normalized with the origin at the bottom left.
            let box = observation.boundingBox
            let rect = CGRect(
                x: frame.minX + box.minX * frame.width,
                y: frame.minY + (1 - box.maxY) * frame.height,
                width: box.width * frame.width,
                height: box.height * frame.height)
            return Recognized(text: text, frame: rect, confidence: best.confidence)
        }
    }

    /// OCR is noisy and overlapping detections repeat each other, so one
    /// region is listed once, with its most confident reading. Text that an
    /// element already listed shows is dropped, so a control has one id, the
    /// one accessibility gave it.
    static func dedupe(_ found: [Recognized], against labelled: [(frame: CGRect, text: String)]) -> [Recognized] {
        var kept: [Recognized] = []
        for piece in found.sorted(by: { $0.confidence > $1.confidence }) {
            if kept.contains(where: { overlap($0.frame, piece.frame) >= 0.5 }) { continue }
            let text = normalized(piece.text)
            let shown = labelled.contains { element in
                let label = normalized(element.text)
                return !label.isEmpty && overlap(element.frame, piece.frame) >= 0.5
                    && (label.contains(text) || text.contains(label))
            }
            if !shown { kept.append(piece) }
        }
        return kept
    }

    /// Top to bottom, and left to right within a line.
    static func readingOrder(_ pieces: [Recognized]) -> [Recognized] {
        pieces.sorted { a, b in
            if abs(a.frame.midY - b.frame.midY) > min(a.frame.height, b.frame.height) / 2 {
                return a.frame.midY < b.frame.midY
            }
            return a.frame.minX < b.frame.minX
        }
    }

    /// Share of the smaller rectangle that the two have in common.
    static func overlap(_ a: CGRect, _ b: CGRect) -> CGFloat {
        let shared = a.intersection(b)
        guard !shared.isNull else { return 0 }
        let smaller = min(a.width * a.height, b.width * b.height)
        return smaller > 0 ? (shared.width * shared.height) / smaller : 0
    }

    static func normalized(_ text: String) -> String {
        String(text.lowercased().filter { $0.isLetter || $0.isNumber })
    }
}

/// Copy a capture into an ordinary 8-bit sRGB bitmap. A capture from the
/// invisible display comes back GPU-backed in the display's own color space,
/// and Vision stalls on it; an ordinary bitmap reads in a few hundred ms.
func plainBitmap(_ image: CGImage) -> CGImage? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return context.makeImage()
}

/// The current frame of a window, by number. OCR text is clicked where its
/// window is now, which differs from where it was read when the window moved.
func windowFrame(_ wid: UInt32) -> CGRect? {
    guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(wid)) as? [[String: Any]],
          let bounds = info.first?[kCGWindowBounds as String] as? [String: Any],
          let x = (bounds["X"] as? NSNumber)?.doubleValue,
          let y = (bounds["Y"] as? NSNumber)?.doubleValue,
          let width = (bounds["Width"] as? NSNumber)?.doubleValue,
          let height = (bounds["Height"] as? NSNumber)?.doubleValue
    else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

func ocrScreenFrame(_ text: OCRText) -> CGRect? {
    windowFrame(text.windowID).map { text.offset.offsetBy(dx: $0.minX, dy: $0.minY) }
}

func ocrWindowTarget(_ text: OCRText) -> WindowTarget? {
    windowFrame(text.windowID).map { WindowTarget(pid: text.pid, wid: text.windowID, frame: $0) }
}

/// Capture one window at full resolution for OCR, wherever it is: behind other
/// windows, or parked on the invisible display.
func captureWindowImage(windowID: UInt32) -> (CGImage, CGRect)? {
    let semaphore = DispatchSemaphore(value: 0)
    final class Box: @unchecked Sendable { var value: (CGImage, CGRect)? }
    let box = Box()
    let task = Task.detached {
        defer { semaphore.signal() }
        guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
              let window = content.windows.first(where: { $0.windowID == windowID })
        else { return }
        let config = SCStreamConfiguration()
        // Retina detail for small windows; a large one is read at about 2000 px
        // wide, which keeps UI text legible and Vision's time bounded.
        let scale = min(2.0, 2000 / max(1.0, window.frame.width))
        config.width = Int(window.frame.width * scale)
        config.height = Int(window.frame.height * scale)
        config.showsCursor = false
        guard let image = try? await SCScreenshotManager.captureImage(
            contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
        else { return }
        box.value = (image, window.frame)
    }
    if semaphore.wait(timeout: .now() + 10) == .timedOut {
        task.cancel()
        return nil
    }
    return box.value
}
