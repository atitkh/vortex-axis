package dev.vortexaxis.quest.core;

import static dev.vortexaxis.quest.core.T.check;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The proof of the secret on the helper's loopback port (HelperProtocol.clientHandshake / serverHandshake), over a
 * real TCP socket: the right secret gets through, a wrong one or garbage does not, and the secret itself never
 * crosses the connection.
 */
public final class HandshakeTest {
    public static void main(String[] args) throws Exception {
        String secret = HelperProtocol.nonce();
        check(secret.matches("[0-9a-f]{32}") && !secret.equals(HelperProtocol.nonce()), "a secret is 32 hex characters and fresh each time");

        try (ServerSocket server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))) {
            int port = server.getLocalPort();
            AtomicBoolean proved = new AtomicBoolean();
            AtomicBoolean ended = new AtomicBoolean();
            // The helper's side: serve with the secret; `proved` runs only when the app knew it.
            Thread helper = new Thread(() -> {
                try {
                    while (true) {
                        Socket c = server.accept();
                        try {
                            HelperServer.serve(c.getInputStream(), c.getOutputStream(), null, null, secret, () -> proved.set(true));
                        } catch (IOException ignored) {
                            // A peer that went away mid-handshake.
                        } finally {
                            c.close();
                            ended.set(true);
                        }
                    }
                } catch (IOException ignored) {
                    // The test closed the listening socket.
                }
            });
            helper.setDaemon(true);
            helper.start();

            System.out.println("[handshake] the right secret");
            try (Socket s = new Socket("127.0.0.1", port)) {
                s.setSoTimeout(3000);
                HelperProtocol.clientHandshake(s.getInputStream(), s.getOutputStream(), secret);
                for (int i = 0; i < 50 && !proved.get(); i++) Thread.sleep(20);
                check(proved.get(), "the helper let the app in");
            }

            System.out.println("[handshake] a wrong secret");
            proved.set(false);
            ended.set(false);
            try (Socket s = new Socket("127.0.0.1", port)) {
                s.setSoTimeout(3000);
                boolean threw = false;
                try {
                    HelperProtocol.clientHandshake(s.getInputStream(), s.getOutputStream(), HelperProtocol.nonce());
                } catch (IOException e) {
                    threw = true;
                }
                check(threw, "the app does not take a helper that cannot prove the secret");
            }
            for (int i = 0; i < 50 && !ended.get(); i++) Thread.sleep(20);
            check(!proved.get(), "and the helper let nothing in");

            System.out.println("[handshake] garbage, and an app that proves it with the wrong key");
            ended.set(false);
            try (Socket s = new Socket("127.0.0.1", port)) {
                s.setSoTimeout(3000);
                s.getOutputStream().write("GET / HTTP/1.1\r\n\r\n".getBytes());
                s.getOutputStream().flush();
                check(HelperProtocol.readLine(s.getInputStream()) == null, "nothing is answered to a stranger");
            }
            for (int i = 0; i < 50 && !ended.get(); i++) Thread.sleep(20);
            check(!proved.get(), "and nothing is let in");

            System.out.println("[handshake] the secret is never on the wire");
            // A listener that records what the app sends and answers like a helper that holds another secret.
            try (ServerSocket spy = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
                StringBuilder heard = new StringBuilder();
                Thread t = new Thread(() -> {
                    try (Socket c = spy.accept()) {
                        String hello = HelperProtocol.readLine(c.getInputStream());
                        heard.append(hello).append('\n');
                        c.getOutputStream().write(("ok " + HelperProtocol.nonce() + " " + "0".repeat(64) + "\n").getBytes());
                        c.getOutputStream().flush();
                    } catch (IOException ignored) {
                        // Done.
                    }
                });
                t.start();
                try (Socket s = new Socket("127.0.0.1", spy.getLocalPort())) {
                    s.setSoTimeout(3000);
                    try {
                        HelperProtocol.clientHandshake(s.getInputStream(), s.getOutputStream(), secret);
                    } catch (IOException expected) {
                        // The spy cannot prove it.
                    }
                }
                t.join(3000);
                check(heard.length() > 0 && !heard.toString().contains(secret), "the app said hello without the secret in it: " + heard.toString().trim());
            }
        }
        System.out.println("HandshakeTest: ALL PASS (" + T.checks + " checks)");
    }
}
