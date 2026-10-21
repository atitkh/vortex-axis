import Foundation

/** The colour of what is going on, for a pill's dot, its edge and its first line (the Windows app's colours). */
public enum PillTint: String, Equatable, Sendable {
    case listening, hearing, thinking, speaking, error, question, control
    /** An agent's long task under way, one waiting for the person, one finished; a timer counting down. */
    case task, needsYou, done, timer

    /** Red, green and blue, 0 to 255. */
    public var rgb: (r: Int, g: Int, b: Int) {
        switch self {
        case .listening: return (0x26, 0xFF, 0x8C)
        case .hearing: return (0x9E, 0x66, 0xFF)
        case .thinking: return (0xB0, 0x82, 0xFF)
        case .speaking: return (0x8C, 0xF2, 0xFF)
        case .error: return (0xFF, 0x5C, 0x4A)
        case .question: return (0x4D, 0x94, 0xFF)
        case .control: return (0xFF, 0x52, 0x9E)
        case .task: return (0x8C, 0xB4, 0xFF)
        case .needsYou: return (0xFF, 0xB3, 0x3D)
        case .done: return (0x3D, 0xDC, 0x84)
        case .timer: return (0xFF, 0xD2, 0x4D)
        }
    }
}

/** The "using this computer" pill's words and timing (the Windows app's `ControlPill`). */
public enum ControlPillWords {
    public static let title = "VorteX is using this computer"
    /** How long after the last command it stays: the agent thinks between calls. Matches Axis's own count. */
    public static let linger = 8.0

    /** Whether a command shows the pill: a `desktop.*` command other than the admin page's "Show the pointer". */
    public static func shows(_ command: String, paused: Bool, switchedOn: Bool) -> Bool {
        command.hasPrefix("desktop.") && command != "desktop.hello" && !paused && switchedOn
    }
}

/**
 * What the voice pill shows for the voice part's state (the Windows app's `VoicePill.Show`): a word in the colour of the
 * moment, what was heard in quotes, the reply, a question with its choices, and what to do with the pill.
 */
public struct VoicePillWords: Equatable, Sendable {
    public enum Then: Equatable, Sendable {
        /** Show it and keep it (a turn under way, a question waiting). */
        case show
        /** Show it, then let it go after `linger` (something went wrong). */
        case showThenLeave
        /** The turn is done: leave the answer `linger` seconds to be read, then go (when it is up). */
        case leaveSoon
        /** Nothing was said: go now. */
        case hide
    }

    /** How long a finished answer stays. */
    public static let linger = 6.0

    public var status: String
    public var tint: PillTint
    /** What was heard (in quotes), or the question. */
    public var heard: String
    /** Whether `heard` is the person's words (shown in italics), not a question. */
    public var heardIsSpeech: Bool
    public var reply: String
    /** The question's choices as buttons; the pill takes clicks only while there are any. */
    public var choices: [String]
    /** How big the dot is: it swells with the voice while listening. */
    public var dotScale: Double
    public var then: Then
    /** The address of a picture that came with the reply, shown under it (and gone with it). */
    public var picture: String? = nil

    public static func of(_ s: VoiceSnapshot, talkKey: String) -> VoicePillWords {
        var (status, tint) = word(s.mode)
        let scale: Double = s.mode == .listening ? 1 + max(0, s.level) * 0.9 : 1
        // A question waiting here: said in the pill, with its choices, until answered.
        if let q = s.question, s.mode == .idle || s.mode == .listening {
            if s.mode == .idle { (status, tint) = ("Question · \(talkKey) to answer", .question) }
            return VoicePillWords(status: status, tint: tint, heard: q, heardIsSpeech: false, reply: "", choices: s.choices,
                                  dotScale: scale, then: .show)
        }
        let heard = s.heard.isEmpty ? "" : "“\(s.heard)”"
        let then: Then
        switch s.mode {
        case .idle: then = s.reply.isEmpty && s.heard.isEmpty ? .hide : .leaveSoon
        case .error: then = .showThenLeave
        default: then = .show
        }
        return VoicePillWords(status: status, tint: tint, heard: heard, heardIsSpeech: true, reply: s.reply, choices: [],
                              dotScale: scale, then: then, picture: s.picture?.url)
    }

    static func word(_ mode: VoiceMode) -> (String, PillTint) {
        switch mode {
        case .listening: return ("Listening", .listening)
        case .transcribing: return ("Hearing you", .hearing)
        case .thinking: return ("Thinking", .thinking)
        case .speaking: return ("Speaking", .speaking)
        case .error: return ("Something went wrong", .error)
        case .idle: return ("", .speaking)
        }
    }
}

/**
 * The task pill (an agent's long work, `progress.show`): its title, how far ("3/5", or the note), a bar when the steps
 * are counted, "+N" for the other tasks, and the list a click opens: the other tasks first, then this one's steps.
 */
public struct TaskPillWords: Equatable, Sendable {
    public struct Row: Equatable, Sendable {
        public enum Kind: String, Equatable, Sendable { case task, needsYou, done, running, pending }
        public var kind: Kind
        public var text: String
    }

    /** The most rows the open list shows; the rest are on the admin page's Live page. */
    public static let maxRows = 8

    public var title: String
    /** "3/5", "needs you: …", "done", or the note. */
    public var detail: String
    public var tint: PillTint
    /** 0 to 1, or nil for no bar. */
    public var fraction: Double?
    /** "+2", or empty. */
    public var more: String
    public var rows: [Row]
    /** A finished task can be put away. */
    public var dismissible: Bool

    public static func of(_ t: TaskLine) -> TaskPillWords? {
        guard t.shows else { return nil }
        let tint: PillTint = t.state == .done ? .done : t.state == .blocked ? .needsYou : .task
        let count = t.total > 0 ? "\(max(0, t.done))/\(t.total)" : ""
        let detail: String
        switch t.state {
        case .done: detail = "done"
        case .blocked: detail = ["needs you", t.note].filter { !$0.isEmpty }.joined(separator: ": ")
        default: detail = [count, t.note].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        var rows = t.others.map { Row(kind: $0.needsYou ? .needsYou : $0.text.hasSuffix(" done") ? .done : .task, text: $0.text) }
        rows += t.steps.map { Row(kind: $0.state == .done ? .done : $0.state == .running ? .running : .pending, text: $0.text) }
        if rows.count > maxRows { rows = Array(rows.prefix(maxRows - 1)) + [Row(kind: .pending, text: "… \(rows.count - maxRows + 1) more")] }
        return TaskPillWords(title: t.title, detail: detail, tint: tint, fraction: t.fraction,
                             more: t.others.isEmpty ? "" : "+\(t.others.count)", rows: rows, dismissible: t.state == .done)
    }
}

/** The timer pill (`timer.next`): its name, the time left, "+N" for more timers; red in the last 10 s, as the boards glow. */
public struct TimerPillWords: Equatable, Sendable {
    public static let warnSeconds = 10

    public var label: String
    public var clock: String
    public var tint: PillTint
    public var cancellable: Bool

    public static func of(_ t: NextTimer, now: UInt64) -> TimerPillWords {
        let left = t.secondsLeft(now: now)
        let more = t.count > 1 ? " +\(t.count - 1)" : ""
        return TimerPillWords(label: t.label.isEmpty ? "Timer" : t.label, clock: NextTimer.clock(left) + more,
                              tint: left <= warnSeconds ? .error : .timer, cancellable: t.id != nil && left > 0)
    }
}

/** The typing pill's first line: "Typing", or the question it will answer. */
public enum TypingPillWords {
    public static let status = "Typing"
    public static let placeholder = "Ask VorteX…  (Return sends, ⇧Return new line, Esc closes)"
    public static let answerPlaceholder = "Type your answer…"
}

/** What the menu bar icon shows: the app's state at a glance. */
public enum MenuIconState: String, CaseIterable, Equatable, Sendable {
    case idle, listening, speaking, usingComputer, paused, offline

    /** Paused first (the person's own choice), then no link, then the voice, then an agent at work here. */
    public static func of(online: Bool, paused: Bool, voice: VoiceMode?, agentHere: Bool) -> MenuIconState {
        if paused { return .paused }
        if !online { return .offline }
        switch voice {
        case .listening?: return .listening
        case .speaking?: return .speaking
        default: return agentHere ? .usingComputer : .idle
        }
    }

    /** For VoiceOver and the item's tooltip. */
    public var words: String {
        switch self {
        case .idle: return "VorteX Axis"
        case .listening: return "VorteX Axis: listening"
        case .speaking: return "VorteX Axis: speaking"
        case .usingComputer: return "VorteX Axis: an agent is using this Mac"
        case .paused: return "VorteX Axis: paused"
        case .offline: return "VorteX Axis: offline"
        }
    }
}
