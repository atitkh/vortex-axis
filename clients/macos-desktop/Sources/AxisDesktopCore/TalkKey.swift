import Foundation

/**
 * The key held to talk from this Mac (Settings; the Windows app's talk key). Kept as text ("ctrl+option+space") in
 * the saved settings under the Windows app's field name `TalkKey`. A press listens until a pause, a hold listens until
 * let go, and while the agent thinks or speaks a press stops it (`Voice`).
 *
 * `fn` alone is the Fn (Globe) key held by itself: it needs no other key, but macOS gives it a job of its own
 * (System Settings > Keyboard, "Press 🌐 key to": set it to "Do Nothing").
 */
public struct TalkKey: Equatable, Sendable, CustomStringConvertible {
    public var ctrl = false, option = false, shift = false, cmd = false
    /** A key name as `KeyCombo` knows them ("space", "v", "f5"), or "fn" for the Fn key alone. */
    public var key: String

    public init(ctrl: Bool = false, option: Bool = false, shift: Bool = false, cmd: Bool = false, key: String) {
        self.ctrl = ctrl
        self.option = option
        self.shift = shift
        self.cmd = cmd
        self.key = key
    }

    /** Control+Option+Space: the Windows app's Ctrl+Alt+Space, and taken by nothing common on a Mac. */
    public static let standard = TalkKey(ctrl: true, option: true, key: "space")

    /** Offered in the menu and Settings; any other combination can be recorded in Settings. */
    public static let presets: [TalkKey] = [
        standard,
        TalkKey(ctrl: true, shift: true, key: "space"),
        TalkKey(ctrl: true, option: true, key: "v"),
        TalkKey(ctrl: true, option: true, key: "t"),
        TalkKey(key: "f5"),
        TalkKey(key: "fn"),
    ]

    public var isFn: Bool { key == "fn" }
    var isFunctionKey: Bool {
        key.count >= 2 && key.count <= 3 && key.hasPrefix("f") && Int(key.dropFirst()).map { $0 >= 1 && $0 <= 20 } == true
    }
    var hasModifier: Bool { ctrl || option || shift || cmd }

    /**
     * Reads "ctrl+option+space", "⌃⌥Space", "control+alt+v", "f5", "fn" (any case, spaces ignored), and the Windows
     * app's ids ("ctrl+alt+space"). Nil for anything that is not one key with modifiers.
     */
    public static func parse(_ text: String) -> TalkKey? {
        var raw = text.lowercased().replacingOccurrences(of: " ", with: "")
        // The symbols as macOS writes them, run together: ⌃⌥space.
        for (symbol, word) in [("⌃", "ctrl+"), ("⌥", "option+"), ("⇧", "shift+"), ("⌘", "cmd+")] {
            raw = raw.replacingOccurrences(of: symbol, with: word)
        }
        let parts = raw.split(separator: "+").map(String.init)
        guard let last = parts.last else { return nil }
        var k = TalkKey(key: "")
        for m in parts.dropLast() {
            switch m {
            case "ctrl", "control", "ctl": k.ctrl = true
            case "option", "opt", "alt": k.option = true
            case "shift": k.shift = true
            case "cmd", "command", "meta", "super", "win": k.cmd = true
            default: return nil
            }
        }
        let key = last == "globe" ? "fn" : (KeyCombo.aliases[last] ?? last)
        k.key = key
        if key == "fn" { return k.hasModifier ? nil : k }
        let isChar = key.count == 1 && key.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7E }
        guard KeyCombo.named.contains(key) || k.isFunctionKey || isChar else { return nil }
        return k
    }

    /** The saved settings' value, else the standard key. */
    public static func saved(_ text: String?) -> TalkKey {
        guard let text, let k = parse(text), k.refused() == nil else { return standard }
        return k
    }

    /**
     * Why this cannot be the talk key, or nil when it can: it must not swallow typing (a letter or Space with no
     * modifier but Shift), and must not take a shortcut macOS itself depends on.
     */
    public func refused() -> String? {
        if isFn { return nil }
        if !isFunctionKey && !(ctrl || option || cmd) { return "add Control, Option or Command, or it would swallow typing" }
        if cmd && !ctrl && !option && (key == "space" || key == "tab" || key == "q" || key == "w" || key == "h" || key == "m" || key == "`") {
            return "Command+\(Self.keyLabel(key)) is macOS's own"
        }
        if ctrl && !option && !cmd && !shift && key == "space" { return "Control+Space switches input sources" }
        if cmd && option && key == "escape" { return "that is Force Quit" }
        return nil
    }

    /** "ctrl+option+shift+cmd+space", the order `parse` reads and `KeyCombo` writes. Saved as this. */
    public var description: String {
        [ctrl ? "ctrl" : nil, option ? "option" : nil, shift ? "shift" : nil, cmd ? "cmd" : nil, key].compactMap { $0 }.joined(separator: "+")
    }

    /** As macOS writes shortcuts: "⌃⌥Space", "F5", "Fn". */
    public var label: String {
        if isFn { return "Fn (Globe)" }
        let mods = (ctrl ? "⌃" : "") + (option ? "⌥" : "") + (shift ? "⇧" : "") + (cmd ? "⌘" : "")
        return mods + Self.keyLabel(key)
    }

    static func keyLabel(_ key: String) -> String {
        switch key {
        case "space": return "Space"
        case "enter": return "Return"
        case "escape": return "Esc"
        case "tab": return "Tab"
        case "backspace": return "Delete"
        case "delete": return "Forward Delete"
        case "up": return "↑"
        case "down": return "↓"
        case "left": return "←"
        case "right": return "→"
        case "home": return "Home"
        case "end": return "End"
        case "pageup": return "Page Up"
        case "pagedown": return "Page Down"
        default: return key.uppercased()
        }
    }
}
