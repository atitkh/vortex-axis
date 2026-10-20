import AppKit
import AxisDesktopCore

/**
 * The menu bar icon, drawn in code as a template image (macOS tints it for the menu bar, light or dark, and when the
 * menu is open): the vortex's three spiral arms of dots, as on the logo, with a mark for the state. Idle: the spiral.
 * Listening: drawn in, the core bigger (the face pulls in to listen). Speaking: the spiral with two sound arcs.
 * Using this Mac: a pointer at the corner. Paused: faint, with pause bars. Offline: faint, hollow, struck through.
 */
@MainActor
enum MenuBarIcon {
    static let side: CGFloat = 18
    private static var cache: [MenuIconState: NSImage] = [:]

    static func image(_ state: MenuIconState) -> NSImage {
        if let image = cache[state] { return image }
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { _ in
            guard let g = NSGraphicsContext.current?.cgContext else { return false }
            draw(state, g)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = state.words
        cache[state] = image
        return image
    }

    /** In an 18 point square, y up. Template images use only the alpha: black at some alpha everywhere. */
    nonisolated static func draw(_ state: MenuIconState, _ g: CGContext) {
        let faint = state == .paused || state == .offline
        var centre = CGPoint(x: 9, y: 9)
        var reach: CGFloat = 8.0
        var core: CGFloat = 1.5
        switch state {
        case .listening:
            reach = 6.2
            core = 2.3
        case .speaking:
            centre = CGPoint(x: 7.4, y: 9)
            reach = 6.6
        default: break
        }
        spiral(g, centre: centre, reach: reach, core: core, alpha: faint ? 0.5 : 1, hollow: state == .offline)

        g.setFillColor(CGColor(gray: 0, alpha: 1))
        g.setStrokeColor(CGColor(gray: 0, alpha: 1))
        switch state {
        case .speaking:
            g.setLineWidth(1.3)
            g.setLineCap(.round)
            for (r, a) in [(CGFloat(4.4), CGFloat(0.55)), (CGFloat(7.0), CGFloat(0.5))] {
                g.addArc(center: CGPoint(x: 10.2, y: 9), radius: r, startAngle: -a, endAngle: a, clockwise: false)
                g.strokePath()
            }
        case .usingComputer:
            knockOut(g)
            // A pointer arrow, its tip up and left.
            let arrow: [CGPoint] = [CGPoint(x: 11.4, y: 8.6), CGPoint(x: 11.4, y: 1.6), CGPoint(x: 13.1, y: 3.2), CGPoint(x: 14.4, y: 0.6),
                                    CGPoint(x: 15.7, y: 1.2), CGPoint(x: 14.4, y: 3.8), CGPoint(x: 16.7, y: 4.0)]
            g.addLines(between: arrow)
            g.closePath()
            g.fillPath()
        case .paused:
            knockOut(g)
            g.fill(CGRect(x: 11.9, y: 0.8, width: 1.8, height: 6.4))
            g.fill(CGRect(x: 15.0, y: 0.8, width: 1.8, height: 6.4))
        case .offline:
            // A stroke across, with a gap cut either side so it reads against the dots.
            g.setLineCap(.round)
            g.setBlendMode(.clear)
            g.setLineWidth(3.6)
            g.move(to: CGPoint(x: 2.5, y: 15.5))
            g.addLine(to: CGPoint(x: 15.5, y: 2.5))
            g.strokePath()
            g.setBlendMode(.normal)
            g.setLineWidth(1.4)
            g.move(to: CGPoint(x: 2.5, y: 15.5))
            g.addLine(to: CGPoint(x: 15.5, y: 2.5))
            g.strokePath()
        default: break
        }
    }

    /** Three arms of nine dots wound round a core, bigger and a little fainter outwards (tuned to read at 18 points). */
    nonisolated private static func spiral(_ g: CGContext, centre: CGPoint, reach: CGFloat, core: CGFloat, alpha: CGFloat, hollow: Bool) {
        let arms = 3, dots = 9
        g.setLineWidth(0.8)
        for arm in 0..<arms {
            for i in 0..<dots {
                let t: CGFloat = CGFloat(i + 1) / CGFloat(dots)
                let r: CGFloat = core + 0.6 + (reach - core - 0.6) * pow(t, 0.85)
                let armAngle: CGFloat = CGFloat(arm) * 2 * CGFloat.pi / CGFloat(arms)
                let wound: CGFloat = 0.55 * 2 * CGFloat.pi * t
                let angle: CGFloat = armAngle - wound + CGFloat.pi / 2
                let size: CGFloat = 0.38 + 0.6 * t
                let x: CGFloat = centre.x + r * cos(angle) - size
                let y: CGFloat = centre.y + r * sin(angle) - size
                let at = CGRect(x: x, y: y, width: size * 2, height: size * 2)
                let a: CGFloat = alpha * (1 - 0.15 * t)
                if hollow {
                    g.setStrokeColor(CGColor(gray: 0, alpha: a))
                    g.strokeEllipse(in: at.insetBy(dx: 0.4, dy: 0.4))
                } else {
                    g.setFillColor(CGColor(gray: 0, alpha: a))
                    g.fillEllipse(in: at)
                }
            }
        }
        g.setFillColor(CGColor(gray: 0, alpha: alpha))
        g.fillEllipse(in: CGRect(x: centre.x - core, y: centre.y - core, width: core * 2, height: core * 2))
    }

    /** Clears the bottom right corner for a badge, so it never sits on dots. */
    nonisolated private static func knockOut(_ g: CGContext) {
        g.setBlendMode(.clear)
        g.fillEllipse(in: CGRect(x: 9.6, y: -1.2, width: 9.6, height: 10.6))
        g.setBlendMode(.normal)
    }
}
