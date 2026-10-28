import Foundation

/** What the operating system says about power. A nil is unknown and is not sent (client guide, section 11). */
public struct PowerState: Equatable, Sendable {
    public var battery: Int?
    public var charging: Bool?
    public var onPower: Bool?

    public init(battery: Int? = nil, charging: Bool? = nil, onPower: Bool? = nil) {
        self.battery = battery
        self.charging = charging
        self.onPower = onPower
    }

    public static let unknown = PowerState()

    /**
     * From IOKit's power sources (`IOPSGetProvidingPowerSourceType` and each `IOPSGetPowerSourceDescription`), by their
     * keys' string values so this stays testable anywhere: "AC Power" is on power, "Battery Power" and "UPS Power" are
     * not. Battery and charging come from the internal battery only; a Mac with none gives only onPower.
     */
    public static func fromPowerSources(providing: String?, sources: [[String: Any]]) -> PowerState {
        var state = PowerState()
        switch providing {
        case "AC Power": state.onPower = true
        case "Battery Power", "UPS Power": state.onPower = false
        default: break
        }
        let builtIn = sources.first { $0["Type"] as? String == "InternalBattery" && ($0["Is Present"] as? Bool ?? true) }
        guard let battery = builtIn else { return state }
        if let current = number(battery["Current Capacity"]), let full = number(battery["Max Capacity"]), full > 0 {
            state.battery = min(100, max(0, Int((current * 100 / full).rounded())))
        }
        state.charging = battery["Is Charging"] as? Bool
        return state
    }

    private static func number(_ value: Any?) -> Double? {
        switch value {
        case let i as Int: return Double(i)
        case let d as Double: return d
        case let n as NSNumber: return n.doubleValue
        default: return nil
        }
    }
}

/** Where the readings come from: IOKit on a Mac (`MacPower`), a fake in the tests. Asked off the main thread. */
public protocol PowerSource: Sendable {
    func read() -> PowerState
}

/** Turns started on this computer since local midnight. */
public final class TurnCount: @unchecked Sendable {
    private let lock = NSLock()
    private let now: @Sendable () -> Date
    private let calendar: Calendar
    private var day: DateComponents?
    private var count = 0

    public init(calendar: Calendar = .autoupdatingCurrent, now: @escaping @Sendable () -> Date = { Date() }) {
        self.calendar = calendar
        self.now = now
    }

    public func add() { lock.withLock { roll(); count += 1 } }

    public var today: Int { lock.withLock { roll(); return count } }

    private func roll() {
        let d = calendar.dateComponents([.year, .month, .day], from: now())
        if d != day { day = d; count = 0 }
    }
}

/** When to send: at once after connecting, on a change at most every 30 s, otherwise every minute. */
public struct ReadingsPace: Sendable {
    public static let changeMs: UInt64 = 30_000
    public static let regularMs: UInt64 = 60_000
    private var last: (power: PowerState, turns: Int)?
    private var lastAt: UInt64 = 0

    public init() {}

    public mutating func connected() { last = nil }

    public func due(_ power: PowerState, turns: Int, now: UInt64) -> Bool {
        guard let last else { return true }
        let since = now >= lastAt ? now - lastAt : 0
        return since >= Self.regularMs || (since >= Self.changeMs && (last.power != power || last.turns != turns))
    }

    public mutating func sent(_ power: PowerState, turns: Int, now: UInt64) {
        last = (power, turns)
        lastAt = now
    }
}

/**
 * Sends `sense` readings about power and use (battery, charging, onPower, turnsToday, uptimeS). The power source is
 * asked on this class's own task, never on the main thread or the talk key's path.
 */
public final class Readings: @unchecked Sendable {
    public static let tickMs: UInt64 = 5_000
    public let turns: TurnCount
    private let source: PowerSource
    private let uptimeS: @Sendable () -> Int?
    private let clock: @Sendable () -> UInt64
    private let lock = NSLock()
    private var pace = ReadingsPace()
    private var send: (@Sendable (JSONValue) async -> Bool)?
    private var online = false
    private var fresh = false
    private var loop: Task<Void, Never>?
    private let wakes: AsyncStream<Void>
    private let wake: AsyncStream<Void>.Continuation

    public init(source: PowerSource, turns: TurnCount = TurnCount(), uptimeS: @escaping @Sendable () -> Int? = { nil },
                clock: @escaping @Sendable () -> UInt64 = { DispatchTime.now().uptimeNanoseconds / 1_000_000 }) {
        self.source = source
        self.turns = turns
        self.uptimeS = uptimeS
        self.clock = clock
        var made: AsyncStream<Void>.Continuation?
        wakes = AsyncStream(bufferingPolicy: .bufferingNewest(1)) { made = $0 }
        wake = made!
    }

    deinit { stop() }

    public static func message(_ power: PowerState, turnsToday: Int, uptimeS: Int?) -> JSONValue {
        var r: [String: JSONValue] = [:]
        if let b = power.battery { r["battery"] = .number(Double(min(100, max(0, b)))) }
        if let c = power.charging { r["charging"] = .number(c ? 1 : 0) }
        if let o = power.onPower { r["onPower"] = .number(o ? 1 : 0) }
        r["turnsToday"] = .number(Double(turnsToday))
        if let u = uptimeS { r["uptimeS"] = .number(Double(u)) }
        return .object(["t": .string("sense"), "readings": .object(r)])
    }

    /** How to send (the link's `trySend`); a new link after pairing again replaces the old one. */
    public func use(send: @escaping @Sendable (JSONValue) async -> Bool) { lock.withLock { self.send = send } }

    /** The link came up or went: readings go at once on connecting, and not while offline. */
    public func linkChanged(online: Bool) {
        lock.withLock {
            self.online = online
            if online { fresh = true }
        }
        if online { poke() }
    }

    /** Something may have changed (power plugged in or out, waking): look now rather than at the next tick. */
    public func poke() { wake.yield() }

    /** Starts the loop once: a look every `tickMs`, and at each poke. */
    public func start() {
        lock.withLock {
            guard loop == nil else { return }
            let wake = self.wake
            loop = Task.detached { [weak self, wakes] in
                let ticker = Task.detached {
                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: Readings.tickMs * 1_000_000)
                        wake.yield()
                    }
                }
                defer { ticker.cancel() }
                for await _ in wakes {
                    guard let self else { return }
                    await self.check()
                }
            }
        }
    }

    public func stop() {
        lock.withLock { loop?.cancel(); loop = nil }
        wake.finish()
    }

    /** One look: sends when the pace says so. The loop calls it; the tests call it directly. */
    public func check() async {
        let (sender, up) = lock.withLock { () -> ((@Sendable (JSONValue) async -> Bool)?, Bool) in
            if fresh && online { fresh = false; pace.connected() }
            return (send, online)
        }
        guard up, let send = sender else { return }
        let power = source.read()
        let count = turns.today
        let now = clock()
        guard lock.withLock({ pace.due(power, turns: count, now: now) }) else { return }
        if await send(Self.message(power, turnsToday: count, uptimeS: uptimeS())) {
            lock.withLock { pace.sent(power, turns: count, now: now) }
        }
    }
}
