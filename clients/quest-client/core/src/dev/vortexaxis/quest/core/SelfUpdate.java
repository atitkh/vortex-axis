package dev.vortexaxis.quest.core;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;

/**
 * Axis's `update` command, `{version, size, sha256, path}`, taken as the Windows app takes it
 * (AppUpdate.cs): only a newer version, only from the paired Axis, plain http only on the local
 * network or a tailnet, downloaded with the headset's own token and kept only if its size and
 * SHA-256 match. Then installed through the app's own adb: the APK is copied to /data/local/tmp and
 * `pm install -r` runs a few seconds after the answer has gone, in the app's own adb stream. Installing
 * over itself ends the app's process, so a working install is never read back: Android starts the app
 * again (UpdatedReceiver). A failed one leaves the app running to say what pm said.
 */
public final class SelfUpdate {
    public static final String PACKAGE = "dev.vortexaxis.quest";
    public static final String ACTIVITY = PACKAGE + "/.MainActivity";
    /** The extra the restart carries, so the window knows it was started by an update. */
    public static final String UPDATED_EXTRA = PACKAGE + ".UPDATED";
    public static final String FILE = "quest-client.apk";
    static final String STAGED = "/data/local/tmp/vortex-axis-update.apk";
    static final String RESULT = "/data/local/tmp/vortex-axis-update.txt";
    static final int ADB_MS = 30_000, INSTALL_MS = 120_000;

    /** What only the Android side can do. */
    public interface Host {
        /** The folder the download goes in (the app's external files folder, `update/`), made if missing. */
        File folder() throws IOException;
        /** Throws, saying why, when the download is not this app signed with this app's key, or is older (Android's package manager reads it). */
        void check(File apk) throws IOException;
        /** Remembers the version being installed (null: forget it), to say "Updated to X" after the restart. */
        void pending(String version);
    }

    public static final class Offer {
        public final String version, sha256, path;
        public final long size;

        Offer(String version, long size, String sha256, String path) {
            this.version = version;
            this.size = size;
            this.sha256 = sha256;
            this.path = path;
        }

        private static final Pattern VERSION = Pattern.compile("[0-9A-Za-z.+-]{1,40}");
        private static final Pattern SHA = Pattern.compile("[0-9a-f]{64}");

        public static Offer read(Map<String, Object> p) {
            String version = p == null ? null : Json.str(p, "version");
            String sha = p == null ? null : Json.str(p, "sha256");
            String path = p == null ? null : Json.str(p, "path");
            Object size = p == null ? null : p.get("size");
            long n = size instanceof Number ? ((Number) size).longValue() : 0;
            sha = sha == null ? "" : sha.toLowerCase(Locale.ROOT);
            if (version == null || !VERSION.matcher(version).matches() || n <= 0 || !SHA.matcher(sha).matches() || path == null || !path.startsWith("/"))
                throw new IllegalArgumentException("the update offer is incomplete");
            return new Offer(version, n, sha, path);
        }
    }

    private final AdbLink adb;
    private final RollingLog log;
    private final String version;
    private volatile Host host;
    private volatile AxisLink.Pairing pairing;
    private volatile PanelCommands.Diary diary = what -> {};
    /** Seconds the install waits, so the answer is out before the app goes. */
    int delaySeconds = 3;

    public SelfUpdate(AdbLink adb, RollingLog log, String version) {
        this.adb = adb;
        this.log = log;
        this.version = version;
    }

    public void setHost(Host h) { host = h; }
    public void setPairing(AxisLink.Pairing p) { pairing = p; }
    public void setDiary(PanelCommands.Diary d) { diary = d == null ? what -> {} : d; }

    private void did(String what) {
        log.line("update: " + what);
        try { diary.did(what); } catch (RuntimeException ignored) {}
    }

    /** The command. `gate` is the panel commands' one-at-a-time lock, held only while adb is used. */
    AxisLink.Answer handle(Map<String, Object> p, ReentrantLock gate) {
        Host h = host;
        AxisLink.Pairing paired = pairing;
        if (h == null || paired == null) return AxisLink.Answer.fail("this build of the app cannot update itself");
        Offer offer;
        URL url;
        try {
            offer = Offer.read(p);
            if (!newer(offer.version, version)) return AxisLink.Answer.fail("not updating: " + offer.version + " is not newer than this app's " + version);
            url = where(paired, offer);
        } catch (IllegalArgumentException e) {
            did("Refused an update: " + e.getMessage());
            return AxisLink.Answer.fail(e.getMessage());
        }
        File apk = null;
        try {
            try {
                adb.ensure();
            } catch (IOException e) {
                throw new IOException("it is installed through the headset's adb, which is not ready: " + adb.problem());
            }
            did("Downloading version " + offer.version);
            File folder = h.folder();
            apk = new File(folder, FILE);
            download(url, paired, offer, apk);
            h.check(apk);
            String source = apk.getAbsolutePath();
            if (!SAFE_PATH.matcher(source).matches()) throw new IOException("the download's folder has an odd name: " + source);
            if (!gate.tryLock(PanelCommands.BUSY_MS, TimeUnit.MILLISECONDS)) throw new IOException("the headset is busy with an agent's command; try again in a moment");
            try {
                String out = adb.shell(stageCommand(source), ADB_MS);
                if (!out.contains("staged")) throw new IOException("the headset could not take the download: " + firstLine(out));
                h.pending(offer.version);
            } finally {
                gate.unlock();
            }
        } catch (Exception e) {
            if (apk != null) apk.delete();
            String why = AxisLink.describe(e);
            did("Update to " + offer.version + " failed: " + why);
            return AxisLink.Answer.fail("update failed: " + why);
        }
        did("Updating to " + offer.version + "; the app restarts by itself");
        install(offer.version, apk, gate);
        return AxisLink.Answer.done(Json.obj("version", offer.version));
    }

    /**
     * The install itself, once the answer has gone: `pm install -r`, run in this app's own adb stream and waited
     * for. When it works Android replaces this app, ends its process and starts it again through
     * ACTION_MY_PACKAGE_REPLACED (the app's UpdatedReceiver), so nothing after it needs to run; when it does not,
     * the app is still here and says what pm said. (An earlier version ran it detached from the stream with
     * nohup, and on the Quest it never ran: nothing was installed and nothing was said.)
     */
    private void install(String to, File apk, ReentrantLock gate) {
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(delaySeconds * 1000L);
                if (!gate.tryLock(PanelCommands.BUSY_MS, TimeUnit.MILLISECONDS)) throw new IOException("the headset was busy with an agent's command");
                String out;
                try {
                    out = adb.shell(installCommand(), INSTALL_MS);
                } finally {
                    gate.unlock();
                }
                if (out.contains("Success")) {
                    log.line("update: installed " + to + ", waiting to be restarted");
                    return;
                }
                throw new IOException(firstLine(out));
            } catch (IOException e) {
                // Only reached while the app still lives, which a working install does not leave it.
                Host h = host;
                String why = AxisLink.describe(e);
                did("Update to " + to + " failed: " + why);
                if (h != null) h.pending(null);
                if (apk != null) apk.delete();
            } catch (InterruptedException ignored) {
                // The app is going.
            }
        }, "axis-update-install");
        t.setDaemon(true);
        t.start();
    }

    private static final Pattern SAFE_PATH = Pattern.compile("/[A-Za-z0-9._/-]+");
    private static final Pattern PATH = Pattern.compile("/[A-Za-z0-9._~/-]*");

    /** The download's address: the offer's path on the paired Axis, nowhere else; plain http only nearby. */
    static URL where(AxisLink.Pairing pairing, Offer offer) {
        AxisAddress address = AxisAddress.parse(pairing.address);
        if (offer.path.startsWith("//") || !PATH.matcher(offer.path).matches() || offer.path.contains(".."))
            throw new IllegalArgumentException("the update is not on the paired Axis (" + Panel.clip(offer.path, 60) + ")");
        URL url;
        try {
            url = new URL(address.http + offer.path);
        } catch (java.net.MalformedURLException e) {
            throw new IllegalArgumentException("the update's address cannot be read");
        }
        if (!url.getAuthority().equalsIgnoreCase(address.http.substring(address.http.indexOf("://") + 3)))
            throw new IllegalArgumentException("the update is not on the paired Axis");
        // A program fetched over a plain connection across the internet could be swapped on the way, and the
        // checksum came the same way. Plain http only to this headset, the local network or a tailnet.
        if (url.getProtocol().equals("http") && !nearby(url.getHost()))
            throw new IllegalArgumentException("not updating over an unencrypted connection to " + url.getHost() + "; reach Axis over https to update");
        return url;
    }

    /** Copies the download where the shell user's `pm` can read it, and clears the last install's output. */
    static String stageCommand(String source) {
        return "rm -f " + RESULT + " && cp " + Shell.quote(source) + " " + STAGED + " && chmod 644 " + STAGED + " && echo staged";
    }

    /** `pm install -r` of the staged copy, its words (Success, or Failure [INSTALL_FAILED_...]) coming back on the stream. */
    static String installCommand() {
        return "pm install -r " + STAGED + " 2>&1; rm -f " + STAGED;
    }

    /** Downloads `url` to `file` with the headset's token and checks size and SHA-256. Throws, leaving no file, when anything does not match. */
    static void download(URL url, AxisLink.Pairing pairing, Offer offer, File file) throws IOException {
        file.delete();
        HttpURLConnection http = (HttpURLConnection) url.openConnection();
        http.setConnectTimeout(15_000);
        http.setReadTimeout(60_000);
        http.setUseCaches(false);
        http.setInstanceFollowRedirects(false);
        http.setRequestProperty("authorization", "Bearer " + pairing.token);
        http.setRequestProperty("x-axis-client", pairing.clientId);
        try {
            int status = http.getResponseCode();
            if (status != 200) throw new IOException("Axis answered " + status + " to the download");
            MessageDigest sha;
            try {
                sha = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException e) {
                throw new IOException("no SHA-256 here");
            }
            long length = 0;
            try (InputStream in = http.getInputStream(); OutputStream out = new FileOutputStream(file)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    length += n;
                    if (length > offer.size) throw new IOException("the download is longer than the " + offer.size + " bytes Axis said");
                    sha.update(buf, 0, n);
                    out.write(buf, 0, n);
                }
            }
            if (length != offer.size) throw new IOException("the download is " + length + " bytes, not " + offer.size);
            if (!hex(sha.digest()).equals(offer.sha256)) throw new IOException("the download does not match its checksum");
        } catch (IOException e) {
            file.delete();
            throw e;
        } finally {
            http.disconnect();
        }
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    private static String firstLine(String s) {
        String t = s.trim();
        int nl = t.indexOf('\n');
        if (nl > 0) t = t.substring(0, nl);
        return t.isEmpty() ? "it said nothing" : Panel.clip(t, 160);
    }

    /** "0.5.1" newer than "0.5.0"; anything that is not numbers counts as older (Axis's own rule, desktopapp.ts). */
    public static boolean newer(String a, String b) {
        String[] x = a.split("[.-]"), y = b.split("[.-]");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int d = part(x, i) - part(y, i);
            if (d != 0) return d > 0;
        }
        return false;
    }

    private static int part(String[] p, int i) {
        if (i >= p.length) return 0;
        return p[i].matches("\\d{1,9}") ? Integer.parseInt(p[i]) : -1;
    }

    private static final Pattern IPV4 = Pattern.compile("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})");

    /** True for this headset, the local network or a tailnet (100.64.0.0/10), by address or local name (AppUpdate.Nearby). */
    public static boolean nearby(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length() - 1);
        if (h.contains(":")) {
            // An IPv6 address: loopback, link-local, site-local or unique local.
            if (h.equals("::1")) return true;
            return h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb") || h.startsWith("fec") || h.startsWith("fc") || h.startsWith("fd");
        }
        java.util.regex.Matcher m = IPV4.matcher(h);
        if (m.matches()) {
            int a = Integer.parseInt(m.group(1)), b = Integer.parseInt(m.group(2));
            return a == 127 || a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 100 && b >= 64 && b <= 127);
        }
        return h.equals("localhost") || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa") || h.endsWith(".ts.net") || !h.contains(".");
    }
}
