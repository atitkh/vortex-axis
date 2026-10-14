package dev.vortexaxis.quest.core;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Building the shell commands sent to adbd, where nothing an agent says may become shell syntax:
 * every value is a number checked here, a package name checked against a strict pattern, or text
 * inside single quotes.
 */
public final class Shell {
    private Shell() {}

    /** `s` as one shell word: single-quoted, each ' written as '\''. */
    public static String quote(String s) {
        return "'" + s.replace("'", "'\\''") + "'";
    }

    /**
     * The commands that type `text` into what has the focus: `input text` for the plain parts (spaces
     * as %s, which is how `input` reads a space), Enter for a newline, Tab for a tab. Throws, with
     * words for the agent, on what `input text` cannot type: anything outside plain ASCII, control
     * characters, and a literal "%s" (input would turn it into a space).
     */
    public static List<String> typeCommands(String text) {
        List<String> out = new ArrayList<>();
        StringBuilder part = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\r') continue;
            if (c == '\n' || c == '\t') {
                flush(out, part);
                out.add("input keyevent " + (c == '\n' ? Keys.ENTER : Keys.TAB));
                continue;
            }
            if (c < 0x20 || c == 0x7f) throw new IllegalArgumentException("the text has a control character, which cannot be typed");
            if (c > 0x7e) {
                String shown = Character.isSurrogate(c) && i + 1 < text.length() ? text.substring(i, i + 2) : String.valueOf(c);
                throw new IllegalArgumentException("a Quest can only be typed plain ASCII from here (adb's input text); \"" + shown
                        + "\" cannot be typed. Leave such characters out, or ask the person to type them");
            }
            if (c == 's' && part.length() > 0 && part.charAt(part.length() - 1) == '%')
                throw new IllegalArgumentException("the text has \"%s\", which adb's input text turns into a space; it cannot be typed as it is");
            part.append(c == ' ' ? "%s" : String.valueOf(c));
        }
        flush(out, part);
        return out;
    }

    private static void flush(List<String> out, StringBuilder part) {
        if (part.length() == 0) return;
        out.add("input text " + quote(part.toString()));
        part.setLength(0);
    }

    /** An http(s) address safe to hand to `am start -d`, or an exception saying why not. */
    public static String checkUrl(String url) {
        if (url.length() > 500) throw new IllegalArgumentException("the address is longer than 500 characters");
        for (int i = 0; i < url.length(); i++) {
            char c = url.charAt(i);
            if (c <= 0x20 || c >= 0x7f) throw new IllegalArgumentException("the address has a space, a control character or a non-ASCII character; encode it (%20 and the like) first");
        }
        URI u;
        try {
            u = new URI(url);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("that is not an address: " + e.getReason());
        }
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) throw new IllegalArgumentException("the app only opens http and https addresses");
        if (u.getHost() == null || u.getHost().isEmpty()) throw new IllegalArgumentException("the address has no host");
        return url;
    }

    private static final java.util.regex.Pattern PACKAGE = java.util.regex.Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+");

    /** True for a well-formed Android package name, the only form one may take in a command. */
    public static boolean isPackage(String pkg) {
        return pkg != null && pkg.length() <= 200 && PACKAGE.matcher(pkg).matches();
    }
}
