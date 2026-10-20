import Foundation

/**
 * The audio formats on the wire and the arithmetic on them, apart from Core Audio so it is tested anywhere: the
 * microphone goes to Axis as 16 kHz mono 16-bit little-endian PCM in frames of about 20 ms (`Voice.micRate`, 320
 * samples, 640 bytes); speech comes back as 16-bit mono little-endian PCM at the rate `speak.start` names (24 kHz
 * when it names none), as the Windows app sends and plays them.
 */
public enum PCM {
    /** Samples in one 20 ms frame at 16 kHz. */
    public static let frameSamples = 320

    /** Samples as little-endian bytes, as Axis takes them. */
    public static func bytes(_ samples: [Int16]) -> Data {
        var data = Data(capacity: samples.count * 2)
        for s in samples {
            let u = UInt16(bitPattern: s)
            data.append(UInt8(truncatingIfNeeded: u))
            data.append(UInt8(truncatingIfNeeded: u >> 8))
        }
        return data
    }

    /** Little-endian bytes as samples; an odd last byte is left out (`ByteCarry` keeps it for the next piece). */
    public static func samples(_ data: Data) -> [Int16] {
        let n = data.count / 2
        var out = [Int16](repeating: 0, count: n)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            for i in 0..<n {
                let lo = UInt16(raw[i * 2]), hi = UInt16(raw[i * 2 + 1])
                out[i] = Int16(bitPattern: lo | hi << 8)
            }
        }
        return out
    }

    /** A sample of -1...1 as 16 bits, clipped, rounded. */
    public static func int16(_ x: Float) -> Int16 {
        guard x.isFinite else { return 0 }
        let clipped = max(-1, min(1, x))
        return Int16((clipped * 32767).rounded())
    }

    /** 16 bits as -1...1 (the full negative range reaches exactly -1). */
    public static func float(_ s: Int16) -> Float { Float(s) / 32768 }

    /** The loudness of samples, 0 to 1 (root mean square of the full scale). */
    public static func rms(_ samples: [Int16]) -> Double {
        guard !samples.isEmpty else { return 0 }
        var energy = 0.0
        for s in samples { energy += Double(s) * Double(s) }
        return (energy / Double(samples.count)).squareRoot() / 32768
    }

    public static func rms(_ samples: UnsafeBufferPointer<Float>) -> Double {
        guard !samples.isEmpty else { return 0 }
        var energy = 0.0
        for s in samples { energy += Double(s) * Double(s) }
        return (energy / Double(samples.count)).squareRoot()
    }

    /** The microphone's level for a meter and the face, 0 to 1: square-root shaped above a small floor (Voice.cs). */
    public static func micLevel(rms: Double) -> Double {
        min(1, max(0, (rms - 0.004) / 0.08).squareRoot())
    }

    /**
     * The speech's level for the face, 0 to 1, from the last one: square-root shaped so ordinary speech fills most of
     * the range, rising at once and falling by `fall` of the way per buffer (the Windows app's `Meter`: 0.6 for its
     * buffers; a smaller buffer wants a slower fall, docs/face.md section 4: about a tenth of a second).
     */
    public static func playLevel(previous: Double, rms: Double, fall: Double = 0.6) -> Double {
        let level = min(1, (max(0, rms) / 0.22).squareRoot())
        return level > previous ? level : previous * fall + level * (1 - fall)
    }

    /** How long `bytes` of 16-bit mono audio at `rate` last, in seconds. */
    public static func seconds(bytes: Int, rate: Int) -> Double {
        rate > 0 ? Double(bytes / 2) / Double(rate) : 0
    }
}

/**
 * Cuts the microphone's samples into frames of exactly `PCM.frameSamples`, keeping what is left over for the next
 * call: Core Audio hands over whatever size it likes, Axis expects about 20 ms at a time.
 */
public struct FrameChunker: Sendable {
    public let size: Int
    private var held: [Int16] = []

    public init(size: Int = PCM.frameSamples) { self.size = size }

    /** The whole frames there are now, in order. */
    public mutating func push(_ samples: [Int16]) -> [[Int16]] {
        held.append(contentsOf: samples)
        var frames: [[Int16]] = []
        var start = 0
        while held.count - start >= size {
            frames.append(Array(held[start..<start + size]))
            start += size
        }
        if start > 0 { held.removeFirst(start) }
        return frames
    }

    /** What is left, under a frame; dropped (a recording's last few milliseconds). */
    public mutating func reset() { held.removeAll() }
    public var waiting: Int { held.count }
}

/** Speech arrives in binary frames that may split a sample across two: an odd byte waits for the next frame. */
public struct ByteCarry: Sendable {
    private var odd: UInt8?
    public init() {}

    /** `data` with the byte left from before in front, an even number of bytes; a new odd byte is kept back. */
    public mutating func whole(_ data: Data) -> Data {
        var all = Data()
        if let o = odd { all.append(o) }
        all.append(data)
        if all.count % 2 == 1 {
            odd = all.last
            all.removeLast()
        } else {
            odd = nil
        }
        return all
    }

    public mutating func reset() { odd = nil }
}
