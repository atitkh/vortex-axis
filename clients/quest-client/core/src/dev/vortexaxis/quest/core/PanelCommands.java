package dev.vortexaxis.quest.core;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Turns Axis's `desktop.*` commands into adb shell commands on the headset's own adbd and answers in
 * the shapes the Windows app uses (DesktopCommands.cs), so the server and agents need nothing new.
 * Keeps the elements of the last look by id. Refuses everything while the person has paused the
 * app, and looking when Axis's allowLook is off. One command at a time: the adb connection is one.
 */
public final class PanelCommands implements AxisLink.Handler {
    /** Shrinks a PNG to a JPEG; the app does it with android.graphics, tests with javax.imageio. */
    public interface Pictures {
        /** `crop` is {x, y, w, h} in the picture's pixels, or null for all of it. Returns {jpeg, w, h} via Shot. */
        Shot shrink(byte[] png, int maxSide, int[] crop) throws IOException;
    }

    public static final class Shot {
        public final byte[] jpeg;
        public final int w, h;

        public Shot(byte[] jpeg, int w, int h) {
            this.jpeg = jpeg;
            this.w = w;
            this.h = h;
        }
    }

    /** Apps that can be started, with the names a person sees. The app asks Android; without it, adb is asked. */
    public interface Apps {
        List<String[]> launchable(); // {label, package}
    }

    public interface Diary { void did(String what); }

    /** Told when a command starts and ends, for the app's Live view and notification. */
    public interface Doing {
        void started(String what);
        void finished(String what, long ms, boolean ok);
    }

    public static final int MAX_ELEMENTS = 250;
    public static final int MAX_TYPED = 500;
    public static final int MAX_STEPS = 10;
    static final String DUMP = "/data/local/tmp/vortex-axis-panel.xml";
    /** Axis waits 15 s for a look; a dump that takes longer than this is given up, so the agent hears why. */
    static final int DUMP_MS = 10_000;
    /** Reading the dump's file back: a local file of a few hundred kilobytes at most. */
    static final int READ_MS = 4_000;
    static final int ACT_MS = 8_000;
    /** Through the shell, an action's `after` is read this long after it. */
    static final int AFTER_MS = 300;
    /** With the fast engine, the panel is let settle instead: until no accessibility event for QUIET_MS, AFTER_MAX_MS at most. */
    static final int QUIET_MS = 100, AFTER_MAX_MS = 400;
    /** `open` waits for what it started to come to the front, looking every OPEN_STEP_MS (through the shell OPEN_SHELL_STEP_MS), OPEN_MS at most. */
    static final int OPEN_MS = 2000, OPEN_STEP_MS = 100, OPEN_SHELL_STEP_MS = 250;
    /** A package in front read this recently (by a look or the last action) still stands for `before`. */
    static final int FRONT_FRESH_MS = 1000;
    static final String BROWSER = "com.oculus.browser";
    static final int SETTLE_MS = 150;
    /** How long a command waits for the one before it to finish. */
    static final int BUSY_MS = 10_000;

    private final AdbLink adb;
    private final RollingLog log;
    private final String version;
    private volatile Pictures pictures;
    private volatile Apps apps;
    private volatile Diary diary = what -> {};
    private volatile SelfUpdate updater;
    private volatile Helper helper;
    private volatile Doing doing = new Doing() {
        @Override public void started(String what) {}
        @Override public void finished(String what, long ms, boolean ok) {}
    };
    private final ReentrantLock gate = new ReentrantLock();
    private volatile Map<String, Object> settings = new LinkedHashMap<>();
    private List<Panel.Element> last = Collections.emptyList();
    private Panel lastPanel;
    private long lastPanelAt;
    /** The dump's deadline; shortened in tests. */
    int dumpMs = DUMP_MS;
    /** Sleeps between actions; replaced in tests. */
    Sleeper sleeper = ms -> Thread.sleep(ms);
    /** QUIET_MS, shortened in tests (the wait happens in the helper, not through `sleeper`). */
    int quietMs = QUIET_MS;
    /** The package last seen in front, and when. */
    private String lastFront;
    private long lastFrontAt;
    /** In front before the action under way, and what an `open` saw come to the front (null: it did not see it). */
    private String beforeFront, arrived;

    interface Sleeper { void sleep(long ms) throws InterruptedException; }

    /** Set by the person in the app. While true, nothing is read and nothing is done. */
    public volatile boolean paused;

    public PanelCommands(AdbLink adb, RollingLog log, String version) {
        this.adb = adb;
        this.log = log;
        this.version = version;
    }

    public void setPictures(Pictures p) { pictures = p; }
    public void setApps(Apps a) { apps = a; }
    public void setDiary(Diary d) { diary = d == null ? what -> {} : d; }
    public void setUpdater(SelfUpdate u) { updater = u; }
    public void setHelper(Helper h) { helper = h; }
    public void setDoing(Doing d) { if (d != null) doing = d; }

    /** True when this call should try the fast engine first. */
    private boolean fast() {
        Helper h = helper;
        return h != null && h.usable();
    }

    /** The fast engine did not answer: it is restarted later, and this call goes on through the shell. Said once per outage. */
    private void lost(Helper.Lost e) {
        Helper h = helper;
        if (h != null) h.lost(AxisLink.describe(e));
    }

    /**
     * An action the fast engine was asked to do and did not answer: it may have been done, so it is not done again
     * through the shell (a second tap could undo the first).
     */
    private IOException unsure(String what, Helper.Lost e) {
        lost(e);
        return new IOException("the fast engine did not answer while " + what + ", so it may or may not have happened; look again before trying again");
    }
    public void useSettings(Map<String, Object> values) { settings = values == null ? new LinkedHashMap<>() : values; }

    private void did(String what) {
        log.line("did: " + what);
        try { diary.did(what); } catch (RuntimeException ignored) {}
    }

    boolean toggle(String key, boolean fallback) {
        Object v = settings.get(key);
        if (v instanceof Boolean) return (Boolean) v;
        if (v instanceof Number) return ((Number) v).doubleValue() != 0;
        if (v instanceof String) return v.equals("1") || v.equals("true");
        return fallback;
    }

    /** A command's answer, or its failure in words; never throws. */
    @Override public AxisLink.Answer handle(String name, Map<String, Object> p) {
        log.line("command " + name + summary(name, p));
        if (name.equals("update")) {
            // Its download must not hold up agents' commands; it takes the one-at-a-time lock only to use adb.
            SelfUpdate u = updater;
            return u == null ? AxisLink.Answer.fail("not implemented on this device") : u.handle(p, gate);
        }
        boolean locked = false;
        String what = null;
        long started = System.currentTimeMillis();
        boolean ok = false;
        try {
            locked = gate.tryLock(BUSY_MS, TimeUnit.MILLISECONDS);
            if (!locked) return AxisLink.Answer.fail("the headset is still busy with the last command; try again in a moment");
            what = name.startsWith("desktop.") && !paused ? doingWords(name, p) : null;
            if (what != null) try { doing.started(what); } catch (RuntimeException ignored) {}
            AxisLink.Answer answer;
            if (!CHANGES.contains(name)) answer = run(name, p);
            else {
                String before = before();
                beforeFront = before;
                arrived = null;
                answer = withAfter(run(name, p), name, p, before);
            }
            ok = answer.ok;
            return answer;
        } catch (Exception e) {
            String why = AxisLink.describe(e);
            did(name + " failed: " + why);
            return AxisLink.Answer.fail(why);
        } finally {
            if (locked) gate.unlock();
            if (what != null) try { doing.finished(what, System.currentTimeMillis() - started, ok); } catch (RuntimeException ignored) {}
        }
    }

    /** What a command is doing, in words for the person in the headset: "Tapping "Elixir"", "Typing 11 characters". */
    String doingWords(String name, Map<String, Object> p) {
        String target = Json.str(p, "name") != null ? "\"" + clip(Json.str(p, "name"), 40) + "\""
                : Json.integer(p, "id") != null ? "element " + Json.integer(p, "id")
                : Json.integer(p, "x") != null && Json.integer(p, "y") != null ? Json.integer(p, "x") + ", " + Json.integer(p, "y") : null;
        Panel seen;
        synchronized (this) { seen = lastPanel; }
        String panel = seen != null && !seen.pkg.isEmpty() ? Panel.appName(seen.pkg) : "the panel";
        switch (name) {
            case "desktop.look": return "Looking at " + panel;
            case "desktop.find": return "Looking for " + (target != null ? target : "something") + " on " + panel;
            case "desktop.click": return "Tapping " + (target != null ? target : "the panel");
            case "desktop.type": {
                Object t = p.get("text");
                int n = t instanceof String ? ((String) t).length() : 0;
                return "Typing " + n + " character" + (n == 1 ? "" : "s");
            }
            case "desktop.keys": return "Pressing " + clip(or(Json.str(p, "keys"), "a key"), 30);
            case "desktop.scroll": return "Scrolling " + or(Json.str(p, "go"), "down");
            case "desktop.open": return "Opening " + clip(or(Json.str(p, "app"), or(Json.str(p, "url"), "an app")), 40);
            case "desktop.screenshot": return "Taking a picture of " + panel;
            case "desktop.wait": return Json.str(p, "name") != null ? "Waiting for " + target : "Waiting";
            case "desktop.steps": return "Running steps";
            case "desktop.hello": return "Checked from the admin page";
            default: return null;
        }
    }

    /** What the log may say about a command's arguments: never what is typed, only how long it is. */
    static String summary(String name, Map<String, Object> p) {
        if (p == null || p.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(" (");
        for (Map.Entry<String, Object> e : p.entrySet()) {
            if (sb.length() > 2) sb.append(", ");
            Object v = e.getValue();
            if (e.getKey().equals("text") && v instanceof String) sb.append("text: ").append(((String) v).length()).append(" chars");
            else if (e.getKey().equals("data")) sb.append("data");
            else {
                String s = String.valueOf(v);
                sb.append(e.getKey()).append(": ").append(s.length() > 20 ? s.substring(0, 20) + "…" : s);
            }
        }
        return sb.append(')').toString();
    }

    private AxisLink.Answer run(String name, Map<String, Object> p) throws Exception {
        if (name.startsWith("desktop.") && paused)
            return AxisLink.Answer.fail("the person wearing the headset has paused VorteX Axis");
        switch (name) {
            case "desktop.look": {
                if (!toggle("allowLook", true)) return AxisLink.Answer.fail("reading the screen is switched off for this headset");
                String scope = or(Json.str(p, "scope"), "window");
                if (!scope.equals("window") && !scope.equals("mouse") && !scope.equals("screen")) return AxisLink.Answer.fail("scope must be window, mouse or screen");
                long started = System.currentTimeMillis();
                Panel panel = dump();
                List<Panel.Element> elements = pick(panel.elements, MAX_ELEMENTS);
                synchronized (this) { last = elements; }
                did("Looked at " + Panel.appName(panel.pkg) + ": " + elements.size() + " things in " + (System.currentTimeMillis() - started) + " ms");
                return AxisLink.Answer.data(lookData(panel, elements));
            }
            case "desktop.find": {
                if (!toggle("allowLook", true)) return AxisLink.Answer.fail("reading the screen is switched off for this headset");
                String query = or(Json.str(p, "name"), "");
                Panel panel = freshLook();
                List<int[]> found = match(panel.elements, query, Json.str(p, "kind"));
                List<Object> lines = new ArrayList<>();
                for (int i = 0; i < found.size() && i < 5; i++) lines.add(panel.elements.get(found.get(i)[0]).line(found.get(i)[0] + 1));
                did("Looked for \"" + clip(query, 40) + "\": " + lines.size() + " found");
                return AxisLink.Answer.data(Json.obj("matches", lines, "window", panel.window()));
            }
            case "desktop.screenshot":
                return screenshot(p);
            case "desktop.point": {
                Target t = target(p);
                if (t.fail != null) return AxisLink.Answer.fail(t.fail);
                int x, y;
                String label = null;
                if (t.element != null) { x = t.element.cx(); y = t.element.cy(); label = t.element.name; }
                else if (Json.integer(p, "x") != null && Json.integer(p, "y") != null) { x = Json.integer(p, "x"); y = Json.integer(p, "y"); }
                else return AxisLink.Answer.fail("point needs a name, an id, or x and y");
                // No pointer is drawn on a Quest yet: the point is noted, so an agent that points does not fail.
                did("Pointed at " + (label != null ? clip(label, 60) : x + ", " + y) + " (not shown on the headset)");
                Map<String, Object> payload = Json.obj("x", x, "y", y);
                if (label != null) payload.put("name", clip(label, 200));
                payload.put("shown", false);
                return AxisLink.Answer.done(payload);
            }
            case "desktop.hide":
                return AxisLink.Answer.done();
            case "desktop.wait": {
                if (Json.str(p, "name") != null || Json.str(p, "window") != null) return waitFor(p);
                Integer ms = Json.integer(p, "ms");
                sleeper.sleep(clamp(ms == null ? 500 : ms, 50, 3000));
                return AxisLink.Answer.done();
            }
            case "desktop.steps":
                return steps(p);
            case "desktop.click": case "desktop.type": case "desktop.keys": case "desktop.open": case "desktop.scroll":
                return act(name, p);
            case "desktop.switch":
                return AxisLink.Answer.fail("switch is not available on a Quest: the app sees only the panel in front. Use open with the app's name to bring it forward");
            case "desktop.window":
                return AxisLink.Answer.fail("window is not available on a Quest: panels cannot be minimized, maximized or moved from here");
            case "desktop.desktop":
                return AxisLink.Answer.fail("there are no virtual desktops on a Quest");
            case "desktop.clipboard":
                return AxisLink.Answer.fail("reading the clipboard is not available on a Quest");
            case "desktop.paste":
                return AxisLink.Answer.fail("paste is not available on a Quest; use type (up to 500 plain ASCII characters at a time)");
            case "desktop.hello": {
                // The admin page's "Check the headset": proof the app is there and can reach adb.
                String adbSays;
                try {
                    adb.shell("echo ok", 3000);
                    adbSays = "ready";
                } catch (IOException e) {
                    adbSays = adb.problem();
                }
                did("Checked from the admin page: adb " + ("ready".equals(adbSays) ? "ready" : "not ready"));
                return AxisLink.Answer.done(Json.obj(
                        "platform", QuestIdentity.TYPE,
                        "version", version,
                        "adb", clip(adbSays, 200),
                        "panel", Panel.WIDTH + "x" + Panel.HEIGHT,
                        "engine", engineWord(),
                        "unsupported", "switch, window, desktop, clipboard, paste; point is noted but not drawn"));
            }
            default:
                return AxisLink.Answer.fail("not implemented on this device");
        }
    }

    // ---- reading the panel ---------------------------------------------------

    /** Where the time of one look went, for the app's Test button and the diagnostics. */
    public static final class Timing {
        /** The look came from the fast engine (its dump), not uiautomator. */
        public final boolean fast;
        public final boolean compressed;
        public final long connectMs, dumpMs, readMs, parseMs, totalMs;
        public final int nodes, kept, bytes;

        Timing(boolean compressed, long connectMs, long dumpMs, long readMs, long parseMs, long totalMs, int nodes, int kept, int bytes) {
            this(false, compressed, connectMs, dumpMs, readMs, parseMs, totalMs, nodes, kept, bytes);
        }

        Timing(boolean fast, boolean compressed, long connectMs, long dumpMs, long readMs, long parseMs, long totalMs, int nodes, int kept, int bytes) {
            this.fast = fast;
            this.compressed = compressed;
            this.connectMs = connectMs;
            this.dumpMs = dumpMs;
            this.readMs = readMs;
            this.parseMs = parseMs;
            this.totalMs = totalMs;
            this.nodes = nodes;
            this.kept = kept;
            this.bytes = bytes;
        }

        /** "294 nodes, 25 kept; dump 4100 ms, read 80 ms, parse 40 ms, total 4230 ms" (adb connect first when there was one). */
        @Override public String toString() {
            if (fast) return nodes + " nodes, " + kept + " kept; fast dump " + dumpMs + " ms, parse " + parseMs + " ms, total " + totalMs + " ms";
            return nodes + " nodes, " + kept + " kept; " + (connectMs > 0 ? "adb connect " + connectMs + " ms, " : "")
                    + "dump " + dumpMs + " ms, read " + readMs + " ms, parse " + parseMs + " ms, total " + totalMs + " ms";
        }
    }

    /**
     * "Faster looks": `uiautomator dump --compressed`, which leaves out nodes it thinks unimportant (it
     * may hide some an agent needs). Off unless the person switches it on in the app.
     */
    public volatile boolean compressed;
    private volatile Timing lastTiming;

    /** A dump of the panel in front, read back and parsed. One retry when the panel was mid-animation or adb dropped. */
    Panel dump() throws IOException, InterruptedException {
        return dump(compressed);
    }

    Panel dump(boolean compressed) throws IOException, InterruptedException {
        if (fast()) {
            try {
                return fastDump();
            } catch (Helper.Lost e) {
                lost(e);
            } catch (Helper.Failed e) {
                log.line("look: the fast engine could not read the panel (" + e.getMessage() + "); with uiautomator this once");
            }
        }
        return shellDump(compressed);
    }

    /** The panel from the fast engine: one call, parsed into the same tree a uiautomator dump gives. */
    private Panel fastDump() throws IOException {
        long started = System.currentTimeMillis();
        Map<String, Object> got = helper.call("dump", Json.obj("maxNodes", HelperRouter.MAX_NODES, "idleMs", FAST_IDLE_MS), dumpMs);
        long t = System.currentTimeMillis();
        Panel panel;
        try {
            panel = Panel.fromHelper(got);
        } catch (IllegalArgumentException e) {
            throw new Helper.Failed(HelperProtocol.FAILED, e.getMessage());
        }
        long now = System.currentTimeMillis();
        Timing timing = new Timing(true, false, 0, t - started, 0, now - t, now - started, panel.nodes, panel.elements.size(), 0);
        lastTiming = timing;
        log.line("look: fast dump of " + panel.window() + ": " + timing);
        synchronized (this) {
            lastPanel = panel;
            lastPanelAt = System.currentTimeMillis();
            if (!panel.pkg.isEmpty()) { lastFront = panel.pkg; lastFrontAt = lastPanelAt; }
        }
        return panel;
    }

    /** How long the fast engine lets the panel settle before reading it (uiautomator waits for idle too, much longer). */
    static final int FAST_IDLE_MS = 300;

    Panel shellDump(boolean compressed) throws IOException, InterruptedException {
        IOException last = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            long started = System.currentTimeMillis();
            long connectMs = 0, dumpMs, readMs;
            String out;
            try {
                connectMs = adb.ensure();
                long t = System.currentTimeMillis();
                // Two calls, so the time uiautomator takes is told apart from reading its file back.
                String said = adb.shell("rm -f " + DUMP + "; uiautomator dump" + (compressed ? " --compressed " : " ") + DUMP, this.dumpMs);
                dumpMs = System.currentTimeMillis() - t;
                t = System.currentTimeMillis();
                out = adb.shell("cat " + DUMP + "; rm -f " + DUMP, READ_MS);
                readMs = System.currentTimeMillis() - t;
                if (Panel.extractXml(out) == null) out = said + "\n" + out;
            } catch (AdbClient.TimeoutException e) {
                throw new IOException("reading the panel took longer than " + seconds(this.dumpMs) + " s (uiautomator did not finish); try again");
            } catch (IOException e) {
                last = e;
                if (adb.ready() || attempt > 0) throw e;
                log.line("look: adb dropped (" + AxisLink.describe(e) + "), connecting again");
                continue;
            }
            String xml = Panel.extractXml(out);
            if (xml == null) {
                String said = out.trim();
                int nl = said.indexOf('\n');
                if (nl > 0) said = said.substring(0, nl);
                last = new IOException("the panel could not be read: " + (said.isEmpty() ? "uiautomator printed nothing" : clip(said, 160)));
                if (attempt == 0) {
                    sleeper.sleep(300);
                    continue;
                }
                throw last;
            }
            long t = System.currentTimeMillis();
            Panel panel = Panel.parse(xml);
            long now = System.currentTimeMillis();
            Timing timing = new Timing(compressed, connectMs, dumpMs, readMs, now - t, now - started, panel.nodes, panel.elements.size(), xml.length());
            lastTiming = timing;
            log.line("look: " + (compressed ? "compressed " : "") + "dump of " + panel.window() + ": " + timing + ", " + xml.length() + " bytes");
            synchronized (this) {
                lastPanel = panel;
                lastPanelAt = System.currentTimeMillis();
            }
            return panel;
        }
        throw last;
    }

    /** How the last look went, or null before the first. */
    public Timing lastTiming() { return lastTiming; }

    /** The panel read afresh, every element kept (not just the 250 a look sends), for finding by name. */
    private Panel freshLook() throws IOException, InterruptedException {
        Panel panel = dump();
        synchronized (this) { last = panel.elements; }
        return panel;
    }

    /** Told with every look: the panel, and how to spend less time (one line, at most 200 characters). */
    static final String DEVICE_HINT = "Quest panel: coordinates are the panel's; one panel is seen at a time. Actions answer with after: no need to look again to check. "
            + "To wait, use wait with a name (returns once it shows), not ms";

    static Map<String, Object> lookData(Panel panel, List<Panel.Element> elements) {
        List<Object> lines = new ArrayList<>();
        for (int i = 0; i < elements.size(); i++) lines.add(elements.get(i).line(i + 1));
        Map<String, Object> data = Json.obj(
                "screen", "0,0 " + panel.width + "x" + panel.height,
                "window", panel.window() + " 0,0 " + panel.width + "x" + panel.height,
                "device", DEVICE_HINT);
        data.put("elements", lines);
        if (panel.elements.size() > elements.size()) data.put("more", panel.elements.size() - elements.size());
        return data;
    }

    private static final Set<String> ACTIONABLE = new HashSet<>(Arrays.asList(
            "button", "edit", "hyperlink", "menuitem", "checkbox", "radiobutton", "combobox", "tabitem", "listitem",
            "treeitem", "slider", "spinner", "splitbutton", "menubaritem", "dataitem", "password", "document", "switch"));

    /** The `max` elements most worth sending, in panel order: what has the focus, then things that can be used, then the rest. */
    static List<Panel.Element> pick(List<Panel.Element> all, int max) {
        if (all.size() <= max) return new ArrayList<>(all);
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < all.size(); i++) order.add(i);
        order.sort(Comparator.comparingInt((Integer i) -> {
            Panel.Element e = all.get(i);
            return e.focused ? 0 : ACTIONABLE.contains(e.kind) || e.scrollable ? 1 : 2;
        }).thenComparingInt(i -> i));
        List<Integer> kept = new ArrayList<>(order.subList(0, max));
        Collections.sort(kept);
        List<Panel.Element> out = new ArrayList<>();
        for (int i : kept) out.add(all.get(i));
        return out;
    }

    static String norm(String s) {
        String t = String.join(" ", s.toLowerCase(Locale.ROOT).trim().split("\\s+"));
        int a = 0, b = t.length();
        while (a < b && ".…: ".indexOf(t.charAt(a)) >= 0) a++;
        while (b > a && ".…: ".indexOf(t.charAt(b - 1)) >= 0) b--;
        return t.substring(a, b);
    }

    /** Elements whose name fits `query`, best first, as {index, score}: the Windows app's scoring, unchanged. */
    static List<int[]> match(List<Panel.Element> all, String query, String kind) {
        String q = norm(query);
        List<int[]> found = new ArrayList<>();
        if (q.isEmpty()) return found;
        String[] words = q.split(" ");
        String k = kind == null ? null : kind.toLowerCase(Locale.ROOT);
        for (int i = 0; i < all.size(); i++) {
            Panel.Element e = all.get(i);
            String n = norm(e.name);
            if (n.isEmpty()) continue;
            int score = n.equals(q) ? 100
                    : n.startsWith(q + " ") || (n.startsWith(q) && q.length() >= 3) ? 85
                    : n.contains(" " + q) ? 75
                    : q.length() >= 3 && n.contains(q) ? 65
                    : words.length > 1 && allIn(words, n) ? 55
                    : 0;
            if (score == 0) continue;
            if (ACTIONABLE.contains(e.kind)) score += 8;
            if (k != null && e.kind.equals(k)) score += 12;
            if (e.kind.equals("window") || e.kind.equals("pane") || e.kind.equals("group") || e.kind.equals("document")) score -= 15;
            found.add(new int[] {i, score});
        }
        found.sort((a, b) -> b[1] - a[1]);
        return found;
    }

    private static boolean allIn(String[] words, String n) {
        for (String w : words) if (!n.contains(w)) return false;
        return true;
    }

    private static final class Target {
        final Panel.Element element;
        final String fail;

        Target(Panel.Element element, String fail) {
            this.element = element;
            this.fail = fail;
        }
    }

    /**
     * The element a command means: `id` from the last look or find, or `name` (with `kind`) matched in a
     * fresh look. Neither: no element and no failure. A name that matches nothing, or several equally,
     * fails with what was found.
     */
    private Target target(Map<String, Object> p) throws IOException, InterruptedException {
        Integer id = Json.integer(p, "id");
        if (id != null) {
            Panel.Element e;
            synchronized (this) { e = id >= 1 && id <= last.size() ? last.get(id - 1) : null; }
            return e == null ? new Target(null, "no element " + id + " in the last look; look again") : new Target(e, null);
        }
        String query = Json.str(p, "name");
        if (query == null) return new Target(null, null);
        Panel panel = freshLook();
        List<int[]> matches = match(panel.elements, query, Json.str(p, "kind"));
        if (matches.isEmpty()) return new Target(null, "nothing called \"" + query + "\" on the panel in front (" + panel.window() + "); try find or look");
        int top = matches.get(0)[1];
        List<int[]> tied = new ArrayList<>();
        for (int[] m : matches) if (m[1] == top) tied.add(m);
        if (tied.size() > 1 && !nested(panel.elements, tied)) {
            StringBuilder which = new StringBuilder();
            for (int i = 0; i < tied.size() && i < 5; i++) {
                Panel.Element e = panel.elements.get(tied.get(i)[0]);
                if (i > 0) which.append("; ");
                which.append("id ").append(tied.get(i)[0] + 1).append(": ").append(e.kind).append(" \"").append(clip(e.name, 40)).append('"');
            }
            return new Target(null, "\"" + query + "\" matches " + tied.size() + " things equally (" + which + "); use one of the ids");
        }
        int[] chosen = tied.get(0);
        // Several the same, one inside another (a tile and its own label): the innermost.
        for (int[] m : tied) if (area(panel.elements.get(m[0])) < area(panel.elements.get(chosen[0]))) chosen = m;
        return new Target(panel.elements.get(chosen[0]), null);
    }

    private static long area(Panel.Element e) { return (long) e.w * e.h; }

    private static boolean nested(List<Panel.Element> all, List<int[]> tied) {
        Panel.Element inner = all.get(tied.get(0)[0]);
        for (int[] m : tied) if (area(all.get(m[0])) < area(inner)) inner = all.get(m[0]);
        for (int[] m : tied) {
            Panel.Element e = all.get(m[0]);
            if (!(inner.x >= e.x && inner.y >= e.y && inner.x + inner.w <= e.x + e.w && inner.y + inner.h <= e.y + e.h)) return false;
        }
        return true;
    }

    // ---- acting ----------------------------------------------------------------

    private static final Set<String> CHANGES = new HashSet<>(Arrays.asList(
            "desktop.click", "desktop.type", "desktop.keys", "desktop.open", "desktop.steps", "desktop.scroll"));

    /** Everything that changes the panel: refused when Axis's allowInput is off for this headset. */
    private AxisLink.Answer act(String name, Map<String, Object> p) throws Exception {
        if (!toggle("allowInput", true)) return AxisLink.Answer.fail("tapping and typing are switched off for this headset");
        switch (name) {
            case "desktop.click": {
                Target t = target(p);
                if (t.fail != null) return AxisLink.Answer.fail(t.fail);
                int x, y;
                if (t.element != null) { x = t.element.cx(); y = t.element.cy(); }
                else if (Json.integer(p, "x") != null && Json.integer(p, "y") != null) { x = Json.integer(p, "x"); y = Json.integer(p, "y"); }
                else return AxisLink.Answer.fail("click needs a name, an id, or x and y");
                if (x < 0 || y < 0 || x >= Panel.WIDTH || y >= Panel.HEIGHT)
                    return AxisLink.Answer.fail("(" + x + ", " + y + ") is outside the panel (0,0 " + Panel.WIDTH + "x" + Panel.HEIGHT + ")");
                String button = or(Json.str(p, "button"), "left");
                String command, how, said;
                switch (button) {
                    case "left": command = "input tap " + x + " " + y; how = "tap"; said = "Tapped"; break;
                    case "double": command = "input tap " + x + " " + y + " && input tap " + x + " " + y; how = "double tap"; said = "Double-tapped"; break;
                    // A long press is what a right click is on a touch panel: it opens the menu, if there is one.
                    case "right": command = "input swipe " + x + " " + y + " " + x + " " + y + " 800"; how = "long press"; said = "Long-pressed"; break;
                    default: return AxisLink.Answer.fail("button must be left, right or double, not " + button);
                }
                if (!fastClick(t.element, x, y, button)) checkQuiet(adb.shell(command, ACT_MS));
                did(said + " " + (t.element != null ? "\"" + clip(t.element.name, 60) + "\"" : x + ", " + y));
                Map<String, Object> payload = Json.obj("x", x, "y", y, "how", how);
                if (t.element != null) payload.put("name", clip(t.element.name, 200));
                return AxisLink.Answer.done(payload);
            }
            case "desktop.type": {
                Object raw = p.get("text");
                String text = raw instanceof String ? (String) raw : "";
                if (text.isEmpty()) return AxisLink.Answer.fail("type needs text");
                if (text.length() > MAX_TYPED) return AxisLink.Answer.fail("at most " + MAX_TYPED + " characters at a time");
                // The shell types plain ASCII only; the fast engine any text. Control characters, never.
                List<String> commands = null;
                String shellCannot = null;
                try {
                    commands = Shell.typeCommands(text);
                } catch (IllegalArgumentException e) {
                    shellCannot = e.getMessage();
                }
                if (shellCannot != null && !fast()) return AxisLink.Answer.fail(shellCannot);
                for (int i = 0; i < text.length(); i++) {
                    char c = text.charAt(i);
                    if ((c < 0x20 && c != '\n' && c != '\t' && c != '\r') || c == 0x7f) return AxisLink.Answer.fail("the text has a control character, which cannot be typed");
                }
                Target t = target(p);
                if (t.fail != null) return AxisLink.Answer.fail(t.fail);
                if (t.element != null) {
                    if (t.element.password || t.element.kind.equals("password")) return AxisLink.Answer.fail("the app never types into a password field");
                } else {
                    // Typing blind into whatever has the focus: it must not be a password field. Asked of the fast
                    // engine cheaply; when it cannot say, the whole panel is read as before.
                    Boolean pw = fastPasswordFocused();
                    if (pw == null) pw = dump().passwordFocused;
                    if (pw) return AxisLink.Answer.fail("the app never types into a password field (one has the focus)");
                }
                String typedFast = fastType(t.element, text);
                if (typedFast != null) return AxisLink.Answer.fail(typedFast);
                if (!typedFastDone) {
                    if (shellCannot != null) return AxisLink.Answer.fail(shellCannot);
                    if (t.element != null) {
                        // Tapping the field gives it the focus.
                        checkQuiet(adb.shell("input tap " + t.element.cx() + " " + t.element.cy(), ACT_MS));
                        sleeper.sleep(AFTER_MS);
                    }
                    checkQuiet(adb.shell(String.join(" && ", commands), 15_000));
                }
                did("Typed " + text.length() + " characters" + (t.element != null ? " into \"" + clip(t.element.name, 60) + "\"" : ""));
                Map<String, Object> payload = Json.obj("typed", text.length());
                if (t.element != null) payload.put("into", clip(t.element.name, 200));
                return AxisLink.Answer.done(payload);
            }
            case "desktop.keys": {
                Keys combo;
                try {
                    combo = Keys.parse(or(Json.str(p, "keys"), ""));
                } catch (Keys.Refused r) {
                    did("Refused to press " + r.key);
                    return AxisLink.Answer.fail(r.getMessage());
                } catch (IllegalArgumentException e) {
                    return AxisLink.Answer.fail(e.getMessage());
                }
                if (fastKey(combo)) {
                    did("Pressed " + combo);
                    return AxisLink.Answer.done(Json.obj("pressed", combo.toString()));
                }
                String out = adb.shell(combo.command(), ACT_MS);
                if (combo.combination() && looksLikeError(out))
                    return AxisLink.Answer.fail("this headset cannot press key combinations (" + combo + "): its input command has no keycombination; single keys work");
                checkQuiet(out);
                did("Pressed " + combo);
                return AxisLink.Answer.done(Json.obj("pressed", combo.toString()));
            }
            case "desktop.open":
                return open(p);
            case "desktop.scroll":
                return scroll(p);
            default:
                return AxisLink.Answer.fail("not implemented on this device");
        }
    }

    /** `input` and `am` print nothing when they work; anything that reads like an error is one. */
    static boolean looksLikeError(String out) {
        String o = out.toLowerCase(Locale.ROOT);
        return o.contains("error") || o.contains("exception") || o.contains("usage:") || o.contains("unknown command") || o.contains("not found") || o.contains("permission denial");
    }

    private static void checkQuiet(String out) throws IOException {
        if (looksLikeError(out)) {
            String first = out.trim();
            int nl = first.indexOf('\n');
            if (nl > 0) first = first.substring(0, nl);
            throw new IOException("the headset said: " + clip(first, 160));
        }
    }

    private AxisLink.Answer open(Map<String, Object> p) throws IOException, InterruptedException {
        String url = Json.str(p, "url"), app = Json.str(p, "app");
        if ((url == null) == (app == null)) return AxisLink.Answer.fail("open needs app or url");
        if (url != null) {
            try {
                url = Shell.checkUrl(url);
            } catch (IllegalArgumentException e) {
                return AxisLink.Answer.fail(e.getMessage());
            }
            checkQuiet(adb.shell("am start -a android.intent.action.VIEW -d " + Shell.quote(url), ACT_MS));
            awaitFront(BROWSER, true);
            did("Opened " + clip(url, 60));
            return AxisLink.Answer.done(Json.obj("opened", clip(url, 200)));
        }
        String q = norm(app);
        if (q.equals("settings")) {
            checkQuiet(adb.shell("am start -a android.settings.SETTINGS", ACT_MS));
            awaitFront(null, true);
            did("Opened Settings");
            return AxisLink.Answer.done(Json.obj("opened", "Settings"));
        }
        String[] best = null;
        int bestScore = 0;
        for (String[] a : launchable()) {
            int s = Math.max(score(a[0], app), score(Panel.appName(a[1]), app));
            if (q.equals("browser") && a[1].equals("com.oculus.browser")) s = 100;
            if (s > bestScore) { best = a; bestScore = s; }
        }
        if (best == null) return AxisLink.Answer.fail("no app called \"" + app + "\" is installed on the headset");
        if (!Shell.isPackage(best[1])) return AxisLink.Answer.fail("\"" + best[1] + "\" is not a package name this will start");
        String out = adb.shell("monkey -p " + best[1] + " -c android.intent.category.LAUNCHER 1", ACT_MS);
        if (out.contains("No activities found") || out.contains("monkey aborted")) return AxisLink.Answer.fail(best[0] + " (" + best[1] + ") has nothing to start");
        awaitFront(best[1], false);
        did("Opened " + clip(best[0], 60));
        return AxisLink.Answer.done(Json.obj("opened", clip(best[0], 120) + " (" + best[1] + ")"));
    }

    /**
     * Waits for what was just started to come to the front: `pkg`, or with `loose` (an address may open in another
     * app than the Browser) any other package than was in front before, looking every OPEN_STEP_MS with the fast engine and OPEN_SHELL_STEP_MS through the shell,
     * OPEN_MS at most. What it saw is the answer's `after`; when it did not come, `after` is read as for any action.
     */
    private void awaitFront(String pkg, boolean loose) throws InterruptedException {
        long end = System.currentTimeMillis() + OPEN_MS;
        String was = beforeFront;
        for (int waited = 0; waited < OPEN_MS && System.currentTimeMillis() < end; ) {
            boolean quick = fast();
            int step = quick ? OPEN_STEP_MS : OPEN_SHELL_STEP_MS;
            sleeper.sleep(step);
            waited += step;
            String now = quick ? fastFront(0) : foreground();
            if (now != null && (now.equals(pkg) || (loose && was != null && !now.equals(was)))) {
                arrived = now;
                return;
            }
        }
    }

    /** Apps to start: from Android with their labels when the app gave a list, else the packages adb lists. */
    private List<String[]> launchable() throws IOException {
        Apps a = apps;
        if (a != null) {
            List<String[]> list = a.launchable();
            if (list != null && !list.isEmpty()) return list;
        }
        String out = adb.shell("cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER", ACT_MS);
        List<String[]> list = new ArrayList<>();
        Matcher m = Pattern.compile("(?m)^\\s*([A-Za-z][A-Za-z0-9_.]*)/").matcher(out);
        Set<String> seen = new HashSet<>();
        while (m.find()) if (seen.add(m.group(1))) list.add(new String[] {Panel.appName(m.group(1)), m.group(1)});
        return list;
    }

    /** How well a name fits what someone asked for, 0 for not at all (the Windows app's Fuzzy.Score). */
    static int score(String name, String query) {
        String n = norm(name), q = norm(query);
        if (n.isEmpty() || q.isEmpty()) return 0;
        if (n.equals(q)) return 100;
        if (n.startsWith(q)) return 85;
        if (n.contains(" " + q)) return 75;
        if (q.length() >= 3 && n.contains(q)) return 65;
        String[] words = q.split(" ");
        return words.length > 1 && allIn(words, n) ? 55 : 0;
    }

    private AxisLink.Answer scroll(Map<String, Object> p) throws Exception {
        String go = or(Json.str(p, "go"), "down");
        if (!Arrays.asList("up", "down", "left", "right", "top", "bottom").contains(go)) return AxisLink.Answer.fail("scroll needs go: up, down, left, right, top or bottom");
        Integer pg = Json.integer(p, "pages");
        int pages = clamp(pg == null ? 1 : pg, 1, 10);
        Target t = target(p);
        if (t.fail != null) return AxisLink.Answer.fail(t.fail);
        boolean sideways = go.equals("left") || go.equals("right");
        Panel.Element box = t.element;
        if (box == null) {
            // The biggest list of the last look that scrolls that way, else the panel.
            synchronized (this) {
                for (Panel.Element e : last) {
                    if (!e.scrollable || ("sideways".equals(e.scrollsWay) != sideways)) continue;
                    if (box == null || area(e) > area(box)) box = e;
                }
            }
        }
        int x = 0, y = 0, w = Panel.WIDTH, h = Panel.HEIGHT;
        if (box != null) { x = box.x; y = box.y; w = box.w; h = box.h; }
        int cx = x + w / 2, cy = y + h / 2;
        // A swipe from three quarters to a quarter of the box moves its content about half the box.
        int fromX = cx, fromY = cy, toX = cx, toY = cy;
        switch (go) {
            case "down": case "bottom": fromY = y + h * 3 / 4; toY = y + h / 4; break;
            case "up": case "top": fromY = y + h / 4; toY = y + h * 3 / 4; break;
            case "right": fromX = x + w * 3 / 4; toX = x + w / 4; break;
            default: fromX = x + w / 4; toX = x + w * 3 / 4; break;
        }
        boolean far = go.equals("top") || go.equals("bottom");
        int times = far ? 8 : pages;
        String how = fastScroll(box, go.equals("down") || go.equals("bottom") || go.equals("right"), times, new int[] {fromX, fromY, toX, toY, far ? 120 : 400});
        if (how == null) {
            String one = "input swipe " + fromX + " " + fromY + " " + toX + " " + toY + " " + (far ? 120 : 400);
            List<String> all = new ArrayList<>();
            for (int i = 0; i < times; i++) all.add(one);
            checkQuiet(adb.shell(String.join(" && ", all), 15_000));
            how = "swipe";
        }
        String in = t.element != null ? t.element.name : box != null ? box.name : null;
        did("Scrolled " + go + (far ? "" : " " + pages + " page" + (pages == 1 ? "" : "s")) + (in != null && !in.isEmpty() ? " in " + clip(in, 40) : ""));
        Map<String, Object> payload = Json.obj("scrolled", go, "how", how);
        if (in != null && !in.isEmpty()) payload.put("in", clip(in, 200));
        return AxisLink.Answer.done(payload);
    }

    private AxisLink.Answer screenshot(Map<String, Object> p) throws Exception {
        if (!toggle("allowScreenshot", false)) return AxisLink.Answer.fail("screenshots are switched off for this headset (admin page, the headset's settings)");
        String scope = or(Json.str(p, "scope"), "window");
        if (!scope.equals("window") && !scope.equals("screen")) return AxisLink.Answer.fail("scope must be window or screen");
        Integer side = SHOT_SIDES.get(or(Json.str(p, "detail"), "normal"));
        if (side == null) return AxisLink.Answer.fail("detail must be low, normal or high");
        Panel.Element region = null;
        Integer id = Json.integer(p, "id");
        if (id != null) {
            synchronized (this) { region = id >= 1 && id <= last.size() ? last.get(id - 1) : null; }
            if (region == null) return AxisLink.Answer.fail("no element " + id + " in the last look; look or find again");
        }
        Pictures pics = pictures;
        if (pics == null) return AxisLink.Answer.fail("this build of the app cannot make pictures");
        // Never while a password field has the focus: read the panel again unless it was read a moment ago.
        Panel panel;
        synchronized (this) { panel = System.currentTimeMillis() - lastPanelAt < 3000 ? lastPanel : null; }
        if (panel == null) panel = dump();
        if (panel.passwordFocused) return AxisLink.Answer.fail("no screenshot while a password field has the focus");
        int[] crop = null;
        if (region != null) {
            int m = 40;
            crop = new int[] {Math.max(0, region.x - m), Math.max(0, region.y - m), region.w + 2 * m, region.h + 2 * m};
        }
        Shot shot = fastShot(side, crop);
        if (shot == null) shot = shellShot(pics, side, crop);
        did("Took a " + shot.w + "x" + shot.h + " picture of " + (region != null ? clip(region.name, 40) : Panel.appName(panel.pkg)));
        Map<String, Object> data = Json.obj(
                "image", Json.obj("data", Base64.getEncoder().encodeToString(shot.jpeg), "mimeType", "image/jpeg"),
                "picture", shot.w + "x" + shot.h + (crop != null ? " of " + crop[0] + "," + crop[1] + " " + crop[2] + "x" + crop[3] : " of the panel"),
                "window", panel.window());
        return AxisLink.Answer.data(data);
    }

    /** screencap through the shell, shrunk by the app. */
    private Shot shellShot(Pictures pics, int side, int[] crop) throws IOException {
        byte[] png;
        try {
            png = adb.shellBytes("screencap -p", dumpMs);
        } catch (AdbClient.TimeoutException e) {
            throw new IOException("the picture took longer than " + seconds(dumpMs) + " s; try again");
        }
        if (png.length < 8 || (png[0] & 0xff) != 0x89 || png[1] != 'P') throw new IOException("screencap did not give a picture" + (png.length < 200 ? ": " + clip(new String(png, java.nio.charset.StandardCharsets.UTF_8).trim(), 120) : ""));
        return pics.shrink(png, side, crop);
    }

    // ---- the fast engine's ways, each falling back to the shell -----------------

    /** Taps, double-taps or long-presses through the fast engine: by the element's handle when it has one. False: do it through the shell. */
    private boolean fastClick(Panel.Element e, int x, int y, String button) throws IOException {
        if (!fast()) return false;
        try {
            boolean byHandle = e != null && e.handle >= 0 && !button.equals("double");
            if (byHandle) {
                try {
                    helper.call(button.equals("right") ? "longClick" : "click", Json.obj("handle", e.handle), ACT_MS);
                    return true;
                } catch (Helper.Failed f) {
                    if (!HelperProtocol.STALE.equals(f.code)) throw f;
                    // Gone since the look: where it was is still where the agent meant.
                }
            }
            if (button.equals("right")) helper.call("longPress", Json.obj("x", x, "y", y), ACT_MS);
            else {
                helper.call("tap", Json.obj("x", x, "y", y), ACT_MS);
                if (button.equals("double")) helper.call("tap", Json.obj("x", x, "y", y), ACT_MS);
            }
            return true;
        } catch (Helper.Lost l) {
            if (l.sent) throw unsure("tapping", l);
            lost(l);
            return false;
        } catch (Helper.Failed f) {
            log.line("click: the fast engine could not (" + f.getMessage() + "); through the shell");
            return false;
        }
    }

    /** Whether a password field has the input focus, from the fast engine's `focus` (no dump); null when it cannot tell. */
    private Boolean fastPasswordFocused() {
        if (!fast()) return null;
        try {
            Map<String, Object> r = helper.call("focus", Json.obj(), ACT_MS);
            return Json.isTrue(r, "found") && Json.isTrue(r, "password");
        } catch (Helper.Lost l) {
            lost(l);
        } catch (IOException e) {
            log.line("type: the fast engine could not tell what has the focus (" + e.getMessage() + "); reading the panel");
        }
        return null;
    }

    /** Set by fastType when it typed everything. */
    private boolean typedFastDone;

    /**
     * Types through the fast engine (any text): into the element by its handle, else into the focus; a newline is
     * Enter and a tab is Tab, as through the shell. Sets typedFastDone when it typed; returns a refusal for the agent,
     * or null. When it could not start, the shell types instead (plain ASCII only).
     */
    private String fastType(Panel.Element e, String text) throws IOException {
        typedFastDone = false;
        if (!fast()) return null;
        boolean begun = false;
        try {
            StringBuilder part = new StringBuilder();
            boolean first = true;
            for (int i = 0; i <= text.length(); i++) {
                char c = i < text.length() ? text.charAt(i) : '\n';
                if (c == '\r') continue;
                if (c != '\n' && c != '\t') {
                    part.append(c);
                    continue;
                }
                if (part.length() > 0) {
                    Map<String, Object> req = Json.obj("text", part.toString());
                    // The field by its handle the first time; then where the focus is (Enter may have moved it).
                    if (first && e != null && e.handle >= 0) req.put("handle", e.handle);
                    else if (first && e != null) {
                        helper.call("tap", Json.obj("x", e.cx(), "y", e.cy()), ACT_MS);
                        sleeper.sleep(AFTER_MS);
                    }
                    try {
                        helper.call("setText", req, 15_000);
                    } catch (Helper.Failed f) {
                        if (!begun && HelperProtocol.STALE.equals(f.code) && e != null) {
                            helper.call("tap", Json.obj("x", e.cx(), "y", e.cy()), ACT_MS);
                            sleeper.sleep(AFTER_MS);
                            helper.call("setText", Json.obj("text", part.toString()), 15_000);
                        } else throw f;
                    }
                    begun = true;
                    first = false;
                    part.setLength(0);
                } else if (first && e != null && i < text.length()) {
                    // A newline first: the field gets the focus before the key.
                    if (e.handle >= 0) helper.call("click", Json.obj("handle", e.handle), ACT_MS);
                    else helper.call("tap", Json.obj("x", e.cx(), "y", e.cy()), ACT_MS);
                    first = false;
                }
                if (i < text.length()) {
                    helper.call("key", Json.obj("code", c == '\n' ? Keys.ENTER : Keys.TAB), ACT_MS);
                    begun = true;
                }
            }
            typedFastDone = true;
            return null;
        } catch (Helper.Failed f) {
            if (HelperProtocol.PASSWORD.equals(f.code)) return "the app never types into a password field" + (e == null ? " (one has the focus)" : "");
            if (begun) throw new IOException("typing stopped part way: " + f.getMessage() + "; look before typing again");
            log.line("type: the fast engine could not (" + f.getMessage() + "); through the shell");
            return null;
        } catch (Helper.Lost l) {
            if (l.sent || begun) throw unsure("typing", l);
            lost(l);
            return null;
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while typing");
        }
    }

    /** A key through the fast engine: Back as the system's Back, others injected with their modifiers (no keycombination needed). False: through the shell. */
    private boolean fastKey(Keys combo) throws IOException {
        if (!fast()) return false;
        try {
            if (combo.code == 4 && !combo.combination()) helper.call("back", Json.obj(), ACT_MS);
            else helper.call("key", Json.obj("code", combo.code, "ctrl", combo.ctrl, "alt", combo.alt, "shift", combo.shift), ACT_MS);
            return true;
        } catch (Helper.Lost l) {
            if (l.sent) throw unsure("pressing " + combo, l);
            lost(l);
            return false;
        } catch (Helper.Failed f) {
            log.line("keys: the fast engine could not (" + f.getMessage() + "); through the shell");
            return false;
        }
    }

    /**
     * Scrolls through the fast engine: the list's own scrolling by its handle ("scroll"), page by page until it will
     * go no further, else the same swipes the shell would make ("swipe"). Null: through the shell.
     */
    private String fastScroll(Panel.Element box, boolean forward, int times, int[] swipe) throws IOException {
        if (!fast()) return null;
        boolean begun = false;
        try {
            if (box != null && box.handle >= 0 && box.scrollable) {
                try {
                    for (int i = 0; i < times; i++) {
                        Map<String, Object> r = helper.call("scroll", Json.obj("handle", box.handle, "forward", forward), ACT_MS);
                        begun = true;
                        if (!Json.isTrue(r, "moved")) break;
                        if (i + 1 < times) sleeper.sleep(SETTLE_MS);
                    }
                    if (begun) return "scroll";
                } catch (Helper.Failed f) {
                    if (begun) return "scroll";
                    // Stale, or a list that does not take scrolling from accessibility: swipe as a person would.
                }
            }
            for (int i = 0; i < times; i++) {
                helper.call("swipe", Json.obj("x1", swipe[0], "y1", swipe[1], "x2", swipe[2], "y2", swipe[3], "ms", swipe[4]), ACT_MS);
                begun = true;
            }
            return "swipe";
        } catch (Helper.Lost l) {
            if (l.sent || begun) throw unsure("scrolling", l);
            lost(l);
            return null;
        } catch (Helper.Failed f) {
            if (begun) return "swipe";
            log.line("scroll: the fast engine could not (" + f.getMessage() + "); through the shell");
            return null;
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while scrolling");
        }
    }

    /** A picture through the fast engine (UiAutomation's screenshot), or null to take it with screencap. */
    private Shot fastShot(int side, int[] crop) {
        if (!fast()) return null;
        try {
            Map<String, Object> r = helper.call("screenshot", Json.obj("maxSide", side, "crop", crop == null ? null : Arrays.asList((Object) crop[0], crop[1], crop[2], crop[3])), dumpMs);
            byte[] jpeg = Base64.getDecoder().decode(String.valueOf(r.get("jpeg")));
            Integer w = Json.integer(r, "w"), h = Json.integer(r, "h");
            if (jpeg.length < 4 || (jpeg[0] & 0xff) != 0xff || (jpeg[1] & 0xff) != 0xd8 || w == null || h == null) throw new Helper.Failed(HelperProtocol.FAILED, "not a JPEG");
            return new Shot(jpeg, w, h);
        } catch (Helper.Lost l) {
            lost(l);
            return null;
        } catch (IOException | IllegalArgumentException e) {
            log.line("screenshot: the fast engine could not (" + e.getMessage() + "); with screencap");
            return null;
        }
    }

    /** The engine in a word, for the admin page's Check and the diagnostics. */
    String engineWord() {
        Helper h = helper;
        if (h == null) return "uiautomator";
        switch (h.state()) {
            case FAST: return "fast";
            case STARTING: return "starting (uiautomator meanwhile)";
            case OFF: return "uiautomator (fast engine off)";
            default: return "uiautomator (fast engine not available: " + clip(h.detail(), 80) + ")";
        }
    }

    private static final Map<String, Integer> SHOT_SIDES = new LinkedHashMap<>();
    static {
        SHOT_SIDES.put("low", 640);
        SHOT_SIDES.put("normal", 1024);
        SHOT_SIDES.put("high", 1568);
    }

    /**
     * Waits until an element called `name` is on the panel, or the panel in front belongs to `window`
     * (`gone`: until not), looking twice a second, for up to `seconds`.
     */
    private AxisLink.Answer waitFor(Map<String, Object> p) throws Exception {
        String name = Json.str(p, "name"), window = Json.str(p, "window");
        Integer goneN = Json.integer(p, "gone");
        boolean gone = (goneN != null && goneN == 1) || Json.isTrue(p, "gone");
        Integer s = Json.integer(p, "seconds");
        int seconds = clamp(s == null ? 10 : s, 1, 20);
        long started = System.currentTimeMillis();
        String lastWindow = null;
        while (true) {
            boolean there;
            if (name != null) {
                Panel panel = freshLook();
                lastWindow = panel.window();
                there = !match(panel.elements, name, Json.str(p, "kind")).isEmpty();
            } else {
                String pkg = foreground();
                there = pkg != null && (score(Panel.appName(pkg), window) > 0 || pkg.toLowerCase(Locale.ROOT).contains(window.toLowerCase(Locale.ROOT)));
            }
            long took = System.currentTimeMillis() - started;
            if (there != gone) {
                did("Waited " + took + " ms for " + (name != null ? "\"" + clip(name, 40) + "\"" : "the " + clip(window, 40) + " panel") + (gone ? " to go" : ""));
                return AxisLink.Answer.done(Json.obj("waited", took));
            }
            if (took >= seconds * 1000L) {
                String what = name != null
                        ? "\"" + name + "\" " + (gone ? "is still" : "did not appear") + " on " + (lastWindow != null ? lastWindow : "the panel in front")
                        : "the " + window + " panel " + (gone ? "is still in front" : "did not come to the front");
                return AxisLink.Answer.fail(what + " after " + seconds + " s");
            }
            sleeper.sleep(500);
        }
    }

    /** Runs steps in order, stopping at the first that fails, and says how each went. */
    private AxisLink.Answer steps(Map<String, Object> p) throws Exception {
        Map<String, Object> data = Json.map(p.get("data"));
        List<Object> steps = data == null ? null : Json.list(data.get("steps"));
        if (steps == null) return AxisLink.Answer.fail("steps needs a list of steps");
        if (steps.size() > MAX_STEPS) return AxisLink.Answer.fail("at most " + MAX_STEPS + " steps in one call");
        List<Object> report = new ArrayList<>();
        int i = 0;
        for (Object o : steps) {
            i++;
            Map<String, Object> step = Json.map(o);
            String action = step == null ? "" : or(Json.str(step, "action"), "");
            if (!STEP_ACTIONS.contains(action)) return stepsFailed(report, i, action, action + " cannot be a step", null);
            if (i > 1) sleeper.sleep(SETTLE_MS);
            AxisLink.Answer answer;
            try {
                answer = run("desktop." + action, step);
            } catch (Exception e) {
                answer = AxisLink.Answer.fail(AxisLink.describe(e));
            }
            Map<String, Object> line = Json.obj("action", action, "ok", answer.ok);
            if (answer.payload != null) line.putAll(answer.payload);
            Map<String, Object> d = Json.map(answer.data);
            if (d != null && d.get("matches") != null) line.put("matches", d.get("matches"));
            if (!answer.ok) return stepsFailed(report, i, action, answer.error == null ? "failed" : answer.error, line);
            report.add(line);
        }
        did("Ran " + i + " steps");
        return AxisLink.Answer.data(Json.obj("steps", report, "done", i, "of", i));
    }

    private AxisLink.Answer stepsFailed(List<Object> report, int at, String action, String error, Map<String, Object> line) {
        if (line == null) line = Json.obj("action", action, "ok", false);
        line.put("error", error);
        report.add(line);
        did("Steps stopped at step " + at + " (" + action + "): " + error);
        return new AxisLink.Answer(false, "step " + at + " (" + action + ") failed: " + error, null,
                Json.obj("steps", report, "done", at - 1, "failed", at, "error", error));
    }

    private static final Set<String> STEP_ACTIONS = new HashSet<>(Arrays.asList(
            "click", "type", "keys", "open", "switch", "window", "desktop", "wait", "point", "find", "scroll", "paste"));

    // ---- what is in front, after an action -----------------------------------

    private static final Pattern FOCUS = Pattern.compile("mCurrentFocus=Window\\{\\S+ \\S+ ([A-Za-z0-9_.]+)(/[^ }]*)?\\}");
    private static final Pattern RESUMED = Pattern.compile("(?:mResumedActivity|ResumedActivity|mFocusedApp)[:=].*? ([A-Za-z0-9_.]+)/");

    /** The package of the window in front, cheaply (no dump), or null when it cannot be told. */
    String foreground() {
        try {
            String out = adb.shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'", 3000);
            Matcher m = FOCUS.matcher(out);
            if (m.find()) return m.group(1);
            m = RESUMED.matcher(out);
            if (m.find()) return m.group(1);
        } catch (IOException e) {
            // Only a nicety for the answer; the action itself has been done or failed on its own.
        }
        return null;
    }

    /**
     * The package in front from the fast engine, after letting the panel settle for up to `idleMs` (0: at once), or
     * null when it is not running or cannot tell. One call; no shell.
     */
    private String fastFront(int idleMs) {
        if (!fast()) return null;
        try {
            Map<String, Object> r = helper.call("front", Json.obj("idleMs", idleMs, "quietMs", quietMs), ACT_MS);
            String pkg = Json.str(r, "package");
            if (pkg == null || pkg.isEmpty()) return null;
            synchronized (this) {
                lastFront = pkg;
                lastFrontAt = System.currentTimeMillis();
            }
            return pkg;
        } catch (Helper.Lost l) {
            lost(l);
        } catch (IOException e) {
            log.line("front: the fast engine could not tell (" + e.getMessage() + ")");
        }
        return null;
    }

    /**
     * The package in front before an action. With the fast engine: what a look or the last action saw within
     * FRONT_FRESH_MS, else one `front` call; through the shell, `dumpsys window` as before.
     */
    private String before() {
        if (!fast()) return foreground();
        synchronized (this) {
            if (lastFront != null && System.currentTimeMillis() - lastFrontAt < FRONT_FRESH_MS) return lastFront;
        }
        String pkg = fastFront(0);
        return pkg != null || fast() ? pkg : foreground();
    }

    /** Adds `after` to an action's answer: the panel in front afterwards, with `new` when it changed. */
    private AxisLink.Answer withAfter(AxisLink.Answer answer, String name, Map<String, Object> p, String before) throws InterruptedException {
        if (!answer.ok && !"desktop.steps".equals(name)) return answer;
        // An open has waited for its app to come to the front already; anything else is read once the panel is
        // still (fast engine), else after AFTER_MS through the shell.
        String now = name.equals("desktop.open") ? arrived : null;
        if (now == null) now = fastFront(AFTER_MAX_MS);
        if (now == null) {
            sleeper.sleep(AFTER_MS);
            now = foreground();
        }
        if (now == null) return answer;
        Map<String, Object> after = Json.obj("window", Panel.appName(now) + " (" + now + ")");
        if (before != null && !before.equals(now)) after.put("new", true);
        Map<String, Object> data = Json.map(answer.data);
        data = data == null ? new LinkedHashMap<>() : new LinkedHashMap<>(data);
        data.put("after", after);
        return answer.withData(data);
    }

    // ---- small things ----------------------------------------------------------

    /** The panel last read, for the app's Test button. */
    public synchronized Panel lastPanel() { return lastPanel; }

    /** What the Test button found: the panel, the fast engine's timing when it ran, and a plain and a compressed uiautomator dump. */
    public static final class TestResult {
        public final Panel panel;
        public final Timing plain, compressed;
        /** Why the compressed dump failed, if it did. */
        public final String compressedFailed;
        /** The fast engine's dump, or null when it was not running; why not, or why it failed. */
        public final Timing fast;
        public final String fastNote;

        TestResult(Panel panel, Timing plain, Timing compressed, String compressedFailed, Timing fast, String fastNote) {
            this.panel = panel;
            this.plain = plain;
            this.compressed = compressed;
            this.compressedFailed = compressedFailed;
            this.fast = fast;
            this.fastNote = fastNote;
        }
    }

    /**
     * Reads the panel for the app's own Test button (not an agent's command; still one at a time): with the fast
     * engine when it runs, then as uiautomator does by default and with --compressed, so the person can compare.
     * uiautomator cannot read while the helper holds the screen, so the helper is stopped for the uiautomator reads
     * and started again afterwards. The look agents get afterwards is the engine's, else what "Faster looks" says.
     */
    public TestResult test() throws Exception {
        if (!gate.tryLock(BUSY_MS, TimeUnit.MILLISECONDS)) throw new IOException("busy with an agent's command");
        Helper h = helper;
        boolean restart = false;
        try {
            Timing quick = null;
            String quickNote;
            if (fast()) {
                try {
                    fastDump();
                    quick = lastTiming;
                    quickNote = null;
                } catch (Helper.Lost e) {
                    lost(e);
                    quickNote = "did not answer: " + e.getMessage();
                } catch (IOException e) {
                    quickNote = "failed: " + e.getMessage();
                }
                h.pause("stopped for Test's uiautomator reads");
                restart = true;
            } else quickNote = h == null ? "not in this build" : "not running (" + engineWord() + ")";
            Panel panel = shellDump(false);
            Timing plain = lastTiming;
            Timing small = null;
            String failed = null;
            try {
                shellDump(true);
                small = lastTiming;
            } catch (IOException e) {
                failed = AxisLink.describe(e);
            }
            synchronized (this) {
                lastPanel = panel;
            }
            lastTiming = quick != null ? quick : compressed && small != null ? small : plain;
            return new TestResult(panel, plain, small, failed, quick, quickNote);
        } finally {
            gate.unlock();
            // Back to the fast engine at once, not at the next check.
            if (restart) h.tick();
        }
    }

    static String seconds(int ms) { return ms % 1000 == 0 ? String.valueOf(ms / 1000) : String.valueOf(ms / 1000.0); }
    static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }
    static String or(String a, String b) { return a != null ? a : b; }
    static String clip(String s, int n) { return s.length() > n ? s.substring(0, n - 1) + "…" : s; }
}
