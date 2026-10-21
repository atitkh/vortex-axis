import Foundation

/**
 * The app's few sounds, made in code (no sound files): a list of samples, -1 to 1, mono, at `rate`, for the platform
 * to play through the chosen speaker. Each is a sum of sine notes, every note shaped by a short linear rise and an
 * exponential fall to silence, so none clicks at either end.
 */
public enum Sounds {
    public static let rate = 44100.0

    /** One sine note: `hz` from `at` seconds, rising to `peak` in `attack` s, falling to a thousandth by `length` s. */
    public struct Note: Equatable, Sendable {
        public var hz: Double
        public var at: Double
        public var peak: Double
        public var attack: Double
        public var length: Double
        /** The pitch at the end, for a glide (the listening cue); nil holds it. */
        public var toHz: Double?

        public init(hz: Double, at: Double, peak: Double, attack: Double = 0.02, length: Double, toHz: Double? = nil) {
            self.hz = hz
            self.at = at
            self.peak = peak
            self.attack = attack
            self.length = length
            self.toHz = toHz
        }
    }

    /** How loud a note is `t` seconds after it starts: the web client's ramp (linear up, exponential down to 0.001). */
    public static func envelope(_ n: Note, _ t: Double) -> Double {
        guard t >= 0, t <= n.length else { return 0 }
        if t < n.attack { return n.peak * t / n.attack }
        let fall = (t - n.attack) / max(0.001, n.length - n.attack)
        // From peak to a thousandth of it, the last few milliseconds faded to exactly nothing.
        let level = n.peak * pow(0.001, fall)
        let tail = min(1, (n.length - t) / 0.005)
        return level * tail
    }

    public static func render(_ notes: [Note], rate: Double = rate) -> [Float] {
        let end = notes.map { $0.at + $0.length }.max() ?? 0
        let count = Int((end * rate).rounded(.up))
        var out = [Float](repeating: 0, count: count)
        for n in notes {
            let first = Int(n.at * rate), samples = Int(n.length * rate)
            var phase = 0.0
            for i in 0..<samples where first + i < count {
                let t = Double(i) / rate
                let hz = n.toHz.map { n.hz + ($0 - n.hz) * t / n.length } ?? n.hz
                phase += 2 * Double.pi * hz / rate
                out[first + i] += Float(sin(phase) * envelope(n, t))
            }
        }
        // Never over full scale, however the notes add up.
        let peak = out.reduce(Float(0)) { max($0, abs($1)) }
        if peak > 0.95 { for i in out.indices { out[i] *= 0.95 / peak } }
        return out
    }

    /** Two soft notes, E5 then A5, for an agent's task that has just finished: the web client's `chime`. */
    public static let taskDoneNotes = [
        Note(hz: 659.25, at: 0, peak: 0.12, length: 0.5),
        Note(hz: 880, at: 0.16, peak: 0.12, length: 0.5),
    ]

    /** A small bell for a timer (before Axis says which one): three strikes of a bell-like pair of partials. */
    public static let timerNotes: [Note] = [0.0, 0.42, 0.84].flatMap { at in
        [Note(hz: 1046.5, at: at, peak: 0.22, attack: 0.004, length: 0.9),
         Note(hz: 2637, at: at, peak: 0.06, attack: 0.002, length: 0.35)]
    }

    /** A short rising tone as listening starts: the boards' `listenCue`. */
    public static let listeningNotes = [Note(hz: 620, at: 0, peak: 0.1, attack: 0.012, length: 0.14, toHz: 940)]

    public static func notes(_ sound: Notices.Sound) -> [Note] {
        switch sound {
        case .timer: return timerNotes
        case .taskDone: return taskDoneNotes
        case .listening: return listeningNotes
        }
    }

    private static let timerSamples = render(timerNotes)
    private static let taskDoneSamples = render(taskDoneNotes)
    private static let listeningSamples = render(listeningNotes)

    /** The sound's samples at `rate`, made once. */
    public static func samples(_ sound: Notices.Sound) -> [Float] {
        switch sound {
        case .timer: return timerSamples
        case .taskDone: return taskDoneSamples
        case .listening: return listeningSamples
        }
    }

    /** How long a sound lasts, in milliseconds. */
    public static func lengthMs(_ sound: Notices.Sound) -> Int {
        Int(((notes(sound).map { $0.at + $0.length }.max() ?? 0) * 1000).rounded(.up))
    }
}

/**
 * Whether a sound may play: never in quiet hours (`quietFrom`, `quietTo`, Axis's own rule in `quiet.ts`, read on the
 * Mac's clock), and the task chime and the listening cue only while their settings (`taskChime`, `listenCue`, the
 * boards' keys, declared by this app too) are on.
 */
public enum SoundRules {
    /** Minutes since midnight for "HH:MM", or nil. */
    public static func minutes(_ value: JSONValue?) -> Int? {
        guard let s = value?.stringValue?.trimmingCharacters(in: .whitespaces) else { return nil }
        let parts = s.split(separator: ":")
        guard parts.count == 2, parts[1].count == 2, let h = Int(parts[0]), let m = Int(parts[1]), (0..<24).contains(h), (0..<60).contains(m),
              parts[0].count <= 2 else { return nil }
        return h * 60 + m
    }

    /** Axis's `isQuiet`: both times set and different; the stretch may run over midnight. */
    public static func quiet(_ settings: [String: JSONValue], minuteOfDay now: Int) -> Bool {
        guard let from = minutes(settings["quietFrom"]), let to = minutes(settings["quietTo"]), from != to else { return false }
        return from < to ? now >= from && now < to : now >= from || now < to
    }

    /** A toggle as Axis sends it (true, 1, "1"), else `fallback`. */
    public static func on(_ v: JSONValue?, fallback: Bool) -> Bool {
        switch v {
        case .bool(let b)?: return b
        case .number(let n)?: return n != 0
        case .string(let s)?: return s == "1" || s.lowercased() == "true"
        default: return fallback
        }
    }

    public static func allowed(_ sound: Notices.Sound, settings: [String: JSONValue], minuteOfDay now: Int) -> Bool {
        if quiet(settings, minuteOfDay: now) { return false }
        switch sound {
        case .timer: return true
        case .taskDone: return on(settings["taskChime"], fallback: true)
        case .listening: return on(settings["listenCue"], fallback: true)
        }
    }

    public static func minuteOfDay(_ date: Date = Date(), calendar: Calendar = .current) -> Int {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }
}
