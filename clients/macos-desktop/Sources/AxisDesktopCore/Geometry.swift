import Foundation

/** A box in points, top-left origin. */
public struct Box: Equatable, Hashable, Sendable, CustomStringConvertible {
    public var x: Int, y: Int, w: Int, h: Int
    public init(x: Int, y: Int, w: Int, h: Int) {
        self.x = x; self.y = y; self.w = w; self.h = h
    }

    public var right: Int { x + w }
    public var bottom: Int { y + h }
    public var area: Int64 { w <= 0 || h <= 0 ? 0 : Int64(w) * Int64(h) }
    public var centre: (x: Int, y: Int) { (x + w / 2, y + h / 2) }
    public var description: String { "\(x),\(y) \(w)x\(h)" }

    /** The part of this box inside `other`, or nil when they do not overlap. */
    public func within(_ other: Box) -> Box? {
        let l = max(x, other.x), t = max(y, other.y), r = min(right, other.right), b = min(bottom, other.bottom)
        return r > l && b > t ? Box(x: l, y: t, w: r - l, h: b - t) : nil
    }

    public func inside(_ other: Box) -> Bool { x >= other.x && y >= other.y && right <= other.right && bottom <= other.bottom }
}

/**
 * Where on a control a click lands, and when it would hit a browser's own bar instead. Port of the Windows
 * app's `Geometry.cs` (0.10.4), pure arithmetic, checked by `GeometryTests`. The constants are in points here
 * (pixels on Windows); `chromeBand` 100 is a guess for macOS browsers to be measured (docs/mac-port.md 3.3).
 */
public enum Geometry {
    /** Under this share of a control showing (and not a big piece of it), it is scrolled into view before a click. */
    public static let minVisible = 0.4
    /** A piece at least this wide and tall is enough to click, whatever share of a big control it is. */
    public static let minSide = 40
    /** The top of a browser window, where its tabs, address bar and buttons are. */
    public static let chromeBand = 100

    /** The part of `box` inside every one of `areas` (the pages and scroll areas it is in, its window), or nil when none of it shows. */
    public static func visible(_ box: Box, _ areas: [Box]) -> Box? {
        var shown = box
        for a in areas {
            guard let cut = shown.within(a) else { return nil }
            shown = cut
        }
        return shown
    }

    /** How much of `box` shows, 0 to 1. */
    public static func fraction(_ box: Box, _ visible: Box?) -> Double {
        guard let v = visible, box.area > 0 else { return 0 }
        return min(1.0, Double(v.area) / Double(box.area))
    }

    /** Enough of a control shows to click it where it shows. */
    public static func enough(_ box: Box, _ visible: Box?) -> Bool {
        guard let v = visible else { return false }
        return fraction(box, v) >= minVisible || (v.w >= minSide && v.h >= minSide)
    }

    /** The element with its box cut to what shows. */
    public static func shown(_ e: ScreenElement, _ visible: Box) -> ScreenElement {
        var cut = e
        cut.x = visible.x; cut.y = visible.y; cut.w = visible.w; cut.h = visible.h
        return cut
    }

    /** Browser names, normalised (`normalise`): the Mac apps' own names and the Windows process names. */
    static let browsers: Set<String> = [
        "safari", "safaritechnologypreview", "chrome", "chromecanary", "chromebeta", "chromedev", "chromium", "brave", "bravebrowser",
        "arc", "firefox", "firefoxdeveloperedition", "firefoxnightly", "edge", "msedge", "edgebeta", "edgedev", "opera", "vivaldi",
        "orion", "zen", "zenbrowser", "waterfox", "librewolf", "floorp", "thorium", "iexplore", "duckduckgo",
    ]
    /** Browser bundle identifiers, lower case. */
    static let browserBundles: Set<String> = [
        "com.apple.safari", "com.apple.safaritechnologypreview", "com.google.chrome", "com.google.chrome.canary", "com.google.chrome.beta",
        "com.google.chrome.dev", "org.chromium.chromium", "com.brave.browser", "com.brave.browser.beta", "company.thebrowser.browser",
        "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly", "com.microsoft.edgemac",
        "com.microsoft.edgemac.beta", "com.microsoft.edgemac.dev", "com.operasoftware.opera", "com.vivaldi.vivaldi",
        "com.kagi.kagimacos", "app.zen-browser.zen", "com.duckduckgo.macos.browser",
    ]

    /** "Google Chrome" → "chrome", "Microsoft Edge" → "edge", "MSEdge.exe" → "msedge", "Brave Browser" → "brave". */
    static func normalise(_ app: String) -> String {
        var n = app.lowercased().replacingOccurrences(of: " ", with: "")
        for suffix in [".exe", ".app"] where n.hasSuffix(suffix) { n.removeLast(suffix.count) }
        for prefix in ["google", "microsoft", "mozilla"] where n.hasPrefix(prefix) && n.count > prefix.count { n.removeFirst(prefix.count) }
        if n.hasSuffix("browser"), n.count > "browser".count, browsers.contains(String(n.dropLast("browser".count))) { n.removeLast("browser".count) }
        return n
    }

    /** The app (its name, a Windows process name, or a bundle identifier) is a web browser. */
    public static func isBrowser(_ app: String?) -> Bool {
        guard let app, !app.isEmpty else { return false }
        return browsers.contains(normalise(app)) || browserBundles.contains(app.lowercased())
    }

    /** The window belongs to a web browser, by its app's name or bundle identifier. */
    public static func isBrowser(_ window: WindowInfo) -> Bool { isBrowser(window.app) || isBrowser(window.bundleID) }

    /**
     * Why a mouse click at `y` on a control in a web page would land on the browser's own bar instead, or nil to go
     * on. Only for a control inside a page (`inPage`): the address bar, tabs and buttons are clicked as ever, and so is
     * a bare x,y. `page` is the page's own box: a page that starts at the top of the window (full screen) may be
     * clicked there; one that reaches above the window says nothing, and the top band is refused.
     */
    public static func chromeRefusal(_ window: WindowInfo?, y: Int, inPage: Bool, page: Box?) -> String? {
        guard let window, inPage, isBrowser(window), y >= window.y, y < window.y + chromeBand else { return nil }
        if let p = page, p.y >= window.y - 2, y >= p.y { return nil }
        return "that spot is on the browser's own bar at the top of the window, not the page; scroll up a little so it comes down into the page, look again, and click it there"
    }
}

/**
 * The one place coordinates change origin. Accessibility, CGEvent and the CGWindowList use points with the
 * origin at the top left of the main display, y down: that is the wire's space, used as is. AppKit (NSScreen,
 * NSWindow frames) uses the bottom left of the main display, y up; Vision uses a 0-1 box with the origin at the
 * bottom left of the image. Retina never shows here: only captured images are in pixels, and they are scaled
 * back to points before anything leaves them.
 */
public enum Coordinates {
    /** An AppKit rectangle (bottom-left origin) as a top-left box. `mainHeight` is the main display's height (NSScreen.screens[0]). */
    public static func topLeft(x: Double, y: Double, w: Double, h: Double, mainHeight: Double) -> Box {
        Box(x: Int(x.rounded(.down)), y: Int((mainHeight - (y + h)).rounded(.down)), w: Int(w.rounded()), h: Int(h.rounded()))
    }

    /** A top-left point as an AppKit point (bottom-left origin), for placing the app's own windows. */
    public static func appKit(x: Double, y: Double, mainHeight: Double) -> (x: Double, y: Double) { (x, mainHeight - y) }

    /** A Vision box (0 to 1, bottom-left origin of the image) on an image of `area` (top-left points) as a top-left box. */
    public static func fromVision(x: Double, y: Double, w: Double, h: Double, area: Box) -> Box {
        let left = Double(area.x) + x * Double(area.w)
        let top = Double(area.y) + (1 - y - h) * Double(area.h)
        return Box(x: Int(left.rounded()), y: Int(top.rounded()), w: Int((w * Double(area.w)).rounded()), h: Int((h * Double(area.h)).rounded()))
    }

    /** The box holding every display. */
    public static func union(_ displays: [Display]) -> Box {
        guard let first = displays.first else { return Box(x: 0, y: 0, w: 0, h: 0) }
        var l = first.x, t = first.y, r = first.x + first.w, b = first.y + first.h
        for d in displays.dropFirst() {
            l = min(l, d.x); t = min(t, d.y); r = max(r, d.x + d.w); b = max(b, d.y + d.h)
        }
        return Box(x: l, y: t, w: r - l, h: b - t)
    }
}
