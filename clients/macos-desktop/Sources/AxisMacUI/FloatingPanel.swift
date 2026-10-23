import AppKit
import AxisDesktopCore

/**
 * A borderless panel for the app's own things on screen (the face, the pills): never the key or main window, so it
 * never takes the focus; on every Space and over full-screen apps; out of every screen capture (`sharingType`), which
 * is the Mac's way of the Windows app stepping its face and pills aside for a screenshot; click-through until asked.
 */
class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    // A borderless window may sit over the menu bar (a pill grown out of the notch); AppKit is not to push it down.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }

    /** Above normal windows, below the menu bar: the face. */
    static let underMenuBar = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue - 1)
    /** Over the menu bar: the pills, which may grow out of the notch. */
    static let overMenuBar = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)

    static let everywhere: NSWindow.CollectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

    /**
     * Onto the screen, on every Space. The behaviour is set again at each showing: a window ordered out and in again
     * (the face and pills fade away and come back) can come back on the Space that is current only, and a panel
     * shown while a Space change is under way can stay on the Space it began on.
     */
    func bringUp() {
        collectionBehavior = []
        collectionBehavior = Self.everywhere
        orderFrontRegardless()
    }

    /** `keyable`: the typing pill's panel, which takes the keyboard without making the app active (`KeyablePanel`). */
    static func make(level: NSWindow.Level, keyable: Bool = false) -> FloatingPanel {
        let frame = NSRect(x: 0, y: 0, width: 10, height: 10)
        let style: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]
        let p: FloatingPanel = keyable
            ? KeyablePanel(contentRect: frame, styleMask: style, backing: .buffered, defer: true)
            : FloatingPanel(contentRect: frame, styleMask: style, backing: .buffered, defer: true)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = level
        p.collectionBehavior = everywhere
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.becomesKeyOnlyIfNeeded = !keyable
        p.isReleasedWhenClosed = false
        p.animationBehavior = .none
        p.sharingType = .none
        p.ignoresMouseEvents = true
        p.alphaValue = 0
        return p
    }
}

/**
 * The typing pill's panel: it may become the key window, so keystrokes reach its field, but it is still a
 * non-activating panel: the app is not brought forward and the app in front stays the one in front (and its window
 * gets the keyboard back as soon as this one resigns), so the desktop tool's typing still goes where it went.
 */
final class KeyablePanel: FloatingPanel {
    override var canBecomeKey: Bool { true }
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
