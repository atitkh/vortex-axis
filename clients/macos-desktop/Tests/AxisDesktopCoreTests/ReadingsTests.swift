import XCTest
@testable import AxisDesktopCore

/** A power source that says what the test sets. */
final class FakePower: PowerSource, @unchecked Sendable {
    var state: PowerState
    init(_ state: PowerState) { self.state = state }
    func read() -> PowerState { state }
}

/** 0.7.0: `sense` readings about power and use: unknown left out, the day's count, the pace. */
final class ReadingsTests: XCTestCase {
    func testPowerSourcesLaptop() {
        let battery: [String: Any] = ["Type": "InternalBattery", "Is Present": true, "Current Capacity": 76, "Max Capacity": 100, "Is Charging": false]
        XCTAssertEqual(PowerState.fromPowerSources(providing: "Battery Power", sources: [battery]), PowerState(battery: 76, charging: false, onPower: false))
        var charging = battery
        charging["Is Charging"] = true
        charging["Current Capacity"] = 40
        XCTAssertEqual(PowerState.fromPowerSources(providing: "AC Power", sources: [charging]), PowerState(battery: 40, charging: true, onPower: true))
    }

    func testPowerSourcesNoBattery() {
        // A Mac mini: AC only, no battery and no charging. A UPS is not the Mac's battery.
        XCTAssertEqual(PowerState.fromPowerSources(providing: "AC Power", sources: []), PowerState(onPower: true))
        let ups: [String: Any] = ["Type": "UPS", "Current Capacity": 90, "Max Capacity": 100]
        XCTAssertEqual(PowerState.fromPowerSources(providing: "UPS Power", sources: [ups]), PowerState(onPower: false))
        XCTAssertEqual(PowerState.fromPowerSources(providing: nil, sources: []), .unknown)
        let absent: [String: Any] = ["Type": "InternalBattery", "Is Present": false, "Current Capacity": 0, "Max Capacity": 100]
        XCTAssertEqual(PowerState.fromPowerSources(providing: "AC Power", sources: [absent]), PowerState(onPower: true))
    }

    func testMessageShape() {
        let m = Readings.message(PowerState(battery: 76, charging: false, onPower: false), turnsToday: 3, uptimeS: 3600)
        XCTAssertEqual(m["t"], .string("sense"))
        XCTAssertEqual(m["readings"], .object(["battery": 76, "charging": 0, "onPower": 0, "turnsToday": 3, "uptimeS": 3600]))
        for (_, v) in m["readings"]?.objectValue ?? [:] { XCTAssertNotNil(v.doubleValue, "scalars only") }
        XCTAssertEqual(Readings.message(PowerState(onPower: true), turnsToday: 0, uptimeS: nil)["readings"], .object(["onPower": 1, "turnsToday": 0]))
        XCTAssertEqual(Readings.message(.unknown, turnsToday: 0, uptimeS: nil)["readings"], .object(["turnsToday": 0]))
    }

    func testTurnsResetAtLocalMidnight() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        let now = Shared(calendar.date(from: DateComponents(year: 2026, month: 10, day: 28, hour: 23, minute: 59))!)
        let turns = TurnCount(calendar: calendar, now: { now.value })
        turns.add(); turns.add()
        XCTAssertEqual(turns.today, 2)
        now.value = now.value.addingTimeInterval(120)
        XCTAssertEqual(turns.today, 0, "a new local day")
        turns.add()
        XCTAssertEqual(turns.today, 1)
    }

    func testPace() {
        var pace = ReadingsPace()
        let on = PowerState(battery: 80, charging: true, onPower: true)
        let off = PowerState(battery: 80, charging: false, onPower: false)
        XCTAssertTrue(pace.due(on, turns: 0, now: 0), "at connect")
        pace.sent(on, turns: 0, now: 0)
        XCTAssertFalse(pace.due(on, turns: 0, now: 10_000))
        XCTAssertFalse(pace.due(off, turns: 0, now: 10_000), "a change within 30 s waits")
        XCTAssertTrue(pace.due(off, turns: 0, now: 30_000), "a change after 30 s goes")
        XCTAssertTrue(pace.due(on, turns: 1, now: 30_000), "a turn is a change")
        XCTAssertFalse(pace.due(on, turns: 0, now: 59_999))
        XCTAssertTrue(pace.due(on, turns: 0, now: 60_000), "every minute")
        pace.sent(on, turns: 0, now: 60_000)
        pace.connected()
        XCTAssertTrue(pace.due(on, turns: 0, now: 61_000), "again at once after connecting again")
    }

    func testCheckSendsOnlyOnlineAndPaced() async {
        let power = FakePower(PowerState(onPower: true))
        let clock = Shared<UInt64>(0)
        let sent = Shared<[JSONValue]>([])
        let readings = Readings(source: power, uptimeS: { 10 }, clock: { clock.value })
        readings.use(send: { m in sent.value.append(m); return true })
        await readings.check()
        XCTAssertEqual(sent.value.count, 0, "nothing while offline")
        readings.linkChanged(online: true)
        await readings.check()
        XCTAssertEqual(sent.value.count, 1, "at connect")
        XCTAssertEqual(sent.value.first?["readings"], .object(["onPower": 1, "turnsToday": 0, "uptimeS": 10]))
        clock.value = 5_000
        readings.turns.add()
        await readings.check()
        XCTAssertEqual(sent.value.count, 1, "a turn within 30 s waits")
        clock.value = 30_000
        await readings.check()
        XCTAssertEqual(sent.value.last?["readings"]?["turnsToday"], .number(1))
        readings.linkChanged(online: false)
        readings.linkChanged(online: true)
        clock.value = 31_000
        await readings.check()
        XCTAssertEqual(sent.value.count, 3, "at once on connecting again")
        readings.stop()
    }
}
