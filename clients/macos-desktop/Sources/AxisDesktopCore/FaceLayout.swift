import Foundation

/** A rectangle in AppKit's screen space (points, origin at the bottom left of the main display, y up), as NSScreen gives. */
public struct PanelRect: Equatable, Sendable, CustomStringConvertible {
    public var x: Double, y: Double, w: Double, h: Double
    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x; self.y = y; self.w = w; self.h = h
    }

    public var maxX: Double { x + w }
    public var maxY: Double { y + h }
    public var midX: Double { x + w / 2 }
    public var midY: Double { y + h / 2 }
    public var description: String { "\(x),\(y) \(w)x\(h)" }

    /** The smallest rectangle holding this one and `other`. */
    public func union(_ other: PanelRect) -> PanelRect {
        let l = min(x, other.x), b = min(y, other.y)
        return PanelRect(x: l, y: b, w: max(maxX, other.maxX) - l, h: max(maxY, other.maxY) - b)
    }
}

/**
 * Where the face sits and how big it is: the Windows app's `FaceWindow.Look` and `Place` in AppKit's space. The face
 * is a disc (`disc` points across) in a square panel with `margin` round it for the shadow; the 240 square of `Face`
 * fills `figure` of the disc. Pure, so it is tested off the Mac.
 */
public enum FaceLayout {
    /** The sizes to choose from: the disc's diameter in points. Medium is the Mac's 132. */
    public static let sizes: [(id: String, label: String, disc: Double)] = [("small", "Small", 104), ("medium", "Medium", 132), ("large", "Large", 176)]
    /** Where along the bottom of the main display it sits; `custom` is where it was dragged (offered once there is one). */
    public static let places: [(id: String, label: String)] = [("center", "Bottom centre"), ("left", "Bottom left"), ("right", "Bottom right"), (custom, "Where you put it")]
    public static let custom = "custom"
    /** Room round the disc inside the panel, for the soft shadow. */
    public static let margin = 22.0
    /** How far above the bottom of the visible area (the Dock, else the screen's edge) the disc sits. */
    public static let lift = 14.0
    /** The part of the disc's diameter that `Face`'s 240 square takes (its dots reach about 0.44 of the square from the middle). */
    public static let figure = 0.72

    public static func disc(_ size: String) -> Double { sizes.first { $0.id == size }?.disc ?? 132 }
    public static func side(_ size: String) -> Double { disc(size) + margin * 2 }

    /**
     * The panel's frame. `visible` is the main display's visible frame (under the menu bar, above the Dock), `screens`
     * every display's frame. A dragged face's middle is `customX`, `customY` in top-left points (as saved, the Windows
     * field names), turned into AppKit's space with `mainHeight` (the main display's height); it is kept wholly on the
     * displays together, so a display taken away does not strand it. "Where you put it" with nowhere put is the centre.
     */
    public static func frame(size: String, place: String, customX: Double?, customY: Double?, visible: PanelRect,
                             screens: [PanelRect], mainHeight: Double) -> PanelRect {
        let d = disc(size), s = d + margin * 2
        if place == custom, let cx = customX, let cy = customY {
            let all = screens.dropFirst().reduce(screens.first ?? visible) { $0.union($1) }
            let x = clamp(cx, all.x + d / 2, all.maxX - d / 2)
            let y = clamp(mainHeight - cy, all.y + d / 2, all.maxY - d / 2)
            return PanelRect(x: x - s / 2, y: y - s / 2, w: s, h: s)
        }
        let discX: Double
        switch place {
        case "left": discX = visible.x + lift
        case "right": discX = visible.maxX - lift - d
        default: discX = visible.midX - d / 2
        }
        return PanelRect(x: discX - margin, y: visible.y + lift - margin, w: s, h: s)
    }

    /** Where a dragged face's middle is, in top-left points, to be saved. */
    public static func middle(of panel: PanelRect, mainHeight: Double) -> (x: Double, y: Double) {
        (panel.midX, mainHeight - panel.midY)
    }

    static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { hi < lo ? lo : min(max(v, lo), hi) }
}

/**
 * When the face is on screen (the Windows app's `FaceWindow.Update` and its leave timer): it comes at once when it is
 * wanted or kept, and goes `FaceShow.leaveAfter` seconds after it stops being wanted, unless it is wanted again in
 * between, so it does not blink out between a reply and the next call. Times are seconds on any steady clock.
 */
public struct FacePresence: Equatable, Sendable {
    public enum Change: Equatable, Sendable { case none, show, hide }

    public private(set) var shown = false
    /** When it goes, if nothing wants it before then. */
    public private(set) var leaveAt: Double?
    private var wanted = false, keep = false

    public init() {}

    public mutating func set(wanted: Bool, keep: Bool, now: Double) -> Change {
        self.wanted = wanted
        self.keep = keep
        if wanted || keep {
            leaveAt = nil
            if shown { return .none }
            shown = true
            return .show
        }
        if shown && leaveAt == nil { leaveAt = now + FaceShow.leaveAfter }
        return .none
    }

    /** Called when the time comes (or at any time): `.hide` once it is due. */
    public mutating func tick(now: Double) -> Change {
        guard let at = leaveAt, now >= at else { return .none }
        leaveAt = nil
        guard shown, !wanted, !keep else { return .none }
        shown = false
        return .hide
    }

    /** Put away at once (the face switched off, the app paused). */
    public mutating func reset() {
        self = FacePresence()
    }
}
