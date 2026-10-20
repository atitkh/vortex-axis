import XCTest
@testable import AxisDesktopCore

/** The pointer: how long an action waits for it, and where its bubble goes (every edge and corner, a display above and left, the notch). */
final class PointerTests: XCTestCase {
    let main = PanelRect(x: 0, y: 0, w: 1440, h: 900)
    /** A display above and left of the main one: negative coordinates. */
    let upLeft = PanelRect(x: -1920, y: -1080, w: 1920, h: 1080)
    /** A MacBook with a notch 32 points tall. */
    let notched = PanelRect(x: 0, y: 0, w: 1512, h: 982)
    let w = 300.0, h = 60.0, size = 44.0

    func place(_ x: Double, _ y: Double, on d: PanelRect, safeTop: Double = 0, w: Double? = nil, h: Double? = nil) -> PointerLayout.BubblePlace {
        PointerLayout.bubble(tipX: x, tipY: y, size: size, w: w ?? self.w, h: h ?? self.h, display: d, safeTop: safeTop)
    }

    /** Inside the display (an edge's width in), off the tip, and off the arrow's body below and right of it. */
    func assertGood(_ p: PointerLayout.BubblePlace, tip: (Double, Double), on d: PanelRect, safeTop: Double = 0,
                    file: StaticString = #filePath, line: UInt = #line) {
        let e = PointerLayout.edge
        XCTAssertGreaterThanOrEqual(p.x, d.x + e, "left edge", file: file, line: line)
        XCTAssertLessThanOrEqual(p.x + w, d.maxX - e, "right edge", file: file, line: line)
        XCTAssertGreaterThanOrEqual(p.y, d.y + safeTop + e, "top edge", file: file, line: line)
        XCTAssertLessThanOrEqual(p.y + h, d.maxY - e, "bottom edge", file: file, line: line)
        XCTAssertFalse(PointerLayout.covers(x: p.x, y: p.y, w: w, h: h, tipX: tip.0, tipY: tip.1), "covers the tip", file: file, line: line)
        let body = PanelRect(x: tip.0, y: tip.1, w: size * 0.5, h: size * 0.8)
        let apart = p.x >= body.maxX || p.x + w <= body.x || p.y >= body.maxY || p.y + h <= body.y
        XCTAssertTrue(apart, "covers the arrow", file: file, line: line)
    }

    // MARK: Waiting

    func testAnActionWaitsForTheGlideOrAMoment() {
        XCTAssertEqual(PointerLayout.glideMs, 220)
        XCTAssertEqual(PointerLayout.waitMs(glides: true), 250)
        XCTAssertEqual(PointerLayout.waitMs(glides: false), 100)
    }

    func testTheArrowFollowsThePointerSizeSetting() {
        XCTAssertEqual(PointerLayout.length(size: 44), 44)
        XCTAssertEqual(PointerLayout.length(size: 10), 24)
        XCTAssertEqual(PointerLayout.length(size: 500), 120)
        XCTAssertEqual(PointerLayout.arrow.first?.x, 0)
        XCTAssertEqual(PointerLayout.arrow.first?.y, 0)
    }

    // MARK: The bubble

    func testRightAndBelowWhenThereIsRoom() {
        let p = place(720, 450, on: main)
        XCTAssertEqual(p, PointerLayout.BubblePlace(x: 720 + 44 * 0.6 + 8, y: 450 + 44 * 0.9, right: true, below: true))
        assertGood(p, tip: (720, 450), on: main)
    }

    func testEveryCorner() {
        let corners: [(Double, Double, Bool, Bool)] = [(0, 0, true, true), (1439, 0, false, true), (0, 899, true, false), (1439, 899, false, false)]
        for (x, y, right, below) in corners {
            let p = place(x, y, on: main)
            XCTAssertEqual(p.right, right, "\(x),\(y)")
            XCTAssertEqual(p.below, below, "\(x),\(y)")
            assertGood(p, tip: (x, y), on: main)
        }
        let topRight = place(1439, 0, on: main)
        XCTAssertEqual(topRight.x, 1439 - 14 - w)
        let bottomLeft = place(0, 899, on: main)
        XCTAssertEqual(bottomLeft.y, 899 - 14 - h)
    }

    func testEveryEdge() {
        let edges: [(Double, Double, Bool, Bool)] = [(0, 450, true, true), (1439, 450, false, true), (720, 0, true, true), (720, 899, true, false)]
        for (x, y, right, below) in edges {
            let p = place(x, y, on: main)
            XCTAssertEqual(p.right, right, "\(x),\(y)")
            XCTAssertEqual(p.below, below, "\(x),\(y)")
            assertGood(p, tip: (x, y), on: main)
        }
    }

    func testEverywhereOnTheDisplay() {
        for d in [main, upLeft, notched] {
            for fx in stride(from: 0.0, through: 1.0, by: 0.05) {
                for fy in stride(from: 0.0, through: 1.0, by: 0.05) {
                    let x = min(d.x + fx * d.w, d.maxX - 1), y = min(d.y + fy * d.h, d.maxY - 1)
                    let safe = d == notched ? 32.0 : 0
                    assertGood(place(x, y, on: d, safeTop: safe), tip: (x, y), on: d, safeTop: safe)
                }
            }
        }
    }

    func testADisplayAboveAndLeftOfTheMainOne() {
        let topLeft = place(-1920, -1080, on: upLeft)
        XCTAssertEqual(topLeft, PointerLayout.BubblePlace(x: -1920 + 44 * 0.6 + 8, y: -1080 + 44 * 0.9, right: true, below: true))
        let bottomRight = place(-1, -1, on: upLeft)
        XCTAssertEqual(bottomRight, PointerLayout.BubblePlace(x: -1 - 14 - w, y: -1 - 14 - h, right: false, below: false))
        for (x, y) in [(-1920.0, -1.0), (-1.0, -1080.0), (-960.0, -540.0)] {
            assertGood(place(x, y, on: upLeft), tip: (x, y), on: upLeft)
        }
    }

    func testNeverIntoTheNotch() {
        let p = place(756, 0, on: notched, safeTop: 32)
        XCTAssertTrue(p.below)
        XCTAssertEqual(p.y, 32 + PointerLayout.edge)
        assertGood(p, tip: (756, 0), on: notched, safeTop: 32)
        // A tip in the notch at the display's right end: left of it and below the notch.
        let corner = place(1511, 4, on: notched, safeTop: 32)
        XCTAssertFalse(corner.right)
        XCTAssertTrue(corner.below)
        assertGood(corner, tip: (1511, 4), on: notched, safeTop: 32)
        // Without the notch the same spot may use the top of the display.
        XCTAssertEqual(place(756, 0, on: notched).y, 44 * 0.9)
    }

    func testABubbleTooWideForEitherSideStaysOnTheDisplayAndOffTheTip() {
        let p = place(720, 450, on: main, w: 1000)
        XCTAssertEqual(p.x, 1440 - 8 - 1000)
        XCTAssertFalse(PointerLayout.covers(x: p.x, y: p.y, w: 1000, h: h, tipX: 720, tipY: 450))
        XCTAssertTrue(p.below)
    }

    func testATinyDisplayNeverHidesTheTip() {
        let tiny = PanelRect(x: 0, y: 0, w: 200, h: 100)
        let p = place(100, 50, on: tiny)
        XCTAssertFalse(PointerLayout.covers(x: p.x, y: p.y, w: w, h: h, tipX: 100, tipY: 50))
    }
}
