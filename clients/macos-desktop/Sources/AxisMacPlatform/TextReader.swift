import AppKit
import CoreGraphics
import Vision
import AxisDesktopCore

/**
 * Text read from the pixels, for windows that expose few controls: a picture of just the area (`ScreenCapture`,
 * the app's own windows left out), no bigger than `maxSide` pixels along its longer side, read with Vision's fast
 * recogniser off the main thread, a line each. Needs Screen Recording access; macOS 14 for ScreenCaptureKit (13
 * uses the older Quartz capture). Vision's boxes are 0-1 with a bottom-left origin; `Coordinates.fromVision` turns
 * them into the area's top-left points.
 *
 * 0.1.0 answered "took too long" on a Retina MacBook Air: it fetched ScreenCaptureKit's whole window list each time,
 * captured the entire display at full Retina resolution (about 2940x1912 pixels) and only then cut out the area,
 * and ran Vision's accurate recogniser with language correction on the result, all inside 4 s (unverified which of
 * the three cost most; the list fetch and the accurate pass are the usual suspects).
 */
public enum TextReader {
    public struct Refused: SaysWhy, LocalizedError {
        public let message: String
        public init(message: String) { self.message = message }
        public var errorDescription: String? { message }
    }

    /** Longest side of the picture Vision reads; plenty for text the size people read. */
    static let maxSide = 1568

    public static func read(area: Box) async throws -> [ScreenElement] {
        guard Permissions.screenRecording else { throw Refused(message: ScreenCapture.refusedNoAccess) }
        let (image, shown) = try await ScreenCapture.capture(area: area, maxSide: maxSide)
        return try await Task.detached(priority: .userInitiated) { try recognise(image, area: shown) }.value
    }

    static func recognise(_ image: CGImage, area: Box) throws -> [ScreenElement] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).prefix(400).compactMap { o in
            guard let text = o.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
            let b = o.boundingBox
            let box = Coordinates.fromVision(x: b.minX, y: b.minY, w: b.width, h: b.height, area: area)
            return ScreenElement(kind: "text", name: text, x: box.x, y: box.y, w: box.w, h: box.h, source: "ocr")
        }
    }
}
