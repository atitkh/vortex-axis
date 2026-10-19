import AppKit
import CoreGraphics
import ScreenCaptureKit
import Vision
import AxisDesktopCore

/**
 * Text read from the pixels, for windows that expose few controls: one ScreenCaptureKit picture of the display the
 * area is on (the app's own windows left out, so the pointer is never read as text), cut to the area, read with
 * Vision, a line each. Needs Screen Recording access, and macOS 14 for `SCScreenshotManager`. Vision's boxes are
 * 0-1 with a bottom-left origin; `Coordinates.fromVision` turns them into the area's top-left points.
 * (U) all of it: written without a Mac.
 */
public enum TextReader {
    public struct Refused: Error, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    public static func read(area: Box) async throws -> [ScreenElement] {
        guard #available(macOS 14.0, *) else { throw Refused(message: "reading the pixels needs macOS 14 or newer") }
        guard Permissions.screenRecording else {
            throw Refused(message: "macOS has not given VorteX Axis Screen Recording access (System Settings > Privacy & Security > Screen Recording)")
        }
        let (image, shown) = try await capture(area: area)
        return try await Task.detached(priority: .userInitiated) { try recognise(image, area: shown) }.value
    }

    @available(macOS 14.0, *)
    static func capture(area: Box) async throws -> (CGImage, Box) {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        // The display holding the area's middle, else the one it overlaps most.
        let centre = CGPoint(x: area.x + area.w / 2, y: area.y + area.h / 2)
        let overlap = { (d: SCDisplay) -> Int64 in
            let b = CGDisplayBounds(d.displayID)
            return area.within(Box(x: Int(b.minX), y: Int(b.minY), w: Int(b.width), h: Int(b.height)))?.area ?? 0
        }
        guard let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(centre) })
            ?? content.displays.max(by: { overlap($0) < overlap($1) }) else { throw Refused(message: "no display shows that area") }
        let bounds = CGDisplayBounds(display.displayID)
        let screen = Box(x: Int(bounds.minX), y: Int(bounds.minY), w: Int(bounds.width), h: Int(bounds.height))
        guard let shown = area.within(screen) else { throw Refused(message: "that area is off the screen") }

        let me = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        let filter = SCContentFilter(display: display, excludingApplications: me, exceptingWindows: [])
        let config = SCStreamConfiguration()
        // Pixels per point of this display (2 on Retina): the picture is taken at full detail, then cut in pixels.
        let scale = CGDisplayCopyDisplayMode(display.displayID).map { Double($0.pixelWidth) / Double(max($0.width, 1)) } ?? 2
        config.width = Int(Double(screen.w) * scale)
        config.height = Int(Double(screen.h) * scale)
        config.showsCursor = false
        let picture = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let s = Double(picture.width) / Double(max(screen.w, 1))
        let crop = CGRect(x: Double(shown.x - screen.x) * s, y: Double(shown.y - screen.y) * s, width: Double(shown.w) * s, height: Double(shown.h) * s)
        guard let cut = picture.cropping(to: crop) else { throw Refused(message: "the picture could not be cut to the window") }
        return (cut, shown)
    }

    static func recognise(_ image: CGImage, area: Box) throws -> [ScreenElement] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).prefix(400).compactMap { o in
            guard let text = o.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
            let b = o.boundingBox
            let box = Coordinates.fromVision(x: b.minX, y: b.minY, w: b.width, h: b.height, area: area)
            return ScreenElement(kind: "text", name: text, x: box.x, y: box.y, w: box.w, h: box.h, source: "ocr")
        }
    }
}
