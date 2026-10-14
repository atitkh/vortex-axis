package dev.vortexaxis.quest;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.List;

import dev.vortexaxis.quest.core.AdbLink;
import dev.vortexaxis.quest.core.PanelCommands;

/** The few things the core asks of Android: pictures, the app list, and somewhere safe for the adb key. */
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

    static String utf8(byte[] b) { return new String(b, StandardCharsets.UTF_8); }
}
