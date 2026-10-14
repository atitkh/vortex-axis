package dev.vortexaxis.quest.helper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.pm.PackageManager;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Bundle;
import android.util.Log;

import java.io.IOException;

import dev.vortexaxis.quest.core.HelperProtocol;
import dev.vortexaxis.quest.core.HelperRouter;
import dev.vortexaxis.quest.core.HelperServer;

/**
 * The fast engine's helper. Started by the VorteX Axis app through the headset's adb, as the shell user:
 * `am instrument -w -e uid <the app's uid> dev.vortexaxis.quest.helper/.Helper`. That is what gives it a UiAutomation
 * connection; started any other way it has none and ends at once. It listens on an abstract local socket and
 * answers only a peer whose uid is the app's (as the package manager says, and as the start said) when the app is
 * signed with the helper's key. It does nothing on its own, and ends when the app has not been heard for ten minutes.
 *
 * Thin on purpose: the rules, the wire and the handle table are HelperRouter and HelperServer (plain Java, tested on
 * a JVM); this file and Screen only connect them to Android. None of it has run on a headset by its author.
 */
public final class Helper extends Instrumentation {
    static final String TAG = "VortexAxisHelper";
    static final String APP = "dev.vortexaxis.quest";
    static final long IDLE_MS = 10 * 60_000;
    private Bundle args;
    private volatile long seen = System.currentTimeMillis();
    private volatile LocalServerSocket server;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        args = arguments;
        start();
    }

    @Override public void onStart() {
        Bundle out = new Bundle();
        try {
            serve();
        } catch (Throwable t) {
            Log.e(TAG, "stopped: " + t);
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
        UiAutomation ui = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        if (ui == null) throw new IllegalStateException("no UiAutomation (start it with am instrument from the shell)");
        AccessibilityServiceInfo info = ui.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        ui.setServiceInfo(info);
        String version = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
        HelperRouter<android.view.accessibility.AccessibilityNodeInfo> router = new HelperRouter<>(new Screen(ui), version);
        LocalServerSocket ss = new LocalServerSocket(HelperProtocol.SOCKET);
        server = ss;
        Log.i(TAG, "listening for uid " + app + ", version " + version);
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
            LocalSocket s;
            try {
                s = ss.accept();
            } catch (IOException e) {
                if (server == null) return;
                throw e;
            }
            if (s.getPeerCredentials().getUid() != app) {
                Log.w(TAG, "refused a connection from uid " + s.getPeerCredentials().getUid());
                s.close();
                continue;
            }
            seen = System.currentTimeMillis();
            Thread t = new Thread(() -> {
                try (LocalSocket c = s) {
                    HelperServer.serve(c.getInputStream(), c.getOutputStream(), router, () -> seen = System.currentTimeMillis());
                } catch (IOException ignored) {
                    // The app hung up.
                }
            }, "helper-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    private void close() {
        LocalServerSocket ss = server;
        server = null;
        if (ss != null) try { ss.close(); } catch (IOException ignored) {}
    }
}
