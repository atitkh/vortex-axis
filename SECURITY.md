# Security

VorteX Axis sits between an AI agent and the devices around a person: microphones, speakers, screens and, with the desktop app or the Quest app, a computer or headset an agent can read and act on. This page says what protects what, what you have to do yourself, and what is not protected.

Report a problem privately rather than in a public issue: on GitHub, the repository's **Security** tab, **Report a vulnerability**. Say what you found, how to see it, and which version.

## The three doors

**The admin side** (`/admin`, `/admin/*`): one token, `AXIS_ADMIN_TOKEN`, sent as a bearer token. It must be 24 characters or more; shorter, or unset, and the admin side is off. Make one with `openssl rand -hex 24`. Compared in constant time; ten wrong tokens from one address shut that address out for five minutes. The admin page keeps the token for the tab, or in the browser's storage when "Remember on this device" is ticked.

**Devices** (`/v1/pair`, the `/v1/client` socket, `/v1/*`): a device pairs once with a short-lived code an admin made (six digits, attempts limited per address) and gets its own token. Axis stores only a hash of it. A device can act only as itself: its own settings, its own volume, the firmware or desktop app meant for its type.

**Agents** (`POST /mcp`): a token an admin made on the Agent tools page, hashed, with the same lockout as the admin side. Each tool can be switched off for every agent. Experimental tools (the desktop tool) are off until an admin switches them on.

## Under a public name

Axis can be reached from outside through a tunnel or reverse proxy. List those names in `AXIS_PUBLIC_HOSTS`: under them `/admin` (and, for Axis 0.57.0 only, `/admin-classic` and the `/admin-next` redirect), the admin API, the Home Assistant blueprint and (unless `AXIS_MCP_PUBLIC` is set) `/mcp` answer 404, so only devices see Axis from outside. Set `AXIS_TRUSTED_PROXIES` to the proxy's address so the lockouts count the real caller and not the proxy.

Two things to get right:
- The proxy must pass the public name as the `Host` header (most do). A proxy that rewrites it to `localhost` makes every outside request look local, and the admin side answers it (it still needs the token).
- Axis itself speaks plain HTTP. Encryption is the proxy's job. Over plain HTTP on a local network, anyone on that network can read what devices say and send.

## On the host

The data folder holds the database: the gateway link's private key, the keys for web push, every token's hash, settings and the activity log. Axis makes the folder and the file readable by its own user only (`700` and `600`), and does the same to its backups, where the folder allows it (network shares may not). Keep the folder off shared storage that other people can read, and keep `.env` (the admin token) the same way.

Words people say are not stored: turns and the live page keep them in memory and drop them after minutes. The activity log keeps times and outcomes, not words.

## The desktop app

The desktop app lets an agent read a computer's screen and, if allowed, click and type on it. It is EXPERIMENTAL.

- Off by default at the hub: the desktop tool is an experimental tool, off until an admin switches it on.
- Per computer, on its admin page: "Let agents read the screen" and "Let agents click and type" (on), "Let agents take screenshots" (off). Axis checks them, and so does the app.
- On the computer: Pause (window, tray or Ctrl+Alt+S) stops everything. A pill at the top of the screen shows while an agent is using it.
- The app never types into a password field, never takes a screenshot while one has the focus, and never presses lock, sign-out, the security screen, Task Manager, Alt+F4, Win+R or Win+X. It opens only Start-menu apps and http(s) addresses, never a path or a command.
- **Asking first** (Axis 0.45.0): before a click or drag on something named to send, post, delete, buy, pay, sign out, install and the like, or Enter in a mail, chat or payment window, Axis asks the person itself ("Allow" / "Deny", 30 seconds, silence is no), on the computer or a device near it; an agent's word does not count. Allow covers that one call. Per computer it can be switched off ("confirmRisky"). It goes by names: an element whose name gives no hint (an icon with no name, a spot on a canvas) is not asked about, and a click by id or point is named from the last look, so it can be wrong when the screen changed since.
- **A block list** (Agent tools page): apps and windows, by part of their names, that are never read and never acted on. Axis refuses calls that name one and keeps such a window out of answers; the app (from 0.10.0) refuses to read or act on it when it is in front. With an older app, Axis can only keep what is read out of the answer, and an action on it is not stopped.

**Things done later, with nobody watching.** An agent can leave itself a task for later (a timer with something to do). While such a task runs, the desktop tool is look-only: nothing is clicked or typed. It may act only if the person allowed it when the task was set, and Axis asks them that itself, on the device, with its own question; an agent's word that they agreed does not count. This governs Axis's desktop tool only. Whatever else an agent can do through its own harness (send mail, run commands) is not Axis's to limit.

**Updates.** Axis tells a computer to update when it has a newer build; the app downloads it with its own token and checks its size and SHA-256 before swapping it in. Both come from the same Axis, so the check guards against a broken download, not against a hostile Axis. The app refuses an update over plain HTTP unless Axis is on the same computer, the local network or a tailnet. The app is not code-signed yet, so Windows SmartScreen warns when it is first run (docs/hardware.md says what to click, and how to build it yourself instead).

**What an agent sees goes to its model.** Screen text from looks, and screenshots when they are on, are sent to whatever model the agent uses, and they stay in that agent's conversation history. Axis keeps none of it.

## The Quest app

The Quest app (`clients/quest-client/`, EXPERIMENTAL) is a computer to Axis, so everything above applies to it: the desktop tool off until switched on, the per-device switches (checked by Axis and by the app), Pause in the app and its notification, look-only while a task runs with nobody watching, no typing into password fields and no screenshot while one has the focus.

What is different: it acts through the headset's own adb. Its key, once allowed on the headset ("Always allow"), lets the app run shell commands as adb's `shell` user: anything a computer on the cable could do with `adb shell`, including installing and removing apps. The app only ever sends its own fixed commands (`uiautomator dump`, `input`, `am start`, `monkey -p <package>`, `cmd package query-activities`, `dumpsys window`, `screencap`, for its own update `cp` and `pm install -r`, and for the fast engine's helper `pm list packages`, `cp`, `pm install -r`, `am instrument` and `am force-stop` of that one package); an agent's words reach them only as numbers it has checked, a package name matched against a strict pattern, an http(s) address checked and quoted, or text inside single quotes. It never presses power, sleep or recents. While `adb tcpip 5555` is on (until the headset restarts), the port is open on the network too; adb lets in only keys the headset was told to trust, so switch it on only on a network you trust and accept only prompts you expect. Revoke the app's key on the headset (Developer settings, revoke USB debugging authorisations) to take its access away.

**The fast engine's helper** (0.3.0). The app carries a second, small APK, `dev.vortexaxis.quest.helper`, signed with the same key, and installs it through its own adb (`pm install -r`, only when it is missing or is not the build the app carries, told by its SHA-256 noted in `/data/local/tmp`). It starts it the same way, as adb's `shell` user: `am instrument -w -e uid <the app's uid> dev.vortexaxis.quest.helper/.Helper`, detached. That start is what gives the helper a UiAutomation connection, the same power `uiautomator` has: read every window's accessibility tree (what the screen shows, as text), take screenshots, inject touches and keys, press Back. The helper does nothing on its own: it listens on `127.0.0.1` at a port the app picks for each start (0.3.0's abstract local socket was refused to an app by the headset's SELinux policy), and answers only a peer that proves it holds the secret the app passed on the start command, by a challenge each way answered with an HMAC, so the secret itself never crosses the connection. Any app on the headset can connect to a loopback port, so this is what keeps them out: one that connects gets nothing answered, and one that got to the port first cannot learn the secret or read typed text. The helper also checks that the start named the uid of `dev.vortexaxis.quest`, and that app is signed with the helper's key; the app talks only to a helper package signed with its own key. The helper's package declares the INTERNET permission, which Android requires of any package that opens a socket, even on loopback. Started any other way (another app cannot start it as the shell user) it has no UiAutomation and ends. The rules stay in the app: Pause, the per-device switches, no typing into a password field (the helper refuses that too, for a field it is given and for the field with the focus), no screenshot while one has the focus, the keys never pressed. A password field's text never leaves the helper. It dies when the headset restarts (as `adb tcpip` does), ends when the app has not been heard for ten minutes, and is stopped whenever "Use fast engine" is switched off; remove it with `adb uninstall dev.vortexaxis.quest.helper`. While it runs, `uiautomator dump` from a computer fails (one UiAutomation at a time).

Its Axis token and its adb key are sealed with a key kept in the Android Keystore and stored in the app's private preferences. The log (`axis.log` in the app's external folder, readable over adb) and Copy diagnostics never hold the token, typed text (only its length) or a password field's content.

**Updates.** As for the desktop app: Axis tells a headset to update when it has a newer build (never an older one, and not when the headset's "Update automatically" is off); the app takes only a newer version, only from a path on the Axis it is paired with, downloads it with its own token (`GET /v1/quest/app`, which answers only a Quest headset's own token: type `meta-quest`, which Axis 0.44.0 gives a headset that still says `quest-panels`) into its external files folder, and keeps it only if its size and SHA-256 match what Axis said. It refuses plain HTTP unless Axis is on the headset, the local network or a tailnet. Android's package manager then checks it is this app, not an older build number, and signed with the same key, before the app copies it to `/data/local/tmp` and installs it through its own adb (`pm install -r`, run in the app's own adb stream a few seconds after it has answered; Android restarts the new build by itself). The size and checksum come from the same Axis as the file, so they guard against a broken download, not against a hostile Axis; what stops a hostile Axis from installing just anything is Android's rule that an update must be signed with the installed app's key. The APK is signed only with the build machine's debug key (`scripts/build-quest-client.sh` keeps it in a Docker volume): keep that volume as private as the data folder.

## Boards

Boards keep their Wi-Fi password and token in flash. They trust public certificates for `axis+tls://` addresses and refuse self-signed ones. Firmware updates come only from the Axis a board is paired with, checked by MD5 against what Axis said, and a build that does not reach Axis within three minutes is rolled back. Firmware is not signed.

**The flasher page** (`/flash`) is served to anyone who can reach Axis, under a public name too. It holds no secret: the page, the installer and the firmware, which is public.

## Known gaps

- No signed firmware, desktop app or Quest app.
- The desktop tool's confirmation and block list go by names and titles (see above): an app that names nothing, or a title that does not say what it is, gets neither.
- One admin token for everything; no separate users or roles.
- The admin side is not rate-limited beyond the wrong-token lockout.
