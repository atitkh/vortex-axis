package dev.vortexaxis.quest.core;

import static dev.vortexaxis.quest.core.T.check;
import static dev.vortexaxis.quest.core.T.equal;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * The command layer over the real adb client and a pretend adbd: the exact shell commands each
 * desktop.* command sends, the guards (pause, allowLook, allowInput, password fields, keys never
 * pressed, addresses never opened), deadlines, a dropped connection, and one command at a time.
 */
public class CommandsTest {
    static FakeAdbd adbd;
    static PanelCommands cmds;
    static AdbLink adb;
    static final String[] xml = new String[1];
    static final String[] focus = {"com.oculus.store"};
    static String plain;

    public static void main(String[] args) throws Exception {
        plain = Panel.extractXml(T.fixture("store-panel.xml"));
        xml[0] = plain;
        adbd = new FakeAdbd();
        adbd.answer = T.headset(xml, focus);
        RollingLog log = T.log();
        adb = new AdbLink("127.0.0.1", adbd.port(), new T.MemoryKeys(), "vortexaxis@quest", log);
        cmds = new PanelCommands(adb, log, "0.1.0-test");
        cmds.sleeper = ms -> Thread.sleep(Math.min(ms, 20));
        cmds.setPictures(new T.JvmPictures());
        List<String> diary = new ArrayList<>();
        cmds.setDiary(diary::add);

        setUp();
        look();
        click();
        drag();
        type();
        keys();
        scroll();
        open();
        unsupported();
        guards();
        screenshot();
        steps();
        waits();
        deadlines();
        oneAtATime();
        check(diary.stream().anyMatch(d -> d.startsWith("Tapped \"Beyond Sandbox")), "the app's Recently list heard what was done: " + diary.size() + " entries");
        check(diary.stream().noneMatch(d -> d.contains("hello world") || d.contains("reboot")), "Recently never holds typed text");
        adbd.close();
        System.out.println("CommandsTest: ALL PASS (" + T.checks + " checks)");
    }

    static AxisLink.Answer run(String name, Object... kv) {
        return cmds.handle(name, Json.obj(kv));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> data(AxisLink.Answer a) { return (Map<String, Object>) a.data; }

    /** The commands sent other than the cheap "what is in front" reads every action makes. */
    static List<String> acted() {
        List<String> out = new ArrayList<>();
        for (String c : adbd.take()) if (!c.startsWith("dumpsys window")) out.add(c);
        return out;
    }

    static void setUp() throws Exception {
        System.out.println("[adb] the first connection offers the key, as Set up does");
        try {
            adb.connect(0);
            check(false, "a command's connect never offers the key");
        } catch (java.io.IOException e) {
            check(adb.state() == AdbLink.State.NEEDS_ALLOW, "without the key allowed, the state says to tap Allow: " + e.getMessage());
            check(adbd.publicKeys.isEmpty(), "and nothing was offered (no dialog raised by a command)");
        }
        adb.connect(AdbLink.APPROVAL_MS);
        check(adb.state() == AdbLink.State.READY, "Set up: the key was offered and allowed, adb is ready");
        adb.close();
        adb.connect(0);
        check(adb.state() == AdbLink.State.READY, "the next connection signs in with the remembered key, no dialog");
        equal(adbd.publicKeys.size(), 1, "the key was offered once");
        adbd.take();
    }

    static void look() {
        System.out.println("[look]");
        AxisLink.Answer a = run("desktop.look", "scope", "window", "ocr", false);
        check(a.ok, "look answered");
        Map<String, Object> d = data(a);
        List<Object> el = Json.list(d.get("elements"));
        equal(el.size(), 17, "17 elements");
        equal(el.get(7), "8 listitem 24,170 300x240 Beyond Sandbox — Free", "an element line");
        equal(d.get("window"), "Store (com.oculus.store) 0,0 1280x800", "the window line");
        equal(d.get("screen"), "0,0 1280x800", "the screen box");
        List<String> sent = acted();
        equal(sent, Arrays.asList("rm -f " + PanelCommands.DUMP + "; uiautomator dump " + PanelCommands.DUMP, "cat " + PanelCommands.DUMP + "; rm -f " + PanelCommands.DUMP),
                "the dump, then its file read back with cat (two calls, timed apart)");
        check(Json.write(a.data).length() < 1500, "the whole look is small: " + Json.write(a.data).length() + " characters");
        PanelCommands.Timing t = cmds.lastTiming();
        check(t != null && !t.compressed && t.nodes == 35 && t.kept == 17 && t.totalMs >= t.dumpMs + t.readMs, "the look's timing is kept: " + t);
        check(t.toString().matches("35 nodes, 17 kept; dump \\d+ ms, read \\d+ ms, parse \\d+ ms, total \\d+ ms"), "and said as the split: " + t);

        System.out.println("[look] Faster looks: --compressed");
        cmds.compressed = true;
        check(run("desktop.look").ok, "a compressed look answered");
        equal(acted().get(0), "rm -f " + PanelCommands.DUMP + "; uiautomator dump --compressed " + PanelCommands.DUMP, "uiautomator dump --compressed");
        check(cmds.lastTiming().compressed, "its timing says compressed");
        cmds.compressed = false;
        try {
            PanelCommands.TestResult r = cmds.test();
            check(r.plain != null && !r.plain.compressed && r.compressed != null && r.compressed.compressed && r.panel.elements.size() == 17, "Test reads both ways: " + r.plain + " / " + r.compressed);
            List<String> both = acted();
            check(both.contains("rm -f " + PanelCommands.DUMP + "; uiautomator dump " + PanelCommands.DUMP) && both.contains("rm -f " + PanelCommands.DUMP + "; uiautomator dump --compressed " + PanelCommands.DUMP), "a plain dump and a compressed one");
            check(!cmds.lastTiming().compressed, "with Faster looks off, the timing kept is the plain one");
        } catch (Exception e) {
            check(false, "Test: " + e);
        }

        AxisLink.Answer f = run("desktop.find", "name", "horizon");
        equal(Json.list(data(f).get("matches")), Arrays.asList("9 listitem 340,170 300x240 Horizon Worlds, Free"), "find gives the match with its id");
        acted();
    }

    static void click() {
        System.out.println("[click]");
        AxisLink.Answer a = run("desktop.click", "name", "Beyond Sandbox", "button", "left");
        check(a.ok, "click by name: " + a.error);
        equal(acted().get(2), "input tap 174 290", "a tap at the tile's centre (after a fresh dump)");
        equal(a.payload.get("how") + " " + a.payload.get("name"), "tap Beyond Sandbox — Free", "says how and what");
        Map<String, Object> after = Json.map(data(a).get("after"));
        equal(after.get("window"), "Store (com.oculus.store)", "after: the panel in front");

        run("desktop.look");
        acted();
        a = run("desktop.click", "id", 11, "button", "double");
        equal(acted(), Arrays.asList("input tap 903 388 && input tap 903 388"), "a double tap on id 11 (Get), no dump needed");
        a = run("desktop.click", "id", 2, "button", "right");
        equal(acted(), Arrays.asList("input swipe 200 48 200 48 800"), "right is a long press");
        a = run("desktop.click", "x", 10, "y", 20);
        equal(acted(), Arrays.asList("input tap 10 20"), "a tap at x,y");
        a = run("desktop.click", "x", 1280, "y", 20);
        check(!a.ok && a.error.contains("outside the panel"), "x,y off the panel refused: " + a.error);
        a = run("desktop.click", "id", 99);
        check(!a.ok && a.error.contains("no element 99"), "a stale id refused");
        a = run("desktop.click", "name", "Nothing Here");
        check(!a.ok && a.error.contains("nothing called"), "an unknown name refused with where it looked");
        a = run("desktop.click", "name", "Free");
        check(a.ok || a.error.contains("equally"), "a name that fits two tiles equally asks for an id, or picks one: " + (a.ok ? a.payload : a.error));
        check(acted().stream().noneMatch(c -> c.startsWith("input") && c.contains("1280")), "nothing was tapped off the panel");

        System.out.println("[click] a focus line in another form, and the panel changing");
        focus[0] = "com.oculus.browser";
        a = run("desktop.click", "x", 5, "y", 5);
        check(Json.map(data(a).get("after")).get("window").equals("Browser (com.oculus.browser)"), "after names the new panel");
        focus[0] = "com.oculus.store";
        acted();
    }

    static void type() {
        System.out.println("[type]");
        AxisLink.Answer a = run("desktop.type", "text", "hello world", "name", "Search");
        check(a.ok, "type into a field by name: " + a.error);
        List<String> sent = acted();
        equal(sent.subList(2, sent.size()), Arrays.asList("input tap 650 48", "input text 'hello%sworld'"), "tap the field, then input text");
        equal(a.payload.get("typed"), 11, "says how many characters");

        run("desktop.look");
        acted();
        run("desktop.type", "text", "'; reboot #", "id", 3);
        equal(acted(), Arrays.asList("input tap 650 48", "input text ''\\'';%sreboot%s#'"), "an injection attempt is typed as text");
        run("desktop.type", "text", "a \"b\" $(id) `c`\nnext", "id", 3);
        equal(acted(), Arrays.asList("input tap 650 48", "input text 'a%s\"b\"%s$(id)%s`c`' && input keyevent 66 && input text 'next'"), "quotes, $( ) and backticks stay inside quotes; a newline is Enter");
        a = run("desktop.type", "text", "naïve", "id", 3);
        check(!a.ok && a.error.contains("ASCII"), "non-ASCII refused clearly: " + a.error);
        check(acted().isEmpty(), "and nothing was sent");
        a = run("desktop.type", "text", "x".repeat(501), "id", 3);
        check(!a.ok && a.error.contains("500"), "over 500 characters refused");

        System.out.println("[type] password fields");
        a = run("desktop.type", "text", "hunter2", "name", "Password");
        check(!a.ok && a.error.contains("password"), "never types into a password field by name: " + a.error);
        a = run("desktop.type", "text", "hunter2", "id", 15);
        check(!a.ok && a.error.contains("password"), "nor by id");
        xml[0] = focusPassword();
        a = run("desktop.type", "text", "hunter2");
        check(!a.ok && a.error.contains("password"), "nor blind into the focus when a password field has it: " + a.error);
        check(acted().stream().noneMatch(c -> c.startsWith("input")), "no input command was sent for any of them");
        xml[0] = plain;
        a = run("desktop.type", "text", "ok");
        check(a.ok, "blind typing when no password field has the focus");
        equal(acted().get(2), "input text 'ok'", "typed into the focus after checking it");
    }

    static String focusPassword() {
        return focusPassword0(plain);
    }

    static String focusPassword0(String plain) {
        return plain.replace("content-desc=\"Password\" checkable=\"false\" checked=\"false\" clickable=\"true\" enabled=\"true\" focusable=\"true\" focused=\"false\"",
                "content-desc=\"Password\" checkable=\"false\" checked=\"false\" clickable=\"true\" enabled=\"true\" focusable=\"true\" focused=\"true\"");
    }

    static void keys() {
        System.out.println("[keys]");
        AxisLink.Answer a = run("desktop.keys", "keys", "enter");
        check(a.ok && "enter".equals(a.payload.get("pressed")), "enter pressed");
        equal(acted(), Arrays.asList("input keyevent 66"), "as a keyevent");
        run("desktop.keys", "keys", "back");
        equal(acted(), Arrays.asList("input keyevent 4"), "back");
        run("desktop.keys", "keys", "ctrl+a");
        equal(acted(), Arrays.asList("input keycombination 113 29"), "ctrl+a as a key combination");
        a = run("desktop.keys", "keys", "power");
        check(!a.ok && a.error.contains("never presses"), "power refused: " + a.error);
        a = run("desktop.keys", "keys", "win+l");
        check(!a.ok, "win+l refused: " + a.error);
        check(acted().isEmpty(), "nothing sent for refused keys");
        adbd.answer = cmd -> cmd.startsWith("input keycombination") ? "Error: Unknown command: keycombination\nUsage: input [<source>] <command> [<arg>...]\n".getBytes() : T.headset(xml, focus).apply(cmd);
        a = run("desktop.keys", "keys", "ctrl+c");
        check(!a.ok && a.error.contains("cannot press key combinations"), "an older Android without keycombination says so: " + a.error);
        adbd.answer = T.headset(xml, focus);
        acted();
    }

    static void scroll() {
        System.out.println("[scroll]");
        run("desktop.look");
        acted();
        AxisLink.Answer a = run("desktop.scroll", "go", "down", "pages", 1);
        check(a.ok, "scroll down");
        equal(acted(), Arrays.asList("input swipe 640 625 640 275 400"), "a swipe up the biggest vertical list (the page)");
        run("desktop.scroll", "go", "right", "pages", 2, "id", 7);
        equal(acted(), Arrays.asList("input swipe 960 290 320 290 400 && input swipe 960 290 320 290 400"), "two pages sideways in the row by id");
        run("desktop.scroll", "go", "left");
        equal(acted(), Arrays.asList("input swipe 320 290 960 290 400"), "left without a target finds the sideways row");
        run("desktop.scroll", "go", "top");
        List<String> top = acted();
        equal(top.size(), 1, "top is one command");
        equal(top.get(0).split(" && ").length, 8, "of eight quick swipes");
        check(top.get(0).startsWith("input swipe 640 275 640 625 120"), "downwards (content to the top)");
        a = run("desktop.scroll", "go", "sideways");
        check(!a.ok, "a direction that is not one refused");
    }

    static void open() {
        System.out.println("[open]");
        AxisLink.Answer a = run("desktop.open", "url", "https://example.org/a?b=1&c='x'");
        check(a.ok, "open an address: " + a.error);
        equal(acted(), Arrays.asList("am start -a android.intent.action.VIEW -d 'https://example.org/a?b=1&c='\\''x'\\'''"), "am start with the address quoted");
        for (String bad : new String[] {"file:///sdcard/secret", "https://x.example/; reboot", "javascript:alert(1)"}) {
            a = run("desktop.open", "url", bad);
            check(!a.ok, "refused: " + bad + " (" + a.error + ")");
        }
        check(acted().isEmpty(), "nothing sent for refused addresses");
        a = run("desktop.open", "app", "Settings");
        equal(acted(), Arrays.asList("am start -a android.settings.SETTINGS"), "Settings by its intent");
        a = run("desktop.open", "app", "Browser");
        List<String> sent = acted();
        equal(sent.get(sent.size() - 1), "monkey -p com.oculus.browser -c android.intent.category.LAUNCHER 1", "the Browser from adb's list of launchable apps");
        a = run("desktop.open", "app", "chess");
        sent = acted();
        equal(sent.get(sent.size() - 1), "monkey -p com.example.chess -c android.intent.category.LAUNCHER 1", "an app by part of its package");
        cmds.setApps(() -> Arrays.asList(new String[] {"Beat Saber", "com.example.beats"}, new String[] {"Evil; app", "com.x; reboot"}));
        a = run("desktop.open", "app", "beat saber");
        sent = acted();
        equal(sent.get(sent.size() - 1), "monkey -p com.example.beats -c android.intent.category.LAUNCHER 1", "by the label Android gives it");
        a = run("desktop.open", "app", "Evil");
        check(!a.ok && a.error.contains("not a package name"), "a package name with shell in it is never run: " + a.error);
        check(acted().stream().noneMatch(c -> c.contains("reboot")), "nothing with reboot was sent");
        a = run("desktop.open", "app", "Not Installed At All");
        check(!a.ok && a.error.contains("no app called"), "an app not there: " + a.error);
        cmds.setApps(null);
        a = run("desktop.open", "app", "x", "url", "https://example.org");
        check(!a.ok, "app and url together refused");
        acted();

        System.out.println("[open] waits for the app to come forward, looking every 250 ms through the shell");
        List<Long> slept = new ArrayList<>();
        PanelCommands.Sleeper was = cmds.sleeper;
        cmds.sleeper = ms -> { slept.add(ms); Thread.sleep(Math.min(ms, 20)); };
        int[] polls = {0};
        adbd.answer = cmd -> {
            if (cmd.startsWith("monkey")) polls[0] = 0;
            if (cmd.startsWith("dumpsys window") && ++polls[0] >= 3) focus[0] = "com.example.chess";
            return T.headset(xml, focus).apply(cmd);
        };
        a = run("desktop.open", "app", "chess");
        List<String> polled = adbd.take();
        equal(polled.stream().filter(c -> c.startsWith("dumpsys window")).count(), 4L, "dumpsys window before, then until the app was in front (the third look), which is after");
        equal(slept, Arrays.asList(250L, 250L, 250L), "250 ms between looks, and no fixed wait after (0.3.2 slept 1200 ms)");
        Map<String, Object> after = Json.map(data(a).get("after"));
        check(String.valueOf(after.get("window")).contains("com.example.chess") && Json.isTrue(after, "new"), "after: the app, new: " + after);
        focus[0] = "com.oculus.store";
        adbd.answer = T.headset(xml, focus);
        slept.clear();
        run("desktop.click", "x", 5, "y", 5);
        equal(slept, Arrays.asList((long) PanelCommands.AFTER_MS), "a click through the shell: after read AFTER_MS later, as before");
        cmds.sleeper = was;
        acted();
    }

    static void drag() {
        System.out.println("[drag] a slow swipe, or drag and drop after a hold, through the shell; the block list");
        acted();
        AxisLink.Answer a = run("desktop.drag", "x", 10, "y", 20, "toX", 300, "toY", 40);
        check(a.ok && "swipe".equals(a.payload.get("how")), "dragged: " + a.error);
        equal(acted(), Arrays.asList("input swipe 10 20 300 40 400"), "input swipe over 400 ms");
        a = run("desktop.drag", "name", "Beyond Sandbox", "toX", 300, "toY", 40, "holdMs", 600);
        check(a.ok && "drag and drop".equals(a.payload.get("how")), "held first: " + a.error);
        check(acted().stream().anyMatch(c -> c.startsWith("input draganddrop ") && c.endsWith(" 300 40 1000")), "input draganddrop, with the hold in its time");
        check(!run("desktop.drag", "x", 1, "y", 1).ok, "no destination: refused");
        check(!run("desktop.drag", "x", 1, "y", 1, "toX", 5000, "toY", 1).ok, "off the panel: refused");
        a = run("desktop.look", "blocked", "bank|store");
        check(!a.ok && a.error.contains("blocked by the user (it matches \"store\")"), "the panel in front blocked: refused: " + a.error);
        check(acted().stream().noneMatch(c -> c.contains("uiautomator")), "and not read");
        check(!run("desktop.click", "x", 5, "y", 5, "blocked", "store").ok && acted().isEmpty(), "nor tapped");
        check(run("desktop.look", "blocked", "bank").ok, "another app blocked: read as before");
        acted();
    }

    static void unsupported() {
        System.out.println("[hello] nothing longer than Axis takes, long things as pieces");
        Map<String, Object> pcs = new java.util.LinkedHashMap<>();
        PanelCommands.pieces(pcs, "why", "x".repeat(450));
        equal(new java.util.ArrayList<>(pcs.keySet()), Arrays.asList("why", "why2", "why3"), "450 characters make three pieces");
        check(pcs.values().stream().allMatch(v -> ((String) v).length() <= 200), "none over 200 characters");
        PanelCommands.pieces(pcs, "empty", "");
        check(!pcs.containsKey("empty"), "an empty text makes none");
        Map<String, Object> hi = Json.map(run("desktop.hello").payload);
        check(hi != null && hi.values().stream().allMatch(v -> !(v instanceof String) || ((String) v).length() <= 240), "every value of hello is within 240 characters: " + hi);
        adbd.take();

        System.out.println("[unsupported on a Quest]");
        for (String n : new String[] {"window", "desktop", "clipboard", "paste"}) {
            AxisLink.Answer a = run("desktop." + n, "window", "Store", "do", "maximize", "go", "next", "text", "hi");
            check(!a.ok && (a.error.contains("Quest")), n + ": " + a.error);
        }
        check(acted().isEmpty(), "none of them touched adb");
        AxisLink.Answer p = run("desktop.point", "x", 100, "y", 200, "text", "This one");
        check(p.ok && Boolean.FALSE.equals(p.payload.get("shown")), "point is accepted and noted (not drawn)");
        check(run("desktop.hide").ok, "hide is accepted");
        AxisLink.Answer h = run("desktop.hello");
        check(h.ok && "meta-quest".equals(h.payload.get("platform")) && "ready".equals(h.payload.get("adb")), "hello says what it is and that adb is ready: " + h.payload);
        check(run("desktop.reboot").error.contains("not implemented"), "an unknown command");
        acted();
    }

    static void guards() {
        System.out.println("[guards]");
        cmds.paused = true;
        for (String n : new String[] {"look", "find", "click", "type", "keys", "scroll", "open", "screenshot", "steps", "hello"}) {
            AxisLink.Answer a = run("desktop." + n, "name", "Store", "text", "x", "keys", "enter", "x", 1, "y", 1, "url", "https://example.org");
            check(!a.ok && a.error.contains("paused"), n + " refused while paused");
        }
        check(acted().isEmpty(), "nothing reached adb while paused");
        cmds.paused = false;

        cmds.useSettings(Json.obj("allowLook", 0));
        check(run("desktop.look").error.contains("switched off"), "allowLook 0: look refused");
        check(run("desktop.find", "name", "x").error.contains("switched off"), "allowLook 0: find refused");
        cmds.useSettings(Json.obj("allowLook", 1, "allowInput", 0));
        check(run("desktop.look").ok, "allowLook 1: look goes on");
        for (String n : new String[] {"click", "type", "keys", "scroll", "open"}) {
            AxisLink.Answer a = run("desktop." + n, "x", 1, "y", 1, "text", "x", "keys", "enter", "url", "https://example.org");
            check(!a.ok && a.error.contains("switched off"), "allowInput 0: " + n + " refused");
        }
        check(acted().stream().noneMatch(c -> c.startsWith("input") || c.startsWith("am") || c.startsWith("monkey")), "and none acted");
        cmds.useSettings(Json.obj("allowLook", true, "allowInput", "1"));
        check(run("desktop.keys", "keys", "tab").ok, "settings as true and \"1\" read as on");
        acted();
    }

    static void screenshot() {
        System.out.println("[screenshot]");
        AxisLink.Answer a = run("desktop.screenshot");
        check(!a.ok && a.error.contains("switched off"), "off unless allowScreenshot");
        cmds.useSettings(Json.obj("allowScreenshot", 1));
        run("desktop.look");
        a = run("desktop.screenshot", "detail", "low");
        check(a.ok, "a picture: " + a.error);
        Map<String, Object> img = Json.map(data(a).get("image"));
        byte[] jpeg = java.util.Base64.getDecoder().decode((String) img.get("data"));
        check((jpeg[0] & 0xff) == 0xff && (jpeg[1] & 0xff) == 0xd8, "a JPEG (" + jpeg.length + " bytes)");
        equal(data(a).get("picture"), "640x400 of the panel", "shrunk to 640 on its long side");
        a = run("desktop.screenshot", "id", 8);
        check(a.ok && ((String) data(a).get("picture")).startsWith("380x320 of 0,130"), "cropped around an element: " + data(a).get("picture"));
        xml[0] = focusPassword();
        adbd.take();
        try { Thread.sleep(3100); } catch (InterruptedException ignored) {}
        a = run("desktop.screenshot");
        check(!a.ok && a.error.contains("password"), "never while a password field has the focus: " + a.error);
        check(adbd.take().stream().noneMatch(c -> c.startsWith("screencap")), "no screencap was taken");
        xml[0] = plain;
        cmds.useSettings(Json.obj());
    }

    static void steps() {
        System.out.println("[steps]");
        Map<String, Object> data = Json.obj("steps", Arrays.asList(
                Json.obj("action", "click", "name", "Beyond Sandbox", "button", "left"),
                Json.obj("action", "wait", "ms", 100),
                Json.obj("action", "keys", "keys", "back")));
        AxisLink.Answer a = cmds.handle("desktop.steps", Json.obj("data", data));
        check(a.ok, "three steps ran: " + a.error);
        equal(data(a).get("done"), 3, "done 3");
        equal(Json.list(data(a).get("steps")).size(), 3, "a line for each");
        data = Json.obj("steps", Arrays.asList(
                Json.obj("action", "keys", "keys", "enter"),
                Json.obj("action", "switch", "window", "Store"),
                Json.obj("action", "keys", "keys", "enter")));
        a = cmds.handle("desktop.steps", Json.obj("data", data));
        check(!a.ok && a.error.startsWith("step 2 (switch) failed"), "a failing step stops the rest: " + a.error);
        equal(data(a).get("failed"), 2, "the report says which");
        long enters = acted().stream().filter(c -> c.equals("input keyevent 66")).count();
        equal(enters, 1L, "the step after the failure did not run");
    }

    static void waits() {
        System.out.println("[wait]");
        AxisLink.Answer a = run("desktop.wait", "name", "Sign in", "seconds", 2);
        check(a.ok, "waits for a name that is there");
        a = run("desktop.wait", "name", "Never There", "seconds", 1);
        check(!a.ok && a.error.contains("did not appear"), "and says when it did not come: " + a.error);
        a = run("desktop.wait", "window", "Store", "seconds", 1);
        check(a.ok, "waits for a panel by app name");
        a = run("desktop.wait", "ms", 60);
        check(a.ok, "a plain pause");
        acted();
    }

    static void deadlines() throws Exception {
        System.out.println("[deadlines] a dump that never finishes, then a dropped connection");
        adbd.slowFor = "uiautomator";
        adbd.slowMs = 4000;
        int before = adbd.connections;
        long t0 = System.currentTimeMillis();
        PanelCommands quick = new PanelCommands(adb, T.log(), "t");
        // The deadline is DUMP_MS (10 s) in the app; here the same code with a shorter one.
        AxisLink.Answer a = withDumpMs(quick, 1500).handle("desktop.look", Json.obj());
        long took = System.currentTimeMillis() - t0;
        check(!a.ok && a.error.contains("took longer"), "a clear error instead of a hang: " + a.error);
        check(took < 3500, "within the deadline (" + took + " ms)");
        adbd.slowFor = null;
        a = cmds.handle("desktop.look", Json.obj());
        check(a.ok, "the next command connects again and works");
        check(adbd.connections > before, "on a new adb connection (" + adbd.connections + " so far)");
        acted();
    }

    static PanelCommands withDumpMs(PanelCommands c, int ms) {
        c.dumpMs = ms;
        return c;
    }

    static void oneAtATime() throws Exception {
        System.out.println("[one at a time]");
        adbd.slowFor = "uiautomator";
        adbd.slowMs = 600;
        ExecutorService pool = Executors.newFixedThreadPool(3);
        List<Future<AxisLink.Answer>> all = new ArrayList<>();
        for (int i = 0; i < 3; i++) all.add(pool.submit((Callable<AxisLink.Answer>) () -> cmds.handle("desktop.look", Json.obj())));
        int ok = 0;
        for (Future<AxisLink.Answer> f : all) if (f.get().ok) ok++;
        pool.shutdown();
        equal(ok, 3, "three looks at once all answered, one after another on the one connection");
        adbd.slowFor = null;
        acted();
    }
}
