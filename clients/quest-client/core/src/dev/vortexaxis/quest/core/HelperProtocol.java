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
 * `windows`, `front` (idleMs, quietMs: the active window's package and title, and a count of accessibility events,
 * after waiting for the screen to settle; 0.3.3), `focus` (what has the input focus: password, editable, name,
 * handle; 0.3.3), `click`/`longClick` (handle), `setText` (handle or focus, text), `scroll` (handle, forward),
 * `tap`/`longPress` (x, y), `swipe` (x1, y1, x2, y2, ms), `key` (code, ctrl, alt, shift), `back`,
 * `screenshot` (maxSide, crop) answering a base64 JPEG. Handles are valid until the next dump.
 */
public final class HelperProtocol {
    private HelperProtocol() {}

    /** The helper's package; its instrumentation targets this same package (`am instrument` force-stops its target). */
    public static final String PACKAGE = "dev.vortexaxis.quest.helper";
    public static final String INSTRUMENTATION = PACKAGE + "/.Helper";
    /** 0.3.0 listened on this abstract-namespace socket; the headset refuses an app that connects to it. Kept for the record. */
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

    // ---- proving both ends know the secret -------------------------------------------------------------
    //
    // The helper listens on a loopback TCP port (the abstract local socket 0.3.0 used is refused to an app by the
    // headset's SELinux policy: "Permission denied"), and any app on the headset can connect to such a port. So
    // before a line of the protocol, each end proves it holds a secret the app passed to the helper on its start
    // command, without ever sending it: a challenge each way, answered with an HMAC. An app that got to the port
    // first learns nothing it could use, and one that connects to the helper gets nothing answered.
    //   app -> helper: hello <app nonce>
    //   helper -> app: ok <helper nonce> <hmac(secret, "S" + app nonce + helper nonce)>
    //   app -> helper: auth <hmac(secret, "C" + app nonce + helper nonce)>

    private static final java.security.SecureRandom RANDOM = new java.security.SecureRandom();

    /** 16 random bytes as hex, for a nonce or a secret. */
    public static String nonce() {
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        return hex(b);
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    static String mac(String secret, String data) {
        try {
            javax.crypto.Mac m = javax.crypto.Mac.getInstance("HmacSHA256");
            m.init(new javax.crypto.spec.SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return hex(m.doFinal(data.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    private static boolean same(String a, String b) {
        return java.security.MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    private static String[] words(String line, String first, int count) {
        if (line == null) return null;
        String[] w = line.trim().split(" ");
        return w.length == count && w[0].equals(first) && w[1].matches("[0-9a-f]{32}") ? w : null;
    }

    /** The app's side, on a fresh connection. Throws when the other end does not know the secret. */
    public static void clientHandshake(InputStream in, OutputStream out, String secret) throws IOException {
        String mine = nonce();
        out.write(("hello " + mine + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
        String[] ok = words(readLine(in), "ok", 3);
        if (ok == null || !same(ok[2], mac(secret, "S" + mine + ok[1])))
            throw new IOException("whatever answers on the helper's port does not know the secret");
        out.write(("auth " + mac(secret, "C" + mine + ok[1]) + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    /** The helper's side. False (and nothing useful said) when the app does not know the secret. */
    public static boolean serverHandshake(InputStream in, OutputStream out, String secret) throws IOException {
        String[] hello = words(readLine(in), "hello", 2);
        if (hello == null) return false;
        String mine = nonce();
        out.write(("ok " + mine + " " + mac(secret, "S" + hello[1] + mine) + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
        String line = readLine(in);
        String[] auth = line == null ? null : line.trim().split(" ");
        return auth != null && auth.length == 2 && auth[0].equals("auth") && same(auth[1], mac(secret, "C" + hello[1] + mine));
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
