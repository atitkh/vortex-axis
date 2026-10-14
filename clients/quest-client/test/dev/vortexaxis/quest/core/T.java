package dev.vortexaxis.quest.core;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** The tests' few helpers: checks that stop at the first failure, the fixture, keys kept in memory. */
final class T {
    static int checks;

    static void check(boolean ok, String what) {
        checks++;
        if (!ok) {
            System.out.println("FAIL: " + what);
            System.exit(1);
        }
        System.out.println("  ok: " + what);
    }

    static void equal(Object got, Object want, String what) {
        boolean ok = want == null ? got == null : want.equals(got);
        if (!ok) {
            System.out.println("FAIL: " + what + "\n   want: " + want + "\n    got: " + got);
            System.exit(1);
        }
        checks++;
        System.out.println("  ok: " + what);
    }

    static String fixture(String name) throws IOException {
        File dir = new File(System.getProperty("fixtures", "test/fixtures"));
        return new String(Files.readAllBytes(new File(dir, name).toPath()), StandardCharsets.UTF_8);
    }

    static RollingLog log() {
        RollingLog log = new RollingLog(null, 1 << 20);
        if (System.getenv("QUIET") == null) log.echoTo(line -> System.out.println("     log " + line));
        return log;
    }

    /** The app keeps the adb key wrapped by the Android Keystore; here it is kept in memory. */
    static final class MemoryKeys implements AdbLink.KeyStore {
        byte[][] saved;

        @Override public byte[][] load() { return saved; }
        @Override public void save(byte[] pkcs8, byte[] x509) { saved = new byte[][] {pkcs8, x509}; }
        @Override public void forget() { saved = null; }
    }

    /** What the pretend headset answers: the fixture for a dump, a focus line for dumpsys, a PNG for screencap. */
    static java.util.function.Function<String, byte[]> headset(String[] xml, String[] focus) {
        return cmd -> {
            String out;
            if (cmd.contains("uiautomator dump")) out = "UI hierchary dumped to: " + PanelCommands.DUMP + "\n";
            else if (cmd.startsWith("cat " + PanelCommands.DUMP)) out = xml[0];
            else if (cmd.endsWith("&& echo staged")) out = "staged\n";
            else if (cmd.startsWith("pm install -r ")) out = "Success\n";
            else if (cmd.endsWith("& echo started")) out = "started\n";
            else if (cmd.startsWith("dumpsys window")) out = "  mCurrentFocus=Window{1a2b3c u0 " + focus[0] + "/" + focus[0] + ".MainActivity}\n  mFocusedApp=ActivityRecord{4d5e u0 " + focus[0] + "/.MainActivity t12}\n";
            else if (cmd.startsWith("screencap")) return png();
            else if (cmd.startsWith("cmd package query-activities"))
                out = "com.oculus.browser/com.oculus.browser.PanelActivity\ncom.example.chess/.MainActivity\ncom.oculus.store/.StoreActivity\n";
            else if (cmd.startsWith("echo ")) out = cmd.substring(5) + "\n";
            else if (cmd.startsWith("input keycombination")) out = "";
            else if (cmd.startsWith("monkey")) out = "  bash arg: -p\nEvents injected: 1\n";
            else if (cmd.startsWith("am start")) out = "Starting: Intent { act=android.intent.action.VIEW }\n";
            else out = "";
            return out.getBytes(StandardCharsets.UTF_8);
        };
    }

    static byte[] png() {
        try {
            java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(1280, 800, java.awt.image.BufferedImage.TYPE_INT_RGB);
            java.awt.Graphics2D g = img.createGraphics();
            g.setColor(java.awt.Color.DARK_GRAY);
            g.fillRect(0, 0, 1280, 800);
            g.setColor(java.awt.Color.CYAN);
            g.fillRect(24, 170, 300, 240);
            g.dispose();
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            javax.imageio.ImageIO.write(img, "png", b);
            return b.toByteArray();
        } catch (IOException e) {
            throw new RuntimeException(e);
        }
    }

    /** Pictures as the app makes them, with javax.imageio instead of android.graphics. */
    static final class JvmPictures implements PanelCommands.Pictures {
        @Override public PanelCommands.Shot shrink(byte[] png, int maxSide, int[] crop) throws IOException {
            java.awt.image.BufferedImage img = javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(png));
            if (crop != null) {
                int x = Math.min(crop[0], img.getWidth() - 1), y = Math.min(crop[1], img.getHeight() - 1);
                img = img.getSubimage(x, y, Math.min(crop[2], img.getWidth() - x), Math.min(crop[3], img.getHeight() - y));
            }
            double scale = Math.min(1.0, (double) maxSide / Math.max(img.getWidth(), img.getHeight()));
            int w = Math.max(1, (int) Math.round(img.getWidth() * scale)), h = Math.max(1, (int) Math.round(img.getHeight() * scale));
            java.awt.image.BufferedImage out = new java.awt.image.BufferedImage(w, h, java.awt.image.BufferedImage.TYPE_INT_RGB);
            java.awt.Graphics2D g = out.createGraphics();
            g.drawImage(img, 0, 0, w, h, null);
            g.dispose();
            java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
            javax.imageio.ImageIO.write(out, "jpg", b);
            return new PanelCommands.Shot(b.toByteArray(), w, h);
        }
    }
}
