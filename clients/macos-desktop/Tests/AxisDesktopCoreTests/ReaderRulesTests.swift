import XCTest
@testable import AxisDesktopCore

final class AXKindsTests: XCTestCase {
    func testTheWindowsVocabulary() {
        let cases: [(String, String?, String?, String)] = [
            ("AXButton", nil, nil, "button"),
            ("AXTextField", nil, nil, "edit"),
            ("AXTextField", "AXSecureTextField", nil, "password"),
            ("AXTextField", "AXSearchField", nil, "edit"),
            ("AXTextArea", nil, nil, "edit"),
            ("AXComboBox", nil, nil, "combobox"),
            ("AXPopUpButton", nil, nil, "combobox"),
            ("AXCheckBox", nil, nil, "checkbox"),
            ("AXCheckBox", "AXSwitch", nil, "checkbox"),
            ("AXRadioButton", nil, nil, "radiobutton"),
            ("AXRadioButton", "AXTabButton", nil, "tabitem"),
            ("AXLink", nil, nil, "hyperlink"),
            ("AXMenuItem", nil, nil, "menuitem"),
            ("AXMenuBarItem", nil, nil, "menuitem"),
            ("AXRadioButton", nil, "AXTabGroup", "tabitem"),
            ("AXPopUpButton", nil, nil, "combobox"),
            ("AXSearchField", nil, nil, "edit"),
            ("AXButton", "AXCloseButton", nil, "button"),
            ("AXWebArea", nil, nil, "document"),
            ("AXWindow", "AXStandardWindow", nil, "window"),
            ("AXSheet", nil, nil, "window"),
            ("AXRow", nil, "AXOutline", "treeitem"),
            ("AXRow", nil, "AXTable", "listitem"),
            ("AXRow", "AXOutlineRow", "AXTable", "treeitem"),
            ("AXCell", nil, nil, "dataitem"),
            ("AXSlider", nil, nil, "slider"),
            ("AXIncrementor", nil, nil, "spinner"),
            ("AXStaticText", nil, nil, "text"),
            ("AXGroup", nil, nil, "group"),
            ("AXScrollArea", nil, nil, "pane"),
            ("AXSplitGroup", nil, nil, "pane"),
            ("AXRuler", nil, nil, "ruler"),
            ("AXSome Odd-Role", nil, nil, "someoddrole"),
            ("", nil, nil, "custom"),
        ]
        for (role, subrole, parent, kind) in cases {
            XCTAssertEqual(AXKinds.kind(role: role, subrole: subrole, parentRole: parent), kind, "\(role) \(subrole ?? "")")
        }
    }

    /** Axis reads element lines with `^(\d+) \S+ ...`: a kind with a space would break its risk checks. */
    func testEveryKindIsOneToken() {
        let kinds = Array(AXKinds.byRole.values) + Array(AXKinds.bySubrole.values)
        for k in kinds {
            XCTAssertFalse(k.isEmpty)
            XCTAssertNil(k.rangeOfCharacter(from: .whitespacesAndNewlines), "\(k) has a space")
            XCTAssertEqual(k, k.lowercased())
        }
    }

    /** Core's guards key on these: a mapping that never yields them would silently switch a guard off. */
    func testTheKindsCoreActsOnAreReachable() {
        let all = Set(AXKinds.byRole.values).union(AXKinds.bySubrole.values)
        for k in ["password", "document", "edit", "combobox", "window", "button", "hyperlink", "menuitem", "checkbox", "tabitem"] {
            XCTAssertTrue(all.contains(k), k)
        }
    }

    /** The tool's kind hints (button, edit, hyperlink, menuitem...) are the only names an agent passes; no Mac-only spellings. */
    func testNoMacOnlySpellingsOfTheToolsKinds() {
        let all = Set(AXKinds.byRole.values).union(AXKinds.bySubrole.values)
        for k in ["menubaritem", "textfield", "link", "popupbutton", "statictext", "webarea"] { XCTAssertFalse(all.contains(k), k) }
    }
}

final class ReadingOrderTests: XCTestCase {
    func e(_ name: String, _ x: Int, _ y: Int, w: Int = 50, h: Int = 20) -> ScreenElement {
        ScreenElement(kind: "button", name: name, x: x, y: y, w: w, h: h)
    }

    func testTopToBottomThenLeftToRight() {
        let sorted = ReadingOrder.sort([e("C", 10, 100), e("B", 200, 12), e("A", 10, 10), e("D", 100, 103)])
        XCTAssertEqual(sorted.map(\.name), ["A", "B", "C", "D"], "tops within 6 pt are one line")
    }

    func testStableForTies() {
        let sorted = ReadingOrder.sort([e("first", 10, 10), e("second", 10, 10)])
        XCTAssertEqual(sorted.map(\.name), ["first", "second"])
    }

    func testOnePerBox() {
        let kept = ReadingOrder.dedupe([e("Send", 10, 10), e("Send label", 10, 10), e("Other", 10, 40)])
        XCTAssertEqual(kept.map(\.name), ["Send", "Other"], "the first one with a box stays (the control before its own label)")
    }

    func k(_ kind: String, _ name: String, _ x: Int, _ y: Int, _ w: Int, _ h: Int, focused: Bool = false, source: String = "ui") -> ScreenElement {
        ScreenElement(kind: kind, name: name, x: x, y: y, w: w, h: h, focused: focused, source: source)
    }

    /** The 0.2.0 live test on a Wikipedia page: `hyperlink Contents`, `text Contents`, `group Contents`. */
    func testEchoesOfALinkGo() {
        let list = [k("group", "Contents", 0, 95, 300, 40), k("hyperlink", "Contents", 10, 100, 80, 20), k("text", "Contents", 12, 102, 60, 16)]
        XCTAssertEqual(ReadingOrder.dropEchoes(list).map(\.kind), ["hyperlink"])
        let logo = [k("hyperlink", "Wikipedia The Free Encyclopedia", 0, 0, 160, 50), k("image", "Wikipedia", 0, 0, 50, 50)]
        XCTAssertEqual(ReadingOrder.dropEchoes(logo).map(\.kind), ["hyperlink"], "an image named with part of the link's name")
    }

    func testWhatIsNotAnEchoStays() {
        let list = [k("button", "Send", 10, 10, 80, 30), k("text", "3 new messages", 12, 12, 60, 20),
                    k("hyperlink", "Contents", 10, 100, 80, 20), k("text", "Contents", 10, 300, 80, 20),
                    k("group", "Sidebar", 0, 0, 300, 400), k("text", "Help", 400, 10, 40, 20)]
        XCTAssertEqual(ReadingOrder.dropEchoes(list).count, list.count, "another name, outside the control, or a group named for none inside it")
        let focused = [k("hyperlink", "Edit", 0, 0, 80, 20), k("text", "Edit", 2, 2, 40, 16, focused: true)]
        XCTAssertEqual(ReadingOrder.dropEchoes(focused).count, 2, "the focus always stays")
        let ocr = [k("hyperlink", "Edit", 0, 0, 80, 20), k("text", "Edit", 2, 2, 40, 16, source: "ocr")]
        XCTAssertEqual(ReadingOrder.dropEchoes(ocr).count, 2, "OCR lines are never touched")
        let window = [k("window", "Inbox", 0, 0, 800, 600), k("group", "Inbox", 0, 0, 800, 600), k("text", "Inbox", 10, 10, 50, 20)]
        XCTAssertEqual(ReadingOrder.dropEchoes(window).map(\.kind), ["window", "text"], "a group named as the text in it goes; the window stays")
    }

    /** The 0.2.1 live test: `text 264,156 153x8`, a line half under Brave's toolbar. */
    func testSliversGo() {
        let list = [k("window", "Wikipedia", 0, 33, 1470, 923), k("text", "Half hidden", 264, 156, 153, 8), k("hyperlink", "Thin", 10, 300, 6, 30),
                    k("text", "Whole", 264, 200, 153, 18), k("text", "Focused sliver", 10, 400, 100, 4, focused: true),
                    k("text", "ocr line", 10, 500, 100, 8, source: "ocr"), k("edit", "", 10, 600, 200, 6)]
        XCTAssertEqual(ReadingOrder.dropNoise(list).map(\.name), ["Wikipedia", "Whole", "Focused sliver", "ocr line", ""],
                       "under 10 pt either way goes; the window, the focus, OCR and fields stay")
    }

    func testNarrowGroupsAndGlossesGo() {
        let list = [k("group", "Search", 10, 10, 14, 40), k("group", "B", 100, 10, 60, 40),
                    k("group", "/ˈwɪkiˌpiːdi.ə/", 200, 10, 120, 20), k("text", "ˈwɪkiˌpiːdi.ə", 202, 12, 110, 16),
                    k("group", "Wikipedia", 400, 10, 120, 20), k("text", "Wiki", 402, 12, 40, 16), k("text", "pedia", 442, 12, 50, 16),
                    k("group", "Main menu", 600, 10, 200, 300), k("hyperlink", "Home", 610, 20, 80, 20)]
        XCTAssertEqual(ReadingOrder.dropNoise(list).map(\.name), ["ˈwɪkiˌpiːdi.ə", "Wiki", "pedia", "Main menu", "Home"],
                       "a group under 20 pt wide, of one letter, or only repeating the text in it goes; a group named for itself stays")
    }

    /** Two `text Contents` on the same spot. */
    func testDoubleLinesGo() {
        let list = [k("text", "Contents", 10, 100, 80, 20), k("text", "Contents", 12, 102, 60, 16), k("text", "Contents", 10, 300, 80, 20),
                    k("hyperlink", "Contents", 10, 100, 80, 20)]
        XCTAssertEqual(ReadingOrder.dropNoise(list).map { "\($0.kind) \($0.y)" }, ["text 100", "text 300", "hyperlink 100"],
                       "the same kind and name, one box inside the other: the first stays; elsewhere, or another kind, stays")
        let focused = [k("text", "Contents", 10, 100, 80, 20), k("text", "Contents", 12, 102, 60, 16, focused: true)]
        XCTAssertEqual(ReadingOrder.dropNoise(focused).count, 2, "the focus always stays")
    }
}

final class AddressTests: XCTestCase {
    func testTheWindowsRules() throws {
        let lan = try AxisAddress.parse("192.168.1.20:8440")
        XCTAssertEqual(lan.description, "http://192.168.1.20:8440", "a bare host:port is plain http")
        XCTAssertEqual(lan.socket.absoluteString, "ws://192.168.1.20:8440/v1/client")
        XCTAssertEqual(lan.pair.absoluteString, "http://192.168.1.20:8440/v1/pair")

        let named = try AxisAddress.parse("axis.example.org")
        XCTAssertEqual(named.description, "https://axis.example.org", "a bare name is https")
        XCTAssertEqual(named.socket.absoluteString, "wss://axis.example.org/v1/client")

        let setup = try AxisAddress.parse("axis://192.168.1.20:8440/123-456")
        XCTAssertEqual(setup.description, "http://192.168.1.20:8440")
        XCTAssertEqual(setup.code, "123-456")

        let tls = try AxisAddress.parse(" axis+tls://axis.example.org/987-654/ ")
        XCTAssertEqual(tls.description, "https://axis.example.org")
        XCTAssertEqual(tls.code, "987-654")

        XCTAssertEqual(try AxisAddress.parse("https://axis.example.org:443/admin").description, "https://axis.example.org", "the usual port and a path go")
        XCTAssertEqual(try AxisAddress.parse("http://axis.example.org:8440").description, "http://axis.example.org:8440", "an explicit scheme wins")
        XCTAssertNil(try AxisAddress.parse("axis://axis.example.org/").code)
        XCTAssertThrowsError(try AxisAddress.parse("  "))
        XCTAssertThrowsError(try AxisAddress.parse("http://"))
    }
}

final class JSONValueTests: XCTestCase {
    func testRoundTripAndWholeNumbers() throws {
        let v = try JSONValue.parse(#"{"a":1,"b":true,"c":"x","d":[null,2.5],"e":{"f":false}}"#)
        XCTAssertEqual(v["a"], .number(1))
        XCTAssertEqual(v["b"], .bool(true), "true is not read as 1")
        XCTAssertEqual(v["d"], .array([.null, .number(2.5)]))
        XCTAssertEqual(v["e"]?["f"], .bool(false))
        XCTAssertEqual(try JSONValue.parse(try v.encoded()), v)
        XCTAssertEqual(String(decoding: try JSONValue.int(44).encoded(), as: UTF8.self), "44", "whole numbers go without .0")
        XCTAssertEqual(JSONValue.number(2.6).intValue, 3)
    }
}
