import XCTest
@testable import AxisDesktopCore

/** M2's commands against the fake screen: the answers, the gates, ids after a scroll, the block list before each input, steps. */
final class InputCommandsTests: XCTestCase {
    var fake: FakeDesktop!
    var commands: DesktopCommands!

    override func setUp() {
        fake = FakeDesktop()
        commands = DesktopCommands(desktop: fake)
    }

    func run(_ name: String, _ params: JSONValue = [:]) async -> CommandAnswer { await commands.handle(name, params) }

    func testClickByNameIdAndPoint() async throws {
        let byName = await run("desktop.click", ["name": "Send"])
        XCTAssertTrue(byName.ok, byName.error ?? "")
        XCTAssertEqual(byName.payload?["how"], "invoked")
        XCTAssertEqual(byName.payload?["name"], "Send")
        XCTAssertEqual(byName.payload?["x"], 940)
        XCTAssertEqual(fake.did.last, "click left Send")
        // An acting answer says what is in front afterwards.
        XCTAssertEqual(byName.data?["after"]?["window"], "Inbox - Mail (Mail)")
        XCTAssertEqual(byName.data?["after"]?["focus"], "edit Search")
        XCTAssertEqual(byName.data?["after"]?["value"], "invoices")
        XCTAssertNil(byName.data?["after"]?["new"])

        let right = await run("desktop.click", ["id": 3, "button": "right"])
        XCTAssertEqual(fake.did.last, "click right Send")
        XCTAssertTrue(right.ok)
        let double = await run("desktop.click", ["x": 5, "y": 6, "button": "double"])
        XCTAssertEqual(fake.did.last, "click double 5,6")
        XCTAssertNil(double.payload?["name"])
        let bad = await run("desktop.click", ["x": 5, "y": 6, "button": "middle"])
        XCTAssertEqual(bad.error, "button must be left, right or double, not middle")
        let none = await run("desktop.click")
        XCTAssertEqual(none.error, "click needs a name, an id, or x and y")
    }

    func testInputSwitchedOff() async {
        commands.useSettings(["allowInput": "0"])
        for name in ["desktop.click", "desktop.type", "desktop.keys", "desktop.scroll", "desktop.paste", "desktop.open", "desktop.drag", "desktop.desktop"] {
            let a = await run(name, ["x": 1, "y": 1, "text": "a", "keys": "enter", "app": "Notes"])
            XCTAssertEqual(a.error, "clicking and typing are switched off for this computer", name)
        }
        XCTAssertTrue(fake.did.isEmpty, "nothing was done")
        let list = await run("desktop.window", ["do": "list"])
        XCTAssertTrue(list.ok, "the window list is reading, not input")
        let point = await run("desktop.point", ["x": 1, "y": 2])
        XCTAssertTrue(point.ok, "pointing goes on")
    }

    func testTypeAndPasteNeverIntoAPassword() async throws {
        let typed = await run("desktop.type", ["text": "hello", "name": "Search"])
        XCTAssertEqual(typed.payload, ["typed": 5, "into": "Search"])
        XCTAssertEqual(fake.did.last, "type hello into Search")
        let refused = await run("desktop.type", ["text": "hunter2", "name": "Password"])
        XCTAssertEqual(refused.error, "the app never types into a password field")
        let pasteRefused = await run("desktop.paste", ["data": ["text": "hunter2"], "id": 5])
        XCTAssertEqual(pasteRefused.error, "the app never pastes into a password field")
        let pasted = await run("desktop.paste", ["data": ["text": .string(String(repeating: "x", count: 1000))]])
        XCTAssertEqual(pasted.payload, ["pasted": 1000])
        XCTAssertEqual(fake.did.last, "paste 1000 into focus")
        let long = await run("desktop.type", ["text": .string(String(repeating: "x", count: 501))])
        XCTAssertEqual(long.error, "at most 500 characters at a time")
        let empty = await run("desktop.type", ["text": ""])
        XCTAssertEqual(empty.error, "type needs text")
    }

    func testKeysMapCtrlToCmdAndRefuseTheBlockedChords() async throws {
        let save = await run("desktop.keys", ["keys": "ctrl+s"])
        XCTAssertEqual(save.payload, ["pressed": "cmd+s"])
        XCTAssertEqual(fake.did.last, "keys cmd+s")
        for (asked, said) in [("cmd+q", "cmd+q (quitting the app)"), ("ctrl+q", "cmd+q (quitting the app)"), ("cmd+option+escape", "option+cmd+escape (Force Quit)"),
                              ("ctrl+cmd+q", "ctrl+cmd+q (locking the screen)"), ("shift+cmd+q", "shift+cmd+q (logging out)"),
                              ("shift+opt+cmd+q", "option+shift+cmd+q (logging out)")] {
            let a = await run("desktop.keys", ["keys": .string(asked)])
            XCTAssertEqual(a.error, "the app never presses \(said)", asked)
        }
        let unknown = await run("desktop.keys", ["keys": "hyper+k"])
        XCTAssertEqual(unknown.error, "\"hyper\" is not a modifier (cmd, ctrl, option, shift, fn)")
        let printScreen = await run("desktop.keys", ["keys": "printscreen"])
        XCTAssertEqual(printScreen.error, "a Mac has no Print Screen key; use the screenshot action")
    }

    func testOpenSwitchWindowSpace() async throws {
        let opened = await run("desktop.open", ["app": "TextEdit"])
        XCTAssertEqual(opened.payload, ["opened": "TextEdit"])
        XCTAssertEqual(opened.data?["after"]?["window"], "Untitled (TextEdit)")
        XCTAssertEqual(opened.data?["after"]?["new"], true, "the window in front changed")
        let none = await run("desktop.open", ["app": "Ghost"])
        XCTAssertEqual(none.payload?["note"], "no window showed within 8 s; check before typing")
        let file = await run("desktop.open", ["url": "file:///etc/passwd"])
        XCTAssertEqual(file.error, "the app only opens http and https addresses")
        let both = await run("desktop.open", ["url": "https://example.org", "app": "Safari"])
        XCTAssertEqual(both.error, "open needs app or url")

        let switched = await run("desktop.switch", ["window": "notes"])
        XCTAssertEqual(switched.payload, ["window": "Notes (Notes) 5,6 700x500"])
        let move = await run("desktop.window", ["do": "move", "display": 0])
        XCTAssertEqual(move.error, "move needs display, 1 or more")
        let filled = await run("desktop.window", ["do": "maximize"])
        XCTAssertTrue(filled.ok)
        XCTAssertEqual(fake.did.last, "window maximize 0")
        let space = await run("desktop.desktop", ["go": "next"])
        XCTAssertEqual(space.payload, ["went": "next"])
        XCTAssertEqual(fake.did.last, "space next")
        let badSpace = await run("desktop.desktop", ["go": "up"])
        XCTAssertEqual(badSpace.error, "desktop needs go: next or previous")
    }

    /** The Windows app's 0.10.4 rule: after a scroll an id is read again; OCR text cannot be, and a look makes ids current. */
    func testIdsAfterAScroll() async throws {
        fake.elements.append(ScreenElement(kind: "text", name: "Total 42", x: 10, y: 700, w: 80, h: 16, source: "ocr"))
        fake.elements[2].ref = NSObject()  // "Send" has a platform handle; the OCR line has none
        _ = await run("desktop.look")
        let scrolled = await run("desktop.scroll", ["go": "down", "pages": 2])
        XCTAssertEqual(scrolled.payload, ["scrolled": "down", "how": "wheel"])
        XCTAssertEqual(fake.did.last, "scroll down 2 -")

        let ocr = await run("desktop.click", ["id": 8])
        XCTAssertEqual(ocr.error, "scrolled since the last look, so element 8 may have moved; look again")
        fake.refreshed = .some(ScreenElement(kind: "button", name: "Send", x: 900, y: 300, w: 80, h: 30))
        let moved = await run("desktop.click", ["id": 3])
        XCTAssertEqual(moved.payload?["y"], 315, "clicked where it is now")
        fake.refreshed = .some(nil)
        let gone = await run("desktop.click", ["id": 3])
        XCTAssertEqual(gone.error, "element 3 is off the screen since the scroll; look again")
        _ = await run("desktop.look")
        let fresh = await run("desktop.click", ["id": 8])
        XCTAssertTrue(fresh.ok, "a look makes the ids current again")

        let pages = await run("desktop.scroll", ["go": "sideways"])
        XCTAssertEqual(pages.error, "scroll needs go: up, down, left, right, top or bottom")
        _ = await run("desktop.scroll", ["go": "up", "pages": 99])
        XCTAssertEqual(fake.did.last, "scroll up 10 -", "pages are held to 10")
    }

    func testTheBlockListIsCheckedAgainBeforeEachStep() async throws {
        // The first step opens a blocked app; the second would type into it.
        let steps: JSONValue = ["steps": [["action": "open", "app": "KeePassXC"], ["action": "type", "text": "x"]]]
        fake.front = WindowInfo(title: "Inbox", app: "Mail", x: 0, y: 0, w: 100, h: 100)
        let a = await run("desktop.steps", ["data": steps, "blocked": "keepassxc"])
        XCTAssertFalse(a.ok)
        XCTAssertEqual(a.data?["done"], 1)
        XCTAssertEqual(a.data?["failed"], 2)
        XCTAssertTrue(a.error!.hasPrefix("step 2 (type) failed: the window in front is blocked by the user"), a.error!)
        XCTAssertFalse(fake.did.contains { $0.hasPrefix("type") }, "nothing was typed")
    }

    func testStepsReportEachAndStopAtTheFirstFailure() async throws {
        let steps: JSONValue = ["steps": [["action": "click", "name": "Send"], ["action": "keys", "keys": "enter"], ["action": "find", "name": "Delete"]]]
        let a = await run("desktop.steps", ["data": steps])
        XCTAssertTrue(a.ok, a.error ?? "")
        XCTAssertEqual(a.data?["done"], 3)
        XCTAssertEqual(a.data?["steps"]?.arrayValue?[1]["pressed"], "enter")
        XCTAssertEqual(a.data?["steps"]?.arrayValue?[2]["matches"]?.arrayValue?.count, 2)
        XCTAssertNotNil(a.data?["after"], "steps change the screen: after is added")
        let bad = await run("desktop.steps", ["data": ["steps": [["action": "look"]]]])
        XCTAssertEqual(bad.error, "step 1 (look) failed: look cannot be a step")
        let tooMany = await run("desktop.steps", ["data": ["steps": .array(Array(repeating: ["action": "wait", "ms": 50], count: 11))]])
        XCTAssertEqual(tooMany.error, "at most 10 steps in one call")
    }

    func testWaitClipboardScreenshot() async throws {
        let waited = await run("desktop.wait", ["window": "notes", "seconds": 1])
        XCTAssertTrue(waited.ok)
        XCTAssertNotNil(waited.payload?["waited"])
        let never = await run("desktop.wait", ["window": "Ghost", "seconds": 1])
        XCTAssertEqual(never.error, "window \"Ghost\" did not open after 1 s")
        let fixed = await run("desktop.wait", ["ms": 50])
        XCTAssertTrue(fixed.ok)

        let copied = await run("desktop.clipboard")
        XCTAssertEqual(copied.data?["clipboard"], "hello")
        fake.clipboard = (nil, "what is on the clipboard is marked private (a password manager put it there); not read")
        let secret = await run("desktop.clipboard")
        XCTAssertEqual(secret.data?["clipboard"], JSONValue.null)

        let off = await run("desktop.screenshot")
        XCTAssertEqual(off.error, "screenshots are switched off for this computer (admin page, the computer's settings)")
        commands.useSettings(["allowScreenshot": "1"])
        let shot = await run("desktop.screenshot", ["detail": "low"])
        XCTAssertEqual(shot.data?["picture"], "640x427 of 0,0 1200x800")
        XCTAssertEqual(shot.data?["image"]?["mimeType"], "image/jpeg")
        XCTAssertEqual(shot.data?["image"]?["data"], "AQID")
        XCTAssertEqual(fake.did.last, "shot window - 640")
        let badDetail = await run("desktop.screenshot", ["detail": "ultra"])
        XCTAssertEqual(badDetail.error, "detail must be low, normal or high")
    }

    func testDrag() async throws {
        let a = await run("desktop.drag", ["name": "Send", "toX": 10, "toY": 20, "holdMs": 5000])
        XCTAssertEqual(a.payload, ["x": 940, "y": 615, "toX": 10, "toY": 20, "how": "mouse", "name": "Send"])
        XCTAssertEqual(fake.did.last, "drag 940,615 10,20 2000", "the hold is held to 2 s")
        let noTo = await run("desktop.drag", ["x": 1, "y": 1])
        XCTAssertEqual(noTo.error, "drag needs where to: toName, toId, or toX and toY")
    }

    func testWindowListFlagsOtherSpaces() async throws {
        fake.screenWindows.append(ScreenElement(kind: "window", name: "Remote (Windows App)", x: 0, y: 33, w: 1470, h: 923, value: "on another Space, or minimised"))
        let list = await run("desktop.window", ["do": "list"])
        XCTAssertEqual(list.data?["windows"]?.arrayValue?.last, "Remote (Windows App) 0,33 1470x923 (on another Space, or minimised)")
    }
}

final class KeyComboTests: XCTestCase {
    func combo(_ s: String) throws -> String { try KeyCombo.parse(s).description }

    func testCtrlIsCmdForTheCommonShortcuts() throws {
        for k in ["s", "c", "v", "x", "a", "z", "f", "t", "w", "n", "o", "p", "r", "l", "k", "b", "i", "u", "/", "[", "]", "0"] {
            XCTAssertEqual(try combo("ctrl+\(k)"), "cmd+\(k)", k)
        }
        XCTAssertEqual(try combo("Ctrl+Shift+T"), "shift+cmd+t", "other modifiers are kept")
        XCTAssertEqual(try combo("ctrl+comma"), "cmd+,")
        XCTAssertEqual(try combo("ctrl+plus"), "cmd+=", "zoom in")
        XCTAssertEqual(try combo("ctrl++"), "cmd+=", "the plus key itself")
        XCTAssertEqual(try combo("ctrl+minus"), "cmd+-")
        XCTAssertEqual(try combo("ctrl+equals"), "cmd+=")
        XCTAssertEqual(try combo("ctrl+y"), "shift+cmd+z", "redo")
    }

    func testCtrlStaysControlWhereThatIsMeant() throws {
        XCTAssertEqual(try combo("ctrl+tab"), "ctrl+tab")
        XCTAssertEqual(try combo("ctrl+shift+tab"), "ctrl+shift+tab")
        XCTAssertEqual(try combo("ctrl+left"), "ctrl+left")
        XCTAssertEqual(try combo("ctrl+space"), "ctrl+space")
        XCTAssertEqual(try combo("ctrl+e"), "ctrl+e", "a letter not in the table")
        XCTAssertEqual(try combo("control+a"), "ctrl+a", "spelled out: the Control key itself")
        XCTAssertEqual(try combo("ctrl+cmd+f"), "ctrl+cmd+f", "nothing is mapped when cmd is asked for")
    }

    func testModifiersAndKeys() throws {
        XCTAssertEqual(try combo("cmd+l"), "cmd+l")
        XCTAssertEqual(try combo("command+option+i"), "option+cmd+i")
        XCTAssertEqual(try combo("alt+f4"), "option+f4")
        XCTAssertEqual(try combo("win+e"), "cmd+e", "the Windows key is cmd")
        XCTAssertEqual(try combo("fn+f11"), "fn+f11")
        XCTAssertEqual(try combo("Return"), "enter")
        XCTAssertEqual(try combo("esc"), "escape")
        XCTAssertEqual(try combo("del"), "delete")
        XCTAssertEqual(try combo("pgdn"), "pagedown")
        XCTAssertEqual(try combo("F20"), "f20")
        XCTAssertEqual(try combo("shift+!"), "shift+!")
        XCTAssertThrowsError(try KeyCombo.parse("f21"))
        XCTAssertThrowsError(try KeyCombo.parse(""))
        XCTAssertThrowsError(try KeyCombo.parse("ctrl+"))
        XCTAssertThrowsError(try KeyCombo.parse("volumeup"))
        XCTAssertThrowsError(try KeyCombo.parse("insert"))
        XCTAssertThrowsError(try KeyCombo.parse("menu"))
        XCTAssertThrowsError(try KeyCombo.parse("cmd+é"), "printable ASCII keys only")
    }

    func testBlocked() throws {
        func why(_ s: String) throws -> String? { try KeyCombo.parse(s).blocked() }
        XCTAssertEqual(try why("cmd+q"), "quitting the app")
        XCTAssertEqual(try why("ctrl+q"), "quitting the app", "ctrl+q becomes cmd+q, which is refused")
        XCTAssertEqual(try why("ctrl+cmd+q"), "locking the screen")
        XCTAssertEqual(try why("control+command+q"), "locking the screen")
        XCTAssertEqual(try why("shift+cmd+q"), "logging out")
        XCTAssertEqual(try why("shift+option+cmd+q"), "logging out")
        XCTAssertEqual(try why("cmd+option+esc"), "Force Quit")
        XCTAssertNil(try why("cmd+w"), "closing a tab is allowed, as ctrl+w on Windows")
        XCTAssertNil(try why("option+escape"))
        XCTAssertNil(try why("control+q"), "the Control key with q is not quitting")
    }
}

final class WindowPickTests: XCTestCase {
    let air = [Display(x: 0, y: 0, w: 1470, h: 956, primary: true)]

    func w(_ pid: Int32, _ owner: String, _ title: String, _ box: Box, number: Int = 0, layer: Int = 0, onScreen: Bool = true) -> WindowCandidate {
        WindowCandidate(number: number, pid: pid, owner: owner, title: title, box: box, layer: layer, onScreen: onScreen)
    }

    /** The live test: Brave's helper strip came first in Quartz's list and was taken for the window. */
    func testTheFrontWindowIsAccessibilitysNotAHelperStrip() {
        let list = [
            w(10, "Brave Browser", "", Box(x: 241, y: 33, w: 1470, h: 40)),
            w(10, "Brave Browser", "Axis - Brave", Box(x: 0, y: 114, w: 1470, h: 842)),
            w(20, "Terminal", "zsh", Box(x: 100, y: 100, w: 600, h: 400)),
        ]
        let focused = FocusedWindow(title: "Axis - Brave", box: Box(x: 0, y: 114, w: 1470, h: 842))
        let front = WindowPick.front(pid: 10, focused: focused, list: list, displays: air)
        XCTAssertEqual(front?.box, Box(x: 0, y: 114, w: 1470, h: 842))
        XCTAssertEqual(front?.title, "Axis - Brave")
        // Without Accessibility's answer, Quartz's first *normal* window of the app: never the 40-high strip.
        let fallback = WindowPick.front(pid: 10, focused: nil, list: list, displays: air)
        XCTAssertEqual(fallback?.box, Box(x: 0, y: 114, w: 1470, h: 842))
        // A strip off to the left of every display is not a window either.
        XCTAssertFalse(WindowPick.normal(w(10, "Brave Browser", "", Box(x: -1405, y: 33, w: 1470, h: 40)), displays: air))
    }

    /** The live test: Finder's desktop reported as the front window `0,0 0x0` while Terminal was under the mouse. */
    func testNoDesktopAndNoZeroWindow() {
        let list = [w(20, "Terminal", "zsh", Box(x: 100, y: 100, w: 600, h: 400)), w(30, "Finder", "", Box(x: 0, y: 0, w: 0, h: 0))]
        XCTAssertNil(WindowPick.front(pid: 30, focused: nil, list: list, displays: air), "Finder with only its desktop: no front window")
        XCTAssertNil(WindowPick.front(pid: 30, focused: FocusedWindow(title: "", box: Box(x: 0, y: 0, w: 0, h: 0)), list: list, displays: air))
        XCTAssertEqual(WindowPick.front(pid: 20, focused: nil, list: list, displays: air)?.title, "zsh")
        XCTAssertNil(WindowPick.front(pid: nil, focused: nil, list: list, displays: air))
    }

    func testAMinimisedOrElsewhereFocusedWindowIsNotTheFront() {
        let list = [w(20, "Terminal", "zsh", Box(x: 100, y: 100, w: 600, h: 400))]
        let minimised = FocusedWindow(title: "old", box: Box(x: 0, y: 0, w: 800, h: 600), minimised: true)
        XCTAssertEqual(WindowPick.front(pid: 20, focused: minimised, list: list, displays: air)?.title, "zsh", "a minimised focus: Quartz's window instead")
        // The app has no window on this Space: whatever AX says, nothing.
        XCTAssertNil(WindowPick.front(pid: 40, focused: FocusedWindow(title: "Remote", box: Box(x: 0, y: 33, w: 1470, h: 923)), list: list, displays: air))
    }

    func testTheAppsOwnWindowIsSkipped() {
        let list = [w(99, "VorteX Axis", "VorteX Axis", Box(x: 400, y: 200, w: 460, h: 520)), w(20, "Terminal", "zsh", Box(x: 100, y: 100, w: 600, h: 400))]
        let front = WindowPick.front(pid: 99, focused: nil, list: list, displays: air, ownPid: 99)
        XCTAssertEqual(front?.pid, 20, "with its own window in front, the next app's window is the one an agent means")
    }

    func testTheTitleComesFromQuartzWhenAccessibilityHasNone() {
        let list = [w(10, "Notes", "Shopping", Box(x: 10, y: 40, w: 800, h: 600))]
        let front = WindowPick.front(pid: 10, focused: FocusedWindow(title: "", box: Box(x: 11, y: 41, w: 799, h: 600)), list: list, displays: air)
        XCTAssertEqual(front?.title, "Shopping")
        XCTAssertEqual(front?.box, Box(x: 11, y: 41, w: 799, h: 600), "the box is still Accessibility's")
    }

    /** The live test: the list had only the current Space's (full-screen) windows. */
    func testTheListHasEverySpace() {
        let here = [w(1, "Code", "main.swift", Box(x: 0, y: 33, w: 1470, h: 923), number: 1),
                    w(2, "Discord", "", Box(x: 50, y: 50, w: 900, h: 700), number: 2),
                    w(3, "Window Server", "", Box(x: 0, y: 0, w: 1470, h: 33), number: 3, layer: 25)]
        let all = here + [w(4, "Windows App", "Remote", Box(x: 0, y: 0, w: 1470, h: 956), number: 4, onScreen: false),
                          w(5, "Brave Browser", "", Box(x: 0, y: 0, w: 900, h: 700), number: 5, onScreen: false),
                          w(1, "Code", "main.swift", Box(x: 0, y: 33, w: 1470, h: 923), number: 1)]
        let listed = WindowPick.listed(onScreen: here, all: all, displays: air)
        XCTAssertEqual(listed.map { $0.window.name }, ["main.swift (Code)", "Discord", "Remote (Windows App)"])
        XCTAssertEqual(listed.map { $0.here }, [true, true, false])
    }

    func testFindByAppOrTitle() {
        let list = [w(1, "Code", "notes.md", Box(x: 0, y: 0, w: 900, h: 700)), w(2, "Notes", "Shopping", Box(x: 0, y: 0, w: 900, h: 700))]
        XCTAssertEqual(WindowPick.find("notes", in: list)?.pid, 2, "the app's name scores 5 more than a title")
        XCTAssertEqual(WindowPick.find("shopping", in: list)?.pid, 2)
        XCTAssertEqual(WindowPick.find("code", in: list)?.pid, 1)
        XCTAssertNil(WindowPick.find("slack", in: list))
    }
}

final class InputGeometryTests: XCTestCase {
    /** A main display 1440x900, one above and left of it (1920x1080), one to its right (1280x800). */
    let displays = [Display(x: 0, y: 0, w: 1440, h: 900, primary: true), Display(x: -1920, y: -1080, w: 1920, h: 1080, primary: false),
                    Display(x: 1440, y: 0, w: 1280, h: 800, primary: false)]

    func testWhichDisplayAPointIsOn() {
        XCTAssertEqual(Coordinates.display(at: 0, 0, in: displays), 0)
        XCTAssertEqual(Coordinates.display(at: 1439, 899, in: displays), 0)
        XCTAssertEqual(Coordinates.display(at: 1440, 10, in: displays), 2, "a display's right edge is the next one's left")
        XCTAssertEqual(Coordinates.display(at: -1, -1, in: displays), 1, "above and left: negative both ways")
        XCTAssertEqual(Coordinates.display(at: -1920, -1080, in: displays), 1)
        XCTAssertNil(Coordinates.display(at: 1500, 850, in: displays), "below the shorter right-hand display: on none")
        XCTAssertNil(Coordinates.display(at: 0, -1, in: [displays[0]]))
    }

    func testMovingAWindowToADisplay() {
        let area = Box(x: 1440, y: 25, w: 1280, h: 775)
        XCTAssertEqual(Coordinates.centred(Box(x: 0, y: 0, w: 800, h: 600), in: area), Box(x: 1680, y: 112, w: 800, h: 600))
        XCTAssertEqual(Coordinates.centred(Box(x: 0, y: 0, w: 2000, h: 1200), in: area), area, "too big: shrunk to the area")
    }

    func testPictureSizes() {
        let window = Box(x: 0, y: 114, w: 1470, h: 842)
        let low = Coordinates.pictureSize(area: window, pixelsPerPoint: 2, maxSide: 640)
        XCTAssertEqual(low.w, 640)
        XCTAssertEqual(low.h, 367)
        let high = Coordinates.pictureSize(area: window, pixelsPerPoint: 2, maxSide: 1568)
        XCTAssertEqual(high.w, 1568)
        let small = Coordinates.pictureSize(area: Box(x: 0, y: 0, w: 300, h: 100), pixelsPerPoint: 2, maxSide: 1568)
        XCTAssertEqual(small.w, 600, "never sharper than the screen: 2 pixels a point on Retina")
        XCTAssertEqual(small.k, 2)
    }

    func testScrolling() {
        XCTAssertEqual(Scrolling.wheel(go: "down", pages: 1, width: 1000, height: 800).wheel1, -680, "down is negative, 85% of a page")
        XCTAssertEqual(Scrolling.wheel(go: "up", pages: 2, width: 1000, height: 800).wheel1, 1360)
        XCTAssertEqual(Scrolling.wheel(go: "right", pages: 1, width: 1000, height: 800).wheel2, -850)
        XCTAssertEqual(Scrolling.wheel(go: "left", pages: 1, width: 1000, height: 800).wheel1, 0)
        XCTAssertEqual(Scrolling.wheel(go: "top", pages: 1, width: 1, height: 1).wheel1, Scrolling.farPixels)
        XCTAssertEqual(Scrolling.wheel(go: "down", pages: 1, width: 10, height: 10).wheel1, -40, "at least 40 points")

        XCTAssertEqual(Scrolling.barValue(current: 0.5, go: "top", pages: 1, visible: 500, content: 5000), 0)
        XCTAssertEqual(Scrolling.barValue(current: 0.5, go: "bottom", pages: 1, visible: 500, content: 5000), 1)
        let next = Scrolling.barValue(current: 0, go: "down", pages: 1, visible: 500, content: 1500)!
        XCTAssertEqual(next, 0.425, accuracy: 0.0001, "85% of 500 points of the 1000 that can scroll")
        XCTAssertEqual(Scrolling.barValue(current: 0.9, go: "down", pages: 3, visible: 500, content: 1500), 1, "held at the end")
        XCTAssertEqual(Scrolling.barValue(current: 0.1, go: "up", pages: 1, visible: 500, content: 1500), 0)
        XCTAssertNil(Scrolling.barValue(current: 0, go: "down", pages: 1, visible: 500, content: 400), "nothing to scroll")
    }

    /** The browser-bar guard knows the Mac browsers the live test used, by name and by bundle id. */
    func testTheChromeBandWithMacBrowsers() {
        let page = Box(x: 0, y: 200, w: 1470, h: 756)
        for (app, bundle) in [("Brave Browser", "com.brave.Browser"), ("Arc", "company.thebrowser.Browser"), ("Google Chrome", "com.google.Chrome"),
                              ("Safari", "com.apple.Safari"), ("Microsoft Edge", "com.microsoft.edgemac"), ("Firefox", "org.mozilla.firefox")] {
            let window = WindowInfo(title: "x", app: app, x: 0, y: 114, w: 1470, h: 842, bundleID: bundle)
            XCTAssertNotNil(Geometry.chromeRefusal(window, y: 150, inPage: true, page: page), app)
            XCTAssertNil(Geometry.chromeRefusal(window, y: 150, inPage: false, page: nil), "\(app): its own address bar is clicked")
            XCTAssertNil(Geometry.chromeRefusal(window, y: 250, inPage: true, page: page), "\(app): below the band")
        }
        let terminal = WindowInfo(title: "zsh", app: "Terminal", x: 0, y: 114, w: 1470, h: 842, bundleID: "com.apple.Terminal")
        XCTAssertNil(Geometry.chromeRefusal(terminal, y: 150, inPage: true, page: page))
    }
}
