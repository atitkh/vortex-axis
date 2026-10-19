import AppKit
import CoreGraphics
import AxisDesktopCore

/**
 * Windows and displays from Quartz, never Accessibility, so a frozen app cannot hold them up. CGWindowList bounds
 * and CGDisplayBounds are already top-left points: no flip here. Other apps' window titles come only with Screen
 * Recording access (since macOS 10.15); without it a title is empty and the app's name stands in.
 */
public enum WindowList {
    struct Entry {
        let pid: pid_t
        let owner: String
        let title: String
        let box: Box
    }

    /** Ordinary windows on screen (layer 0, the current Space), front to back, the app's own left out. */
    static func entries() -> [Entry] {
        let me = ProcessInfo.processInfo.processIdentifier
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { w in
            guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pid != me, (w[kCGWindowLayer as String] as? Int) == 0,
                  let bounds = w[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width >= 2, rect.height >= 2 else { return nil }
            let box = Box(x: Int(rect.minX.rounded(.down)), y: Int(rect.minY.rounded(.down)), w: Int(rect.width.rounded()), h: Int(rect.height.rounded()))
            return Entry(pid: pid, owner: w[kCGWindowOwnerName as String] as? String ?? "", title: w[kCGWindowName as String] as? String ?? "", box: box)
        }
    }

    /** The app in front and its front window. The title may be empty (see above); `MacDesktop` fills it from AX then. */
    public static func front() -> (pid: pid_t, window: WindowInfo)? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let pid = app.processIdentifier
        let name = app.localizedName ?? ""
        let w = entries().first { $0.pid == pid }
        return (pid, WindowInfo(title: w?.title ?? "", app: name, x: w?.box.x ?? 0, y: w?.box.y ?? 0, w: w?.box.w ?? 0, h: w?.box.h ?? 0,
                                bundleID: app.bundleIdentifier))
    }

    /**
     * The open windows as `window` elements for a look at the screen. The name is "Title (App)", or the app's name
     * alone: unlike the Windows app's, the app is in the name, so the block list matches an app by name here too.
     */
    public static func windows() -> [ScreenElement] {
        entries().map { e in
            let name = e.title.isEmpty ? e.owner : e.owner.isEmpty ? e.title : "\(e.title) (\(e.owner))"
            return ScreenElement(kind: "window", name: name, x: e.box.x, y: e.box.y, w: e.box.w, h: e.box.h)
        }
    }

    /** Every display in top-left points, the main one (with the menu bar) first, the order `monitors` and "display N" use. */
    public static func displays() -> [Display] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        let main = CGMainDisplayID()
        return ids.prefix(Int(count)).sorted { ($0 == main ? 0 : 1) < ($1 == main ? 0 : 1) }.map { id in
            let b = CGDisplayBounds(id)
            return Display(x: Int(b.minX), y: Int(b.minY), w: Int(b.width), h: Int(b.height), primary: id == main)
        }
    }

    /** Where the mouse is, top-left points. */
    public static func mouse() -> (x: Int, y: Int) {
        let p = CGEvent(source: nil)?.location ?? .zero
        return (Int(p.x.rounded(.down)), Int(p.y.rounded(.down)))
    }
}
