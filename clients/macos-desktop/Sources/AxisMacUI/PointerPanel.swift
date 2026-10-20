import AppKit
import QuartzCore
import AxisDesktopCore
import AxisMacPlatform

/**
 * The agent's pointer, the Windows app's `Overlay` made for a Mac: an arrow in the face's cyan with a soft glow, its
 * tip exactly on the spot, a ring breathing round the tip while it waits, and the agent's words in a dark pill with a
 * thin cyan edge on the roomier side (`PointerLayout.bubble`). Two panels (`FloatingPanel`: never key or main,
 * click-through, on every Space and over full-screen apps, out of screen captures), one for the arrow and one for the
 * words, so a glide only moves them. It glides from where it was (`PointerLayout.glideMs`, eased out) and fades out
 * after its time. With Reduce Motion it does not breathe or glide: it fades in on the spot.
 */
@MainActor
public final class PointerPanel: PointerDrawing {
    /** The arrow's length in points (the `pointerSize` setting). */
    public var size: CGFloat = 44
    private let arrowPanel: FloatingPanel
    private let bubblePanel: FloatingPanel
    private let arrowView: PointerArrowView
    private let bubbleView: PointerBubbleView
    private var generation = 0
    /** On screen where it was last put (fading out counts): the next show glides from there. */
    private var placed = false
    private var bubbleShown = false

    public init() {
        arrowPanel = FloatingPanel.make(level: .screenSaver)
        bubblePanel = FloatingPanel.make(level: .screenSaver)
        arrowView = PointerArrowView(frame: NSRect(x: 0, y: 0, width: 120, height: 120))
        bubbleView = PointerBubbleView(frame: NSRect(x: 0, y: 0, width: 100, height: 40))
        arrowPanel.contentView = arrowView
        bubblePanel.contentView = bubbleView
    }

    @discardableResult
    public func show(x: Int, y: Int, text: String?, seconds: Double) -> Bool {
        generation += 1
        let mine = generation
        let tipX = Double(x), tipY = Double(y)
        let mainHeight = Screens.mainHeight
        let calm = Screens.reduceMotion

        // The arrow's panel is a square with the tip at its middle.
        arrowView.build(size: Double(size))
        let side = Double(arrowView.side)
        let corner = Coordinates.appKit(x: tipX - side / 2, y: tipY + side / 2, mainHeight: mainHeight)
        let arrowFrame = NSRect(x: corner.x, y: corner.y, width: side, height: side)

        // The words beside it, on the roomier side of the display the tip is on.
        bubbleView.text = text
        var bubbleFrame: NSRect?
        if let content = bubbleView.bubbleSize {
            let (display, safeTop) = Self.display(at: tipX, tipY, mainHeight: mainHeight)
            let p = PointerLayout.bubble(tipX: tipX, tipY: tipY, size: Double(size), w: Double(content.width), h: Double(content.height),
                                         display: display, safeTop: safeTop)
            let m = Double(PointerBubbleView.margin)
            let o = Coordinates.appKit(x: p.x - m, y: p.y + Double(content.height) + m, mainHeight: mainHeight)
            bubbleFrame = NSRect(x: o.x, y: o.y, width: Double(content.width) + m * 2, height: Double(content.height) + m * 2)
        }

        let glides = placed && !calm
        if glides {
            let bubbleGlides = bubbleShown && bubbleFrame != nil, bubbleTarget = bubbleFrame
            NSAnimationContext.runAnimationGroup { c in
                c.duration = Double(PointerLayout.glideMs) / 1000
                c.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1)
                arrowPanel.animator().setFrame(arrowFrame, display: true)
                arrowPanel.animator().alphaValue = 1
                if bubbleGlides, let bubbleTarget {
                    bubblePanel.animator().setFrame(bubbleTarget, display: true)
                    bubblePanel.animator().alphaValue = 1
                }
            }
            if !bubbleGlides { appear(bubbleFrame) }
        } else {
            arrowPanel.setFrame(arrowFrame, display: true)
            arrowPanel.alphaValue = 0
            arrowPanel.orderFrontRegardless()
            fadeIn(arrowPanel)
            appear(bubbleFrame)
        }
        arrowView.breathe(!calm)
        placed = true
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.generation == mine else { return }
            self.hide()
        }
        return glides
    }

    public func hide() {
        generation += 1
        let mine = generation
        NSAnimationContext.runAnimationGroup({ c in
            c.duration = 0.3
            arrowPanel.animator().alphaValue = 0
            bubblePanel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                self.arrowPanel.orderOut(nil)
                self.bubblePanel.orderOut(nil)
                self.arrowView.breathe(false)
                self.placed = false
                self.bubbleShown = false
            }
        })
    }

    /** The words fade in at `frame`, or fade away when there are none. */
    private func appear(_ frame: NSRect?) {
        guard let frame else {
            if bubbleShown {
                NSAnimationContext.runAnimationGroup { c in
                    c.duration = 0.12
                    bubblePanel.animator().alphaValue = 0
                }
            }
            bubbleShown = false
            return
        }
        bubblePanel.setFrame(frame, display: true)
        bubblePanel.alphaValue = 0
        bubblePanel.orderFrontRegardless()
        bubbleView.needsDisplay = true
        fadeIn(bubblePanel)
        bubbleShown = true
    }

    private func fadeIn(_ panel: NSPanel) {
        NSAnimationContext.runAnimationGroup { c in
            c.duration = 0.16
            panel.animator().alphaValue = 1
        }
    }

    /** The display (its whole frame, top-left space) the point is on, or the nearest one, and its notch's height. */
    static func display(at x: Double, _ y: Double, mainHeight: Double) -> (PanelRect, Double) {
        var best: (PanelRect, Double)?
        var nearest = Double.infinity
        for s in NSScreen.screens {
            let f = s.frame
            let r = PanelRect(x: Double(f.minX), y: mainHeight - Double(f.maxY), w: Double(f.width), h: Double(f.height))
            let dx = max(r.x - x, 0, x - r.maxX), dy = max(r.y - y, 0, y - r.maxY)
            let d = dx * dx + dy * dy
            if d < nearest {
                nearest = d
                best = (r, Double(s.safeAreaInsets.top))
            }
        }
        return best ?? (PanelRect(x: 0, y: 0, w: 1440, h: 900), 0)
    }
}

/** The pointer's colours. */
enum PointerColour {
    static let cyan = NSColor(srgbRed: CGFloat(PointerLayout.cyan.r) / 255, green: CGFloat(PointerLayout.cyan.g) / 255,
                              blue: CGFloat(PointerLayout.cyan.b) / 255, alpha: 1)
    static let words = NSColor(srgbRed: 0xF2 / 255.0, green: 0xF3 / 255.0, blue: 0xF7 / 255.0, alpha: 1)
    static let top = NSColor(srgbRed: 0x1A / 255.0, green: 0x1B / 255.0, blue: 0x24 / 255.0, alpha: 0.96)
    static let bottom = NSColor(srgbRed: 0x0D / 255.0, green: 0x0D / 255.0, blue: 0x13 / 255.0, alpha: 0.96)
}

/**
 * The arrow (`PointerLayout.arrow`, tip at the middle of the view) with its cyan glow, and the ring round the tip,
 * in Core Animation layers so the breathing costs nothing on the main thread.
 */
final class PointerArrowView: NSView {
    private let root = CALayer()
    private let ring = CAShapeLayer()
    private let arrow = CAShapeLayer()
    /** The view's side in points: room for the arrow, the ring at its biggest breath, and the glow. */
    private(set) var side: CGFloat = 120
    private var builtFor: Double = 0
    private var breathing = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        root.isGeometryFlipped = true
        layer = root
        wantsLayer = true
        let cyan = PointerColour.cyan.cgColor
        ring.fillColor = nil
        ring.strokeColor = cyan
        ring.lineWidth = 2
        ring.opacity = 0.6
        ring.shadowColor = cyan
        ring.shadowOpacity = 0.9
        ring.shadowRadius = 9
        ring.shadowOffset = .zero
        arrow.fillColor = cyan
        arrow.strokeColor = NSColor.black.withAlphaComponent(0.85).cgColor
        arrow.lineWidth = 1.5
        arrow.lineJoin = .round
        arrow.shadowColor = cyan
        arrow.shadowOpacity = 0.8
        arrow.shadowRadius = 7
        arrow.shadowOffset = .zero
        root.addSublayer(ring)
        root.addSublayer(arrow)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let scale = window?.backingScaleFactor ?? 2
        for l in [root, ring, arrow] { l.contentsScale = scale }
    }

    /** The arrow and the ring for the `pointerSize` setting; nothing to do when it has not changed. */
    func build(size: Double) {
        guard size != builtFor else { return }
        builtFor = size
        let a = CGFloat(PointerLayout.length(size: size)), k = a / CGFloat(PointerLayout.arrowUnits)
        let ringSide = 28 * k
        let half = ceil(max(ringSide / 2 * 1.25, a) + 16)
        side = half * 2
        setFrameSize(NSSize(width: side, height: side))
        let path = CGMutablePath()
        for (i, p) in PointerLayout.arrow.enumerated() {
            let point = CGPoint(x: half + CGFloat(p.x) * k, y: half + CGFloat(p.y) * k)
            if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        path.closeSubpath()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        arrow.frame = CGRect(x: 0, y: 0, width: side, height: side)
        arrow.path = path
        ring.frame = CGRect(x: half - ringSide / 2, y: half - ringSide / 2, width: ringSide, height: ringSide)
        ring.path = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: ringSide, height: ringSide), transform: nil)
        CATransaction.commit()
    }

    /** The ring grows and fades, and the glow with it, every 0.9 s each way (the Windows app's breath); still when off. */
    func breathe(_ on: Bool) {
        if on, breathing, ring.animation(forKey: "breathe") != nil { return }
        breathing = on
        ring.removeAnimation(forKey: "breathe")
        arrow.removeAnimation(forKey: "breathe")
        guard on else { return }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.25
        fade.toValue = 0.8
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.85
        grow.toValue = 1.25
        ring.add(Self.breath([fade, grow]), forKey: "breathe")
        let glow = CABasicAnimation(keyPath: "shadowOpacity")
        glow.fromValue = 0.55
        glow.toValue = 0.95
        arrow.add(Self.breath([glow]), forKey: "breathe")
    }

    private static func breath(_ animations: [CAAnimation]) -> CAAnimationGroup {
        let g = CAAnimationGroup()
        g.animations = animations
        g.duration = 0.9
        g.autoreverses = true
        g.repeatCount = .infinity
        g.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        g.isRemovedOnCompletion = false
        return g
    }
}

/** The agent's words in a dark pill with a thin cyan edge and a glowing cyan dot, with room round it for its shadow. */
final class PointerBubbleView: NSView {
    /** Room round the pill in its panel, for the shadow. */
    static let margin: CGFloat = 14
    static let maxText: CGFloat = 300
    static let padX: CGFloat = 14, padY: CGFloat = 9
    static let dot: CGFloat = 6, dotGap: CGFloat = 8
    static let font = NSFont.systemFont(ofSize: 13, weight: .medium)

    var text: String? { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }

    var words: NSAttributedString? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byWordWrapping
        style.lineSpacing = 2
        return NSAttributedString(string: String(text.prefix(200)),
                                  attributes: [.font: Self.font, .foregroundColor: PointerColour.words, .paragraphStyle: style])
    }

    private static func textSize(_ w: NSAttributedString) -> NSSize {
        let r = w.boundingRect(with: NSSize(width: maxText, height: 1000), options: [.usesLineFragmentOrigin, .usesFontLeading])
        return NSSize(width: ceil(r.width), height: ceil(r.height))
    }

    /** The pill's size, padding included, or nil with nothing to say. */
    var bubbleSize: NSSize? {
        guard let w = words else { return nil }
        let t = Self.textSize(w)
        return NSSize(width: t.width + Self.padX * 2 + Self.dot + Self.dotGap, height: t.height + Self.padY * 2)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let w = words else { return }
        let rect = bounds.insetBy(dx: Self.margin, dy: Self.margin)
        guard rect.width > 0, rect.height > 0 else { return }
        let radius = min(16, rect.height / 2)
        let shape = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.5)
        shadow.shadowBlurRadius = 9
        shadow.shadowOffset = NSSize(width: 0, height: -3)
        shadow.set()
        PointerColour.bottom.setFill()
        shape.fill()
        NSGraphicsContext.restoreGraphicsState()

        // A little lighter at the top than at the bottom, like the pills (the view is flipped: 90° runs down).
        NSGradient(starting: PointerColour.top, ending: PointerColour.bottom)?.draw(in: shape, angle: 90)
        let edge = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: radius - 0.5, yRadius: radius - 0.5)
        edge.lineWidth = 1
        PointerColour.cyan.withAlphaComponent(0.55).setStroke()
        edge.stroke()

        let line = NSLayoutManager().defaultLineHeight(for: Self.font)
        let dotRect = NSRect(x: rect.minX + Self.padX, y: rect.minY + Self.padY + line / 2 - Self.dot / 2, width: Self.dot, height: Self.dot)
        NSGraphicsContext.saveGraphicsState()
        let glow = NSShadow()
        glow.shadowColor = PointerColour.cyan.withAlphaComponent(0.9)
        glow.shadowBlurRadius = 4.5
        glow.shadowOffset = .zero
        glow.set()
        PointerColour.cyan.setFill()
        NSBezierPath(ovalIn: dotRect).fill()
        NSGraphicsContext.restoreGraphicsState()

        let t = Self.textSize(w)
        w.draw(with: NSRect(x: dotRect.maxX + Self.dotGap, y: rect.minY + Self.padY, width: t.width + 1, height: t.height),
               options: [.usesLineFragmentOrigin, .usesFontLeading])
    }
}
