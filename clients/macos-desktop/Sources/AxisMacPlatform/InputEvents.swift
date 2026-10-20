import AppKit
import ApplicationServices
import Carbon.HIToolbox
import AxisDesktopCore

/**
 * Real mouse and keyboard input through CGEvent, in points with the origin at the top left of the main display
 * (the look's space; `Coordinates.display(at:)` is the multi-display rule). A click moves the person's pointer
 * there for an instant and puts it back. Posting needs Accessibility access (the same grant that reads controls).
 * Every function blocks its thread for the few milliseconds between events: call them off the main thread.
 * Patterns from the public-domain "Bluey" app's ComputerControl.swift (docs/mac-port.md section 7).
 */
enum InputEvents {
    static let source = CGEventSource(stateID: .hidSystemState)

    static func sleep(ms: Int) { usleep(useconds_t(max(ms, 0) * 1000)) }

    static var pointer: CGPoint { CGEvent(source: nil)?.location ?? .zero }

    /** Puts the real pointer back where the person left it. */
    static func warp(to point: CGPoint) {
        CGWarpMouseCursorPosition(point)
        CGAssociateMouseAndMouseCursorPosition(1)
    }

    static func post(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, clickState: Int = 0) {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return }
        if clickState > 0 { event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState)) }
        event.flags = []
        event.post(tap: .cghidEventTap)
    }

    /** Clicks at `point` (left, right, or a double click with the click state macOS needs to see two) and puts the pointer back. */
    static func click(at point: CGPoint, kind: ClickKind) {
        let was = pointer
        defer { warp(to: was) }
        let right = kind == .right
        let button: CGMouseButton = right ? .right : .left
        let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
        let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
        post(.mouseMoved, at: point, button: .left)
        // Lets the window under it see the pointer arrive, as hover menus need.
        sleep(ms: 30)
        let count = kind == .double ? 2 : 1
        for i in 1...count {
            post(down, at: point, button: button, clickState: i)
            sleep(ms: 35)
            post(up, at: point, button: button, clickState: i)
            if i < count { sleep(ms: 80) }
        }
        sleep(ms: 30)
    }

    /**
     * Drags with the left button from `from` to `to`: down, held `holdMs` (80 ms at least, so the press is seen),
     * moved in `leftMouseDragged` steps over `moveMs` (apps ignore plain moves while the button is down), a moment at
     * rest over the target so it takes the drop, then up. The button is always let go and the pointer put back.
     */
    static func drag(from: CGPoint, to: CGPoint, holdMs: Int, moveMs: Int) {
        let was = pointer
        var down = false
        defer {
            if down { post(.leftMouseUp, at: to, button: .left, clickState: 1) }
            warp(to: was)
        }
        post(.mouseMoved, at: from, button: .left)
        sleep(ms: 30)
        post(.leftMouseDown, at: from, button: .left, clickState: 1)
        down = true
        sleep(ms: max(80, holdMs))
        let steps = max(10, moveMs / 15)
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            post(.leftMouseDragged, at: p, button: .left)
            sleep(ms: max(1, moveMs / steps))
        }
        sleep(ms: 150)
        post(.leftMouseUp, at: to, button: .left, clickState: 1)
        down = false
        sleep(ms: 30)
    }

    /**
     * Turns the scroll wheel over `point` by `wheel1` (vertical) and `wheel2` (horizontal) pixels (`Scrolling.wheel`),
     * in pieces so apps animate and none is dropped, and puts the pointer back.
     */
    static func wheel(at point: CGPoint, wheel1: Int, wheel2: Int) {
        let was = pointer
        defer { warp(to: was) }
        post(.mouseMoved, at: point, button: .left)
        sleep(ms: 30)
        let piece = 120
        var left1 = wheel1, left2 = wheel2
        var sent = 0
        while (left1 != 0 || left2 != 0) && sent < 400 {
            let d1 = left1 > 0 ? min(piece, left1) : max(-piece, left1)
            let d2 = left2 > 0 ? min(piece, left2) : max(-piece, left2)
            if let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(d1), wheel2: Int32(d2), wheel3: 0) {
                event.location = point
                event.post(tap: .cghidEventTap)
            }
            left1 -= d1
            left2 -= d2
            sent += 1
            sleep(ms: 8)
        }
    }

    /**
     * Types `text` as characters, whatever the keyboard layout (each piece carries its own Unicode string); a new line
     * is Return and a tab is Tab. In pieces of up to 16 UTF-16 units (the event's string holds about 20), with a short
     * pause between, as Bluey does, so a long text does not swamp the app.
     */
    static func type(_ text: String) {
        var chunk = ""
        func flush() {
            guard !chunk.isEmpty else { return }
            typeUnicode(chunk)
            chunk = ""
            sleep(ms: 12)
        }
        for character in text.replacingOccurrences(of: "\r\n", with: "\n") {
            if character == "\n" || character == "\r" || character == "\t" {
                flush()
                press(code: CGKeyCode(character == "\t" ? kVK_Tab : kVK_Return), flags: [])
                sleep(ms: 12)
                continue
            }
            if chunk.utf16.count + String(character).utf16.count > 16 { flush() }
            chunk.append(character)
        }
        flush()
    }

    static func typeUnicode(_ text: String) {
        let units = Array(text.utf16)
        for pressed in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: pressed) else { continue }
            units.withUnsafeBufferPointer { buffer in
                event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            event.flags = []
            event.post(tap: .cghidEventTap)
        }
    }

    static func press(code: CGKeyCode, flags: CGEventFlags) {
        for pressed in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: pressed) else { continue }
            event.flags = flags
            event.post(tap: .cghidEventTap)
        }
    }

    /** Presses one combination: the key with its modifiers as flags on the event (no separate modifier presses). */
    static func press(_ combo: KeyCombo) throws {
        var key = combo.key
        var shifted = false
        // A character typed with shift on a US keyboard ("!" is shift+1).
        if keyCode(key) == nil, let base = shiftedKeys[key] {
            key = base
            shifted = true
        }
        guard let code = keyCode(key) else {
            throw DesktopError("this keyboard has no key for \"\(combo.key)\" that the app knows (US layout keys only for now)")
        }
        var flags: CGEventFlags = []
        if shifted { flags.insert(.maskShift) }
        if combo.cmd { flags.insert(.maskCommand) }
        if combo.ctrl { flags.insert(.maskControl) }
        if combo.option { flags.insert(.maskAlternate) }
        if combo.shift { flags.insert(.maskShift) }
        // Real arrow keys carry the function and numeric-pad flags; some apps look for them.
        if combo.fn || arrows.contains(key) { flags.insert(.maskSecondaryFn) }
        if arrows.contains(key) { flags.insert(.maskNumericPad) }
        press(code: code, flags: flags)
    }

    static let arrows: Set<String> = ["up", "down", "left", "right"]

    static let shiftedKeys: [String: String] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "|": "\\", "~": "`",
    ]

    /** The key code for a key name or character: ANSI (US) positions, as Bluey's table. Other layouts: M6. */
    static func keyCode(_ key: String) -> CGKeyCode? {
        if let code = keyCodes[key] { return CGKeyCode(code) }
        if key.count >= 2, key.hasPrefix("f"), let n = Int(key.dropFirst()), n >= 1, n <= functionKeys.count { return CGKeyCode(functionKeys[n - 1]) }
        return nil
    }

    static let functionKeys: [Int] = [
        kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
        kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20,
    ]

    static let keyCodes: [String: Int] = [
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
        "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
        "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
        "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
        "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
        "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        "enter": kVK_Return, "tab": kVK_Tab, "space": kVK_Space, "escape": kVK_Escape,
        "backspace": kVK_Delete, "delete": kVK_ForwardDelete,
        "left": kVK_LeftArrow, "right": kVK_RightArrow, "up": kVK_UpArrow, "down": kVK_DownArrow,
        "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
        "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal, "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
        ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period,
        "/": kVK_ANSI_Slash, "\\": kVK_ANSI_Backslash, "`": kVK_ANSI_Grave,
    ]
}
