package dev.vortexaxis.quest.core;

import static dev.vortexaxis.quest.core.T.check;
import static dev.vortexaxis.quest.core.T.equal;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The pure parts: the dump parser against a Store-like fixture (React Native labels, a sideways row,
 * tiles scrolled off the panel, a password field, a tappable tile inside a tappable tile), and the
 * address, JSON, escaping and key rules.
 */
public class UnitTest {
    public static void main(String[] args) throws Exception {
        panel();
        address();
        json();
        typing();
        urls();
        keys();
        logRedaction();
        System.out.println("UnitTest: ALL PASS (" + T.checks + " checks)");
    }

    static List<String> lines(Panel p) {
        List<String> out = new ArrayList<>();
        for (int i = 0; i < p.elements.size(); i++) out.add(p.elements.get(i).line(i + 1));
        return out;
    }

    static void panel() throws Exception {
        System.out.println("[panel] the Store fixture, compacted");
        String raw = T.fixture("store-panel.xml");
        String printed = "UI hierchary dumped to: /data/local/tmp/x.xml\n" + raw;
        String xml = Panel.extractXml(printed);
        check(xml != null && xml.startsWith("<?xml") && xml.endsWith("</hierarchy>"), "the XML is cut out of uiautomator's output");
        Panel p = Panel.parse(xml);
        List<String> l = lines(p);
        for (String s : l) System.out.println("     | " + s);
        equal(p.pkg, "com.oculus.store", "the panel's package");
        equal(p.window(), "Store (com.oculus.store)", "the window is named");
        check(p.nodes >= 30, "every node counted: " + p.nodes);
        equal(l, java.util.Arrays.asList(
                "1 button 16,16 64x64 Back",
                "2 text 100,20 200x56 Store",
                "3 edit 400,20 500x56 Search apps and games",
                "4 button 950,20 150x56 Browse = selected",
                "5 list 0,100 1280x700 *scrolls",
                "6 text 24,110 276x40 Top free",
                "7 list 0,160 1280x260 *scrolls sideways",
                "8 listitem 24,170 300x240 Beyond Sandbox — Free",
                "9 listitem 340,170 300x240 Horizon Worlds, Free",
                "10 listitem 656,170 300x240 Cloud Garden",
                "11 button 860,372 86x32 Get",
                "12 listitem 972,170 300x240 Echo Valley *disabled",
                "13 text 24,440 376x40 Sign in to buy",
                "14 edit 24,490 576x60 Email",
                "15 password 24,560 576x60 Password",
                "16 checkbox 620,575 200x30 Remember me = on",
                "17 button 24,640 176x60 Sign in"), "the compact element list");
        check(l.stream().noneMatch(s -> s.contains("Starfall")), "a tile scrolled to a 10-pixel sliver at the edge is left out");
        check(l.stream().noneMatch(s -> s.contains("Deep Orbit")), "a tile wholly off the panel is left out");
        check(l.stream().noneMatch(s -> s.contains("Recommended")), "a line cut to a sliver at the bottom is left out");
        check(l.stream().noneMatch(s -> s.contains("•")), "a password field's content is never sent");
        Panel.Element pw = p.elements.get(14);
        check(pw.password && pw.value == null, "the password field is marked and carries no value");
        check(!p.passwordFocused, "no password field has the focus");
        Panel focused = Panel.parse(xml.replace("content-desc=\"Password\" checkable=\"false\" checked=\"false\" clickable=\"true\" enabled=\"true\" focusable=\"true\" focused=\"false\"",
                "content-desc=\"Password\" checkable=\"false\" checked=\"false\" clickable=\"true\" enabled=\"true\" focusable=\"true\" focused=\"true\""));
        check(focused.passwordFocused, "a focused password field is seen");
        check(focused.elements.get(14).line(15).endsWith("*focus"), "and marked *focus");
        for (Panel.Element e : p.elements) check(e.x >= 0 && e.y >= 0 && e.x + e.w <= 1280 && e.y + e.h <= 800, "inside the panel: " + e.name + " " + e.x + "," + e.y + " " + e.w + "x" + e.h);

        System.out.println("[panel] boxes clipped to the panel");
        Panel clipped = Panel.parse("<?xml version='1.0'?><hierarchy><node class=\"android.widget.FrameLayout\" package=\"p.q\" text=\"\" content-desc=\"\" bounds=\"[0,0][1280,800]\">"
                + "<node class=\"android.widget.Button\" package=\"p.q\" text=\"Wide\" clickable=\"true\" bounds=\"[-100,700][1400,900]\"/></node></hierarchy>");
        equal(lines(clipped), java.util.Arrays.asList("1 button 0,700 1280x100 Wide"), "a box that runs past the panel is cut to it");

        System.out.println("[panel] matching by name, as on Windows");
        List<int[]> m = PanelCommands.match(p.elements, "beyond sandbox", null);
        equal(m.get(0)[0], 7, "\"beyond sandbox\" finds the tile named from its text");
        equal(PanelCommands.match(p.elements, "Get", "button").get(0)[0], 10, "\"Get\" finds the button inside the tile");
        check(PanelCommands.match(p.elements, "zzz", null).isEmpty(), "nothing for a name not there");
        equal(PanelCommands.pick(p.elements, 5).size(), 5, "pick keeps at most max");
        check(PanelCommands.pick(p.elements, 5).stream().noneMatch(e -> e.kind.equals("text")), "pick prefers things that can be used");

        System.out.println("[panel] a dump with something odd in it");
        try {
            Panel.parse("<?xml version='1.0'?><!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]><hierarchy><node text=\"&e;\"/></hierarchy>");
            check(false, "a DOCTYPE is refused");
        } catch (IllegalArgumentException e) {
            check(true, "a DOCTYPE (an entity reaching for a file) is refused: " + e.getMessage());
        }
        check(Panel.extractXml("ERROR: could not get idle state.") == null, "no XML in an error is seen as no XML");
        home();
    }

    /** The Store's front page as a real look showed it: 52 lines before the tidying, 24 after. */
    static void home() throws Exception {
        System.out.println("[panel] the Store's front page, tidied");
        Panel p = Panel.parse(Panel.extractXml(T.fixture("store-home.xml")));
        List<String> l = lines(p);
        for (String s : l) System.out.println("     | " + s);
        check(p.elements.size() <= 26, "a short list: " + p.elements.size() + " elements from " + p.nodes + " nodes (0.1.0 kept 52)");
        equal(l.subList(0, 8), java.util.Arrays.asList(
                "1 button 31,30 84x40 Home = selected",
                "2 button 125,30 117x40 Top charts",
                "3 button 252,30 128x40 Categories",
                "4 button 390,30 80x40 Deals",
                "5 button 480,30 90x40 Library",
                "6 edit 877,30 221x40 Search",
                "7 button 1119,30 61x40 Your Meta Credits balance is 0. Meta Credits can no longer be purchased on the…",
                "8 button 1200,20 60x60 Sam"), "the header row first, left to right, though it comes last in the dump");
        check(l.stream().noneMatch(s -> s.contains("Star icon") || s.contains("Credits icon") || s.contains(", image")), "no decoration images, no image twins");
        equal(l.get(8), "9 button 30,0 228x72 Unplugged: Air Guitar, $19.99 — 4.3 (1.2K), Games • Rhythm", "a tile carries its rating and genre, the trailing bullet gone");
        check(l.stream().noneMatch(s -> s.matches("\\d+ text .*(4\\.\\d \\(|Games •|Fitness •).*")), "and those texts are not listed again");
        check(l.contains("16 button 452,122 794x446"), "the unnamed hero card stays, as kind and box");
        check(l.stream().noneMatch(s -> s.contains("*disabled")), "its unnamed disabled twin is gone");
        check(l.contains("20 list 0,660 1280x140 *scrolls sideways") && l.get(20).startsWith("21 listitem 30,669 228x131 DeoVR - VR Video Player, Free"), "the bottom row is still a list, its tiles after it");
        check(l.stream().filter(s -> s.contains("DeoVR")).count() == 1, "the DeoVR tile once, without its same-box text twin");
        Panel.Element credits = p.elements.get(6);
        check(credits.name.endsWith("Meta Horizon Store.") && credits.name.length() == 98, "a long label is cut on the line only; its name is whole for matching");
        for (Panel.Element e : p.elements) check(e.line(1).length() < 160, "every line is short: " + e.line(1).length());

        System.out.println("[panel] names still found by their short form");
        List<int[]> m = PanelCommands.match(p.elements, "Elixir", null);
        check(!m.isEmpty() && p.elements.get(m.get(0)[0]).name.startsWith("Elixir, Free — "), "\"Elixir\" finds its tile: " + (m.isEmpty() ? "nothing" : p.elements.get(m.get(0)[0]).name));
        check(m.size() == 1 || m.get(1)[1] < m.get(0)[1], "and only it best");
        equal(PanelCommands.match(p.elements, "can no longer be purchased", null).get(0)[0], 6, "a word from the cut-off end of a long label still finds it");
        equal(PanelCommands.match(p.elements, "Search", "edit").get(0)[0], 5, "the search field by name");

        System.out.println("[panel] the tidying rules on their own");
        Panel unnamed = Panel.parse("<?xml version='1.0'?><hierarchy><node class=\"android.widget.FrameLayout\" package=\"p.q\" bounds=\"[0,0][1280,800]\">"
                + "<node class=\"android.view.ViewGroup\" package=\"p.q\" clickable=\"true\" bounds=\"[0,0][200,100]\"><node class=\"android.widget.ImageView\" package=\"p.q\" content-desc=\"Settings icon\" bounds=\"[10,10][50,50]\"/></node>"
                + "<node class=\"android.widget.ImageView\" package=\"p.q\" content-desc=\"Mountain at dawn\" bounds=\"[300,0][600,200]\"/>"
                + "<node class=\"android.view.ViewGroup\" package=\"p.q\" clickable=\"true\" bounds=\"[700,0][900,100]\"><node class=\"android.widget.TextView\" package=\"p.q\" text=\"Play\" bounds=\"[710,10][800,40]\"/><node class=\"android.widget.TextView\" package=\"p.q\" text=\"Free •\" bounds=\"[710,50][800,90]\"/></node>"
                + "</node></hierarchy>");
        equal(lines(unnamed), java.util.Arrays.asList("1 button 0,0 200x100 Settings icon", "2 image 300,0 300x200 Mountain at dawn", "3 button 700,0 200x100 Play — Free"),
                "an icon that is all a button has names it; a picture with a real name stays; an unnamed tile is named by its first text");
    }

    static void address() {
        System.out.println("[address] as the Windows app reads them");
        AxisAddress a = AxisAddress.parse("192.168.1.20:8440");
        equal(a.http, "http://192.168.1.20:8440", "host:port is plain http");
        equal(a.socketUrl(), "ws://192.168.1.20:8440/v1/client", "its socket");
        equal(a.pairUrl(), "http://192.168.1.20:8440/v1/pair", "its pairing address");
        AxisAddress b = AxisAddress.parse("axis.example.org");
        equal(b.http, "https://axis.example.org", "a bare name is https");
        equal(b.socketUrl(), "wss://axis.example.org/v1/client", "and wss");
        AxisAddress c = AxisAddress.parse("axis://192.168.1.20:8440/123456");
        equal(c.http + " " + c.code, "http://192.168.1.20:8440 123456", "a setup string carries the code");
        AxisAddress d = AxisAddress.parse("axis+tls://axis.example.org/654321/");
        equal(d.http + " " + d.code, "https://axis.example.org 654321", "axis+tls is https");
        equal(AxisAddress.parse("https://axis.example.org:443/admin").http, "https://axis.example.org", "a path and the default port are dropped");
        equal(AxisAddress.parse("http://axis.example.org:8080").socketUrl(), "ws://axis.example.org:8080/v1/client", "an explicit scheme wins");
        for (String bad : new String[] {"", "   ", "http://", "http://user:pw@host:1"}) {
            try {
                AxisAddress.parse(bad);
                check(false, "\"" + bad + "\" is refused");
            } catch (IllegalArgumentException e) {
                check(true, "\"" + bad + "\" is refused: " + e.getMessage());
            }
        }
    }

    static void json() {
        System.out.println("[json]");
        Map<String, Object> m = Json.parseObject("{\"t\":\"command\",\"id\":\"c1\",\"params\":{\"x\":12,\"y\":3.5,\"ok\":true,\"s\":\"a\\\"b\\u00e9\\n\"},\"data\":{\"steps\":[{\"action\":\"click\"}]},\"n\":null}");
        equal(Json.str(m, "t"), "command", "a string");
        Map<String, Object> p = Json.map(m.get("params"));
        equal(Json.integer(p, "x"), 12, "a whole number");
        equal(p.get("y"), 3.5, "a fraction");
        equal(p.get("s"), "a\"bé\n", "escapes");
        equal(Json.list(Json.map(m.get("data")).get("steps")).size(), 1, "an array");
        check(m.containsKey("n") && m.get("n") == null, "null");
        String w = Json.write(Json.obj("a", "x\"y\u0001 ", "b", 1, "c", 2.0, "d", 2.5, "e", java.util.Arrays.asList(true, null)));
        equal(w, "{\"a\":\"x\\\"y\\u0001\\u2028\",\"b\":1,\"c\":2,\"d\":2.5,\"e\":[true,null]}", "writing");
        equal(Json.parse(w), Json.parse(w), "round trip parses");
    }

    static void typing() {
        System.out.println("[type] escaping for adb's input text");
        equal(Shell.typeCommands("hello world"), java.util.Arrays.asList("input text 'hello%sworld'"), "spaces as %s, single-quoted");
        equal(Shell.typeCommands("'; reboot #"), java.util.Arrays.asList("input text ''\\'';%sreboot%s#'"), "a quote and a command stay text");
        equal(Shell.typeCommands("say \"hi\" & $(id) `x` \\ |"), java.util.Arrays.asList("input text 'say%s\"hi\"%s&%s$(id)%s`x`%s\\%s|'"), "shell metacharacters stay inside the quotes");
        equal(Shell.typeCommands("one\ntwo\tthree"), java.util.Arrays.asList("input text 'one'", "input keyevent 66", "input text 'two'", "input keyevent 61", "input text 'three'"), "newline is Enter, tab is Tab");
        equal(Shell.typeCommands("100%"), java.util.Arrays.asList("input text '100%'"), "a lone % is fine");
        for (String bad : new String[] {"café", "日本", "smile 😀", "bell \u0007", "50%s off"}) {
            try {
                Shell.typeCommands(bad);
                check(false, "refused: " + bad);
            } catch (IllegalArgumentException e) {
                check(true, "refused with words (" + e.getMessage().substring(0, Math.min(60, e.getMessage().length())) + "…)");
            }
        }
        equal(Shell.quote("a'b"), "'a'\\''b'", "quote");
    }

    static void urls() {
        System.out.println("[open] addresses");
        equal(Shell.checkUrl("https://example.org/a?b=1&c=2"), "https://example.org/a?b=1&c=2", "a plain https address passes");
        for (String bad : new String[] {"javascript:alert(1)", "file:///sdcard/x", "https://exa mple.org", "https://example.org/\n", "content://x/y", "https:///nohost", "intent://x#Intent;end", "https://example.org/é"}) {
            try {
                Shell.checkUrl(bad);
                check(false, "refused: " + bad);
            } catch (IllegalArgumentException e) {
                check(true, "refused: " + bad.replace("\n", "\\n") + " (" + e.getMessage() + ")");
            }
        }
        check(Shell.isPackage("com.oculus.browser"), "a package name");
        check(!Shell.isPackage("com.x; reboot"), "not a package name");
        check(!Shell.isPackage("browser"), "a name without a dot is not a package");
    }

    static void keys() {
        System.out.println("[keys]");
        equal(Keys.parse("Enter").command(), "input keyevent 66", "enter");
        equal(Keys.parse("esc").command(), "input keyevent 111", "esc");
        equal(Keys.parse("back").command(), "input keyevent 4", "back");
        equal(Keys.parse("home").command(), "input keyevent 122", "home is the text cursor key, not the Quest's Home");
        equal(Keys.parse("ctrl+a").command(), "input keycombination 113 29", "ctrl+a as a combination");
        equal(Keys.parse("Ctrl + Shift + Z").toString(), "ctrl+shift+z", "spaces and case");
        for (String bad : new String[] {"power", "sleep", "win+l", "alt+f4x", "", "hyper+a", "recents"}) {
            try {
                Keys.parse(bad);
                check(false, "refused: " + bad);
            } catch (IllegalArgumentException e) {
                check(true, "refused: \"" + bad + "\" (" + e.getMessage() + ")");
            }
        }
    }

    static void logRedaction() {
        System.out.println("[log]");
        equal(RollingLog.redact("hello {\"token\":\"abc123\",\"x\":1} token=zzz"), "hello {\"token\":\"***\",\"x\":1} token=***", "tokens are cut out of log lines");
        equal(PanelCommands.summary("desktop.type", Json.obj("text", "my secret words", "name", "Search")), " (text: 15 chars, name: Search)", "typed text is logged as its length only");
    }
}
