import Foundation

/**
 * Something readable on the screen: a control the window exposes, or text read from its pixels. Positions are
 * points with the origin at the top left of the main display (the one with the menu bar), y down; displays left
 * of or above it have negative coordinates. `kind` is one token from the Windows app's vocabulary (button, edit,
 * password, document...): Axis and Core both read it.
 */
public struct ScreenElement: @unchecked Sendable, Equatable {
    public var kind: String
    public var name: String
    public var x: Int, y: Int, w: Int, h: Int
    public var value: String?
    public var focused: Bool
    /** "ui" for a control, "ocr" for text read from the pixels. */
    public var source: String
    /** The platform's own handle on the control (an AXUIElement), to act on it later. Never sent, never compared. */
    public var ref: AnyObject?

    public init(kind: String, name: String, x: Int, y: Int, w: Int, h: Int, value: String? = nil, focused: Bool = false,
                source: String = "ui", ref: AnyObject? = nil) {
        self.kind = kind
        self.name = name
        self.x = x; self.y = y; self.w = w; self.h = h
        self.value = value
        self.focused = focused
        self.source = source
        self.ref = ref
    }

    public var box: Box { Box(x: x, y: y, w: w, h: h) }

    public static func == (a: ScreenElement, b: ScreenElement) -> Bool {
        a.kind == b.kind && a.name == b.name && a.box == b.box && a.value == b.value && a.focused == b.focused && a.source == b.source
    }
}

/** When to read text from the pixels: never, only when the window exposes little, or always. */
public enum OcrMode: Sendable { case never, auto, always }

/** A window: its title, its app's name as the person sees it (`localizedName`, "Google Chrome"), its box. */
public struct WindowInfo: Equatable, Sendable {
    public var title: String
    public var app: String
    public var x: Int, y: Int, w: Int, h: Int
    /** The app's bundle identifier ("com.google.Chrome"), when known. Not sent. */
    public var bundleID: String?
    /** After `window`: whether the window is minimised now, read back from it (kAXMinimized). Nil elsewhere. */
    public var minimised: Bool?

    public init(title: String, app: String, x: Int, y: Int, w: Int, h: Int, bundleID: String? = nil, minimised: Bool? = nil) {
        self.title = title
        self.app = app
        self.x = x; self.y = y; self.w = w; self.h = h
        self.bundleID = bundleID
        self.minimised = minimised
    }

    public var box: Box { Box(x: x, y: y, w: w, h: h) }
}

/** One display, in points, top-left origin. */
public struct Display: Equatable, Sendable {
    public var x: Int, y: Int, w: Int, h: Int
    public var primary: Bool
    public init(x: Int, y: Int, w: Int, h: Int, primary: Bool) {
        self.x = x; self.y = y; self.w = w; self.h = h
        self.primary = primary
    }
}

/** The window in front and what has the focus, read cheaply instead of a whole look. */
public struct ScreenState: Sendable {
    public var window: WindowInfo?
    public var focus: ScreenElement?
    public init(window: WindowInfo?, focus: ScreenElement?) {
        self.window = window
        self.focus = focus
    }
}

/** What a look found. The whole desktop is the box (screenX, screenY, screenW, screenH). */
public struct LookResult: Sendable {
    public var window: WindowInfo?
    public var mouseX: Int, mouseY: Int
    public var elements: [ScreenElement]
    public var screenX: Int, screenY: Int, screenW: Int, screenH: Int
    public var monitors: [Display]
    /** Text was read from the pixels. */
    public var ocr: Bool
    /** Why reading the pixels was skipped, when it was wanted and did not work. */
    public var ocrFailed: String?
    /** How long reading the controls and the pixels took, for the app's own list. */
    public var readMs: Int
    public var ocrMs: Int

    public init(window: WindowInfo?, mouseX: Int, mouseY: Int, elements: [ScreenElement], screenX: Int = 0, screenY: Int = 0,
                screenW: Int, screenH: Int, monitors: [Display] = [], ocr: Bool = false, ocrFailed: String? = nil,
                readMs: Int = 0, ocrMs: Int = 0) {
        self.window = window
        self.mouseX = mouseX; self.mouseY = mouseY
        self.elements = elements
        self.screenX = screenX; self.screenY = screenY; self.screenW = screenW; self.screenH = screenH
        self.monitors = monitors
        self.ocr = ocr
        self.ocrFailed = ocrFailed
        self.readMs = readMs
        self.ocrMs = ocrMs
    }
}

/** Which click: one with the left button, one with the right, or two quick left ones. */
public enum ClickKind: String, Sendable { case left, right, double }

/**
 * A picture of part of the screen, already shrunk and encoded: the area it shows is (x, y, areaW, areaH) in
 * points, `w` x `h` its own size in pixels.
 */
public struct Shot: Sendable {
    public var jpeg: Data
    public var w: Int, h: Int
    public var x: Int, y: Int, areaW: Int, areaH: Int
    public var window: WindowInfo?
    public init(jpeg: Data, w: Int, h: Int, x: Int, y: Int, areaW: Int, areaH: Int, window: WindowInfo?) {
        self.jpeg = jpeg
        self.w = w; self.h = h
        self.x = x; self.y = y; self.areaW = areaW; self.areaH = areaH
        self.window = window
    }
}

/**
 * What the computer itself does. The Mac app supplies it (`MacDesktop`); the tests fake it. The calls mirror the
 * Windows app's `IDesktop` one for one, so `DesktopCommands` keeps the wire's answers.
 */
public protocol Desktop: AnyObject, Sendable {
    /** `scope` is window, mouse or screen. */
    func look(scope: String, ocr: OcrMode) async throws -> LookResult
    /** Shows the pointer at (x, y) with `text` beside it (none when nil) for `seconds`. */
    func point(x: Int, y: Int, text: String?, seconds: Double) async throws
    func hide() async
    /** The middle of the main screen, for "show the pointer". */
    func centre() async -> (x: Int, y: Int)
    /** The window in front and the focused control, without reading the rest of the window. */
    func state() async throws -> ScreenState
    /** The window in front only (no focus read): what the block list is checked against before each input. */
    func inFront() async -> WindowInfo?

    /**
     * Clicks `target` (from the last look) or (x, y). Returns how and where: "invoked" when the control was pressed
     * through Accessibility, "focused" when a field was given the focus that way, "mouse" when a real click was sent
     * (and the pointer put back). With a target it can read again, it clicks where it shows now and refuses a click
     * that would land on a browser's own bar.
     */
    func click(target: ScreenElement?, x: Int, y: Int, kind: ClickKind) async throws -> (how: String, x: Int, y: Int)
    /** `e` (one with a ref) as it is now, its box cut to what shows; nil when it is gone or none of it shows. */
    func refresh(_ e: ScreenElement) async throws -> ScreenElement?
    /** Drags with the left button from (x1, y1) to (x2, y2), held `holdMs` first; the pointer is put back. Returns "mouse". */
    func drag(from: ScreenElement?, x1: Int, y1: Int, to: ScreenElement?, x2: Int, y2: Int, holdMs: Int) async throws -> String
    /** Types `text` into `target`, or into whatever has the focus. Refuses a password field. */
    func type(target: ScreenElement?, text: String) async throws
    /** Presses one key combination. */
    func keys(_ combo: KeyCombo) async throws
    /** Starts an app matched by name, or opens an http(s) address; waits for its window and brings it forward. */
    func open(app: String?, url: String?) async throws -> (opened: String, window: WindowInfo?)
    /** Brings forward the window best matching an app name or a title. */
    func switchTo(_ window: String) async throws -> WindowInfo
    /** Minimizes, maximizes, restores or moves to display `display` (1-based) the named window, or the one in front. */
    func window(op: String, window: String?, display: Int?) async throws -> WindowInfo
    /** The next or previous Space. */
    func desktop(next: Bool) async throws
    /** A picture of the window in front, the whole desktop, or `region` with a margin, its longer side at most `maxSide`. */
    func screenshot(scope: String, region: ScreenElement?, maxSide: Int) async throws -> Shot
    /** Scrolls `target` (or what holds it), else the window in front. Returns "scrolled" (the control did it) or "wheel". */
    func scroll(target: ScreenElement?, go: String, pages: Int) async throws -> String
    /** The open window best matching an app name or title, or nil. Does not bring it forward. */
    func findWindow(_ query: String) async throws -> WindowInfo?
    /** The text on the clipboard, or nil with why. */
    func readClipboard() async throws -> (text: String?, why: String?)
    /** Puts `text` into `target` (or the focus) by the clipboard and cmd+V, then puts the clipboard back. */
    func paste(target: ScreenElement?, text: String) async throws
}

extension Desktop {
    public func inFront() async -> WindowInfo? { try? await state().window }
}
