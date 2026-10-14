package dev.vortexaxis.quest.core;

import static dev.vortexaxis.quest.core.T.check;
import static dev.vortexaxis.quest.core.T.equal;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import com.sun.net.httpserver.HttpServer;

/**
 * Axis's `update` on the headset, over the real adb client and a pretend adbd, with a small HTTP
 * server standing in for Axis's /v1/quest/app: what is refused before anything is fetched (not newer,
 * not on the paired Axis, plain http far away, an incomplete offer), a download that does not match,
 * the package manager's check failing, and the exact commands of an install that goes ahead.
 */
public class UpdateTest {
    static final byte[] APK = "PK pretend quest-client.apk 0.2.1".getBytes(StandardCharsets.UTF_8);
    static final String TOKEN = "t0ken-of-the-headset-0123456789";

    public static void main(String[] args) throws Exception {
        FakeAdbd adbd = new FakeAdbd();
        String[] xml = {Panel.extractXml(T.fixture("store-panel.xml"))};
        adbd.answer = T.headset(xml, new String[] {"com.oculus.store"});
        RollingLog log = T.log();
        AdbLink adb = new AdbLink("127.0.0.1", adbd.port(), new T.MemoryKeys(), "vortexaxis@quest", log);
        adb.connect(AdbLink.APPROVAL_MS);
        adbd.take();

        byte[][] served = {APK};
        AtomicInteger asked = new AtomicInteger();
        List<String> auth = new ArrayList<>();
        HttpServer axis = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        axis.createContext("/v1/quest/app", ex -> {
            asked.incrementAndGet();
            String a = ex.getRequestHeaders().getFirst("authorization") + " " + ex.getRequestHeaders().getFirst("x-axis-client");
            auth.add(a);
            if (!a.equals("Bearer " + TOKEN + " quest-1")) {
                ex.sendResponseHeaders(401, -1);
                ex.close();
                return;
            }
            ex.sendResponseHeaders(200, served[0].length);
            try (OutputStream o = ex.getResponseBody()) { o.write(served[0]); }
        });
        axis.start();
        String base = "http://127.0.0.1:" + axis.getAddress().getPort();

        File dir = Files.createTempDirectory("quest-update").toFile();
        List<String> pending = new ArrayList<>();
        String[] refuse = {null};
        SelfUpdate.Host host = new SelfUpdate.Host() {
            @Override public File folder() { return dir; }
            @Override public void check(File apk) throws IOException { if (refuse[0] != null) throw new IOException(refuse[0]); }
            @Override public void pending(String version) { pending.add(String.valueOf(version)); }
        };
        QuestClient quest = new QuestClient(adb, new JdkSockets(), log, "0.2.0");
        List<String> diary = new ArrayList<>();
        quest.update.setDiary(diary::add);
        quest.update.delaySeconds = 3;
        String sha = hex(MessageDigest.getInstance("SHA-256").digest(APK));

        System.out.println("[update] refused before anything is fetched");
        AxisLink.Answer a = quest.commands.handle("update", offer("0.2.1", APK.length, sha, "/v1/quest/app"));
        check(!a.ok && a.error.contains("cannot update itself"), "without the app's part (no Host, no pairing): " + a.error);
        quest.update.setHost(host);
        quest.update.setPairing(new AxisLink.Pairing(base, "quest-1", TOKEN, "Quest"));
        for (String v : new String[] {"0.2.0", "0.1.9", "0.1.10", "beta"}) {
            a = quest.commands.handle("update", offer(v, APK.length, sha, "/v1/quest/app"));
            check(!a.ok && a.error.contains("not newer"), "not newer (" + v + "): " + a.error);
        }
        for (String path : new String[] {"//evil.example.org/x.apk", "/v1/../../x", "/v1/quest/app?x=1", "/a b", "v1/quest/app"}) {
            a = quest.commands.handle("update", offer("0.2.1", APK.length, sha, path));
            check(!a.ok, "not a path on the paired Axis (" + path + "): " + a.error);
        }
        a = quest.commands.handle("update", offer("0.2.1", 0, sha, "/v1/quest/app"));
        check(!a.ok && a.error.contains("incomplete"), "no size: " + a.error);
        a = quest.commands.handle("update", offer("0.2.1", APK.length, "abc", "/v1/quest/app"));
        check(!a.ok && a.error.contains("incomplete"), "no proper checksum: " + a.error);
        a = quest.commands.handle("update", offer("0.2.1; reboot", APK.length, sha, "/v1/quest/app"));
        check(!a.ok && a.error.contains("incomplete"), "a version with shell in it: " + a.error);
        quest.update.setPairing(new AxisLink.Pairing("http://axis.example.org:8440", "quest-1", TOKEN, "Quest"));
        a = quest.commands.handle("update", offer("0.2.1", APK.length, sha, "/v1/quest/app"));
        check(!a.ok && a.error.contains("unencrypted"), "plain http to a public name: " + a.error);
        quest.update.setPairing(new AxisLink.Pairing(base, "quest-1", TOKEN, "Quest"));
        equal(asked.get(), 0, "nothing was downloaded for any of them");
        check(adbd.take().isEmpty() && pending.isEmpty(), "nothing went to adb, nothing was remembered");
        check(SelfUpdate.nearby("192.168.1.20") && SelfUpdate.nearby("10.0.0.5") && SelfUpdate.nearby("100.100.1.2") && SelfUpdate.nearby("axis.local") && SelfUpdate.nearby("vortex-axis") && SelfUpdate.nearby("[fd00::1]"), "nearby: the local network and a tailnet");
        check(!SelfUpdate.nearby("axis.example.org") && !SelfUpdate.nearby("8.8.8.8") && !SelfUpdate.nearby("[2001:db8::1]") && !SelfUpdate.nearby("172.32.0.1"), "not nearby: the internet");
        check(SelfUpdate.newer("0.10.0", "0.9.9") && !SelfUpdate.newer("0.2.0", "0.2.0") && SelfUpdate.newer("1.0", "0.9.9"), "versions compare by number");

        System.out.println("[update] a download that does not match");
        File apk = new File(dir, SelfUpdate.FILE);
        served[0] = "PK something else of the same length!".substring(0, APK.length).getBytes(StandardCharsets.UTF_8);
        a = quest.commands.handle("update", offer("0.2.1", APK.length, sha, "/v1/quest/app"));
        check(!a.ok && a.error.contains("checksum"), "another file: " + a.error);
        check(!apk.exists(), "and the file is deleted");
        served[0] = APK;
        a = quest.commands.handle("update", offer("0.2.1", APK.length + 5, sha, "/v1/quest/app"));
        check(!a.ok && a.error.contains("bytes"), "another size: " + a.error);
        check(!apk.exists(), "deleted again");
        equal(auth.get(0), "Bearer " + TOKEN + " quest-1", "downloaded with the headset's own token and id");
        refuse[0] = "the download is signed with another key than this app";
        a = quest.commands.handle("update", offer("0.2.1", APK.length, sha, "/v1/quest/app"));
        check(!a.ok && a.error.contains("another key"), "the package manager's check refuses: " + a.error);
        check(!apk.exists(), "and the file is deleted");
        refuse[0] = null;
        List<String> sent = adbd.take();
        check(sent.stream().noneMatch(c -> c.contains("pm install") || c.contains("cp ")), "nothing was installed for any of them: " + sent);

        System.out.println("[update] one that goes ahead");
        quest.update.delaySeconds = 0;
        adbd.answer = cmd -> cmd.startsWith("pm install")
                ? "Success\n".getBytes(StandardCharsets.UTF_8)
                : T.headset(xml, new String[] {"com.oculus.store"}).apply(cmd);
        a = quest.commands.handle("update", offer("0.2.1", APK.length, sha.toUpperCase(), "/v1/quest/app"));
        check(a.ok, "answered before the app goes: " + a.error);
        equal(a.payload, Json.obj("version", "0.2.1"), "with the version");
        check(apk.exists() && java.util.Arrays.equals(Files.readAllBytes(apk.toPath()), APK), "the download is kept in the app's update folder");
        sent = new java.util.ArrayList<>();
        for (int i = 0; i < 50 && sent.size() < 2; i++) {
            Thread.sleep(100);
            sent.addAll(adbd.take());
        }
        String path = apk.getAbsolutePath();
        equal(sent, java.util.Arrays.asList(
                "rm -f /data/local/tmp/vortex-axis-update.txt && cp '" + path + "' /data/local/tmp/vortex-axis-update.apk && chmod 644 /data/local/tmp/vortex-axis-update.apk && echo staged",
                "pm install -r /data/local/tmp/vortex-axis-update.apk 2>&1; rm -f /data/local/tmp/vortex-axis-update.apk"),
                "copied where pm can read it, then pm install -r in the app's own stream (no detaching: the app is restarted by Android)");
        equal(pending, java.util.Arrays.asList("0.2.1"), "the version being installed is remembered for after the restart");
        check(diary.stream().anyMatch(d -> d.startsWith("Updating to 0.2.1")), "Recently says so");
        check(SelfUpdate.stageCommand("/sdcard/it's here.apk").contains("cp '/sdcard/it'\\''s here.apk' "), "the path is one quoted word");

        System.out.println("[update] the install fails on the headset");
        pending.clear();
        adbd.answer = cmd -> cmd.startsWith("pm install")
                ? "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package dev.vortexaxis.quest signatures do not match]\n".getBytes(StandardCharsets.UTF_8)
                : T.headset(xml, new String[] {"com.oculus.store"}).apply(cmd);
        a = quest.commands.handle("update", offer("0.2.1", APK.length, sha, "/v1/quest/app"));
        check(a.ok, "the answer went first");
        for (int i = 0; i < 40 && !pending.contains("null"); i++) Thread.sleep(100);
        check(pending.contains("null"), "pm's failure forgets the pending version: " + pending);
        check(diary.stream().anyMatch(d -> d.contains("INSTALL_FAILED_UPDATE_INCOMPATIBLE")), "and Recently has pm's words");
        check(!apk.exists(), "the download is deleted");

        System.out.println("[update] adb not there");
        adbd.close();
        adb.close();
        a = quest.commands.handle("update", offer("0.3.0", APK.length, sha, "/v1/quest/app"));
        check(!a.ok && a.error.contains("adb"), "said before downloading: " + a.error);
        axis.stop(0);
        System.out.println("UpdateTest: ALL PASS (" + T.checks + " checks)");
    }

    static Map<String, Object> offer(String version, long size, String sha, String path) {
        return Json.obj("version", version, "size", size, "sha256", sha, "path", path);
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }
}
