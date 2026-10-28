import Foundation
import IOKit.ps
import AxisDesktopCore

/**
 * Power as macOS says it (IOKit power sources), for the `sense` readings. `read` is asked from `Readings`' own task;
 * `watch` calls back on the main run loop when a power source changes (plugged in or out, a battery step).
 */
public final class MacPower: PowerSource, @unchecked Sendable {
    private final class Box { let changed: () -> Void; init(_ changed: @escaping () -> Void) { self.changed = changed } }
    private var source: CFRunLoopSource?

    public init() {}

    public func read() -> PowerState {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else { return .unknown }
        let providing = IOPSGetProvidingPowerSourceType(blob)?.takeUnretainedValue() as String?
        var list: [AnyObject] = []
        if let array = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() { list = array as NSArray as [AnyObject] }
        let sources: [[String: Any]] = list.compactMap { item in
            guard let description = IOPSGetPowerSourceDescription(blob, item)?.takeUnretainedValue() else { return nil }
            return description as NSDictionary as? [String: Any]
        }
        return PowerState.fromPowerSources(providing: providing, sources: sources)
    }

    /** Once: further calls are ignored. The callback lives as long as the app. */
    public func watch(_ changed: @escaping () -> Void) {
        guard source == nil else { return }
        let context = Unmanaged.passRetained(Box(changed)).toOpaque()
        guard let made = IOPSNotificationCreateRunLoopSource({ context in
            guard let context else { return }
            Unmanaged<Box>.fromOpaque(context).takeUnretainedValue().changed()
        }, context)?.takeRetainedValue() else { return }
        CFRunLoopAddSource(CFRunLoopGetMain(), made, .defaultMode)
        source = made
    }

    /** Seconds since the Mac started, sleep included (`kern.boottime`); nil when the system does not say. */
    public static func uptimeS() -> Int? {
        var boot = timeval()
        var size = MemoryLayout<timeval>.size
        var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
        guard sysctl(&mib, 2, &boot, &size, nil, 0) == 0, boot.tv_sec > 0 else { return nil }
        return max(0, Int(Date().timeIntervalSince1970) - Int(boot.tv_sec))
    }
}
