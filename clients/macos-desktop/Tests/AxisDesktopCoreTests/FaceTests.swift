import XCTest
@testable import AxisDesktopCore

/** The face (its state machine and timing), where the face and the pills go (the notch included), and the pills' words. */
final class FaceTests: XCTestCase {
    /** A steady sequence in place of chance, so a test sees the same face every run. */
    final class Steady: @unchecked Sendable {
        private var i = 0
        let values: [Double]
        init(_ values: [Double]) { self.values = values }
        func next() -> Double {
            defer { i += 1 }
            return values[i % values.count]
        }
    }

    func face(_ values: [Double] = [0.1, 0.55, 0.9, 0.3]) -> Face {
        let s = Steady(values)
        return Face(random: { s.next() })
    }

    // MARK: Face

    func testEveryDotIsPaintedEachFrame() {
        let f = face()
        let frame = f.frame(0.016)
        XCTAssertEqual(frame.dots.count, 78)
        XCTAssertNotNil(frame.core)
        XCTAssertNil(frame.icon)
        for d in frame.dots {
            XCTAssert((0...1).contains(d.r) && (0...1).contains(d.g) && (0...1).contains(d.b))
            XCTAssert(d.radius > 0)
            // Inside the 240 square, with room for the biggest swell.
            XCTAssert(d.x > 0 && d.x < Face.size && d.y > 0 && d.y < Face.size)
        }
    }

    func testLongFramesAreCutToATenthOfASecond() {
        let a = face(), b = face()
        a.setMode("speaking")
        b.setMode("speaking")
        XCTAssertEqual(a.frame(5).dots, b.frame(0.1).dots)
    }

    func testIdleDriftsToAnotherLookWithinSeventeenSeconds() {
        let f = face()
        f.setMode("idle")
        let first = f.idleIndex
        XCTAssert((7...17).contains(f.idleRemaining))
        for _ in 0..<(18 * 10) { _ = f.frame(0.1) }
        XCTAssertNotEqual(f.idleIndex, first)
    }

    func testTheIconComesOnlyWhileThinkingAndFadesInWithinASecond() {
        let f = face()
        f.iconStyle = "line"
        f.setMode("speaking")
        f.setDoing("computer")
        for _ in 0..<20 { _ = f.frame(0.05) }
        XCTAssertEqual(f.iconShown, 0, accuracy: 0.001)
        f.setMode("thinking")
        for _ in 0..<20 { _ = f.frame(0.05) }
        XCTAssertGreaterThan(f.iconShown, 0.985)
        XCTAssertNotNil(f.frame(0.016).icon)
        f.setDoing(nil)
        for _ in 0..<20 { _ = f.frame(0.05) }
        XCTAssertLessThan(f.iconShown, 0.01)
    }

    func testDotsDrawTheIconByDefault() {
        let f = face()
        f.setMode("thinking")
        f.setDoing("computer")
        var frame = f.frame(0.05)
        for _ in 0..<30 { frame = f.frame(0.05) }
        // As dots, not with a pen; the core gives way to it.
        XCTAssertNil(frame.icon)
        XCTAssertNil(frame.core)
    }

    func testAHeldRunIsALookNotAnIcon() {
        let f = face()
        f.iconStyle = "line"
        f.setMode("thinking")
        f.setDoing("compacting")
        for _ in 0..<20 { _ = f.frame(0.05) }
        XCTAssertEqual(f.iconShown, 0, accuracy: 0.001)
    }

    func testReducedMotionDropsTheSparkle() {
        // random() always 0 would flash every dot while thinking; always 0.99 never does. With Reduce motion they match.
        func thinking(_ chance: Double, reduced: Bool) -> [Face.Circle] {
            let f = face([chance])
            f.reducedMotion = reduced
            f.setMode("thinking")
            return f.frame(0.05).dots
        }
        XCTAssertNotEqual(thinking(0, reduced: false), thinking(0.99, reduced: false))
        XCTAssertEqual(thinking(0, reduced: true), thinking(0.99, reduced: true))
    }

    func testTheComputerIconExists() {
        XCTAssertNotNil(FaceIcons.all["computer"])
        let points = FaceIcons.all["computer"]!.points
        XCTAssertGreaterThanOrEqual(points.count, FaceIcons.dots * 2)
    }

    // MARK: The Face page's settings (the Windows app's Checks.FaceSettings)

    /** Runs a face for `seconds` in steps of a tenth, and gives the last frame. */
    func run(_ f: Face, _ seconds: Double) -> Face.Frame {
        var frame = f.frame(0)
        var t = 0.0
        while t < seconds - 1e-9 { frame = f.frame(0.1); t += 0.1 }
        return frame
    }

    func shapeDots(_ frame: Face.Frame) -> Int { frame.dots.filter { abs($0.radius - FaceIcons.shapeDot) < 1e-9 }.count }

    func testAShapeOfFewerDotsSpreadsThemOverThe78Points() {
        // toolIconDots, as web/vortex.js: dot n is in the shape when n < dots, at point floor(n * 78 / dots).
        XCTAssertEqual(Face.shapePoint(0, 78), 0)
        XCTAssertEqual(Face.shapePoint(77, 78), 77)
        XCTAssertEqual(Face.shapePoint(11, 12), 71)
        XCTAssertEqual(Face.shapePoint(12, 12), -1)
        XCTAssertEqual(Face.shapePoint(39, 40), 76)
        XCTAssertEqual(Face.shapePoint(5, 40), 9)
    }

    func testTheSettingsAsAxisSendsThem() {
        let f = face()
        f.useSettings(["toolIcons": .string("line"), "toolIconMs": .number(5000), "toolIconDots": .number(5)])
        XCTAssertEqual(f.iconStyle, "line")
        XCTAssertEqual(f.iconMs, 3000)
        XCTAssertEqual(f.iconDots, 12)
        f.useSettings(["toolIcons": .string("sparkles"), "toolIconMs": .number(100), "toolIconDots": .number(40.5)])
        XCTAssertEqual(f.iconStyle, "dots")
        XCTAssertEqual(f.iconMs, 150)
        XCTAssertEqual(f.iconDots, 41)
        f.useSettings([:])
        XCTAssertEqual(f.iconStyle, "dots")
        XCTAssertEqual(f.iconMs, 700)
        XCTAssertEqual(f.iconDots, 78)
    }

    func testTwelveDotsDrawTheShapeAndTheRestRingIt() {
        let f = face()
        f.setIconTuning(ms: nil, dots: 12)
        f.setMode("thinking")
        f.setDoing("search")
        var frame = run(f, 1.5)
        XCTAssertEqual(shapeDots(frame), 12)
        let ring = frame.dots.filter { abs($0.radius - FaceIcons.shapeDot) >= 1e-9 && hypot($0.x - 120, $0.y - 120) >= 80 - 1e-6 }
        XCTAssertEqual(ring.count, 66)
        XCTAssertNil(frame.core)
        XCTAssertNil(frame.icon)
        f.setIconTuning(ms: nil, dots: nil)
        frame = run(f, 0.1)
        XCTAssertEqual(shapeDots(frame), 78)
    }

    func testASlowerIconIsNotFormedYet() {
        let f = face()
        f.setIconTuning(ms: 3000, dots: nil)
        f.setMode("thinking")
        f.setDoing("search")
        let frame = run(f, 0.7)
        XCTAssertEqual(shapeDots(frame), 0)
        XCTAssertNotNil(frame.core)
    }

    func testIconsOffAndLine() {
        let f = face()
        f.iconStyle = "off"
        f.setMode("thinking")
        f.setDoing("search")
        var frame = run(f, 1.5)
        XCTAssertNotNil(frame.core)
        XCTAssertNil(frame.icon)
        XCTAssertEqual(shapeDots(frame), 0)
        f.iconStyle = "line"
        frame = run(f, 1.5)
        XCTAssertNil(frame.core)
        XCTAssertNotNil(frame.icon)
        XCTAssertEqual(shapeDots(frame), 0)
    }

    func testIdleLooksSwitchedOff() {
        let allButSway = Face.idleNames.filter { $0 != "sway" }.map { $0.uppercased() }.joined(separator: ", ")
        var f = face()
        f.setIdleOff(allButSway + ",nonsense")
        f.setMode("idle")
        XCTAssertEqual(f.idleName, "sway")
        _ = run(f, 40)
        XCTAssertEqual(f.idleName, "sway")
        // Switched off while on show: moves off at once, and never comes back.
        f = face()
        f.setMode("idle")
        let showing = f.idleName
        f.useSettings(["idleLooksOff": .string(showing)])
        XCTAssertNotEqual(f.idleName, showing)
        for _ in 0..<30 {
            _ = run(f, 17.1)
            XCTAssertNotEqual(f.idleName, showing)
        }
        // Every look named: the first stays.
        f = face()
        f.setIdleOff(Face.idleNames.joined(separator: ","))
        f.setMode("idle")
        _ = run(f, 40)
        XCTAssertEqual(f.idleName, "calm")
    }

    // MARK: FaceShow (the Windows app's FaceWindow.Set)

    func testWhatTheFaceShows() {
        XCTAssertEqual(FaceShow.of(.idle, doing: nil, agentHere: false), FaceShow(mode: "idle", doing: nil, voiced: false, wanted: false))
        XCTAssertEqual(FaceShow.of(.idle, doing: "web", agentHere: true), FaceShow(mode: "thinking", doing: "computer", voiced: false, wanted: true))
        XCTAssertEqual(FaceShow.of(.listening, doing: nil, agentHere: true), FaceShow(mode: "listening", doing: nil, voiced: true, wanted: true))
        XCTAssertEqual(FaceShow.of(.thinking, doing: "web", agentHere: false), FaceShow(mode: "thinking", doing: "web", voiced: false, wanted: true))
        XCTAssertEqual(FaceShow.of(.transcribing, doing: nil, agentHere: false).mode, "thinking")
        XCTAssertEqual(FaceShow.of(.speaking, doing: "web", agentHere: false), FaceShow(mode: "speaking", doing: nil, voiced: true, wanted: true))
        XCTAssertEqual(FaceShow.of(.error, doing: nil, agentHere: false).mode, "error")
    }

    // MARK: FacePresence (coming and going)

    func testTheFaceComesAtOnceAndLeavesTwoAndAHalfSecondsAfter() {
        var p = FacePresence()
        XCTAssertEqual(p.set(wanted: true, keep: false, now: 0), .show)
        XCTAssertEqual(p.set(wanted: true, keep: false, now: 1), .none)
        XCTAssertEqual(p.set(wanted: false, keep: false, now: 10), .none)
        XCTAssertEqual(p.leaveAt, 12.5)
        XCTAssertEqual(p.tick(now: 12), .none)
        XCTAssertTrue(p.shown)
        XCTAssertEqual(p.tick(now: 12.5), .hide)
        XCTAssertFalse(p.shown)
        XCTAssertNil(p.leaveAt)
    }

    func testWantedAgainBeforeItLeavesItStays() {
        var p = FacePresence()
        _ = p.set(wanted: true, keep: false, now: 0)
        _ = p.set(wanted: false, keep: false, now: 1)
        XCTAssertEqual(p.set(wanted: true, keep: false, now: 2), .none)
        XCTAssertNil(p.leaveAt)
        XCTAssertEqual(p.tick(now: 4), .none)
        XCTAssertTrue(p.shown)
    }

    func testTheLeaveIsNotPutOffByMoreNews() {
        var p = FacePresence()
        _ = p.set(wanted: true, keep: false, now: 0)
        _ = p.set(wanted: false, keep: false, now: 1)
        // The voice part reports often (every frame of the microphone): the first not-wanted time counts.
        _ = p.set(wanted: false, keep: false, now: 2)
        XCTAssertEqual(p.leaveAt, 3.5)
    }

    func testAKeptFaceNeverLeaves() {
        var p = FacePresence()
        XCTAssertEqual(p.set(wanted: false, keep: true, now: 0), .show)
        XCTAssertNil(p.leaveAt)
        XCTAssertEqual(p.tick(now: 100), .none)
        // Not kept any more: it goes after the usual wait.
        _ = p.set(wanted: false, keep: false, now: 100)
        XCTAssertEqual(p.tick(now: 102.5), .hide)
    }

    func testNotWantedWhileHiddenDoesNothing() {
        var p = FacePresence()
        XCTAssertEqual(p.set(wanted: false, keep: false, now: 0), .none)
        XCTAssertNil(p.leaveAt)
        XCTAssertFalse(p.shown)
    }

    // MARK: FaceLayout

    /** A MacBook Air 13" (1470 by 956 points, a 32 point menu bar, the Dock 60 points at the bottom). */
    let air = PanelRect(x: 0, y: 0, w: 1470, h: 956)
    let airVisible = PanelRect(x: 0, y: 60, w: 1470, h: 864)

    func testTheFaceSitsAtTheBottomMiddleAboveTheDock() {
        let f = FaceLayout.frame(size: "medium", place: "center", customX: nil, customY: nil, visible: airVisible, screens: [air], mainHeight: 956)
        let side = 132 + FaceLayout.margin * 2
        XCTAssertEqual(f, PanelRect(x: 735 - side / 2, y: 60 + FaceLayout.lift - FaceLayout.margin, w: side, h: side))
        XCTAssertEqual(f.midX, 735)
    }

    func testLeftRightAndSizes() {
        let left = FaceLayout.frame(size: "small", place: "left", customX: nil, customY: nil, visible: airVisible, screens: [air], mainHeight: 956)
        XCTAssertEqual(left.x + FaceLayout.margin, FaceLayout.lift)
        XCTAssertEqual(left.w, 104 + FaceLayout.margin * 2)
        let right = FaceLayout.frame(size: "large", place: "right", customX: nil, customY: nil, visible: airVisible, screens: [air], mainHeight: 956)
        XCTAssertEqual(right.maxX - FaceLayout.margin, 1470 - FaceLayout.lift)
        XCTAssertEqual(FaceLayout.disc("huge"), 132)
    }

    func testADraggedFaceStaysOnTheDisplays() {
        // Its middle saved at 100, 100 from the top left: AppKit's y is 956 - 100.
        let f = FaceLayout.frame(size: "medium", place: FaceLayout.custom, customX: 100, customY: 100, visible: airVisible, screens: [air], mainHeight: 956)
        XCTAssertEqual(f.midX, 100)
        XCTAssertEqual(f.midY, 856)
        XCTAssertEqual(FaceLayout.middle(of: f, mainHeight: 956).x, 100)
        XCTAssertEqual(FaceLayout.middle(of: f, mainHeight: 956).y, 100)
        // Left far off the left: back with the whole disc on the display.
        let off = FaceLayout.frame(size: "medium", place: FaceLayout.custom, customX: -500, customY: 2000, visible: airVisible, screens: [air], mainHeight: 956)
        XCTAssertEqual(off.midX, 66)
        XCTAssertEqual(off.midY, 66)
        // A second display on the left counts as room.
        let second = PanelRect(x: -1920, y: 0, w: 1920, h: 1080)
        let there = FaceLayout.frame(size: "medium", place: FaceLayout.custom, customX: -900, customY: 500, visible: airVisible, screens: [air, second], mainHeight: 956)
        XCTAssertEqual(there.midX, -900)
    }

    func testCustomWithNowherePutIsTheCentre() {
        let f = FaceLayout.frame(size: "medium", place: FaceLayout.custom, customX: nil, customY: nil, visible: airVisible, screens: [air], mainHeight: 956)
        XCTAssertEqual(f.midX, 735)
    }

    // MARK: PillLayout

    func testTheNotchIsWhatLiesBetweenTheMenuBarsTwoSides() {
        let notch = PillScreen.notch(frame: air, safeTop: 32, leftWidth: 640, rightWidth: 640)
        XCTAssertEqual(notch, PanelRect(x: 640, y: 924, w: 190, h: 32))
        XCTAssertNil(PillScreen.notch(frame: air, safeTop: 0, leftWidth: 640, rightWidth: 640))
        XCTAssertNil(PillScreen.notch(frame: air, safeTop: 32, leftWidth: nil, rightWidth: 640))
        // Nonsense widths: no notch rather than a strange one.
        XCTAssertNil(PillScreen.notch(frame: air, safeTop: 32, leftWidth: 800, rightWidth: 800))
        XCTAssertNil(PillScreen.notch(frame: air, safeTop: 32, leftWidth: 100, rightWidth: 100))
        // On a second display placed right of the main one.
        let right = PanelRect(x: 1470, y: 0, w: 1512, h: 982)
        XCTAssertEqual(PillScreen.notch(frame: right, safeTop: 38, leftWidth: 650, rightWidth: 650)?.x, 2120)
    }

    func testWithoutANotchAPillFloatsUnderTheMenuBar() {
        let screen = PillScreen(frame: air, visible: airVisible, notch: nil)
        let p = PillLayout.place(w: 300, h: 36, on: screen)
        XCTAssertFalse(p.attached)
        XCTAssertEqual(p.pill, PanelRect(x: 585, y: 924 - PillLayout.gap - 36, w: 300, h: 36))
        XCTAssertEqual(p.panel, PanelRect(x: 585 - 16, y: 924 - PillLayout.gap - 36 - 16, w: 332, h: 68))
        XCTAssertEqual(p.topInset, 0)
        // A second pill under it.
        let q = PillLayout.place(w: 200, h: 50, on: screen, under: p.pill.y)
        XCTAssertEqual(q.pill.maxY, p.pill.y - PillLayout.gap)
        XCTAssertEqual(q.pill.midX, 735)
    }

    func testWithANotchTheFirstPillGrowsOutOfIt() {
        let notch = PanelRect(x: 640, y: 924, w: 190, h: 32)
        let screen = PillScreen(frame: air, visible: PanelRect(x: 0, y: 60, w: 1470, h: 864), notch: notch)
        let p = PillLayout.place(w: 300, h: 36, on: screen)
        XCTAssertTrue(p.attached)
        // Flush with the top of the screen, centred on the notch, the words under it.
        XCTAssertEqual(p.pill.maxY, 956)
        XCTAssertEqual(p.pill.midX, notch.midX)
        XCTAssertEqual(p.pill.h, 32 + 36)
        XCTAssertEqual(p.topInset, 32)
        XCTAssertEqual(p.panel.maxY, 956)
        XCTAssertEqual(p.panel.h, p.pill.h + PillLayout.margin)
        XCTAssertEqual(p.collapsed.w, 190)
        XCTAssertEqual(p.collapsed.h, 32)
        // Short words: still wider than the notch, so they clear the camera.
        let short = PillLayout.place(w: 100, h: 30, on: screen)
        XCTAssertEqual(short.pill.w, 190 + PillLayout.wings * 2)
        // The second pill floats under the first.
        let q = PillLayout.place(w: 200, h: 40, on: screen, under: p.pill.y)
        XCTAssertFalse(q.attached)
        XCTAssertEqual(q.pill.maxY, p.pill.y - PillLayout.gap)
    }

    // MARK: The pills' words

    func snapshot(_ mode: VoiceMode, heard: String = "", reply: String = "", question: String? = nil, choices: [String] = [], level: Double = 0) -> VoiceSnapshot {
        VoiceSnapshot(mode: mode, heard: heard, reply: reply, question: question, choices: choices, doing: nil, level: level, loudness: -1)
    }

    func testTheVoicePillsWordsFollowTheTurn() {
        let listening = VoicePillWords.of(snapshot(.listening, level: 0.5), talkKey: "⌃⌥Space")
        XCTAssertEqual(listening.status, "Listening")
        XCTAssertEqual(listening.tint, .listening)
        XCTAssertEqual(listening.dotScale, 1.45, accuracy: 0.0001)
        XCTAssertEqual(listening.then, .show)
        let thinking = VoicePillWords.of(snapshot(.thinking, heard: "what time is it"), talkKey: "")
        XCTAssertEqual(thinking.heard, "“what time is it”")
        XCTAssertTrue(thinking.heardIsSpeech)
        XCTAssertEqual(thinking.dotScale, 1)
        XCTAssertEqual(VoicePillWords.of(snapshot(.transcribing), talkKey: "").status, "Hearing you")
        XCTAssertEqual(VoicePillWords.of(snapshot(.speaking, reply: "Ten past four."), talkKey: "").reply, "Ten past four.")
        let done = VoicePillWords.of(snapshot(.idle, heard: "what time is it", reply: "Ten past four."), talkKey: "")
        XCTAssertEqual(done.then, .leaveSoon)
        XCTAssertEqual(done.status, "")
        XCTAssertEqual(VoicePillWords.of(snapshot(.idle), talkKey: "").then, .hide)
        XCTAssertEqual(VoicePillWords.of(snapshot(.error), talkKey: "").then, .showThenLeave)
        XCTAssertEqual(VoicePillWords.of(snapshot(.error), talkKey: "").status, "Something went wrong")
    }

    func testAQuestionWaitsWithItsChoices() {
        let w = VoicePillWords.of(snapshot(.idle, question: "Send the mail?", choices: ["Allow", "Deny"]), talkKey: "⌃⌥Space")
        XCTAssertEqual(w.status, "Question · ⌃⌥Space to answer")
        XCTAssertEqual(w.tint, .question)
        XCTAssertEqual(w.heard, "Send the mail?")
        XCTAssertFalse(w.heardIsSpeech)
        XCTAssertEqual(w.choices, ["Allow", "Deny"])
        XCTAssertEqual(w.then, .show)
        // Answering by voice: still shown, while listening.
        let answering = VoicePillWords.of(snapshot(.listening, question: "Send the mail?", choices: ["Allow", "Deny"]), talkKey: "")
        XCTAssertEqual(answering.status, "Listening")
        XCTAssertEqual(answering.choices, ["Allow", "Deny"])
        // Thinking after the answer: the question is no longer the pill's.
        XCTAssertEqual(VoicePillWords.of(snapshot(.thinking, question: "Send the mail?"), talkKey: "").choices, [])
    }

    func testTheControlPillShowsForAnAgentsDesktopCommandsOnly() {
        XCTAssertTrue(ControlPillWords.shows("desktop.click", paused: false, switchedOn: true))
        XCTAssertFalse(ControlPillWords.shows("desktop.hello", paused: false, switchedOn: true))
        XCTAssertFalse(ControlPillWords.shows("update", paused: false, switchedOn: true))
        XCTAssertFalse(ControlPillWords.shows("desktop.look", paused: true, switchedOn: true))
        XCTAssertFalse(ControlPillWords.shows("desktop.look", paused: false, switchedOn: false))
        XCTAssertEqual(ControlPillWords.title, "VorteX is using this computer")
        XCTAssertEqual(ControlPillWords.linger, 8)
    }

    func testTheMenuBarIconsState() {
        XCTAssertEqual(MenuIconState.of(online: true, paused: false, voice: nil, agentHere: false), .idle)
        XCTAssertEqual(MenuIconState.of(online: false, paused: false, voice: nil, agentHere: true), .offline)
        XCTAssertEqual(MenuIconState.of(online: false, paused: true, voice: nil, agentHere: false), .paused)
        XCTAssertEqual(MenuIconState.of(online: true, paused: false, voice: .listening, agentHere: true), .listening)
        XCTAssertEqual(MenuIconState.of(online: true, paused: false, voice: .speaking, agentHere: false), .speaking)
        XCTAssertEqual(MenuIconState.of(online: true, paused: false, voice: .thinking, agentHere: true), .usingComputer)
        XCTAssertEqual(Set(MenuIconState.allCases.map(\.words)).count, MenuIconState.allCases.count)
    }

    /** The face's and pills' switches are the person's own, kept on the Mac: Axis's describe has the eight settings and the boards' two sound switches. */
    func testTheFaceAndPillSwitchesAreNotInDescribe() throws {
        let id = DesktopIdentity.create(version: "0.3.0", voice: true)
        let keys = try XCTUnwrap(id.describe["settings"]?.arrayValue).compactMap { $0["key"]?.stringValue }
        XCTAssertEqual(keys.count, 10, "the eight and the two sound switches")
        for local in ["showFace", "keepFace", "faceSize", "facePlace", "showControl", "voice", "talkKey"] {
            XCTAssertFalse(keys.contains(local), local)
        }
    }
}
