package dev.vortexaxis.quest;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import dev.vortexaxis.quest.core.AdbLink;
import dev.vortexaxis.quest.core.AxisAddress;
import dev.vortexaxis.quest.core.AxisLink;
import dev.vortexaxis.quest.core.Helper;
import dev.vortexaxis.quest.core.PanelCommands;
import dev.vortexaxis.quest.core.QuestClient;
import dev.vortexaxis.quest.core.RollingLog;
import dev.vortexaxis.quest.core.SelfUpdate;

/**
 * The app's one QuestClient and what is saved for it: the pairing (token sealed by SecretBox) and
 * the pause switch, in private preferences. The service and the window both talk to this; changes
 * are told to them on the main thread.
 */
final class Hub {
    private static Hub instance;

    static synchronized Hub get(Context context) {
        if (instance == null) instance = new Hub(context.getApplicationContext());
        return instance;
    }

    final Context app;
    final QuestClient client;
    final RollingLog log;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CopyOnWriteArrayList<Runnable> watchers = new CopyOnWriteArrayList<>();
    /** Slow work started from the window (pairing, Set up, Test), off the main thread. */
    final ExecutorService work = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService checks = Executors.newSingleThreadScheduledExecutor();
    /** The fast engine's checks: its own thread, since installing the helper can take a while. */
    private final ScheduledExecutorService engine = Executors.newSingleThreadScheduledExecutor();
    volatile String linkWhy = "";

    private Hub(Context app) {
        this.app = app;
        File dir = app.getExternalFilesDir(null);
        if (dir == null) dir = app.getFilesDir();
        log = new RollingLog(new File(dir, "axis.log"), 512 * 1024);
        log.echoTo(line -> Log.i("VortexAxis", line));
        log.line("start: VorteX Axis " + BuildConfig.VERSION_NAME + " on " + Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE);
        prefs = app.getSharedPreferences("axis", Context.MODE_PRIVATE);
        AdbLink adb = new AdbLink(AdbLink.HOST, AdbLink.PORT, new AndroidParts.Keys(app), "vortexaxis@quest", log);
        client = new QuestClient(adb, new OkHttpSockets(), log, BuildConfig.VERSION_NAME);
        client.commands.setPictures(new AndroidParts.Pictures());
        client.commands.setApps(new AndroidParts.Apps(app));
        client.commands.paused = prefs.getBoolean("paused", false);
        client.commands.compressed = prefs.getBoolean("fasterLooks", false);
        client.update.setHost(new Updates());
        client.helper.setHost(new AndroidParts.HelperApk(app));
        client.helper.setChannel(new AndroidParts.HelperSocket(app));
        client.helper.setEnabled(prefs.getBoolean("fastEngine", true));
        afterUpdate();
        client.setListener(new QuestClient.Listener() {
            @Override public void link(AxisLink.State state, String why) {
                linkWhy = why == null ? "" : why;
                changed();
            }
            @Override public void adb(AdbLink.State state, String detail) { changed(); }
            @Override public void recent() { changed(); }
            @Override public void engine(Helper.State state, String detail) { changed(); }
            @Override public void doing() { changed(); }
        });
        // adb comes and goes (`adb tcpip` lasts until the headset restarts): looked at quietly once a minute, never raising the Allow dialog.
        checks.scheduleWithFixedDelay(() -> {
            if (!client.adb.ready()) {
                try { client.adb.connect(0); } catch (Exception ignored) {}
            }
        }, 2, 60, TimeUnit.SECONDS);
        // The fast engine: installed, started, pinged and started again when it stops, every ten seconds, while paired.
        engine.scheduleWithFixedDelay(() -> {
            try {
                if (prefs.contains("clientId")) client.helper.tick();
            } catch (RuntimeException e) {
                log.line("engine: check failed: " + e);
            }
        }, 3, 10, TimeUnit.SECONDS);
    }

    void watch(Runnable r) { watchers.add(r); }
    void unwatch(Runnable r) { watchers.remove(r); }

    void changed() {
        main.post(() -> { for (Runnable r : watchers) r.run(); });
    }

    // ---- the pairing -----------------------------------------------------------

    AxisLink.Pairing pairing() {
        String address = prefs.getString("address", null), id = prefs.getString("clientId", null), sealed = prefs.getString("token", null);
        if (address == null || id == null || sealed == null) return null;
        try {
            return new AxisLink.Pairing(address, id, new String(SecretBox.open(sealed), StandardCharsets.UTF_8), prefs.getString("name", "Quest"));
        } catch (Exception e) {
            log.line("pairing: the token could not be unsealed (" + e.getClass().getSimpleName() + "); pair again");
            return null;
        }
    }

    /** Pairs with Axis (blocking: call from `work`) and keeps the pairing. */
    AxisLink.Pairing pair(String address, String code, String name) throws Exception {
        AxisAddress where = AxisAddress.parse(address);
        String useCode = code == null || code.trim().isEmpty() ? where.code : code.trim();
        if (useCode == null) throw new IllegalArgumentException("Give the pairing code from Axis's admin page (Add a device).");
        AxisLink.Pairing p = AxisLink.pair(where, useCode, name, client.identity());
        prefs.edit()
                .putString("address", p.address)
                .putString("clientId", p.clientId)
                .putString("token", SecretBox.seal(p.token.getBytes(StandardCharsets.UTF_8)))
                .putString("name", p.name)
                .apply();
        log.line("pairing: paired with " + p.address + " as " + p.name);
        return p;
    }

    void forget() {
        client.stop();
        engine.execute(client.helper::shutdown);
        prefs.edit().remove("address").remove("clientId").remove("token").apply();
        log.line("pairing: forgotten");
        changed();
    }

    String savedName() { return prefs.getString("name", "Quest"); }
    String savedAddress() { return prefs.getString("address", ""); }

    /** Connects with the saved pairing, unless already connected or connecting. */
    void connect() {
        AxisLink.Pairing p = pairing();
        if (p == null) return;
        AxisLink.State s = client.linkState();
        if (s == AxisLink.State.ONLINE || s == AxisLink.State.CONNECTING) return;
        client.start(p);
    }

    void setPaused(boolean paused) {
        client.setPaused(paused);
        prefs.edit().putBoolean("paused", paused).apply();
        changed();
    }

    /** Opens adb, offering the key so the headset asks "Allow USB debugging?" if it does not know it. */
    void setUpAdb() {
        work.execute(() -> {
            try {
                client.adb.connect(AdbLink.APPROVAL_MS);
            } catch (Exception e) {
                log.line("adb: set up: " + e.getMessage());
            }
            changed();
        });
    }

    boolean fasterLooks() { return client.commands.compressed; }

    /** "Faster looks": `uiautomator dump --compressed` for agents' looks. Kept across restarts. */
    void setFasterLooks(boolean on) {
        client.commands.compressed = on;
        prefs.edit().putBoolean("fasterLooks", on).apply();
        log.line("faster looks " + (on ? "on" : "off"));
        changed();
    }

    boolean fastEngine() { return client.helper.enabled(); }

    /** "Use fast engine": on by default. Off stops the helper (off the main thread: it uses adb). */
    void setFastEngine(boolean on) {
        prefs.edit().putBoolean("fastEngine", on).apply();
        log.line("fast engine " + (on ? "on" : "off"));
        engine.execute(() -> {
            client.helper.setEnabled(on);
            if (on) client.helper.tick();
            changed();
        });
    }

    /** The Test button: the panel read with the fast engine and both uiautomator ways, with where the time went. */
    String test() {
        long t0 = System.currentTimeMillis();
        try {
            PanelCommands.TestResult r = client.commands.test();
            StringBuilder sb = new StringBuilder(r.panel.window()).append('\n');
            sb.append("Fast engine: ").append(r.fast != null ? r.fast.toString() : r.fastNote).append('\n');
            sb.append("Normal: ").append(r.plain).append('\n');
            sb.append("Faster (--compressed): ").append(r.compressed != null ? r.compressed.toString() : "failed: " + r.compressedFailed).append('\n');
            if (r.fast != null) sb.append("Agents' looks use the fast engine; uiautomator only when it is not answering.");
            else sb.append(fasterLooks() ? "Faster looks is on: agents get the compressed dump." : "Faster looks is off: agents get the normal dump.");
            log.line("test: " + sb.toString().replace('\n', ' '));
            return sb.toString();
        } catch (Exception e) {
            return "Failed after " + (System.currentTimeMillis() - t0) + " ms: " + e.getMessage();
        }
    }

    // ---- updates from Axis -----------------------------------------------------

    /** Where the download goes, the package manager's look at it, and the version being installed, kept over the restart. */
    private final class Updates implements SelfUpdate.Host {
        @Override public File folder() throws IOException {
            File base = app.getExternalFilesDir(null);
            if (base == null) throw new IOException("the app's files folder is not there");
            File dir = new File(base, "update");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("could not make " + dir.getPath());
            return dir;
        }

        @Override public void check(File apk) throws IOException {
            PackageManager pm = app.getPackageManager();
            PackageInfo fresh = pm.getPackageArchiveInfo(apk.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
            if (fresh == null) throw new IOException("the download is not an Android app");
            if (!app.getPackageName().equals(fresh.packageName)) throw new IOException("the download is another app (" + fresh.packageName + ")");
            PackageInfo mine;
            try {
                mine = pm.getPackageInfo(app.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            } catch (PackageManager.NameNotFoundException e) {
                throw new IOException("this app cannot read its own package");
            }
            if (fresh.getLongVersionCode() < mine.getLongVersionCode())
                throw new IOException("the download's build number " + fresh.getLongVersionCode() + " is older than this app's " + mine.getLongVersionCode());
            // Android installs an update only when it is signed with the same key; say so before trying.
            if (fresh.signingInfo != null && mine.signingInfo != null
                    && !Arrays.equals(fresh.signingInfo.getApkContentsSigners(), mine.signingInfo.getApkContentsSigners()))
                throw new IOException("the download is signed with another key than this app, so Android would refuse it: uninstall the app and install the new one by cable (the pairing is lost)");
        }

        @Override public void pending(String version) {
            // commit, not apply: the process may end a few seconds from now.
            if (version == null) prefs.edit().remove("updatePending").commit();
            else prefs.edit().putString("updatePending", version).commit();
        }
    }

    /** After an update: "Updated to X" in Recently, or that it did not take; the download is removed. */
    private void afterUpdate() {
        String pending = prefs.getString("updatePending", null);
        if (pending != null) {
            prefs.edit().remove("updatePending").apply();
            String said = pending.equals(BuildConfig.VERSION_NAME) ? "Updated to " + pending : "The update to " + pending + " did not take; this is still " + BuildConfig.VERSION_NAME;
            log.line("update: " + said);
            client.remember(said);
        }
        File base = app.getExternalFilesDir(null);
        File left = base == null ? null : new File(new File(base, "update"), SelfUpdate.FILE);
        if (left != null && left.exists()) left.delete();
    }

    String diagnostics() {
        return client.diagnostics(Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")")
                + "\nLog file: " + (log.file() == null ? "none" : log.file().getPath()) + "\n";
    }
}
