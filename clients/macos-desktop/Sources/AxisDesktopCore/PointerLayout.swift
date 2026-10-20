import Foundation

/**
 * The agent's pointer, the parts that are arithmetic (the Windows app's `Overlay`): how long an action waits for it,
 * the arrow's outline, and where the speech bubble goes beside it. Everything here is in the wire's space: top-left
 * points of the main display, y down, so a display above or left of the main one has negative coordinates; a
 * `PanelRect` here has its `y` at the top. Pure, so it is tested off the Mac (`PointerTests`).
 */
public enum PointerLayout {
    /** How long the pointer glides to a new spot (the Windows app's `Overlay.GlideMs`). */
    public static let glideMs = 220
    /** How long an action waits when the pointer appeared on the spot instead. */
    public static let appearMs = 100

    /** How long to wait after showing the pointer before acting: its glide and a moment more, or a short moment. */
    public static func waitMs(glides: Bool) -> Int { glides ? glideMs + 30 : appearMs }

    /** The face's cyan (the Windows pointer's `#6FD4EF`), 0 to 255. */
    public static let cyan = (r: 0x6F, g: 0xD4, b: 0xEF)

    /** The arrow's outline in units, its tip at (0, 0), 21 wide and 30 tall (the Windows `Overlay.xaml` path). */
    public static let arrow: [(x: Double, y: Double)] = [(0, 0), (0, 26), (7, 19.5), (12, 30), (16.5, 28), (11.5, 18), (21, 18)]
    public static let arrowUnits = 30.0

    /** The arrow's length in points for the `pointerSize` setting (24 to 120). */
    public static func length(size: Double) -> Double { min(max(size, 24), 120) }

    /** Room between the bubble and the pointer, and between the bubble and the display's edge. */
    public static let gap = 8.0, edge = 8.0, before = 14.0

    /** Where the bubble goes: its top-left corner, and which side of the tip it is on. */
    public struct BubblePlace: Equatable, Sendable {
        public var x: Double, y: Double
        public var right: Bool, below: Bool
        public init(x: Double, y: Double, right: Bool, below: Bool) {
            self.x = x; self.y = y; self.right = right; self.below = below
        }
    }

    /**
     * The bubble of `w` by `h` points beside the pointer whose tip is at (`tipX`, `tipY`) on `display` (its whole
     * frame, top-left space). Right of the arrow and below it, as on Windows, unless the display ends there: then the
     * other side, and when neither side has room, the roomier one. Kept `edge` inside the display and under `safeTop`
     * (the notch's height; 0 without one). The tip is never covered: on a display too small for the bubble either side,
     * it keeps its distance from the tip down or up and may run off the display rather than hide the spot.
     */
    public static func bubble(tipX: Double, tipY: Double, size: Double, w: Double, h: Double, display: PanelRect,
                              safeTop: Double = 0) -> BubblePlace {
        let a = length(size: size)
        let left = display.x + edge, right = display.maxX - edge
        let top = display.y + max(0, safeTop) + edge, bottom = display.maxY - edge

        let rightX = tipX + a * 0.6 + gap, leftX = tipX - before - w
        let goRight: Bool
        if rightX + w <= right { goRight = true }
        else if leftX >= left { goRight = false }
        else { goRight = right - tipX >= tipX - left }

        let belowY = tipY + a * 0.9, aboveY = tipY - before - h
        let goBelow: Bool
        if belowY + h <= bottom { goBelow = true }
        else if aboveY >= top { goBelow = false }
        else { goBelow = bottom - tipY >= tipY - top }

        var x = clamp(goRight ? rightX : leftX, left, right - w)
        var y = clamp(goBelow ? belowY : aboveY, top, bottom - h)
        if covers(x: x, y: y, w: w, h: h, tipX: tipX, tipY: tipY) {
            // Too small a display: keep off the tip one way, whatever the edge says.
            y = goBelow ? belowY : aboveY
            if covers(x: x, y: y, w: w, h: h, tipX: tipX, tipY: tipY) { x = goRight ? rightX : leftX }
        }
        return BubblePlace(x: x, y: y, right: goRight, below: goBelow)
    }

    /** The box of `w` by `h` at (`x`, `y`) reaches within 4 points of the tip. */
    public static func covers(x: Double, y: Double, w: Double, h: Double, tipX: Double, tipY: Double) -> Bool {
        tipX > x - 4 && tipX < x + w + 4 && tipY > y - 4 && tipY < y + h + 4
    }

    /** `v` kept between `lo` and `hi`; `lo` when there is no room between them. */
    static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { hi < lo ? lo : min(max(v, lo), hi) }
}
