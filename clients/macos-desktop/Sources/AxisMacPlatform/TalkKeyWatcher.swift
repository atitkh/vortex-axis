import AppKit
import Carbon.HIToolbox
import AxisDesktopCore

/** The signature of this app's hot keys ("VXAX"), told apart from any other app's in the shared Carbon handler. */
private let talkSignature: OSType = 0x5658_4158

/**
 * The talk key (or the typing key), anywhere on the Mac: a press, then a hold once it has stayed down
 * `TapHold.tapMs` (220 ms; let go sooner it is a tap), then its release, reported either way. A combination with a
 * key is a Carbon hot key (`RegisterEventHotKey`), which tells press and release apart and needs no permission (no
 * Input Monitoring: it is not a key monitor). `fn` alone is watched through AppKit's monitors of modifier changes,
 * which macOS lets an app with Accessibility access see. Each watcher has its own hot key id, so the talk key's and
 * the typing key's never reach each other.
 */
@MainActor
public final class TalkKeyWatcher {
    public var onPress: (() -> Void)?
    public var onHold: (() -> Void)?
    /** The key came up, after a hold or a tap (`TapHold`). */
    public var onRelease: (() -> Void)?

    static let holdMs: UInt64 = TapHold.tapMs
    /** This watcher's hot key id, under the app's signature. */
    nonisolated let hotKeyId: UInt32

    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var monitors: [Any] = []
    private var isDown = false
    private var held = false
    private var presses = 0
    /** When the last press's event happened, in milliseconds since startup (`Voice.uptimeMs`'s clock); 0 before any. */
    public private(set) var pressedAtMs: UInt64 = 0

    /** `id`: 1 for the talk key, 2 for the typing key. */
    public init(id: UInt32 = 1) { hotKeyId = id }

    /** Watches `key` in place of the one before. Returns why it cannot, in words, or nil when it is watched. */
    public func use(_ key: TalkKey) -> String? {
        stop()
        if key.isFn { return watchFn() }
        guard let code = InputEvents.keyCode(key.key) else { return "\(key.label) is not a key this app can watch" }
        installHandler()
        var mods: UInt32 = 0
        if key.cmd { mods |= UInt32(cmdKey) }
        if key.option { mods |= UInt32(optionKey) }
        if key.ctrl { mods |= UInt32(controlKey) }
        if key.shift { mods |= UInt32(shiftKey) }
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(UInt32(code), mods, EventHotKeyID(signature: talkSignature, id: hotKeyId), GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let ref else {
            if status == OSStatus(eventHotKeyExistsErr) { return "\(key.label) is taken by another app; pick another talk key in Settings" }
            return "\(key.label) could not be set as the talk key (error \(status))"
        }
        hotKey = ref
        return nil
    }

    /** No talk key (talking switched off). */
    public func stop() {
        if let hotKey { UnregisterEventHotKey(hotKey) }
        hotKey = nil
        for m in monitors { NSEvent.removeMonitor(m) }
        monitors = []
        if isDown { up() }
    }

    /** One handler for this app's hot keys, installed once; it hops to the main actor (it is called on the main thread). */
    private func installHandler() {
        guard handler == nil else { return }
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let me = Unmanaged.passUnretained(self).toOpaque()
        var installed: EventHandlerRef?
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, user in
            guard let event, let user else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            let got = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                        MemoryLayout<EventHotKeyID>.size, nil, &id)
            let watcher = Unmanaged<TalkKeyWatcher>.fromOpaque(user).takeUnretainedValue()
            // The other watcher's key: left for its own handler, installed on the same target.
            guard got == noErr, id.signature == talkSignature, id.id == watcher.hotKeyId else { return OSStatus(eventNotHandledErr) }
            let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            // Seconds since startup, the clock of `Voice.uptimeMs`: for the talk key's timing line.
            let at = UInt64(max(0, GetEventTime(event)) * 1000)
            Task { @MainActor in
                if pressed { watcher.down(at: at) } else { watcher.up() }
            }
            return noErr
        }, 2, &specs, me, &installed)
        if status == noErr { handler = installed }
    }

    /** Fn (Globe) alone: its own modifier change, with no other modifier held. */
    private func watchFn() -> String? {
        let fnCode = UInt16(kVK_Function)
        let changed: (NSEvent) -> Void = { [weak self] event in
            guard event.keyCode == fnCode else { return }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let fnDown = flags.contains(.function) && flags.isDisjoint(with: [.command, .control, .option, .shift])
            let at = UInt64(max(0, event.timestamp) * 1000)
            Task { @MainActor in
                if fnDown { self?.down(at: at) } else { self?.up() }
            }
        }
        if let global = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: changed) { monitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged, handler: { changed($0); return $0 }) { monitors.append(local) }
        return monitors.isEmpty ? "the Fn key cannot be watched (Accessibility access is needed)" : nil
    }

    /** The talk key a key press in this app's window makes (Settings' recorder); nil for a key this app cannot watch. */
    public static func talkKey(from event: NSEvent) -> TalkKey? {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.type == .flagsChanged {
            let alone = flags.isDisjoint(with: [.command, .control, .option, .shift])
            return event.keyCode == UInt16(kVK_Function) && flags.contains(.function) && alone ? TalkKey(key: "fn") : nil
        }
        guard event.type == .keyDown, let name = keyName(Int(event.keyCode)) else { return nil }
        return TalkKey(ctrl: flags.contains(.control), option: flags.contains(.option), shift: flags.contains(.shift),
                       cmd: flags.contains(.command), key: name)
    }

    /** A key code's name as `KeyCombo` and `TalkKey` know it (US positions), or nil. */
    static func keyName(_ code: Int) -> String? {
        if let i = InputEvents.functionKeys.firstIndex(of: code) { return "f\(i + 1)" }
        return InputEvents.keyCodes.first { $0.value == code }?.key
    }

    private func down(at: UInt64) {
        guard !isDown else { return }
        pressedAtMs = at
        isDown = true
        held = false
        presses += 1
        let mine = presses
        onPress?()
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: Self.holdMs * 1_000_000)
            guard let self, self.isDown, self.presses == mine else { return }
            self.held = true
            self.onHold?()
        }
    }

    private func up() {
        guard isDown else { return }
        isDown = false
        held = false
        onRelease?()
    }
}
