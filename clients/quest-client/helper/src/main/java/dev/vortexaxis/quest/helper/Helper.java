package dev.vortexaxis.quest.helper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;

import dev.vortexaxis.quest.core.HelperProtocol;
import dev.vortexaxis.quest.core.HelperRouter;
import dev.vortexaxis.quest.core.HelperServer;

/**
 * The fast engine's helper. Started by the VorteX Axis app through the headset's adb:
 * `am instrument -w -e uid <the app's uid> -e port <port> -e secret <secret> dev.vortexaxis.quest.helper/.Helper`.
 * That is what gives it a UiAutomation connection (the shell's, lent to the instrumentation); started any other
 * way it has none and ends at once. The process itself runs as this package's own uid, not the shell's.
 *
 * It listens on 127.0.0.1 at the given port and answers only a peer that proves it holds the secret
 * (HelperProtocol's handshake; the secret never crosses the connection). It does nothing on its own, and ends when
 * the app has not been heard for ten minutes. How far it got, and any crash, is written to status.txt in its own
 * external files folder, which the app reads over adb when it does not answer.
 *
 * Thin on purpose: the rules, the wire and the handle table are HelperRouter and HelperServer (plain Java, tested on
 * a JVM); this file and Screen only connect them to Android.
 */
public final class Helper extends Instrumentation {
    static final String TAG = "VortexAxisHelper";
    static final String APP = "dev.vortexaxis.quest";
    static final long IDLE_MS = 10 * 60_000;
    private Bundle args;
    private volatile long seen = System.currentTimeMillis();
    private volatile ServerSocket server;
    private static volatile File status;

    private static volatile Helper self;

    /**
     * How far the helper got, said two ways: as an INSTRUMENTATION_STATUS line, which `am instrument` prints and the app
     * reads back from its log (the one way known to work), and in status.txt when that can be written.
     */
    static void note(String line) {
        // logcat is what the app reads over adb when the helper does not answer (tag VortexAxisHelper).
        Log.i(TAG, line);
        Helper h = self;
        if (h != null) {
            try {
                Bundle b = new Bundle();
                b.putString("note", line.length() > 400 ? line.substring(0, 400) : line);
                h.sendStatus(0, b);
            } catch (RuntimeException ignored) {
                // Not told then; the file may be.
            }
        }
        File f = status;
        if (f == null) return;
        try (java.io.FileWriter w = new java.io.FileWriter(f, true)) {
            w.write(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(new java.util.Date()) + " " + line + "\n");
        } catch (IOException ignored) {
            // Nowhere to say it.
        }
    }

    @Override public void onCreate(Bundle arguments) {
        self = this;
        try {
            File dir = getTargetContext().getExternalFilesDir(null);
            if (dir != null) {
                status = new File(dir, "status.txt");
                status.delete();
            }
        } catch (RuntimeException ignored) {
            // No trail then; the rest goes on.
        }
        final Thread.UncaughtExceptionHandler before = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            note("CRASH in " + thread.getName() + ": " + Log.getStackTraceString(error).replace('\n', ' '));
            if (before != null) before.uncaughtException(thread, error);
        });
        // The port is how the app tells this start's lines from older ones.
        note("onCreate (pid " + android.os.Process.myPid() + ", uid " + android.os.Process.myUid() + ", port " + (arguments == null ? "?" : arguments.getString("port")) + ")");
        super.onCreate(arguments);
        args = arguments;
        start();
    }

    @Override public void onStart() {
        note("onStart");
        Bundle out = new Bundle();
        try {
            serve();
        } catch (Throwable t) {
            Log.e(TAG, "stopped: " + t);
            note("stopped: " + Log.getStackTraceString(t).replace('\n', ' '));
            out.putString("stopped", String.valueOf(t));
        }
        finish(Activity.RESULT_OK, out);
    }

    private void serve() throws Exception {
        PackageManager pm = getContext().getPackageManager();
        int app = pm.getPackageUid(APP, 0);
        String given = args == null ? null : args.getString("uid");
        if (given == null || Integer.parseInt(given.trim()) != app) throw new SecurityException("not started for the VorteX Axis app");
        if (pm.checkSignatures(APP, getContext().getPackageName()) != PackageManager.SIGNATURE_MATCH)
            throw new SecurityException("the VorteX Axis app is not signed with this helper's key");
        String portText = args.getString("port");
        String secret = args.getString("secret");
        if (portText == null || secret == null || !secret.matches("[0-9a-f]{32}")) throw new SecurityException("started without a port and a secret");
        int port = Integer.parseInt(portText.trim());
        note("checks passed (app uid " + app + ", port " + port + ")");
        UiAutomation ui = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        if (ui == null) throw new IllegalStateException("no UiAutomation (start it with am instrument from the shell)");
        note("UiAutomation connected");
        AccessibilityServiceInfo info = ui.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        ui.setServiceInfo(info);
        note("service info set");
        String version = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
        HelperRouter<android.view.accessibility.AccessibilityNodeInfo> router = new HelperRouter<>(new Screen(ui), version);
        // Loopback only: nothing off the headset can reach it. Another app on the headset can connect, and gets
        // nothing answered without the secret.
        ServerSocket ss = new ServerSocket(port, 4, InetAddress.getByName("127.0.0.1"));
        server = ss;
        note("listening on 127.0.0.1:" + port + ", version " + version);
        Log.i(TAG, "listening on port " + port + ", version " + version);
        Thread watch = new Thread(() -> {
            while (server != null) {
                try { Thread.sleep(30_000); } catch (InterruptedException e) { return; }
                if (System.currentTimeMillis() - seen > IDLE_MS) {
                    Log.i(TAG, "the app has not been heard for ten minutes; ending");
                    close();
                    // A blocked accept() may not see the close: finishing ends the process either way.
                    Bundle out = new Bundle();
                    out.putString("stopped", "idle");
                    finish(Activity.RESULT_OK, out);
                    return;
                }
            }
        }, "helper-idle");
        watch.setDaemon(true);
        watch.start();
        while (server != null) {
            Socket s;
            try {
                s = ss.accept();
            } catch (IOException e) {
                if (server == null) return;
                throw e;
            }
            s.setTcpNoDelay(true);
            // A peer that never says anything is let go, so it cannot hold the helper's attention.
            s.setSoTimeout(5_000);
            Thread t = new Thread(() -> {
                try (Socket c = s) {
                    HelperServer.serve(c.getInputStream(), c.getOutputStream(), router, () -> seen = System.currentTimeMillis(), secret, () -> {
                        try { c.setSoTimeout(0); } catch (IOException ignored) {}
                        note("the app is connected");
                        seen = System.currentTimeMillis();
                    });
                } catch (IOException ignored) {
                    // The app hung up, or never proved the secret in time.
                }
            }, "helper-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    private void close() {
        ServerSocket ss = server;
        server = null;
        if (ss != null) try { ss.close(); } catch (IOException ignored) {}
    }
}
