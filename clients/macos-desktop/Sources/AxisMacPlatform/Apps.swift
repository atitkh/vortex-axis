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

    /** App `pid`'s AX window with this box (within a few points), else the one with this title, else its focused window. */
    static func axWindow(pid: pid_t, box: Box?, title: String?) -> AXUIElement? {
        let app = AXReader.app(pid)
        let windows: [AXUIElement] = AXReader.attribute(app, kAXWindowsAttribute) ?? []
        if let box {
            for w in windows {
                if let p: AnyObject = AXReader.attribute(w, kAXPositionAttribute), let s: AnyObject = AXReader.attribute(w, kAXSizeAttribute),
                   let b = AXReader.box(position: p, size: s),
                   abs(b.x - box.x) <= 4, abs(b.y - box.y) <= 4, abs(b.w - box.w) <= 4, abs(b.h - box.h) <= 4 { return w }
            }
        }
        if let title, !title.isEmpty, let w = windows.first(where: { (AXReader.attribute($0, kAXTitleAttribute) as String?) == title }) { return w }
        return AXReader.element(app, kAXFocusedWindowAttribute) ?? windows.first
    }

    /** A window's box as Accessibility gives it now. */
    static func box(of window: AXUIElement) -> Box? {
        guard let p: AnyObject = AXReader.attribute(window, kAXPositionAttribute), let s: AnyObject = AXReader.attribute(window, kAXSizeAttribute) else { return nil }
        return AXReader.box(position: p, size: s)
    }

    static func setBox(_ window: AXUIElement, _ box: Box) {
        var point = CGPoint(x: box.x, y: box.y)
        var size = CGSize(width: box.w, height: box.h)
        if let position = AXValueCreate(.cgPoint, &point) { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position) }
        if let extent = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, extent) }
        // Setting the position again after the size: some apps clamp a window that would cross the screen's edge.
        if let position = AXValueCreate(.cgPoint, &point) { AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position) }
    }

    /**
     * Minimizes, fills ("maximize": the display's visible area, never macOS full screen, which would make a Space of
     * its own), restores or moves `window` to `visible[display - 1]` (top-left points, the menu bar and Dock left
     * out). Restore takes a minimised window back, and a filled one back to the box it had before (`previous`).
     */
    static func arrange(_ window: AXUIElement, op: String, displayArea: Box?, previous: Box?) throws {
        switch op {
        case "minimize":
            guard AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue) == .success else {
                throw DesktopError("the window would not minimize")
            }
        case "maximize":
            if (AXReader.attribute(window, kAXMinimizedAttribute) as Bool?) == true {
                AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            }
            guard let area = displayArea else { throw DesktopError("no display to fill") }
            setBox(window, area)
        case "restore":
            if (AXReader.attribute(window, kAXMinimizedAttribute) as Bool?) == true {
                AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            } else if let previous {
                setBox(window, previous)
            }
        case "move":
            guard let area = displayArea else { throw DesktopError("no such display") }
            if (AXReader.attribute(window, kAXMinimizedAttribute) as Bool?) == true {
                AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            }
            let now = box(of: window) ?? area
            setBox(window, Coordinates.centred(now, in: area))
        default:
            throw DesktopError("window needs do: minimize, maximize, restore or move")
        }
        InputEvents.sleep(ms: 120)
    }
}
