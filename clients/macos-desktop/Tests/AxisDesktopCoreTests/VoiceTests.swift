import XCTest
@testable import AxisDesktopCore

/** A microphone and speaker that only remember what they were asked. */
final class FakeVoiceIO: VoiceIO, @unchecked Sendable {
    private let lock = NSLock()
    var capturing = false
    var failCapture = false
    var began: [Int] = []
    var written = 0
    var ended: (@Sendable () -> Void)?
    var stops = 0
    var playing = false
    var level = 0.0

    func startCapture(_ frame: @escaping @Sendable ([Int16]) -> Void) throws {
        if failCapture { throw DesktopError("no microphone is connected") }
        lock.withLock { capturing = true }
    }
    func stopCapture() { lock.withLock { capturing = false } }
    func playBegin(sampleRate: Int) { lock.withLock { began.append(sampleRate); playing = true } }
    func playWrite(_ pcm: Data) { lock.withLock { written += pcm.count } }
    func playEnd(_ finished: @escaping @Sendable () -> Void) { lock.withLock { ended = finished } }
    func stopPlayback() -> Bool {
        lock.withLock {
            stops += 1
            let was = playing
            playing = false
            return was
        }
    }
    var playLevel: Double { lock.withLock { level } }

    /** The speakers ran dry: what `playEnd` was given is called. */
    func drain() {
        let f: (@Sendable () -> Void)? = lock.withLock {
            playing = false
            let e = ended
            ended = nil
            return e
        }
        f?()
    }
}

final class FakeClock: @unchecked Sendable {
    var ms: UInt64 = 1000
}

final class Sent: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [VoiceOutgoing] = []
    func put(_ item: VoiceOutgoing) { lock.withLock { items.append(item) } }
    var all: [VoiceOutgoing] { lock.withLock { items } }
    /** Each message's `t`, and "audio" for a frame. */
    var types: [String] {
        all.map { item in
            if case .message(let m) = item { return m["t"]?.stringValue ?? "?" }
            return "audio"
        }
    }
    func last(_ t: String) -> JSONValue? {
        for item in all.reversed() { if case .message(let m) = item, m["t"]?.stringValue == t { return m } }
        return nil
    }
    func clear() { lock.withLock { items.removeAll() } }
}

final class VoiceTests: XCTestCase {
    var io: FakeVoiceIO!
    var clock: FakeClock!
    var sent: Sent!
    var voice: Voice!

    override func setUp() {
        io = FakeVoiceIO()
        clock = FakeClock()
        sent = Sent()
        let c = clock!, s = sent!
        voice = Voice(io: io, out: { s.put($0) }, clock: { c.ms })
    }

    let loud = [Int16](repeating: 3000, count: PCM.frameSamples)
    let quiet = [Int16](repeating: 0, count: PCM.frameSamples)

    func at(_ ms: UInt64, _ samples: [Int16]) {
        clock.ms = 1000 + ms
        voice.frame(samples)
    }

    func testAPressListensAndAPauseSends() throws {
        voice.press()
        XCTAssertEqual(voice.currentMode, .listening)
        XCTAssertTrue(io.capturing)
        let start = try XCTUnwrap(sent.last("audio.start"))
        XCTAssertEqual(start["format"], ["encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1], "16 kHz mono 16-bit, as Windows sends")
        XCTAssertEqual(start["trigger"], "tap")
        XCTAssertTrue(start["turnId"]?.stringValue?.hasPrefix("pc-") == true)
        at(100, loud)
        at(200, quiet)
        at(1300, quiet)
        XCTAssertEqual(voice.currentMode, .listening, "1.1 s of quiet is not yet a pause")
        at(1500, quiet)
        XCTAssertEqual(sent.types, ["audio.start", "audio", "audio", "audio", "audio", "audio.end"])
        XCTAssertEqual(sent.last("audio.end")?["reason"], "silence")
        XCTAssertEqual(sent.last("audio.end")?["turnId"], start["turnId"])
        XCTAssertEqual(voice.currentMode, .transcribing)
        XCTAssertFalse(io.capturing)
        if case .audio(let pcm) = sent.all[1] { XCTAssertEqual(pcm.count, 640, "20 ms of 16-bit samples") } else { XCTFail("a frame") }
    }

    func testNothingSaidIsDropped() {
        voice.press()
        at(5900, quiet)
        XCTAssertEqual(voice.currentMode, .listening)
        at(6100, quiet)
        XCTAssertEqual(sent.last("audio.end")?["reason"], "cancel")
        XCTAssertEqual(voice.currentMode, .idle)
    }

    func testThirtySecondsIsTheMost() {
        voice.press()
        voice.hold()
        at(29000, loud)
        at(30100, loud)
        XCTAssertEqual(sent.last("audio.end")?["reason"], "max")
    }

    func testAHoldListensUntilLetGo() {
        voice.press()
        voice.hold()
        at(100, loud)
        at(200, quiet)
        at(3000, quiet)
        XCTAssertEqual(voice.currentMode, .listening, "a pause does not end a hold")
        voice.release()
        XCTAssertEqual(sent.last("audio.end")?["reason"], "silence")
    }

    func testAShortSilentHoldIsCancelled() {
        voice.press()
        voice.hold()
        at(500, quiet)
        voice.release()
        XCTAssertEqual(sent.last("audio.end")?["reason"], "cancel")
        XCTAssertEqual(voice.currentMode, .idle)
    }

    func testASecondPressFinishes() {
        voice.press()
        at(100, loud)
        voice.press()
        XCTAssertEqual(sent.last("audio.end")?["reason"], "silence")
    }

    func testSpeechIsPlayedAndReported() {
        voice.handle("speak.start", ["t": "speak.start", "turnId": "t1", "format": ["sampleRate": 22050]])
        XCTAssertEqual(io.began, [22050])
        XCTAssertEqual(sent.last("playback")?["state"], "started")
        XCTAssertEqual(voice.currentMode, .speaking)
        voice.audio(Data(count: 960))
        XCTAssertEqual(io.written, 960)
        voice.handle("speak.end", ["t": "speak.end", "turnId": "t1"])
        XCTAssertEqual(voice.currentMode, .speaking, "speaking until the last of it is heard")
        io.drain()
        XCTAssertEqual(sent.last("playback")?["state"], "finished")
        XCTAssertEqual(voice.currentMode, .idle)
        voice.audio(Data(count: 10))
        XCTAssertEqual(io.written, 960, "audio after the stretch is not played")
    }

    func testTheRateIs24kHzWhenNotSaid() {
        voice.handle("speak.start", ["t": "speak.start", "turnId": "t1"])
        XCTAssertEqual(io.began, [24000])
    }

    func testSpeechDuringARecordingEndsItFirst() {
        voice.press()
        at(100, loud)
        sent.clear()
        voice.handle("speak.start", ["t": "speak.start", "turnId": "say-1"])
        XCTAssertEqual(sent.types, ["audio.end", "playback"], "theirs comes first, then the speech")
        XCTAssertFalse(io.capturing, "the microphone never listens while it speaks (no echo canceller)")
    }

    func testAPressWhileSpeakingStopsIt() {
        voice.handle("speak.start", ["t": "speak.start", "turnId": "t1"])
        sent.clear()
        voice.press()
        XCTAssertEqual(sent.types, ["playback", "interrupt"])
        XCTAssertEqual(sent.last("playback")?["state"], "stopped")
        XCTAssertEqual(voice.currentMode, .idle)
        XCTAssertFalse(io.capturing, "a press while it speaks stops it, it does not listen")
    }

    func testAPressWhileThinkingInterrupts() {
        voice.handle("turn", ["t": "turn", "turnId": "t1", "state": "thinking"])
        voice.press()
        XCTAssertEqual(sent.types, ["interrupt"])
    }

    func testStopFromAxis() {
        voice.handle("speak.start", ["t": "speak.start", "turnId": "t1"])
        voice.handle("stop", ["t": "stop"])
        XCTAssertEqual(sent.last("playback")?["state"], "stopped")
        XCTAssertEqual(voice.currentMode, .idle)
    }

    func testAQuestionAndItsAnswer() throws {
        voice.handle("ask", ["t": "ask", "askId": "a1", "question": "Allow the click on Send?", "choices": ["Allow", "Deny", ""]])
        XCTAssertEqual(voice.snapshot.question, "Allow the click on Send?")
        XCTAssertEqual(voice.snapshot.choices, ["Allow", "Deny"])
        voice.press()
        XCTAssertEqual(sent.last("audio.start")?["trigger"], "question", "a spoken answer")
        voice.interrupt()
        sent.clear()
        voice.answer("Maybe")
        XCTAssertEqual(sent.types, [], "only one of its choices")
        voice.answer("Deny")
        let answer = try XCTUnwrap(sent.last("answer"))
        XCTAssertEqual(answer["askId"], "a1")
        XCTAssertEqual(answer["choice"], "Deny")
        XCTAssertNil(voice.snapshot.question)
    }

    func testAQuestionTakenBack() {
        voice.handle("ask", ["t": "ask", "askId": "a1", "question": "Q", "choices": ["Yes"]])
        voice.handle("ask.end", ["t": "ask.end", "askId": "other"])
        XCTAssertEqual(voice.snapshot.question, "Q", "another question's end")
        voice.handle("ask.end", ["t": "ask.end", "askId": "a1"])
        XCTAssertNil(voice.snapshot.question)
    }

    func testTurnsWordsAndDoing() {
        voice.handle("turn", ["t": "turn", "turnId": "t1", "state": "listening"])
        XCTAssertEqual(voice.currentMode, .idle, "listening is the Mac's own to show")
        voice.handle("turn", ["t": "turn", "turnId": "t1", "state": "thinking", "doing": "search"])
        XCTAssertEqual(voice.snapshot.doing, "search")
        voice.handle("turn", ["t": "turn", "turnId": "t1", "state": "thinking", "doing": "none"])
        XCTAssertNil(voice.snapshot.doing)
        voice.handle("transcript", ["t": "transcript", "text": "what time is it"])
        voice.handle("reply.text", ["t": "reply.text", "turnId": "t1", "text": "It is "])
        voice.handle("reply.text", ["t": "reply.text", "turnId": "t1", "text": "noon."])
        XCTAssertEqual(voice.snapshot.heard, "what time is it")
        XCTAssertEqual(voice.snapshot.reply, "It is noon.")
        voice.handle("reply.text", ["t": "reply.text", "turnId": "say-2", "text": "Timer done.", "final": true])
        XCTAssertEqual(voice.snapshot.reply, "Timer done.", "another turn's words start afresh")
        voice.handle("turn", ["t": "turn", "turnId": "t1", "state": "error", "detail": "the agent is not answering"])
        XCTAssertEqual(voice.currentMode, .error)
        XCTAssertEqual(voice.snapshot.reply, "the agent is not answering")
    }

    func testIdleWhilePlayingStaysSpeaking() {
        voice.handle("speak.start", ["t": "speak.start", "turnId": "t1"])
        voice.handle("turn", ["t": "turn", "turnId": "t1", "state": "idle"])
        XCTAssertEqual(voice.currentMode, .speaking)
    }

    func testALostLinkLetsGo() {
        voice.handle("ask", ["t": "ask", "askId": "a1", "question": "Q", "choices": ["Yes"]])
        voice.handle("speak.start", ["t": "speak.start", "turnId": "t1"])
        voice.linkChanged(online: false)
        XCTAssertEqual(voice.currentMode, .idle)
        XCTAssertNil(voice.snapshot.question)
        XCTAssertFalse(io.playing)
    }

    func testAMicrophoneThatWillNotStart() {
        io.failCapture = true
        voice.press()
        XCTAssertEqual(sent.types, ["audio.start", "audio.end"])
        XCTAssertEqual(sent.last("audio.end")?["reason"], "cancel")
        XCTAssertEqual(voice.currentMode, .error)
        XCTAssertTrue(voice.snapshot.reply.contains("no microphone"))
    }

    func testLoudnessFollowsWhoIsTalking() {
        XCTAssertEqual(voice.loudness, -1)
        voice.press()
        at(100, loud)
        XCTAssertGreaterThan(voice.loudness, 0.5, "the person's voice while listening")
        voice.interrupt()
        voice.handle("speak.start", ["t": "speak.start", "turnId": "t1"])
        io.level = 0.7
        XCTAssertEqual(voice.loudness, 0.7, "the agent's while it speaks")
    }

    func testTheOutboxKeepsTheOrder() async {
        let got = Sent()
        let done = expectation(description: "all sent")
        let outbox = Outbox { item in
            // Later items finish sooner if they ran side by side: the order must still hold.
            if case .message = item { try? await Task.sleep(nanoseconds: 2_000_000) }
            got.put(item)
            if got.all.count == 4 { done.fulfill() }
        }
        outbox.put(.message(["t": "audio.start"]))
        outbox.put(.audio(Data([1, 2])))
        outbox.put(.audio(Data([3, 4])))
        outbox.put(.message(["t": "audio.end"]))
        await fulfillment(of: [done], timeout: 2)
        XCTAssertEqual(got.types, ["audio.start", "audio", "audio", "audio.end"])
    }
}

final class TalkKeyTests: XCTestCase {
    func testReadingKeys() {
        XCTAssertEqual(TalkKey.parse("ctrl+option+space"), TalkKey.standard)
        XCTAssertEqual(TalkKey.parse("ctrl+alt+space"), TalkKey.standard, "the Windows app's id")
        XCTAssertEqual(TalkKey.parse("⌃⌥Space"), TalkKey.standard, "as macOS writes it")
        XCTAssertEqual(TalkKey.parse(" Control + Option + V "), TalkKey(ctrl: true, option: true, key: "v"))
        XCTAssertEqual(TalkKey.parse("cmd+shift+return"), TalkKey(shift: true, cmd: true, key: "enter"))
        XCTAssertEqual(TalkKey.parse("f5"), TalkKey(key: "f5"))
        XCTAssertEqual(TalkKey.parse("globe"), TalkKey(key: "fn"))
        XCTAssertNil(TalkKey.parse("ctrl+fn"), "Fn is held alone")
        XCTAssertNil(TalkKey.parse("hyper+space"))
        XCTAssertNil(TalkKey.parse("ctrl+option+nosuchkey"))
        XCTAssertNil(TalkKey.parse(""))
    }

    func testWritingKeys() {
        XCTAssertEqual(TalkKey.standard.description, "ctrl+option+space")
        XCTAssertEqual(TalkKey.standard.label, "⌃⌥Space")
        XCTAssertEqual(TalkKey(shift: true, cmd: true, key: "k").label, "⇧⌘K")
        XCTAssertEqual(TalkKey(key: "f5").label, "F5")
        XCTAssertEqual(TalkKey(key: "fn").label, "Fn (Globe)")
        for k in TalkKey.presets { XCTAssertEqual(TalkKey.parse(k.description), k, "a saved key reads back as itself") }
    }

    func testKeysThatCannotBeTheTalkKey() {
        XCTAssertNotNil(TalkKey(key: "space").refused(), "it would swallow typing")
        XCTAssertNotNil(TalkKey(shift: true, key: "a").refused())
        XCTAssertNotNil(TalkKey(cmd: true, key: "space").refused(), "Spotlight")
        XCTAssertNotNil(TalkKey(ctrl: true, key: "space").refused(), "input sources")
        XCTAssertNotNil(TalkKey(cmd: true, key: "q").refused())
        XCTAssertNil(TalkKey(key: "f5").refused())
        for k in TalkKey.presets { XCTAssertNil(k.refused(), k.label) }
        XCTAssertEqual(TalkKey.saved("cmd+space"), TalkKey.standard, "a saved key that cannot be used falls back")
        XCTAssertEqual(TalkKey.saved(nil), TalkKey.standard)
        XCTAssertEqual(TalkKey.saved("ctrl+shift+space"), TalkKey(ctrl: true, shift: true, key: "space"))
    }
}

final class PCMTests: XCTestCase {
    func testLittleEndianBothWays() {
        let samples: [Int16] = [0, 1, -1, 32767, -32768, 0x1234]
        let bytes = PCM.bytes(samples)
        XCTAssertEqual(Array(bytes), [0, 0, 1, 0, 0xFF, 0xFF, 0xFF, 0x7F, 0x00, 0x80, 0x34, 0x12])
        XCTAssertEqual(PCM.samples(bytes), samples)
        XCTAssertEqual(PCM.samples(Data([1, 0, 7])), [1], "an odd last byte waits")
    }

    func testFloatsAndClipping() {
        XCTAssertEqual(PCM.int16(0), 0)
        XCTAssertEqual(PCM.int16(1), 32767)
        XCTAssertEqual(PCM.int16(-1), -32767)
        XCTAssertEqual(PCM.int16(3.5), 32767, "clipped")
        XCTAssertEqual(PCM.int16(-7), -32767)
        XCTAssertEqual(PCM.int16(.nan), 0)
        XCTAssertEqual(PCM.float(-32768), -1)
        XCTAssertEqual(PCM.float(16384), 0.5)
    }

    func testLevels() {
        XCTAssertEqual(PCM.rms([Int16](repeating: 0, count: 10)), 0)
        XCTAssertEqual(PCM.rms([16384, -16384]), 0.5, accuracy: 1e-9)
        XCTAssertEqual(PCM.micLevel(rms: 0.003), 0, "under the floor")
        XCTAssertEqual(PCM.micLevel(rms: 0.084), 1, accuracy: 1e-9)
        XCTAssertEqual(PCM.micLevel(rms: 0.5), 1, "never more than 1")
        let up = PCM.playLevel(previous: 0, rms: 0.22)
        XCTAssertEqual(up, 1, accuracy: 1e-9, "rises at once")
        XCTAssertEqual(PCM.playLevel(previous: up, rms: 0), 0.6, accuracy: 1e-9, "falls by 0.6 (Windows' Meter)")
        XCTAssertEqual(PCM.playLevel(previous: 1, rms: 0, fall: 0.8), 0.8, accuracy: 1e-9)
        XCTAssertEqual(PCM.seconds(bytes: 48000, rate: 24000), 1)
    }

    func testFramesOf20ms() {
        var chunker = FrameChunker()
        XCTAssertEqual(chunker.push([Int16](repeating: 1, count: 300)).count, 0)
        let frames = chunker.push([Int16](repeating: 2, count: 700))
        XCTAssertEqual(frames.count, 3, "1000 samples: three whole frames")
        XCTAssertTrue(frames.allSatisfy { $0.count == PCM.frameSamples })
        XCTAssertEqual(frames[0].first, 1)
        XCTAssertEqual(frames[0].last, 2, "the frames run on across pushes")
        XCTAssertEqual(chunker.waiting, 40)
        chunker.reset()
        XCTAssertEqual(chunker.waiting, 0)
    }

    func testAnOddByteWaitsForTheNextFrame() {
        var carry = ByteCarry()
        XCTAssertEqual(Array(carry.whole(Data([1, 2, 3]))), [1, 2])
        XCTAssertEqual(Array(carry.whole(Data([4, 5, 6]))), [3, 4, 5, 6])
        XCTAssertEqual(Array(carry.whole(Data([7]))), [])
        carry.reset()
        XCTAssertEqual(Array(carry.whole(Data([8, 9]))), [8, 9])
    }
}
