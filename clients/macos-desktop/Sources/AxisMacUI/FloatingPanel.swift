import AppKit
import AxisDesktopCore

/**
 * A borderless panel for the app's own things on screen (the face, the pills): never the key or main window, so it
 * never takes the focus; on every Space and over full-screen apps; out of every screen capture (`sharingType`), which
 * is the Mac's way of the Windows app stepping its face and pills aside for a screenshot; click-through until asked.
 */
final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    // A borderless window may sit over the menu bar (a pill grown out of the notch); AppKit is not to push it down.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }

    /** Above normal windows, below the menu bar: the face. */
    static let underMenuBar = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue - 1)
    /** Over the menu bar: the pills, which may grow out of the notch. */
    static let overMenuBar = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)

    static func make(level: NSWindow.Level) -> FloatingPanel {
        let p = FloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10), styleMask: [.borderless, .nonactivatingPanel],
                              backing: .buffered, defer: true)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = level
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.becomesKeyOnlyIfNeeded = true
        p.isReleasedWhenClosed = false
        p.animationBehavior = .none
        p.sharingType = .none
        p.ignoresMouseEvents = true
        p.alphaValue = 0
        return p
    }
}

/** The main display (the one with the menu bar) and the rest, in the shapes Core's layouts take. */
@MainActor
enum Screens {
    static var main: NSScreen? { NSScreen.screens.first }
    static var mainHeight: Double { Double(main?.frame.height ?? 0) }

    static func rect(_ r: NSRect) -> PanelRect {
        PanelRect(x: Double(r.origin.x), y: Double(r.origin.y), w: Double(r.width), h: Double(r.height))
    }

    static func nsRect(_ r: PanelRect) -> NSRect { NSRect(x: r.x, y: r.y, width: r.w, height: r.h) }

    /** The main display for the pills, with its notch when it has one. */
    static var pillScreen: PillScreen? {
        guard let s = main else { return nil }
        let frame = rect(s.frame)
        let notch = PillScreen.notch(frame: frame, safeTop: Double(s.safeAreaInsets.top),
                                     leftWidth: s.auxiliaryTopLeftArea.map { Double($0.width) },
                                     rightWidth: s.auxiliaryTopRightArea.map { Double($0.width) })
        return PillScreen(frame: frame, visible: rect(s.visibleFrame), notch: notch)
    }

    /** The person asked for less motion (System Settings > Accessibility > Display > Reduce motion). */
    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
}

/** Calls `tick` about 60 times a second on the main thread while started (macOS 13 has no NSView display link). */
@MainActor
final class Ticker: NSObject {
    private var timer: Timer?
    private let tick: () -> Void

    init(_ tick: @escaping () -> Void) { self.tick = tick }

    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 1.0 / 60, target: self, selector: #selector(fire), userInfo: nil, repeats: true)
        t.tolerance = 0.004
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    @objc private func fire() { tick() }
}
