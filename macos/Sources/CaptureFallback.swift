import AppKit
import CoreGraphics
import Foundation
import ImageIO

// When ScreenCaptureKit stops answering, captures go through /usr/sbin/screencapture.
//
// A ScreenCaptureKit call that never returns used to cost every later capture
// its own 15-20 s wait before failing the same way, so one wedged daemon turned
// every screenshot, zoom and OCR pass into a long error. After one timeout the
// server stops asking ScreenCaptureKit for `suspension` and captures with
// `screencapture`: a separate short-lived process with its own replayd client,
// which keeps working while this process's connection is stuck. The first
// capture after the suspension tries ScreenCaptureKit again, with a fresh
// display list.

enum ScreenCaptureHealth {
    static let suspension: TimeInterval = 60

    /// Test hook: ScreenCaptureKit calls hang instead of running, as when
    /// replayd stops answering.
    static let simulateHang = ProcessInfo.processInfo.environment["MUNIM_COMPUTER_USE_TEST_SCK_HANG"] == "1"

    private static let lock = NSLock()
    private static var suspendedUntil = Date.distantPast

    /// False while captures should skip ScreenCaptureKit.
    static var usable: Bool { lock.withLock { Date() >= suspendedUntil } }

    static func noteTimeout() {
        lock.withLock { suspendedUntil = Date().addingTimeInterval(suspension) }
        DisplayCache.shared.invalidate()
        fputs("munim-computer-use: ScreenCaptureKit did not answer; capturing with screencapture "
            + "for \(Int(suspension)) s\n", stderr)
    }

    static func noteAnswered() {
        lock.withLock { suspendedUntil = .distantPast }
    }

    /// Stands in for a ScreenCaptureKit call under `simulateHang`. Returns
    /// only when the task is cancelled, and then the caller must give up.
    static func hangIfSimulated() async -> Bool {
        guard simulateHang else { return false }
        while !Task.isCancelled { try? await Task.sleep(nanoseconds: 1_000_000_000) }
        return true
    }
}

enum ScreencaptureFallback {
    private static let tool = "/usr/sbin/screencapture"
    private static let timeout: TimeInterval = 10

    /// One display, by the same index ScreenCaptureKit's list uses (active
    /// displays in CoreGraphics order, without the parking display). Captured
    /// by its rectangle so screencapture's own display numbering never matters.
    static func display(index: Int, maxWidth: Int, encoding: ImageEncoding) -> CaptureShot? {
        let displays = activeDisplays()
        guard index >= 0, index < displays.count else { return nil }
        let bounds = CGDisplayBounds(displays[index])
        guard let image = run(["-R\(rectArgument(bounds))"]) else { return nil }
        return shot(image, frame: bounds, maxWidth: maxWidth, pointResolution: true, encoding: encoding, title: nil)
    }

    /// A rectangle in global screen points, clipped to the display holding its
    /// centre, the same way the ScreenCaptureKit region capture clips it.
    static func region(rect: CGRect, maxWidth: Int, encoding: ImageEncoding) -> CaptureShot? {
        let displays = activeDisplays().map { CGDisplayBounds($0) }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        guard let bounds = displays.first(where: { $0.contains(center) }) ?? displays.first else { return nil }
        let clipped = rect.intersection(bounds).integral
        guard clipped.width >= 4, clipped.height >= 4,
              let image = run(["-R\(rectArgument(clipped))"])
        else { return nil }
        return shot(image, frame: clipped, maxWidth: maxWidth, pointResolution: false, encoding: encoding, title: nil)
    }

    /// The largest on-screen normal window of `pid`, like the ScreenCaptureKit path.
    static func window(pid: pid_t, maxWidth: Int, encoding: ImageEncoding) -> CaptureShot? {
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]]) ?? []
        let candidates = windows.compactMap { info -> (id: CGWindowID, frame: CGRect, title: String?)? in
            guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { return nil }
            return (id, frame, info[kCGWindowName as String] as? String)
        }
        guard let window = candidates.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }),
              let image = run(["-o", "-l\(window.id)"])
        else { return nil }
        return shot(
            image, frame: window.frame, maxWidth: maxWidth, pointResolution: true, encoding: encoding,
            title: window.title)
    }

    /// One window by id at its native resolution, with its frame, for OCR.
    static func windowImage(windowID: CGWindowID) -> (CGImage, CGRect)? {
        guard let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]])?.first,
              let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
              let image = run(["-o", "-l\(windowID)"])
        else { return nil }
        return (image, frame)
    }

    // MARK: helpers

    static func activeDisplays() -> [CGDirectDisplayID] {
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return [] }
        let parking = WindowParking.shared.displayID
        return Array(ids.prefix(Int(count))).filter { $0 != parking }
    }

    private static func rectArgument(_ rect: CGRect) -> String {
        "\(Int(rect.origin.x.rounded())),\(Int(rect.origin.y.rounded())),"
            + "\(Int(rect.width.rounded())),\(Int(rect.height.rounded()))"
    }

    /// Runs screencapture into a private temporary file and loads the image.
    private static func run(_ arguments: [String]) -> CGImage? {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("munim-computer-use-\(getpid())-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = ["-x", "-t", "png"] + arguments + [file.path]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        do {
            try process.run()
        } catch {
            fputs("munim-computer-use: could not run screencapture: \(error.localizedDescription)\n", stderr)
            return nil
        }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            fputs("munim-computer-use: screencapture did not finish within \(Int(timeout)) s\n", stderr)
            return nil
        }
        guard process.terminationStatus == 0 else {
            fputs("munim-computer-use: screencapture \(arguments.joined(separator: " ")) exited "
                + "\(process.terminationStatus)\n", stderr)
            return nil
        }
        // Read the bytes now: an image made from the file decodes lazily, after
        // the deferred delete has already removed it.
        guard let bytes = try? Data(contentsOf: file),
              let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            fputs("munim-computer-use: screencapture \(arguments.joined(separator: " ")) wrote no image\n", stderr)
            return nil
        }
        return image
    }

    /// `pointResolution`: one pixel per point at most, as the ScreenCaptureKit
    /// display and window captures are sized; otherwise every physical pixel,
    /// as a region (zoom) capture is.
    private static func shot(
        _ image: CGImage, frame: CGRect, maxWidth: Int, pointResolution: Bool, encoding: ImageEncoding,
        title: String?
    ) -> CaptureShot? {
        var limit = maxWidth > 0 ? maxWidth : Int.max
        if pointResolution { limit = min(limit, max(1, Int(frame.width.rounded()))) }
        let sized = scaled(image, toWidth: limit)
        guard let data = encoding.encode(sized) else {
            fputs("munim-computer-use: could not encode the screencapture image as \(encoding.mimeType)\n", stderr)
            return nil
        }
        return CaptureShot(
            data: data, mimeType: encoding.mimeType, frame: frame,
            pixelWidth: sized.width, pixelHeight: sized.height, title: title)
    }

    /// At most `limit` pixels wide, never upscaled.
    private static func scaled(_ image: CGImage, toWidth limit: Int) -> CGImage {
        guard image.width > limit else { return image }
        let width = limit
        let height = max(1, Int((Double(image.height) * Double(width) / Double(image.width)).rounded()))
        guard let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return image }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage() ?? image
    }
}
