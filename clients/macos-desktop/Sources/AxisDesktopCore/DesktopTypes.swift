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

    public init(title: String, app: String, x: Int, y: Int, w: Int, h: Int, bundleID: String? = nil) {
        self.title = title
        self.app = app
        self.x = x; self.y = y; self.w = w; self.h = h
        self.bundleID = bundleID
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

/**
 * What the computer itself does. The Mac app supplies it (`MacDesktop`); the tests fake it. M1: reading and the
 * pointer only. Input (click, type, keys...) comes with M2 and is answered "not implemented" until then.
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
}
