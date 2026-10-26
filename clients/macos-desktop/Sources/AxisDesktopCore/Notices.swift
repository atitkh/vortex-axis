import Foundation

/**
 * The long-task line Axis sends to every client with a screen (`progress.show`, server `progress.ts` `tell`): the task
 * reported on last, how far it is, its steps, and the other tasks a line each. Read as the web client reads it.
 */
public struct TaskLine: Equatable, Sendable {
    public enum State: String, Equatable, Sendable { case running, blocked, done, none }

    public struct Step: Equatable, Sendable {
        public enum State: String, Equatable, Sendable { case done, running, pending }
        public var state: State
        public var text: String
    }

    /** Another task, as `taskLine` writes it: "!" leads one that waits for the person. */
    public struct Other: Equatable, Sendable {
        public var needsYou: Bool
        public var text: String
    }

    public var title: String
    public var note: String
    /** Steps done and in all; `total` 0 when the work has no steps (then `done` is -1). */
    public var done: Int
    public var total: Int
    public var state: State
    /** How many tasks there are, this one included. */
    public var count: Int
    public var steps: [Step]
    public var others: [Other]

    public static let none = TaskLine(title: "", note: "", done: -1, total: 0, state: .none, count: 0, steps: [], others: [])

    /** From the command's params; anything missing reads as the web client reads it. */
    public static func of(_ p: JSONValue) -> TaskLine {
        let int: (String) -> Int? = { p[$0]?.intValue ?? p[$0]?.doubleValue.map { Int($0) } }
        let lines: (String) -> [String] = { key in
            guard let s = p[key]?.stringValue, !s.isEmpty else { return [] }
            return s.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        }
        let steps = lines("steps").map { line -> Step in
            let mark = line.first
            let state: Step.State = mark == "x" ? .done : mark == ">" ? .running : .pending
            return Step(state: state, text: String(line.dropFirst()))
        }
        let others = lines("others").map { Other(needsYou: $0.first == "!", text: String($0.dropFirst())) }
        return TaskLine(title: p["title"]?.stringValue ?? "", note: p["note"]?.stringValue ?? "", done: int("done") ?? -1,
                        total: int("total") ?? 0, state: State(rawValue: p["state"]?.stringValue ?? "") ?? .running,
                        count: int("count") ?? 0, steps: steps, others: others)
    }

    /** How far along, 0 to 1, or nil when it has no steps to count (no bar then, unless it is done). */
    public var fraction: Double? {
        if state == .done { return 1 }
        guard total > 0 else { return nil }
        return min(1, max(0, Double(max(0, done)) / Double(total)))
    }

    public var shows: Bool { count > 0 && state != .none && !title.isEmpty }
}

/** The next timer, from `timer.next` (server `timers.ts` `tell`): its label, when it ends, how many there are, its id. */
public struct NextTimer: Equatable, Sendable {
    public var label: String
    /** On the voice part's clock (milliseconds). */
    public var endsAt: UInt64
    public var count: Int
    /** What `/v1/timers/cancel` takes; nil from an older Axis (no cancel then). */
    public var id: Int?

    /** Nil when there is no timer (ms 0). */
    public static func of(_ p: JSONValue, now: UInt64) -> NextTimer? {
        let ms = p["ms"]?.intValue ?? p["ms"]?.doubleValue.map { Int($0) } ?? 0
        guard ms > 0 else { return nil }
        let count = p["count"]?.intValue ?? 1
        return NextTimer(label: p["label"]?.stringValue ?? "", endsAt: now + UInt64(ms), count: max(1, count), id: p["id"]?.intValue)
    }

    /** Whole seconds left, rounded up as the web client does. */
    public func secondsLeft(now: UInt64) -> Int {
        guard endsAt > now else { return 0 }
        return Int((endsAt - now + 999) / 1000)
    }

    /** "4:05", "1:02:09": the web client's clock. */
    public static func clock(_ seconds: Int) -> String {
        let s = max(0, seconds)
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        let ss = sec < 10 ? "0\(sec)" : "\(sec)"
        if h > 0 { return "\(h):\(m < 10 ? "0\(m)" : "\(m)"):\(ss)" }
        return "\(m):\(ss)"
    }
}

/**
 * What Axis asks a screen to show besides the voice (`progress.show`, `timer.next`) and the sound it may ask for
 * (`chime`): commands that every desktop answered "not implemented" before 0.4.0. Holds the latest of each and
 * says when they change; the pills read it. The chime is played by the app through `onChime`.
 *
 * A finished task stays `doneShownMs` (Axis's own 90 s, after which it sends the line again without it) unless put
 * away sooner: `dismissDone` hides it here and tells Axis to put finished tasks away everywhere (the boards' swipe
 * down, a `gesture` of `swipe_down`).
 */
public final class Notices: @unchecked Sendable {
    public static let doneShownMs: UInt64 = 90_000
    /** A countdown at 0 that Axis has not followed with the next timer is let go after this. */
    public static let rungShownMs: UInt64 = 60_000

    public enum Sound: String, Sendable { case timer, taskDone, listening }

    private let lock = NSLock()
    private let clock: @Sendable () -> UInt64
    private var _task = TaskLine.none
    private var doneSince: UInt64?
    private var _timer: NextTimer?
    private var _elsewhere = 0
    private var settings: [String: JSONValue] = [:]
    private let minuteOfDay: @Sendable () -> Int

    /** Something to show changed. Called on whichever thread changed it. */
    public var onChange: (@Sendable () -> Void)?
    /** Plays a sound `SoundRules` allows just now (on the speaker). True when it was played. */
    public var onChime: (@Sendable (Sound) -> Bool)?
    /** A message for Axis (the dismissal's gesture). */
    public var send: (@Sendable (JSONValue) -> Void)?

    public init(clock: @escaping @Sendable () -> UInt64 = Voice.uptimeMs,
                minuteOfDay: @escaping @Sendable () -> Int = { SoundRules.minuteOfDay() }) {
        self.clock = clock
        self.minuteOfDay = minuteOfDay
    }

    /** The settings Axis sent (quiet hours, `taskChime`, `listenCue`). */
    public func useSettings(_ values: [String: JSONValue]) { lock.withLock { settings = values } }

    /** Plays `sound` if it may play now (never in quiet hours; the task chime and the cue only while switched on). */
    @discardableResult
    public func play(_ sound: Sound) -> Bool {
        // The speaker switched off on the admin page: no sounds at all.
        let may = lock.withLock {
            !DesktopCommands.capabilitiesOff(settings).contains("speaker") && SoundRules.allowed(sound, settings: settings, minuteOfDay: minuteOfDay())
        }
        return may && onChime?(sound) == true
    }

    /** The task to show now: none once a finished one has been on show long enough. */
    public var task: TaskLine {
        lock.withLock {
            if _task.state == .done, let since = doneSince, clock() - since > Self.doneShownMs { return .none }
            return _task
        }
    }

    /** The timer to show now: none a while after it ran out with no word from Axis. */
    public var timer: NextTimer? {
        lock.withLock {
            guard let t = _timer else { return nil }
            if clock() > t.endsAt + Self.rungShownMs { return nil }
            return t
        }
    }

    public var now: UInt64 { clock() }

    /** How many questions wait for the person on another device, or on none (`ask.waiting`); 0 for none. */
    public var asksElsewhere: Int { lock.withLock { _elsewhere } }

    /** The commands this part answers; anything else is for `DesktopCommands`. */
    public static let commands: Set<String> = ["progress.show", "timer.next", "chime", "ask.waiting"]

    public func handle(_ name: String, _ p: JSONValue) -> CommandAnswer {
        switch name {
        case "progress.show":
            let line = TaskLine.of(p)
            lock.withLock {
                let was = _task.state
                _task = line
                if line.state == .done { if was != .done || doneSince == nil { doneSince = clock() } } else { doneSince = nil }
            }
            if p["chime"]?.boolValue == true { play(.taskDone) }
            onChange?()
            return .done()
        case "timer.next":
            let next = NextTimer.of(p, now: clock())
            lock.withLock { _timer = next }
            onChange?()
            return .done()
        case "ask.waiting":
            // A question waiting where it is not shown here (server `asklight.ts`): a quiet line, as the boards glow blue.
            let n = max(0, p["elsewhere"]?.intValue ?? 0)
            lock.withLock { _elsewhere = n }
            onChange?()
            return .done()
        case "chime":
            // Axis waits for the chime before it speaks only when it was played: a quiet one is said to be not played.
            return play(.timer) ? .done() : .fail("no chime now (quiet hours, or no speaker)")
        default:
            return .fail("not implemented on this device")
        }
    }

    /** The person put the finished task away (the pill's ×): gone here, and Axis takes finished tasks off every screen. */
    public func dismissDone() {
        let had: Bool = lock.withLock {
            guard _task.state == .done else { return false }
            _task = .none
            doneSince = nil
            return true
        }
        guard had else { return }
        send?(["t": "gesture", "gesture": "swipe_down"])
        onChange?()
    }

    /** The link went: what it showed may be stale. Axis tells it again on the next connection. */
    public func linkChanged(online: Bool) {
        guard !online else { return }
        lock.withLock {
            _task = .none
            doneSince = nil
            _timer = nil
            _elsewhere = 0
        }
        onChange?()
    }
}
