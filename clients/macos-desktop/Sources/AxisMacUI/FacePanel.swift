import AppKit
import QuartzCore
import AxisDesktopCore

/**
 * Vortex's face on this Mac: the one the boards draw (Core's `Face`), on a small frosted disc at the bottom middle of
 * the main display (the Windows app's `FaceWindow`). It comes in with a spring for a voice turn and while an agent is
 * using this Mac (the computer icon), and goes `FaceShow.leaveAfter` seconds after; or stays, when kept, and then a
 * click on it talks and a right-button (or Control) drag moves it. Click-through otherwise; never takes the focus; out of every
 * screen capture. Reduce motion: no spring, and the face turns slower without its sparkle (docs/face.md section 6).
 */
@MainActor
public final class FacePanel: NSObject {
    /** The loudness to follow each frame (the person's voice or the agent's), or below 0 for none. */
    public var loudness: (() -> Double)?
    /** A click on the face, when it is kept on screen. */
    public var onClick: (() -> Void)?
    /** The face was dragged somewhere: where its middle is now, in top-left points (to be saved). */
    public var onMoved: ((Double, Double) -> Void)?

    private let panel: FloatingPanel
    private let view: FaceView
    private let face: Face
    private var ticker: Ticker?
    private var presence = FacePresence()
    private var kept = false
    private var voiced = false
    private var size = "medium", place = "center"
    private var customX: Double?, customY: Double?
    private var last: CFTimeInterval = 0
    /** Counts shows and hides, so a fade that finishes late does not hide a face shown again since. */
    private var generation = 0

    public override init() {
        let face = Face()
        self.face = face
        panel = FloatingPanel.make(level: FloatingPanel.underMenuBar)
        view = FaceView(face: face)
        super.init()
        panel.contentView = view
        view.clicked = { [weak self] in
            guard let self, self.kept else { return }
            self.onClick?()
        }
        view.dragged = { [weak self] by in self?.drag(by) }
        view.dropped = { [weak self] in self?.dropped() }
        ticker = Ticker { [weak self] in self?.step() }
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(displayOptionsChanged),
                                                          name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        face.reducedMotion = Screens.reduceMotion
        layout()
    }

    // MARK: What the app tells it

    /** Size and place, from the settings; x and y are where a dragged face's middle was left (top-left points). */
    public func look(size: String, place: String, x: Double?, y: Double?) {
        self.size = size
        self.place = place
        customX = x
        customY = y
        layout()
    }

    /** Whether it stays on screen between turns (idle, drifting through its looks); then clicks reach it. */
    public func keep(_ on: Bool) {
        kept = on
        panel.ignoresMouseEvents = !on
        update()
    }

    /** What to show (Core's `FaceShow`: the voice part's mode, what the agent is doing, whether an agent is here). */
    public func set(_ show: FaceShow) {
        face.setMode(show.mode)
        face.setDoing(show.doing)
        voiced = show.voiced
        wanted = show.wanted
        update()
    }

    private var wanted = false
    /** When the leave check is set for, so each leave is scheduled once. */
    private var leaveScheduled: Double?

    // MARK: Coming and going

    private func now() -> Double { CACurrentMediaTime() }

    private func update() {
        switch presence.set(wanted: wanted, keep: kept, now: now()) {
        case .show: appear()
        case .hide: disappear()
        case .none: break
        }
        if let at = presence.leaveAt, at != leaveScheduled {
            leaveScheduled = at
            let wait = max(0, at - now()) + 0.02
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                guard let self else { return }
                if self.presence.tick(now: self.now()) == .hide { self.disappear() }
            }
        }
    }

    private func appear() {
        generation += 1
        layout()
        last = 0
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        ticker?.start()
        NSAnimationContext.runAnimationGroup { c in
            c.duration = 0.22
            panel.animator().alphaValue = 1
        }
        if !Screens.reduceMotion { view.springIn() }
    }

    private func disappear() {
        generation += 1
        let mine = generation
        NSAnimationContext.runAnimationGroup({ c in
            c.duration = 0.45
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                self.panel.orderOut(nil)
                self.ticker?.stop()
            }
        })
    }

    /** One frame: the face moves on and the view paints it. */
    private func step() {
        let t = CACurrentMediaTime()
        let dt = last == 0 ? 0 : t - last
        last = t
        // Every frame, not only when the voice part reports: the agent's voice changes faster than its state.
        face.level = voiced ? (loudness?() ?? -1) : -1
        view.paint(face.frame(dt))
    }

    // MARK: Where it is

    private func layout() {
        guard let main = Screens.main else { return }
        let frame = FaceLayout.frame(size: size, place: place, customX: customX, customY: customY,
                                     visible: Screens.rect(main.visibleFrame), screens: NSScreen.screens.map { Screens.rect($0.frame) },
                                     mainHeight: Screens.mainHeight)
        panel.setFrame(Screens.nsRect(frame), display: true)
        view.disc = FaceLayout.disc(size)
    }

    private var dragStart: NSPoint?

    private func drag(_ by: NSSize) {
        if dragStart == nil { dragStart = panel.frame.origin }
        guard let from = dragStart else { return }
        panel.setFrameOrigin(NSPoint(x: from.x + by.width, y: from.y + by.height))
    }

    private func dropped() {
        guard dragStart != nil else { return }
        dragStart = nil
        // Kept on the displays: let go half off one, it comes back on.
        let middle = FaceLayout.middle(of: Screens.rect(panel.frame), mainHeight: Screens.mainHeight)
        look(size: size, place: FaceLayout.custom, x: middle.x, y: middle.y)
        let settled = FaceLayout.middle(of: Screens.rect(panel.frame), mainHeight: Screens.mainHeight)
        customX = settled.x
        customY = settled.y
        onMoved?(settled.x, settled.y)
    }

    @objc private func screensChanged() { layout() }

    @objc private func displayOptionsChanged() { face.reducedMotion = Screens.reduceMotion }
}

/**
 * The disc and the face on it: a soft shadow, the system's frosted material (light or dark with the Mac's appearance),
 * a dark pool in the middle so the dots read on either, a hairline edge, then the dots, the core and the pen icon,
 * scaled from the face's 240 square. Flipped, so y runs down as in `Face`.
 */
final class FaceView: NSView {
    private let face: Face
    private let shadowView = NSView()
    private let material = NSVisualEffectView()
    private var frameNow: Face.Frame?
    var clicked: (() -> Void)?
    var dragged: ((NSSize) -> Void)?
    var dropped: (() -> Void)?
    private var grab: NSPoint?
    private var moved = false

    /** The disc's diameter in points. */
    var disc: Double = 132 { didSet { needsLayout = true } }

    init(face: Face) {
        self.face = face
        super.init(frame: NSRect(x: 0, y: 0, width: 176, height: 176))
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        shadowView.wantsLayer = true
        addSubview(shadowView)
        material.material = .hudWindow
        material.blendingMode = .behindWindow
        material.state = .active
        addSubview(material)
    }

    required init?(coder: NSCoder) { nil }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private var discRect: NSRect {
        let d = CGFloat(disc)
        return NSRect(x: (bounds.width - d) / 2, y: (bounds.height - d) / 2, width: d, height: d)
    }

    private var dark: Bool { effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }

    override func layout() {
        super.layout()
        let r = discRect
        shadowView.frame = r
        material.frame = r
        material.maskImage = NSImage(size: r.size, flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(ovalIn: rect).fill()
            return true
        }
        styleShadow()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        styleShadow()
        needsDisplay = true
    }

    private func styleShadow() {
        guard let l = shadowView.layer else { return }
        let r = shadowView.bounds
        l.cornerRadius = r.width / 2
        l.backgroundColor = NSColor(white: 0, alpha: 0.2).cgColor
        l.shadowPath = CGPath(ellipseIn: r, transform: nil)
        l.shadowColor = NSColor.black.cgColor
        l.shadowOpacity = dark ? 0.55 : 0.3
        l.shadowRadius = 12
        l.shadowOffset = CGSize(width: 0, height: -4)
    }

    /** Grows in from a little smaller with a spring (not with Reduce motion: the caller only fades it then). */
    func springIn() {
        guard let l = layer else { return }
        let c = bounds.width / 2
        let small = CATransform3DConcat(CATransform3DConcat(CATransform3DMakeTranslation(-c, -c, 0), CATransform3DMakeScale(0.6, 0.6, 1)),
                                        CATransform3DMakeTranslation(c, c, 0))
        let spring = CASpringAnimation(keyPath: "sublayerTransform")
        spring.fromValue = NSValue(caTransform3D: small)
        spring.toValue = NSValue(caTransform3D: CATransform3DIdentity)
        spring.mass = 1
        spring.stiffness = 240
        spring.damping = 17
        spring.duration = spring.settlingDuration
        l.sublayerTransform = CATransform3DIdentity
        l.add(spring, forKey: "appear")
    }

    func paint(_ frame: Face.Frame) {
        frameNow = frame
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let g = NSGraphicsContext.current?.cgContext else { return }
        let r = discRect
        let mid = CGPoint(x: r.midX, y: r.midY)
        // A dark pool in the middle of the material, deeper in Light mode, so the dots read on any wallpaper.
        let space = CGColorSpaceCreateDeviceRGB()
        let pool = [CGColor(red: 0.02, green: 0.02, blue: 0.04, alpha: dark ? 0.55 : 0.78),
                    CGColor(red: 0.02, green: 0.02, blue: 0.04, alpha: dark ? 0.25 : 0.5)] as CFArray
        g.saveGState()
        g.addEllipse(in: r)
        g.clip()
        if let gradient = CGGradient(colorsSpace: space, colors: pool, locations: [0, 1]) {
            g.drawRadialGradient(gradient, startCenter: mid, startRadius: 0, endCenter: mid, endRadius: r.width / 2, options: [])
        }
        g.restoreGState()
        g.setStrokeColor(dark ? CGColor(red: 1, green: 1, blue: 1, alpha: 0.14) : CGColor(red: 0, green: 0, blue: 0, alpha: 0.12))
        g.setLineWidth(1)
        g.strokeEllipse(in: r.insetBy(dx: 0.5, dy: 0.5))

        guard let f = frameNow else { return }
        let scale = r.width * CGFloat(FaceLayout.figure) / CGFloat(Face.size)
        g.saveGState()
        g.addEllipse(in: r)
        g.clip()
        g.translateBy(x: mid.x - CGFloat(Face.size / 2) * scale, y: mid.y - CGFloat(Face.size / 2) * scale)
        g.scaleBy(x: scale, y: scale)
        // Each dot gives off a little light of its own colour, as on the boards' panels, where overlapping dots add up.
        for d in f.dots { fill(g, d, radius: d.radius * 2.4, alpha: 0.15) }
        if let c = f.core { fill(g, c, radius: c.radius * 2.6, alpha: 0.19) }
        for d in f.dots { fill(g, d, radius: d.radius, alpha: 1) }
        if let c = f.core { fill(g, c, radius: c.radius, alpha: 1) }
        if let pen = f.icon {
            g.setStrokeColor(red: CGFloat(pen.r), green: CGFloat(pen.g), blue: CGFloat(pen.b), alpha: CGFloat(pen.alpha))
            g.setLineWidth(CGFloat(pen.width))
            g.setLineCap(.round)
            g.setLineJoin(.round)
            for stroke in pen.strokes where stroke.count >= 4 {
                g.move(to: CGPoint(x: stroke[0], y: stroke[1]))
                var i = 2
                while i + 1 < stroke.count {
                    g.addLine(to: CGPoint(x: stroke[i], y: stroke[i + 1]))
                    i += 2
                }
            }
            g.strokePath()
        }
        g.restoreGState()
    }

    private func fill(_ g: CGContext, _ c: Face.Circle, radius: Double, alpha: Double) {
        g.setFillColor(red: CGFloat(c.r), green: CGFloat(c.g), blue: CGFloat(c.b), alpha: CGFloat(alpha))
        g.fillEllipse(in: CGRect(x: c.x - radius, y: c.y - radius, width: radius * 2, height: radius * 2))
    }

    // MARK: Mouse (only reaches here while the face is kept on screen)

    override func mouseDown(with event: NSEvent) {
        // Control held: a drag (a trackpad's way to the right button's), not a click.
        if event.modifierFlags.contains(.control) { rightMouseDown(with: event) } else { clicked?() }
    }

    override func mouseDragged(with event: NSEvent) { rightMouseDragged(with: event) }

    override func mouseUp(with event: NSEvent) { if grab != nil { rightMouseUp(with: event) } }

    override func rightMouseDown(with event: NSEvent) {
        grab = NSEvent.mouseLocation
        moved = false
    }

    override func rightMouseDragged(with event: NSEvent) {
        guard let from = grab else { return }
        let at = NSEvent.mouseLocation
        let by = NSSize(width: at.x - from.x, height: at.y - from.y)
        if !moved && abs(by.width) + abs(by.height) < 4 { return }
        moved = true
        NSCursor.closedHand.set()
        dragged?(by)
    }

    override func rightMouseUp(with event: NSEvent) {
        grab = nil
        NSCursor.arrow.set()
        if moved { dropped?() }
        moved = false
    }
}
