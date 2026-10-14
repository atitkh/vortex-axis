package dev.vortexaxis.quest.core;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Everything the app runs, wired once: the Axis link answering with the panel commands over the
 * headset's adb, the settings Axis sends, the pause switch and the "Recently" list. The Android
 * service holds one; the end-to-end test builds the same one against a real Axis.
 */
public final class QuestClient {
    public interface Listener {
        default void link(AxisLink.State state, String why) {}
        default void adb(AdbLink.State state, String detail) {}
        default void recent() {}
    }

    static final int RECENT = 30;

    public final RollingLog log;
    public final AdbLink adb;
    public final PanelCommands commands;
    /** Axis's `update`: give it a Host to let the app update itself. */
    public final SelfUpdate update;
    private final Sockets sockets;
    private final String version;
    private volatile AxisLink link;
    private volatile Listener listener = new Listener() {};
    private final ArrayDeque<String> recent = new ArrayDeque<>();
    private final SimpleDateFormat clock = new SimpleDateFormat("HH:mm", Locale.ROOT);

    public QuestClient(AdbLink adb, Sockets sockets, RollingLog log, String version) {
        this.adb = adb;
        this.sockets = sockets;
        this.log = log;
        this.version = version;
        this.commands = new PanelCommands(adb, log, version);
        commands.setDiary(this::remember);
        this.update = new SelfUpdate(adb, log, version);
        update.setDiary(this::remember);
        commands.setUpdater(update);
        adb.setListener((s, d) -> listener.adb(s, d));
    }

    public void setListener(Listener l) { listener = l == null ? new Listener() {} : l; }

    public AxisLink.Identity identity() { return QuestIdentity.create(version); }

    /** Connects to Axis with a pairing, replacing any connection there was. */
    public synchronized void start(AxisLink.Pairing pairing) {
        stop();
        update.setPairing(pairing);
        AxisLink l = new AxisLink(pairing, identity(), sockets, log);
        l.setHandler(commands);
        l.setListener(new AxisLink.Listener() {
            @Override public void state(AxisLink.State state, String why) { listener.link(state, why); }
            @Override public void settings(Map<String, Object> values) {
                commands.useSettings(values);
                log.line("axis: settings " + values.keySet());
            }
            @Override public void trouble(String what) { remember(what); }
        });
        link = l;
        l.start();
    }

    public synchronized void stop() {
        AxisLink l = link;
        link = null;
        if (l != null) l.stop();
    }

    public AxisLink.State linkState() {
        AxisLink l = link;
        return l == null ? AxisLink.State.STOPPED : l.state();
    }

    public void setPaused(boolean paused) {
        commands.paused = paused;
        remember(paused ? "Paused: agents are refused" : "Resumed");
    }

    public boolean paused() { return commands.paused; }

    /** Puts a line in Recently (the app's own notes, such as "Updated to 0.2.1"). */
    public void remember(String what) {
        synchronized (recent) {
            recent.addFirst(clock.format(new Date()) + "  " + what);
            while (recent.size() > RECENT) recent.removeLast();
        }
        try { listener.recent(); } catch (RuntimeException ignored) {}
    }

    /** The last things done, newest first. */
    public List<String> recent() {
        synchronized (recent) { return new ArrayList<>(recent); }
    }

    /** A plain-text report for "Copy diagnostics": versions, states, the recent list and the log's last lines. Never a token. */
    public String diagnostics(String device) {
        StringBuilder sb = new StringBuilder();
        sb.append("VorteX Axis Quest panel client ").append(version).append('\n');
        sb.append("Device: ").append(device).append('\n');
        AxisLink l = link;
        sb.append("Axis: ").append(linkState()).append(l != null ? " at " + l.pairing().address + " as " + l.pairing().name : "").append('\n');
        sb.append("adb: ").append(adb.state()).append(adb.detail().isEmpty() ? "" : " (" + adb.detail() + ")").append('\n');
        sb.append("Paused: ").append(paused()).append('\n');
        sb.append("Faster looks (--compressed): ").append(commands.compressed ? "on" : "off").append('\n');
        Panel p = commands.lastPanel();
        if (p != null) sb.append("Last panel: ").append(p.window()).append(", ").append(p.nodes).append(" nodes, ").append(p.elements.size()).append(" kept\n");
        PanelCommands.Timing t = commands.lastTiming();
        if (t != null) sb.append("Last look").append(t.compressed ? " (compressed)" : "").append(": ").append(t).append(", ").append(t.bytes).append(" bytes\n");
        sb.append("\nRecently:\n");
        for (String r : recent()) sb.append("  ").append(r).append('\n');
        sb.append("\nLog:\n").append(log.recentText());
        return RollingLog.redact(sb.toString());
    }
}
