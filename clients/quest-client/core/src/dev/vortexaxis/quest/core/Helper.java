package dev.vortexaxis.quest.core;

import java.io.BufferedInputStream;
import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The fast engine, from the app's side: the helper package (`dev.vortexaxis.quest.helper`, carried inside this app)
 * holds one UiAutomation connection and answers over a local socket (HelperProtocol), so a look is one call instead
 * of a `uiautomator dump` process, and an element is pressed or filled by its handle.
 *
 * Kept up by `tick()` (the app calls it every few seconds): installs the helper through the app's adb when it is
 * missing or not the one this app carries (`pm install -r`, then its SHA-256 is noted in /data/local/tmp), starts it
 * detached as SelfUpdate starts an install (`am instrument -w` under nohup, as the shell user, so it dies with the
 * headset's restart as `adb tcpip` does), connects, and pings it while it is idle. When it does not answer it is
 * stopped (its UiAutomation connection would otherwise keep `uiautomator dump` from working) and started again later,
 * waiting longer each time. Every call has a deadline. While it is not Fast, PanelCommands uses the shell.
 */
public final class Helper {
    public enum State {
        /** "Use fast engine" is off. */
        OFF,
        STARTING,
        /** Connected and answering. */
        FAST,
        /** Not available (adb not ready, it would not start, it stopped answering): looks use uiautomator. */
        BASIC,
    }

    /** One connection to the helper; the app checks who is at the other end before it hands one out. */
    public interface Conn extends Closeable {
        InputStream in() throws IOException;
        OutputStream out() throws IOException;

        /** Called once the handshake is over: reads may wait as long as a call's own deadline says. */
        default void relax() throws IOException {}
    }

    /** How to reach the helper: loopback TCP on the headset (and to a pretend helper in tests). */
    public interface Channel {
        Conn open() throws IOException;

        /** Before each start: the port the new helper will listen on and the secret both ends prove they hold. Tests ignore it. */
        default void prepare(int port, String secret) {}

        /** The secret to prove on each new connection, or null for none (a pretend helper in tests). */
        default String secret() { return null; }
    }

    /** What only the Android side knows. */
    public interface Host {
        /** The helper APK this app carries, written where the shell user can read it (the app's external files); null when it has none. */
        File apk() throws IOException;
        /** The SHA-256 of that APK, hex, or null when it has none. */
        String sha256();
        /** This app's uid: the only one the helper answers. */
        int uid();
    }

    public interface Listener { void state(State state, String detail); }

    /** The helper answered, with a refusal or a failure (`code` from HelperProtocol). */
    public static final class Failed extends IOException {
        public final String code;

        Failed(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** No answer: the connection failed or the deadline passed. `sent`: the request had gone out, so it may have been done. */
    public static final class Lost extends IOException {
        public final boolean sent;

        Lost(boolean sent, String message) {
            super(message);
            this.sent = sent;
        }
    }

    static final String STAGED = "/data/local/tmp/vortex-axis-helper.apk";
    static final String MARKER = "/data/local/tmp/vortex-axis-helper.sha";
    static final String LOG = "/data/local/tmp/vortex-axis-helper.log";
    static final int PING_MS = 3000, INSTALL_MS = 60_000;
    /** How long a start may take before the helper's socket answers. */
    /** How long a started helper gets to answer: a fresh process connecting UiAutomation took most of 8 s on a Quest. */
    int startMs = 25_000;
    /** Waits before trying again after a failure: doubled each time, from the first to the last. */
    long retryFirstMs = 4_000, retryMaxMs = 5 * 60_000;

    private final AdbLink adb;
    private final RollingLog log;
    private final String version;
    private volatile Host host;
    private volatile Channel channel;
    private volatile Listener listener = (s, d) -> {};
    private volatile PanelCommands.Diary diary = what -> {};
    private volatile boolean enabled = true;
    private volatile State state = State.BASIC;
    private volatile String detail = "not started yet";
    private final ReentrantLock io = new ReentrantLock();
    private final Object life = new Object();
    private Conn conn;
    private OutputStream out;
    private BlockingQueue<Object> answers;
    private long nextId;
    private int failures;
    private long nextTryAt;
    private static final Object EOF = new Object();

    public Helper(AdbLink adb, RollingLog log, String version) {
        this.adb = adb;
        this.log = log;
        this.version = version;
    }

    public void setHost(Host h) { host = h; }
    public void setChannel(Channel c) { channel = c; }
    public void setListener(Listener l) { listener = l == null ? (s, d) -> {} : l; }
    public void setDiary(PanelCommands.Diary d) { diary = d == null ? what -> {} : d; }
    public State state() { return state; }
    public String detail() { return detail; }
    public boolean enabled() { return enabled; }

    /** True when calls should go to the helper. */
    public boolean usable() { return enabled && state == State.FAST; }

    private void set(State s, String d) {
        boolean changed = s != state || !d.equals(detail);
        state = s;
        detail = d;
        if (changed) {
            log.line("engine: " + s + (d.isEmpty() ? "" : " (" + d + ")"));
            try { listener.state(s, d); } catch (RuntimeException ignored) {}
        }
    }

    /** "Use fast engine". Off stops the helper, so uiautomator can have the screen. */
    public void setEnabled(boolean on) {
        enabled = on;
        synchronized (life) {
            if (!on) {
                stopHelper();
                set(State.OFF, "switched off");
            } else if (state == State.OFF) {
                failures = 0;
                nextTryAt = 0;
                set(State.BASIC, "starting soon");
            }
        }
    }

    // ---- keeping it up ---------------------------------------------------------

    /** Checks on the helper: pings it when idle, starts it when it is down and its wait is over. Blocking; never throws. */
    public void tick() {
        synchronized (life) {
            if (!enabled) {
                if (state != State.OFF) {
                    stopHelper();
                    set(State.OFF, "switched off");
                }
                return;
            }
            if (state == State.FAST) {
                // A command in flight is proof enough; otherwise a ping.
                if (!io.tryLock()) return;
                try {
                    call0("ping", Json.obj(), PING_MS);
                } catch (IOException e) {
                    lostLocked("it did not answer a ping (" + AxisLink.describe(e) + ")");
                } finally {
                    io.unlock();
                }
                return;
            }
            if (System.currentTimeMillis() < nextTryAt) return;
            start();
        }
    }

    private void start() {
        Host h = host;
        Channel ch = channel;
        if (h == null || ch == null || h.sha256() == null) {
            set(State.BASIC, "this build has no fast engine");
            nextTryAt = Long.MAX_VALUE;
            return;
        }
        set(State.STARTING, "connecting");
        // Already running (the app was restarted, or updated itself, and the helper went on): use it if it is this app's.
        String running = tryConnect(ch);
        if (version.equals(running)) {
            started("already running");
            return;
        }
        if (!adb.ready()) {
            try {
                adb.ensure();
            } catch (IOException e) {
                failed("waiting for adb: " + adb.problem());
                return;
            }
        }
        try {
            closeConn();
            set(State.STARTING, "checking the helper");
            if (installIfNeeded(h)) set(State.STARTING, "installed; starting");
            else set(State.STARTING, "starting");
            lastConnectError = "";
            // A new port and secret for every start: only the helper this app has just started can answer them.
            int port = 20_000 + new java.security.SecureRandom().nextInt(40_000);
            String secret = HelperProtocol.nonce();
            ch.prepare(port, secret);
            String said = adb.shell(startCommand(h.uid(), port, secret), 10_000);
            if (!said.contains("helper-started")) throw new IOException("the start was not taken: " + firstLine(said));
            long end = System.currentTimeMillis() + startMs;
            String v = null;
            while (System.currentTimeMillis() < end) {
                Thread.sleep(250);
                v = tryConnect(ch);
                if (v != null) break;
            }
            if (v == null) throw new IOException("it did not answer within " + startMs / 1000 + " s" + startLog());
            if (!version.equals(v)) throw new IOException("it is version " + v + ", not " + version);
            started("started");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            failed("interrupted");
        } catch (Exception e) {
            failed(AxisLink.describe(e));
        }
    }

    private void started(String how) {
        failures = 0;
        set(State.FAST, how);
        try { diary.did("Fast engine on (" + how + ")"); } catch (RuntimeException ignored) {}
    }

    private void failed(String why) {
        closeConn();
        stopHelper();
        failures++;
        long wait = Math.min(retryMaxMs, retryFirstMs << Math.min(10, failures - 1));
        nextTryAt = System.currentTimeMillis() + wait;
        set(State.BASIC, why + "; trying again in " + Math.max(1, wait / 1000) + " s");
    }

    /** Called by PanelCommands when the helper did not answer a call: stopped, Basic, started again later. Logged once. */
    public void lost(String why) {
        synchronized (life) {
            if (state != State.FAST) return;
            lostLocked(why);
        }
    }

    private void lostLocked(String why) {
        try { diary.did("Fast engine stopped answering (" + PanelCommands.clip(why, 80) + "); using uiautomator until it is back"); } catch (RuntimeException ignored) {}
        closeConn();
        stopHelper();
        failures = Math.max(failures, 0) + 1;
        // The first restart soon: a helper that died with the headset's adb comes back with it.
        nextTryAt = System.currentTimeMillis() + Math.min(retryFirstMs, 5000);
        set(State.BASIC, why);
    }

    /** Stops the helper for a moment (Test reads with uiautomator too, which cannot while the helper holds the screen). Back on the next tick. */
    public void pause(String why) {
        synchronized (life) {
            if (state != State.FAST) return;
            closeConn();
            stopHelper();
            nextTryAt = 0;
            set(State.BASIC, why);
        }
    }

    /** Stops the helper (when the app is going away). A later tick starts it again. */
    public void shutdown() {
        synchronized (life) {
            closeConn();
            stopHelper();
            nextTryAt = 0;
            if (state != State.OFF) set(State.BASIC, "stopped");
        }
    }

    private void stopHelper() {
        closeConn();
        try {
            if (adb.ready()) adb.shell("am force-stop " + HelperProtocol.PACKAGE, 5000);
        } catch (IOException ignored) {
            // Its next start stops it first anyway.
        }
    }

    /** The helper's version when it answers on the channel, else null (and no connection is kept). */
    private String tryConnect(Channel ch) {
        try {
            openConn(ch);
            Map<String, Object> pong = call("ping", Json.obj(), PING_MS);
            String v = Json.str(pong, "version");
            if (v != null && version.equals(v)) return v;
            closeConn();
            return v;
        } catch (IOException e) {
            lastConnectError = AxisLink.describe(e);
            closeConn();
            return null;
        }
    }

    /**
     * Installs the carried helper when the headset has no helper or another one than this app carries (told by the
     * SHA-256 noted after the last install). True when it installed.
     */
    boolean installIfNeeded(Host h) throws IOException {
        String sha = h.sha256();
        String out = adb.shell("pm list packages --show-versioncode " + HelperProtocol.PACKAGE + "; cat " + MARKER + " 2>/dev/null", 10_000);
        boolean installed = Pattern.compile("(?m)^package:" + Pattern.quote(HelperProtocol.PACKAGE) + "(\\s|$)").matcher(out).find();
        Matcher m = Pattern.compile("(?m)^([0-9a-f]{64})\\s*$").matcher(out);
        String noted = m.find() ? m.group(1) : null;
        if (installed && sha.equals(noted)) return false;
        File apk = h.apk();
        if (apk == null) throw new IOException("this build carries no helper");
        String source = apk.getAbsolutePath();
        if (!SAFE_PATH.matcher(source).matches()) throw new IOException("the helper's folder has an odd name: " + source);
        log.line("engine: installing the helper (" + (installed ? "another build was there" : "not installed") + ")");
        String said = adb.shell(installCommand(source), INSTALL_MS);
        if (!said.contains("Success") && (said.contains("INSTALL_FAILED_UPDATE_INCOMPATIBLE") || said.contains("INSTALL_FAILED_VERSION_DOWNGRADE"))) {
            // Signed with another key, or newer: it is only ever ours, so it goes and this one comes.
            adb.shell("pm uninstall " + HelperProtocol.PACKAGE, 30_000);
            said = adb.shell(installCommand(source), INSTALL_MS);
        }
        if (!said.contains("Success")) throw new IOException("the helper could not be installed: " + firstLine(said));
        adb.shell("echo " + sha + " > " + MARKER, 5000);
        try { diary.did("Installed the fast engine's helper"); } catch (RuntimeException ignored) {}
        return true;
    }

    private static final Pattern SAFE_PATH = Pattern.compile("/[A-Za-z0-9._/-]+");

    static String installCommand(String source) {
        return "cp " + Shell.quote(source) + " " + STAGED + " && chmod 644 " + STAGED + " && pm install -r " + STAGED + " 2>&1; rm -f " + STAGED;
    }

    /** Stops any helper that runs, then starts it detached (SelfUpdate's way), answering only `uid`, its words kept in LOG. */
    static String startCommand(int uid, int port, String secret) {
        // A second after the force-stop: the old process's UiAutomation connection is still being cleared, and a
        // helper started on top of it failed its first tries (the window sat on "Starting" for minutes).
        return "rm -f " + STATUS + "; am force-stop " + HelperProtocol.PACKAGE + "; sleep 1; "
                + Shell.detached("am instrument -w -e uid " + uid + " -e port " + port + " -e secret " + secret + " "
                        + HelperProtocol.INSTRUMENTATION + " > " + LOG + " 2>&1", "helper-started");
    }

    /**
     * The helper writes how far it got here, and any crash. Its process runs as the helper app's own uid (only the
     * UiAutomation connection is the shell's), so it can write its own external files folder and not /data/local/tmp,
     * which 0.3.1 tried: the file was never written, and "it wrote no status" meant nothing.
     */
    static final String STATUS = "/sdcard/Android/data/" + HelperProtocol.PACKAGE + "/files/status.txt";
    /** Why the last connection to the helper's socket failed (empty: none yet), for the message when it never answers. */
    private volatile String lastConnectError = "";

    private String startLog() {
        StringBuilder out = new StringBuilder();
        try {
            // What `am instrument` printed: the helper's own steps as INSTRUMENTATION_STATUS notes, and how it ended.
            String log = adb.shell("tail -n 60 " + LOG + " 2>/dev/null", 3000);
            StringBuilder trail = new StringBuilder();
            StringBuilder ended = new StringBuilder();
            for (String line : log.split("\n")) {
                String t = line.trim();
                if (t.startsWith("INSTRUMENTATION_STATUS: note=")) trail.append(trail.length() > 0 ? " | " : "").append(t.substring("INSTRUMENTATION_STATUS: note=".length()));
                else if (t.startsWith("INSTRUMENTATION_RESULT:") || t.startsWith("INSTRUMENTATION_FAILED") || t.startsWith("Error") || t.startsWith("java.") || t.startsWith("android."))
                    ended.append(ended.length() > 0 ? " | " : "").append(t);
            }
            out.append(trail.length() == 0 ? " (the helper reported no step: it did not reach its own code)" : " (the helper got as far as: " + tailOf(trail.toString(), 450) + ")");
            if (ended.length() > 0) out.append(" (am said: ").append(tailOf(ended.toString(), 220)).append(')');
            String file = adb.shell("tail -n 6 " + STATUS + " 2>/dev/null", 3000).trim();
            if (!file.isEmpty()) out.append(" (status file: ").append(tailOf(file.replace('\n', '|'), 300)).append(')');
        } catch (IOException ignored) {
            // The reasons are only help; the failure is told anyway.
        }
        if (!lastConnectError.isEmpty()) out.append(" (connecting said: ").append(PanelCommands.clip(lastConnectError, 160)).append(')');
        return out.toString();
    }

    private static String tailOf(String s, int n) { return s.length() <= n ? s : "…" + s.substring(s.length() - n); }

    // ---- calls -----------------------------------------------------------------

    private void openConn(Channel ch) throws IOException {
        closeConn();
        Conn c = ch.open();
        String secret = ch.secret();
        if (secret != null) {
            try {
                HelperProtocol.clientHandshake(c.in(), c.out(), secret);
                c.relax();
            } catch (IOException e) {
                try { c.close(); } catch (IOException ignored) {}
                throw e;
            }
        }
        BlockingQueue<Object> q = new LinkedBlockingQueue<>();
        InputStream in = new BufferedInputStream(c.in(), 64 * 1024);
        Thread reader = new Thread(() -> {
            try {
                String line;
                while ((line = HelperProtocol.readLine(in)) != null) {
                    try { q.add(Json.parseObject(line)); } catch (IllegalArgumentException ignored) {}
                }
            } catch (IOException ignored) {
                // Closed: the call waiting is told below.
            }
            q.add(EOF);
        }, "axis-helper-read");
        reader.setDaemon(true);
        synchronized (this) {
            conn = c;
            out = c.out();
            answers = q;
        }
        reader.start();
    }

    private synchronized void closeConn() {
        Conn c = conn;
        conn = null;
        out = null;
        answers = null;
        if (c != null) try { c.close(); } catch (IOException ignored) {}
    }

    /**
     * One request and its answer within `timeoutMs`. Throws Failed when the helper answered with a refusal, Lost when
     * there was no answer (the connection is then dropped; the caller tells `lost`).
     */
    public Map<String, Object> call(String op, Map<String, Object> params, int timeoutMs) throws IOException {
        boolean locked;
        try {
            locked = io.tryLock(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Lost(false, "interrupted");
        }
        if (!locked) throw new Lost(false, "the fast engine is busy");
        try {
            return call0(op, params, timeoutMs);
        } finally {
            io.unlock();
        }
    }

    private Map<String, Object> call0(String op, Map<String, Object> params, int timeoutMs) throws IOException {
        OutputStream o;
        BlockingQueue<Object> q;
        long id;
        synchronized (this) {
            o = out;
            q = answers;
            id = ++nextId;
        }
        if (o == null || q == null) throw new Lost(false, "the fast engine is not connected");
        // What is left from before: answers to calls given up on, or the end of a helper that died meanwhile.
        for (Object left; (left = q.peek()) != null; ) {
            if (left == EOF) {
                closeConn();
                throw new Lost(false, "the fast engine went away");
            }
            q.poll();
        }
        Map<String, Object> req = Json.obj("id", id, "op", op);
        if (params != null) req.putAll(params);
        try {
            HelperProtocol.write(o, req);
        } catch (IOException e) {
            closeConn();
            throw new Lost(false, "the fast engine went away (" + AxisLink.describe(e) + ")");
        }
        long end = System.currentTimeMillis() + timeoutMs;
        while (true) {
            long left = end - System.currentTimeMillis();
            Object got;
            try {
                got = left <= 0 ? null : q.poll(left, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                closeConn();
                throw new Lost(true, "interrupted");
            }
            if (got == null) {
                closeConn();
                throw new Lost(true, "the fast engine did not answer " + op + " within " + PanelCommands.seconds(timeoutMs) + " s");
            }
            if (got == EOF) {
                closeConn();
                throw new Lost(true, "the fast engine went away");
            }
            @SuppressWarnings("unchecked") Map<String, Object> answer = (Map<String, Object>) got;
            Integer aid = Json.integer(answer, "id");
            // An answer to a call that was given up on: not this one.
            if (aid == null || aid != id) continue;
            if (Json.isTrue(answer, "ok")) return answer;
            throw new Failed(String.valueOf(answer.get("code")), String.valueOf(answer.get("error")));
        }
    }

    private static String firstLine(String s) {
        String t = s.trim();
        int nl = t.indexOf('\n');
        if (nl > 0) t = t.substring(0, nl);
        return t.isEmpty() ? "it said nothing" : PanelCommands.clip(t, 160);
    }
}
