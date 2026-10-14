package dev.vortexaxis.quest.core;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;

/**
 * The app's log: lines to a file that rolls over at a size (one old copy kept), and the last few
 * hundred in memory for "Copy diagnostics". Callers never pass tokens or typed text; `redact` is a
 * last guard against a token slipping into a message.
 */
public final class RollingLog {
    public interface Sink { void line(String line); }

    private static final int KEEP_LINES = 400;
    private final File file;
    private final long maxBytes;
    private final ArrayDeque<String> recent = new ArrayDeque<>();
    private final SimpleDateFormat stamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.ROOT);
    private volatile Sink echo;
    private OutputStream out;
    private long size;

    /** `file` may be null: memory only (tests, or no storage). */
    public RollingLog(File file, long maxBytes) {
        this.file = file;
        this.maxBytes = maxBytes;
    }

    /** Also hands every line to `sink` (System.out in tests, logcat in the app). */
    public void echoTo(Sink sink) { this.echo = sink; }

    public synchronized void line(String text) {
        String line = stamp.format(new Date()) + " " + redact(text);
        recent.addLast(line);
        while (recent.size() > KEEP_LINES) recent.removeFirst();
        Sink e = echo;
        if (e != null) e.line(line);
        if (file == null) return;
        try {
            if (out == null) {
                File dir = file.getParentFile();
                if (dir != null) dir.mkdirs();
                size = file.exists() ? file.length() : 0;
                out = new FileOutputStream(file, true);
            }
            byte[] bytes = (line + "\n").getBytes(StandardCharsets.UTF_8);
            if (size + bytes.length > maxBytes) {
                out.close();
                File old = new File(file.getPath() + ".1");
                old.delete();
                file.renameTo(old);
                out = new FileOutputStream(file, false);
                size = 0;
            }
            out.write(bytes);
            out.flush();
            size += bytes.length;
        } catch (IOException ignored) {
            // The log is a convenience; a full disk must not stop the app.
        }
    }

    /** The last lines, oldest first. */
    public synchronized String recentText() {
        StringBuilder sb = new StringBuilder();
        for (String l : recent) sb.append(l).append('\n');
        return sb.toString();
    }

    public File file() { return file; }

    /** Anything that looks like a token after "token" is cut out. */
    static String redact(String s) {
        if (s == null) return "";
        return s.replaceAll("(?i)(token\"?\\s*[:=]\\s*\"?)[^\"\\s,}]+", "$1***");
    }
}
