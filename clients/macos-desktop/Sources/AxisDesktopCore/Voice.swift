import Foundation

/** The Mac's microphone and speakers, as the voice part needs them. The platform supplies it (`AudioIO`). */
public protocol VoiceIO: AnyObject, Sendable {
    /**
     * Starts the microphone: `frame` gets 16 kHz mono 16-bit samples, about 20 ms at a time, on the IO's own queue
     * (never on the caller's thread, never on the audio thread). Throws, with words, when it cannot start.
     */
    func startCapture(_ frame: @escaping @Sendable ([Int16]) -> Void) throws
    func stopCapture()
    /** Starts a stretch of speech at `sampleRate` (16-bit mono, little-endian). */
    func playBegin(sampleRate: Int)
    func playWrite(_ pcm: Data)
    /** No more audio for this stretch: `finished` is called once, never from inside this call, when the last of it has been heard. */
    func playEnd(_ finished: @escaping @Sendable () -> Void)
    /** Stops at once and drops what is left. True when something was playing. */
    @discardableResult func stopPlayback() -> Bool
    /** How loud what is coming out of the speakers is just now, 0 to 1, for the face. */
    var playLevel: Double { get }
}

/** What the voice part is doing, for the app to show. */
public enum VoiceMode: String, Sendable { case idle, listening, transcribing, thinking, speaking, error }

/** What goes to Axis, in this order: a message, or a frame of the microphone's audio. */
public enum VoiceOutgoing: Equatable, Sendable {
    case message(JSONValue)
    case audio(Data)
}

/** Everything the pill and the face show, read at once. */
public struct VoiceSnapshot: Equatable, Sendable {
    public var mode: VoiceMode
    /** What was heard, then the reply as it comes; cleared on the next turn. */
    public var heard: String
    public var reply: String
    /** A question Axis is asking here, and its choices, until it is answered or taken back. */
    public var question: String?
    public var choices: [String]
    /** While thinking: the kind of work the agent has picked up (a tool icon's name) or why it is held up. */
    public var doing: String?
    /** The microphone's level just now, 0 to 1. */
    public var level: Double
    /** The loudness to show: the person's voice while listening, the agent's while it speaks; -1 otherwise. */
    public var loudness: Double
    /** A picture that came with the reply (`reply.image`), until the next turn. */
    public var picture: VoicePicture?

    public init(mode: VoiceMode, heard: String, reply: String, question: String?, choices: [String], doing: String?,
                level: Double, loudness: Double, picture: VoicePicture? = nil) {
        self.mode = mode
        self.heard = heard
        self.reply = reply
        self.question = question
        self.choices = choices
        self.doing = doing
        self.level = level
        self.loudness = loudness
        self.picture = picture
    }
}

/** A picture in a reply: `url` is a path on Axis that needs no credentials (`media.ts`); `alt` says what it shows. */
public struct VoicePicture: Equatable, Sendable {
    public var url: String
    public var alt: String
    public var turnId: String

    public init(url: String, alt: String, turnId: String) {
        self.url = url
        self.alt = alt
        self.turnId = turnId
    }
}

/** What a key-down did: stopped the agent, finished a recording, or started the microphone to see if it is held. */
public enum KeyDown: Equatable, Sendable { case stopped, finished, waiting }
/** What letting go did: a tap (nothing sent), the end of a hold, or nothing. */
public enum KeyUp: Equatable, Sendable { case tap, released, none }

/**
 * Sends what the voice part says to Axis one at a time, in the order it was said: audio.start, the frames, audio.end.
 * (One task per message would not keep the order.)
 */
public final class Outbox: @unchecked Sendable {
    private let continuation: AsyncStream<VoiceOutgoing>.Continuation
    private let task: Task<Void, Never>

    public init(_ sink: @escaping @Sendable (VoiceOutgoing) async -> Void) {
        var made: AsyncStream<VoiceOutgoing>.Continuation?
        let stream = AsyncStream<VoiceOutgoing> { made = $0 }
        continuation = made!
        task = Task { for await item in stream { await sink(item) } }
    }

    public func put(_ item: VoiceOutgoing) { continuation.yield(item) }

    deinit {
        continuation.finish()
        task.cancel()
    }
}

/**
 * Talking to the agent from this Mac, the way a board or the web client does: a press starts listening (and stops
 * on a pause, as theirs do), a hold listens until let go, a press while it thinks or speaks stops it. Speech from Axis
 * is played and reported (started, finished, stopped). A port of the Windows app's `Voice.cs` line for line; all
 * protocol and timing is here, so the platform supplies only `VoiceIO` and the key.
 *
 * No echo canceller, as on Windows: the microphone never listens while the agent speaks (speech arriving during a
 * recording ends the recording first; a press while it speaks stops the speech).
 */
public final class Voice: @unchecked Sendable {
    public static let micRate = 16000
    /** A pause this long after speech ends the recording; a recording with no speech in this long is dropped. */
    static let quietMs: UInt64 = 1200, nothingSaidMs: UInt64 = 6000, maxMs: UInt64 = 30000
    /** Louder than this (0..1 RMS) counts as speech. */
    static let speechLevel = 0.02
    /** Released after this long counts as having said something, even quietly. */
    static let heldEnoughMs: UInt64 = 900

    let io: VoiceIO
    let out: @Sendable (VoiceOutgoing) -> Void
    let clock: @Sendable () -> UInt64
    // Recursive: the IO may call back (playEnd's `finished`) while a call into it is still on the stack.
    private let lock = NSRecursiveLock()

    private var recording: String?
    private var holding = false
    private var startedAt: UInt64 = 0, quietSince: UInt64 = 0
    private var spoke = false
    private var playing: String?
    private var turn: String?
    private var replyTurn: String?
    private var askId: String?
    private var ids = 0

    private var mode = VoiceMode.idle
    private var heard = "", reply = ""
    private var question: String?
    private var choices: [String] = []
    private var doing: String?
    private var level = 0.0
    private var picture: VoicePicture?

    // From a key-down until it is known to be a hold or a tap: the microphone runs, its frames kept.
    private var waiting = false
    private var waitCapturing = false
    private var waitError: Error?
    private var waitAt: UInt64 = 0
    private var preRoll = PreRoll()

    /** Anything shown changed. Called on whichever thread changed it: hop to the main thread before drawing. */
    public var onChange: (@Sendable () -> Void)?
    /** Something went wrong handling a message from Axis (for the app's list). */
    public var onFailed: (@Sendable (String) -> Void)?
    /** A recording has just started (for the listening cue). Called under the voice part's lock: hop before doing much. */
    public var onListening: (@Sendable () -> Void)?

    /** `out` sends in order (an `Outbox`); `clock` is milliseconds from any fixed start. */
    public init(io: VoiceIO, out: @escaping @Sendable (VoiceOutgoing) -> Void, clock: @escaping @Sendable () -> UInt64 = Voice.uptimeMs) {
        self.io = io
        self.out = out
        self.clock = clock
    }

    public static let uptimeMs: @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds / 1_000_000 }

    public var snapshot: VoiceSnapshot {
        lock.lock(); defer { lock.unlock() }
        let loud = mode == .listening ? level : mode == .speaking ? io.playLevel : -1
        return VoiceSnapshot(mode: mode, heard: heard, reply: reply, question: question, choices: choices, doing: doing, level: level,
                             loudness: loud, picture: picture)
    }

    public var currentMode: VoiceMode { lock.lock(); defer { lock.unlock() }; return mode }

    /** The loudness to show just now, 0 to 1: the person's voice while listening, the agent's while it speaks; -1 otherwise. */
    public var loudness: Double {
        lock.lock(); defer { lock.unlock() }
        return mode == .listening ? level : mode == .speaking ? io.playLevel : -1
    }

    private var busy: Bool { mode == .transcribing || mode == .thinking || mode == .speaking }

    private func send(_ m: [String: JSONValue]) { out(.message(.object(m))) }

    /** The link to Axis came or went: a turn that was waiting on it will never finish, so let go of it. */
    public func linkChanged(online: Bool) {
        guard !online else { return }
        lock.lock(); defer { lock.unlock() }
        let was = mode
        if playing != nil {
            io.stopPlayback()
            playing = nil
        }
        if askId != nil {
            askId = nil
            question = nil
            choices = []
        }
        if was == .transcribing || was == .thinking || was == .speaking {
            doing = nil
            set(.idle)
        } else {
            onChange?()
        }
    }

    /** The talk key went down: starts listening; while listening, finishes; while the agent thinks or speaks, stops it. */
    public func press() {
        lock.lock(); defer { lock.unlock() }
        if recording != nil {
            // A second press while listening finishes, as a tap on the board does.
            finish(spoke ? "silence" : "cancel")
            return
        }
        if busy || playing != nil {
            interrupt()
            return
        }
        start(askId != nil ? "question" : "tap")
    }

    /** A choice picked on screen (a button in the pill): sent as the answer, as a tap on a board does. */
    public func answer(_ choice: String) {
        let id: String
        do {
            lock.lock(); defer { lock.unlock() }
            guard let a = askId, choices.contains(choice) else { return }
            id = a
            askId = nil
            question = nil
            choices = []
        }
        send(["t": "answer", "askId": .string(id), "choice": .string(choice)])
        onChange?()
    }

    /** The key has stayed down: listen until it comes up. */
    public func hold() {
        lock.lock(); defer { lock.unlock() }
        if recording != nil { holding = true }
    }

    /** The key came up after a hold: send what was said. */
    public func release() {
        lock.lock(); defer { lock.unlock() }
        guard recording != nil, holding else { return }
        holding = false
        finish(spoke || clock() - startedAt > Self.heldEnoughMs ? "silence" : "cancel")
    }

    // MARK: Hold to talk, tap to type

    /**
     * The talk key went down. While listening it finishes; while the agent thinks or speaks it stops it; otherwise the
     * microphone starts at once and its frames are kept (`PreRoll`) until `keyHeld` (a hold: they are sent) or `keyUp`
     * (a tap: they are thrown away).
     */
    @discardableResult
    public func keyDown() -> KeyDown {
        lock.lock(); defer { lock.unlock() }
        if recording != nil {
            finish(spoke ? "silence" : "cancel")
            return .finished
        }
        if busy || playing != nil {
            interrupt()
            return .stopped
        }
        if waiting { return .waiting }
        waiting = true
        waitAt = clock()
        waitError = nil
        preRoll.clear()
        do {
            try io.startCapture { [weak self] samples in self?.frame(samples) }
            waitCapturing = true
        } catch {
            // Said only if it turns out to be a hold: a tap types, and needs no microphone.
            waitCapturing = false
            waitError = error
        }
        return .waiting
    }

    /** The key has stayed down `TapHold.tapMs`: a hold. The turn starts with what the microphone heard since key-down. */
    public func keyHeld() {
        lock.lock(); defer { lock.unlock() }
        guard waiting else { return }
        waiting = false
        commit(askId != nil ? "question" : "hold", holding: true)
    }

    /**
     * The key came up. Before `keyHeld`: a tap, and what was heard is dropped (or, with `tapListens`, the recording
     * goes on until a pause, as a press did before 0.4.0). After it: the end of the hold.
     */
    @discardableResult
    public func keyUp(tapListens: Bool = false) -> KeyUp {
        lock.lock(); defer { lock.unlock() }
        if waiting {
            waiting = false
            if tapListens {
                commit(askId != nil ? "question" : "tap", holding: false)
                return .tap
            }
            if waitCapturing { io.stopCapture() }
            waitCapturing = false
            preRoll.clear()
            level = 0
            onChange?()
            return .tap
        }
        if recording != nil && holding {
            release()
            return .released
        }
        return .none
    }

    /** Starts the turn on the microphone already running since key-down (under the lock). */
    private func commit(_ trigger: String, holding hold: Bool) {
        let kept = preRoll.take()
        if let error = waitError, !waitCapturing {
            waitError = nil
            failToStart(error)
            return
        }
        begin(trigger, at: waitAt)
        holding = hold
        waitCapturing = false
        for f in kept { consume(f) }
        if recording != nil { onChange?() }
    }

    // MARK: Typing

    /**
     * A typed turn (the web client's text box): speech and any recording stop, Axis is told to stop the turn under
     * way, then `{t: "text", turnId, text}`. While a question is open Axis takes the text as its answer. False when
     * there is nothing to send.
     */
    @discardableResult
    public func type(_ text: String) -> Bool {
        guard let clean = TypedText.clean(text) else { return false }
        lock.lock(); defer { lock.unlock() }
        if waiting {
            waiting = false
            if waitCapturing { io.stopCapture() }
            waitCapturing = false
            preRoll.clear()
        }
        interrupt()
        ids += 1
        let id = "pc-\(String(clock(), radix: 16))-\(ids)"
        turn = id
        heard = clean
        reply = ""
        picture = nil
        doing = nil
        send(["t": "text", "turnId": .string(id), "text": .string(clean)])
        set(.thinking)
        return true
    }

    private func start(_ trigger: String) {
        begin(trigger, at: clock())
        do {
            try io.startCapture { [weak self] samples in self?.frame(samples) }
        } catch {
            failToStart(error)
        }
    }

    /** A new recording's id and audio.start (under the lock); the microphone is the caller's. */
    private func begin(_ trigger: String, at: UInt64) {
        ids += 1
        let id = "pc-\(String(clock(), radix: 16))-\(ids)"
        recording = id
        holding = false
        spoke = false
        quietSince = 0
        startedAt = at
        heard = ""
        reply = ""
        picture = nil
        set(.listening)
        send([
            "t": "audio.start",
            "turnId": .string(id),
            "format": ["encoding": "pcm_s16le", "sampleRate": .int(Self.micRate), "channels": 1],
            "trigger": .string(trigger),
        ])
        onListening?()
    }

    private func failToStart(_ error: Error) {
        if let id = recording {
            recording = nil
            send(["t": "audio.end", "turnId": .string(id), "reason": "cancel"])
        }
        reply = "The microphone could not start: \(describeError(error))"
        set(.error)
    }

    /** One frame from the microphone. Internal for the tests; the IO calls it through `startCapture`'s closure. */
    func frame(_ samples: [Int16]) {
        do {
            lock.lock(); defer { lock.unlock() }
            if waiting {
                // Not yet known to be a hold: kept, not sent.
                preRoll.push(samples)
                return
            }
            guard recording != nil else { return }
            consume(samples)
        }
        onChange?()
    }

    /** One frame of a recording: its level, speech or quiet, sent, and the recording ended when it is time (under the lock). */
    private func consume(_ samples: [Int16]) {
        guard recording != nil else { return }
        let rms = PCM.rms(samples)
        level = PCM.micLevel(rms: rms)
        let now = clock()
        if rms > Self.speechLevel {
            spoke = true
            quietSince = 0
        } else if spoke, quietSince == 0 {
            quietSince = now
        }
        out(.audio(PCM.bytes(samples)))
        if !holding && spoke && quietSince != 0 && now - quietSince > Self.quietMs { finish("silence") }
        else if now - startedAt > Self.maxMs { finish("max") }
        else if !holding && !spoke && now - startedAt > Self.nothingSaidMs { finish("cancel") }
    }

    /** Ends the recording (under the lock). */
    private func finish(_ reason: String) {
        guard let id = recording else { return }
        recording = nil
        holding = false
        level = 0
        io.stopCapture()
        send(["t": "audio.end", "turnId": .string(id), "reason": .string(reason)])
        set(reason == "cancel" ? .idle : .transcribing)
    }

    /** Stops speech and tells Axis the person wants it to stop. */
    public func interrupt() {
        lock.lock(); defer { lock.unlock() }
        if recording != nil { finish("cancel") }
        let was = playing
        playing = nil
        if io.stopPlayback(), let was { send(["t": "playback", "turnId": .string(was), "state": "stopped"]) }
        send(["t": "interrupt"])
        set(.idle)
    }

    /** Speech audio from Axis: the binary frames between a speak.start and its speak.end. */
    public func audio(_ pcm: Data) {
        lock.lock(); defer { lock.unlock() }
        if playing != nil { io.playWrite(pcm) }
    }

    /** A message from Axis the link does not handle itself (turn, transcript, reply.text, speak.*, stop, ask, ask.end). */
    public func handle(_ type: String, _ m: JSONValue) {
        // A failure while handling one message must not take the connection with it; nothing here throws, but the IO may misbehave.
        lock.lock(); defer { lock.unlock() }
        let s: (String) -> String? = { m[$0]?.stringValue }
        switch type {
        case "turn":
            turn = s("turnId")
            let state = s("state")
            // Listening is ours to show; the rest follow Axis.
            if state == "listening" && recording == nil { break }
            let next: VoiceMode
            switch state {
            case "transcribing": next = .transcribing
            case "thinking": next = .thinking
            case "speaking": next = .speaking
            case "error": next = .error
            case "idle": next = playing != nil ? .speaking : .idle
            default: next = mode
            }
            if state == "thinking" {
                if let d = s("doing") { doing = d == "none" ? nil : d }
            } else {
                doing = nil
            }
            if state == "error", let why = s("detail"), !why.isEmpty { reply = why }
            set(next)
        case "reply.image":
            guard let url = s("url"), !url.isEmpty else { break }
            picture = VoicePicture(url: url, alt: s("alt") ?? "", turnId: s("turnId") ?? "")
            onChange?()
        case "transcript":
            heard = s("text") ?? ""
            onChange?()
        case "reply.text":
            let text = s("text") ?? ""
            let final = m["final"]?.boolValue == true
            // Another turn's words (an announcement after an answer) start afresh.
            if s("turnId") != replyTurn {
                reply = ""
                if let p = picture, p.turnId != s("turnId") { picture = nil }
            }
            replyTurn = s("turnId")
            reply = final ? text : reply + text
            onChange?()
        case "speak.start":
            guard let id = s("turnId") else { break }
            let rate = m["format"]?["sampleRate"]?.intValue ?? 24000
            // Speech that comes while the person is talking to it waits its turn: theirs comes first.
            if recording != nil { finish("silence") }
            if playing != nil { io.stopPlayback() }
            playing = id
            io.playBegin(sampleRate: rate)
            send(["t": "playback", "turnId": .string(id), "state": "started"])
            set(.speaking)
        case "speak.end":
            guard let id = s("turnId"), id == playing else { break }
            io.playEnd { [weak self] in self?.played(id) }
        case "ask":
            askId = s("askId")
            question = s("question")
            choices = (m["choices"]?.arrayValue ?? []).compactMap { $0.stringValue }.filter { !$0.isEmpty }
            onChange?()
        case "ask.end":
            guard s("askId") == askId else { break }
            askId = nil
            question = nil
            choices = []
            onChange?()
        case "stop":
            let was = playing
            playing = nil
            if io.stopPlayback(), let was { send(["t": "playback", "turnId": .string(was), "state": "stopped"]) }
            if mode == .speaking { set(.idle) }
        default:
            break
        }
    }

    /** The last of `id`'s speech has been heard. */
    private func played(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        guard playing == id else { return }
        playing = nil
        send(["t": "playback", "turnId": .string(id), "state": "finished"])
        if mode == .speaking { set(.idle) }
    }

    private func set(_ next: VoiceMode) {
        mode = next
        onChange?()
    }
}
