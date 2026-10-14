package dev.vortexaxis.quest;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.List;

import dev.vortexaxis.quest.core.AdbLink;
import dev.vortexaxis.quest.core.Helper;
import dev.vortexaxis.quest.core.HelperProtocol;
import dev.vortexaxis.quest.core.PanelCommands;

/** The few things the core asks of Android: pictures, the app list, somewhere safe for the adb key, and the fast engine's helper. */
final class AndroidParts {
    private AndroidParts() {}

    /** PNG from screencap to a JPEG no larger than maxSide on its long side. */
    static final class Pictures implements PanelCommands.Pictures {
        @Override public PanelCommands.Shot shrink(byte[] png, int maxSide, int[] crop) throws IOException {
            Bitmap full = BitmapFactory.decodeByteArray(png, 0, png.length);
            if (full == null) throw new IOException("the screen picture could not be read");
            Bitmap img = full;
            if (crop != null) {
                int x = Math.min(crop[0], full.getWidth() - 1), y = Math.min(crop[1], full.getHeight() - 1);
                img = Bitmap.createBitmap(full, x, y, Math.min(crop[2], full.getWidth() - x), Math.min(crop[3], full.getHeight() - y));
            }
            double scale = Math.min(1.0, (double) maxSide / Math.max(img.getWidth(), img.getHeight()));
            int w = Math.max(1, (int) Math.round(img.getWidth() * scale)), h = Math.max(1, (int) Math.round(img.getHeight() * scale));
            Bitmap out = scale < 1.0 ? Bitmap.createScaledBitmap(img, w, h, true) : img;
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            out.compress(Bitmap.CompressFormat.JPEG, 80, b);
            return new PanelCommands.Shot(b.toByteArray(), out.getWidth(), out.getHeight());
        }
    }

    /** Launchable apps with the names Android shows for them. */
    static final class Apps implements PanelCommands.Apps {
        private final Context context;

        Apps(Context context) { this.context = context.getApplicationContext(); }

        @Override public List<String[]> launchable() {
            PackageManager pm = context.getPackageManager();
            Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
            List<String[]> out = new ArrayList<>();
            for (ResolveInfo r : pm.queryIntentActivities(main, 0)) {
                CharSequence label = r.loadLabel(pm);
                out.add(new String[] {label == null ? r.activityInfo.packageName : label.toString(), r.activityInfo.packageName});
            }
            return out;
        }
    }

    /** The adb key pair, sealed with the Keystore (SecretBox) in the app's private preferences. */
    static final class Keys implements AdbLink.KeyStore {
        private final SharedPreferences prefs;

        Keys(Context context) { prefs = context.getSharedPreferences("adbkey", Context.MODE_PRIVATE); }

        @Override public byte[][] load() throws IOException {
            String priv = prefs.getString("private", null), pub = prefs.getString("public", null);
            if (priv == null || pub == null) return null;
            try {
                return new byte[][] {SecretBox.open(priv), android.util.Base64.decode(pub, android.util.Base64.NO_WRAP)};
            } catch (GeneralSecurityException e) {
                throw new IOException("the adb key could not be unsealed (" + e.getMessage() + "); press Forget key and set up again", e);
            }
        }

        @Override public void save(byte[] pkcs8, byte[] x509) throws IOException {
            try {
                prefs.edit()
                        .putString("private", SecretBox.seal(pkcs8))
                        .putString("public", android.util.Base64.encodeToString(x509, android.util.Base64.NO_WRAP))
                        .apply();
            } catch (GeneralSecurityException e) {
                throw new IOException("the adb key could not be sealed: " + e.getMessage(), e);
            }
        }

        @Override public void forget() { prefs.edit().clear().apply(); }
    }

    /** The helper APK this app carries (assets/helper.apk): its SHA-256, and a copy the shell user can read for `pm install`. */
    static final class HelperApk implements Helper.Host {
        static final String ASSET = "helper.apk";
        private final Context context;
        private volatile String sha;
        private volatile boolean looked;

        HelperApk(Context context) { this.context = context.getApplicationContext(); }

        @Override public synchronized String sha256() {
            if (!looked) {
                looked = true;
                try (InputStream in = context.getAssets().open(ASSET)) {
                    sha = hash(in);
                } catch (IOException e) {
                    sha = null;
                }
            }
            return sha;
        }

        @Override public synchronized File apk() throws IOException {
            String want = sha256();
            if (want == null) return null;
            File base = context.getExternalFilesDir(null);
            if (base == null) throw new IOException("the app's files folder is not there");
            File dir = new File(base, "helper");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("could not make " + dir.getPath());
            File f = new File(dir, ASSET);
            if (f.exists()) {
                try (InputStream in = new FileInputStream(f)) {
                    if (want.equals(hash(in))) return f;
                }
            }
            try (InputStream in = context.getAssets().open(ASSET); OutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return f;
        }

        @Override public int uid() { return android.os.Process.myUid(); }

        private static String hash(InputStream in) throws IOException {
            try {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
                StringBuilder sb = new StringBuilder();
                for (byte x : md.digest()) sb.append(String.format("%02x", x & 0xff));
                return sb.toString();
            } catch (NoSuchAlgorithmException e) {
                throw new IOException("no SHA-256 here");
            }
        }
    }

    /**
     * The helper's abstract local socket. Only the helper package, signed with this app's key, is talked to: the
     * peer's uid is checked against the helper's, so an app that took the socket's name first gets nothing (typed
     * text included). The helper checks this app's uid the same way.
     */
    static final class HelperSocket implements Helper.Channel {
        private final Context context;

        HelperSocket(Context context) { this.context = context.getApplicationContext(); }

        @Override public Helper.Conn open() throws IOException {
            PackageManager pm = context.getPackageManager();
            int helperUid;
            try {
                helperUid = pm.getPackageUid(HelperProtocol.PACKAGE, 0);
            } catch (PackageManager.NameNotFoundException e) {
                throw new IOException("the helper is not installed");
            }
            if (pm.checkSignatures(context.getPackageName(), HelperProtocol.PACKAGE) != PackageManager.SIGNATURE_MATCH)
                throw new IOException("the helper installed is signed with another key");
            LocalSocket s = new LocalSocket();
            try {
                s.connect(new LocalSocketAddress(HelperProtocol.SOCKET, LocalSocketAddress.Namespace.ABSTRACT));
                int peer = s.getPeerCredentials().getUid();
                if (peer != helperUid) throw new IOException("something else (uid " + peer + ") answers on the helper's socket");
            } catch (IOException e) {
                s.close();
                throw e;
            }
            return new Helper.Conn() {
                @Override public InputStream in() throws IOException { return s.getInputStream(); }
                @Override public OutputStream out() throws IOException { return s.getOutputStream(); }
                @Override public void close() throws IOException { s.close(); }
            };
        }
    }

    static String utf8(byte[] b) { return new String(b, StandardCharsets.UTF_8); }
}
