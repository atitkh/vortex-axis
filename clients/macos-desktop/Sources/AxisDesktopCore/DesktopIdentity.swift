import Foundation

/** How the Mac app introduces itself to Axis, and what it offers the admin page. The same eight settings as Windows. */
public enum DesktopIdentity {
    public static let type = "macos-desktop"

    /**
     * With `voice` (Talk from this Mac, on unless switched off), also a microphone, speakers and a screen (the voice
     * pill, which shows what was heard, the reply and Axis's questions with their choices): the Mac is talked to like
     * a board, as the Windows app is. Without it only `desktop`: advertising `screen` obliges the app to show questions.
     * The settings are the Windows app's eight; its switches for voice, the face and the pills are the person's own,
     * kept on the Mac, not on the admin page (the same on Windows).
     */
    public static func capabilities(voice: Bool) -> [String] {
        voice ? ["desktop", "mic", "speaker", "screen"] : ["desktop"]
    }

    public static func create(version: String, voice: Bool = false) -> ClientIdentity {
        ClientIdentity(type: type, version: version, capabilities: capabilities(voice: voice), describe: [
            "settings": .array([
                setting("allowLook", "Let agents read the screen", "Off refuses every look. The person at the Mac can also pause the app from its menu bar item.", "1"),
                setting("allowInput", "Let agents click and type", "Off refuses clicks, typing and key presses; looking and pointing go on. The app never types into a password field or presses lock, log out, Force Quit or cmd+Q.", "1"),
                setting("bubble", "Words beside the pointer", "Show what the agent says next to its pointer.", "1"),
                setting("allowScreenshot", "Let agents take screenshots", "On, an agent may take a small picture of the window in front or the screen when reading its controls is not enough; the picture goes to the agent's model. Never while a password field has the focus. Needs Screen Recording.", "0"),
                setting("autoUpdate", "Update automatically", "When a newer desktop app is on this hub, download it, check it and restart into it. (The Mac app is updated by hand for now.)", "1"),
                setting("confirmRisky", "Ask before risky actions", "Axis asks you first (Allow or Deny, here or on a device near you) when an agent would click Send, Delete, Buy and the like, or press Enter in a chat, mail or payment window.", "1"),
                setting("autoOcr", "Read pixels when a window says little", "When a window exposes few controls (games, canvases, some apps), also read its text from the pixels. Needs Screen Recording access.", "1"),
                ["key": "pointerSize", "label": "Pointer size", "kind": "number", "group": "Desktop", "default": 44, "min": 24, "max": 120, "unit": "pt"],
            ]),
            "actions": .array([
                ["name": "desktop.hello", "label": "Show the pointer", "help": "The pointer appears in the middle of the screen for a few seconds."],
            ]),
            "links": .array([]),
        ])
    }

    static func setting(_ key: String, _ label: String, _ help: String, _ def: String) -> JSONValue {
        ["key": .string(key), "label": .string(label), "kind": "toggle", "group": "Desktop", "help": .string(help), "default": .string(def)]
    }
}
