import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import AxisDesktopCore

/**
 * Pictures of part of the screen, for screenshots and for reading text from the pixels. One function takes any
 * area in top-left points (a window, an element with a margin, the whole desktop), captures each display it covers
 * at no more pixels than the answer needs (ScreenCaptureKit's `sourceRect`, the app's own windows left out), and
 * puts the pieces together. macOS 14 and newer: `SCScreenshotManager`. macOS 13: the older Quartz call
 * (`CGWindowListCreateImage`, looked up at run time because newer SDKs mark it unavailable), with the app's own
 * pointer hidden first by the caller. Needs Screen Recording access either way.
 */
public enum ScreenCapture {
    struct Screen {
        let id: CGDirectDisplayID
        let box: Box
        /** Pixels per point (2 on a Retina display). */
        let scale: Double
    }

    static func screens() -> [Screen] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { id in
            let b = CGDisplayBounds(id)
            let scale = CGDisplayCopyDisplayMode(id).map { Double($0.pixelWidth) / Double(max($0.width, 1)) } ?? 2
            return Screen(id: id, box: Box(x: Int(b.minX), y: Int(b.minY), w: Int(b.width), h: Int(b.height)), scale: scale)
        }
    }

    public static var refusedNoAccess: String {
        "macOS has not given VorteX Axis Screen Recording access (System Settings > Privacy & Security > Screen Recording, then start the app again)"
    }

    /**
     * A picture of `area` whose longer side is at most `maxSide` pixels (and never more pixels than the screen
     * has), and the part of `area` it shows (cut to the displays). Throws with words when there is nothing to take.
     */
    public static func capture(area: Box, maxSide: Int) async throws -> (image: CGImage, shown: Box) {
        guard Permissions.screenRecording else { throw DesktopError(refusedNoAccess) }
        let all = screens()
        guard let shown = area.within(Coordinates.union(all.map { Display(x: $0.box.x, y: $0.box.y, w: $0.box.w, h: $0.box.h, primary: false) })),
              shown.w >= 8, shown.h >= 8 else { throw DesktopError("there is nothing on screen there to take a picture of") }
        let parts = all.compactMap { s in shown.within(s.box).map { (screen: s, part: $0) } }
        let size = Coordinates.pictureSize(area: shown, pixelsPerPoint: parts.map { $0.screen.scale }.max() ?? 2, maxSide: maxSide)
        guard let context = CGContext(data: nil, width: size.w, height: size.h, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
            throw DesktopError("could not make a picture of \(size.w)x\(size.h)")
        }
        context.setFillColor(CGColor(gray: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: size.w, height: size.h))
        context.interpolationQuality = .high
        if #available(macOS 14.0, *) {
            let content = try await Content.shared.get()
            let me = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
            for (screen, part) in parts {
                guard let display = content.displays.first(where: { $0.displayID == screen.id }) else { continue }
                let filter = SCContentFilter(display: display, excludingApplications: me, exceptingWindows: [])
                let config = SCStreamConfiguration()
                config.sourceRect = CGRect(x: part.x - screen.box.x, y: part.y - screen.box.y, width: part.w, height: part.h)
                config.width = max(1, Int((Double(part.w) * size.k).rounded()))
                config.height = max(1, Int((Double(part.h) * size.k).rounded()))
                config.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
                context.draw(image, in: place(part, in: shown, k: size.k, height: size.h))
            }
        } else {
            guard let image = legacyImage(shown) else { throw DesktopError("macOS gave no picture of the screen") }
            context.draw(image, in: CGRect(x: 0, y: 0, width: size.w, height: size.h))
        }
        guard let picture = context.makeImage() else { throw DesktopError("could not finish the picture") }
        return (picture, shown)
    }

    /** Where `part` goes in a picture of `area` scaled by `k`: Core Graphics draws from the bottom left. */
    static func place(_ part: Box, in area: Box, k: Double, height: Int) -> CGRect {
        let x = Double(part.x - area.x) * k
        let top = Double(part.y - area.y) * k
        let h = Double(part.h) * k
        return CGRect(x: x, y: Double(height) - top - h, width: Double(part.w) * k, height: h)
    }

    /** ScreenCaptureKit's list of displays and apps, kept for a few seconds: fetching it is the slow part of a capture. */
    @available(macOS 14.0, *)
    final class Content: @unchecked Sendable {
        static let shared = Content()
        private let lock = NSLock()
        private var kept: (at: Date, content: SCShareableContent)?

        func get() async throws -> SCShareableContent {
            if let kept = lock.withLock({ kept }), Date().timeIntervalSince(kept.at) < 10 { return kept.content }
            let fresh = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            lock.withLock { kept = (Date(), fresh) }
            return fresh
        }
    }

    typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    /** macOS 13: `CGWindowListCreateImage` of the area (on-screen windows, every display, nominal resolution). */
    static func legacyImage(_ area: Box) -> CGImage? {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
        let create = unsafeBitCast(symbol, to: CreateImage.self)
        let rect = CGRect(x: area.x, y: area.y, width: area.w, height: area.h)
        // kCGWindowListOptionOnScreenOnly (1), kCGNullWindowID (0), kCGWindowImageNominalResolution (1 << 4).
        return create(rect, 1, 0, 1 << 4)?.takeRetainedValue()
    }

    /** JPEG at the Windows app's quality (72). */
    public static func jpeg(_ image: CGImage, quality: Double = 0.72) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality as String: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}
