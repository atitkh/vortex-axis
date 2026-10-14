package dev.vortexaxis.questprobe;

import android.app.Activity;
import android.os.Bundle;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.DataInputStream;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Quest probe v2. Keeps Q1 (does adbd answer?) and adds the full adb AUTH key
// exchange plus shell commands over 127.0.0.1:5555, with an on-panel UI to verify
// the connection and run checks. All networking is on a single worker thread; the
// UI is updated via runOnUiThread. The protocol itself lives in AdbClient.
public class MainActivity extends Activity {
    // Q1 constants (self-contained; the key exchange uses AdbClient instead).
    static final int A_CNXN = 0x4e584e43, A_AUTH = 0x48545541, A_STLS = 0x534c5453, A_CLSE = 0x45534c43;
    static final int VERSION = 0x01000001, MAX_DATA = 256 * 1024;

    static final String HOST = "127.0.0.1";
    static final int PORT = 5555;
    static final String KEY_NAME = "questprobe@quest";
    static final int APPROVAL_TIMEOUT_MS = 60000;

    TextView out, status;
    CheckBox allowActions;
    EditText textField, cmdField;
    ScrollView scroll;

    final ExecutorService worker = Executors.newSingleThreadExecutor();
    AdbClient adb; // the live connection, or null

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.main);
        out = findViewById(R.id.out);
        status = findViewById(R.id.status);
        allowActions = findViewById(R.id.allowActions);
        textField = findViewById(R.id.textField);
        cmdField = findViewById(R.id.cmdField);
        scroll = findViewById(R.id.scroll);

        findViewById(R.id.run).setOnClickListener(v -> worker.submit(() -> handshake(HOST, PORT)));
        findViewById(R.id.connect).setOnClickListener(v -> worker.submit(this::connect));
        findViewById(R.id.disconnect).setOnClickListener(v -> worker.submit(this::disconnect));
        findViewById(R.id.forget).setOnClickListener(v -> worker.submit(this::forgetKey));
        findViewById(R.id.runAll).setOnClickListener(v -> worker.submit(this::runAll));

        findViewById(R.id.cId).setOnClickListener(v -> runOne("id", "id"));
        findViewById(R.id.cDump).setOnClickListener(v -> worker.submit(this::dumpActivePanel));
        findViewById(R.id.cWindows).setOnClickListener(v -> runOne("windows",
                "dumpsys window windows | grep -E 'Window #|mDisplayId' | head -40"));
        findViewById(R.id.cDisplays).setOnClickListener(v -> runOne("displays",
                "dumpsys display | grep -E 'mDisplayId|DisplayDeviceInfo' | head -20"));
        findViewById(R.id.cForeground).setOnClickListener(v -> runOne("foreground",
                "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | head -5"));
        findViewById(R.id.cScreencap).setOnClickListener(v -> runOne("screencap", "screencap -p | wc -c"));

        findViewById(R.id.aTap).setOnClickListener(v -> runAction("tap", "input tap 640 400"));
        findViewById(R.id.aSwipe).setOnClickListener(v -> runAction("swipe", "input swipe 900 400 300 400 300"));
        findViewById(R.id.aBack).setOnClickListener(v -> runAction("back", "input keyevent 4"));
        findViewById(R.id.aSettings).setOnClickListener(v -> runAction("settings", "am start -a android.settings.SETTINGS"));
        findViewById(R.id.aText).setOnClickListener(v -> {
            String t = textField.getText().toString();
            runAction("text", "input text " + escapeInputText(t));
        });
        findViewById(R.id.cmdRun).setOnClickListener(v -> {
            String c = cmdField.getText().toString().trim();
            if (c.isEmpty()) return;
            if (needsAllow(c) && !allowActions.isChecked()) {
                log("blocked (tick 'Allow actions' to run): " + c);
                return;
            }
            worker.submit(() -> runCmd("cmd", c));
        });

        log("Quest probe v2. log file: " + logFile().getAbsolutePath());
        log("key present: " + privKeyFile().exists());
    }

    // ---- connection lifecycle ---------------------------------------------

    void connect() {
        try {
            KeyPair kp = loadOrCreateKey();
            adb = new AdbClient((RSAPrivateKey) kp.getPrivate(), (RSAPublicKey) kp.getPublic(),
                    KEY_NAME, this::setStatus);
            adb.connect(HOST, PORT, 3000, APPROVAL_TIMEOUT_MS);
            log("CONNECTED banner=" + adb.banner());
        } catch (Exception e) {
            log("connect failed: " + e.getMessage());
            setStatus("disconnected", e.getMessage());
            adb = null;
        }
    }

    void disconnect() {
        if (adb != null) { adb.close(); adb = null; }
        log("disconnected");
    }

    void forgetKey() {
        disconnect();
        boolean a = privKeyFile().delete();
        boolean b = pubKeyFile().delete();
        boolean c = new File(externalDir(), "adbkey.pub").delete();
        log("forgot key (priv=" + a + " pub=" + b + " adbkey.pub=" + c + "). "
                + "The headset still lists it under 'Always allow' until you revoke it there.");
    }

    // ---- shell helpers -----------------------------------------------------

    void runOne(String label, String command) { worker.submit(() -> runCmd(label, command)); }

    void runAction(String label, String command) {
        if (!allowActions.isChecked()) {
            log("blocked (tick 'Allow actions'): " + label);
            return;
        }
        worker.submit(() -> runCmd(label, command));
    }

    // Run one command, log "label (Nms): output", return the result or null.
    AdbClient.ShellResult runCmd(String label, String command) {
        if (adb == null || !adb.isConnected()) {
            log(label + ": not connected (press Connect first)");
            return null;
        }
        try {
            AdbClient.ShellResult r = adb.shell(command);
            String o = r.output.trim();
            log(label + " (" + r.commandMs + "ms): " + (o.isEmpty() ? "(no output)" : o));
            return r;
        } catch (IOException e) {
            log(label + ": error " + e.getMessage());
            adb = null;
            setStatus("disconnected", "connection lost");
            return null;
        }
    }

    // 'Dump active panel': dump, read it back, count nodes, show first 3 clickable.
    void dumpActivePanel() {
        if (adb == null || !adb.isConnected()) { log("dump: not connected"); return; }
        try {
            long start = System.currentTimeMillis();
            adb.shell("uiautomator dump /sdcard/w.xml >/dev/null 2>&1");
            AdbClient.ShellResult size = adb.shell("wc -c /sdcard/w.xml");
            AdbClient.ShellResult xml = adb.shell("cat /sdcard/w.xml");
            long total = System.currentTimeMillis() - start;
            String x = xml.output;
            int nodes = count(x, "<node ");
            List<String> clickable = firstClickable(x, 3);
            StringBuilder sb = new StringBuilder();
            sb.append("dump (").append(total).append("ms total): ").append(size.output.trim())
              .append("; nodes=").append(nodes).append("; first clickable:\n");
            for (String c : clickable) sb.append("  ").append(c).append("\n");
            if (clickable.isEmpty()) sb.append("  (none found)\n");
            log(sb.toString().trim());
        } catch (IOException e) {
            log("dump: error " + e.getMessage());
        }
    }

    // ---- run-all with latency ---------------------------------------------

    void runAll() {
        if (adb == null || !adb.isConnected()) { log("run-all: not connected (press Connect first)"); return; }
        List<String> summary = new ArrayList<>();
        summary.add("Quest probe v2 read-only checks " + stamp());
        summary.add(line("id", "id", s -> s.contains("uid=")));
        summary.add(latencyLine("dump", "uiautomator dump /sdcard/w.xml >/dev/null 2>&1; wc -c /sdcard/w.xml", s -> s.contains("w.xml")));
        summary.add(line("windows", "dumpsys window windows | grep -E 'Window #' | head -40", s -> s.contains("Window")));
        summary.add(line("displays", "dumpsys display | grep -E 'mDisplayId' | head -20", s -> s.contains("mDisplayId")));
        summary.add(line("foreground", "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | head -5", s -> !s.isEmpty()));
        summary.add(latencyLine("screencap", "screencap -p | wc -c", s -> s.trim().matches("\\d+")));

        StringBuilder all = new StringBuilder();
        for (String s : summary) all.append(s).append("\n");
        log("---- RUN ALL ----\n" + all.toString().trim());
        writeSummary(all.toString());
    }

    interface Pass { boolean ok(String out); }

    // One read-only command: PASS/FAIL + ms.
    String line(String label, String command, Pass p) {
        try {
            AdbClient.ShellResult r = adb.shell(command);
            boolean ok = p.ok(r.output.trim());
            return (ok ? "PASS " : "FAIL ") + label + " (" + r.commandMs + "ms)";
        } catch (IOException e) {
            return "FAIL " + label + " (error " + e.getMessage() + ")";
        }
    }

    // Three runs; report PASS/FAIL (last run) with min/median ms.
    String latencyLine(String label, String command, Pass p) {
        long[] ms = new long[3];
        boolean ok = false;
        try {
            for (int i = 0; i < 3; i++) {
                AdbClient.ShellResult r = adb.shell(command);
                ms[i] = r.commandMs;
                ok = p.ok(r.output.trim());
            }
        } catch (IOException e) {
            return "FAIL " + label + " (error " + e.getMessage() + ")";
        }
        long[] sorted = ms.clone();
        Arrays.sort(sorted);
        return (ok ? "PASS " : "FAIL ") + label + " (min=" + sorted[0] + "ms median=" + sorted[1] + "ms x3)";
    }

    // ---- Q1 handshake (unchanged behaviour) --------------------------------

    void handshake(String host, int port) {
        log("Q1 connecting to " + host + ":" + port);
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), 3000);
            log("Q1 connected");
            s.setSoTimeout(5000);
            byte[] payload = "host::\0".getBytes(StandardCharsets.US_ASCII);
            OutputStream os = s.getOutputStream();
            os.write(q1header(A_CNXN, VERSION, MAX_DATA, payload));
            os.write(payload);
            os.flush();
            DataInputStream in = new DataInputStream(s.getInputStream());
            byte[] h = new byte[24];
            in.readFully(h);
            ByteBuffer b = ByteBuffer.wrap(h).order(ByteOrder.LITTLE_ENDIAN);
            int cmd = b.getInt(), arg0 = b.getInt(), arg1 = b.getInt(), len = b.getInt();
            String extra = "";
            if (cmd == A_CNXN && len > 0 && len < 4096) {
                byte[] d = new byte[len];
                in.readFully(d);
                extra = " banner=" + new String(d, StandardCharsets.US_ASCII).replace('\0', ' ').trim();
            }
            log(String.format(Locale.US, "Q1 RESULT: adbd answered with %s arg0=0x%08x arg1=0x%08x len=%d%s (%s)",
                    q1name(cmd), arg0, arg1, len, extra, q1meaning(cmd)));
        } catch (ConnectException e) {
            log("Q1 RESULT: refused (" + e.getMessage() + ") - nothing listening, or blocked for apps");
        } catch (SocketTimeoutException e) {
            log("Q1 RESULT: timeout (" + e.getMessage() + ")");
        } catch (IOException e) {
            log("Q1 RESULT: error " + e);
        }
    }

    static byte[] q1header(int cmd, int arg0, int arg1, byte[] data) {
        int sum = 0;
        for (byte x : data) sum += x & 0xff;
        return ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN)
                .putInt(cmd).putInt(arg0).putInt(arg1).putInt(data.length).putInt(sum).putInt(~cmd).array();
    }

    static String q1name(int cmd) {
        switch (cmd) {
            case A_CNXN: return "CNXN";
            case A_AUTH: return "AUTH";
            case A_STLS: return "STLS";
            case A_CLSE: return "CLSE";
            default: return String.format("0x%08x", cmd);
        }
    }

    static String q1meaning(int cmd) {
        switch (cmd) {
            case A_CNXN: return "connected without a key";
            case A_AUTH: return "reachable, a key is required";
            case A_STLS: return "reachable, wants TLS";
            default: return "unexpected";
        }
    }

    // ---- keys --------------------------------------------------------------

    // Load the persisted RSA key pair, or generate and persist one. Keeping the
    // key means 'Always allow from this computer' survives app restarts.
    KeyPair loadOrCreateKey() throws Exception {
        File pk = privKeyFile(), pub = pubKeyFile();
        if (pk.exists() && pub.exists()) {
            RSAPrivateKey priv = AdbClient.decodePrivateKey(Files.readAllBytes(pk.toPath()));
            RSAPublicKey pubk = AdbClient.decodePublicKey(Files.readAllBytes(pub.toPath()));
            return new KeyPair(pubk, priv);
        }
        KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
        g.initialize(2048);
        KeyPair kp = g.generateKeyPair();
        Files.write(pk.toPath(), kp.getPrivate().getEncoded());     // PKCS8
        Files.write(pub.toPath(), kp.getPublic().getEncoded());     // X509
        // A human-readable adb-format public key next to the logs, for reference.
        String adbPub = java.util.Base64.getEncoder()
                .encodeToString(AdbClient.encodeAdbPublicKey((RSAPublicKey) kp.getPublic())) + " " + KEY_NAME + "\n";
        try { Files.write(new File(externalDir(), "adbkey.pub").toPath(), adbPub.getBytes(StandardCharsets.US_ASCII)); }
        catch (IOException ignored) {}
        log("generated a new 2048-bit key");
        return kp;
    }

    File privKeyFile() { return new File(getFilesDir(), "adbkey"); }
    File pubKeyFile() { return new File(getFilesDir(), "adbkey.pub.x509"); }

    // ---- small utilities ---------------------------------------------------

    // Allow-list: these touch the device, so they need the checkbox.
    static boolean needsAllow(String cmd) {
        String c = cmd.trim();
        for (String p : new String[]{"input", "am ", "pm ", "settings ", "svc ", "reboot", "rm "}) {
            if (c.startsWith(p)) return true;
        }
        return false;
    }

    // Shell-safe single argument for `input text`: %s for spaces, quote the rest.
    static String escapeInputText(String t) {
        String spaced = t.replace(" ", "%s");
        return "'" + spaced.replace("'", "'\\''") + "'";
    }

    static int count(String s, String needle) {
        int n = 0, i = 0;
        while ((i = s.indexOf(needle, i)) >= 0) { n++; i += needle.length(); }
        return n;
    }

    // Pull the first `max` clickable nodes' text / content-desc / bounds from a
    // uiautomator dump, using plain string scanning (no XML parser needed).
    static List<String> firstClickable(String xml, int max) {
        List<String> r = new ArrayList<>();
        int i = 0;
        while (r.size() < max && (i = xml.indexOf("<node ", i)) >= 0) {
            int end = xml.indexOf('>', i);
            if (end < 0) break;
            String tag = xml.substring(i, end);
            if (tag.contains("clickable=\"true\"")) {
                r.add("text=" + attr(tag, "text") + " desc=" + attr(tag, "content-desc") + " bounds=" + attr(tag, "bounds"));
            }
            i = end + 1;
        }
        return r;
    }

    static String attr(String tag, String key) {
        String k = key + "=\"";
        int i = tag.indexOf(k);
        if (i < 0) return "";
        int start = i + k.length();
        int end = tag.indexOf('"', start);
        return end < 0 ? "" : tag.substring(start, end);
    }

    File externalDir() {
        File dir = getExternalFilesDir(null);
        return dir != null ? dir : getFilesDir();
    }

    File logFile() { return new File(externalDir(), "probe.log"); }

    void writeSummary(String text) {
        try (FileWriter w = new FileWriter(new File(externalDir(), "summary.txt"), false)) {
            w.write(text);
        } catch (IOException e) {
            log("summary.txt write failed: " + e.getMessage());
        }
    }

    static String stamp() { return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()); }

    void setStatus(String st, String detail) {
        String line = detail == null || detail.isEmpty() ? st : st + " - " + detail;
        runOnUiThread(() -> status.setText(line));
    }

    void log(String line) {
        String stamped = stamp() + " " + line;
        try (FileWriter w = new FileWriter(logFile(), true)) {
            w.write(stamped + "\n");
        } catch (IOException ignored) {}
        runOnUiThread(() -> {
            out.append(stamped + "\n");
            scroll.post(() -> scroll.fullScroll(ScrollView.FOCUS_DOWN));
        });
    }
}
