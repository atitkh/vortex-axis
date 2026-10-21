import Foundation

/** The display the pills show on, as NSScreen describes it, in AppKit's space. */
public struct PillScreen: Equatable, Sendable {
    public var frame: PanelRect
    /** Under the menu bar, above the Dock. */
    public var visible: PanelRect
    /** The camera housing at the top middle, on a MacBook that has one. */
    public var notch: PanelRect?

    public init(frame: PanelRect, visible: PanelRect, notch: PanelRect?) {
        self.frame = frame
        self.visible = visible
        self.notch = notch
    }

    /**
     * The notch from what NSScreen says (macOS 12+): `safeTop` is `safeAreaInsets.top` (0 without a notch), the widths
     * those of `auxiliaryTopLeftArea` and `auxiliaryTopRightArea`, the parts of the menu bar either side of it. Only the
     * widths are used: what lies between them is the notch.
     */
    public static func notch(frame: PanelRect, safeTop: Double, leftWidth: Double?, rightWidth: Double?) -> PanelRect? {
        guard safeTop > 0, let l = leftWidth, let r = rightWidth else { return nil }
        let w = frame.w - l - r
        guard w > 0, w < frame.w / 2 else { return nil }
        return PanelRect(x: frame.x + l, y: frame.maxY - safeTop, w: w, h: safeTop)
    }
}

/**
 * Where the pills go at the top middle of the main display (the Windows app's `Pill.Place`, made for a Mac). Without a
 * notch a pill floats `gap` under the menu bar. With one, the first pill grows out of the notch like the Dynamic
 * Island: black, flush with the top of the screen, at least as wide as the notch, its words under the notch's line;
 * a second pill floats under it. Every pill sits in a panel with `margin` round it for the shadow (none at the top of
 * one grown out of the notch). Pure, so it is tested off the Mac.
 */
public enum PillLayout {
    public static let gap = 8.0
    public static let margin = 16.0
    /** How much wider than the notch a pill grown out of it is, each side, so its words clear the camera. */
    public static let wings = 22.0

    public struct Placed: Equatable, Sendable {
        /** The panel's frame. */
        public var panel: PanelRect
        /** The pill itself, in screen space. */
        public var pill: PanelRect
        /** Grown out of the notch (black, square at the top, the words under `topInset`). */
        public var attached: Bool
        /** Room at the top of the pill before its words: the notch's height when attached, else 0. */
        public var topInset: Double
        /** The pill when it is drawn in, before it grows (the notch itself, or a small capsule), relative to the pill's top middle. */
        public var collapsed: (w: Double, h: Double)

        public static func == (a: Placed, b: Placed) -> Bool {
            a.panel == b.panel && a.pill == b.pill && a.attached == b.attached && a.topInset == b.topInset
                && a.collapsed.w == b.collapsed.w && a.collapsed.h == b.collapsed.h
        }
    }

    /**
     * A pill whose words take `w` by `h` points (padding included), on `screen`; `under` is the bottom (AppKit y) of the
     * pill above it, or nil when it is the first.
     */
    /**
     * What a pill goes under, given the bottoms (AppKit y) of the pills above it in their order (nil for one not up):
     * the lowest of them, or nil when none is up, and then it is the first (out of the notch).
     */
    public static func under(_ bottoms: [Double?]) -> Double? { bottoms.compactMap { $0 }.min() }

    public static func place(w: Double, h: Double, on screen: PillScreen, under: Double? = nil) -> Placed {
        if under == nil, let notch = screen.notch {
            let pw = max(w, notch.w + wings * 2), ph = notch.h + h
            let pill = PanelRect(x: notch.midX - pw / 2, y: screen.frame.maxY - ph, w: pw, h: ph)
            let panel = PanelRect(x: pill.x - margin, y: pill.y - margin, w: pw + margin * 2, h: ph + margin)
            return Placed(panel: panel, pill: pill, attached: true, topInset: notch.h, collapsed: (notch.w, notch.h))
        }
        let top = (under ?? screen.visible.maxY) - gap
        let pill = PanelRect(x: screen.frame.midX - w / 2, y: top - h, w: w, h: h)
        let panel = PanelRect(x: pill.x - margin, y: pill.y - margin, w: w + margin * 2, h: h + margin * 2)
        return Placed(panel: panel, pill: pill, attached: false, topInset: 0, collapsed: (min(w, 96), min(h, 24)))
    }
}
