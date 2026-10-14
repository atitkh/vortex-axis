package dev.vortexaxis.quest;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.security.GeneralSecurityException;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Secrets at rest (Axis's token, the adb key) sealed with an AES key that lives in the Android
 * Keystore and never leaves it: a copy of the app's files without the device's Keystore is useless.
 * Sealed form: base64 of (12-byte IV, AES-GCM ciphertext).
 */
final class SecretBox {
    private static final String ALIAS = "vortex-axis-secrets";

    private SecretBox() {}

    private static SecretKey key() throws GeneralSecurityException {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            KeyStore.Entry e = ks.getEntry(ALIAS, null);
            if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
            KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return g.generateKey();
        } catch (java.io.IOException e) {
            throw new GeneralSecurityException(e);
        }
    }

    static String seal(byte[] plain) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] body = c.doFinal(plain);
        return Base64.encodeToString(ByteBuffer.allocate(iv.length + body.length).put(iv).put(body).array(), Base64.NO_WRAP);
    }

    static byte[] open(String sealed) throws GeneralSecurityException {
        byte[] all = Base64.decode(sealed, Base64.NO_WRAP);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
        return c.doFinal(all, 12, all.length - 12);
    }
}
