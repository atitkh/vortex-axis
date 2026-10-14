package dev.vortexaxis.quest.core;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * A key combination as an agent writes it ("enter", "ctrl+a", "back"), mapped to Android key codes
 * for `input keyevent`. The same names as the Windows app where Android has the key; `home` and
 * `end` are the text cursor keys there too, never the Quest's own Home. Keys that leave the panel
 * or switch the headset off are refused, as the Windows app refuses lock and sign-out.
 */
public final class Keys {
    public static final int ENTER = 66, TAB = 61;
    static final int CTRL = 113, ALT = 57, SHIFT = 59;

    private static final Map<String, Integer> NAMED = new HashMap<>();
    private static final Map<String, String> ALIASES = new HashMap<>();
    private static final Map<String, String> BLOCKED = new HashMap<>();

    static {
        NAMED.put("enter", ENTER);
        NAMED.put("tab", TAB);
        NAMED.put("escape", 111);
        NAMED.put("backspace", 67);
        NAMED.put("delete", 112);
        NAMED.put("insert", 124);
        NAMED.put("space", 62);
        NAMED.put("up", 19);
        NAMED.put("down", 20);
        NAMED.put("left", 21);
        NAMED.put("right", 22);
        NAMED.put("home", 122);
        NAMED.put("end", 123);
        NAMED.put("pageup", 92);
        NAMED.put("pagedown", 93);
        NAMED.put("menu", 82);
        NAMED.put("back", 4);
        NAMED.put("volumeup", 24);
        NAMED.put("volumedown", 25);
        NAMED.put("volumemute", 164);
        NAMED.put("mediaplaypause", 85);
        NAMED.put("medianext", 87);
        NAMED.put("mediaprevious", 88);
        NAMED.put("mediastop", 86);
        NAMED.put(",", 55);
        NAMED.put(".", 56);
        NAMED.put("-", 69);
        NAMED.put("=", 70);
        NAMED.put("[", 71);
        NAMED.put("]", 72);
        NAMED.put("\\", 73);
        NAMED.put(";", 74);
        NAMED.put("'", 75);
        NAMED.put("/", 76);
        NAMED.put("`", 68);
        for (int i = 0; i < 26; i++) NAMED.put(String.valueOf((char) ('a' + i)), 29 + i);
        for (int i = 0; i < 10; i++) NAMED.put(String.valueOf((char) ('0' + i)), 7 + i);
        for (int i = 1; i <= 12; i++) NAMED.put("f" + i, 130 + i);

        ALIASES.put("return", "enter");
        ALIASES.put("esc", "escape");
        ALIASES.put("del", "delete");
        ALIASES.put("ins", "insert");
        ALIASES.put("pgup", "pageup");
        ALIASES.put("pgdn", "pagedown");
        ALIASES.put("arrowup", "up");
        ALIASES.put("arrowdown", "down");
        ALIASES.put("arrowleft", "left");
        ALIASES.put("arrowright", "right");
        ALIASES.put("spacebar", "space");
        ALIASES.put("playpause", "mediaplaypause");
        ALIASES.put("mute", "volumemute");

        BLOCKED.put("power", "the power key");
        BLOCKED.put("sleep", "putting the headset to sleep");
        BLOCKED.put("lock", "locking the headset");
        BLOCKED.put("wakeup", "the power key");
        BLOCKED.put("appswitch", "leaving the panel");
        BLOCKED.put("recents", "leaving the panel");
        BLOCKED.put("assist", "the assistant");
        BLOCKED.put("voiceassist", "the assistant");
    }

    public final boolean ctrl, alt, shift;
    public final String key;
    public final int code;

    private Keys(boolean ctrl, boolean alt, boolean shift, String key, int code) {
        this.ctrl = ctrl;
        this.alt = alt;
        this.shift = shift;
        this.key = key;
        this.code = code;
    }

    /** Reads "Ctrl+A" and the like. Throws IllegalArgumentException, in words for the agent, on anything it will not press. */
    public static Keys parse(String text) {
        String t = (text == null ? "" : text).toLowerCase(Locale.ROOT).replace(" ", "");
        List<String> parts = new ArrayList<>();
        // "ctrl++" is ctrl and the + key; split on + between names only.
        for (String p : t.split("\\+")) if (!p.isEmpty()) parts.add(p);
        if (parts.isEmpty()) throw new IllegalArgumentException("keys is empty");
        boolean ctrl = false, alt = false, shift = false;
        for (String m : parts.subList(0, parts.size() - 1)) {
            switch (m) {
                case "ctrl": case "control": ctrl = true; break;
                case "alt": case "option": alt = true; break;
                case "shift": shift = true; break;
                case "win": case "windows": case "meta": case "super": case "cmd":
                    throw new IllegalArgumentException("a Quest has no Windows or Command key");
                default:
                    throw new IllegalArgumentException("\"" + m + "\" is not a modifier (ctrl, alt, shift)");
            }
        }
        String key = parts.get(parts.size() - 1);
        String alias = ALIASES.get(key);
        if (alias != null) key = alias;
        String blocked = BLOCKED.get(key);
        if (blocked != null) throw new Refused(key, blocked);
        Integer code = NAMED.get(key);
        if (code == null) throw new IllegalArgumentException("\"" + parts.get(parts.size() - 1) + "\" is not a key a Quest panel takes (enter, tab, escape, backspace, delete, arrows, home, end, pageup, pagedown, back, a letter or digit)");
        return new Keys(ctrl, alt, shift, key, code);
    }

    /** A key the app never presses, whatever an agent asks. */
    public static final class Refused extends IllegalArgumentException {
        public final String key;

        Refused(String key, String what) {
            super("the app never presses " + key + " (" + what + ")");
            this.key = key;
        }
    }

    public boolean combination() { return ctrl || alt || shift; }

    /** The shell command that presses it. */
    public String command() {
        if (!combination()) return "input keyevent " + code;
        // `input keycombination` (Android 13 and later) holds the modifiers down with the key.
        StringBuilder sb = new StringBuilder("input keycombination");
        if (ctrl) sb.append(' ').append(CTRL);
        if (alt) sb.append(' ').append(ALT);
        if (shift) sb.append(' ').append(SHIFT);
        return sb.append(' ').append(code).toString();
    }

    @Override public String toString() {
        StringBuilder sb = new StringBuilder();
        if (ctrl) sb.append("ctrl+");
        if (alt) sb.append("alt+");
        if (shift) sb.append("shift+");
        return sb.append(key).toString();
    }
}
