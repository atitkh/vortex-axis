package dev.vortexaxis.quest.core;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.util.Base64;

import javax.crypto.Cipher;

// Plain-JVM test for AdbClient, copied from clients/quest-probe with the package changed. No JUnit.
// Exits non-zero on the first failed check.
//
//   (a) adb public-key struct encode -> decode round-trip (n, e, n0inv, R^2).
//   (b) AUTH signature: RSA public "decrypt" of the signature yields the SHA-1
//       DigestInfo prefix + the original token.
//   (c) the whole connect/AUTH/shell state machine against a fake adbd that
//       rejects the signature once, asks for the public key, then accepts and
//       serves two shell streams.
public class AdbClientTest {
    static int checks = 0;

    public static void main(String[] args) throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        KeyPair kp = g.generateKeyPair();
        RSAPublicKey pub = (RSAPublicKey) kp.getPublic();
        RSAPrivateKey priv = (RSAPrivateKey) kp.getPrivate();

        testPublicKeyEncoding(pub);
        testSignature(pub, priv);
        testStateMachine(pub, priv);

        System.out.println("ALL PASS (" + checks + " checks)");
    }

    static void check(boolean cond, String what) {
        checks++;
        if (!cond) { System.out.println("FAIL: " + what); System.exit(1); }
        System.out.println("  ok: " + what);
    }

    // (a) Encode, then decode the struct back and compare against BigInteger truth.
    static void testPublicKeyEncoding(RSAPublicKey pub) {
        System.out.println("[a] public key adb-format encoding");
        byte[] enc = AdbClient.encodeAdbPublicKey(pub);
        check(enc.length == 4 + 4 + 256 + 256 + 4, "struct length 524");

        ByteBuffer b = ByteBuffer.wrap(enc).order(ByteOrder.LITTLE_ENDIAN);
        long words = b.getInt() & 0xffffffffL;
        long n0inv = b.getInt() & 0xffffffffL;
        byte[] modLE = new byte[256]; b.get(modLE);
        byte[] rrLE = new byte[256]; b.get(rrLE);
        long exp = b.getInt() & 0xffffffffL;

        check(words == 64, "len = 64 words");
        check(exp == 65537, "exponent = 65537");

        BigInteger n = fromLE(modLE);
        check(n.equals(pub.getModulus()), "modulus round-trips");

        BigInteger r32 = BigInteger.ONE.shiftLeft(32);
        BigInteger n0 = pub.getModulus().mod(r32);
        BigInteger expectN0inv = r32.subtract(n0.modInverse(r32)).mod(r32);
        check(BigInteger.valueOf(n0inv).equals(expectN0inv), "n0inv = -1/n[0] mod 2^32");
        // Confirm the defining property too: (n0 * -n0inv) mod 2^32 == 1.
        BigInteger negN0inv = r32.subtract(BigInteger.valueOf(n0inv)).mod(r32);
        check(n0.multiply(negN0inv).mod(r32).equals(BigInteger.ONE), "n0 * -n0inv == 1 mod 2^32");

        BigInteger rr = fromLE(rrLE);
        BigInteger r = BigInteger.ONE.shiftLeft(2048);
        check(rr.equals(r.multiply(r).mod(pub.getModulus())), "rr = R^2 mod n");
    }

    // (b) Public "decrypt" of the signature must reveal SHA1 DigestInfo prefix + token.
    static void testSignature(RSAPublicKey pub, RSAPrivateKey priv) throws Exception {
        System.out.println("[b] AUTH signature");
        byte[] token = new byte[20];
        new SecureRandom().nextBytes(token);

        AdbClient client = new AdbClient(priv, pub, "questprobe@quest", null);
        byte[] sig = client.signToken(token);
        check(sig.length == 256, "signature is 256 bytes");

        Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
        c.init(Cipher.DECRYPT_MODE, pub);
        byte[] recovered = c.doFinal(sig);

        byte[] expected = new byte[AdbClient.SHA1_DIGEST_INFO.length + 20];
        System.arraycopy(AdbClient.SHA1_DIGEST_INFO, 0, expected, 0, AdbClient.SHA1_DIGEST_INFO.length);
        System.arraycopy(token, 0, expected, AdbClient.SHA1_DIGEST_INFO.length, 20);
        check(java.util.Arrays.equals(recovered, expected), "recovered == SHA1 DigestInfo + token");
    }

    // (c) Full state machine against a fake adbd on a loopback socket.
    static void testStateMachine(RSAPublicKey pub, RSAPrivateKey priv) throws Exception {
        System.out.println("[c] connect / AUTH / shell against a fake adbd");
        try (ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            final boolean[] sawPublicKey = {false};
            final boolean[] signatureVerified = {false};

            Thread fake = new Thread(() -> {
                try (Socket s = server.accept()) {
                    s.setTcpNoDelay(true);
                    FakeAdbd d = new FakeAdbd(s, pub);
                    d.serve(sawPublicKey, signatureVerified);
                } catch (Exception e) {
                    System.out.println("  fake adbd error: " + e);
                }
            });
            fake.setDaemon(true);
            fake.start();

            final StringBuilder lastState = new StringBuilder();
            AdbClient client = new AdbClient(priv, pub, "questprobe@quest",
                    (state, detail) -> lastState.setLength(0));

            client.connect("127.0.0.1", port, 3000, 10000);
            check(client.isConnected(), "connected after auth");
            check(sawPublicKey[0], "adbd received RSAPUBLICKEY (dialog would show)");
            check(signatureVerified[0], "adbd verified the first signature");
            check(client.banner().contains("device"), "banner carries device props: " + client.banner());

            AdbClient.ShellResult r1 = client.shell("id");
            check(r1.output.contains("uid=0(root)"), "shell 'id' output: " + r1.output.trim());

            AdbClient.ShellResult r2 = client.shell("echo hello");
            check(r2.output.contains("hello"), "second stream works (multiplexing): " + r2.output.trim());

            client.close();
        }
    }

    static BigInteger fromLE(byte[] le) {
        byte[] be = new byte[le.length + 1]; // leading 0 keeps it positive
        for (int i = 0; i < le.length; i++) be[be.length - 1 - i] = le[i];
        return new BigInteger(be);
    }

    // A tiny adbd good enough to exercise the client: one CNXN, AUTH TOKEN,
    // reject the signature once (ask again), accept the public key, send CNXN,
    // then answer shell: OPENs with canned stdout.
    static final class FakeAdbd {
        final Socket socket;
        final RSAPublicKey clientPub;
        final OutputStream out;
        final DataInputStream in;
        final byte[] token = new byte[20];

        FakeAdbd(Socket s, RSAPublicKey clientPub) throws IOException {
            this.socket = s; this.clientPub = clientPub;
            this.out = s.getOutputStream();
            this.in = new DataInputStream(s.getInputStream());
            new SecureRandom().nextBytes(token);
        }

        void serve(boolean[] sawPublicKey, boolean[] signatureVerified) throws Exception {
            // Expect client CNXN.
            AdbClient.Message m = read();
            if (m.command != AdbClient.A_CNXN) throw new IOException("expected CNXN");
            // Challenge with a token.
            send(AdbClient.A_AUTH, AdbClient.AUTH_TOKEN, 0, token);

            // First signature: verify it, then pretend the key is unknown -> ask again.
            m = read();
            if (m.command != AdbClient.A_AUTH || m.arg0 != AdbClient.AUTH_SIGNATURE)
                throw new IOException("expected AUTH SIGNATURE");
            signatureVerified[0] = verifySignature(m.data);
            send(AdbClient.A_AUTH, AdbClient.AUTH_TOKEN, 0, token);

            // Now the public key arrives -> dialog -> accept -> send our CNXN.
            m = read();
            if (m.command != AdbClient.A_AUTH || m.arg0 != AdbClient.AUTH_RSAPUBLICKEY)
                throw new IOException("expected AUTH RSAPUBLICKEY");
            sawPublicKey[0] = true;
            byte[] banner = "device::ro.product.model=Quest 3;features=cmd\0".getBytes(StandardCharsets.US_ASCII);
            send(AdbClient.A_CNXN, AdbClient.VERSION, AdbClient.MAX_DATA, banner);

            // Serve shell streams until the socket closes.
            while (true) {
                try { m = read(); } catch (java.io.EOFException eof) { return; }
                if (m.command == AdbClient.A_OPEN) {
                    int remoteLocal = m.arg0;      // client's local id
                    int myId = 42;                 // our stream id
                    String dest = new String(m.data, StandardCharsets.UTF_8);
                    send(AdbClient.A_OKAY, myId, remoteLocal, new byte[0]);
                    String reply = dest.contains("id") && !dest.contains("echo")
                            ? "uid=0(root) gid=0(root)\n"
                            : dest.substring(dest.indexOf(':') + 1).replace("echo ", "").replace("\0", "");
                    send(AdbClient.A_WRTE, myId, remoteLocal, reply.getBytes(StandardCharsets.UTF_8));
                    read(); // client's OKAY for our WRTE
                    send(AdbClient.A_CLSE, myId, remoteLocal, new byte[0]);
                    read(); // client's CLSE
                } else if (m.command == AdbClient.A_CLSE) {
                    // ignore
                }
            }
        }

        boolean verifySignature(byte[] sig) {
            try {
                Cipher c = Cipher.getInstance("RSA/ECB/PKCS1Padding");
                c.init(Cipher.DECRYPT_MODE, clientPub);
                byte[] rec = c.doFinal(sig);
                byte[] expected = new byte[AdbClient.SHA1_DIGEST_INFO.length + 20];
                System.arraycopy(AdbClient.SHA1_DIGEST_INFO, 0, expected, 0, AdbClient.SHA1_DIGEST_INFO.length);
                System.arraycopy(token, 0, expected, AdbClient.SHA1_DIGEST_INFO.length, 20);
                return java.util.Arrays.equals(rec, expected);
            } catch (Exception e) { return false; }
        }

        void send(int cmd, int arg0, int arg1, byte[] data) throws IOException {
            int sum = 0; for (byte x : data) sum += x & 0xff;
            ByteBuffer h = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN);
            h.putInt(cmd).putInt(arg0).putInt(arg1).putInt(data.length).putInt(sum).putInt(~cmd);
            out.write(h.array());
            if (data.length > 0) out.write(data);
            out.flush();
        }

        AdbClient.Message read() throws IOException {
            byte[] h = new byte[24];
            in.readFully(h);
            ByteBuffer b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN);
            int cmd = b.getInt(), arg0 = b.getInt(), arg1 = b.getInt(), len = b.getInt();
            b.getInt(); b.getInt();
            byte[] data = new byte[len];
            if (len > 0) in.readFully(data);
            return new AdbClient.Message(cmd, arg0, arg1, data);
        }
    }
}
