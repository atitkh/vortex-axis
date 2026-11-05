import XCTest
@testable import AxisDesktopCore

/** 0.7.3: the link's watchdog settles on whichever outcome comes first. */
final class SettleTests: XCTestCase {
    func testTheFirstValueWins() async {
        let s = Settle<Int>()
        s.finish(1)
        s.finish(2)
        let v = await s.wait()
        XCTAssertEqual(v, 1)
    }

    func testAWaiterIsWokenByALaterValue() async {
        let s = Settle<String>()
        Task { try? await Task.sleep(nanoseconds: 50_000_000); s.finish("late") }
        let v = await s.wait()
        XCTAssertEqual(v, "late")
    }
}
