import XCTest
@testable import AxisDesktopCore

/** The Windows app's `Axis.Desktop.Smoke/Checks.cs` Clipping and ChromeBand, check for check, plus the Mac's browser names. */
final class GeometryTests: XCTestCase {
    func testClipping() {
        let window = Box(x: 0, y: 0, w: 1000, h: 900)
        let page = Box(x: 0, y: 100, w: 1000, h: 800)  // under 100 pt of tabs and address bar
        // A field half under the top of the page: its middle is on the address bar, the part that shows is not.
        let field = Box(x: 100, y: 50, w: 400, h: 90)
        let shown = Geometry.visible(field, [page, window])
        XCTAssertEqual(shown, Box(x: 100, y: 100, w: 400, h: 40), "the part of a half-hidden field that shows")
        XCTAssertTrue(field.centre.y < page.y, "the whole field's middle is above the page")
        XCTAssertEqual(shown!.centre.x, 300)
        XCTAssertEqual(shown!.centre.y, 120, "the middle of what shows is in the page")
        XCTAssertEqual((Geometry.fraction(field, shown) * 100).rounded() / 100, 0.44, "4/9 of it shows")
        XCTAssertTrue(Geometry.enough(field, shown), "over 40% is enough to click")
        // A thin sliver: scrolled into view first.
        let sliver = Box(x: 100, y: 70, w: 400, h: 40)
        XCTAssertFalse(Geometry.enough(sliver, Geometry.visible(sliver, [page])), "a quarter of a field is not enough")
        // Wholly above the page: nothing shows.
        XCTAssertNil(Geometry.visible(Box(x: 100, y: 20, w: 400, h: 40), [page]), "a field scrolled above the page")
        XCTAssertFalse(Geometry.enough(Box(x: 100, y: 20, w: 400, h: 40), nil), "nothing showing is not enough")
        XCTAssertEqual(Geometry.fraction(Box(x: 100, y: 20, w: 400, h: 40), nil), 0, "nothing showing is 0")
        // A big control with a big piece showing is clicked there, whatever share that is.
        let tall = Box(x: 0, y: -1000, w: 1000, h: 3000)
        XCTAssertTrue(Geometry.enough(tall, Geometry.visible(tall, [page])), "a big piece of a tall pane is enough")
        // A frame inside the page, itself half scrolled out: cut by both.
        let frame = Box(x: 200, y: 50, w: 400, h: 300)
        XCTAssertEqual(Geometry.visible(Box(x: 250, y: 80, w: 100, h: 40), [frame, page, window]), Box(x: 250, y: 100, w: 100, h: 20),
                       "a control in a frame, cut by the frame and the page")
        // Wholly inside: as it is.
        XCTAssertEqual(Geometry.visible(Box(x: 10, y: 500, w: 50, h: 20), [page, window]), Box(x: 10, y: 500, w: 50, h: 20), "a control wholly in the page")
        XCTAssertEqual(Geometry.shown(ScreenElement(kind: "edit", name: "Search", x: 100, y: 60, w: 400, h: 80), Box(x: 100, y: 100, w: 400, h: 40)),
                       ScreenElement(kind: "edit", name: "Search", x: 100, y: 100, w: 400, h: 40), "an element cut to what shows")
    }

    func testChromeBand() {
        let chrome = WindowInfo(title: "Shop - Google Chrome", app: "Google Chrome", x: 0, y: 0, w: 1000, h: 900)
        let page = Box(x: 0, y: 90, w: 1000, h: 810)
        XCTAssertNotNil(Geometry.chromeRefusal(chrome, y: 50, inPage: true, page: page), "a page control clicked on the address bar is refused")
        XCTAssertNil(Geometry.chromeRefusal(chrome, y: 95, inPage: true, page: page), "a page control just below the bar, inside the band, is clicked")
        XCTAssertNil(Geometry.chromeRefusal(chrome, y: 50, inPage: false, page: nil), "the address bar itself is clicked")
        XCTAssertNil(Geometry.chromeRefusal(chrome, y: 50, inPage: false, page: page), "a tab or button is clicked")
        XCTAssertNil(Geometry.chromeRefusal(chrome, y: 300, inPage: true, page: page), "below the band, anything goes")
        var notes = chrome
        notes.app = "Notes"
        XCTAssertNil(Geometry.chromeRefusal(notes, y: 50, inPage: true, page: page), "not a browser: not refused")
        XCTAssertNil(Geometry.chromeRefusal(chrome, y: 50, inPage: true, page: Box(x: 0, y: 0, w: 1000, h: 900)), "a full-screen page is clicked at the top")
        XCTAssertNotNil(Geometry.chromeRefusal(chrome, y: 50, inPage: true, page: Box(x: 0, y: -2000, w: 1000, h: 5000)), "a page box reaching above the window says nothing: refused")
        XCTAssertNotNil(Geometry.chromeRefusal(chrome, y: 50, inPage: true, page: nil), "in a page with no box: refused")
        var high = chrome
        high.y = -8
        XCTAssertNotNil(Geometry.chromeRefusal(high, y: -8 + 99, inPage: true, page: nil), "the band starts at the window's own top")
        XCTAssertNil(Geometry.chromeRefusal(nil, y: 50, inPage: true, page: page), "no window in front: not refused")
        // A browser known only by its bundle id (an app name in another language).
        let byBundle = WindowInfo(title: "Shop", app: "Navigateur", x: 0, y: 0, w: 1000, h: 900, bundleID: "com.apple.Safari")
        XCTAssertNotNil(Geometry.chromeRefusal(byBundle, y: 50, inPage: true, page: page), "Safari by its bundle id")
    }

    func testBrowsers() {
        for name in ["Safari", "Google Chrome", "Brave Browser", "Arc", "Firefox", "Microsoft Edge", "Chromium", "Opera", "Vivaldi",
                     "Google Chrome Canary", "Firefox Developer Edition", "Zen Browser", "Safari Technology Preview",
                     "chrome", "MSEdge.exe", "firefox"] {
            XCTAssertTrue(Geometry.isBrowser(name), "\(name) is a browser")
        }
        for id in ["com.apple.Safari", "com.google.Chrome", "com.brave.Browser", "company.thebrowser.Browser", "org.mozilla.firefox", "com.microsoft.edgemac"] {
            XCTAssertTrue(Geometry.isBrowser(id), "\(id) is a browser")
        }
        for name in ["Finder", "Notes", "notepad", "Mail", "Slack", "Code", "Google Drive", "Microsoft Word", "Arcade", "", "Browser"] {
            XCTAssertFalse(Geometry.isBrowser(name), "\(name) is not a browser")
        }
        XCTAssertFalse(Geometry.isBrowser(nil as String?))
    }
}

final class CoordinatesTests: XCTestCase {
    /** A main display 1440x900 and a second one above and to the left of it, 1920x1080. */
    func testFlipWithADisplayAboveAndLeft() {
        let mainHeight = 900.0
        // AppKit: the main display's bottom left is 0,0; the second sits above (y 900 to 1980) and left (x -1920 to 0).
        XCTAssertEqual(Coordinates.topLeft(x: 0, y: 0, w: 1440, h: 900, mainHeight: mainHeight), Box(x: 0, y: 0, w: 1440, h: 900))
        XCTAssertEqual(Coordinates.topLeft(x: -1920, y: 900, w: 1920, h: 1080, mainHeight: mainHeight), Box(x: -1920, y: -1080, w: 1920, h: 1080),
                       "a display above and left is negative both ways, as in AX and CGEvent")
        // A window 200 pt below the main display's top edge.
        XCTAssertEqual(Coordinates.topLeft(x: 100, y: 500, w: 400, h: 200, mainHeight: mainHeight), Box(x: 100, y: 200, w: 400, h: 200))
        // And back: a top-left point placed in AppKit.
        let p = Coordinates.appKit(x: 100, y: 200, mainHeight: mainHeight)
        XCTAssertEqual(p.x, 100)
        XCTAssertEqual(p.y, 700)
        let above = Coordinates.appKit(x: -500, y: -300, mainHeight: mainHeight)
        XCTAssertEqual(above.y, 1200, "a point on the display above is above the main display in AppKit too")
    }

    func testVisionBoxes() {
        let area = Box(x: 100, y: 50, w: 1000, h: 500)
        // Vision: the bottom-left tenth of the image.
        XCTAssertEqual(Coordinates.fromVision(x: 0, y: 0, w: 0.1, h: 0.1, area: area), Box(x: 100, y: 500, w: 100, h: 50))
        // The top-right corner.
        XCTAssertEqual(Coordinates.fromVision(x: 0.9, y: 0.9, w: 0.1, h: 0.1, area: area), Box(x: 1000, y: 50, w: 100, h: 50))
    }

    func testUnion() {
        let displays = [Display(x: 0, y: 0, w: 1440, h: 900, primary: true), Display(x: -1920, y: -1080, w: 1920, h: 1080, primary: false)]
        XCTAssertEqual(Coordinates.union(displays), Box(x: -1920, y: -1080, w: 3360, h: 1980))
        XCTAssertEqual(Coordinates.union([]), Box(x: 0, y: 0, w: 0, h: 0))
    }
}
