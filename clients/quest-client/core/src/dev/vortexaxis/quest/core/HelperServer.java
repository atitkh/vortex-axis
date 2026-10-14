package dev.vortexaxis.quest.core;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * The helper's loop over one connection, in plain Java: a line in, the router's answer out, until the app hangs up.
 * The helper package runs it on a socket whose peer it has already checked; the tests run it on a TCP socket.
 */
public final class HelperServer {
    private HelperServer() {}

    /** Told of every request, so the helper can tell an app that is still there from one that has gone. */
    public interface Seen { void now(); }

    public static void serve(InputStream rawIn, OutputStream rawOut, HelperRouter<?> router, Seen seen) throws IOException {
        serve(rawIn, rawOut, router, seen, null, null);
    }

    /**
     * With a secret, the app must prove it holds it (HelperProtocol.serverHandshake) before anything is answered;
     * `proved` is called once it has.
     */
    public static void serve(InputStream rawIn, OutputStream rawOut, HelperRouter<?> router, Seen seen, String secret, Runnable proved) throws IOException {
        if (secret != null) {
            if (!HelperProtocol.serverHandshake(rawIn, rawOut, secret)) return;
            if (proved != null) proved.run();
        }
        InputStream in = new BufferedInputStream(rawIn, 64 * 1024);
        OutputStream out = new BufferedOutputStream(rawOut, 64 * 1024);
        while (true) {
            String line = HelperProtocol.readLine(in);
            if (line == null) return;
            if (line.trim().isEmpty()) continue;
            if (seen != null) seen.now();
            HelperProtocol.write(out, router.handle(line));
        }
    }
}
