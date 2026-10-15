package dev.vortexaxis.quest.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import javax.xml.parsers.SAXParserFactory;

import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.helpers.DefaultHandler;

/**
 * A pretend helper for the tests: the REAL HelperRouter and HelperServer, over a pretend screen read from a
 * uiautomator fixture, listening on TCP instead of the headset's local socket. It is "installed" and "started" by
 * the pretend adbd (`adbd(...)`), dies when the app force-stops it, and can be made to hang or die mid-session.
 * Every action it is asked to do is kept in `calls`.
 */
final class FakeHelper implements AutoCloseable {
    /** One node of the pretend screen. */
    static final class N {
        final HelperRouter.NodeData d = new HelperRouter.NodeData();
        final List<N> kids = new ArrayList<>();
        boolean gone;
    }

    final List<String> calls = Collections.synchronizedList(new ArrayList<>());
    /** Every op the helper was asked, in order ("dump", "front", "focus", "tap", ...). */
    final List<String> ops = Collections.synchronizedList(new ArrayList<>());
    /** The package `front` says is in front; null: the screen's own. Changed by `fronts` after so many `front` calls. */
    volatile String front;
    volatile String frontLater;
    volatile int frontAfter = -1;
    volatile String version;
    volatile N root;
    /** An op that never answers while set (the helper hangs). */
    volatile String hangOn;
    /** The helper sees no window at all (its UiAutomation is dead): dumps have no tree, but it still answers pings. */
    volatile boolean blind;
    /** The port the last start was told, for the pretend logcat. */
    volatile String lastPort = "0";
    /** The helper process starts but never listens (it dies, or hangs on UiAutomation). */
    volatile boolean wontStart;
    /** The helper cannot inject a touch. */
    volatile boolean tapFails;
    /** The pretend headset's own state for the install: is the helper there, and which build's SHA-256 is noted. */
    volatile boolean installed;
    volatile String marker;
    volatile int installs, starts, stops;
    private final int port;
    private volatile ServerSocket server;
    private final List<Socket> open = Collections.synchronizedList(new ArrayList<>());

    FakeHelper(String version, String xml) throws IOException {
        this.version = version;
        try (ServerSocket probe = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"))) { port = probe.getLocalPort(); }
        setScreen(xml);
    }

    void setScreen(String xml) { root = parse(xml); }

    /** The channel the app's Helper uses here: TCP to the pretend helper (on a headset, the abstract local socket). */
    Helper.Channel channel() {
        return () -> {
            Socket s = new Socket();
            s.connect(new InetSocketAddress("127.0.0.1", port), 500);
            return new Helper.Conn() {
                @Override public InputStream in() throws IOException { return s.getInputStream(); }
                @Override public OutputStream out() throws IOException { return s.getOutputStream(); }
                @Override public void close() throws IOException { s.close(); }
            };
        };
    }

    boolean running() { return server != null; }

    /** Starts listening, as `am instrument` starting the helper does. */
    synchronized void start() throws IOException {
        if (server != null) return;
        starts++;
        ServerSocket ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress("127.0.0.1", port), 5);
        server = ss;
        // A new process: its own router, with a handle table of its own.
        HelperRouter<N> r = new HelperRouter<>(new Screen(), version);
        Thread t = new Thread(() -> {
            while (true) {
                Socket s;
                try {
                    s = ss.accept();
                } catch (IOException e) {
                    return;
                }
                open.add(s);
                Thread c = new Thread(() -> {
                    try (Socket c2 = s) {
                        HelperServer.serve(new Hanging(c2.getInputStream()), c2.getOutputStream(), r, null);
                    } catch (IOException ignored) {
                        // Closed by die().
                    }
                }, "fake-helper-conn");
                c.setDaemon(true);
                c.start();
            }
        }, "fake-helper");
        t.setDaemon(true);
        t.start();
    }

    /** The helper's process ends: every connection drops. */
    synchronized void die() {
        ServerSocket ss = server;
        server = null;
        if (ss != null) try { ss.close(); } catch (IOException ignored) {}
        synchronized (open) {
            for (Socket s : open) try { s.close(); } catch (IOException ignored) {}
            open.clear();
        }
    }

    @Override public void close() { die(); }

    /** Holds a request back while its op is `hangOn`, as a helper stuck in a call would. */
    private final class Hanging extends InputStream {
        private final InputStream in;
        private final ByteArrayOutputStream line = new ByteArrayOutputStream();

        Hanging(InputStream in) { this.in = in; }

        /** One byte at a time, so a line is seen as soon as it ends (InputStream's own would wait to fill the buffer). */
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            int c = read();
            if (c < 0) return -1;
            b[off] = (byte) c;
            return 1;
        }

        @Override public int read() throws IOException {
            int c = in.read();
            if (c < 0) return c;
            if (c != '\n') line.write(c);
            else {
                String l = line.toString("UTF-8");
                line.reset();
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"op\":\"(\\w+)\"").matcher(l);
                if (m.find()) ops.add(m.group(1));
                String h = hangOn;
                if (h != null && l.contains("\"op\":\"" + h + "\"")) {
                    try { Thread.sleep(60_000); } catch (InterruptedException e) { throw new IOException("stopped"); }
                }
            }
            return c;
        }
    }

    /** The pretend adbd's answers for the helper's install, start and stop, then `rest` for everything else. */
    Function<String, byte[]> adbd(Function<String, byte[]> rest) {
        return cmd -> {
            String out = null;
            if (cmd.startsWith("pm list packages --show-versioncode " + HelperProtocol.PACKAGE))
                out = (installed ? "package:" + HelperProtocol.PACKAGE + " versionCode:3\n" : "") + (marker != null ? marker + "\n" : "");
            else if (cmd.startsWith("cp ") && cmd.contains("pm install -r " + Helper.STAGED)) {
                die();
                installs++;
                installed = true;
                out = "Performing Streamed Install\nSuccess\n";
            } else if (cmd.startsWith("echo ") && cmd.endsWith("> " + Helper.MARKER)) {
                marker = cmd.substring(5, cmd.indexOf(' ', 5));
                out = "";
            } else if (cmd.startsWith("am force-stop " + HelperProtocol.PACKAGE) || cmd.startsWith("rm -f " + Helper.STATUS + "; am force-stop " + HelperProtocol.PACKAGE)) {
                if (running()) stops++;
                die();
                out = cmd.endsWith("echo stopped") ? "stopped\n" : "";
            } else if (cmd.startsWith("am instrument -w ")) {
                // Like the real `am instrument -w`: runs for as long as the helper does.
                java.util.regex.Matcher pm = java.util.regex.Pattern.compile("-e port (\\d+)").matcher(cmd);
                if (pm.find()) lastPort = pm.group(1);
                try {
                    if (installed && !wontStart) start();
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
                long until = System.currentTimeMillis() + 120_000;
                while (running() && System.currentTimeMillis() < until) {
                    try { Thread.sleep(50); } catch (InterruptedException e) { break; }
                }
                out = "INSTRUMENTATION_RESULT: stopped=done\nINSTRUMENTATION_CODE: -1\n";
            } else if (cmd.startsWith("logcat -d")) out = "10-14 21:00:00.000  1  1 I VortexAxisHelper: onCreate (pid 1, uid 10124, port " + lastPort + ")\n10-14 21:00:00.050  1  1 I VortexAxisHelper: checks passed (app uid 10123, port " + lastPort + ")\n";
            else if (cmd.startsWith("tail -n 6 " + Helper.STATUS)) out = "";
            return out != null ? out.getBytes(StandardCharsets.UTF_8) : rest.apply(cmd);
        };
    }

    // ---- the pretend screen --------------------------------------------------------

    static N parse(String xml) {
        N top = new N();
        try {
            SAXParserFactory.newInstance().newSAXParser().parse(new InputSource(new StringReader(xml)), new DefaultHandler() {
                final ArrayList<N> stack = new ArrayList<>(List.of(top));

                @Override public void startElement(String uri, String local, String q, Attributes a) {
                    if (!"node".equals(q)) return;
                    N n = new N();
                    HelperRouter.NodeData d = n.d;
                    d.cls = v(a, "class");
                    d.pkg = v(a, "package");
                    d.text = v(a, "text");
                    d.desc = v(a, "content-desc");
                    d.hint = v(a, "hint");
                    d.resId = v(a, "resource-id");
                    int[] b = Panel.bounds(v(a, "bounds"));
                    d.left = b[0];
                    d.top = b[1];
                    d.right = b[2];
                    d.bottom = b[3];
                    d.clickable = "true".equals(v(a, "clickable"));
                    d.longClickable = "true".equals(v(a, "long-clickable"));
                    d.scrollable = "true".equals(v(a, "scrollable"));
                    d.enabled = !"false".equals(v(a, "enabled"));
                    d.focusable = "true".equals(v(a, "focusable"));
                    d.focused = "true".equals(v(a, "focused"));
                    d.checkable = "true".equals(v(a, "checkable"));
                    d.checked = "true".equals(v(a, "checked"));
                    d.selected = "true".equals(v(a, "selected"));
                    d.password = "true".equals(v(a, "password"));
                    d.editable = d.cls.endsWith("EditText") || d.password;
                    stack.get(stack.size() - 1).kids.add(n);
                    stack.add(n);
                }

                @Override public void endElement(String uri, String local, String q) {
                    if ("node".equals(q)) stack.remove(stack.size() - 1);
                }
            });
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        return top.kids.get(0);
    }

    private static String v(Attributes a, String k) {
        String s = a.getValue(k);
        return s == null ? "" : s;
    }

    static String name(N n) { return !n.d.resId.isEmpty() ? n.d.resId.substring(n.d.resId.indexOf('/') + 1) : !n.d.text.isEmpty() ? n.d.text : n.d.desc; }

    private N find(N n, java.util.function.Predicate<N> p) {
        if (p.test(n)) return n;
        for (N k : n.kids) {
            N f = find(k, p);
            if (f != null) return f;
        }
        return null;
    }

    final class Screen implements HelperRouter.Device<N> {
        @Override public List<Map<String, Object>> windows() {
            List<Map<String, Object>> all = new ArrayList<>();
            all.add(Json.obj("id", 1, "title", "Store", "package", root.d.pkg, "display", 0, "type", 1, "active", true, "focused", true));
            all.addAll(moreWindows);
            return all;
        }
        @Override public N root(Integer windowId, boolean compressed, int idleMs) { return blind ? null : root; }
        @Override public String[] front() {
            if (frontAfter == 0 && frontLater != null) front = frontLater;
            if (frontAfter >= 0) frontAfter--;
            return new String[] {front != null ? front : root.d.pkg, "Store"};
        }
        @Override public HelperRouter.NodeData read(N n) { return n.d; }
        @Override public int childCount(N n) { return n.kids.size(); }
        @Override public N child(N n, int i) { return n.kids.get(i); }
        @Override public boolean refresh(N n) { return !n.gone; }
        @Override public boolean click(N n) { calls.add("click " + name(n)); return true; }
        @Override public boolean longClick(N n) { calls.add("longClick " + name(n)); return true; }
        @Override public boolean focus(N n) {
            calls.add("focus " + name(n));
            N was = find(root, x -> x.d.focused);
            if (was != null) was.d.focused = false;
            n.d.focused = true;
            return true;
        }
        @Override public boolean setText(N n, String text, int caret) {
            calls.add("setText " + name(n) + " = " + text + " @" + caret);
            n.d.text = text;
            n.d.selStart = n.d.selEnd = caret;
            return true;
        }
        @Override public boolean scroll(N n, boolean forward) { calls.add("scroll " + (forward ? "forward" : "backward")); return true; }
        @Override public N focusedInput() { return find(root, x -> x.d.focused && x.d.editable); }
        @Override public void tap(int x, int y) {
            if (tapFails) throw new IllegalStateException("the touch was not taken");
            calls.add("tap " + x + "," + y);
        }
        @Override public void longPress(int x, int y) { calls.add("longPress " + x + "," + y); }
        @Override public void swipe(int x1, int y1, int x2, int y2, int ms) { calls.add("swipe " + x1 + "," + y1 + " " + x2 + "," + y2 + " " + ms); }
        @Override public void drag(int x1, int y1, int x2, int y2, int holdMs, int ms) { calls.add("drag " + x1 + "," + y1 + " " + x2 + "," + y2 + " hold " + holdMs); }
        @Override public void key(int code, boolean ctrl, boolean alt, boolean shift) { calls.add("key " + (ctrl ? "ctrl+" : "") + (alt ? "alt+" : "") + (shift ? "shift+" : "") + code); }
        @Override public void back() { calls.add("back"); }
        @Override public Object[] screenshot(int maxSide, int[] crop) throws IOException {
            calls.add("screenshot " + maxSide + (crop == null ? "" : " crop"));
            PanelCommands.Shot s = new T.JvmPictures().shrink(T.png(), maxSide, crop);
            return new Object[] {s.jpeg, s.w, s.h};
        }
    }

    /** Windows besides the one in front, as the helper lists them. */
    final List<Map<String, Object>> moreWindows = new ArrayList<>();

    /** The ops since the last call, and forgets them. */
    List<String> takeOps() {
        synchronized (ops) {
            List<String> out = new ArrayList<>(ops);
            ops.clear();
            return out;
        }
    }

    /** The calls since the last take, and forgets them. */
    List<String> take() {
        synchronized (calls) {
            List<String> out = new ArrayList<>(calls);
            calls.clear();
            return out;
        }
    }
}
