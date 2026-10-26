import XCTest
@testable import AxisDesktopCore

/** A value a test's @Sendable closure may change. */
final class Shared<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

/** 0.4.0: the long-task line, the timer countdown, the sounds, typing to the agent and hold-or-tap on the talk key. */
final class NoticesTests: XCTestCase {
    /** What Axis's `progress.ts` sends for "Backup, 3 of 5, deploying" with two other tasks. */
    let backup: JSONValue = [
        "title": "Backup", "note": "deploying", "done": 3, "total": 5, "state": "running", "count": 3,
        "steps": "xcopy\nxcheck\nxpack\n>deploy\n-tidy", "others": "!Mail: needs you\n Build 1/4",
    ]

    func testATaskLineIsReadAsTheWebReadsIt() {
        let t = TaskLine.of(backup)
        XCTAssertEqual(t.title, "Backup")
        XCTAssertEqual(t.done, 3)
        XCTAssertEqual(t.total, 5)
        XCTAssertEqual(t.state, .running)
        XCTAssertEqual(t.steps.map(\.state), [.done, .done, .done, .running, .pending])
        XCTAssertEqual(t.steps.map(\.text), ["copy", "check", "pack", "deploy", "tidy"])
        XCTAssertEqual(t.others, [.init(needsYou: true, text: "Mail: needs you"), .init(needsYou: false, text: "Build 1/4")])
        XCTAssertEqual(t.fraction, 0.6)
        XCTAssertTrue(t.shows)
        // None: Axis's "nothing to show".
        let none = TaskLine.of(["title": "", "note": "", "done": -1, "total": 0, "state": "none", "count": 0])
        XCTAssertFalse(none.shows)
        XCTAssertNil(none.fraction)
        // Done: a full bar even without steps.
        XCTAssertEqual(TaskLine.of(["title": "Sync", "state": "done", "count": 1, "total": 0, "done": -1]).fraction, 1)
    }

    func testTheTaskPillsWords() throws {
        let w = try XCTUnwrap(TaskPillWords.of(TaskLine.of(backup)))
        XCTAssertEqual(w.title, "Backup")
        XCTAssertEqual(w.detail, "3/5 · deploying")
        XCTAssertEqual(w.more, "+2")
        XCTAssertEqual(w.tint, .task)
        XCTAssertFalse(w.dismissible)
        XCTAssertEqual(w.rows.map(\.kind), [.needsYou, .task, .done, .done, .done, .running, .pending], "the other tasks, then the steps")
        let blocked = try XCTUnwrap(TaskPillWords.of(TaskLine.of(["title": "Mail", "note": "which account?", "state": "blocked", "count": 1])))
        XCTAssertEqual(blocked.detail, "needs you: which account?")
        XCTAssertEqual(blocked.tint, .needsYou)
        XCTAssertNil(blocked.fraction)
        let done = try XCTUnwrap(TaskPillWords.of(TaskLine.of(["title": "Backup", "state": "done", "done": 5, "total": 5, "count": 1])))
        XCTAssertEqual(done.detail, "done")
        XCTAssertEqual(done.tint, .done)
        XCTAssertTrue(done.dismissible, "a finished task can be put away")
        XCTAssertNil(TaskPillWords.of(.none))
    }

    func testALongListIsClipped() throws {
        let steps = (1...12).map { "-step \($0)" }.joined(separator: "\n")
        let w = try XCTUnwrap(TaskPillWords.of(TaskLine.of(["title": "Big", "state": "running", "count": 1, "total": 12, "done": 0, "steps": .string(steps)])))
        XCTAssertEqual(w.rows.count, TaskPillWords.maxRows)
        XCTAssertEqual(w.rows.last?.text, "… 5 more")
    }

    func testAFinishedTaskLeavesAfter90sOrWhenPutAway() {
        let clock = FakeClock()
        let n = Notices(clock: { clock.ms })
        let sent = Sent()
        n.send = { sent.put(.message($0)) }
        let chimes = Shared<[Notices.Sound]>([])
        n.onChime = { chimes.value.append($0); return true }
        XCTAssertEqual(n.handle("progress.show", backup), .done())
        XCTAssertEqual(n.task.title, "Backup")
        XCTAssertEqual(n.handle("progress.show", ["title": "Backup", "state": "done", "count": 1, "chime": true]), .done())
        XCTAssertEqual(chimes.value, [.taskDone], "the chime Axis asks for (it never asks in quiet hours)")
        clock.ms += 89_000
        // Told again (another task's word): the 90 s still count from when it finished.
        _ = n.handle("progress.show", ["title": "Backup", "state": "done", "count": 1])
        XCTAssertEqual(n.task.state, .done)
        clock.ms += 2_000
        XCTAssertFalse(n.task.shows, "done leaves after 90 s, as on the boards")
        // Put away by hand: gone here, and Axis is told as by a swipe down on a board.
        _ = n.handle("progress.show", ["title": "Sync", "state": "done", "count": 1])
        n.dismissDone()
        XCTAssertFalse(n.task.shows)
        XCTAssertEqual(sent.last("gesture")?["gesture"], "swipe_down")
        // A task under way is not put away.
        sent.clear()
        _ = n.handle("progress.show", backup)
        n.dismissDone()
        XCTAssertTrue(n.task.shows)
        XCTAssertTrue(sent.all.isEmpty)
    }

    func testTheTimerCountsDown() throws {
        let clock = FakeClock()
        let n = Notices(clock: { clock.ms })
        XCTAssertEqual(n.handle("timer.next", ["label": "Tea", "ms": 245_000, "count": 2, "id": 7]), .done())
        let t = try XCTUnwrap(n.timer)
        XCTAssertEqual(t.id, 7)
        XCTAssertEqual(TimerPillWords.of(t, now: clock.ms), TimerPillWords(label: "Tea", clock: "4:05 +1", tint: .timer, cancellable: true))
        clock.ms += 236_000
        XCTAssertEqual(TimerPillWords.of(t, now: clock.ms).tint, .error, "red in the last 10 s")
        XCTAssertEqual(TimerPillWords.of(t, now: clock.ms).clock, "0:09 +1")
        clock.ms += 10_000
        XCTAssertFalse(TimerPillWords.of(t, now: clock.ms).cancellable, "nothing to cancel at 0:00; Axis rings it")
        clock.ms += Notices.rungShownMs
        XCTAssertNil(n.timer, "let go if Axis never sends the next")
        // No timer.
        _ = n.handle("timer.next", ["label": "", "ms": 0, "count": 0])
        XCTAssertNil(n.timer)
        XCTAssertEqual(NextTimer.clock(3729), "1:02:09")
        XCTAssertEqual(NextTimer.clock(59), "0:59")
        // An older Axis says no id: no cancel.
        let old = try XCTUnwrap(NextTimer.of(["label": "", "ms": 5000, "count": 1], now: 0))
        XCTAssertEqual(TimerPillWords.of(old, now: 0).label, "Timer")
        XCTAssertFalse(TimerPillWords.of(old, now: 0).cancellable)
    }

    func testTheChimeIsAnsweredOnlyWhenPlayed() {
        let n = Notices(clock: { 0 })
        let allowed = Shared(true)
        n.onChime = { _ in allowed.value }
        XCTAssertTrue(n.handle("chime", [:]).ok)
        allowed.value = false
        XCTAssertFalse(n.handle("chime", [:]).ok, "quiet: Axis then does not wait for it before speaking")
        XCTAssertEqual(n.handle("desktop.look", [:]).error, "not implemented on this device")
        // Quiet hours: nothing is played, whatever the speaker could do.
        allowed.value = true
        let night = Notices(clock: { 0 }, minuteOfDay: { 23 * 60 })
        let played = Shared(0)
        night.onChime = { _ in played.value += 1; return true }
        night.useSettings(["quietFrom": "22:00", "quietTo": "07:00"])
        XCTAssertFalse(night.handle("chime", [:]).ok)
        _ = night.handle("progress.show", ["title": "Backup", "state": "done", "count": 1, "chime": true])
        XCTAssertFalse(night.play(.listening))
        XCTAssertEqual(played.value, 0)
        night.useSettings(["taskChime": "0"])
        XCTAssertTrue(night.handle("chime", [:]).ok, "out of quiet hours the timer's chime rings")
        XCTAssertFalse(night.play(.taskDone), "the task chime switched off")
        XCTAssertEqual(played.value, 1)
        XCTAssertEqual(Notices.commands, ["progress.show", "timer.next", "chime", "ask.waiting"])
    }

    func testQuestionsWaitingElsewhere() throws {
        let n = Notices(clock: { 0 })
        XCTAssertEqual(n.asksElsewhere, 0)
        XCTAssertEqual(n.handle("ask.waiting", ["elsewhere": 2]), .done())
        XCTAssertEqual(n.asksElsewhere, 2)
        XCTAssertNil(TaskPillWords.of(.none, elsewhere: 0), "nothing to show")
        let alone = try XCTUnwrap(TaskPillWords.of(.none, elsewhere: 1))
        XCTAssertEqual(alone.title, "A question waits for you elsewhere")
        XCTAssertEqual(alone.tint, .question)
        let under = try XCTUnwrap(TaskPillWords.of(TaskLine.of(["title": "Backup", "state": "running", "count": 1]), elsewhere: 2))
        XCTAssertEqual(under.title, "Backup")
        XCTAssertEqual(under.waiting, "2 questions wait for you elsewhere")
        _ = n.handle("ask.waiting", ["elsewhere": 0])
        XCTAssertEqual(n.asksElsewhere, 0, "cleared at 0")
        _ = n.handle("ask.waiting", ["elsewhere": 3])
        n.linkChanged(online: false)
        XCTAssertEqual(n.asksElsewhere, 0, "forgotten when the link drops (Axis sends it again)")
    }

    func testTheCancelRequest() throws {
        let address = try AxisAddress.parse("192.168.1.20:8440")
        let r = AxisLink.cancelTimerRequest(address: address, pairing: Pairing(address: "192.168.1.20:8440", clientId: "c1", token: "tok", name: "Mac"), id: 7)
        XCTAssertEqual(r.url?.absoluteString, "http://192.168.1.20:8440/v1/timers/cancel")
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-Axis-Client"), "c1")
        XCTAssertEqual(try JSONValue.parse(XCTUnwrap(r.httpBody)), ["id": 7])
        XCTAssertEqual(address.http("/v1/media/abc")?.absoluteString, "http://192.168.1.20:8440/v1/media/abc")
        XCTAssertEqual(address.http("https://x.org/p.png")?.absoluteString, "https://x.org/p.png")
        XCTAssertNil(address.http("media/abc"))
    }
}

final class SoundTests: XCTestCase {
    func testEnvelopesStartAndEndInSilence() {
        for sound in [Notices.Sound.timer, .taskDone, .listening] {
            let s = Sounds.samples(sound)
            XCTAssertEqual(s, Sounds.render(Sounds.notes(sound)))
            XCTAssertFalse(s.isEmpty)
            XCTAssertEqual(s.count, Int((Double(Sounds.lengthMs(sound)) / 1000 * Sounds.rate).rounded(.up)), accuracy: 50)
            XCTAssertLessThan(abs(s.first!), 0.01, "\(sound): no click at the start")
            XCTAssertLessThan(abs(s.last!), 0.001, "\(sound): none at the end")
            XCTAssertLessThanOrEqual(s.map { abs($0) }.max()!, 0.95)
            XCTAssertGreaterThan(s.map { abs($0) }.max()!, 0.05, "\(sound): audible")
        }
        XCTAssertEqual(Sounds.lengthMs(.taskDone), 660, "the web client's two notes: 0.16 s apart, half a second each")
        XCTAssertLessThan(Sounds.lengthMs(.listening), 200, "the cue is short")
    }

    func testTheEnvelopeRisesThenFalls() {
        let n = Sounds.Note(hz: 440, at: 0, peak: 0.12, attack: 0.02, length: 0.5)
        XCTAssertEqual(Sounds.envelope(n, 0), 0)
        XCTAssertEqual(Sounds.envelope(n, 0.01), 0.06, accuracy: 1e-9)
        XCTAssertEqual(Sounds.envelope(n, 0.02), 0.12, accuracy: 1e-9)
        XCTAssertGreaterThan(Sounds.envelope(n, 0.1), Sounds.envelope(n, 0.3))
        XCTAssertEqual(Sounds.envelope(n, 0.5), 0)
        XCTAssertEqual(Sounds.envelope(n, -0.1), 0)
        XCTAssertEqual(Sounds.envelope(n, 0.6), 0)
    }

    func testQuietHoursAndTheSwitches() {
        let night: [String: JSONValue] = ["quietFrom": "22:30", "quietTo": "07:00"]
        XCTAssertTrue(SoundRules.quiet(night, minuteOfDay: 23 * 60))
        XCTAssertTrue(SoundRules.quiet(night, minuteOfDay: 6 * 60 + 59))
        XCTAssertFalse(SoundRules.quiet(night, minuteOfDay: 7 * 60))
        XCTAssertFalse(SoundRules.quiet(night, minuteOfDay: 12 * 60))
        let day: [String: JSONValue] = ["quietFrom": "13:00", "quietTo": "14:00"]
        XCTAssertTrue(SoundRules.quiet(day, minuteOfDay: 13 * 60 + 30))
        XCTAssertFalse(SoundRules.quiet(day, minuteOfDay: 14 * 60))
        XCTAssertFalse(SoundRules.quiet(["quietFrom": "08:00", "quietTo": "08:00"], minuteOfDay: 8 * 60))
        XCTAssertFalse(SoundRules.quiet(["quietFrom": "", "quietTo": "07:00"], minuteOfDay: 0))
        XCTAssertFalse(SoundRules.quiet(["quietFrom": "25:00", "quietTo": "07:00"], minuteOfDay: 0))
        for sound in [Notices.Sound.timer, .taskDone, .listening] {
            XCTAssertFalse(SoundRules.allowed(sound, settings: night, minuteOfDay: 0), "never in quiet hours")
            XCTAssertTrue(SoundRules.allowed(sound, settings: [:], minuteOfDay: 0), "on unless switched off")
        }
        XCTAssertFalse(SoundRules.allowed(.taskDone, settings: ["taskChime": false], minuteOfDay: 0))
        XCTAssertFalse(SoundRules.allowed(.listening, settings: ["listenCue": "0"], minuteOfDay: 0))
        XCTAssertTrue(SoundRules.allowed(.timer, settings: ["taskChime": false, "listenCue": false], minuteOfDay: 0))
    }
}

final class TypingTests: XCTestCase {
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

    func testTapOrHold() {
        XCTAssertTrue(TapHold.isTap(downAt: 1000, upAt: 1219))
        XCTAssertFalse(TapHold.isTap(downAt: 1000, upAt: 1220))
    }

    /** Held: the microphone ran from key-down, and what it heard before the hold was known is sent first. */
    func testAHoldSendsThePreRoll() throws {
        XCTAssertEqual(voice.keyDown(), .waiting)
        XCTAssertTrue(io.capturing, "listening from key-down")
        XCTAssertTrue(sent.all.isEmpty, "nothing sent before it is known to be a hold")
        for i in 0..<10 { clock.ms += 20; voice.frame(i < 5 ? loud : quiet) }
        XCTAssertTrue(sent.all.isEmpty)
        voice.keyHeld()
        XCTAssertEqual(voice.currentMode, .listening)
        let start = try XCTUnwrap(sent.last("audio.start"))
        XCTAssertEqual(start["trigger"], "hold")
        XCTAssertEqual(sent.types, ["audio.start"] + Array(repeating: "audio", count: 10), "the first syllable is not lost")
        clock.ms += 3000
        voice.frame(quiet)
        XCTAssertEqual(voice.currentMode, .listening, "a pause does not end a hold")
        XCTAssertEqual(voice.keyUp(), .released)
        XCTAssertEqual(sent.last("audio.end")?["reason"], "silence")
        XCTAssertFalse(io.capturing)
    }

    /** Tapped: nothing goes to Axis and the microphone stops; the app opens the typing pill. */
    func testATapDropsWhatWasHeard() {
        let listened = Shared(0)
        voice.onListening = { listened.value += 1 }
        voice.keyDown()
        voice.frame(loud)
        XCTAssertEqual(voice.keyUp(), .tap)
        XCTAssertFalse(io.capturing)
        XCTAssertTrue(sent.all.isEmpty)
        XCTAssertEqual(voice.currentMode, .idle)
        XCTAssertEqual(listened.value, 0, "no listening cue for a tap")
        // A hold after it starts afresh, with only its own audio.
        voice.keyDown()
        voice.frame(loud)
        voice.keyHeld()
        XCTAssertEqual(sent.types, ["audio.start", "audio"])
        XCTAssertEqual(listened.value, 1)
    }

    /** With a typing key of its own, a tap on the talk key listens until a pause, as a press did before. */
    func testATapCanStillListen() throws {
        voice.keyDown()
        voice.frame(loud)
        XCTAssertEqual(voice.keyUp(tapListens: true), .tap)
        XCTAssertEqual(try XCTUnwrap(sent.last("audio.start"))["trigger"], "tap")
        XCTAssertEqual(voice.currentMode, .listening)
        clock.ms += 100
        voice.frame(quiet)
        clock.ms += 1300
        voice.frame(quiet)
        XCTAssertEqual(sent.last("audio.end")?["reason"], "silence")
    }

    /** The key while the agent speaks stops it, as before; nothing is recorded. */
    func testTheKeyStillStopsSpeech() {
        voice.handle("speak.start", ["t": "speak.start", "turnId": "t1", "format": ["sampleRate": 24000]])
        XCTAssertEqual(voice.keyDown(), .stopped)
        XCTAssertEqual(sent.last("playback")?["state"], "stopped")
        XCTAssertFalse(io.capturing)
        XCTAssertEqual(voice.keyUp(), .none)
    }

    /** A microphone that will not start says so only when it turns out to be a hold: a tap types without it. */
    func testNoMicrophoneMattersOnlyForAHold() {
        io.failCapture = true
        voice.keyDown()
        XCTAssertEqual(voice.keyUp(), .tap)
        XCTAssertEqual(voice.currentMode, .idle)
        voice.keyDown()
        voice.keyHeld()
        XCTAssertEqual(voice.currentMode, .error)
        XCTAssertTrue(voice.snapshot.reply.hasPrefix("The microphone could not start"))
        XCTAssertNil(sent.last("audio.start"))
    }

    func testThePreRollKeepsTheLastSecond() {
        var p = PreRoll()
        for _ in 0..<60 { p.push(loud) }
        XCTAssertEqual(p.ms, 1000)
        XCTAssertEqual(p.take().count, 50)
        XCTAssertEqual(p.ms, 0)
    }

    /** The web client's message, after the speech and the turn under way are stopped. */
    func testATypedTurn() throws {
        voice.handle("speak.start", ["t": "speak.start", "turnId": "t1", "format": ["sampleRate": 24000]])
        sent.clear()
        XCTAssertTrue(voice.type("  what's the weather?\n"))
        XCTAssertEqual(sent.types, ["playback", "interrupt", "text"])
        let m = try XCTUnwrap(sent.last("text"))
        XCTAssertEqual(m["text"], "what's the weather?")
        XCTAssertTrue(m["turnId"]?.stringValue?.hasPrefix("pc-") == true)
        XCTAssertEqual(voice.currentMode, .thinking)
        XCTAssertEqual(voice.snapshot.heard, "what's the weather?", "shown in the pill as what was said")
        // The reply comes as for a spoken turn.
        voice.handle("reply.text", ["t": "reply.text", "turnId": m["turnId"]!, "text": "Sunny.", "final": true])
        voice.handle("reply.image", ["t": "reply.image", "turnId": m["turnId"]!, "url": "/v1/media/abc", "alt": "a sun"])
        XCTAssertEqual(voice.snapshot.reply, "Sunny.")
        XCTAssertEqual(voice.snapshot.picture, VoicePicture(url: "/v1/media/abc", alt: "a sun", turnId: m["turnId"]!.stringValue!))
        XCTAssertEqual(VoicePillWords.of(voice.snapshot, talkKey: "⌃⌥Space").picture, "/v1/media/abc")
        // The next turn starts without it.
        XCTAssertTrue(voice.type("thanks"))
        XCTAssertNil(voice.snapshot.picture)
        // Nothing to send.
        sent.clear()
        XCTAssertFalse(voice.type("  \n "))
        XCTAssertTrue(sent.all.isEmpty)
    }

    /** Typed while a question is open: sent all the same (Axis takes it as the answer); the buttons stay until Axis ends the question. */
    func testTypingAnswersAQuestion() {
        voice.handle("ask", ["t": "ask", "askId": "a1", "question": "Send it?", "choices": ["Allow", "Deny"]])
        XCTAssertTrue(voice.type("yes, send it"))
        XCTAssertEqual(sent.last("text")?["text"], "yes, send it")
        XCTAssertEqual(voice.snapshot.choices, ["Allow", "Deny"])
        voice.handle("ask.end", ["t": "ask.end", "askId": "a1"])
        XCTAssertNil(voice.snapshot.question)
    }

    func testTheTextLimits() throws {
        XCTAssertNil(TypedText.clean(""))
        XCTAssertNil(TypedText.clean(" \n\t"))
        XCTAssertEqual(TypedText.clean(String(repeating: "a", count: 4000))?.count, 4000)
        XCTAssertNil(TypedText.clean(String(repeating: "a", count: 4001)))
        // JavaScript's length: an emoji is two.
        XCTAssertNil(TypedText.clean(String(repeating: "😀", count: 2001)))
        XCTAssertEqual(TypedText.clip(String(repeating: "😀", count: 2001)).utf16.count, 4000)
        XCTAssertEqual(TypedText.clip("short"), "short")
        let m = try XCTUnwrap(TypedText.message(turnId: "pc-1", text: " hi "))
        XCTAssertEqual(m, ["t": "text", "turnId": "pc-1", "text": "hi"])
        XCTAssertNil(TypedText.message(turnId: "pc-1", text: ""))
    }

    /** The typing pill grows from one line to three, then scrolls; it sits in the voice pill's slot. */
    func testTheTypingPillsPlace() {
        let one = TypingLayout.height(lines: 1), three = TypingLayout.height(lines: 3)
        XCTAssertEqual(three - one, TypingLayout.lineHeight * 2)
        XCTAssertEqual(TypingLayout.height(lines: 9), three, "then it scrolls")
        XCTAssertEqual(TypingLayout.height(lines: 0), one)
        XCTAssertEqual(TypingLayout.height(lines: 1, questionLines: 1, choices: true) - one, TypingLayout.questionLine + TypingLayout.choicesRow)
        let air = PanelRect(x: 0, y: 0, w: 1470, h: 956)
        let screen = PillScreen(frame: air, visible: PanelRect(x: 0, y: 60, w: 1470, h: 864), notch: PanelRect(x: 640, y: 924, w: 190, h: 32))
        // Alone it grows out of the notch, its field under the notch's line.
        let alone = PillLayout.place(w: TypingLayout.width, h: three, on: screen)
        XCTAssertTrue(alone.attached)
        XCTAssertEqual(alone.pill.h, 32 + three)
        XCTAssertEqual(alone.pill.w, TypingLayout.width)
        // Under the "using this computer" pill it floats, and the task and timer pills go under it.
        let control = PillLayout.place(w: 400, h: 36, on: screen)
        let typing = PillLayout.place(w: TypingLayout.width, h: one, on: screen, under: PillLayout.under([control.pill.y]))
        XCTAssertFalse(typing.attached)
        XCTAssertEqual(typing.pill.maxY, control.pill.y - PillLayout.gap)
        let task = PillLayout.place(w: 300, h: 36, on: screen, under: PillLayout.under([control.pill.y, typing.pill.y]))
        XCTAssertEqual(task.pill.maxY, typing.pill.y - PillLayout.gap)
        XCTAssertNil(PillLayout.under([nil, nil]))
        XCTAssertEqual(PillLayout.under([nil, 500, 700]), 500)
    }
}
