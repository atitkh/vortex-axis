import AppKit
import CoreGraphics
import AxisDesktopCore

/**
 * Windows and displays from Quartz, never Accessibility, so a frozen app cannot hold them up. CGWindowList bounds
 * and CGDisplayBounds are already top-left points: no flip here. Other apps' window titles come only with Screen
 * Recording access (since macOS 10.15); without it a title is empty and the app's name stands in. Which window is
 * "in front" and which ones a list holds are decided by `WindowPick` (Core, tested).
 */
public enum WindowList {
    /** Quartz's windows, front to back: `onScreenOnly` those on this Space, else every window it knows. */
    static func candidates(onScreenOnly: Bool) -> [WindowCandidate] {
        let options: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { w in
            guard let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let bounds = w[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
            let box = Box(x: Int(rect.minX.rounded(.down)), y: Int(rect.minY.rounded(.down)), w: Int(rect.width.rounded()), h: Int(rect.height.rounded()))
            return WindowCandidate(
                number: (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0,
                pid: pid,
                owner: w[kCGWindowOwnerName as String] as? String ?? "",
                title: w[kCGWindowName as String] as? String ?? "",
                box: box,
                layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
                onScreen: onScreenOnly || ((w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false))
        }
    }

    static var ownPid: Int32 { ProcessInfo.processInfo.processIdentifier }

    /** Normal windows on this Space, front to back, the app's own left out: what `switch`, `open` and `wait` look through. */
    public static func onScreen() -> [WindowCandidate] {
        let displays = displays()
        return candidates(onScreenOnly: true).filter { $0.pid != ownPid && WindowPick.normal($0, displays: displays) }
    }

    /**
     * The open windows as `window` elements, for a look at the screen and the window list (one list for both). The
     * name is "Title (App)", or the app's name alone: unlike the Windows app's, the app is in the name, so the block
     * list matches an app by name here too. Windows on another Space or minimised come last, their value saying so.
     */
    public static func windows() -> [ScreenElement] {
        let displays = displays()
        let listed = WindowPick.listed(onScreen: candidates(onScreenOnly: true), all: candidates(onScreenOnly: false),
                                       displays: displays, ownPid: ownPid)
        return listed.map { item in
            let w = item.window
            return ScreenElement(kind: "window", name: w.name, x: w.box.x, y: w.box.y, w: w.box.w, h: w.box.h,
                                 value: item.here ? nil : WindowPick.elsewhere)
        }
    }

    /** Every display in top-left points, the main one (with the menu bar) first, the order `monitors` and "display N" use. */
    public static func displays() -> [Display] { displayIDs().map { $0.display } }

    /** The displays with their Quartz ids, in the order of `displays()`. */
    static func displayIDs() -> [(id: CGDirectDisplayID, display: Display)] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        let main = CGMainDisplayID()
        return ids.prefix(Int(count)).sorted { ($0 == main ? 0 : 1) < ($1 == main ? 0 : 1) }.map { id in
            let b = CGDisplayBounds(id)
            return (id, Display(x: Int(b.minX), y: Int(b.minY), w: Int(b.width), h: Int(b.height), primary: id == main))
        }
    }

    /** Where the mouse is, top-left points. */
    public static func mouse() -> (x: Int, y: Int) {
        let p = CGEvent(source: nil)?.location ?? .zero
        return (Int(p.x.rounded(.down)), Int(p.y.rounded(.down)))
    }
}
