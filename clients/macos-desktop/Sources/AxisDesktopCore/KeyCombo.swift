import Foundation

/**
 * A key with the modifiers held for it, for `desktop.keys`: "cmd+shift+t", "enter", "ctrl+tab". The Mac's own
 * version of the Windows app's `KeyCombo`, with cmd, option and fn.
 *
 * Agents learn shortcuts on Windows ("ctrl+s saves", the tool's own example), so `ctrl` on a key that is a common
 * shortcut is sent as cmd. The table (docs in clients/macos-desktop/README.md):
 *
 * | asked              | pressed           | why |
 * |--------------------|-------------------|-----|
 * | ctrl+<k>, k in `ctrlAsCmd` (s c v x a z f t w n o p r q l k b i u / [ ] , + - 0 =) | cmd+<k> (other modifiers kept) | the Mac's shortcut key |
 * | ctrl+y             | cmd+shift+z       | redo on a Mac |
 * | ctrl+<anything else> (tab, arrows, space, letters not listed) | ctrl+<key> | Control means itself there (ctrl+tab switches tabs) |
 * | control+<k>        | ctrl+<k>          | spelled out: always the Control key itself |
 * | cmd/command/meta/super/win+<k> | cmd+<k>   | |
 * | alt/option/opt+<k> | option+<k>        | |
 * | ctrl and cmd both  | as written        | nothing is mapped when cmd is asked for |
 */
public struct KeyCombo: Equatable, Sendable, CustomStringConvertible {
    public var ctrl = false, option = false, shift = false, cmd = false, fn = false
    public var key: String

    public init(ctrl: Bool = false, option: Bool = false, shift: Bool = false, cmd: Bool = false, fn: Bool = false, key: String) {
        self.ctrl = ctrl
        self.option = option
        self.shift = shift
        self.cmd = cmd
        self.fn = fn
        self.key = key
    }

    public struct Unknown: SaysWhy, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    public static let named: Set<String> = [
        "enter", "tab", "escape", "backspace", "delete", "space", "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
    ]
    static let aliases: [String: String] = [
        "return": "enter", "esc": "escape", "del": "delete", "forwarddelete": "delete", "pgup": "pageup", "pgdn": "pagedown",
        "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right", "spacebar": "space",
        "comma": ",", "period": ".", "dot": ".", "slash": "/", "backslash": "\\", "minus": "-", "dash": "-", "equals": "=", "equal": "=",
        // cmd+= is "zoom in" in Mac apps; "+" itself is shift+= on the keyboard.
        "plus": "=", "+": "=", "semicolon": ";", "quote": "'", "backtick": "`", "grave": "`",
    ]
    /** Keys Windows has and a Mac does not: refused with words instead of pressing something else. */
    static let missing: [String: String] = [
        "printscreen": "a Mac has no Print Screen key; use the screenshot action",
        "insert": "a Mac keyboard has no Insert key", "ins": "a Mac keyboard has no Insert key",
        "menu": "a Mac keyboard has no menu key; right-click instead",
        "capslock": "the app does not press Caps Lock",
        "volumeup": "media and volume keys are not pressed on a Mac yet", "volumedown": "media and volume keys are not pressed on a Mac yet",
        "volumemute": "media and volume keys are not pressed on a Mac yet", "mute": "media and volume keys are not pressed on a Mac yet",
        "mediaplaypause": "media and volume keys are not pressed on a Mac yet", "playpause": "media and volume keys are not pressed on a Mac yet",
        "medianext": "media and volume keys are not pressed on a Mac yet", "mediaprevious": "media and volume keys are not pressed on a Mac yet",
        "mediastop": "media and volume keys are not pressed on a Mac yet",
    ]
    /** Keys whose ctrl shortcut on Windows is a cmd shortcut on a Mac. */
    public static let ctrlAsCmd: Set<String> = [
        "s", "c", "v", "x", "a", "z", "f", "t", "w", "n", "o", "p", "r", "q", "l", "k", "b", "i", "u", "/", "[", "]", ",", "=", "-", "0",
    ]

    /** Reads "ctrl+shift+t" and the like (any case, spaces ignored). Throws `Unknown` with words on what it does not know. */
    public static func parse(_ text: String) throws -> KeyCombo {
        var raw = text.lowercased().replacingOccurrences(of: " ", with: "")
        // "ctrl++" asks for the plus key: the split below would lose it.
        if raw.hasSuffix("++") { raw = String(raw.dropLast(2)) + "+plus" }
        if raw == "+" { raw = "plus" }
        let parts = raw.split(separator: "+").map(String.init)
        guard let last = parts.last else { throw Unknown(message: "keys is empty") }
        var combo = KeyCombo(key: "")
        var ctrlAsked = false, controlLiteral = false
        for m in parts.dropLast() {
            switch m {
            case "ctrl", "ctl", "⌃": ctrlAsked = true
            case "control": controlLiteral = true
            case "alt", "option", "opt", "⌥": combo.option = true
            case "shift", "⇧": combo.shift = true
            case "cmd", "command", "⌘", "meta", "super", "win", "windows": combo.cmd = true
            case "fn": combo.fn = true
            default: throw Unknown(message: "\"\(m)\" is not a modifier (cmd, ctrl, option, shift, fn)")
            }
        }
        if let why = missing[last] { throw Unknown(message: why) }
        let key = aliases[last] ?? last
        let isFunction = key.count >= 2 && key.count <= 3 && key.hasPrefix("f") && Int(key.dropFirst()).map { $0 >= 1 && $0 <= 20 } == true
        let isChar = key.count == 1 && key.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7E }
        guard named.contains(key) || isFunction || isChar else { throw Unknown(message: "\"\(last)\" is not a key this knows") }
        combo.key = key
        if controlLiteral { combo.ctrl = true }
        if ctrlAsked {
            if !combo.cmd && !controlLiteral && key == "y" {
                // Redo: ctrl+y on Windows, cmd+shift+z on a Mac.
                combo.cmd = true
                combo.shift = true
                combo.key = "z"
            } else if !combo.cmd && !controlLiteral && ctrlAsCmd.contains(key) {
                combo.cmd = true
            } else {
                combo.ctrl = true
            }
        }
        return combo
    }

    /**
     * Combinations the app never presses, whatever an agent asks: locking the screen, logging out, Force Quit, and
     * quitting the app in front (the Windows app's Alt+F4 rule). Checked after ctrl became cmd, so ctrl+q is refused too.
     */
    public func blocked() -> String? {
        if cmd && ctrl && key == "q" { return "locking the screen" }
        if cmd && shift && key == "q" { return "logging out" }
        if cmd && option && key == "escape" { return "Force Quit" }
        if cmd && key == "q" { return "quitting the app" }
        return nil
    }

    /** "ctrl+option+shift+cmd+k", the Mac's own order. */
    public var description: String {
        [ctrl ? "ctrl" : nil, option ? "option" : nil, shift ? "shift" : nil, cmd ? "cmd" : nil, fn ? "fn" : nil, key]
            .compactMap { $0 }.joined(separator: "+")
    }
}
