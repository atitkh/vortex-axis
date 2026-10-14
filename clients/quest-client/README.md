# VorteX Axis for Meta Quest (experimental)

An Android app for a Meta Quest 3 (also built for 3S, Pro and 2) that lets an agent read and use the headset's **2D panels** (Store, Browser, Settings, Android apps) through Axis's existing desktop tool, `vortex_axis_desktop`, the way the Windows desktop app does for a computer. To Axis it is one more computer: a client of type `quest-panels` with the `desktop` capability. The server only adds its updates (`server/src/questapp.ts`).

It works through the headset's own adb: the app connects to `127.0.0.1:5555` on the headset itself, signs in with its own key (the headset asks once, "Allow USB debugging?"), and runs `uiautomator dump`, `input tap`, `input text`, `input swipe`, `input keyevent`, `am start` and `screencap` there (and `pm install -r` for its own updates).

**Phase 1:** no voice, no pointer drawn in the headset, not started at boot. It updates itself from Axis (0.2.0).

## What an agent can do

| Action | On a Quest |
|---|---|
| `look`, `find`, `wait` | A dump of the panel in front, made small: wrappers without a label dropped, labels from `content-desc` when the text is empty (React Native panels such as the Store), boxes clipped to the 1280x800 panel and anything off it left out. Then tidied: reading order (bands from the top by each box's centre, left to right in a band; a list's items stay after their list), a tile's short texts folded into its name (`Elixir, Free — 4.1 (900), Games • Simulation`), a tile without a name named by its first label, decoration pictures ("Star icon…", "…, image"), same-box twins and unnamed disabled copies left out, a name shown up to 80 characters (120 with a tile's details) though `find` and `click` by name match all of it. Lines as on Windows: `id kind x,y wxh name [= value] [*focus] [*disabled] [*scrolls]`. |
| `click` | `input tap` at the element's centre (or x,y in panel pixels). `double` is two taps; `right` is a long press. |
| `type` | Taps the field, then `input text`. Plain ASCII only (that is what `input text` can type); a newline is Enter. Never into a password field, never blind into the focus when a password field has it. |
| `keys` | One key or a combination: enter, tab, escape, backspace, delete, arrows, home/end (the text cursor), pageup/pagedown, back, letters, digits, F1-F12, media and volume keys. Combinations (ctrl+a) need Android 13's `input keycombination`; an older headset says so. Never power, sleep, recents or the assistant. |
| `scroll` | `input swipe` inside the element (or the biggest list that scrolls that way), half its size per page; top and bottom are eight quick swipes. |
| `open` | An installed app by the name Android shows (`monkey -p <package>`), Settings, or an http(s) address (`am start -a VIEW`). Never a path or a command. |
| `screenshot` | `screencap -p`, shrunk to a JPEG like Windows (640/1024/1568). Off unless "Let agents take screenshots" is on. Never while a password field has the focus. |
| `steps` | As on Windows: up to 10, stopping at the first that fails. |
| `point`, `hide` | Accepted and noted, so an agent does not fail; nothing is drawn in phase 1. |
| `switch`, `window`, `desktop`, `clipboard`, `paste` | Refused with "not available on a Quest" and what to do instead. |

Acting answers carry `after` (the app in front, `new` when it changed), read cheaply from `dumpsys window`.

The guards are the Windows app's: Pause in the app (or its notification) refuses everything; Axis's per-device switches (read, tap and type, screenshots) are checked by Axis and again by the app; every adb call has a deadline (a dump gives up after 10 s, before Axis's 15 s, and says so); one command at a time on the one adb connection; and Axis's own rule that a task running with nobody watching is look-only applies here as to any computer.

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

The app takes the offer only if it is newer than itself and on the Axis it is paired with (plain `http://` only on the local network or a tailnet), downloads it with its own token to `/sdcard/Android/data/dev.vortexaxis.quest/files/update/quest-client.apk`, checks its size and SHA-256 and lets Android's package manager check it (this app, same signing key, not an older `versionCode`). Then, through its own adb, it copies the APK to `/data/local/tmp`, answers Axis, and starts `pm install -r` detached (`nohup sh -c '…' &`), because installing over itself ends its process; the same script starts the window again (`am start`), which starts the service, which connects. **Recently** then says "Updated to X". When the install fails, the app is still running: Recently has pm's words (`Failure [INSTALL_FAILED_…]`) and the app carries on as it was.

**The signing key.** Android installs an update only when it is signed with the same key as the installed app. Builds from `scripts/build-quest-client.sh` share one debug key, kept in the Docker volume `vortex-axis-quest-android`; a build made on another machine (another key) will not install over it: uninstall the app first (`adb uninstall dev.vortexaxis.quest`), which loses the pairing, and install the new one by cable. Every build that goes out needs a higher `versionName` and `versionCode` (`app/build.gradle`) and `QuestIdentity.VERSION`.

## Set up adb (after every restart of the headset)

```bash
adb tcpip 5555
```

This switches the headset's adb on for TCP until it restarts; the app needs it to reach `127.0.0.1:5555`. Then unplug the cable.

The first time only: open the app, press **Set up** to read the steps and **Ask the headset**. The headset shows **Allow USB debugging?**: tick **Always allow** and press **Allow**. The state turns to **Ready**. "Always allow" lasts across app restarts and headset restarts; `adb tcpip` does not.

## Pair

1. On Axis's admin page, **Add a device**, and make a pairing code.
2. In the app: Axis's address (`192.168.1.20:8440`, `https://axis.example.org`, or an `axis://` setup string that carries the code), the code, and a name (default "Quest").
3. **Pair**. The pill says **Connected**. On Axis, the headset is listed with type `quest-panels`; switch the desktop tool on (Agent tools) if it is not yet, and its switches are on its device page.

The window shows the connection (Connected, Connecting, Offline, Pair again, Paused), adb (Not set up, Reachable needs Allow, Ready), Pause, **Test** (the panel read twice, normally and with `--compressed`: for each, nodes and kept, and where the time went: adb connect if it had to, dump, read-back, parse, total), **Faster looks** (below), **Recently** (the last 30 things done), **Copy diagnostics** and **Forget this pairing** (remove the device on Axis's admin page too). A foreground service with a notification (Pause/Resume) keeps both links up while the window is closed; open the app once after the headset starts.

## Faster looks

A switch in the window, off by default and kept across restarts. On, agents' looks use `uiautomator dump --compressed`, which leaves out nodes uiautomator thinks unimportant: quicker on a big panel, but it **may hide things an agent needs**. Press **Test** to see both ways on the panel in front (timings and how many things each keeps) before switching it on. Copy diagnostics says which is on and how the last look went.

## Limits

- **2D panels only**, one at a time: the panel in front. Never immersive apps or games (they have no accessibility tree; `screencap` may show nothing useful there).
- `adb tcpip 5555` does not survive a restart of the headset.
- Typing is plain ASCII. A literal `%s` cannot be typed (adb's `input text` turns it into a space).
- Labels come from what apps expose to accessibility; a panel that exposes little gives little.
- Not started at boot, no pointer drawn, no voice. Updates from Axis need adb Ready (they install through it) and the same signing key.

## Logs

`/sdcard/Android/data/dev.vortexaxis.quest/files/axis.log` (rolls over at 512 KB; one old copy, `axis.log.1`), and in the app **Copy diagnostics**. Neither ever holds the token or typed text (only its length); a password field's content is never read into a look.

```bash
adb pull /sdcard/Android/data/dev.vortexaxis.quest/files/axis.log
```

## Build and test

```bash
scripts/build-quest-client.sh    # JVM tests of the core, then the APK in Docker -> $AXIS_DATA_PATH/quest/quest-client.apk + version.json
scripts/test-quest-client.sh     # the JVM tests, then end to end against a real Axis built from this checkout
```

Both use the Quest probe's build image (`clients/quest-probe/Dockerfile`: JDK 17, Android SDK 34, Gradle 8.7) and its Gradle cache volume. The end-to-end test starts this checkout's server in Docker (Node 24) on a free port with a throwaway data folder and admin token, makes a pairing code on the admin API, pairs through `/v1/pair`, connects the socket, mints an agent token and calls `vortex_axis_desktop` through `POST /mcp`; each call goes through Axis to this client and on to a pretend adbd serving `test/fixtures/store-panel.xml`; before the agent part it puts a pretend newer build in that Axis's data folder and checks that Axis offers it, the client downloads it through `/v1/quest/app` with its token and checks it, and the expected `cp` and detached `pm install -r` reach the pretend adbd, and that the admin Update works. It runs twice, with the JDK's WebSocket and with the OkHttp one the app uses.

## Layout

```
core/src/dev/vortexaxis/quest/core/   all the logic, plain Java, no android.*: Axis link and pairing (AxisLink, AxisAddress),
                                      adb (AdbClient from the probe, AdbLink), the panel reader (Panel), the commands
                                      (PanelCommands, Keys, Shell), updates (SelfUpdate), the identity, the log, JSON
app/src/main/java/dev/vortexaxis/quest/  the Android glue: window, foreground service, Keystore sealing, pictures,
                                      the app list, OkHttp
test/                                 JVM tests (no JUnit): AdbClientTest, UnitTest, CommandsTest, UpdateTest, E2eTest; run.sh;
                                      fixtures/: store-panel.xml, store-home.xml (modelled on a real look at the Store)
```

The token and the adb key are sealed with an AES key held in the Android Keystore (`SecretBox`) and kept in the app's private preferences.
