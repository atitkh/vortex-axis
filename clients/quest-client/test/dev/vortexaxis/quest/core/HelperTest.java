package dev.vortexaxis.quest.core;

import static dev.vortexaxis.quest.core.T.check;
import static dev.vortexaxis.quest.core.T.equal;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * The fast engine without a headset: the helper's own plain-Java parts (the wire, the router and its handle table,
 * typing at the caret) against a pretend screen, then the app's side (Helper and PanelCommands) against the pretend
 * helper and the pretend adbd: install and start, every command through the engine with no shell input at all, the
 * guards, a helper that hangs or dies (back to the shell, then started again), a new build carried by an updated
 * app (installed again), the switch, and the Test button.
 */
public class HelperTest {
    static String plain;
    static final String V = "0.3.0-test";

    public static void main(String[] args) throws Exception {
        plain = Panel.extractXml(T.fixture("store-panel.xml"));
        wire();
        router();
        engine();
        System.out.println("HelperTest: ALL PASS (" + T.checks + " checks)");
        System.exit(0);
    }

    static void wire() throws Exception {
        System.out.println("[wire] lines, and typing at the caret");
        String two = "{\"id\":1}\n{\"id\":2,\"op\":\"x\"}\n";
        ByteArrayInputStream in = new ByteArrayInputStream(two.getBytes(StandardCharsets.UTF_8));
        equal(HelperProtocol.readLine(in), "{\"id\":1}", "one line");
        equal(HelperProtocol.readLine(in), "{\"id\":2,\"op\":\"x\"}", "the next");
        equal(HelperProtocol.readLine(in), null, "then the end");
        equal(Arrays.asList(HelperProtocol.insert("", 0, 0, false, "hello")), Arrays.asList("hello", 5), "into an empty field");
        equal(Arrays.asList(HelperProtocol.insert("Search apps", -1, -1, true, "chess")), Arrays.asList("chess", 5), "a field showing its hint counts as empty");
        equal(Arrays.asList(HelperProtocol.insert("hello world", 5, 5, false, ",")), Arrays.asList("hello, world", 6), "at the caret");
        equal(Arrays.asList(HelperProtocol.insert("hello world", 6, 11, false, "there")), Arrays.asList("hello there", 11), "over the selection");
        equal(Arrays.asList(HelperProtocol.insert("abc", -1, -1, false, "d")), Arrays.asList("abcd", 4), "no caret: at the end");
        equal(Arrays.asList(HelperProtocol.insert("abc", 9, 9, false, "d")), Arrays.asList("abcd", 4), "a caret past the end: at the end");
    }

    @SuppressWarnings("unchecked")
    static void router() throws Exception {
        System.out.println("[router] the helper's answers over the pretend screen");
        FakeHelper fh = new FakeHelper(V, plain);
        HelperRouter<FakeHelper.N> r = new HelperRouter<>(fh.new Screen(), V);
        Map<String, Object> pong = r.handle("{\"id\":1,\"op\":\"ping\"}");
        check(Json.isTrue(pong, "ok") && V.equals(pong.get("version")) && Integer.valueOf(1).equals(Json.integer(pong, "id")), "ping: its version and the id back: " + pong);
        Map<String, Object> dump = r.handle("{\"id\":2,\"op\":\"dump\"}");
        String wire = Json.write(dump);
        check(Json.isTrue(dump, "ok"), "dump answered (" + wire.length() + " characters on the wire)");
        check(!wire.contains("••••••••"), "a password field's text never leaves the helper");
        Panel fast = Panel.fromHelper(Json.parseObject(wire));
        Panel slow = Panel.parse(plain);
        List<String> a = new ArrayList<>(), b = new ArrayList<>();
        for (int i = 0; i < fast.elements.size(); i++) a.add(fast.elements.get(i).line(i + 1));
        for (int i = 0; i < slow.elements.size(); i++) b.add(slow.elements.get(i).line(i + 1));
        equal(a, b, "the same panel, line for line, as from uiautomator's XML (one parser path, one tidy)");
        equal(fast.nodes, slow.nodes, "the same node count: " + slow.nodes);
        equal(fast.window(), slow.window(), "and the same window");
        check(fast.elements.stream().allMatch(e -> e.handle > 0), "every element carries its node's handle");
        check(slow.elements.stream().allMatch(e -> e.handle == -1), "uiautomator's have none");

        int search = fast.elements.stream().filter(e -> e.kind.equals("edit")).findFirst().get().handle;
        int pw = fast.elements.stream().filter(e -> e.kind.equals("password")).findFirst().get().handle;
        Map<String, Object> refused = r.handle("{\"id\":3,\"op\":\"setText\",\"handle\":" + pw + ",\"text\":\"hunter2\"}");
        equal(refused.get("code"), HelperProtocol.PASSWORD, "setText into a password field: refused by the helper itself");
        Map<String, Object> typed = r.handle("{\"id\":4,\"op\":\"setText\",\"handle\":" + search + ",\"text\":\"naïve ☕\"}");
        check(Json.isTrue(typed, "ok"), "setText takes any text: " + typed);
        check(fh.take().equals(Arrays.asList("focus search_input", "setText search_input = naïve ☕ @7")), "the field got the focus, then the text at the caret");
        r.handle("{\"id\":5,\"op\":\"dump\"}");
        Map<String, Object> stale = r.handle("{\"id\":6,\"op\":\"click\",\"handle\":" + search + "}");
        equal(stale.get("code"), HelperProtocol.STALE, "a handle from before the last dump is stale");
        equal(r.handle("{\"id\":7,\"op\":\"reboot\"}").get("code"), HelperProtocol.BAD, "an unknown op");
        Map<String, Object> junk = r.handle("not json");
        check(!Json.isTrue(junk, "ok") && junk.get("id") == null, "a line that is not JSON: refused, never thrown");
        equal(r.handle("{\"id\":8,\"op\":\"tap\"}").get("code"), HelperProtocol.BAD, "tap without x and y");
        Map<String, Object> windows = r.handle("{\"id\":9,\"op\":\"windows\"}");
        check(Json.list(windows.get("windows")).size() == 1, "windows: the windows on the screen");
        Map<String, Object> cut = r.handle("{\"id\":10,\"op\":\"dump\",\"maxNodes\":5}");
        check(Json.isTrue(cut, "truncated") && Integer.valueOf(5).equals(Json.integer(cut, "nodes")), "maxNodes cuts a dump short and says so");
        fh.take();
    }

    static final class Host implements Helper.Host {
        File apk;
        String sha;

        Host(String content) throws Exception {
            apk = File.createTempFile("helper", ".apk");
            Files.write(apk.toPath(), content.getBytes(StandardCharsets.UTF_8));
            sha = SelfUpdate.hex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(apk.toPath())));
        }

        @Override public File apk() { return apk; }
        @Override public String sha256() { return sha; }
        @Override public int uid() { return 10123; }
    }

    static FakeAdbd adbd;
    static FakeHelper fh;
    static QuestClient quest;
    static PanelCommands cmds;

    static AxisLink.Answer run(String name, Object... kv) { return cmds.handle(name, Json.obj(kv)); }

    @SuppressWarnings("unchecked")
    static Map<String, Object> data(AxisLink.Answer a) { return (Map<String, Object>) a.data; }

    /** What adbd was asked other than the cheap "what is in front" reads. */
    static List<String> shell() {
        List<String> out = new ArrayList<>();
        for (String c : adbd.take()) if (!c.startsWith("dumpsys window")) out.add(c);
        return out;
    }

    static void engine() throws Exception {
        System.out.println("[engine] install and start through the app's adb");
        String[] xml = {plain};
        String[] focus = {"com.oculus.store"};
        fh = new FakeHelper(V, plain);
        adbd = new FakeAdbd();
        adbd.answer = fh.adbd(T.headset(xml, focus));
        RollingLog log = T.log();
        AdbLink adb = new AdbLink("127.0.0.1", adbd.port(), new T.MemoryKeys(), "vortexaxis@quest", log);
        adb.connect(AdbLink.APPROVAL_MS);
        quest = new QuestClient(adb, null, log, V);
        cmds = quest.commands;
        cmds.sleeper = ms -> Thread.sleep(Math.min(ms, 20));
        cmds.setPictures(new T.JvmPictures());
        Helper helper = quest.helper;
        Host host = new Host("PK pretend helper 0.3.0");
        helper.setHost(host);
        helper.setChannel(fh.channel());
        helper.retryFirstMs = 200;
        helper.startMs = 3000;
        List<Helper.State> states = new ArrayList<>();
        int[] doings = {0};
        quest.setListener(new QuestClient.Listener() {
            @Override public void engine(Helper.State s, String d) { states.add(s); }
            @Override public void doing() { doings[0]++; }
        });
        adbd.take();

        helper.tick();
        equal(helper.state(), Helper.State.FAST, "Fast after the first check: " + helper.detail());
        List<String> sent = shell();
        check(sent.get(0).startsWith("pm list packages --show-versioncode dev.vortexaxis.quest.helper"), "asked whether the helper is there");
        check(sent.contains(Helper.installCommand(host.apk.getAbsolutePath())), "installed it with pm install -r from /data/local/tmp");
        check(sent.contains("echo " + host.sha + " > " + Helper.MARKER), "and noted which build it is");
        String start = sent.stream().filter(c -> c.contains("am instrument")).findFirst().orElse("");
        check(start.startsWith("rm -f /data/local/tmp/vortex-axis-helper.status; am force-stop dev.vortexaxis.quest.helper; nohup sh -c ") && start.contains("am instrument -w -e uid 10123 dev.vortexaxis.quest.helper/.Helper") && start.endsWith("& echo helper-started"),
                "started detached with am instrument, told this app's uid: " + start);
        check(states.contains(Helper.State.STARTING) && states.get(states.size() - 1) == Helper.State.FAST, "the window heard Starting, then Fast: " + states);
        equal(fh.installs, 1, "one install");

        System.out.println("[engine] commands through the helper, nothing typed or tapped through the shell");
        AxisLink.Answer a = run("desktop.look");
        equal(Json.list(data(a).get("elements")).size(), 17, "look: the 17 elements");
        equal(Json.list(data(a).get("elements")).get(7), "8 listitem 24,170 300x240 Beyond Sandbox — Free", "the same tile line as from uiautomator");
        check(shell().stream().noneMatch(c -> c.contains("uiautomator")), "no uiautomator dump");
        check(cmds.lastTiming().fast && cmds.lastTiming().toString().matches("35 nodes, 17 kept; fast dump \\d+ ms, parse \\d+ ms, total \\d+ ms"), "the timing says fast: " + cmds.lastTiming());

        a = run("desktop.click", "name", "Beyond Sandbox");
        check(a.ok, "click by name: " + a.error);
        equal(a.payload.get("how") + " " + a.payload.get("x") + "," + a.payload.get("y"), "tap 174,290", "the answer's shape and words as through the shell");
        List<String> did = fh.take();
        check(did.size() == 1 && did.get(0).startsWith("click "), "the helper pressed the tile by its handle: " + did);
        check(shell().stream().noneMatch(c -> c.startsWith("input")), "the shell got no input tap");
        check("Store (com.oculus.store)".equals(Json.map(data(a).get("after")).get("window")), "after: still read from dumpsys");

        run("desktop.look");
        fh.take();
        run("desktop.click", "id", 11, "button", "double");
        equal(fh.take(), Arrays.asList("tap 903,388", "tap 903,388"), "a double tap: two touches");
        run("desktop.click", "id", 2, "button", "right");
        equal(fh.take(), Arrays.asList("longPress 200,48"), "right: a long press (by handle; this element takes no long click, so a held touch at its centre)");
        run("desktop.click", "x", 10, "y", 20);
        equal(fh.take(), Arrays.asList("tap 10,20"), "x,y: a touch there");
        check(!run("desktop.click", "x", 1280, "y", 20).ok, "off the panel: refused as before");

        fh.setScreen(plain);
        a = run("desktop.type", "text", "hello world", "name", "Search");
        check(a.ok && Long.valueOf(11).equals(((Number) a.payload.get("typed")).longValue()), "type by name: " + a.payload);
        equal(fh.take(), Arrays.asList("focus search_input", "setText search_input = hello world @11"), "the field focused, then setText");
        fh.setScreen(plain);
        a = run("desktop.type", "text", "naïve café", "name", "Search");
        check(a.ok, "non-ASCII through the fast engine: " + a.error);
        check(fh.take().contains("setText search_input = naïve café @10"), "typed as it is");
        fh.setScreen(plain);
        a = run("desktop.type", "text", "one\ntwo", "name", "Search");
        equal(fh.take(), Arrays.asList("focus search_input", "setText search_input = one @3", "key 66", "setText search_input = onetwo @6"),
                "a newline is Enter between two parts, the second typed where the focus is");
        check(shell().stream().noneMatch(c -> c.startsWith("input")), "none of it through input text");
        a = run("desktop.type", "text", "x\u0007", "name", "Search");
        check(!a.ok && a.error.contains("control character"), "a control character still refused");
        a = run("desktop.type", "text", "hunter2", "name", "Password");
        check(!a.ok && a.error.contains("password"), "never into a password field: " + a.error);
        fh.setScreen(CommandsTest.focusPassword0(plain));
        a = run("desktop.type", "text", "hunter2");
        check(!a.ok && a.error.contains("password"), "nor blind into the focus when a password field has it");
        check(fh.take().stream().noneMatch(c -> c.contains("hunter2")), "the helper never got the password text");
        fh.setScreen(plain);

        equal(run("desktop.keys", "keys", "enter").payload.get("pressed"), "enter", "keys enter");
        run("desktop.keys", "keys", "back");
        run("desktop.keys", "keys", "ctrl+a");
        equal(fh.take(), Arrays.asList("key 66", "back", "key ctrl+29"), "keys injected; Back as the system's Back; ctrl+a without keycombination");
        check(!run("desktop.keys", "keys", "power").ok && fh.take().isEmpty(), "power still refused");

        run("desktop.look");
        fh.take();
        a = run("desktop.scroll", "go", "down");
        check(a.ok && "scroll".equals(a.payload.get("how")), "scroll down: the list's own scrolling (" + a.payload + ")");
        equal(fh.take(), Arrays.asList("scroll forward"), "one page forward in the biggest list");
        run("desktop.scroll", "go", "left", "pages", 2, "id", 7);
        equal(fh.take(), Arrays.asList("scroll backward", "scroll backward"), "two pages back in the row by id");
        check(shell().stream().noneMatch(c -> c.startsWith("input")), "no swipes through the shell");

        cmds.useSettings(Json.obj("allowScreenshot", 1));
        a = run("desktop.screenshot", "detail", "low");
        check(a.ok && "640x400 of the panel".equals(data(a).get("picture")), "screenshot through the helper: " + (a.ok ? data(a).get("picture") : a.error));
        check(fh.take().contains("screenshot 640"), "UiAutomation's picture at 640");
        check(shell().stream().noneMatch(c -> c.startsWith("screencap")), "no screencap");
        cmds.useSettings(Json.obj());

        equal(run("desktop.hello").payload.get("engine"), "fast", "Check the headset says the engine");
        check(quest.doing().now == null && quest.doing().last != null && doings[0] > 0, "the Live view heard each command start and end: last \"" + quest.doing().last + "\" in " + quest.doing().lastMs + " ms");
        cmds.paused = true;
        check(!run("desktop.click", "x", 5, "y", 5).ok && fh.take().isEmpty(), "paused: nothing reaches the helper");
        cmds.paused = false;
        cmds.useSettings(Json.obj("allowInput", 0));
        check(!run("desktop.click", "x", 5, "y", 5).ok && fh.take().isEmpty(), "allowInput off: nothing reaches the helper");
        cmds.useSettings(Json.obj());
        shell();

        System.out.println("[engine] a helper that hangs: the look comes from uiautomator, the helper is stopped and started again");
        fh.hangOn = "dump";
        cmds.dumpMs = 1500;
        long t0 = System.currentTimeMillis();
        a = run("desktop.look");
        check(a.ok && Json.list(data(a).get("elements")).size() == 17, "the look still answered, through the shell, in " + (System.currentTimeMillis() - t0) + " ms");
        sent = shell();
        check(sent.contains("am force-stop dev.vortexaxis.quest.helper"), "the stuck helper was stopped (so uiautomator can read)");
        check(sent.stream().anyMatch(c -> c.contains("uiautomator dump")), "and uiautomator read the panel");
        equal(helper.state(), Helper.State.BASIC, "Basic meanwhile: " + helper.detail());
        fh.hangOn = null;
        cmds.dumpMs = PanelCommands.DUMP_MS;
        Thread.sleep(300);
        helper.tick();
        equal(helper.state(), Helper.State.FAST, "started again at the next check");
        equal(fh.installs, 1, "without installing again (the noted build is the one carried)");

        System.out.println("[engine] a helper that dies between commands");
        fh.die();
        Thread.sleep(150);
        a = run("desktop.click", "x", 10, "y", 20);
        check(a.ok, "the click still worked: " + a.error);
        check(shell().contains("input tap 10 20"), "through the shell this time");
        check(fh.take().isEmpty(), "not through the dead helper");
        equal(helper.state(), Helper.State.BASIC, "Basic");
        a = run("desktop.click", "x", 11, "y", 21);
        check(shell().contains("input tap 11 21"), "and the next too, without trying the helper again (no loop)");
        Thread.sleep(300);
        helper.tick();
        equal(helper.state(), Helper.State.FAST, "back after the next check");
        run("desktop.click", "x", 12, "y", 22);
        equal(fh.take(), Arrays.asList("tap 12,22"), "and used again");

        System.out.println("[engine] an action the helper takes and never answers is not done again through the shell");
        fh.hangOn = "tap";
        a = cmds.handle("desktop.click", Json.obj("x", 13, "y", 23));
        check(!a.ok && a.error.contains("may or may not"), "said plainly: " + a.error);
        check(shell().stream().noneMatch(c -> c.startsWith("input tap")), "no second tap through the shell");
        fh.hangOn = null;
        Thread.sleep(300);
        helper.tick();
        equal(helper.state(), Helper.State.FAST, "and the helper is back after the next check");

        System.out.println("[engine] the Test button: the fast engine, then uiautomator both ways");
        PanelCommands.TestResult tr = cmds.test();
        check(tr.fast != null && tr.fast.fast && tr.plain != null && !tr.plain.fast && tr.compressed != null, "three timings: " + tr.fast + " / " + tr.plain + " / " + tr.compressed);
        equal(helper.state(), Helper.State.FAST, "the helper is running again after Test");
        check(cmds.lastTiming().fast, "agents' looks are the fast engine's");

        System.out.println("[engine] the app updated itself: the helper it carries is another build");
        fh.version = "0.3.1-test";
        QuestClient next = new QuestClient(adb, null, log, "0.3.1-test");
        Host newer = new Host("PK pretend helper 0.3.1");
        next.helper.setHost(newer);
        next.helper.setChannel(fh.channel());
        next.helper.startMs = 3000;
        adbd.take();
        next.helper.tick();
        equal(next.helper.state(), Helper.State.FAST, "the new app's engine is Fast: " + next.helper.detail());
        equal(fh.installs, 2, "after installing the helper it carries");
        equal(fh.marker, newer.sha, "and noting the new build");

        System.out.println("[engine] Use fast engine off");
        next.helper.setEnabled(false);
        equal(next.helper.state(), Helper.State.OFF, "Off");
        check(!fh.running(), "the helper was stopped");
        next.helper.tick();
        equal(next.helper.state(), Helper.State.OFF, "and stays off");
        next.commands.handle("desktop.look", Json.obj());
        check(adbd.take().stream().anyMatch(c -> c.contains("uiautomator dump")), "looks go through uiautomator");
        next.helper.setEnabled(true);
        next.helper.tick();
        equal(next.helper.state(), Helper.State.FAST, "on again: Fast");
        next.helper.shutdown();

        System.out.println("[engine] no adb: Basic, and says why");
        Helper lonely = new Helper(new AdbLink("127.0.0.1", 1, new T.MemoryKeys(), "x", log), log, V);
        lonely.setHost(host);
        lonely.setChannel(() -> { throw new IOException("nothing there"); });
        lonely.tick();
        check(lonely.state() == Helper.State.BASIC && lonely.detail().contains("adb"), "Basic: " + lonely.detail());
        fh.close();
        adbd.close();
    }
}
