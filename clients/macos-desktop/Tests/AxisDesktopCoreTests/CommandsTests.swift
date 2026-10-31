import XCTest
@testable import AxisDesktopCore

/** A screen to test against, as the Windows smoke test's FakeDesktop: a mail window with a few controls. */
final class FakeDesktop: Desktop, @unchecked Sendable {
    var elements: [ScreenElement] = [
        ScreenElement(kind: "window", name: "Inbox - Mail", x: 0, y: 0, w: 1200, h: 800),
        ScreenElement(kind: "edit", name: "Search", x: 100, y: 60, w: 400, h: 30, value: "invoices", focused: true),
        ScreenElement(kind: "button", name: "Send", x: 900, y: 600, w: 80, h: 30),
        ScreenElement(kind: "text", name: "Send", x: 910, y: 605, w: 40, h: 20),
        ScreenElement(kind: "password", name: "Password", x: 100, y: 200, w: 300, h: 30),
        ScreenElement(kind: "button", name: "Delete", x: 300, y: 600, w: 80, h: 30),
        ScreenElement(kind: "button", name: "Delete", x: 500, y: 600, w: 80, h: 30),
    ]
    var screenWindows: [ScreenElement] = [
        ScreenElement(kind: "window", name: "Inbox - Mail (Mail)", x: 0, y: 0, w: 1200, h: 800),
        ScreenElement(kind: "window", name: "Vault (KeePassXC)", x: 50, y: 50, w: 600, h: 400),
    ]
    var front = WindowInfo(title: "Inbox - Mail", app: "Mail", x: 0, y: 0, w: 1200, h: 800, bundleID: "com.apple.mail")
    var pointed: [(Int, Int, String?, Double)] = []
    var hidden = 0
    var looks: [String] = []

    func look(scope: String, ocr: OcrMode) async throws -> LookResult {
        looks.append(scope)
        return LookResult(window: front, mouseX: 940, mouseY: 615, elements: scope == "screen" ? screenWindows : elements,
                          screenW: 1440, screenH: 900, monitors: [Display(x: 0, y: 0, w: 1440, h: 900, primary: true)], readMs: 5)
    }
    func point(x: Int, y: Int, text: String?, seconds: Double) async throws { pointed.append((x, y, text, seconds)) }
    func hide() async { hidden += 1 }
    func centre() async -> (x: Int, y: Int) { (720, 450) }
    func state() async throws -> ScreenState { ScreenState(window: front, focus: focus) }

    // M2: what each input was asked to do, and answers to give.
    var focus: ScreenElement? = ScreenElement(kind: "edit", name: "Search", x: 100, y: 60, w: 400, h: 30, value: "invoices", focused: true)
    var did: [String] = []
    var clickHow = "invoked"
    /** What `refresh` gives after a scroll: nil is "off the screen". */
    var refreshed: ScreenElement?? = .none
    var clipboard: (String?, String?) = ("hello", nil)
    var windows = ["Inbox - Mail (Mail)", "Notes (Notes)"]
    /** Set by a test: the window in front changes to this right after the first input is resolved (block-list re-check). */
    var frontAfterTarget: WindowInfo?

    func click(target: ScreenElement?, x: Int, y: Int, kind: ClickKind) async throws -> (how: String, x: Int, y: Int) {
        did.append("click \(kind.rawValue) \(target?.name ?? "\(x),\(y)")")
        return (clickHow, x, y)
    }
    func refresh(_ e: ScreenElement) async throws -> ScreenElement? {
        did.append("refresh \(e.name)")
        switch refreshed {
        case .none: return e
        case .some(let now): return now
        }
    }
    func drag(from: ScreenElement?, x1: Int, y1: Int, to: ScreenElement?, x2: Int, y2: Int, holdMs: Int) async throws -> String {
        did.append("drag \(x1),\(y1) \(x2),\(y2) \(holdMs)")
        return "mouse"
    }
    func type(target: ScreenElement?, text: String) async throws { did.append("type \(text) into \(target?.name ?? "focus")") }
    func keys(_ combo: KeyCombo) async throws { did.append("keys \(combo)") }
    func open(app: String?, url: String?) async throws -> (opened: String, window: WindowInfo?) {
        did.append("open \(app ?? url ?? "")")
        if app == "Ghost" { return ("Ghost", nil) }
        front = WindowInfo(title: "Untitled", app: app ?? "Safari", x: 10, y: 20, w: 800, h: 600)
        return (app ?? url ?? "", front)
    }
    func switchTo(_ window: String) async throws -> WindowInfo {
        did.append("switch \(window)")
        front = WindowInfo(title: "Notes", app: "Notes", x: 5, y: 6, w: 700, h: 500)
        return front
    }
    func window(op: String, window: String?, display: Int?) async throws -> WindowInfo {
        did.append("window \(op) \(display ?? 0)")
        return front
    }
    func desktop(next: Bool) async throws { did.append("space \(next ? "next" : "previous")") }
    func screenshot(scope: String, region: ScreenElement?, maxSide: Int) async throws -> Shot {
        did.append("shot \(scope) \(region?.name ?? "-") \(maxSide)")
        return Shot(jpeg: Data([1, 2, 3]), w: 640, h: 427, x: 0, y: 0, areaW: 1200, areaH: 800, window: front)
    }
    func scroll(target: ScreenElement?, go: String, pages: Int) async throws -> String {
        did.append("scroll \(go) \(pages) \(target?.name ?? "-")")
        return "wheel"
    }
    func findWindow(_ query: String) async throws -> WindowInfo? {
        windows.first { $0.lowercased().contains(query.lowercased()) }.map { WindowInfo(title: $0, app: "", x: 0, y: 0, w: 1, h: 1) }
    }
    func readClipboard() async throws -> (text: String?, why: String?) { clipboard }
    func paste(target: ScreenElement?, text: String) async throws { did.append("paste \(text.count) into \(target?.name ?? "focus")") }
}

final class CommandsTests: XCTestCase {
    var fake: FakeDesktop!
    var commands: DesktopCommands!

    override func setUp() {
        fake = FakeDesktop()
        commands = DesktopCommands(desktop: fake)
    }

    func run(_ name: String, _ params: JSONValue = [:]) async -> CommandAnswer { await commands.handle(name, params) }

    func testLookSendsLinesAndTheScreen() async throws {
        let a = await run("desktop.look")
        XCTAssertTrue(a.ok)
        let d = try XCTUnwrap(a.data)
        XCTAssertEqual(d["screen"], "0,0 1440x900")
        XCTAssertEqual(d["mouse"], "940,615")
        XCTAssertEqual(d["window"], "Inbox - Mail (Mail) 0,0 1200x800")
        XCTAssertEqual(d["monitors"], ["0,0 1440x900 main"])
        let lines = try XCTUnwrap(d["elements"]?.arrayValue?.compactMap(\.stringValue))
        XCTAssertEqual(lines[0], "1 window 0,0 1200x800 Inbox - Mail")
        XCTAssertEqual(lines[1], "2 edit 100,60 400x30 Search = invoices *focus")
        XCTAssertEqual(lines[4], "5 password 100,200 300x30 Password", "a password field is listed, never its contents")
        XCTAssertEqual(d["underMouse"], 4, "the smallest element holding the mouse")
        XCTAssertNil(d["more"])
        // The line Axis parses: id, one token of kind, x,y, wxh, the rest.
        let pattern = try NSRegularExpression(pattern: #"^(\d+) \S+ (-?\d+),(-?\d+) (\d+)x(\d+) ?(.*)$"#)
        for l in lines { XCTAssertNotNil(pattern.firstMatch(in: l, range: NSRange(l.startIndex..., in: l)), l) }
    }

    func testOcrLinesAreMarked() async throws {
        fake.elements.append(ScreenElement(kind: "text", name: "Total 42", x: 10, y: 700, w: 80, h: 16, source: "ocr"))
        let looked = await run("desktop.look")
        let d = try XCTUnwrap(looked.data)
        XCTAssertEqual(d["elements"]?.arrayValue?.last, "8 text 10,700 80x16 Total 42 (ocr)")
        XCTAssertNotNil(d["ocr"])
    }

    func testABusyWindowIsCutTo250KeepingTheWindowAndFocus() async throws {
        fake.elements = [ScreenElement(kind: "window", name: "Big", x: 0, y: 0, w: 1200, h: 800)]
            + (0..<400).map { ScreenElement(kind: "listitem", name: "Row \($0)", x: 0, y: 20 + $0 * 20, w: 300, h: 20) }
            + [ScreenElement(kind: "edit", name: "Filter", x: 0, y: 9000, w: 300, h: 20, focused: true)]
        let looked = await run("desktop.look")
        let d = try XCTUnwrap(looked.data)
        let lines = try XCTUnwrap(d["elements"]?.arrayValue?.compactMap(\.stringValue))
        XCTAssertEqual(lines.count, DesktopCommands.maxElements)
        XCTAssertEqual(d["more"], .int(402 - 250))
        XCTAssertTrue(lines[0].hasSuffix("window 0,0 1200x800 Big"))
        XCTAssertTrue(lines.contains { $0.contains("Filter") && $0.hasSuffix("*focus") }, "the focus always goes")
        XCTAssertTrue(lines.contains { $0.hasSuffix("Row 29") }, "the rows nearest the mouse go")
    }

    func testFindGivesIdsOfTheFullList() async throws {
        let a = await run("desktop.find", ["name": "send"])
        XCTAssertTrue(a.ok)
        let matches = try XCTUnwrap(a.data?["matches"]?.arrayValue?.compactMap(\.stringValue))
        XCTAssertEqual(matches.first, "3 button 900,600 80x30 Send", "the button before its own label")
        XCTAssertEqual(a.data?["window"], "Inbox - Mail (Mail)")
        // And the ids hold for the next call.
        _ = await run("desktop.point", ["id": 3])
        XCTAssertEqual(fake.pointed.last?.0, 940)
    }

    func testPointByIdNameAndPoint() async throws {
        _ = await run("desktop.look")
        let byId = await run("desktop.point", ["id": 3, "text": "This one", "seconds": 90])
        XCTAssertEqual(byId.payload, ["x": 940, "y": 615, "name": "Send"])
        XCTAssertEqual(fake.pointed.last?.2, "This one")
        XCTAssertEqual(fake.pointed.last?.3, 60, "seconds is held to 60")

        let byName = await run("desktop.point", ["name": "Send"])
        XCTAssertTrue(byName.ok, "the button scores above its own label: no tie")
        let byPoint = await run("desktop.point", ["x": 5, "y": 6])
        XCTAssertEqual(byPoint.payload, ["x": 5, "y": 6])

        let tie = await run("desktop.point", ["name": "Delete"])
        XCTAssertFalse(tie.ok)
        XCTAssertTrue(tie.error!.contains("matches 2 things equally"), tie.error!)
        XCTAssertTrue(tie.error!.contains("id 6"), tie.error!)

        let r1 = await run("desktop.point", ["id": 99])
        XCTAssertEqual(r1.error, "no element 99 in the last look; look again")
        let r2 = await run("desktop.point")
        XCTAssertEqual(r2.error, "point needs a name, an id, or x and y")
    }

    func testBubbleOffDropsTheWords() async {
        commands.useSettings(["bubble": "0"])
        _ = await run("desktop.point", ["x": 1, "y": 2, "text": "hi"])
        XCTAssertNil(fake.pointed.last?.2)
    }

    func testHelloAndHide() async {
        let r3 = await run("desktop.hello")
        XCTAssertTrue(r3.ok)
        XCTAssertEqual(fake.pointed.last?.0, 720)
        XCTAssertEqual(fake.pointed.last?.2, "Hi, I'm here")
        let r4 = await run("desktop.hide")
        XCTAssertTrue(r4.ok)
        XCTAssertEqual(fake.hidden, 1)
    }

    func testDesktopSwitchedOffOnTheAdminPage() async {
        XCTAssertEqual(DesktopCommands.capabilitiesOff([:]), [])
        XCTAssertEqual(DesktopCommands.capabilitiesOff(["capabilitiesOff": ""]), [])
        XCTAssertEqual(DesktopCommands.capabilitiesOff(["capabilitiesOff": "mic, desktop"]), ["mic", "desktop"])
        commands.useSettings(["capabilitiesOff": "desktop"])
        let refused = await run("desktop.look")
        XCTAssertEqual(refused.error, "the desktop is switched off for this computer on the VorteX Axis admin page")
        commands.useSettings(["capabilitiesOff": "screen"])
        let looked = await run("desktop.look")
        XCTAssertTrue(looked.ok)
    }

    func testPausedAndSwitchedOff() async {
        commands.paused = true
        let r5 = await run("desktop.hello")
        XCTAssertEqual(r5.error, "the person at the computer has paused the VorteX Axis desktop app")
        let r6 = await run("desktop.look")
        XCTAssertFalse(r6.ok)
        commands.paused = false
        commands.useSettings(["allowLook": false])
        let r7 = await run("desktop.look")
        XCTAssertEqual(r7.error, "reading the screen is switched off for this computer")
        let r8 = await run("desktop.find", ["name": "x"])
        XCTAssertEqual(r8.error, "reading the screen is switched off for this computer")
        commands.useSettings(["allowLook": 1])
        let r9 = await run("desktop.look")
        XCTAssertTrue(r9.ok)
    }

    func testTheBlockList() async throws {
        let refused = await run("desktop.look", ["blocked": "bank|mail"])
        XCTAssertFalse(refused.ok)
        XCTAssertTrue(refused.error!.hasPrefix("the window in front is blocked by the user (it matches \"mail\")"))
        let r10 = await run("desktop.hide", ["blocked": "mail"])
        XCTAssertTrue(r10.ok, "hide is let through")
        // A look at the screen lists a blocked window only as blocked; the app is in the name on a Mac.
        let screen = await run("desktop.look", ["scope": "screen", "blocked": "keepass"])
        let lines = try XCTUnwrap(screen.data?["elements"]?.arrayValue?.compactMap(\.stringValue))
        XCTAssertEqual(lines[1], "2 window 50,50 600x400 blocked by the user")
        let list = await run("desktop.window", ["do": "list", "blocked": "keepass"])
        XCTAssertEqual(list.data?["windows"], ["Inbox - Mail (Mail) 0,0 1200x800", "blocked by the user"])
    }

    func testWhatIsNotHereStill() async {
        let r11 = await run("desktop.busy")
        XCTAssertEqual(r11.error, "not implemented on this device")
        let r12 = await run("update")
        XCTAssertEqual(r12.error, "not implemented on this device")
    }

    func testBadScope() async {
        let r13 = await run("desktop.look", ["scope": "desk"])
        XCTAssertEqual(r13.error, "scope must be window, mouse or screen")
    }

    func testWithinADeadline() async throws {
        let fast = try await within(ms: 1000) { "fast" }
        XCTAssertEqual(fast, "fast")
        let late = try await within(ms: 50) { () async throws -> String in
            try await Task.sleep(nanoseconds: 1_000_000_000)
            return "late"
        }
        XCTAssertNil(late, "past the deadline the answer is nil, not a wait")
    }

    func testMatchOrder() {
        let all = [
            ScreenElement(kind: "pane", name: "Search", x: 0, y: 0, w: 100, h: 100),
            ScreenElement(kind: "edit", name: "Search mail", x: 0, y: 0, w: 10, h: 10),
            ScreenElement(kind: "text", name: "Search", x: 0, y: 0, w: 10, h: 10),
        ]
        let m = DesktopCommands.match(all, "search", kind: "edit")
        XCTAssertEqual(m.map(\.index), [1, 2, 0], "kind asked and actionable lift a near match over a container with the same name")
    }
}

final class IdentityTests: XCTestCase {
    /** Axis's schema: labels at most 80 characters, help at most 240, at most 48 settings and 24 actions. */
    func testTheDescribeFitsAxisSchema() throws {
        let id = DesktopIdentity.create(version: "0.1.0")
        XCTAssertEqual(id.type, "macos-desktop")
        XCTAssertEqual(id.capabilities, ["desktop"])
        let settings = try XCTUnwrap(id.describe["settings"]?.arrayValue)
        XCTAssertEqual(settings.count, 8)
        XCTAssertEqual(Set(settings.compactMap { $0["key"]?.stringValue }),
                       ["allowLook", "allowInput", "bubble", "allowScreenshot", "autoUpdate", "confirmRisky", "autoOcr", "pointerSize"])
        for s in settings {
            XCTAssertLessThanOrEqual(s["label"]?.stringValue?.utf16.count ?? 0, 80)
            XCTAssertLessThanOrEqual(s["help"]?.stringValue?.utf16.count ?? 0, 240, s["key"]?.stringValue ?? "")
        }
        XCTAssertEqual(settings.first { $0["key"] == "allowScreenshot" }?["default"], "0")
        XCTAssertEqual(settings.first { $0["key"] == "pointerSize" }?["default"], 44)
    }

    /**
     * Talking from this Mac adds what the Windows app adds: a microphone, speakers and a screen (the voice pill shows
     * Axis's questions, so Axis may ask them here). The settings stay the Windows app's eight either way: the voice,
     * face and pill switches are the person's own, kept on the Mac (as on Windows), not on the admin page.
     */
    func testVoiceAddsTheWindowsCapabilities() throws {
        let talking = DesktopIdentity.create(version: "0.3.0", voice: true)
        XCTAssertEqual(talking.capabilities, ["desktop", "mic", "speaker", "screen", "touch", "images"], "0.4.0: pictures in replies too")
        XCTAssertEqual(DesktopIdentity.create(version: "0.3.0", voice: false).capabilities, ["desktop"])
        let keys = try XCTUnwrap(talking.describe["settings"]?.arrayValue).compactMap { $0["key"]?.stringValue }
        XCTAssertEqual(keys, ["allowLook", "allowInput", "bubble", "allowScreenshot", "autoUpdate", "confirmRisky", "autoOcr", "pointerSize",
                              "listenCue", "taskChime", "volume"], "the Windows app's order, then the boards' two sound switches and the volume (0.6.0)")
        let actions = try XCTUnwrap(talking.describe["actions"]?.arrayValue).compactMap { $0["name"]?.stringValue }
        XCTAssertEqual(actions, ["desktop.hello", "chime"], "a chime, so Axis rings a timer before saying it")
        let quiet = DesktopIdentity.create(version: "0.3.0")
        XCTAssertEqual(try XCTUnwrap(quiet.describe["actions"]?.arrayValue).count, 1, "no speaker, no chime")
        for s in try XCTUnwrap(talking.describe["settings"]?.arrayValue) {
            XCTAssertLessThanOrEqual(s["help"]?.stringValue?.utf16.count ?? 0, 240, s["key"]?.stringValue ?? "")
        }
    }
}

final class WindowAnswerTests: XCTestCase {
    /** The 0.2.0 live test: a minimize answered ok and nothing happened. The answer says what the window says afterwards. */
    func testTheWindowAnswerSaysWhatHappened() {
        let gone = WindowInfo(title: "Log in - Wikipedia", app: "Brave Browser", x: 0, y: 33, w: 1470, h: 923, minimised: true)
        XCTAssertEqual(DesktopCommands.windowPayload(gone)["minimized"], .bool(true))
        var back = gone
        back.minimised = false
        XCTAssertEqual(DesktopCommands.windowPayload(back)["minimized"], .bool(false))
        back.minimised = nil
        XCTAssertNil(DesktopCommands.windowPayload(back)["minimized"], "switch and open say nothing of it")
        XCTAssertNil(DesktopCommands.windowPayload(back)["fullScreen"])
        back.fullScreen = true
        XCTAssertEqual(DesktopCommands.windowPayload(back)["fullScreen"], .bool(true), "a restore back into full screen says so")
    }
}

final class WindowRestoreTests: XCTestCase {
    /** The 0.2.1 live test: Brave in full screen, minimised, restored as an ordinary window. It goes back into full screen. */
    func testAWindowTakenOutOfFullScreenGoesBack() {
        XCTAssertEqual(WindowRestore.steps(minimised: true, fullScreen: false, wasFullScreen: true, previous: nil), [.unminimise, .enterFullScreen])
        XCTAssertEqual(WindowRestore.steps(minimised: true, fullScreen: false, wasFullScreen: false, previous: nil), [.unminimise])
        XCTAssertEqual(WindowRestore.steps(minimised: false, fullScreen: false, wasFullScreen: true, previous: nil), [.enterFullScreen],
                       "back from the Dock by hand: still put back into full screen")
    }

    func testTheOtherRestores() {
        let before = Box(x: 100, y: 100, w: 800, h: 600)
        XCTAssertEqual(WindowRestore.steps(minimised: false, fullScreen: true, wasFullScreen: false, previous: nil), [.leaveFullScreen])
        XCTAssertEqual(WindowRestore.steps(minimised: false, fullScreen: false, wasFullScreen: false, previous: before), [.setBox(before)])
        XCTAssertEqual(WindowRestore.steps(minimised: false, fullScreen: false, wasFullScreen: false, previous: nil), [])
    }

    func testTheMemory() {
        var m = FullScreenMemory()
        XCTAssertFalse(m.had(pid: 42, title: "Log in - Wikipedia"))
        m.note(pid: 42, title: "Log in - Wikipedia")
        XCTAssertTrue(m.had(pid: 42, title: "Log in - Wikipedia"))
        XCTAssertTrue(m.had(pid: 42, title: "Wikipedia"), "the only one of its app: the title may have changed in the Dock")
        XCTAssertFalse(m.had(pid: 7, title: "Log in - Wikipedia"), "another app")
        m.note(pid: 42, title: "Mail")
        XCTAssertFalse(m.had(pid: 42, title: "Wikipedia"), "two of the app: the title decides")
        m.forget(pid: 42, title: "Other", exactly: true)
        XCTAssertTrue(m.had(pid: 42, title: "Mail"), "moving another window forgets nothing")
        m.forget(pid: 42, title: "Mail")
        XCTAssertTrue(m.had(pid: 42, title: "Log in - Wikipedia"))
        m.forget(pid: 42, title: "Wikipedia")
        XCTAssertFalse(m.had(pid: 42, title: "Log in - Wikipedia"), "restored under its new title: forgotten")
    }
}
