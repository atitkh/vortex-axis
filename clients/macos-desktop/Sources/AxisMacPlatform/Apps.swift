import AppKit
import ApplicationServices
import AxisDesktopCore

/**
 * Apps and their windows: starting an app by the name a person knows it by (the `.app` bundles in the Applications
 * folders, as Bluey's `findApp`), opening an http(s) address, bringing an app or one of its windows forward, and
 * minimising, filling, restoring or moving a window. Only apps are started, never a path or command from the agent.
 * The Accessibility calls block: call these off the main thread.
 */
enum Apps {
    static let folders = [
        "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
        NSHomeDirectory() + "/Applications", "/System/Library/CoreServices/Applications",
    ]

    /** The installed apps: (name as shown, bundle). Read from the folders each time; it is a few directory listings. */
    static func installed() -> [(name: String, url: URL)] {
        var apps: [(name: String, url: URL)] = []
        var seen = Set<String>()
        for folder in folders {
            guard let items = try? FileManager.default.contentsOfDirectory(atPath: folder) else { continue }
            for item in items where item.hasSuffix(".app") {
                let url = URL(fileURLWithPath: folder).appendingPathComponent(item)
                let file = url.deletingPathExtension().lastPathComponent
                guard seen.insert(file.lowercased()).inserted else { continue }
                // The name the Finder and Launchpad show, when the bundle has one ("Code" is "Visual Studio Code").
                let shown = Bundle(url: url)?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                apps.append((file, url))
                if let shown, shown.lowercased() != file.lowercased() { apps.append((shown, url)) }
            }
        }
        return apps
    }

    /** The installed app best matching `query` (Fuzzy, the shorter name on ties), or nil. */
    static func find(_ query: String) -> (name: String, url: URL)? {
        let wanted = query.hasSuffix(".app") ? String(query.dropLast(4)) : query
        var best: (app: (name: String, url: URL), score: Int)?
        for app in installed() {
            let score = Fuzzy.score(app.name, wanted)
            if score == 0 { continue }
            if best == nil || score > best!.score || (score == best!.score && app.name.count < best!.app.name.count) { best = (app, score) }
        }
        return best?.app
    }

    /** Starts (or brings forward, if it runs) the app at `url`. */
    static func launch(_ url: URL) async throws -> NSRunningApplication {
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        return try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    }

    /** Opens an http(s) address in the default browser. */
    static func browse(_ address: String) throws {
        guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host != nil else {
            throw DesktopError("only http and https addresses are opened")
        }
        guard NSWorkspace.shared.open(url) else { throw DesktopError("macOS did not open \(address)") }
    }

    // MARK: Bringing forward

    /**
     * Brings app `pid` forward, and `window` (one of its AX windows) to the front of it. macOS 14's cooperative
     * activation may stop a background app pulling another forward with `activate` alone, so Accessibility is asked
     * as well (AXFrontmost on the app, AXRaise and AXMain on the window), which an app with Accessibility access may do.
     */
    static func bringForward(pid: pid_t, window: AXUIElement?) {
        let app = AXReader.app(pid)
        if let window {
            if (AXReader.attribute(window, kAXMinimizedAttribute) as Bool?) == true {
                AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            }
            AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        }
        AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        if let running = NSRunningApplication(processIdentifier: pid) {
            if #available(macOS 14.0, *) {
                running.activate()
            } else {
                running.activate(options: [.activateIgnoringOtherApps])
            }
        }
        InputEvents.sleep(ms: 120)
    }

    /**
     * App `pid`'s real top-level window (`AXReader.realWindow`) for a window known by its box and title (from Quartz,
     * or a look: the whole window, toolbar included): the AX window with that box (within a few points), else that
     * title, else lying inside that box, else the focused one; then never a toolbar strip, and a page window inside a
     * bigger standard window is that window. `minimised`: a minimised window may be the one.
     */
    static func realWindow(pid: pid_t, box: Box?, title: String?, minimised: Bool = false) -> AXReader.RealWindow? {
        var rules: [(AXWindowRecord) -> Bool] = []
        if let box { rules.append({ r in r.box.map { WindowPick.same($0, box) } ?? false }) }
        if let title, !title.isEmpty { rules.append({ r in r.title == title }) }
        if let box { rules.append({ r in r.box.map { $0.inside(box, slack: 4) } ?? false }) }
        return AXReader.realWindow(AXReader.app(pid), pid: pid, prefer: rules, minimised: minimised)
    }

    /** App `pid`'s AX window to bring forward for a window known by its box and title (`realWindow`, minimised ones too). */
    static func axWindow(pid: pid_t, box: Box?, title: String?) -> AXUIElement? {
        realWindow(pid: pid, box: box, title: title, minimised: true)?.element
    }

    /** A window's box as Accessibility gives it now. */
    static func box(of window: AXUIElement) -> Box? { AXReader.frame(window) }

    static func minimised(_ window: AXUIElement) -> Bool { (AXReader.attribute(window, kAXMinimizedAttribute) as Bool?) == true }

    /** In macOS full screen (a Space of its own), where a window can be neither minimised nor moved. */
    static func fullScreen(_ window: AXUIElement) -> Bool { (AXReader.attribute(window, "AXFullScreen") as Bool?) == true }

    /** Asks `done` every 100 ms for up to `ms`; true as soon as it says so. */
    static func waitFor(ms: Int, _ done: () -> Bool) -> Bool {
        var waited = 0
        while true {
            if done() { return true }
            if waited >= ms { return false }
            InputEvents.sleep(ms: 100)
            waited += 100
        }
    }

    /** Takes the window out of full screen and waits for it (the animation runs on a little past the flag). True when it is out. */
    static func leaveFullScreen(_ window: AXUIElement) -> Bool {
        guard fullScreen(window) else { return true }
        AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, kCFBooleanFalse)
        guard waitFor(ms: 2500, { !fullScreen(window) }) else { return false }
        InputEvents.sleep(ms: 700)
        return true
    }

    /**
     * Puts the window into macOS full screen (a Space of its own) and waits for it, the animation included. True when
     * it says it is in full screen. A window just back from the Dock is given a moment first: its own animation runs on.
     */
    static func enterFullScreen(_ window: AXUIElement) -> Bool {
        if fullScreen(window) { return true }
        InputEvents.sleep(ms: 400)
        AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, kCFBooleanTrue)
        guard waitFor(ms: 3000, { fullScreen(window) }) else { return false }
        InputEvents.sleep(ms: 700)
        return true
    }

    /** Brings a minimised window back from the Dock. True when it says it is back. */
    static func unminimise(_ window: AXUIElement) -> Bool {
        guard minimised(window) else { return true }
        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        return waitFor(ms: 1500, { !minimised(window) })
    }

    /** Whether app `pid` has a minimised window called `title` (any minimised window when `title` is empty). */
    static func hasMinimised(pid: pid_t, title: String) -> Bool {
        AXReader.windowRecords(AXReader.app(pid)).contains { $0.record.minimised && (title.isEmpty || $0.record.title == title) }
    }

    /**
     * The minimised window best matching an app name or a title, across the regular apps, from their AX windows (a
     * minimised window has no title in Quartz's list without Screen Recording). The app's name scores 5 more, as in
     * `WindowPick.find`. Nil when none scores.
     */
    static func minimisedWindow(matching query: String) -> (pid: pid_t, owner: String, title: String)? {
        var best: (pid: pid_t, owner: String, title: String, score: Int)?
        let own = ProcessInfo.processInfo.processIdentifier
        for running in NSWorkspace.shared.runningApplications where running.activationPolicy == .regular && running.processIdentifier != own {
            let pid = running.processIdentifier
            let owner = running.localizedName ?? ""
            let appScore = Fuzzy.score(owner, query)
            for w in AXReader.windowRecords(AXReader.app(pid)) where w.record.minimised {
                let score = max(appScore > 0 ? appScore + 5 : 0, Fuzzy.score(w.record.title, query))
                if score > 5, score > (best?.score ?? 0) { best = (pid, owner, w.record.title, score) }
            }
        }
        guard let best else { return nil }
        return (best.pid, best.owner, best.title)
    }

    static func setBox(_ window: AXUIElement, _ box: Box) {
        var point = CGPoint(x: box.x, y: box.y)
        var size = CGSize(width: box.w, height: box.h)
        if let position = AXValueCreate(.cgPoint, &point) { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position) }
        if let extent = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, extent) }
        // Setting the position again after the size: some apps clamp a window that would cross the screen's edge.
        if let position = AXValueCreate(.cgPoint, &point) { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position) }
    }

    /** What `arrange` left: the window's box now (nil when minimised), and what it says of itself, read back. */
    struct Outcome {
        var box: Box?
        var minimised: Bool
        var fullScreen: Bool
        /** It was in full screen and was taken out of it to be minimised: a restore puts it back (`FullScreenMemory`). */
        var leftFullScreen = false
    }

    /**
     * Minimizes, fills ("maximize": the display's visible area, never macOS full screen, which would make a Space of
     * its own), restores or moves `window` to `visible[display - 1]` (top-left points, the menu bar and Dock left
     * out). Restore follows `WindowRestore.steps`: a minimised window back from the Dock, and into full screen again
     * when it was there before this app minimised it (`wasFullScreen`); a full-screen one out of full screen; a
     * filled one back to the box it had before (`previous`). A window in full screen leaves it first to be minimised
     * or moved; one asked to fill while in full screen already fills its display and is left so. Every change is read
     * back from the window (kAXMinimized, AXFullScreen, its box) and a change that did not take throws, saying so: in
     * 0.2.0's live test Brave answered ok to a minimize and nothing happened. Going back into full screen that does
     * not take is not an error (the window is back); the answer's `fullScreen` says so.
     */
    static func arrange(_ window: AXUIElement, op: String, displayArea: Box?, previous: Box?, wasFullScreen: Bool) throws -> Outcome {
        switch op {
        case "minimize":
            if minimised(window) { return Outcome(box: nil, minimised: true, fullScreen: false) }
            let was = fullScreen(window)
            guard leaveFullScreen(window) else { throw DesktopError("the window is in full screen and did not leave it, so it was not minimized") }
            let asked = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
            guard waitFor(ms: 1500, { minimised(window) }) else {
                let said = asked == .success ? "macOS answered ok" : "macOS answered error \(asked.rawValue)"
                throw DesktopError("the window did not minimize (\(said), but the window still says it is not minimized)")
            }
            return Outcome(box: nil, minimised: true, fullScreen: false, leftFullScreen: was)
        case "maximize":
            guard unminimise(window) else { throw DesktopError("the window did not come back from the Dock, so it was not maximized") }
            if fullScreen(window) { return Outcome(box: box(of: window), minimised: false, fullScreen: true) }
            guard let area = displayArea else { throw DesktopError("no display to fill") }
            let before = box(of: window)
            setBox(window, area)
            InputEvents.sleep(ms: 120)
            let after = box(of: window)
            if let after, let before, after == before, !WindowPick.same(after, area) {
                throw DesktopError("the window did not change size (it stays at \(after); the app may not allow resizing)")
            }
            return Outcome(box: after, minimised: false, fullScreen: false)
        case "restore":
            let steps = WindowRestore.steps(minimised: minimised(window), fullScreen: fullScreen(window), wasFullScreen: wasFullScreen,
                                            previous: previous)
            for step in steps {
                switch step {
                case .unminimise:
                    guard unminimise(window) else { throw DesktopError("the window did not come back from the Dock (it still says it is minimized)") }
                case .leaveFullScreen:
                    guard leaveFullScreen(window) else { throw DesktopError("the window did not leave full screen") }
                case .enterFullScreen:
                    _ = enterFullScreen(window)
                case .setBox(let b):
                    setBox(window, b)
                    InputEvents.sleep(ms: 120)
                }
            }
            return Outcome(box: box(of: window), minimised: minimised(window), fullScreen: fullScreen(window))
        case "move":
            guard let area = displayArea else { throw DesktopError("no such display") }
            guard unminimise(window) else { throw DesktopError("the window did not come back from the Dock, so it was not moved") }
            guard leaveFullScreen(window) else { throw DesktopError("the window is in full screen and did not leave it, so it was not moved") }
            let now = box(of: window) ?? area
            setBox(window, Coordinates.centred(now, in: area))
            InputEvents.sleep(ms: 120)
            let after = box(of: window)
            if let c = after?.centre, !(c.x >= area.x && c.x < area.right && c.y >= area.y && c.y < area.bottom) {
                throw DesktopError("the window did not move to that display (it is at \(after!))")
            }
            return Outcome(box: after, minimised: false, fullScreen: false)
        default:
            throw DesktopError("window needs do: minimize, maximize, restore or move")
        }
    }
}
