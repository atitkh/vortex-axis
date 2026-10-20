import Foundation

/**
 * What `window do=restore` does to a window, from what the window says now and what this app remembers of it.
 * Pure, so it is tested off the Mac. In 0.2.1's live test Brave was in macOS full screen, was taken out of it to be
 * minimised, and came back from the Dock as an ordinary window (0,75 1450x838 instead of 0,33 1470x923): a window
 * this app took out of full screen goes back into it when it is restored.
 */
public enum WindowRestore {
    public enum Step: Equatable, Sendable {
        case unminimise
        case leaveFullScreen
        case enterFullScreen
        case setBox(Box)
    }

    /**
     * In order: a minimised window comes back from the Dock, then into full screen again when it was in full screen
     * before this app minimised it. A window in full screen now is taken out of it (restore is "back to ordinary").
     * Otherwise the box it had before `maximize` (`previous`), else full screen again if it was taken out of it.
     */
    public static func steps(minimised: Bool, fullScreen: Bool, wasFullScreen: Bool, previous: Box?) -> [Step] {
        if minimised { return wasFullScreen ? [.unminimise, .enterFullScreen] : [.unminimise] }
        if fullScreen { return [.leaveFullScreen] }
        if let previous { return [.setBox(previous)] }
        return wasFullScreen ? [.enterFullScreen] : []
    }
}

/**
 * The windows this app took out of macOS full screen to minimise them, by app and title, so a restore puts them
 * back (`WindowRestore`). A window's title can change while it waits in the Dock (a page that finished loading), so
 * an app with only one such window is matched by the app alone.
 */
public struct FullScreenMemory: Sendable {
    private var titles: [Int32: Set<String>] = [:]

    public init() {}

    /** Remembers that `title` of app `pid` was in full screen before this app minimised it. */
    public mutating func note(pid: Int32, title: String) {
        titles[pid, default: []].insert(title)
    }

    /** Whether that window was: the same title, or the only one remembered for the app. */
    public func had(pid: Int32, title: String) -> Bool {
        guard let set = titles[pid] else { return false }
        return set.contains(title) || set.count == 1
    }

    /**
     * Forgets the window: after a restore, the one `had` matched (`exactly` false); after something else done to a
     * window (moved), only that title, so another window of the same app is not forgotten with it.
     */
    public mutating func forget(pid: Int32, title: String, exactly: Bool = false) {
        guard var set = titles[pid] else { return }
        if set.contains(title) { set.remove(title) } else if !exactly && set.count == 1 { set.removeAll() }
        titles[pid] = set.isEmpty ? nil : set
    }
}
