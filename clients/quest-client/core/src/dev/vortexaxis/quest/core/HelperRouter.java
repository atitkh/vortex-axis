package dev.vortexaxis.quest.core;

import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The helper's side of the fast engine, in plain Java: one request in, one answer out (HelperProtocol). It keeps the
 * handle table and every rule; the helper package's Android glue (UiAutomation, AccessibilityNodeInfo) only does
 * what `Device` asks, so all of this is tested on a JVM against a pretend screen. It never acts on its own.
 */
public final class HelperRouter<N> {
    /** One node as the accessibility tree has it, read once. */
    public static final class NodeData {
        public String cls = "", pkg = "", text = "", desc = "", hint = "", resId = "";
        public int left, top, right, bottom;
        public boolean clickable, longClickable, scrollable, enabled = true, focused, focusable, checkable, checked, selected,
                password, editable, visible = true, showingHint;
        public int selStart = -1, selEnd = -1;
    }

    /** What only Android can do; the helper package implements it over UiAutomation. Every call may throw. */
    public interface Device<N> {
        /** The windows on the screen: id, title, package, display, type, layer, active, focused, bounds. */
        List<Map<String, Object>> windows() throws Exception;
        /** The root of the window `windowId`, or of the active window when null; null when there is none. */
        N root(Integer windowId, boolean compressed, int idleMs) throws Exception;
        NodeData read(N node) throws Exception;
        int childCount(N node) throws Exception;
        N child(N node, int i) throws Exception;
        /** Reads the node again from the app; false when it is gone. */
        boolean refresh(N node) throws Exception;
        boolean click(N node) throws Exception;
        boolean longClick(N node) throws Exception;
        boolean focus(N node) throws Exception;
        /** Sets the field's text and puts the caret at `caret`. False when the field did not take it. */
        boolean setText(N node, String text, int caret) throws Exception;
        boolean scroll(N node, boolean forward) throws Exception;
        /** The node that has the input focus, or null. */
        N focusedInput() throws Exception;
        void tap(int x, int y) throws Exception;
        void longPress(int x, int y) throws Exception;
        void swipe(int x1, int y1, int x2, int y2, int ms) throws Exception;
        void key(int code, boolean ctrl, boolean alt, boolean shift) throws Exception;
        void back() throws Exception;
        /** {jpeg bytes, width, height} of the screen (`crop` {x, y, w, h} or null) no larger than maxSide, or null when it cannot. */
        Object[] screenshot(int maxSide, int[] crop) throws Exception;

        /** {package, title} of the active window, cheaply (no tree read); "" for what it cannot tell. */
        default String[] front() throws Exception {
            for (Map<String, Object> w : windows()) {
                if (Json.isTrue(w, "active")) return new String[] {String.valueOf(w.getOrDefault("package", "")), String.valueOf(w.getOrDefault("title", ""))};
            }
            return new String[] {"", ""};
        }

        /** How many accessibility events the helper has seen since it started, or -1 when it cannot count them. */
        default long generation() { return -1; }

        /** Waits until nothing has happened on the screen for quietMs, or maxMs at most (UiAutomation.waitForIdle). */
        default void waitForIdle(int quietMs, int maxMs) throws Exception {}
    }

    /** An answer that is a refusal or a failure, with its code. */
    static final class Refusal extends Exception {
        final String code;

        Refusal(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    public static final int MAX_NODES = 3000;

    private final Device<N> device;
    private final String version;
    private final Map<Integer, N> handles = new HashMap<>();
    private int nextHandle = 1;

    public HelperRouter(Device<N> device, String version) {
        this.device = device;
        this.version = version;
    }

    /** The answer to one request line. Never throws. */
    public synchronized Map<String, Object> handle(String line) {
        Object id = null;
        try {
            Map<String, Object> req = Json.parseObject(line);
            id = req.get("id");
            Map<String, Object> out = run(String.valueOf(req.get("op")), req);
            Map<String, Object> answer = Json.obj("id", id, "ok", true);
            answer.putAll(out);
            return answer;
        } catch (Refusal r) {
            return Json.obj("id", id, "ok", false, "code", r.code, "error", r.getMessage());
        } catch (IllegalArgumentException e) {
            return Json.obj("id", id, "ok", false, "code", HelperProtocol.BAD, "error", String.valueOf(e.getMessage()));
        } catch (Exception e) {
            String why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getClass().getSimpleName() + ": " + e.getMessage();
            return Json.obj("id", id, "ok", false, "code", HelperProtocol.FAILED, "error", why);
        }
    }

    private Map<String, Object> run(String op, Map<String, Object> r) throws Exception {
        switch (op) {
            case "ping":
                return Json.obj("version", version, "wire", HelperProtocol.WIRE);
            case "windows":
                return Json.obj("windows", new ArrayList<Object>(device.windows()));
            case "front": {
                int idleMs = Math.max(0, Math.min(2000, num(r, "idleMs", 0)));
                if (idleMs > 0) settle(Math.max(1, Math.min(idleMs, num(r, "quietMs", 100))), idleMs);
                String[] f = device.front();
                return Json.obj("package", f[0], "title", f[1], "generation", device.generation());
            }
            case "focus": {
                // What has the input focus, without reading the tree: enough to keep typing out of a password field.
                N n = device.focusedInput();
                if (n == null) return Json.obj("found", false);
                NodeData d = device.read(n);
                int handle = nextHandle++;
                handles.put(handle, n);
                String name = !d.password && !d.text.isEmpty() && !d.showingHint ? d.text : !d.desc.isEmpty() ? d.desc : d.hint;
                return Json.obj("found", true, "password", d.password, "editable", d.editable, "name", name, "handle", handle);
            }
            case "dump":
                return dump(Json.integer(r, "window"), Json.isTrue(r, "compressed"), num(r, "maxNodes", MAX_NODES), num(r, "idleMs", 0));
            case "click": case "longClick": {
                N n = node(r);
                NodeData d = device.read(n);
                boolean pressed = op.equals("click") ? d.clickable && d.enabled && device.click(n) : d.longClickable && d.enabled && device.longClick(n);
                if (pressed) return Json.obj("how", "press");
                // Something that is not tappable itself (a label inside a tile): a touch at its centre, as a person would.
                int x = (d.left + d.right) / 2, y = (d.top + d.bottom) / 2;
                if (op.equals("click")) device.tap(x, y);
                else device.longPress(x, y);
                return Json.obj("how", "touch", "x", x, "y", y);
            }
            case "setText":
                return setText(r);
            case "scroll": {
                N n = node(r);
                if (!device.read(n).scrollable) throw new Refusal(HelperProtocol.UNSUPPORTED, "that does not scroll");
                return Json.obj("moved", device.scroll(n, Json.isTrue(r, "forward")));
            }
            case "tap":
                device.tap(need(r, "x"), need(r, "y"));
                return Json.obj();
            case "longPress":
                device.longPress(need(r, "x"), need(r, "y"));
                return Json.obj();
            case "swipe":
                device.swipe(need(r, "x1"), need(r, "y1"), need(r, "x2"), need(r, "y2"), Math.max(1, Math.min(5000, num(r, "ms", 300))));
                return Json.obj();
            case "key":
                device.key(need(r, "code"), Json.isTrue(r, "ctrl"), Json.isTrue(r, "alt"), Json.isTrue(r, "shift"));
                return Json.obj();
            case "back":
                device.back();
                return Json.obj();
            case "screenshot": {
                List<Object> c = Json.list(r.get("crop"));
                int[] crop = null;
                if (c != null) {
                    if (c.size() != 4) throw new IllegalArgumentException("crop is x, y, w, h");
                    crop = new int[4];
                    for (int i = 0; i < 4; i++) crop[i] = ((Number) c.get(i)).intValue();
                }
                Object[] shot = device.screenshot(Math.max(64, Math.min(4096, num(r, "maxSide", 1024))), crop);
                if (shot == null) throw new Refusal(HelperProtocol.UNSUPPORTED, "the screen could not be pictured from here");
                return Json.obj("jpeg", Base64.getEncoder().encodeToString((byte[]) shot[0]), "w", shot[1], "h", shot[2]);
            }
            default:
                throw new IllegalArgumentException("unknown op " + op);
        }
    }

    /**
     * Waits for the screen to settle after an action: until no accessibility event for quietMs, counted from now (an
     * action's first events may come a moment after it), or maxMs at most. Without a count of events, the device's
     * own wait for idle.
     */
    private void settle(int quietMs, int maxMs) throws Exception {
        long seen = device.generation();
        if (seen < 0) {
            device.waitForIdle(quietMs, maxMs);
            return;
        }
        long start = System.nanoTime() / 1_000_000, changed = start;
        while (true) {
            long now = System.nanoTime() / 1_000_000, g = device.generation();
            if (g != seen) {
                seen = g;
                changed = now;
            }
            if (now - changed >= quietMs || now - start >= maxMs) return;
            Thread.sleep(Math.max(1, Math.min(10, quietMs - (now - changed))));
        }
    }

    // ---- dump ----------------------------------------------------------------

    private Map<String, Object> dump(Integer window, boolean compressed, int maxNodes, int idleMs) throws Exception {
        handles.clear();
        N root = device.root(window, compressed, Math.max(0, Math.min(2000, idleMs)));
        List<Object> roots = new ArrayList<>();
        int[] count = {0};
        boolean[] cut = {false};
        if (root != null) roots.add(encode(root, count, Math.max(1, Math.min(MAX_NODES, maxNodes)), cut, 0));
        Map<String, Object> out = Json.obj("roots", roots, "nodes", count[0]);
        if (cut[0]) out.put("truncated", true);
        return out;
    }

    /** One node and what is under it, as uiautomator writes it: only what is visible to the person. */
    private Map<String, Object> encode(N n, int[] count, int max, boolean[] cut, int depth) throws Exception {
        count[0]++;
        NodeData d = device.read(n);
        int handle = nextHandle++;
        handles.put(handle, n);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("handle", handle);
        m.put("class", d.cls);
        m.put("package", d.pkg);
        // A password field's text never leaves the helper.
        if (!d.password && !d.text.isEmpty() && !d.showingHint) m.put("text", d.text);
        if (!d.desc.isEmpty()) m.put("content-desc", d.desc);
        if (!d.hint.isEmpty()) m.put("hint", d.hint);
        if (!d.resId.isEmpty()) m.put("resource-id", d.resId);
        m.put("bounds", java.util.Arrays.asList((Object) d.left, d.top, d.right, d.bottom));
        flag(m, "clickable", d.clickable);
        flag(m, "long-clickable", d.longClickable);
        flag(m, "scrollable", d.scrollable);
        if (!d.enabled) m.put("enabled", false);
        flag(m, "focusable", d.focusable);
        flag(m, "focused", d.focused);
        flag(m, "checkable", d.checkable);
        flag(m, "checked", d.checked);
        flag(m, "selected", d.selected);
        flag(m, "password", d.password);
        int kids = depth >= 100 ? 0 : device.childCount(n);
        List<Object> children = new ArrayList<>();
        for (int i = 0; i < kids; i++) {
            if (count[0] >= max) {
                cut[0] = true;
                break;
            }
            N c = device.child(n, i);
            if (c == null || !device.read(c).visible) continue;
            children.add(encode(c, count, max, cut, depth + 1));
        }
        if (!children.isEmpty()) m.put("children", children);
        return m;
    }

    private static void flag(Map<String, Object> m, String key, boolean on) {
        if (on) m.put(key, true);
    }

    // ---- acting --------------------------------------------------------------

    /** The node a handle names, read again; a handle from before the last dump, or a node gone since, is stale. */
    private N node(Map<String, Object> r) throws Exception {
        Integer h = Json.integer(r, "handle");
        if (h == null) throw new IllegalArgumentException("a handle is needed");
        N n = handles.get(h);
        if (n == null || !device.refresh(n)) throw new Refusal(HelperProtocol.STALE, "that element is gone from the panel; look again");
        return n;
    }

    /**
     * Types into a field: the one a handle names (given the focus first) or the one with the focus. Never into a
     * password field. Puts the text in at the caret (HelperProtocol.insert), so a focused empty field ends up as the
     * Windows app's typing leaves it.
     */
    private Map<String, Object> setText(Map<String, Object> r) throws Exception {
        Object raw = r.get("text");
        if (!(raw instanceof String)) throw new IllegalArgumentException("setText needs text");
        String typed = (String) raw;
        N n;
        if (r.get("handle") != null) n = node(r);
        else {
            n = device.focusedInput();
            if (n == null) throw new Refusal(HelperProtocol.UNSUPPORTED, "nothing on the panel has the focus to type into");
        }
        NodeData d = device.read(n);
        if (d.password) throw new Refusal(HelperProtocol.PASSWORD, "the app never types into a password field");
        if (!d.editable) throw new Refusal(HelperProtocol.UNSUPPORTED, "that is not a text field the fast engine can fill");
        if (!d.focused) {
            if (!device.focus(n) && d.clickable) device.click(n);
            device.refresh(n);
            d = device.read(n);
            if (d.password) throw new Refusal(HelperProtocol.PASSWORD, "the app never types into a password field");
        }
        Object[] next = HelperProtocol.insert(d.text, d.selStart, d.selEnd, d.showingHint, typed);
        if (!device.setText(n, (String) next[0], (Integer) next[1])) throw new Refusal(HelperProtocol.UNSUPPORTED, "the field did not take the text");
        return Json.obj("typed", typed.length());
    }

    private static int num(Map<String, Object> r, String key, int fallback) {
        Integer v = Json.integer(r, key);
        return v == null ? fallback : v;
    }

    private static int need(Map<String, Object> r, String key) {
        Integer v = Json.integer(r, key);
        if (v == null) throw new IllegalArgumentException(key + " is needed");
        return v;
    }
}
