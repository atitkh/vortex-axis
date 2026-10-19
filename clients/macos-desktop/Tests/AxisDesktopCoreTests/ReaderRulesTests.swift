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
            ("AXMenuBarItem", nil, nil, "menubaritem"),
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
        for k in ["password", "document", "edit", "combobox", "window", "button", "hyperlink"] { XCTAssertTrue(all.contains(k), k) }
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
