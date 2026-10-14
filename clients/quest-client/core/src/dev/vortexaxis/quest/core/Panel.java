package dev.vortexaxis.quest.core;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.xml.parsers.SAXParser;
import javax.xml.parsers.SAXParserFactory;

import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.helpers.DefaultHandler;

/**
 * What a `uiautomator dump` of the panel in front shows, made small enough for an agent to read as
 * text: wrappers without a label dropped (their children moved up), labels taken from content-desc
 * when the text is empty (React Native panels, such as the Store), text a parent already says
 * dropped, every box clipped to the panel and anything wholly off it left out. Then tidied: things
 * in reading order (bands top to bottom, left to right in a band), a tile's short texts (rating,
 * genre) folded into its name and a tile without a name named by its first label, decoration
 * images ("Star icon") and same-box twins dropped, long names cut short on the line.
 */
public final class Panel {
    /** Quest system panels are laid out in this space; `input` takes the same coordinates. */
    public static final int WIDTH = 1280, HEIGHT = 800;
    /** A box narrower than this along a panel edge is a tile scrolled almost out of view, not something to use. */
    static final int SLIVER = 16;
    /** How much of a name a line shows; matching by name uses all of it. */
    static final int MAX_NAME = 80;
    /** How much of a tile's name with its folded texts a line shows. */
    static final int MAX_TILE = 120;
    static final int MAX_VALUE = 160;
    /** A text longer than this is content, not a tile's detail, and stays its own line. */
    static final int MAX_DETAIL = 60;
    /** Centres closer than this (or half the smaller height) are one band of the reading order. */
    static final int BAND = 8;

    /** One thing on the panel, as the agent sees it. Coordinates are panel pixels. */
    public static final class Element {
        /** `name` is the whole name, with a tile's folded details after " — "; the line shows it cut short. */
        public final String kind, name, value;
        public final int x, y, w, h;
        public final boolean focused, enabled, scrollable, password;
        final String scrollsWay;
        final String own, details;
        /** The fast engine's handle for the node this came from, valid until its next dump; -1 from a uiautomator dump. */
        public final int handle;

        Element(String kind, String name, String value, int[] box, boolean focused, boolean enabled, boolean scrollable, boolean password, String scrollsWay) {
            this(kind, name, "", value, box, focused, enabled, scrollable, password, scrollsWay, -1);
        }

        Element(String kind, String own, String details, String value, int[] box, boolean focused, boolean enabled, boolean scrollable, boolean password, String scrollsWay, int handle) {
            this.kind = kind;
            this.own = own;
            this.details = details;
            this.name = details.isEmpty() ? own : own + " — " + details;
            this.value = value;
            this.x = box[0];
            this.y = box[1];
            this.w = box[2] - box[0];
            this.h = box[3] - box[1];
            this.focused = focused;
            this.enabled = enabled;
            this.scrollable = scrollable;
            this.password = password;
            this.scrollsWay = scrollsWay;
            this.handle = handle;
        }

        public int cx() { return x + w / 2; }
        public int cy() { return y + h / 2; }

        /** "17 button 120,300 200x80 Beyond Sandbox", then "= value", "*focus", "*disabled", "*scrolls" when they apply. */
        public String line(int id) {
            StringBuilder sb = new StringBuilder();
            sb.append(id).append(' ').append(kind).append(' ').append(x).append(',').append(y).append(' ').append(w).append('x').append(h);
            if (!name.isEmpty()) sb.append(' ').append(shownName());
            if (value != null && !value.isEmpty()) sb.append(" = ").append(clip(value, MAX_VALUE));
            if (focused) sb.append(" *focus");
            if (!enabled) sb.append(" *disabled");
            if (scrollable) sb.append(scrollsWay == null ? " *scrolls" : " *scrolls " + scrollsWay);
            return sb.toString();
        }

        /** The name as a line shows it: its own words cut at MAX_NAME, then a tile's details, all within MAX_TILE. */
        String shownName() {
            String head = clipWords(own, MAX_NAME);
            return details.isEmpty() ? head : clipWords(head + " — " + details, MAX_TILE);
        }
    }

    /** The app the panel belongs to, by package. */
    public final String pkg;
    public final int width, height;
    public final List<Element> elements;
    /** Nodes in the dump, before any were dropped. */
    public final int nodes;
    /** A password field has the focus (screenshots are refused, nothing is typed blind). */
    public final boolean passwordFocused;

    private Panel(String pkg, int width, int height, List<Element> elements, int nodes, boolean passwordFocused) {
        this.pkg = pkg;
        this.width = width;
        this.height = height;
        this.elements = elements;
        this.nodes = nodes;
        this.passwordFocused = passwordFocused;
    }

    /** "Store (com.oculus.store)". */
    public String window() {
        return pkg.isEmpty() ? "unknown panel" : appName(pkg) + " (" + pkg + ")";
    }

    private static final Map<String, String> APPS = new HashMap<>();
    static {
        APPS.put("com.oculus.store", "Store");
        APPS.put("com.oculus.browser", "Browser");
        APPS.put("com.android.settings", "Settings");
        APPS.put("com.oculus.vrshell", "Home");
        APPS.put("com.oculus.systemux", "System");
        APPS.put("com.oculus.explore", "Explore");
        APPS.put("com.oculus.socialplatform", "People");
        APPS.put("com.oculus.tv", "TV");
        APPS.put("com.oculus.vrshell.desktop", "Desktop");
    }

    /** A short name for an app's package: the known ones by name, else the last part of the package. */
    public static String appName(String pkg) {
        String known = APPS.get(pkg);
        if (known != null) return known;
        String last = pkg.substring(pkg.lastIndexOf('.') + 1);
        return last.isEmpty() ? pkg : Character.toUpperCase(last.charAt(0)) + last.substring(1);
    }

    // ---- parsing -------------------------------------------------------------

    static final class Node {
        String cls = "", pkg = "", text = "", desc = "", hint = "", resId = "";
        int[] box = {0, 0, 0, 0};
        /** The box as seen on the panel, for the reading order. */
        int[] seen = box;
        boolean clickable, longClickable, scrollable, enabled = true, focused, checkable, checked, selected, password;
        /** The fast engine's handle for it; -1 from a uiautomator dump. */
        int handle = -1;
        final List<Node> children = new ArrayList<>();
    }

    /** The XML between `<?xml` and `</hierarchy>`, whatever uiautomator printed around it ("UI hierchary dumped to: ..."). */
    public static String extractXml(String output) {
        int start = output.indexOf("<?xml");
        if (start < 0) start = output.indexOf("<hierarchy");
        int end = output.lastIndexOf("</hierarchy>");
        if (start < 0 || end < 0 || end < start) return null;
        return output.substring(start, end + "</hierarchy>".length());
    }

    public static Panel parse(String xml) {
        return parse(xml, WIDTH, HEIGHT);
    }

    public static Panel parse(String xml, int width, int height) {
        Node root = new Node();
        int[] count = {0};
        try {
            SAXParserFactory f = SAXParserFactory.newInstance();
            trySet(f, "http://apache.org/xml/features/disallow-doctype-decl", true);
            trySet(f, "http://xml.org/sax/features/external-general-entities", false);
            trySet(f, "http://xml.org/sax/features/external-parameter-entities", false);
            SAXParser p = f.newSAXParser();
            p.parse(new InputSource(new StringReader(xml)), new DefaultHandler() {
                final ArrayList<Node> stack = new ArrayList<>();
                { stack.add(root); }

                @Override public void startElement(String uri, String local, String qName, Attributes a) {
                    if (!"node".equals(qName)) return;
                    count[0]++;
                    Node n = new Node();
                    n.cls = attr(a, "class");
                    n.pkg = attr(a, "package");
                    n.text = clean(attr(a, "text"));
                    n.desc = clean(attr(a, "content-desc"));
                    n.hint = clean(attr(a, "hint"));
                    n.resId = attr(a, "resource-id");
                    n.box = bounds(attr(a, "bounds"));
                    n.clickable = "true".equals(attr(a, "clickable"));
                    n.longClickable = "true".equals(attr(a, "long-clickable"));
                    n.scrollable = "true".equals(attr(a, "scrollable"));
                    n.enabled = !"false".equals(attr(a, "enabled"));
                    n.focused = "true".equals(attr(a, "focused"));
                    n.checkable = "true".equals(attr(a, "checkable"));
                    n.checked = "true".equals(attr(a, "checked"));
                    n.selected = "true".equals(attr(a, "selected"));
                    n.password = "true".equals(attr(a, "password"));
                    stack.get(stack.size() - 1).children.add(n);
                    stack.add(n);
                }

                @Override public void endElement(String uri, String local, String qName) {
                    if ("node".equals(qName) && stack.size() > 1) stack.remove(stack.size() - 1);
                }
            });
        } catch (Exception e) {
            throw new IllegalArgumentException("the panel's description could not be read: " + e.getMessage(), e);
        }
        return build(root, count[0], width, height);
    }

    /**
     * The panel from the fast engine's dump (HelperProtocol: one object per node, the XML's attribute names as keys,
     * `bounds` as [l, t, r, b], `children`, `handle`). It becomes the same tree a uiautomator dump does, and is tidied
     * by the same code.
     */
    public static Panel fromHelper(Map<String, Object> dump) {
        return fromHelper(dump, WIDTH, HEIGHT);
    }

    public static Panel fromHelper(Map<String, Object> dump, int width, int height) {
        Node root = new Node();
        int[] count = {0};
        List<Object> roots = Json.list(dump.get("roots"));
        if (roots == null) throw new IllegalArgumentException("the fast engine's dump has no roots");
        for (Object o : roots) {
            Map<String, Object> m = Json.map(o);
            if (m != null) root.children.add(node(m, count, 0));
        }
        return build(root, count[0], width, height);
    }

    private static Node node(Map<String, Object> m, int[] count, int depth) {
        if (depth > 200) throw new IllegalArgumentException("the fast engine's dump is nested too deeply");
        count[0]++;
        Node n = new Node();
        n.cls = text(m, "class");
        n.pkg = text(m, "package");
        n.text = clean(text(m, "text"));
        n.desc = clean(text(m, "content-desc"));
        n.hint = clean(text(m, "hint"));
        n.resId = text(m, "resource-id");
        List<Object> b = Json.list(m.get("bounds"));
        if (b != null && b.size() == 4 && b.get(0) instanceof Number && b.get(1) instanceof Number && b.get(2) instanceof Number && b.get(3) instanceof Number)
            n.box = new int[] {((Number) b.get(0)).intValue(), ((Number) b.get(1)).intValue(), ((Number) b.get(2)).intValue(), ((Number) b.get(3)).intValue()};
        n.clickable = Json.isTrue(m, "clickable");
        n.longClickable = Json.isTrue(m, "long-clickable");
        n.scrollable = Json.isTrue(m, "scrollable");
        n.enabled = !Boolean.FALSE.equals(m.get("enabled"));
        n.focused = Json.isTrue(m, "focused");
        n.checkable = Json.isTrue(m, "checkable");
        n.checked = Json.isTrue(m, "checked");
        n.selected = Json.isTrue(m, "selected");
        n.password = Json.isTrue(m, "password");
        Integer h = Json.integer(m, "handle");
        n.handle = h == null ? -1 : h;
        List<Object> kids = Json.list(m.get("children"));
        if (kids != null) for (Object o : kids) {
            Map<String, Object> k = Json.map(o);
            if (k != null) n.children.add(node(k, count, depth + 1));
        }
        return n;
    }

    private static String text(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v instanceof String ? (String) v : "";
    }

    /** The one way from a node tree (either source) to a panel: walked, tidied and finished. */
    private static Panel build(Node root, int nodes, int width, int height) {
        Builder b = new Builder(width, height);
        Item top = new Item();
        for (Node n : b.visual(root.children)) b.walk(n, new ArrayList<>(), false, top.kids);
        b.tidy(top);
        List<Item> flat = new ArrayList<>();
        flatten(top.kids, flat);
        String pkg = "";
        for (Node n : root.children) if (!n.pkg.isEmpty()) { pkg = n.pkg; break; }
        return new Panel(pkg, width, height, Builder.finish(flat), nodes, b.passwordFocused);
    }

    private static void trySet(SAXParserFactory f, String feature, boolean on) {
        try { f.setFeature(feature, on); } catch (Exception ignored) {}
    }

    private static String attr(Attributes a, String name) {
        String v = a.getValue(name);
        return v == null ? "" : v;
    }

    private static String clean(String s) {
        return s.replaceAll("\\s+", " ").trim();
    }

    static int[] bounds(String s) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]").matcher(s);
        if (!m.find()) return new int[] {0, 0, 0, 0};
        return new int[] {Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)), Integer.parseInt(m.group(4))};
    }

    /** An element while the panel is tidied: the kept elements as a tree, wrappers already gone. */
    static final class Item {
        String kind = "", name = "", value, way, details = "";
        int[] box = {0, 0, 0, 0};
        int handle = -1;
        boolean focused, enabled = true, scrollable, password, acts, checkable, edit;
        final List<Item> kids = new ArrayList<>();

        /** Something tapped as a whole whose texts describe it: a Store tile, a row, a button. */
        boolean tile() {
            return acts && !scrollable && !edit && !checkable && (kind.equals("button") || kind.equals("listitem") || kind.equals("tabitem"));
        }

        boolean small(int width, int height) {
            return (long) (box[2] - box[0]) * (box[3] - box[1]) * 2 <= (long) width * height;
        }
    }

    private static void flatten(List<Item> items, List<Item> out) {
        for (Item i : items) {
            out.add(i);
            flatten(i.kids, out);
        }
    }

    /** Walks the tree once into Items, then tidies them. */
    private static final class Builder {
        final int width, height;
        boolean passwordFocused;

        Builder(int width, int height) {
            this.width = width;
            this.height = height;
        }

        /** The box inside the panel, or null when nothing (or only a sliver at an edge) of it is on the panel. */
        int[] visible(int[] b) {
            int l = Math.max(0, b[0]), t = Math.max(0, b[1]), r = Math.min(width, b[2]), bot = Math.min(height, b[3]);
            if (r <= l || bot <= t) return null;
            boolean atEdge = l == 0 || t == 0 || r == width || bot == height;
            if (atEdge && (r - l < SLIVER || bot - t < SLIVER) && !(r - l >= width - 1 || bot - t >= height - 1)) return null;
            return new int[] {l, t, r, bot};
        }

        /**
         * `said`: names of the emitted ancestors, so a child repeating what its parent already says is
         * dropped. `inList`: the nearest emitted ancestor scrolls (its tappable children are list items).
         */
        void walk(Node n, List<String> said, boolean inList, List<Item> into) {
            if (n.focused && n.password) passwordFocused = true;
            int[] box = visible(n.box);
            if (box == null) {
                // Off the panel: its children may still be on it (rare), so they are looked at on their own.
                for (Node c : visual(n.children)) walk(c, said, inList, into);
                return;
            }
            boolean edit = isEdit(n);
            boolean acts = n.clickable || n.longClickable || n.checkable || edit || n.scrollable;
            String label = edit ? first(n.desc, n.hint) : first(n.text, n.desc);
            String value = null;
            if (edit) {
                if (label.isEmpty()) label = idWords(n.resId);
                // Never send what is in a password field; an empty field's text can be its hint.
                if (!n.password && !n.text.isEmpty() && !n.text.equals(n.hint)) value = n.text;
            }
            if (n.checkable) value = n.checked ? "on" : "off";
            else if (n.selected && acts) value = "selected";

            if (!acts && label.isEmpty()) {
                // A wrapper: only its children count.
                for (Node c : visual(n.children)) walk(c, said, inList, into);
                return;
            }
            if (!acts && saidAlready(label, said)) {
                for (Node c : visual(n.children)) walk(c, said, inList, into);
                return;
            }
            // A tappable container without a label of its own is named by what is written inside it (tidy).
            Item item = new Item();
            item.kind = kind(n, edit, acts, inList);
            item.name = label;
            item.value = value;
            item.box = box;
            item.focused = n.focused;
            item.enabled = n.enabled;
            item.scrollable = n.scrollable;
            item.password = n.password;
            item.way = n.scrollable ? scrollWay(n) : null;
            item.acts = acts;
            item.checkable = n.checkable;
            item.edit = edit;
            item.handle = n.handle;
            into.add(item);
            List<String> now = new ArrayList<>(said);
            if (!label.isEmpty()) now.add(label);
            for (Node c : visual(n.children)) walk(c, now, n.scrollable || (inList && !acts), item.kids);
        }

        // ---- reading order -------------------------------------------------

        /**
         * Siblings in the order a person reads them: bands from the top (by the centre of each box, so a
         * header row comes before a panel-sized list it floats over), left to right in a band. Wrappers
         * keep their place as one, so what is inside a list stays together after it.
         */
        List<Node> visual(List<Node> nodes) {
            if (nodes.size() < 2) return nodes;
            for (Node c : nodes) {
                int[] v = visible(c.box);
                c.seen = v != null ? v : c.box;
            }
            List<Node> byY = new ArrayList<>(nodes);
            byY.sort(java.util.Comparator.comparingInt(Builder::cy));
            List<Node> out = new ArrayList<>(nodes.size());
            int i = 0;
            while (i < byY.size()) {
                Node first = byY.get(i);
                int minH = h(first);
                List<Node> band = new ArrayList<>();
                band.add(first);
                int j = i + 1;
                for (; j < byY.size(); j++) {
                    Node c = byY.get(j);
                    if (cy(c) - cy(first) > Math.max(BAND, Math.min(minH, h(c)) / 2)) break;
                    band.add(c);
                    minH = Math.min(minH, h(c));
                }
                band.sort(java.util.Comparator.comparingInt(c -> c.seen[0]));
                out.addAll(band);
                i = j;
            }
            return out;
        }

        static int cy(Node n) { return (n.seen[1] + n.seen[3]) / 2; }
        static int h(Node n) { return n.seen[3] - n.seen[1]; }

        // ---- tidying -------------------------------------------------------

        /** Children first: names unnamed tiles, folds a tile's short texts into it, drops its decoration. */
        void tidy(Item node) {
            for (Item k : node.kids) tidy(k);
            if (node.tile()) fold(node);
            // Texts drawn inside a tile but given as its siblings (React Native does this) belong to it too.
            for (Item t : new ArrayList<>(node.kids)) {
                if (!t.tile() || !node.kids.contains(t)) continue;
                if (t.name.isEmpty()) {
                    // An unnamed tile with a label in exactly its box beside it: that label is its name.
                    for (int i = 0; i < node.kids.size(); i++) {
                        Item s = node.kids.get(i);
                        if (s.acts || s.name.isEmpty() || !s.kids.isEmpty() || !sameBox(s.box, t.box) || !(s.kind.equals("text") || s.kind.equals("image"))) continue;
                        t.name = base(s.name, false);
                        node.kids.remove(i);
                        break;
                    }
                }
                if (t.name.isEmpty() || !t.small(width, height)) continue;
                for (int i = 0; i < node.kids.size(); ) {
                    Item s = node.kids.get(i);
                    if (s != t && !s.acts && s.kids.isEmpty() && inside(s.box, t.box) && !sameBox(s.box, t.box) && absorbs(t, s)) node.kids.remove(i);
                    else i++;
                }
            }
        }

        void fold(Item tile) {
            List<Item> kids = tile.kids;
            if (tile.name.isEmpty()) {
                int labelled = 0;
                for (Item k : kids) if (!k.acts && !k.name.isEmpty()) labelled++;
                for (int i = 0; i < kids.size(); i++) {
                    Item k = kids.get(i);
                    if (k.acts || k.name.isEmpty() || !(k.kind.equals("text") || k.kind.equals("image"))) continue;
                    // A decoration image names a tile only when it is all there is to it.
                    if (k.kind.equals("image") && decoration(k.name) && labelled > 1) continue;
                    tile.name = base(k.name, false);
                    splice(kids, i);
                    break;
                }
            }
            if (tile.name.isEmpty()) return;
            boolean small = tile.small(width, height);
            for (int i = 0; i < kids.size(); ) {
                Item k = kids.get(i);
                if (!k.acts && ((small && absorbs(tile, k)) || (k.kind.equals("image") && related(k.name, tile.name)))) splice(kids, i);
                else i++;
            }
        }

        /**
         * Whether `tile` takes in `k`: a decoration image or a text that repeats the tile's name is
         * dropped, a short text is added to its details while they fit. False leaves `k` as it is.
         */
        boolean absorbs(Item tile, Item k) {
            if (k.acts || k.name.isEmpty()) return false;
            if (k.kind.equals("image")) return decoration(k.name) || related(k.name, tile.name);
            if (!k.kind.equals("text")) return false;
            String t = trimJoiners(k.name);
            String l = t.toLowerCase(Locale.ROOT);
            if (t.isEmpty() || related(t, tile.name) || tile.name.toLowerCase(Locale.ROOT).contains(l) || tile.details.toLowerCase(Locale.ROOT).contains(l)) return true;
            if (t.length() > MAX_DETAIL) return false;
            String details = tile.details.isEmpty() ? t : tile.details + ", " + t;
            if (Math.min(tile.name.length(), MAX_NAME) + 3 + details.length() > MAX_TILE) return false;
            tile.details = details;
            return true;
        }

        /** Takes out kids[i], putting its own kids in its place. */
        static void splice(List<Item> kids, int i) {
            Item gone = kids.remove(i);
            kids.addAll(i, gone.kids);
        }

        /** The last checks on the whole list: same-box twins and decoration images go. */
        static List<Element> finish(List<Item> flat) {
            int n = flat.size();
            boolean[] drop = new boolean[n];
            for (int i = 0; i < n; i++) {
                Item e = flat.get(i);
                if (!e.acts && (e.kind.equals("text") || e.kind.equals("image"))) {
                    // A text or picture saying again what a tappable thing in the same box says.
                    for (int j = 0; j < n && !drop[i]; j++) {
                        Item f = flat.get(j);
                        if (j != i && f.acts && sameBox(e.box, f.box) && related(e.name, f.name)) drop[i] = true;
                    }
                }
                if (!drop[i] && e.kind.equals("image") && !e.acts) {
                    if (decoration(e.name)) drop[i] = true;
                    else if ((i > 0 && related(e.name, flat.get(i - 1).name)) || (i + 1 < n && related(e.name, flat.get(i + 1).name))) drop[i] = true;
                }
                if (!drop[i] && e.acts && !e.enabled && e.name.isEmpty()) {
                    // An unnamed disabled copy of something else in the same place: the hero card's twin.
                    for (int j = 0; j < n && !drop[i]; j++) {
                        Item f = flat.get(j);
                        if (j != i && !drop[j] && sameBox(e.box, f.box) && (f.enabled || !f.name.isEmpty() || j < i)) drop[i] = true;
                    }
                }
            }
            List<Element> out = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                if (drop[i]) continue;
                Item e = flat.get(i);
                out.add(new Element(e.kind, e.name, e.details, e.value, e.box, e.focused, e.enabled, e.scrollable, e.password, e.way, e.handle));
            }
            return out;
        }

        static boolean sameBox(int[] a, int[] b) {
            for (int i = 0; i < 4; i++) if (Math.abs(a[i] - b[i]) > 2) return false;
            return true;
        }

        static boolean inside(int[] in, int[] box) {
            return in[0] >= box[0] - 2 && in[1] >= box[1] - 2 && in[2] <= box[2] + 2 && in[3] <= box[3] + 2;
        }

        private static final java.util.regex.Pattern ICON = java.util.regex.Pattern.compile("\\bicons?\\b");

        /** A picture's name that says nothing an agent can use: "Star icon representing rating", "Cover, image". */
        static boolean decoration(String name) {
            String l = name.toLowerCase(Locale.ROOT).trim();
            return l.isEmpty() || l.equals("image") || l.endsWith(", image") || ICON.matcher(l).find();
        }

        /** One name the same as the other or the start of it, once ", image" and punctuation are set aside. */
        static boolean related(String a, String b) {
            String x = base(a, true), y = base(b, true);
            if (x.isEmpty() || y.isEmpty()) return false;
            return x.equals(y) || y.startsWith(x) || x.startsWith(y);
        }

        /** A name without a trailing ", image" (and, for comparing, in lower case). */
        static String base(String s, boolean lower) {
            String t = s.trim();
            String l = t.toLowerCase(Locale.ROOT);
            if (l.endsWith(", image")) t = t.substring(0, t.length() - 7);
            else if (l.equals("image")) t = "";
            t = trimJoiners(t);
            return lower ? t.toLowerCase(Locale.ROOT) : t;
        }

        /** "4.3 (1.2K) •" as "4.3 (1.2K)": the separators a tile puts between its texts, cut off the ends. */
        static String trimJoiners(String s) {
            int a = 0, b = s.length();
            while (a < b && " •·|,;:-–—".indexOf(s.charAt(a)) >= 0) a++;
            while (b > a && " •·|,;:-–—".indexOf(s.charAt(b - 1)) >= 0) b--;
            return s.substring(a, b);
        }

        static boolean saidAlready(String label, List<String> said) {
            String l = label.toLowerCase(Locale.ROOT);
            for (String s : said) {
                String a = s.toLowerCase(Locale.ROOT);
                if (a.equals(l) || (l.length() >= 4 && a.contains(l))) return true;
                for (String part : a.split(" · |, ")) if (part.trim().equals(l)) return true;
            }
            return false;
        }

        String kind(Node n, boolean edit, boolean acts, boolean inList) {
            String c = n.cls;
            String s = c.substring(c.lastIndexOf('.') + 1);
            if (edit) return n.password ? "password" : "edit";
            if (n.scrollable) return "list";
            if (s.equals("CheckBox") || s.equals("CheckedTextView")) return "checkbox";
            if (s.equals("Switch") || s.equals("SwitchCompat") || s.equals("ToggleButton")) return "switch";
            if (s.equals("RadioButton")) return "radiobutton";
            if (s.equals("SeekBar") || s.equals("RatingBar")) return "slider";
            if (s.equals("Spinner")) return "combobox";
            if (s.equals("ProgressBar")) return "progressbar";
            if (s.equals("WebView")) return "document";
            if (n.checkable) return "checkbox";
            if (acts) {
                if (s.contains("Tab")) return "tabitem";
                if (s.equals("Button") || s.equals("ImageButton")) return "button";
                return inList ? "listitem" : "button";
            }
            if (s.equals("ImageView") || s.equals("Image")) return "image";
            return "text";
        }

        static String scrollWay(Node n) {
            String c = n.cls;
            if (c.contains("Horizontal") || c.contains("ViewPager")) return "sideways";
            int w = n.box[2] - n.box[0], h = n.box[3] - n.box[1];
            // React Native lists say only "ScrollView": a wide, short one is a row.
            return w > 3 * h ? "sideways" : null;
        }
    }

    static boolean isEdit(Node n) {
        return n.cls.endsWith("EditText") || n.cls.endsWith("AutoCompleteTextView") || n.cls.endsWith("SearchView$SearchAutoComplete") || n.password;
    }

    private static String first(String a, String b) {
        return !a.isEmpty() ? a : b;
    }

    /** "search_input" from "com.oculus.store:id/search_input" as "search input". */
    static String idWords(String resId) {
        if (resId.isEmpty()) return "";
        String s = resId.substring(resId.indexOf('/') + 1);
        return s.replace('_', ' ').trim();
    }

    static String clip(String s, int n) {
        return s.length() > n ? s.substring(0, n - 1) + "…" : s;
    }

    /** `s` cut to at most n characters at a word where there is one near the end, with an ellipsis. */
    static String clipWords(String s, int n) {
        if (s.length() <= n) return s;
        String cut = s.substring(0, n - 1);
        int space = cut.lastIndexOf(' ');
        if (space > n * 2 / 3) cut = cut.substring(0, space);
        int b = cut.length();
        while (b > 0 && " ,;:.-–—•·".indexOf(cut.charAt(b - 1)) >= 0) b--;
        return cut.substring(0, b) + "…";
    }
}
