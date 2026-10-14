package dev.vortexaxis.quest.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * The fast engine's wire, shared by the app (Helper) and the helper package (HelperRouter, HelperServer): one JSON
 * object per line each way. A request is `{"id": 7, "op": "dump", ...}`; its answer `{"id": 7, "ok": true, ...}` or
 * `{"id": 7, "ok": false, "code": "stale", "error": "words"}`. One request at a time on a connection.
 *
 * Ops: `ping` (version), `dump` (window, compressed, maxNodes, idleMs: the tree as Panel.fromHelper reads it),
 * `windows`, `click`/`longClick` (handle), `setText` (handle or focus, text), `scroll` (handle, forward),
 * `tap`/`longPress` (x, y), `swipe` (x1, y1, x2, y2, ms), `key` (code, ctrl, alt, shift), `back`,
 * `screenshot` (maxSide, crop) answering a base64 JPEG. Handles are valid until the next dump.
 */
public final class HelperProtocol {
    private HelperProtocol() {}

    /** The helper's package; its instrumentation targets this same package (`am instrument` force-stops its target). */
    public static final String PACKAGE = "dev.vortexaxis.quest.helper";
    public static final String INSTRUMENTATION = PACKAGE + "/.Helper";
    /** The abstract-namespace socket the helper listens on. Who may talk on it is checked by uid at both ends. */
    public static final String SOCKET = "dev.vortexaxis.quest.helper.v1";
    /** The wire's own number: changed only when the app and the helper must talk differently. */
    public static final int WIRE = 1;
    /** A line longer than this is refused (a dump of a big panel is a few hundred kilobytes; a screenshot under 1 MB). */
    public static final int MAX_LINE = 4 << 20;

    /** Error codes an answer may carry. */
    public static final String STALE = "stale", PASSWORD = "password", UNSUPPORTED = "unsupported", FAILED = "failed", BAD = "bad_request";

    /** Writes one message as one line. */
    public static void write(OutputStream out, Map<String, Object> message) throws IOException {
        byte[] b = (Json.write(message) + "\n").getBytes(StandardCharsets.UTF_8);
        out.write(b);
        out.flush();
    }

    /** Reads one line (without its newline), or null at the end of the stream. Throws when a line is too long. */
    public static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream(256);
        while (true) {
            int c = in.read();
            if (c < 0) return line.size() == 0 ? null : line.toString("UTF-8");
            if (c == '\n') return line.toString("UTF-8");
            if (line.size() >= MAX_LINE) throw new IOException("a line longer than " + MAX_LINE + " bytes");
            line.write(c);
        }
    }

    /**
     * What typing `typed` into a field leaves in it, as {text, caret}: put in at the caret, over what is selected,
     * as typing on a keyboard does (the Windows app types at the caret too). A field showing only its hint counts as
     * empty. Without a caret (-1, a field that never had the focus) the text goes at the end.
     */
    public static Object[] insert(String old, int selStart, int selEnd, boolean showingHint, String typed) {
        String now = old == null || showingHint ? "" : old;
        int a = selStart, b = selEnd;
        if (a < 0 || b < 0 || a > now.length() || b > now.length()) a = b = now.length();
        if (a > b) { int t = a; a = b; b = t; }
        String text = now.substring(0, a) + typed + now.substring(b);
        return new Object[] {text, a + typed.length()};
    }
}
