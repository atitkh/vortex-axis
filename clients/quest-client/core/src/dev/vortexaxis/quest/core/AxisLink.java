package dev.vortexaxis.quest.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * One connection to Axis, kept open: hello, welcome, describe, settings and commands, protocol 1.
 * Reconnects by itself after a drop, waiting longer each time up to half a minute. A refused token
 * stops it for good (the pairing is gone; pair again). A port of the Windows app's AxisLink.cs.
 */
public final class AxisLink {
    public static final int PROTOCOL = 1;
    static final int[] BACKOFF_SECONDS = {1, 2, 5, 10, 30};

    public enum State { STOPPED, CONNECTING, ONLINE, OFFLINE, REFUSED }

    /** Who this client is, as it tells Axis on every connection. */
    public static final class Identity {
        public final String type, version;
        public final List<String> capabilities;
        /** The describe message's settings, actions and links. */
        public final Map<String, Object> describe;

        public Identity(String type, String version, List<String> capabilities, Map<String, Object> describe) {
            this.type = type;
            this.version = version;
            this.capabilities = Collections.unmodifiableList(new ArrayList<>(capabilities));
            this.describe = describe;
        }
    }

    /** What the client holds once paired. The token is a secret. */
    public static final class Pairing {
        public final String address, clientId, token, name;

        public Pairing(String address, String clientId, String token, String name) {
            this.address = address;
            this.clientId = clientId;
            this.token = token;
            this.name = name;
        }
    }

    /** A command's answer: `data` for a structured one, `payload` for a few scalar values. */
    public static final class Answer {
        public final boolean ok;
        public final String error;
        public final Map<String, Object> payload;
        public final Object data;

        public Answer(boolean ok, String error, Map<String, Object> payload, Object data) {
            this.ok = ok;
            this.error = error;
            this.payload = payload;
            this.data = data;
        }

        public static Answer fail(String error) { return new Answer(false, error, null, null); }
        public static Answer done() { return new Answer(true, null, null, null); }
        public static Answer done(Map<String, Object> payload) { return new Answer(true, null, payload, null); }
        public static Answer data(Object data) { return new Answer(true, null, null, data); }
        public Answer withData(Object d) { return new Answer(ok, error, payload, d); }
    }

    public interface Handler {
        /** Carries out a command. `params` holds `data` too when Axis sent structured arguments. */
        Answer handle(String name, Map<String, Object> params);
    }

    public interface Listener {
        default void state(State state, String why) {}
        default void settings(Map<String, Object> values) {}
        /** Something went wrong answering Axis that Axis will never hear about. */
        default void trouble(String what) {}
    }

    private final Pairing pairing;
    private final Identity identity;
    private final Sockets sockets;
    private final AxisAddress address;
    private final RollingLog log;
    private volatile Handler handler;
    private volatile Listener listener = new Listener() {};
    private volatile State state = State.STOPPED;
    private volatile int settingsVersion;
    private volatile Thread running;
    private volatile boolean stopping;
    private volatile Sockets.Socket socket;
    private final ExecutorService work = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "axis-command");
        t.setDaemon(true);
        return t;
    });
    private final Object sleeper = new Object();

    public AxisLink(Pairing pairing, Identity identity, Sockets sockets, RollingLog log) {
        this.pairing = pairing;
        this.identity = identity;
        this.sockets = sockets;
        this.log = log;
        this.address = AxisAddress.parse(pairing.address);
    }

    public void setHandler(Handler h) { this.handler = h; }
    public void setListener(Listener l) { this.listener = l == null ? new Listener() {} : l; }
    public State state() { return state; }
    public Pairing pairing() { return pairing; }

    /** Pairs with a one-time code from Axis's admin page ("Add a device"). Blocking; throws with Axis's own words. */
    public static Pairing pair(AxisAddress address, String code, String name, Identity identity) throws IOException {
        Map<String, Object> body = Json.obj(
                "code", code.trim(),
                "type", identity.type,
                "version", identity.version,
                "capabilities", new ArrayList<Object>(identity.capabilities));
        if (name != null && !name.trim().isEmpty()) body.put("name", name.trim());
        HttpURLConnection http = (HttpURLConnection) new URL(address.pairUrl()).openConnection();
        http.setConnectTimeout(15000);
        http.setReadTimeout(15000);
        http.setRequestMethod("POST");
        http.setDoOutput(true);
        http.setRequestProperty("content-type", "application/json");
        try (OutputStream out = http.getOutputStream()) {
            out.write(Json.write(body).getBytes(StandardCharsets.UTF_8));
        }
        int status = http.getResponseCode();
        InputStream in = status < 400 ? http.getInputStream() : http.getErrorStream();
        String text = in == null ? "" : readAll(in);
        Map<String, Object> reply = null;
        try { reply = Json.parseObject(text); } catch (RuntimeException ignored) {}
        if (status < 200 || status >= 300) {
            String said = reply == null ? null : Json.str(reply, "error");
            throw new IOException(said != null ? said : "Axis said " + status + ".");
        }
        if (reply == null || Json.str(reply, "clientId") == null || Json.str(reply, "token") == null)
            throw new IOException("Axis answered the pairing with something this app does not understand.");
        String given = Json.str(reply, "name");
        return new Pairing(address.toString(), Json.str(reply, "clientId"), Json.str(reply, "token"), given != null ? given : name);
    }

    static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        return b.toString("UTF-8");
    }

    public synchronized void start() {
        if (running != null) return;
        stopping = false;
        Thread t = new Thread(this::run, "axis-link");
        t.setDaemon(true);
        running = t;
        t.start();
    }

    public void stop() {
        Thread t;
        synchronized (this) {
            t = running;
            if (t == null) return;
            stopping = true;
            running = null;
        }
        Sockets.Socket s = socket;
        if (s != null) s.cancel();
        synchronized (sleeper) { sleeper.notifyAll(); }
        try { t.join(5000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        setState(State.STOPPED, null);
    }

    private void setState(State s, String why) {
        state = s;
        try { listener.state(s, why); } catch (RuntimeException ignored) {}
    }

    private void run() {
        int attempt = 0;
        while (!stopping) {
            setState(State.CONNECTING, null);
            String why;
            try {
                Session session = new Session();
                String refused = session.run();
                if (refused != null) {
                    log.line("axis: refused: " + refused);
                    setState(State.REFUSED, refused);
                    synchronized (this) { if (running == Thread.currentThread()) running = null; }
                    return;
                }
                if (session.welcomed) attempt = 0;
                why = session.why;
            } catch (RuntimeException e) {
                why = e.getMessage();
            }
            if (stopping) return;
            int wait = BACKOFF_SECONDS[Math.min(attempt++, BACKOFF_SECONDS.length - 1)];
            log.line("axis: offline (" + (why == null ? "connection closed" : why) + "), again in " + wait + " s");
            setState(State.OFFLINE, why == null ? "connection closed" : why);
            synchronized (sleeper) {
                try { if (!stopping) sleeper.wait(wait * 1000L); } catch (InterruptedException e) { return; }
            }
        }
    }

    /** One connection, to its end. */
    private final class Session implements Sockets.Events {
        final CountDownLatch over = new CountDownLatch(1);
        volatile String refused;
        volatile String why;
        volatile boolean welcomed;

        String run() {
            Sockets.Socket opened = sockets.open(address.socketUrl(), this);
            if (socket == null) socket = opened;
            try {
                over.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            socket = null;
            return refused;
        }

        @Override public void opened(Sockets.Socket s) {
            socket = s;
            Map<String, Object> hello = Json.obj(
                    "t", "hello",
                    "protocol", PROTOCOL,
                    "clientId", pairing.clientId,
                    "token", pairing.token,
                    "type", identity.type,
                    "version", identity.version,
                    "capabilities", new ArrayList<Object>(identity.capabilities),
                    "settingsVersion", settingsVersion,
                    "maxFrameBytes", 65536);
            if (!send(hello)) why = "the hello could not be sent";
        }

        @Override public void text(String text) {
            Map<String, Object> m;
            try { m = Json.parseObject(text); } catch (RuntimeException e) { return; }
            String t = Json.str(m, "t");
            if (t == null) return;
            switch (t) {
                case "welcome":
                    welcomed = true;
                    send(describeMessage());
                    log.line("axis: online at " + address);
                    setState(State.ONLINE, null);
                    break;
                case "settings": {
                    Integer v = Json.integer(m, "version");
                    if (v != null) settingsVersion = v;
                    Map<String, Object> values = Json.map(m.get("values"));
                    if (values != null) {
                        try { listener.settings(values); } catch (RuntimeException ignored) {}
                    }
                    break;
                }
                case "command": {
                    String id = Json.str(m, "id"), name = Json.str(m, "name");
                    if (id == null || name == null) break;
                    Map<String, Object> params = Json.map(m.get("params"));
                    Map<String, Object> merged = params == null ? Json.obj() : new java.util.LinkedHashMap<>(params);
                    // Structured arguments (desktop.steps) arrive beside the params; the handler sees them as params.data.
                    if (m.containsKey("data")) merged.put("data", m.get("data"));
                    long received = System.currentTimeMillis();
                    work.execute(() -> answer(id, name, merged, received));
                    break;
                }
                case "error": {
                    String code = Json.str(m, "code"), message = Json.str(m, "message");
                    if ("unauthorized".equals(code)) refused = "Axis no longer knows this headset (" + message + "). Pair it again.";
                    else if ("unsupported_protocol".equals(code)) refused = "Axis speaks another protocol (" + message + "). Update the app.";
                    if (refused != null) {
                        Sockets.Socket s = socket;
                        if (s != null) s.cancel();
                    }
                    break;
                }
                default:
                    break;
            }
        }

        @Override public void closed(int code, String reason, Throwable failure) {
            if (refused == null && reason != null && reason.toLowerCase(Locale.ROOT).contains("token"))
                refused = "Axis refused this headset: " + reason + ". Pair it again.";
            if (refused == null && reason != null && reason.toLowerCase(Locale.ROOT).contains("removed"))
                refused = "Axis removed this headset (" + reason + "). Pair it again.";
            if (why == null) why = failure != null ? describe(failure) : (reason == null || reason.isEmpty() ? null : reason);
            over.countDown();
        }
    }

    static String describe(Throwable t) {
        String m = t.getMessage();
        return m == null || m.isEmpty() ? t.getClass().getSimpleName() : m;
    }

    private void answer(String id, String name, Map<String, Object> params, long received) {
        Answer a;
        try {
            Handler h = handler;
            a = h == null ? Answer.fail("not implemented on this device") : h.handle(name, params);
            if (a == null) a = Answer.fail("no answer");
        } catch (RuntimeException e) {
            a = Answer.fail(describe(e) + " (" + e.getClass().getSimpleName() + ")");
        }
        Map<String, Object> reply = Json.obj("t", "command.result", "id", id, "ok", a.ok);
        if (a.payload != null) reply.put("payload", a.payload);
        if (a.data != null) reply.put("data", a.data);
        if (a.error != null) reply.put("error", a.error.length() > 256 ? a.error.substring(0, 255) + "…" : a.error);
        // Never swallow a failed send: an answer that never left looks like the headset not answering.
        if (!send(reply)) {
            String what = name + ": the answer could not be sent";
            log.line("axis: " + what);
            try { listener.trouble(what); } catch (RuntimeException ignored) {}
        }
        long took = System.currentTimeMillis() - received;
        if (took > 10000) {
            String what = name + " answered after " + took + " ms";
            log.line("axis: " + what);
            try { listener.trouble(what); } catch (RuntimeException ignored) {}
        }
    }

    private Map<String, Object> describeMessage() {
        Map<String, Object> d = new java.util.LinkedHashMap<>(identity.describe);
        d.put("t", "describe");
        d.putIfAbsent("settings", new ArrayList<>());
        d.putIfAbsent("actions", new ArrayList<>());
        d.putIfAbsent("links", new ArrayList<>());
        return d;
    }

    private boolean send(Map<String, Object> message) {
        Sockets.Socket s = socket;
        return s != null && s.send(Json.write(message));
    }
}
