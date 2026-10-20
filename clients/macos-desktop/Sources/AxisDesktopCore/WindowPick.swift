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

    /** A window a person would call one: layer 0, not see-through, big enough, and at least partly on a display. */
    public static func normal(_ w: WindowCandidate, displays: [Display]) -> Bool {
        w.layer == 0 && w.alpha > 0.01 && w.box.w >= minSide && w.box.h >= minSide && !w.owner.isEmpty
            && (displays.isEmpty || onADisplay(w.box, displays))
    }

    static func onADisplay(_ box: Box, _ displays: [Display]) -> Bool {
        displays.contains { d in
            guard let part = box.within(Box(x: d.x, y: d.y, w: d.w, h: d.h)) else { return false }
            return part.w >= 40 && part.h >= 40
        }
    }

    static func same(_ a: Box, _ b: Box) -> Bool {
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
        let here = list.filter { $0.onScreen && normal($0, displays: displays) && $0.pid != ownPid }
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
     * windows are left out: without a title they are helpers more often than not. One entry per window number.
     */
    public static func listed(onScreen: [WindowCandidate], all: [WindowCandidate], displays: [Display], ownPid: Int32? = nil)
        -> [(window: WindowCandidate, here: Bool)] {
        var seen = Set<Int>()
        var out: [(window: WindowCandidate, here: Bool)] = []
        for w in onScreen where w.pid != ownPid && normal(w, displays: displays) {
            if w.number != 0 && !seen.insert(w.number).inserted { continue }
            out.append((w, true))
        }
        for w in all where w.pid != ownPid && !w.onScreen && !w.title.isEmpty && w.layer == 0 && w.alpha > 0.01
            && w.box.w >= minSide && w.box.h >= minSide && !w.owner.isEmpty {
            if w.number != 0 && !seen.insert(w.number).inserted { continue }
            out.append((w, false))
        }
        return out
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
