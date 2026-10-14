package dev.vortexaxis.quest.core;

import static dev.vortexaxis.quest.core.T.check;
import static dev.vortexaxis.quest.core.T.equal;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * End to end, against a REAL Axis (the repository's server, started by scripts/test-quest-client.sh on
 * a throwaway data folder): pair through /v1/pair with a code made on the admin API, connect the
 * socket, take the update Axis offers from a pretend build in its data folder (downloaded through
 * /v1/quest/app, installed on the pretend adbd), then call the desktop tool through the MCP door with
 * an agent token, as an agent harness does. Each call goes Axis -> this client -> the pretend adbd and
 * back. The panel is the fixture.
 *
 *   java ... E2eTest <axis base url> <admin token> [jdk|okhttp]
 */
public class E2eTest {
    static String base, admin, agent;
    // HTTP/1.1: the JDK otherwise asks to upgrade to h2c, and Node hands such a request to the WebSocket upgrade path.
    static final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(Duration.ofSeconds(5)).build();
    static int rpc = 1;

    public static void main(String[] args) throws Exception {
        base = args[0];
        admin = args[1];
        String which = args.length > 2 ? args[2] : "jdk";
        Sockets sockets = which.equals("okhttp")
                ? (Sockets) Class.forName("dev.vortexaxis.quest.OkHttpSockets").getDeclaredConstructor().newInstance()
                : new JdkSockets();
        System.out.println("E2E against " + base + " with the " + which + " WebSocket");

        String plain = Panel.extractXml(T.fixture("store-panel.xml"));
        String[] xml = {plain};
        String[] focus = {"com.oculus.store"};
        FakeAdbd adbd = new FakeAdbd();
        adbd.answer = T.headset(xml, focus);
        RollingLog log = T.log();
        AdbLink adb = new AdbLink("127.0.0.1", adbd.port(), new T.MemoryKeys(), "vortexaxis@quest", log);
        adb.connect(AdbLink.APPROVAL_MS);
        QuestClient quest = new QuestClient(adb, sockets, log, QuestIdentity.VERSION);
        quest.commands.setPictures(new T.JvmPictures());
        // Updates: the download goes to a throwaway folder; Android's package check is the app's, not here.
        java.io.File updates = java.nio.file.Files.createTempDirectory("quest-e2e-update").toFile();
        List<String> pending = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        quest.update.setHost(new SelfUpdate.Host() {
            @Override public java.io.File folder() { return updates; }
            @Override public void check(java.io.File apk) {}
            @Override public void pending(String version) { pending.add(String.valueOf(version)); }
        });

        System.out.println("[pair] through the real pairing endpoint");
        Map<String, Object> code = call("POST", "/admin/pairing-codes", admin, null, 201);
        String name = "Quest " + which;
        AxisLink.Pairing pairing = AxisLink.pair(AxisAddress.parse(base), (String) code.get("code"), name, quest.identity());
        check(pairing.clientId != null && pairing.token.length() > 20, "paired: a client id and a token");
        equal(pairing.name, name, "with the name given");
        try {
            AxisLink.pair(AxisAddress.parse(base), (String) code.get("code"), "Again", quest.identity());
            check(false, "a used code is refused");
        } catch (java.io.IOException e) {
            check(e.getMessage().contains("pairing code"), "a used code is refused with Axis's words: " + e.getMessage());
        }

        System.out.println("[connect]");
        quest.start(pairing);
        waitFor(() -> quest.linkState() == AxisLink.State.ONLINE, 10_000, "online");
        check(true, "the socket is up: hello, welcome, describe");
        Map<String, Object> me = client(pairing.clientId);
        equal(me.get("type"), "meta-quest", "Axis lists it as meta-quest");
        equal(me.get("version"), QuestIdentity.VERSION, "with its version");
        check(Json.list(me.get("capabilities")).equals(Arrays.asList("desktop")), "claiming only the desktop capability: " + me.get("capabilities"));
        equal(me.get("online"), true, "online on the admin page");
        Map<String, Object> types = Json.map(call("GET", "/admin/clients", admin, null, 200).get("types"));
        String schema = Json.write(types.get("meta-quest"));
        check(schema.contains("allowLook") && schema.contains("allowScreenshot") && schema.contains("autoUpdate") && schema.contains("desktop.hello"), "its settings and the Check action reached the admin page");

        System.out.println("[update] Axis offers the newer build in its data folder (put there by the script)");
        Map<String, Object> build = call("GET", "/admin/quest", admin, null, 200);
        check(Boolean.TRUE.equals(build.get("available")) && SelfUpdate.newer(String.valueOf(build.get("version")), QuestIdentity.VERSION), "Axis has a newer Quest app: " + build);
        String newVersion = (String) build.get("version");
        waitFor(() -> pending.contains(newVersion), 15_000, "the update Axis sends on connect");
        java.io.File got = new java.io.File(updates, SelfUpdate.FILE);
        String sha = UpdateTest.hex(java.security.MessageDigest.getInstance("SHA-256").digest(java.nio.file.Files.readAllBytes(got.toPath())));
        equal(sha, build.get("sha256"), "downloaded through /v1/quest/app with the headset's token; size and SHA-256 checked");
        waitFor(() -> adbd.history.stream().anyMatch(c -> c.startsWith("pm install -r ")), 8000, "the install");
        check(adbd.history.contains("rm -f /data/local/tmp/vortex-axis-update.txt && cp '" + got.getAbsolutePath() + "' /data/local/tmp/vortex-axis-update.apk && chmod 644 /data/local/tmp/vortex-axis-update.apk && echo staged"), "copied for pm on the pretend headset");
        check(adbd.history.contains("pm install -r /data/local/tmp/vortex-axis-update.apk 2>&1; rm -f /data/local/tmp/vortex-axis-update.apk"),
                "then pm install -r in the app's own stream (Android restarts the app by UpdatedReceiver)");
        Map<String, Object> pushed = call("POST", "/admin/clients/" + pairing.clientId + "/update", admin, null, 202);
        equal(pushed.get("from") + " -> " + pushed.get("to"), QuestIdentity.VERSION + " -> " + newVersion, "the admin page's Update works for a headset too");
        adbd.take();

        System.out.println("[legacy] a headset still on 0.2.0, which says quest-panels");
        AxisLink.Identity legacy = new AxisLink.Identity("quest-panels", "0.2.0", Arrays.asList("desktop"), QuestIdentity.create("0.2.0").describe);
        Map<String, Object> oldCode = call("POST", "/admin/pairing-codes", admin, null, 201);
        AxisLink.Pairing old = AxisLink.pair(AxisAddress.parse(base), (String) oldCode.get("code"), "Old app " + which, legacy);
        List<String> oldHeard = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        AxisLink oldLink = new AxisLink(old, legacy, sockets, log);
        oldLink.setHandler((n, p) -> {
            oldHeard.add(n);
            return n.equals("update") ? AxisLink.Answer.done(Json.obj("version", p.get("version"))) : AxisLink.Answer.fail("not in this pretend 0.2.0");
        });
        oldLink.start();
        waitFor(() -> oldLink.state() == AxisLink.State.ONLINE, 10_000, "the old app online");
        Map<String, Object> oldMe = client(old.clientId);
        equal(oldMe.get("type") + " " + oldMe.get("version"), "meta-quest 0.2.0", "paired and connected with the old type: Axis keeps it as meta-quest");
        waitFor(() -> oldHeard.contains("update"), 15_000, "the update offered to the old app");
        check(true, "Axis offered it the update, as to any headset behind");
        HttpResponse<byte[]> oldGot = http.send(HttpRequest.newBuilder(URI.create(base + "/v1/quest/app")).header("authorization", "Bearer " + old.token)
                .header("x-axis-client", old.clientId).timeout(Duration.ofSeconds(10)).build(), HttpResponse.BodyHandlers.ofByteArray());
        equal(oldGot.statusCode(), 200, "and it can fetch it through the unchanged /v1/quest/app");
        equal(UpdateTest.hex(java.security.MessageDigest.getInstance("SHA-256").digest(oldGot.body())), build.get("sha256"), "the same build");
        oldLink.stop();
        call("DELETE", "/admin/clients/" + old.clientId, admin, null, 200);

        System.out.println("[agent] the desktop tool through POST /mcp");
        call("PATCH", "/admin/mcp/tools", admin, Json.obj("vortex_axis_desktop", true), 200);
        agent = (String) call("POST", "/admin/mcp/tokens", admin, Json.obj("name", "quest e2e"), 201).get("token");
        Map<String, Object> init = mcp("initialize", Json.obj("protocolVersion", "2025-06-18", "capabilities", Json.obj(), "clientInfo", Json.obj("name", "e2e", "version", "1")));
        check(Json.map(init.get("result")) != null, "MCP initialize answered");

        Map<String, Object> look = tool(Json.obj("action", "look"));
        equal(look.get("computer"), name, "look: Axis names the headset as the computer");
        List<Object> elements = Json.list(look.get("elements"));
        equal(elements.size(), 17, "look: the 17 elements of the panel");
        equal(elements.get(7), "8 listitem 24,170 300x240 Beyond Sandbox — Free", "look: the tile line (named and folded from its texts) came through Axis unchanged");
        equal(look.get("window"), "Store (com.oculus.store) 0,0 1280x800", "look: the window");
        adbd.take();

        Map<String, Object> click = tool(Json.obj("action", "click", "name", "Beyond Sandbox"));
        equal(click.get("done") + " " + click.get("how") + " " + click.get("x") + "," + click.get("y"), "click tap 174,290", "click by name: tapped at the tile's centre");
        check(Json.map(click.get("after")) != null && "Store (com.oculus.store)".equals(Json.map(click.get("after")).get("window")), "click: after says what is in front");
        check(adbd.take().contains("input tap 174 290"), "the pretend headset got: input tap 174 290");

        Map<String, Object> type = tool(Json.obj("action", "type", "into", "Search", "text", "hello world"));
        equal(type.get("typed"), 11L, "type: 11 characters");
        List<String> sent = adbd.take();
        check(sent.contains("input tap 650 48") && sent.contains("input text 'hello%sworld'"), "the headset got the tap on the field and: input text 'hello%sworld'");

        tool(Json.obj("action", "type", "into", "Search", "text", "'; reboot #"));
        check(adbd.take().contains("input text ''\\'';%sreboot%s#'"), "an injection attempt through Axis arrives as quoted text");

        String refused = toolError(Json.obj("action", "type", "into", "Password", "text", "hunter2"));
        check(refused.contains("password"), "type into a password field: refused through Axis: " + refused);
        check(adbd.take().stream().noneMatch(c -> c.contains("hunter2")), "and the password never reached adb");

        Map<String, Object> keys = tool(Json.obj("action", "keys", "keys", "enter"));
        equal(keys.get("pressed"), "enter", "keys enter");
        check(adbd.take().contains("input keyevent 66"), "as input keyevent 66");
        check(toolError(Json.obj("action", "keys", "keys", "power")).contains("never presses"), "keys power refused");

        tool(Json.obj("action", "look"));
        adbd.take();
        Map<String, Object> scroll = tool(Json.obj("action", "scroll", "go", "down"));
        equal(scroll.get("scrolled"), "down", "scroll down");
        check(adbd.take().contains("input swipe 640 625 640 275 400"), "as a swipe in the page");

        Map<String, Object> open = tool(Json.obj("action", "open", "url", "https://example.org/docs"));
        equal(open.get("opened"), "https://example.org/docs", "open a url");
        check(adbd.take().contains("am start -a android.intent.action.VIEW -d 'https://example.org/docs'"), "as am start, quoted");
        check(toolError(Json.obj("action", "open", "url", "file:///sdcard/x")).contains("http"), "a file address refused (by Axis before the headset)");

        check(toolError(Json.obj("action", "switch", "window", "Browser")).contains("not available on a Quest"), "switch: unsupported, said clearly");
        check(toolError(Json.obj("action", "clipboard")).contains("not available on a Quest"), "clipboard: unsupported, said clearly");
        Map<String, Object> point = tool(Json.obj("action", "point", "id", 8, "text", "This one"));
        check(Boolean.TRUE.equals(point.get("pointed")) && Long.valueOf(174).equals(point.get("x")), "point: accepted (noted, not drawn)");

        Map<String, Object> steps = tool(Json.obj("action", "steps", "steps", Arrays.asList(
                Json.obj("action", "click", "name", "Cloud Garden"),
                Json.obj("action", "wait", "ms", 100),
                Json.obj("action", "keys", "keys", "back"))));
        equal(steps.get("done"), 3L, "steps: three ran");
        sent = adbd.take();
        check(sent.contains("input tap 806 290") && sent.contains("input keyevent 4"), "steps: tap on Cloud Garden, then Back");

        Map<String, Object> find = tool(Json.obj("action", "find", "name", "sign in"));
        check(Json.list(find.get("matches")).get(0).toString().contains("Sign in"), "find: " + find.get("matches"));

        System.out.println("[settings] from the admin page to the headset");
        check(toolError(Json.obj("action", "screenshot")).contains("switched off"), "screenshot: off by default (Axis refuses)");
        call("PATCH", "/admin/settings/device/" + pairing.clientId, admin, Json.obj("values", Json.obj("allowScreenshot", 1)), 200);
        Thread.sleep(300);
        Map<String, Object> shot = mcp("tools/call", Json.obj("name", "vortex_axis_desktop", "arguments", Json.obj("action", "screenshot", "detail", "low")));
        List<Object> content = Json.list(Json.map(shot.get("result")).get("content"));
        Map<String, Object> image = Json.map(content.get(0));
        equal(image.get("type"), "image", "screenshot: an image block through the MCP door");
        equal(image.get("mimeType"), "image/jpeg", "a JPEG");
        check(((String) content.toString()).contains("640x400"), "640x400 at detail low");

        call("PATCH", "/admin/settings/device/" + pairing.clientId, admin, Json.obj("values", Json.obj("allowLook", 0)), 200);
        String off = "";
        for (int i = 0; i < 20 && !off.contains("switched off"); i++) {
            Thread.sleep(150);
            off = toolError(Json.obj("action", "look"));
        }
        check(off.contains("reading the screen is switched off for this headset"), "allowLook 0 reached the headset, which refuses: " + off);
        call("PATCH", "/admin/settings/device/" + pairing.clientId, admin, Json.obj("values", Json.obj("allowLook", 1, "allowInput", 0)), 200);
        Thread.sleep(300);
        check(toolError(Json.obj("action", "click", "x", 5, "y", 5)).contains("switched off"), "allowInput 0: Axis refuses the click");
        check(adbd.take().stream().noneMatch(c -> c.startsWith("input")), "and nothing was tapped");
        call("PATCH", "/admin/settings/device/" + pairing.clientId, admin, Json.obj("values", Json.obj("allowInput", 1)), 200);

        quest.setPaused(true);
        check(toolError(Json.obj("action", "look")).contains("paused"), "paused in the app: Axis hears the refusal");
        quest.setPaused(false);

        System.out.println("[deadline] a dump that hangs on the headset");
        adbd.slowFor = "uiautomator";
        adbd.slowMs = 14_000;
        long t0 = System.currentTimeMillis();
        String slow = toolError(Json.obj("action", "look"));
        long took = System.currentTimeMillis() - t0;
        check(slow.contains("took longer than"), "the headset's own deadline answered before Axis's 15 s: " + slow);
        check(took < 14_000, "in " + took + " ms");
        adbd.slowFor = null;
        check(Json.list(tool(Json.obj("action", "look")).get("elements")).size() == 17, "the next look works on a new adb connection");

        System.out.println("[fast engine] the same tool calls through the pretend helper");
        FakeHelper fh = new FakeHelper(QuestIdentity.VERSION, plain);
        adbd.answer = fh.adbd(T.headset(xml, focus));
        quest.helper.setHost(new HelperTest.Host("PK pretend helper for the e2e"));
        quest.helper.setChannel(fh.channel());
        quest.helper.retryFirstMs = 200;
        quest.helper.tick();
        equal(quest.helper.state(), Helper.State.FAST, "installed and started through the pretend adbd: Fast");
        adbd.take();
        fh.take();
        equal(Json.list(tool(Json.obj("action", "look")).get("elements")).get(7), "8 listitem 24,170 300x240 Beyond Sandbox — Free", "look: the same line, from the helper's dump");
        check(adbd.take().stream().noneMatch(c -> c.contains("uiautomator")), "no uiautomator dump on the headset");
        click = tool(Json.obj("action", "click", "name", "Beyond Sandbox"));
        equal(click.get("how") + " " + click.get("x") + "," + click.get("y"), "tap 174,290", "click by name: the same answer");
        List<String> helped = fh.take();
        check(helped.size() == 1 && helped.get(0).equals("tap 174,290"), "the helper touched it at its centre: " + helped);
        List<String> shellNow = adbd.take();
        check(shellNow.stream().noneMatch(c -> c.startsWith("input")), "and the shell got no input tap");
        check(shellNow.stream().noneMatch(c -> c.startsWith("dumpsys window")) && "Store (com.oculus.store)".equals(Json.map(click.get("after")).get("window")),
                "after came from the helper: no dumpsys window (" + shellNow.size() + " shell calls)");
        type = tool(Json.obj("action", "type", "into", "Search", "text", "héllo wörld"));
        equal(type.get("typed"), 11L, "type: 11 characters, not plain ASCII");
        check(fh.take().contains("setText search_input = héllo wörld @11"), "through setText");
        check(adbd.take().stream().noneMatch(c -> c.startsWith("input")), "no input text");
        tool(Json.obj("action", "look"));
        fh.take();
        equal(tool(Json.obj("action", "scroll", "go", "down")).get("how"), "scroll", "scroll: the list's own scrolling");
        equal(fh.take(), Arrays.asList("scroll forward"), "one page forward");
        call("PATCH", "/admin/settings/device/" + pairing.clientId, admin, Json.obj("values", Json.obj("allowScreenshot", 1)), 200);
        Thread.sleep(300);
        shot = mcp("tools/call", Json.obj("name", "vortex_axis_desktop", "arguments", Json.obj("action", "screenshot", "detail", "low")));
        check(Json.write(shot).contains("image/jpeg") && Json.write(shot).contains("640x400"), "screenshot through the helper");
        check(fh.take().contains("screenshot 640") && adbd.take().stream().noneMatch(c -> c.startsWith("screencap")), "UiAutomation's picture, no screencap");

        System.out.println("[fast engine] the helper dies mid-session");
        fh.die();
        Thread.sleep(150);
        check(Json.list(tool(Json.obj("action", "look")).get("elements")).size() == 17, "the next look still answers");
        check(adbd.take().stream().anyMatch(c -> c.contains("uiautomator dump")), "through uiautomator");
        equal(quest.helper.state(), Helper.State.BASIC, "the engine says Basic");
        Thread.sleep(300);
        quest.helper.tick();
        equal(quest.helper.state(), Helper.State.FAST, "started again at the next check");
        tool(Json.obj("action", "click", "x", 10, "y", 20));
        equal(fh.take(), Arrays.asList("tap 10,20"), "and used again");
        check(adbd.take().stream().noneMatch(c -> c.startsWith("input")), "with no shell input");
        quest.helper.shutdown();

        System.out.println("[admin page]");
        Map<String, Object> hello = call("POST", "/admin/clients/" + pairing.clientId + "/commands/desktop.hello", admin, null, 200);
        check(Boolean.TRUE.equals(hello.get("ok")) && "meta-quest".equals(Json.map(hello.get("payload")).get("platform")), "Check the headset: " + hello.get("payload"));
        Map<String, Object> update = call("POST", "/admin/clients/" + pairing.clientId + "/update", admin, null, 202);
        equal(update.get("to"), newVersion, "Update from the admin page again: accepted (" + update + ")");

        System.out.println("[forget] the admin removes the headset");
        call("DELETE", "/admin/clients/" + pairing.clientId, admin, null, 200);
        waitFor(() -> quest.linkState() == AxisLink.State.REFUSED, 8000, "refused");
        check(true, "the app stops and says pair again");
        quest.stop();
        adbd.close();
        System.out.println("E2eTest (" + which + "): ALL PASS (" + T.checks + " checks)");
        System.exit(0);
    }

    interface Cond { boolean ok(); }

    static void waitFor(Cond c, long ms, String what) throws InterruptedException {
        long end = System.currentTimeMillis() + ms;
        while (!c.ok()) {
            if (System.currentTimeMillis() > end) check(false, "waited " + ms + " ms for " + what);
            Thread.sleep(50);
        }
    }

    static Map<String, Object> client(String id) throws Exception {
        for (Object o : Json.list(call("GET", "/admin/clients", admin, null, 200).get("clients"))) {
            Map<String, Object> c = Json.map(o);
            if (id.equals(c.get("id"))) return c;
        }
        throw new AssertionError("client " + id + " not listed");
    }

    static Map<String, Object> call(String method, String path, String token, Object body, int want) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path)).timeout(Duration.ofSeconds(30))
                .header("authorization", "Bearer " + token).header("content-type", "application/json");
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(Json.write(body)));
        HttpResponse<String> res = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != want) check(false, method + " " + path + " answered " + res.statusCode() + ": " + res.body());
        return res.body().isEmpty() ? Json.obj() : Json.parseObject(res.body());
    }

    static Map<String, Object> mcp(String method, Map<String, Object> params) throws Exception {
        return call("POST", "/mcp", agent, Json.obj("jsonrpc", "2.0", "id", rpc++, "method", method, "params", params), 200);
    }

    /** A tool call that must work: its structured result. */
    static Map<String, Object> tool(Map<String, Object> args) throws Exception {
        Map<String, Object> r = Json.map(mcp("tools/call", Json.obj("name", "vortex_axis_desktop", "arguments", args)).get("result"));
        if (Boolean.TRUE.equals(r.get("isError"))) check(false, "tool " + args + " failed: " + Json.write(r.get("content")));
        return Json.map(r.get("structuredContent"));
    }

    /** A tool call that must fail: the words the agent reads. */
    static String toolError(Map<String, Object> args) throws Exception {
        Map<String, Object> r = Json.map(mcp("tools/call", Json.obj("name", "vortex_axis_desktop", "arguments", args)).get("result"));
        if (!Boolean.TRUE.equals(r.get("isError"))) return "(no error: " + Json.write(r.get("structuredContent")) + ")";
        return (String) Json.map(Json.list(r.get("content")).get(0)).get("text");
    }
}
