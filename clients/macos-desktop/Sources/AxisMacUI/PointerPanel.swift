import AppKit
import AxisDesktopCore
import AxisMacPlatform

/**
 * The agent's pointer: a ring with the agent's words beside it, in a borderless panel that never takes the focus
 * or a click, above other windows and on every Space. Placed in AppKit's bottom-left space through the one flip
 * rule (`Coordinates.appKit`, the main display's height). Glides to a new point, fades out after its time.
 * M1's pointer is deliberately plain; the Windows look (breathing, the bubble on the roomier side) comes with M3.
 */
@MainActor
public final class PointerPanel: PointerDrawing {
    /** The ring's diameter in points (the `pointerSize` setting). */
    public var size: CGFloat = 44
    private let panel: NSPanel
    private let view: PointerView
    private var generation = 0

    public init() {
        view = PointerView()
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 44, height: 44), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = view
    }

    @discardableResult
    public func show(x: Int, y: Int, text: String?, seconds: Double) -> Bool {
        generation += 1
        let mine = generation
        view.ring = size
        view.text = text
        let content = view.fittingSize
        // The ring's middle on the point: the panel's top-left is half a ring up and left of it.
        let mainHeight = Double(NSScreen.screens.first?.frame.height ?? 0)
        let half = Double(size) / 2
        let topLeft = Coordinates.appKit(x: Double(x) - half, y: Double(y) - half, mainHeight: mainHeight)
        let frame = NSRect(x: topLeft.x, y: topLeft.y - content.height, width: content.width, height: content.height)
        let glides = panel.isVisible && panel.alphaValue > 0
        if glides {
            NSAnimationContext.runAnimationGroup { c in
                c.duration = 0.22
                panel.animator().setFrame(frame, display: true)
            }
        } else {
            panel.setFrame(frame, display: true)
            panel.alphaValue = 1
            panel.orderFrontRegardless()
        }
        view.needsDisplay = true
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
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return }
                self.panel.orderOut(nil)
            }
        })
    }
}

/** A ring, and the words in a rounded bubble to its right. */
final class PointerView: NSView {
    var ring: CGFloat = 44
    var text: String?
    static let font = NSFont.systemFont(ofSize: 13, weight: .medium)
    static let accent = NSColor(calibratedRed: 0.27, green: 0.55, blue: 1, alpha: 1)

    var words: NSAttributedString? {
        guard let text, !text.isEmpty else { return nil }
        return NSAttributedString(string: String(text.prefix(200)), attributes: [.font: Self.font, .foregroundColor: NSColor.white])
    }

    override var fittingSize: NSSize {
        guard let w = words else { return NSSize(width: ring, height: ring) }
        let box = w.boundingRect(with: NSSize(width: 280, height: 400), options: [.usesLineFragmentOrigin])
        return NSSize(width: ring + 10 + ceil(box.width) + 20, height: max(ring, ceil(box.height) + 14))
    }

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let r = NSRect(x: 3, y: 3, width: ring - 6, height: ring - 6)
        Self.accent.withAlphaComponent(0.25).setFill()
        NSBezierPath(ovalIn: r).fill()
        Self.accent.setStroke()
        let edge = NSBezierPath(ovalIn: r)
        edge.lineWidth = 3
        edge.stroke()
        guard let w = words else { return }
        let box = w.boundingRect(with: NSSize(width: 280, height: 400), options: [.usesLineFragmentOrigin])
        let bubble = NSRect(x: ring + 10, y: 0, width: ceil(box.width) + 20, height: ceil(box.height) + 14)
        NSColor(calibratedWhite: 0.1, alpha: 0.85).setFill()
        NSBezierPath(roundedRect: bubble, xRadius: 10, yRadius: 10).fill()
        w.draw(with: NSRect(x: bubble.minX + 10, y: bubble.minY + 7, width: ceil(box.width), height: ceil(box.height)), options: [.usesLineFragmentOrigin])
    }
}
