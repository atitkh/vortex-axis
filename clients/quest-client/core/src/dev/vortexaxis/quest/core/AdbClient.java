package dev.vortexaxis.quest.core;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.PKCS8EncodedKeySpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;

import javax.crypto.Cipher;

// A minimal adb host client that talks the adb wire protocol over a plain TCP socket.
// Copied from clients/quest-probe (proven against a Quest 3's own adbd), with a deadline
// on every shell command and raw byte output added.
//
// Deliberately free of android.* imports so it can be unit-tested on a desktop JVM
// (see test/AdbClientTest). It only needs java.net / java.security / java.util.Base64.
//
// It keeps one connection (one CNXN), does the RSA AUTH exchange, and runs shell
// streams over that connection one at a time (its methods are synchronized).
public class AdbClient {
    // adb message commands (little-endian ints).
    public static final int A_CNXN = 0x4e584e43;
    public static final int A_AUTH = 0x48545541;
    public static final int A_OPEN = 0x4e45504f;
    public static final int A_OKAY = 0x59414b4f;
    public static final int A_WRTE = 0x45545257;
    public static final int A_CLSE = 0x45534c43;

    // AUTH subtypes.
    static final int AUTH_TOKEN = 1;      // adbd -> us: here is a token to sign
    static final int AUTH_SIGNATURE = 2;  // us -> adbd: token signed with our key
    static final int AUTH_RSAPUBLICKEY = 3; // us -> adbd: our public key, triggers the dialog

    static final int VERSION = 0x01000001;
    static final int MAX_DATA = 256 * 1024;

    // ASN.1 DigestInfo prefix for a SHA-1 digest. adb signs (prefix + 20-byte token)
    // with raw PKCS#1 v1.5 padding; the token is already a SHA-1 digest, not re-hashed.
    static final byte[] SHA1_DIGEST_INFO = {
            0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14
    };

    // A decoded adb message: header fields plus the payload.
    public static final class Message {
        public final int command, arg0, arg1;
        public final byte[] data;
        Message(int command, int arg0, int arg1, byte[] data) {
            this.command = command; this.arg0 = arg0; this.arg1 = arg1; this.data = data;
        }
    }

    public interface Listener { void onState(String state, String detail); }

    private final RSAPrivateKey privateKey;
    private final RSAPublicKey publicKey;
    private final String keyName; // e.g. "questprobe@quest" for the public-key suffix
    private final Listener listener;

    private Socket socket;
    private OutputStream out;
    private DataInputStream in;
    private String banner = "";
    private int peerMaxData = MAX_DATA;
    private final AtomicInteger nextLocalId = new AtomicInteger(1);

    public AdbClient(RSAPrivateKey privateKey, RSAPublicKey publicKey, String keyName, Listener listener) {
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.keyName = keyName;
        this.listener = listener;
    }

    public String banner() { return banner; }
    public boolean isConnected() { return socket != null && socket.isConnected() && !socket.isClosed(); }

    private void state(String s, String detail) { if (listener != null) listener.onState(s, detail); }

    // ---- connection / auth -------------------------------------------------

    // Open the socket, send CNXN, run the AUTH exchange, and return once adbd sends
    // its own CNXN (meaning: authorised). approvalTimeoutMs bounds the wait for the
    // user to accept the on-headset dialog after we send the public key.
    public synchronized void connect(String host, int port, int connectTimeoutMs, int approvalTimeoutMs)
            throws IOException {
        close();
        state("connecting", host + ":" + port);
        socket = new Socket();
        socket.connect(new InetSocketAddress(host, port), connectTimeoutMs);
        socket.setTcpNoDelay(true);
        out = socket.getOutputStream();
        in = new DataInputStream(socket.getInputStream());

        byte[] cnxn = "host::features=cmd".getBytes(StandardCharsets.US_ASCII);
        // Keep the banner simple (no shell_v2) so shell output is plain bytes.
        sendMessage(A_CNXN, VERSION, MAX_DATA, concat(cnxn, new byte[]{0}));

        boolean sentSignature = false;
        long deadline = Long.MAX_VALUE; // only armed once we send the public key
        while (true) {
            if (System.currentTimeMillis() > deadline)
                throw new IOException("timed out waiting for approval on the headset");
            socket.setSoTimeout(deadline == Long.MAX_VALUE ? connectTimeoutMs + approvalTimeoutMs : 1000);
            Message m;
            try {
                m = readMessage();
            } catch (java.net.SocketTimeoutException te) {
                if (deadline != Long.MAX_VALUE) {
                    long left = (deadline - System.currentTimeMillis()) / 1000;
                    state("waiting for approval", "accept on the headset (" + Math.max(0, left) + "s left)");
                    continue;
                }
                throw te;
            }
            if (m.command == A_CNXN) {
                if (m.arg1 > 0) peerMaxData = m.arg1;
                banner = new String(m.data, StandardCharsets.US_ASCII).replace('\0', ' ').trim();
                state("connected", banner);
                return;
            } else if (m.command == A_AUTH && m.arg0 == AUTH_TOKEN) {
                if (!sentSignature) {
                    // First AUTH: sign the token with our private key.
                    sendMessage(A_AUTH, AUTH_SIGNATURE, 0, signToken(m.data));
                    sentSignature = true;
                    state("authenticating", "signed token sent");
                } else if (approvalTimeoutMs <= 0) {
                    // Asked not to raise the dialog (a command must never wait for a person).
                    close();
                    throw new IOException("needs approval: this key is not allowed on the headset yet");
                } else {
                    // adbd did not know our key: offer the public key. This raises the
                    // "Allow USB debugging?" dialog on the headset.
                    sendMessage(A_AUTH, AUTH_RSAPUBLICKEY, 0, adbPublicKey());
                    deadline = System.currentTimeMillis() + approvalTimeoutMs;
                    state("waiting for approval", "accept on the headset");
                }
            } else {
                throw new IOException("unexpected message during auth: " + name(m.command));
            }
        }
    }

    public synchronized void close() {
        try { if (socket != null) socket.close(); } catch (IOException ignored) {}
        socket = null; out = null; in = null; banner = "";
        state("disconnected", "");
    }

    // ---- shell -------------------------------------------------------------

    public static final class ShellResult {
        public final String output;
        public final long commandMs;
        public ShellResult(String output, long commandMs) { this.output = output; this.commandMs = commandMs; }
    }

    /** A shell command that did not finish within its deadline. The connection is closed: its state is unknown. */
    public static final class TimeoutException extends IOException {
        public TimeoutException(String message) { super(message); }
    }

    // Run one shell command over a fresh stream on the existing connection and
    // collect its stdout until the stream closes. Without shell_v2 there is no
    // exit code; callers that need one append "; echo EXIT=$?" to the command.
    public ShellResult shell(String command) throws IOException {
        return shell(command, 30000);
    }

    /** As shell(command), giving up (and closing the connection) after timeoutMs. */
    public synchronized ShellResult shell(String command, int timeoutMs) throws IOException {
        long start = System.currentTimeMillis();
        byte[] out = shellBytes(command, timeoutMs);
        return new ShellResult(new String(out, StandardCharsets.UTF_8), System.currentTimeMillis() - start);
    }

    /** The command's raw output (screencap -p is binary), within timeoutMs. */
    public synchronized byte[] shellBytes(String command, int timeoutMs) throws IOException {
        if (!isConnected()) throw new IOException("not connected");
        long deadline = System.currentTimeMillis() + timeoutMs;
        int localId = nextLocalId.getAndIncrement();
        byte[] dest = ("shell:" + command + "\0").getBytes(StandardCharsets.UTF_8);
        try {
            sendMessage(A_OPEN, localId, 0, dest);
        } catch (IOException e) {
            close();
            throw e;
        }

        int remoteId = 0;
        java.io.ByteArrayOutputStream sb = new java.io.ByteArrayOutputStream();
        boolean opened = false;
        while (true) {
            long left = deadline - System.currentTimeMillis();
            if (left <= 0) throw timedOut(command, timeoutMs);
            Message m;
            try {
                socket.setSoTimeout((int) Math.max(1, left));
                m = readMessage();
            } catch (java.net.SocketTimeoutException te) {
                throw timedOut(command, timeoutMs);
            } catch (IOException e) {
                close();
                throw e;
            }
            // Messages for other streams on this connection are ignored: commands run one at a time.
            if (m.arg1 != localId) continue;
            switch (m.command) {
                case A_OKAY:
                    remoteId = m.arg0;
                    opened = true;
                    break;
                case A_WRTE:
                    sb.write(m.data, 0, m.data.length);
                    // Acknowledge each WRTE so adbd keeps sending.
                    sendMessage(A_OKAY, localId, m.arg0, new byte[0]);
                    break;
                case A_CLSE:
                    if (!opened || m.arg0 == remoteId || m.arg0 == 0) {
                        // Close our half and return.
                        sendMessage(A_CLSE, localId, m.arg0, new byte[0]);
                        return sb.toByteArray();
                    }
                    break;
                default:
                    break; // ignore
            }
        }
    }

    private TimeoutException timedOut(String command, int timeoutMs) {
        // A half-read stream leaves the connection in an unknown state; start afresh next time.
        close();
        String first = command.split(" ")[0];
        return new TimeoutException("adb did not answer within " + (timeoutMs / 1000) + " s (" + first + ")");
    }

    // ---- wire format -------------------------------------------------------

    void sendMessage(int command, int arg0, int arg1, byte[] data) throws IOException {
        if (data == null) data = new byte[0];
        int sum = 0;
        for (byte x : data) sum += x & 0xff; // adb "checksum" is a plain byte sum
        ByteBuffer h = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN);
        h.putInt(command).putInt(arg0).putInt(arg1).putInt(data.length).putInt(sum).putInt(~command);
        out.write(h.array());
        if (data.length > 0) out.write(data);
        out.flush();
    }

    Message readMessage() throws IOException {
        byte[] h = new byte[24];
        in.readFully(h);
        ByteBuffer b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN);
        int command = b.getInt(), arg0 = b.getInt(), arg1 = b.getInt(), len = b.getInt();
        b.getInt(); // data checksum (not verified)
        int magic = b.getInt();
        if (magic != ~command) throw new IOException("bad magic for " + name(command));
        byte[] data = new byte[len];
        if (len > 0) in.readFully(data);
        return new Message(command, arg0, arg1, data);
    }

    // ---- crypto ------------------------------------------------------------

    // Sign a 20-byte adb AUTH token: PKCS#1 v1.5 over (SHA1 DigestInfo prefix + token),
    // with no further hashing (the token is already a SHA-1 digest).
    byte[] signToken(byte[] token) throws IOException {
        try {
            Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
            c.init(Cipher.ENCRYPT_MODE, privateKey);
            return c.doFinal(concat(SHA1_DIGEST_INFO, token));
        } catch (Exception e) {
            throw new IOException("sign failed: " + e, e);
        }
    }

    // Encode the public key in adb's own format: the Android RSAPublicKey struct,
    // base64-encoded, then a " name\0" suffix. This is what adbd stores for
    // "Always allow from this computer".
    byte[] adbPublicKey() {
        String b64 = Base64.getEncoder().encodeToString(encodeAdbPublicKey(publicKey));
        return (b64 + " " + keyName + "\0").getBytes(StandardCharsets.US_ASCII);
    }

    // The Android "RSAPublicKey" struct for a 2048-bit key, little-endian:
    //   uint32 len      = 64        (modulus size in 32-bit words)
    //   uint32 n0inv    = -1/n[0] mod 2^32
    //   uint8  modulus[256]         little-endian
    //   uint8  rr[256]  = R^2 mod n little-endian, R = 2^2048
    //   uint32 exponent = 65537
    public static byte[] encodeAdbPublicKey(RSAPublicKey key) {
        BigInteger n = key.getModulus();
        BigInteger e = key.getPublicExponent();
        int words = 2048 / 32; // 64
        BigInteger r32 = BigInteger.ONE.shiftLeft(32);
        BigInteger n0 = n.mod(r32);
        BigInteger n0inv = r32.subtract(n0.modInverse(r32)).mod(r32); // -1/n[0] mod 2^32
        BigInteger r = BigInteger.ONE.shiftLeft(2048);
        BigInteger rr = r.multiply(r).mod(n);

        ByteBuffer buf = ByteBuffer.allocate(4 + 4 + 256 + 256 + 4).order(ByteOrder.LITTLE_ENDIAN);
        buf.putInt(words);
        buf.putInt((int) n0inv.longValue());
        buf.put(toFixedLE(n, 256));
        buf.put(toFixedLE(rr, 256));
        buf.putInt(e.intValueExact());
        return buf.array();
    }

    // A non-negative BigInteger as exactly len bytes, little-endian.
    static byte[] toFixedLE(BigInteger v, int len) {
        byte[] be = v.toByteArray(); // big-endian, maybe with a leading sign byte
        byte[] le = new byte[len];
        int copy = Math.min(be.length, len);
        for (int i = 0; i < copy; i++) le[i] = be[be.length - 1 - i];
        return le;
    }

    static byte[] concat(byte[] a, byte[] b) {
        byte[] r = new byte[a.length + b.length];
        System.arraycopy(a, 0, r, 0, a.length);
        System.arraycopy(b, 0, r, a.length, b.length);
        return r;
    }

    public static String name(int cmd) {
        switch (cmd) {
            case A_CNXN: return "CNXN";
            case A_AUTH: return "AUTH";
            case A_OPEN: return "OPEN";
            case A_OKAY: return "OKAY";
            case A_WRTE: return "WRTE";
            case A_CLSE: return "CLSE";
            default: return String.format("0x%08x", cmd);
        }
    }

    // Helpers for callers persisting keys (used by the Android side; no android.* here).
    public static RSAPrivateKey decodePrivateKey(byte[] pkcs8) throws IOException {
        try {
            return (RSAPrivateKey) KeyFactory.getInstance("RSA")
                    .generatePrivate(new PKCS8EncodedKeySpec(pkcs8));
        } catch (Exception e) { throw new IOException("bad private key: " + e, e); }
    }

    public static RSAPublicKey decodePublicKey(byte[] x509) throws IOException {
        try {
            return (RSAPublicKey) KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(x509));
        } catch (Exception e) { throw new IOException("bad public key: " + e, e); }
    }
}
