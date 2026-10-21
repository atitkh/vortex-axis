import Foundation

/**
 * The talk key's two uses: held, it talks (the microphone starts at key-down, so nothing said is lost); tapped (let
 * go before `tapMs`), it opens the typing pill and what the microphone heard meanwhile is thrown away.
 */
public enum TapHold {
    /** Let go sooner than this is a tap. */
    public static let tapMs: UInt64 = 220

    public static func isTap(downAt: UInt64, upAt: UInt64) -> Bool { upAt < downAt + tapMs }
}

/**
 * The microphone's frames from key-down until the key is known to be held: kept, at most `maxMs` of them (the oldest
 * dropped first), then sent after the audio.start so the turn starts with the first syllable.
 */
public struct PreRoll: Sendable {
    public static let maxMs = 1000
    public private(set) var frames: [[Int16]] = []
    private var samples = 0
    let limit: Int

    public init(maxMs: Int = PreRoll.maxMs, rate: Int = Voice.micRate) { limit = rate * maxMs / 1000 }

    public mutating func push(_ frame: [Int16]) {
        frames.append(frame)
        samples += frame.count
        while samples > limit, let first = frames.first {
            frames.removeFirst()
            samples -= first.count
        }
    }

    /** What it holds, and empty again. */
    public mutating func take() -> [[Int16]] {
        let all = frames
        clear()
        return all
    }

    public mutating func clear() {
        frames = []
        samples = 0
    }

    public var ms: Int { samples * 1000 / Voice.micRate }
}

/** A typed turn: the `text` message the web client sends (`web/client.js`, protocol `Text`: 1 to 4000 characters). */
public enum TypedText {
    /** Axis's limit, in UTF-16 code units as JavaScript counts a string's length. */
    public static let maxLength = 4000

    /** The text to send, trimmed; nil when there is nothing (or too much: the field never lets more in). */
    public static func clean(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.utf16.count <= maxLength else { return nil }
        return t
    }

    /** At most `maxLength` UTF-16 units, cut on a whole character: what the field keeps of a long paste. */
    public static func clip(_ text: String) -> String {
        guard text.utf16.count > maxLength else { return text }
        var out = ""
        var units = 0
        for ch in text {
            let n = String(ch).utf16.count
            if units + n > maxLength { break }
            out.append(ch)
            units += n
        }
        return out
    }

    public static func message(turnId: String, text: String) -> JSONValue? {
        guard let t = clean(text) else { return nil }
        return ["t": "text", "turnId": .string(turnId), "text": .string(t)]
    }
}

/**
 * The typing pill's size: one line to start, growing to `maxLines`, then the field scrolls. The pill is as wide as
 * `width`; its height is the status line, the field and the padding (and a question with its buttons above the field
 * when one is open), so `PillLayout.place` puts it in the voice pill's slot like any other pill.
 */
public enum TypingLayout {
    public static let width = 440.0
    public static let lineHeight = 17.0
    public static let maxLines = 3
    /** The padding round the words (the voice pill's) and the "Typing" line over the field. */
    public static let padTop = 9.0, padBottom = 10.0, status = 19.0, fieldPad = 8.0
    /** A question's line and its buttons' row. */
    public static let questionLine = 18.0, choicesRow = 32.0

    public static func lines(_ wanted: Int) -> Int { min(max(1, wanted), maxLines) }

    public static func fieldHeight(lines wanted: Int) -> Double { Double(lines(wanted)) * lineHeight + fieldPad }

    public static func height(lines wanted: Int, questionLines: Int = 0, choices: Bool = false) -> Double {
        padTop + status + Double(min(questionLines, 3)) * questionLine + (choices ? choicesRow : 0) + fieldHeight(lines: wanted) + padBottom
    }
}
