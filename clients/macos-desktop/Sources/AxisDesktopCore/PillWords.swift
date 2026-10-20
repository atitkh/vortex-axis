import Foundation

/** The colour of what is going on, for a pill's dot, its edge and its first line (the Windows app's colours). */
public enum PillTint: String, Equatable, Sendable {
    case listening, hearing, thinking, speaking, error, question, control

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
                              dotScale: scale, then: then)
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
