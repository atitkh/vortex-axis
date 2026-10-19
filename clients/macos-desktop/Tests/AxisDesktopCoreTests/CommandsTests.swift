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
    func state() async throws -> ScreenState { ScreenState(window: front, focus: elements[1]) }
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

    func testWhatIsNotHereYet() async {
        for name in ["desktop.click", "desktop.type", "desktop.keys", "desktop.screenshot", "desktop.window"] {
            let a = await run(name, ["do": "minimize"])
            XCTAssertFalse(a.ok)
            XCTAssertTrue(a.error!.hasPrefix("not implemented on this device yet"), name)
        }
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
}
