import Foundation

/**
 * One window as the Quartz window list gives it (CGWindowListCopyWindowInfo), reduced to what the choices below
 * need. Boxes are top-left points, as everywhere. `onScreen` is Quartz's own flag: false for a window on another
 * Space or minimised (the list cannot tell those two apart without Accessibility).
 */
public struct WindowCandidate: Equatable, Sendable {
    public var number: Int
    public var pid: Int32
    public var owner: String
    public var title: String
    public var box: Box
    public var layer: Int
    public var alpha: Double
    public var onScreen: Bool

    public init(number: Int = 0, pid: Int32, owner: String, title: String, box: Box, layer: Int = 0, alpha: Double = 1, onScreen: Bool = true) {
        self.number = number
        self.pid = pid
        self.owner = owner
        self.title = title
        self.box = box
        self.layer = layer
        self.alpha = alpha
        self.onScreen = onScreen
    }

    /** "Title (App)", or the app's name alone when the title is not known (no Screen Recording access). */
    public var name: String { title.isEmpty ? owner : owner.isEmpty ? title : "\(title) (\(owner))" }
}

/** What Accessibility says about an app's focused window, when it says anything. */
public struct FocusedWindow: Equatable, Sendable {
    public var title: String
    public var box: Box
    public var minimised: Bool
    public init(title: String, box: Box, minimised: Bool = false) {
        self.title = title
        self.box = box
        self.minimised = minimised
    }
}

/**
 * One of an app's windows as Accessibility gives it (its AXWindows, plus its focused and main window), reduced to
 * what `WindowPick.real` needs. `box` is nil when it has no position or size.
 */
public struct AXWindowRecord: Equatable, Sendable {
    public var role: String
    public var subrole: String?
    public var title: String
    public var box: Box?
    public var minimised: Bool
    /** The app's AXFocusedWindow (or, for a window named by the agent, the one that matched). */
    public var focused: Bool
    /** The app's AXMainWindow. */
    public var main: Bool

    public init(role: String = "AXWindow", subrole: String? = "AXStandardWindow", title: String = "", box: Box?, minimised: Bool = false,
                focused: Bool = false, main: Bool = false) {
        self.role = role
        self.subrole = subrole
        self.title = title
        self.box = box
        self.minimised = minimised
        self.focused = focused
        self.main = main
    }

    /** A dialog, sheet or floating panel: the window the person is answering, never swapped for the one behind it. */
    public var dialog: Bool {
        role == "AXSheet" || ["AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXSystemFloatingWindow"].contains(subrole ?? "")
    }
}

/**
 * Which window is "the window in front", and which windows a list of the open ones holds. Pure, so the choices are
 * tested off the Mac (`WindowPickTests`). The live test of 0.1.0 found three faults these rules replace: the front
 * window's box taken from the first Quartz window of the front app (Chromium keeps thin helper windows, so a look
 * said `241,33 1470x40` while its element 1, from Accessibility, said `0,114 1470x842`); Finder's empty desktop
 * reported as the front window `0,0 0x0`; and a window list that only had the current Space's windows.
 */
public enum WindowPick {
    /** Smaller than this either way is a strip, a tooltip or a helper, never "a window". */
    public static let minSide = 60
    /** Boxes this close are the same window seen by Accessibility and by Quartz (they round differently). */
    static let sameBoxSlack = 4

    /**
     * Windows the system itself draws (Mission Control's "Window Highlight Overlay" belongs to WindowManager): on screen
     * at layer 0 for a moment, but no window of a person's.
     */
    public static let systemOwners: Set<String> = ["WindowManager", "Window Server", "Dock", "SystemUIServer", "loginwindow"]

    /** A window a person would call one: layer 0, not see-through, big enough, at least partly on a display, not the system's. */
    public static func normal(_ w: WindowCandidate, displays: [Display]) -> Bool {
        w.layer == 0 && w.alpha > 0.01 && w.box.w >= minSide && w.box.h >= minSide && !w.owner.isEmpty
            && !systemOwners.contains(w.owner)
            && (displays.isEmpty || onADisplay(w.box, displays))
    }

    static func onADisplay(_ box: Box, _ displays: [Display]) -> Bool {
        displays.contains { d in
            guard let part = box.within(Box(x: d.x, y: d.y, w: d.w, h: d.h)) else { return false }
            return part.w >= 40 && part.h >= 40
        }
    }

    public static func same(_ a: Box, _ b: Box) -> Bool {
        abs(a.x - b.x) <= sameBoxSlack && abs(a.y - b.y) <= sameBoxSlack && abs(a.w - b.w) <= sameBoxSlack && abs(a.h - b.h) <= sameBoxSlack
    }

    /**
     * The window in front, one source of truth for its box: the front app's focused window as Accessibility gives
     * it (`focused`), when it is a real window on a display and the app has a window on this Space; else the front
     * app's front-most normal window on this Space from Quartz (`list` is front to back); else nothing. Never a
     * window of 0x0 or a desktop. `ownPid`: when the app itself is in front (its own window open), the front-most
     * window of another app is taken instead. The title is Accessibility's, else the Quartz window with the same box.
     */
    public static func front(pid: Int32?, focused: FocusedWindow?, list: [WindowCandidate], displays: [Display], ownPid: Int32? = nil)
        -> (pid: Int32, title: String, box: Box)? {
        let here = merged(list.filter { $0.onScreen && normal($0, displays: displays) && $0.pid != ownPid })
        // Not knowing which app is in front is not a guess at one.
        guard let pid else { return nil }
        if pid == ownPid {
            guard let top = here.first else { return nil }
            return (top.pid, top.title, top.box)
        }
        let mine = here.filter { $0.pid == pid }
        // No window of the app on this Space: its focused window (if any) is elsewhere, or it is Finder's desktop.
        guard let first = mine.first else { return nil }
        if let f = focused, !f.minimised, f.box.w >= minSide, f.box.h >= minSide, onADisplay(f.box, displays) || displays.isEmpty {
            let twin = mine.first { same($0.box, f.box) }
            return (pid, f.title.isEmpty ? twin?.title ?? "" : f.title, f.box)
        }
        return (pid, first.title, first.box)
    }

    /**
     * The windows a list shows, front to back: every normal window on this Space, then (`others`) the titled windows
     * Quartz knows that are not on screen (another Space, or minimised), flagged `here: false`. Untitled off-screen
     * windows are left out: without a title they are helpers more often than not. One entry per window number, and
     * one per window a person counts (`merged`: a browser's toolbar strip is part of its window).
     */
    public static func listed(onScreen: [WindowCandidate], all: [WindowCandidate], displays: [Display], ownPid: Int32? = nil)
        -> [(window: WindowCandidate, here: Bool)] {
        var seen = Set<Int>()
        var out: [(window: WindowCandidate, here: Bool)] = []
        var here: [WindowCandidate] = []
        for w in onScreen where w.pid != ownPid && normal(w, displays: displays) {
            if w.number != 0 && !seen.insert(w.number).inserted { continue }
            here.append(w)
        }
        for w in merged(here) { out.append((w, true)) }
        for w in all where w.pid != ownPid && !w.onScreen && !w.title.isEmpty && w.layer == 0 && w.alpha > 0.01
            && w.box.w >= minSide && w.box.h >= minSide && !w.owner.isEmpty && !systemOwners.contains(w.owner) {
            if w.number != 0 && !seen.insert(w.number).inserted { continue }
            out.append((w, false))
        }
        return out
    }

    /** Narrower than this and untitled, a window of an app that has another one listed is a helper (a popup, a badge). */
    public static let helperWidth = 200
    /** A strip taller than this is not a toolbar: it is a window of its own. */
    public static let maxStripHeight = 200

    /**
     * Whether `a` is a toolbar strip of `b`: as wide as it and level with it (within a few points), starting above
     * its top and ending at most a quarter of the way into it, and less than 200 points tall. Chromium shows its
     * tabs and address bar so in full screen (and on some versions windowed): Brave in the live test of 0.2.0 had
     * an untitled `0,33 1470x117` window over its page window `0,114 1470x842`, both listed, the toolbar never read.
     */
    public static func strip(_ a: Box, of b: Box) -> Bool {
        let slack = 2 * sameBoxSlack
        return abs(a.x - b.x) <= slack && abs(a.w - b.w) <= slack && a.h < maxStripHeight && a.h < b.h
            && a.y < b.y && a.bottom >= b.y - sameBoxSlack && a.bottom <= b.y + b.h / 4
    }

    /**
     * Windows on this Space as a person counts them, front to back: an untitled toolbar strip of another window of
     * the same app is folded into it (its box grows to hold both, so it is the whole window), and an untitled window
     * under `helperWidth` wide is left out when its app has another window listed.
     */
    public static func merged(_ here: [WindowCandidate]) -> [WindowCandidate] {
        var out = here
        var dropped = Set<Int>()
        for (i, s) in here.enumerated() where s.title.isEmpty {
            // The strip goes into the first (front-most) window of its app it sits on.
            guard let j = here.indices.first(where: { $0 != i && !dropped.contains($0) && here[$0].pid == s.pid && strip(s.box, of: here[$0].box) })
            else { continue }
            out[j].box = out[j].box.union(s.box)
            dropped.insert(i)
        }
        for (i, s) in here.enumerated() where s.title.isEmpty && s.box.w < helperWidth && !dropped.contains(i) {
            if here.indices.contains(where: { $0 != i && !dropped.contains($0) && here[$0].pid == s.pid }) { dropped.insert(i) }
        }
        return out.indices.filter { !dropped.contains($0) }.map { out[$0] }
    }

    /**
     * An app's real top-level window among its AX windows, and the toolbar strips that belong to it: what a look
     * walks and what `window` acts on. The focused window, else the main one, else the biggest; never a strip of
     * another window (Chromium's toolbar window), never a minimised one unless `minimised` allows it (restore). A
     * plain window lying wholly inside a bigger standard window of the app is swapped for that one (the page window
     * of a browser for the browser's window); a dialog or sheet never is. `box` holds the window and its strips: the
     * whole window, title bar and toolbar included. Nil when the app has no usable window.
     */
    public static func real(_ windows: [AXWindowRecord], minimised: Bool = false) -> (main: Int, attached: [Int], box: Box)? {
        // Every usable window has a box: `box(i)` is only asked of those.
        func box(_ i: Int) -> Box { windows[i].box ?? Box(x: 0, y: 0, w: 0, h: 0) }
        func area(_ i: Int) -> Int64 { box(i).area }
        let ok = windows.indices.filter { i in
            guard let b = windows[i].box, b.w >= minSide, b.h >= minSide else { return false }
            return minimised || !windows[i].minimised
        }
        func isStrip(_ i: Int) -> Bool {
            if windows[i].dialog { return false }
            return ok.contains { j in j != i && strip(box(i), of: box(j)) }
        }
        let candidates = ok.filter { i in !isStrip(i) }
        guard var pick = candidates.first(where: { i in windows[i].focused }) ?? candidates.first(where: { i in windows[i].main })
            ?? candidates.max(by: { a, b in area(a) < area(b) }) ?? ok.first else { return nil }
        if !windows[pick].dialog {
            let inner = box(pick)
            let outers = candidates.filter { j in j != pick && !windows[j].dialog && area(j) > area(pick) && inner.inside(box(j), slack: sameBoxSlack) }
            if let outer = outers.max(by: { a, b in area(a) < area(b) }) { pick = outer }
        }
        let own = box(pick)
        let attached = ok.filter { j in j != pick && strip(box(j), of: own) }
        let whole = attached.reduce(own) { sum, j in sum.union(box(j)) }
        return (pick, attached, whole)
    }

    /** What a listed window off this Space is called in a list, beside its name. */
    public static let elsewhere = "on another Space, or minimised"

    /**
     * The open window best matching an app name or a title, front to back on ties; the app's name scores 5 more
     * (the Windows app's `Windows.Find`). Nil when nothing scores.
     */
    public static func find(_ query: String, in windows: [WindowCandidate]) -> WindowCandidate? {
        var best: (w: WindowCandidate, score: Int, i: Int)?
        for (i, w) in windows.enumerated() {
            let appScore = Fuzzy.score(w.owner, query)
            let score = max(appScore > 0 ? appScore + 5 : 0, Fuzzy.score(w.title, query))
            if score <= 5 { continue }
            if best == nil || score > best!.score { best = (w, score, i) }
        }
        return best?.w
    }
}
