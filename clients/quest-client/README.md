# VorteX Axis for Meta Quest (experimental)

An Android app for a Meta Quest 3 (also built for 3S, Pro and 2) that lets an agent read and use the headset's **2D panels** (Store, Browser, Settings, Android apps) through Axis's existing desktop tool, `vortex_axis_desktop`, the way the Windows desktop app does for a computer. To Axis it is one more computer: a client of type `meta-quest` ("Meta Quest" on the admin page; `quest-panels` up to 0.2.0, which Axis 0.44.0 and later still take) with the `desktop` capability. The server only adds its updates (`server/src/questapp.ts`).

It works through the headset's own adb: the app connects to `127.0.0.1:5555` on the headset itself and signs in with its own key (the headset asks once, "Allow USB debugging?"). Through it the app installs and starts its **fast engine** (0.3.0, below), a helper that reads and uses the panels directly; when the helper is not running it runs `uiautomator dump`, `input tap`, `input text`, `input swipe`, `input keyevent` and `screencap` there instead. `am start` and `monkey` open apps either way, and `pm install -r` installs its own updates.

**Phase 1:** no voice, no pointer drawn in the headset (a 2D app cannot draw over other panels), not started at boot. It updates itself from Axis (0.2.0).

## What an agent can do

| Action | On a Quest |
|---|---|
| `look`, `find`, `wait` | A dump of the panel in front (the fast engine's, else `uiautomator dump`), made small: wrappers without a label dropped, labels from `content-desc` when the text is empty (React Native panels such as the Store), boxes clipped to the 1280x800 panel and anything off it left out. Then tidied: reading order (bands from the top by each box's centre, left to right in a band; a list's items stay after their list), a tile's short texts folded into its name (`Elixir, Free — 4.1 (900), Games • Simulation`), a tile without a name named by its first label, decoration pictures ("Star icon…", "…, image"), same-box twins and unnamed disabled copies left out, a name shown up to 80 characters (120 with a tile's details) though `find` and `click` by name match all of it. Lines as on Windows: `id kind x,y wxh name [= value] [*focus] [*disabled] [*scrolls]`. |
| `click` | Fast engine: the element pressed by its handle (`ACTION_CLICK`; a touch at its centre when it is not tappable itself), or a touch at x,y. Else `input tap` at the element's centre (or x,y in panel pixels). `double` is two taps; `right` is a long press. |
| `type` | Fast engine: the field given the focus, then its text set with the typed text put in at the caret (any text, Unicode included). Else taps the field, then `input text`: plain ASCII only (that is what `input text` can type). Either way a newline is Enter and a tab is Tab. Never into a password field, never blind into the focus when a password field has it. |
| `keys` | One key or a combination: enter, tab, escape, backspace, delete, arrows, home/end (the text cursor), pageup/pagedown, back, letters, digits, F1-F12, media and volume keys. Fast engine: injected with their modifiers, Back as the system's Back. Else `input keyevent`; combinations (ctrl+a) then need Android 13's `input keycombination`, and an older headset says so. Never power, sleep, recents or the assistant. |
| `scroll` | Fast engine: the list's own scrolling (`ACTION_SCROLL_FORWARD`/`BACKWARD`, a page at a time; `how: "scroll"`), or swipes when it has none. Else `input swipe` inside the element (or the biggest list that scrolls that way), half its size per page; top and bottom are eight quick swipes. |
| `open` | An installed app by the name Android shows (`monkey -p <package>`), Settings, or an http(s) address (`am start -a VIEW`). Never a path or a command. |
| `screenshot` | Fast engine: UiAutomation's screenshot; else `screencap -p`; shrunk to a JPEG like Windows (640/1024/1568). Off unless "Let agents take screenshots" is on. Never while a password field has the focus. |
| `steps` | As on Windows: up to 10, stopping at the first that fails. |
| `point`, `hide` | Accepted and noted, so an agent does not fail; nothing is drawn in phase 1. |
| `switch`, `window`, `desktop`, `clipboard`, `paste` | Refused with "not available on a Quest" and what to do instead. |

Acting answers carry `after` (the app in front, `new` when it changed). With the fast engine it is one call to the helper (`front`), made once the panel has had no accessibility event for 100 ms (400 ms at most); without it, `dumpsys window` 300 ms after the action. `open` waits for the app it started to come to the front (looking every 100 ms with the fast engine, every 250 ms without, 2 s at most) instead of a fixed 1.2 s. Before typing blind into the focus, the fast engine is asked what has the focus (`focus`) instead of reading the whole panel. A look's `device` line tells agents to trust `after` and to wait for a name rather than for a number of milliseconds.

The answers have the same shapes whichever engine did the work. The guards are the Windows app's: Pause in the app (or its notification) refuses everything; Axis's per-device switches (read, tap and type, screenshots) are checked by Axis and again by the app; every adb call and every call to the helper has a deadline (a dump gives up after 10 s, before Axis's 15 s, and says so); one command at a time; and Axis's own rule that a task running with nobody watching is look-only applies here as to any computer.

## Requirements

- A Quest with **developer mode** on (Meta Horizon app on the phone: the headset's settings, Developer mode).
- A computer with `adb`, after every restart of the headset (see below).
- An Axis it can reach. Plain `http://` on the local network works.

## Install

Build it (below) or take `quest-client.apk` from the data folder, then with the headset on a USB cable:

```bash
adb install -r quest-client.apk
```

It shows in the headset's Library under **Unknown Sources** as "VorteX Axis". That first install is by hand; so are developer mode, `adb tcpip 5555` after each restart, and tapping Allow once (below).

## Updates from Axis

After that the app updates itself, like the desktop app. `scripts/build-quest-client.sh` puts the APK and a `version.json` in the data folder's `quest/`, and Axis tells every connected headset with an older version to update (when it connects, or within five minutes of a new build), unless "Update automatically" is off on its admin page; the device page has an **Update** button too. Never to an older or the same version.

The app takes the offer only if it is newer than itself and on the Axis it is paired with (plain `http://` only on the local network or a tailnet), downloads it with its own token to `/sdcard/Android/data/dev.vortexaxis.quest/files/update/quest-client.apk`, checks its size and SHA-256 and lets Android's package manager check it (this app, same signing key, not an older `versionCode`). Then, through its own adb, it copies the APK to `/data/local/tmp`, answers Axis, and a few seconds later runs `pm install -r` in its own adb stream and waits for it (0.3.0 ran it detached with `nohup`, which never ran on a Quest). Installing over itself ends its process; Android then sends the new build ACTION_MY_PACKAGE_REPLACED, and `UpdatedReceiver` starts the service, which connects. **Recently** then says "Updated to X". When the install fails, the app is still running: Recently has pm's words (`Failure [INSTALL_FAILED_…]`) and the app carries on as it was.

**The signing key.** Android installs an update only when it is signed with the same key as the installed app; the helper checks that the app is signed with its own key, and the app the same of the helper. Builds from `scripts/build-quest-client.sh` share one debug key, kept in the Docker volume `vortex-axis-quest-android`; a build made on another machine (another key) will not install over it: uninstall the app first (`adb uninstall dev.vortexaxis.quest`), which loses the pairing, and install the new one by cable. Every build that goes out needs a higher `versionName` and `versionCode` (`app/build.gradle`, and the same in `helper/build.gradle`: the app expects its helper to say its own version) and `QuestIdentity.VERSION`.

## Set up adb (after every restart of the headset)

```bash
adb tcpip 5555
```

This switches the headset's adb on for TCP until it restarts; the app needs it to reach `127.0.0.1:5555`. Then unplug the cable.

The first time only: open the app, press **Set up** to read the steps and **Ask the headset**. The headset shows **Allow USB debugging?**: tick **Always allow** and press **Allow**. The state turns to **Ready**. "Always allow" lasts across app restarts and headset restarts; `adb tcpip` does not.

## Pair

1. On Axis's admin page, **Add a device**, and make a pairing code.
2. In the app: Axis's address (`192.168.1.20:8440`, `https://axis.example.org`, or an `axis://` setup string that carries the code), the code, and a name (default "Quest").
3. **Pair**. The pill says **Connected**. On Axis, the headset is listed as a **Meta Quest** (`meta-quest`); switch the desktop tool on (Agent tools) if it is not yet, and its switches are on its device page.

The Status tab shows the connection (Connected, Connecting, Offline, Pair again, Paused), adb (Not set up, Reachable needs Allow, Ready), the engine and **Use fast engine**, Pause, **Test** (the panel read with the fast engine, then with uiautomator normally and with `--compressed`: for each, nodes and kept, and where the time went), **Faster looks** (below), **Recently** (the last 30 things done), **Copy diagnostics** and **Forget this pairing** (remove the device on Axis's admin page too). A foreground service with a notification (Pause/Resume) keeps both links up while the window is closed; open the app once after the headset starts.

## The fast engine (0.3.0)

`uiautomator dump` starts a process and waits for the panel to be idle on every look, and every action is another `input` process. The fast engine is a small second app, **`dev.vortexaxis.quest.helper`**, built with this one, signed with the same key and carried inside it (`assets/helper.apk`). It has no window. It holds one UiAutomation connection for as long as it runs, so a look is one call, and an element is pressed, filled or scrolled by its handle from the last look.

- **Installed and started by the app, through its adb.** When adb is Ready, the app checks the helper is there and is the build it carries (by its SHA-256, noted in `/data/local/tmp/vortex-axis-helper.sha`); if not, it copies it to `/data/local/tmp` and runs `pm install -r` (an update of the app brings a new helper, installed the same way afterwards). Then it starts it as adb's shell user, detached as the self-update is: `am instrument -w -e uid <this app's uid> dev.vortexaxis.quest.helper/.Helper`. The helper is an instrumentation of itself: `am instrument` stops its target first, and this app must not stop itself.
- **Only this app may use it.** It listens on `127.0.0.1` at a port the app picks for each start (0.3.0 used an abstract local socket, which the headset's SELinux policy refuses an app: "Permission denied"), and answers only an app that proves it holds the secret the app gave it on the start command: a challenge each way, answered with an HMAC, so the secret never crosses the connection (`HelperProtocol`, tested in `HandshakeTest`). Any other app on the headset can connect to a loopback port, and gets nothing answered; one that got to the port first learns nothing it could use. The helper still checks the start named this app's uid and that the app is signed with its key. Android refuses any socket to a package without INTERNET, so the helper declares that one permission.
- **Kept up.** The app checks it every ten seconds: pings it when idle, and starts it again when it stops answering, after a wait that grows each time (10 s, 20 s, … up to five minutes). It dies when the headset restarts, as `adb tcpip` does, and comes back once adb is set up again. It ends by itself when the app has not been heard for ten minutes.
- **Fallback, per call.** While it is not running, or when a call to it gets no answer, the app does that call the old way. A helper that stops answering is stopped (uiautomator cannot read while it holds the screen) and started again later; that is said once in Recently, never retried in a loop. An action it was sent and never answered (a tap that may have happened) is not repeated through the shell: the agent is told to look again.
- **Typing** with the fast engine puts the text in at the caret of the field, over any selection, as typing on a keyboard (or the Windows app) does: into a focused empty field that is the same as replacing; into a field that already has text it is added where the caret is, at the end when the field never had the focus. A field showing only its hint counts as empty.
- **States** in the window: **Fast (helper)**, **Starting**, **Basic (uiautomator)**. **Use fast engine** (on by default) switches it off; off, the helper is stopped.
- While it runs, `uiautomator dump` from a computer fails (only one UiAutomation at a time). Switch the engine off, or `adb shell am force-stop dev.vortexaxis.quest.helper`.

## Live

The window has two tabs. **Live** is made to be read from a distance in the headset: what the app is doing now in plain words ("Looking at Store…", "Tapping "Elixir"…", "Typing 11 characters…", "Idle"), what it did last, when and how long it took, Axis, adb and the engine as coloured dots, the last eight actions, and a big **Pause**/**Resume**. It changes as things happen (the app tells it; nothing polls). The foreground notification says the same line. **Status** has everything below. There is no pointer or overlay on the other panels: a 2D app cannot draw over them.

## Faster looks

For the uiautomator way only (the fast engine always reads the whole tree). A switch in the window, off by default and kept across restarts. On, agents' looks through uiautomator use `uiautomator dump --compressed`, which leaves out nodes uiautomator thinks unimportant: quicker on a big panel, but it **may hide things an agent needs**. Press **Test** to see the fast engine's read and both uiautomator ways on the panel in front (timings and how many things each keeps; the helper is stopped for the uiautomator reads and started again). Copy diagnostics says which is on and how the last look went.

## Limits

- **2D panels only**, one at a time: the panel in front. Never immersive apps or games (they have no accessibility tree; `screencap` may show nothing useful there).
- `adb tcpip 5555` does not survive a restart of the headset.
- Without the fast engine, typing is plain ASCII and a literal `%s` cannot be typed (adb's `input text` turns it into a space). With it, any text.
- The fast engine is started from adb, so it is there only while adb is; it dies with the headset's restart.
- Labels come from what apps expose to accessibility; a panel that exposes little gives little.
- Not started at boot, no pointer drawn, no voice. Updates from Axis need adb Ready (they install through it) and the same signing key.

## Logs

`/sdcard/Android/data/dev.vortexaxis.quest/files/axis.log` (rolls over at 512 KB; one old copy, `axis.log.1`), and in the app **Copy diagnostics**. Neither ever holds the token or typed text (only its length); a password field's content is never read into a look.

```bash
adb pull /sdcard/Android/data/dev.vortexaxis.quest/files/axis.log
```

## Build and test

```bash
scripts/build-quest-client.sh    # JVM tests of the core, then the helper APK and the app APK carrying it, in Docker; checks the helper
                                 # with aapt2 -> $AXIS_DATA_PATH/quest/quest-client.apk + version.json (.out/quest-helper.apk alone)
scripts/test-quest-client.sh     # the JVM tests, then end to end against a real Axis built from this checkout
```

Both use the Quest probe's build image (`clients/quest-probe/Dockerfile`: JDK 17, Android SDK 34, Gradle 8.7) and its Gradle cache volume. The end-to-end test starts this checkout's server in Docker (Node 24) on a free port with a throwaway data folder and admin token, makes a pairing code on the admin API, pairs through `/v1/pair`, connects the socket, mints an agent token and calls `vortex_axis_desktop` through `POST /mcp`; each call goes through Axis to this client and on to a pretend adbd serving `test/fixtures/store-panel.xml`; before the agent part it puts a pretend newer build in that Axis's data folder and checks that Axis offers it, the client downloads it through `/v1/quest/app` with its token and checks it, and the expected `cp` and `pm install -r` reach the pretend adbd, and that the admin Update works. Then a headset still on 0.2.0 (type `quest-panels`) pairs and connects and is offered and fetches the update; then the fast engine, with a pretend helper (the real `HelperRouter` over the fixture): installed and started through the pretend adbd, look, click by name (the helper pressed it by handle, the shell got no `input tap`), type (Unicode, through setText), scroll, screenshot, the helper dying mid-session (the next look through uiautomator) and coming back. It runs twice, with the JDK's WebSocket and with the OkHttp one the app uses.

`HelperTest` (JVM, fakes only) covers the helper's own plain-Java parts (the wire, the router and its handle table, stale handles, password fields, typing at the caret, a dump read back into the same panel line for line as from uiautomator's XML) and the app's side (install and start commands, every command through the helper, a helper that hangs or dies, an action it never answered not repeated, the Test button, a new helper build after the app updates itself, the switch). The Android glue (`helper/src/.../Helper.java` and `Screen.java`, `AndroidParts`) is thin and cannot run here.

## Layout

```
core/src/dev/vortexaxis/quest/core/   all the logic, plain Java, no android.*: Axis link and pairing (AxisLink, AxisAddress),
                                      adb (AdbClient from the probe, AdbLink), the panel reader (Panel), the commands
                                      (PanelCommands, Keys, Shell), updates (SelfUpdate), the fast engine (Helper: the
                                      app's side; HelperProtocol, HelperRouter, HelperServer: the helper's, shared),
                                      the identity, the log, JSON
app/src/main/java/dev/vortexaxis/quest/  the Android glue: window (Live, Status), foreground service, Keystore sealing,
                                      pictures, the app list, OkHttp, the helper's APK and its socket
helper/src/main/java/dev/vortexaxis/quest/helper/  the helper's Android glue: the instrumentation (Helper) and
                                      UiAutomation (Screen); the rest is ../core
test/                                 JVM tests (no JUnit): AdbClientTest, UnitTest, CommandsTest, UpdateTest, HelperTest,
                                      E2eTest, the pretend adbd and helper (FakeAdbd, FakeHelper); run.sh;
                                      fixtures/: store-panel.xml, store-home.xml (modelled on a real look at the Store)
```

The token and the adb key are sealed with an AES key held in the Android Keystore (`SecretBox`) and kept in the app's private preferences.
