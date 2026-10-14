package dev.vortexaxis.quest.core;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;

import javax.crypto.Cipher;
import java.security.interfaces.RSAPublicKey;

/**
 * A pretend adbd on 127.0.0.1 for the tests: the AUTH exchange (a key it has not seen is offered and
 * accepted, as after "Always allow"), then shell streams answered by `answer`, every command kept in
 * `commands`. Serves one connection after another, so a client that drops and reconnects is seen.
 * Output goes out in chunks so the client's handling of several WRTEs is exercised.
 */
final class FakeAdbd implements AutoCloseable {
    final ServerSocket server;
    final List<String> commands = Collections.synchronizedList(new ArrayList<>());
    /** Every command ever sent, never cleared by take(). */
    final List<String> history = Collections.synchronizedList(new ArrayList<>());
    volatile Function<String, byte[]> answer = cmd -> new byte[0];
    /** Milliseconds to wait before answering a command that contains the key. */
    volatile String slowFor;
    volatile int slowMs;
    volatile boolean refuseKeys;
    volatile int connections;
    final List<byte[]> publicKeys = Collections.synchronizedList(new ArrayList<>());
    private volatile boolean closed;

    FakeAdbd() throws IOException {
        server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"));
        Thread t = new Thread(this::serve, "fake-adbd");
        t.setDaemon(true);
        t.start();
    }

    int port() { return server.getLocalPort(); }

    /** The commands since the last call, and forgets them. */
    List<String> take() {
        synchronized (commands) {
            List<String> out = new ArrayList<>(commands);
            commands.clear();
            return out;
        }
    }

    @Override public void close() throws IOException {
        closed = true;
        server.close();
    }

    private void serve() {
        while (!closed) {
            try {
                Socket s = server.accept();
                connections++;
                Thread t = new Thread(() -> {
                    try (Socket c = s) {
                        new Conn(c).run();
                    } catch (Exception ignored) {
                        // The client dropped the connection (a timeout test does that on purpose).
                    }
                }, "fake-adbd-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                return;
            }
        }
    }

    private final class Conn {
        final OutputStream out;
        final DataInputStream in;
        final byte[] token = new byte[20];
        int nextId = 100;

        Conn(Socket s) throws IOException {
            s.setTcpNoDelay(true);
            out = s.getOutputStream();
            in = new DataInputStream(s.getInputStream());
            new SecureRandom().nextBytes(token);
        }

        void run() throws Exception {
            AdbClient.Message m = read();
            if (m.command != AdbClient.A_CNXN) throw new IOException("expected CNXN");
            send(AdbClient.A_AUTH, AdbClient.AUTH_TOKEN, 0, token);
            m = read();
            if (m.command != AdbClient.A_AUTH || m.arg0 != AdbClient.AUTH_SIGNATURE) throw new IOException("expected a signature");
            if (!known(m.data)) {
                // An unknown key: ask again, so the client offers its public key (the "Allow" dialog).
                send(AdbClient.A_AUTH, AdbClient.AUTH_TOKEN, 0, token);
                m = read();
                if (m.command != AdbClient.A_AUTH || m.arg0 != AdbClient.AUTH_RSAPUBLICKEY) throw new IOException("expected a public key");
                if (refuseKeys) return;
                publicKeys.add(m.data);
            }
            send(AdbClient.A_CNXN, AdbClient.VERSION, 4096, "device::ro.product.model=Quest 3;features=cmd\0".getBytes(StandardCharsets.US_ASCII));
            while (true) {
                try { m = read(); } catch (java.io.EOFException eof) { return; }
                if (m.command != AdbClient.A_OPEN) continue;
                int theirs = m.arg0, mine = nextId++;
                String dest = new String(m.data, StandardCharsets.UTF_8).replace("\0", "");
                String cmd = dest.startsWith("shell:") ? dest.substring(6) : dest;
                commands.add(cmd);
                history.add(cmd);
                send(AdbClient.A_OKAY, mine, theirs, new byte[0]);
                String slow = slowFor;
                if (slow != null && cmd.contains(slow)) Thread.sleep(slowMs);
                byte[] reply = answer.apply(cmd);
                for (int at = 0; at < reply.length; at += 4096) {
                    int n = Math.min(4096, reply.length - at);
                    byte[] chunk = new byte[n];
                    System.arraycopy(reply, at, chunk, 0, n);
                    send(AdbClient.A_WRTE, mine, theirs, chunk);
                    AdbClient.Message ack = read();
                    if (ack.command != AdbClient.A_OKAY) throw new IOException("expected OKAY for WRTE");
                }
                send(AdbClient.A_CLSE, mine, theirs, new byte[0]);
                read(); // the client's CLSE
            }
        }

        /** A signature made with a key offered before counts as known. */
        boolean known(byte[] sig) {
            synchronized (publicKeys) {
                for (byte[] k : publicKeys) {
                    try {
                        String b64 = new String(k, StandardCharsets.US_ASCII).split(" ")[0];
                        RSAPublicKey pub = AdbKeys.fromAdb(java.util.Base64.getDecoder().decode(b64));
                        Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
                        c.init(Cipher.DECRYPT_MODE, pub);
                        byte[] rec = c.doFinal(sig);
                        byte[] want = new byte[AdbClient.SHA1_DIGEST_INFO.length + 20];
                        System.arraycopy(AdbClient.SHA1_DIGEST_INFO, 0, want, 0, AdbClient.SHA1_DIGEST_INFO.length);
                        System.arraycopy(token, 0, want, AdbClient.SHA1_DIGEST_INFO.length, 20);
                        if (java.util.Arrays.equals(rec, want)) return true;
                    } catch (Exception ignored) {}
                }
            }
            return false;
        }

        void send(int cmd, int arg0, int arg1, byte[] data) throws IOException {
            int sum = 0;
            for (byte x : data) sum += x & 0xff;
            ByteBuffer h = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN);
            h.putInt(cmd).putInt(arg0).putInt(arg1).putInt(data.length).putInt(sum).putInt(~cmd);
            synchronized (out) {
                out.write(h.array());
                if (data.length > 0) out.write(data);
                out.flush();
            }
        }

        AdbClient.Message read() throws IOException {
            byte[] h = new byte[24];
            in.readFully(h);
            ByteBuffer b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN);
            int cmd = b.getInt(), arg0 = b.getInt(), arg1 = b.getInt(), len = b.getInt();
            b.getInt();
            b.getInt();
            byte[] data = new byte[len];
            if (len > 0) in.readFully(data);
            return new AdbClient.Message(cmd, arg0, arg1, data);
        }
    }

    /** Turns adb's public-key struct back into a key. */
    static final class AdbKeys {
        static RSAPublicKey fromAdb(byte[] s) throws Exception {
            ByteBuffer b = ByteBuffer.wrap(s).order(ByteOrder.LITTLE_ENDIAN);
            b.getInt();
            b.getInt();
            byte[] mod = new byte[256];
            b.get(mod);
            b.position(b.position() + 256);
            int e = b.getInt();
            byte[] be = new byte[257];
            for (int i = 0; i < 256; i++) be[256 - i] = mod[i];
            java.security.spec.RSAPublicKeySpec spec = new java.security.spec.RSAPublicKeySpec(new java.math.BigInteger(be), java.math.BigInteger.valueOf(e));
            return (RSAPublicKey) java.security.KeyFactory.getInstance("RSA").generatePublic(spec);
        }
    }
}
