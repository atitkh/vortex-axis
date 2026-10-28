import Foundation

/**
 * The microphone, opened and closed away from the caller's thread (the Windows app's `WarmMic`): starting an
 * `AVAudioEngine` can take seconds (a Bluetooth headset switching to its headset profile, a device waking up), and
 * the talk key's handler runs on the main thread. Every open and close runs in order on one serial queue (`run`). Let
 * go, it stays on for `graceMs` so a quick second press starts at once, then closes; `release(now: true)` closes it
 * at once (speech about to play, sleep, the microphone switched off).
 */
public final class WarmMic: @unchecked Sendable {
    public static let graceMs = 3000

    private let io: VoiceIO
    private let lock = NSLock()
    private var wanted = false, open = false
    private var generation = 0
    private let queue = DispatchQueue(label: "VorteX Axis microphone opener", qos: .userInitiated)

    /** Where the microphone's frames go (the voice part sets it once). */
    var frame: (@Sendable ([Int16]) -> Void)?
    /** Runs work in order, off the caller's thread. The checks run it inline. */
    public var run: (@escaping @Sendable () -> Void) -> Void
    /** Runs work after so many milliseconds (on `run`). The checks keep it to fire by hand. */
    public var after: (Int, @escaping @Sendable () -> Void) -> Void
    /** The microphone is on for a request (`warm`: it already was). On the worker. */
    var onOpened: (@Sendable (Bool) -> Void)?
    /** The microphone could not open for a request still wanted. On the worker. */
    var onFailed: (@Sendable (Error) -> Void)?

    init(io: VoiceIO) {
        self.io = io
        let queue = self.queue
        run = { work in queue.async(execute: work) }
        after = { ms, work in queue.asyncAfter(deadline: .now() + .milliseconds(ms), execute: work) }
    }

    public var isOpen: Bool { lock.withLock { open } }

    /** The microphone is needed now: opened (or kept, if still warm). Returns at once. */
    func want() {
        lock.withLock {
            wanted = true
            generation += 1
        }
        run { [weak self] in self?.settle() }
    }

    /** Not needed any more: closed after the grace, or at once. */
    func release(now: Bool = false) {
        let mine: Int? = lock.withLock {
            if !wanted && !now { return nil }
            wanted = false
            generation += 1
            return generation
        }
        guard let mine else { return }
        if now {
            run { [weak self] in self?.settle() }
        } else {
            after(Self.graceMs) { [weak self] in
                guard let self, self.lock.withLock({ mine == self.generation }) else { return }
                self.settle()
            }
        }
    }

    /** Brings the device to what is wanted (on the worker). */
    private func settle() {
        let (want, isOpen) = lock.withLock { (wanted, open) }
        if want && isOpen {
            onOpened?(true)
            return
        }
        if want {
            let frame = self.frame
            do {
                try io.startCapture { samples in frame?(samples) }
            } catch {
                if lock.withLock({ wanted }) { onFailed?(error) }
                return
            }
            lock.withLock { open = true }
            onOpened?(false)
            // Let go while it was opening: the grace (or a close at once) is already on its way.
            return
        }
        guard isOpen else { return }
        lock.withLock { open = false }
        io.stopCapture()
    }
}

/**
 * How long the talk key took, from the key's event to the handler, the microphone on, its first audio and the
 * listening (or typing) pill on screen; one line per press for the app's Recently list (the Windows app's
 * `TalkTiming`). Milliseconds of the voice part's clock.
 */
public final class TalkTiming: @unchecked Sendable {
    private let lock = NSLock()
    private var key: UInt64?
    private var handler: UInt64 = 0
    private var mic: UInt64?, audio: UInt64?, shown: UInt64?
    private var warm = false
    private var what = "", failed = ""

    /** A finished measurement, as a line. On whichever thread finished it. */
    public var onMeasured: (@Sendable (String) -> Void)?

    public init() {}

    /** The key went down at `keyAt` (its event) and the handler ran at `handlerAt`. Reports a previous one left open. */
    public func begin(keyAt: UInt64, handlerAt: UInt64) {
        let left: String? = lock.withLock {
            let left = key != nil ? lineLocked() : nil
            key = keyAt
            handler = max(keyAt, handlerAt)
            mic = nil
            audio = nil
            shown = nil
            warm = false
            what = ""
            failed = ""
            return left
        }
        if let left { onMeasured?(left) }
    }

    public func mic(at: UInt64, warm wasWarm: Bool) { mark { if self.mic == nil { self.mic = at; self.warm = wasWarm } } }
    public func failed(at: UInt64, _ why: String) { mark { if self.mic == nil && self.failed.isEmpty { self.mic = at; self.failed = why } } }
    public func audio(at: UInt64) { mark { if self.audio == nil { self.audio = at } } }
    /** `listening` or `typing` is on the screen. */
    public func shown(at: UInt64, _ kind: String) { mark { if self.shown == nil { self.shown = at; self.what = kind } } }

    private func mark(_ set: () -> Void) {
        let done: String? = lock.withLock {
            guard key != nil else { return nil }
            set()
            guard shown != nil, audio != nil || !failed.isEmpty else { return nil }
            let line = lineLocked()
            key = nil
            return line
        }
        if let done { onMeasured?(done) }
    }

    private func lineLocked() -> String {
        let start = key ?? 0
        func at(_ t: UInt64?) -> String { t.map { "+\($0 >= start ? $0 - start : 0) ms" } ?? "never" }
        let micPart = failed.isEmpty ? "mic \(warm ? "warm" : "open") \(at(mic))" : "mic failed \(at(mic)) (\(failed))"
        return "Talk key: handler \(at(handler)), \(micPart), first audio \(at(audio)), \(what.isEmpty ? "pill" : what) shown \(at(shown))"
    }

    public static func isLine(_ text: String) -> Bool { text.contains("Talk key: handler ") }
}
