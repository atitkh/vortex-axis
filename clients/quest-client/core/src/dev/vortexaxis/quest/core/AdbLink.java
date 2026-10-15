package dev.vortexaxis.quest.core;

import java.io.IOException;
import java.net.ConnectException;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.NoSuchAlgorithmException;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;

/**
 * The headset's own adbd, reached at 127.0.0.1:5555 (switched on once per boot from a computer with
 * `adb tcpip 5555`). Holds one authorised connection, opens it again when it drops, and says in
 * plain words what is missing. Every call has a deadline, and a command never waits for a person:
 * only `connect` from the app (Set up, or the service starting) shows "Allow USB debugging".
 */
public final class AdbLink {
    public enum State {
        /** Not tried yet, or the connection dropped and has not been opened again. */
        UNKNOWN,
        /** Nothing answers on the port: `adb tcpip 5555` has not been run since the headset started. */
        NOT_SET_UP,
        /** adbd answers but has not accepted this app's key yet: "Allow USB debugging" is waiting on the headset. */
        NEEDS_ALLOW,
        CONNECTING,
        READY,
    }

    /** Where the app keeps its adb key. The app wraps it with the Android Keystore; tests keep it in memory. */
    public interface KeyStore {
        /** The saved key pair as {PKCS#8 private, X.509 public}, or null when there is none. */
        byte[][] load() throws IOException;
        void save(byte[] pkcs8, byte[] x509) throws IOException;
        void forget();
    }

    public interface Listener { void state(State state, String detail); }

    public static final String HOST = "127.0.0.1";
    public static final int PORT = 5555;
    /** How long the person has to tap Allow on the headset when the app asks. */
    public static final int APPROVAL_MS = 120_000;

    private final String host;
    private final int port;
    private final KeyStore keys;
    private final String keyName;
    private final RollingLog log;
    private volatile Listener listener = (s, d) -> {};
    private volatile State state = State.UNKNOWN;
    private volatile String detail = "";
    private volatile AdbClient client;
    /** Set while a connection is being opened, so a command fails at once instead of queueing behind it. */
    private volatile boolean busy;
    private final Object connecting = new Object();

    public AdbLink(String host, int port, KeyStore keys, String keyName, RollingLog log) {
        this.host = host;
        this.port = port;
        this.keys = keys;
        this.keyName = keyName;
        this.log = log;
    }

    public void setListener(Listener l) { this.listener = l == null ? (s, d) -> {} : l; }
    public State state() { return state; }
    public String detail() { return detail; }

    private void set(State s, String d) {
        boolean changed = s != state || !d.equals(detail);
        state = s;
        detail = d;
        if (changed) {
            log.line("adb: " + s + (d.isEmpty() ? "" : " (" + d + ")"));
            try { listener.state(s, d); } catch (RuntimeException ignored) {}
        }
    }

    private AdbClient client() throws IOException {
        if (client != null) return client;
        RSAPrivateKey priv;
        RSAPublicKey pub;
        byte[][] saved = keys.load();
        if (saved != null) {
            priv = AdbClient.decodePrivateKey(saved[0]);
            pub = AdbClient.decodePublicKey(saved[1]);
        } else {
            try {
                KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
                g.initialize(2048);
                KeyPair kp = g.generateKeyPair();
                priv = (RSAPrivateKey) kp.getPrivate();
                pub = (RSAPublicKey) kp.getPublic();
            } catch (NoSuchAlgorithmException e) {
                throw new IOException("no RSA on this device: " + e.getMessage());
            }
            keys.save(priv.getEncoded(), pub.getEncoded());
            log.line("adb: made a new key");
        }
        client = new AdbClient(priv, pub, keyName, (s, d) -> {
            if ("waiting for approval".equals(s)) set(State.NEEDS_ALLOW, "tap Allow on the headset (tick Always allow)");
        });
        return client;
    }

    /**
     * Connects if not connected. `approvalMs` above 0 offers this app's key and waits that long for the
     * person to tap Allow; 0 gives up at once when the key is not allowed yet.
     */
    public void connect(int approvalMs) throws IOException {
        synchronized (connecting) {
            AdbClient c = client();
            if (c.isConnected()) return;
            busy = true;
            set(State.CONNECTING, host + ":" + port);
            try {
                c.connect(host, port, 3000, approvalMs);
                set(State.READY, c.banner());
            } catch (ConnectException e) {
                set(State.NOT_SET_UP, "nothing answers on " + host + ":" + port);
                throw new IOException(problem(), e);
            } catch (IOException e) {
                c.close();
                String why = String.valueOf(e.getMessage());
                if (why.contains("approval")) {
                    set(State.NEEDS_ALLOW, "tap Allow on the headset (tick Always allow)");
                    throw new IOException(problem(), e);
                }
                set(State.NOT_SET_UP, AxisLink.describe(e));
                throw new IOException("could not reach the headset's adb: " + AxisLink.describe(e), e);
            } finally {
                busy = false;
            }
        }
    }

    /** What is in the way, in words for an agent (and the person it tells). */
    public String problem() {
        switch (state) {
            case NOT_SET_UP:
                return "the headset's adb is not switched on for apps since it last started: on a computer, with the headset on the cable, run `adb tcpip " + port + "` (the VorteX Axis app's Set up says how)";
            case NEEDS_ALLOW:
                return "the headset has not allowed the VorteX Axis app's adb key yet: open the app on the headset, press Set up and tap Allow (tick Always allow)";
            case CONNECTING:
                return "the app is still connecting to the headset's adb; try again in a moment";
            default:
                return "the headset's adb is not connected" + (detail.isEmpty() ? "" : " (" + detail + ")");
        }
    }

    /** Runs a shell command within timeoutMs, connecting first if needed (never waiting for a person). */
    public String shell(String command, int timeoutMs) throws IOException {
        return new String(shellBytes(command, timeoutMs), java.nio.charset.StandardCharsets.UTF_8);
    }

    /** Connects if not connected (never waiting for a person), as a command does. Returns the milliseconds it took, 0 when already connected. */
    public long ensure() throws IOException {
        if (ready()) return 0;
        if (busy) throw new IOException(problem());
        long t = System.currentTimeMillis();
        connect(0);
        return Math.max(1, System.currentTimeMillis() - t);
    }

    public byte[] shellBytes(String command, int timeoutMs) throws IOException {
        if (!ready()) ensure();
        AdbClient c = client;
        try {
            return c.shellBytes(command, timeoutMs);
        } catch (IOException e) {
            if (!c.isConnected()) set(State.UNKNOWN, "connection dropped: " + AxisLink.describe(e));
            throw e;
        }
    }

    /**
     * A second connection with the same key, for one command that runs for a long time (the helper's `am instrument -w`)
     * without holding up the commands on the first. The key must already be allowed: this never waits for a person.
     */
    public AdbClient second() throws IOException {
        byte[][] saved = keys.load();
        if (saved == null) throw new IOException("no adb key yet");
        AdbClient c = new AdbClient(AdbClient.decodePrivateKey(saved[0]), AdbClient.decodePublicKey(saved[1]), keyName, (s, d) -> {});
        c.connect(host, port, 3000, 0);
        return c;
    }

    public boolean ready() {
        AdbClient c = client;
        return c != null && c.isConnected() && !busy;
    }

    public void close() {
        AdbClient c = client;
        if (c != null) c.close();
    }

    /** Throws the key away (the headset keeps its own "Always allow" until revoked there). */
    public void forgetKey() {
        close();
        synchronized (connecting) {
            client = null;
            keys.forget();
        }
        set(State.UNKNOWN, "key forgotten");
    }
}
