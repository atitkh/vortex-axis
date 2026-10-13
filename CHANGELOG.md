# Changelog

What changed in VorteX Axis, newest first. One number covers the server and its web pages (the admin page and the web client), which ship together; it is written once, in the top-level `package.json`. Firmware counts its own versions per device type, and the protocol between devices and Axis has its own single number that changes only when devices and Axis must change how they talk.

Numbers go `0.middle.last`: the middle one for a batch of new things, the last for fixes. Before 0.14.0 everything called itself 0.1.0; the entries below that are written back from the history.

## 0.42.3 (2026-10-13)

- **A task's spoken answer starts with the chime**, the way a timer does, on a device that has one: Axis plays it, gives it a moment, then says "About <title>: ...". Only when there is something to say: a task that answers `NO_REPLY` stays silent and does not chime, and a device without a chime action or a speaker just shows or says the answer as before.

## 0.42.2 (2026-10-13)

- **A task's answer says what it is about.** It opened cold, some minutes after it was asked for. It now begins "About <the task's label, or the start of what was asked>:", as the answer of a run handed over to the background does, in speech and on the screen. A task with nothing to tell still says nothing.
- **A device waits 45 seconds** for the agent before it stops waiting and the run carries on in the background (it was 30, which had started to cut in on ordinary answers). `AXIS_HANDOVER_MS` changes it.

## 0.42.1 (2026-10-13)

- **A board flashed from the flasher page did not start** (owner's first try: "partition 3 invalid ... exceeds flash chip size 0x800000", over and over). PlatformIO's factory image says in its header that the flash is 8 MB, the generic board definition's size, while this board is built for 16 MB; a cable upload corrects the header on the way, a browser flasher writes the file as it is. `scripts/factory-image.mjs` now makes the factory image with esptool, with the size from the board's `platformio.ini` and the checksum renewed, and checks the result; the flasher folder, `push-firmware.mjs` and the release workflow all use it. A board left in that state is fine: flash it again from the page (hold BOOT while plugging in if it is not found). Fixed at the source as well: the board's `platformio.ini` now sets `board_upload.flash_size`, so the bootloader PlatformIO builds has the right size in its header to begin with; the script stays as the check. Only the factory image was affected: updates over Wi-Fi send the application alone, and boards flashed by cable had their header corrected by the upload.

## 0.42.0 (2026-10-13)

**Timers that do something** (owner: "check on it in 20 minutes" set a timer that only reminded him).

- The timer tool's `set` takes **`then`**: an instruction the agent writes to its later self. When the timer is due it does not ring: Axis gives the agent that instruction as a turn of its own (marked as scheduled, with how long ago it was asked for) and the answer is spoken on the device the timer belongs to, like any reply. An answer of `NO_REPLY` says nothing, for "tell me only if it failed". It runs once; repeating is not Axis's job. The countdown on the screens says "Task" for one without a label.
- **Look-only on computers unless the person allowed it, and Axis asks them itself.** While a scheduled task runs, clicking, typing and every other desktop action that changes something is refused (looking goes on), and the agent is told so. To act, the agent sets the task with `act: true`; the device then asks the person, in Axis's own words, "may it click and type on your computer?" with Allow and Look only to tap or say. Only "Allow" counts: no answer, a device that cannot ask, or anything else leaves it look-only, and the tool's answer tells the agent which. An agent saying the person agreed is not enough. A task whose run is handed over to the background stays look-only for 15 minutes more.
- The limit is on Axis's own desktop tool. What an agent does with tools Axis does not provide is its harness's to govern (`SECURITY.md` says so).
- The admin page's Now table shows such a timer as "Task for later" with what it is to do and whether it may act. If a task cannot be carried out, the person is told rather than hearing nothing.
- `Turns.task` starts a turn nobody is asking for just now; `Desktops.holdLookOnly`; timers keep `task` and `may_act`.

## 0.41.3 (2026-10-13)

- **Every Axis serves the flasher, at `/flash`** (owner: why wait for a page on GitHub?). It installs the firmware on the hub's own shelf, so the board ends up on what the hub has; the installer's files are in the image (fetched from npm when it is built), so nothing is loaded from anywhere else. Linked from **Add a device**. Browsers allow USB access only over https or from localhost, and the page says so when it is opened otherwise.
- The firmware shelf keeps a **factory image** beside a build when it is given one: a release image brings it (`bundled/firmware/manifest.json`, `factory`), `scripts/push-firmware.mjs` uploads it, and `POST /admin/firmware/<type>?version=..&part=factory` takes one by hand. Removing a build removes it.
- The standalone flasher folder (GitHub Pages) carries the installer too; no CDN.

## 0.41.2 (2026-10-13)

More of what a stranger needs.

- **A browser flasher for boards** (`flasher/`): a page that puts the firmware on a new board over USB from Chrome or Edge, with ESP Web Tools; no PlatformIO. `scripts/make-flasher.mjs` puts the page, a build's factory image and the manifest together; the release workflow publishes it to GitHub Pages. Checked here that the page loads and its install button comes alive; flashing a board from it has not been tried.
- **`docs/hardware.md`:** the board (what it is, first install three ways, setting up, using it, its limits), the Windows app, a phone or browser, and where to start for another device.
- **`CONTRIBUTING.md`** and issue forms for a bug and an idea. `SECURITY.md` says how to report a problem privately.
- Tests: longer limits and a retry, and fewer at once on CI. The suite timed out on a busy runner (40 of 148 runs on the project's runner had failed that way).

## 0.41.1 (2026-10-13)

Set-up for somebody who has never seen the project.

- **README** rewritten for strangers: what Axis is, what you get, a quick start from the published images, the devices, where to read more. What it held about running and operating Axis is in `docs/setup.md`, unchanged.
- **`compose.release.yaml`:** Axis and its speech services from published images, nothing to build (`compose.yaml` still builds from the repository). The release workflow also pushes the speech image, on GitHub.
- **Getting started** on the admin page's Overview: speech working, an agent that answers (OpenClaw or a chat endpoint, with a link to the other), a first device, a first turn; each step links to the page that does it. It goes when all four are done, or when it is put away.
- `scripts/browser-check.mjs` uses an admin token long enough for 0.40.2's rule, and counts thirteen tool icons.

## 0.41.0 (2026-10-13)

The first release built by the release workflow: the project is free software under the Apache License 2.0, and one version tag now builds everything a person needs.

- **Licence:** Apache-2.0 (`LICENSE`), with `NOTICE` naming what the repository includes from others and what builds fetch.
- **Releases:** a tag `vX.Y.Z` (it must match `package.json`) runs `.github/workflows/release.yml`: the board firmware (an image for updates over Wi-Fi and a factory image for a first flash by cable), the Windows desktop app, and the Axis image with both inside it. On GitHub the image goes to `ghcr.io` for amd64 and arm64 and the files to the release; on a Gitea runner the image is built and checked, and the files go to the release. The test workflow moved beside it to `.github/workflows/` (one place for both); it chooses its runner the same way.
- **A fresh Axis comes with firmware and the desktop app.** A release image carries them in `bundled/`. At start, Axis puts the bundled firmware on the shelf when it is newer than every build of its type there (boards are still only updated when somebody presses Update); the desktop app offered and auto-updated is the newer of the image's and one built on the hub (`scripts/build-desktop.sh`). `AXIS_BUNDLED_DIR` points elsewhere.

## 0.40.2 and desktop app 0.7.7 (2026-10-13)

First part of getting ready to be public: a scrub and a security review (`SECURITY.md`, new).

- **The admin token must be 24 characters or more.** Shorter, the admin side stays off and the log says why (`.env.example` says so too).
- **The data folder and database are for Axis's own user only** (`700`, `600`), and so are backup copies, where the folder allows it. They hold the gateway's private key, the push keys and every token's hash; they were readable by every user on the host.
- **The desktop app will not update over plain HTTP across the internet**: only over https, or to Axis on the same computer, the local network or a tailnet. The checksum came the same way as the program, so it could not protect a download on an open link.
- Scrub: no secret was ever committed (no token, key, `.env` or database in any commit). Current files: a test used the owner's first name, and the status history named the boards; both made generic. The git history still holds installation details (see the project's notes before publishing it).

## Desktop app 0.7.6 (2026-10-13)

- **The face follows the agent's voice.** While it speaks, the figure swells with what is coming out of the speakers (`IVoiceIo.PlayLevel`, measured as the audio is handed to the device; `Voice.Loudness`), as it follows the microphone while listening. It only pulsed on its own before.
- **The pills at the top** share one look (`Pill`): a dark surface a little lighter at the top, a soft shadow, an edge with a hint of the moment's colour, a dot that glows in it, and they fade in and out instead of popping. The voice pill: the word for the moment in its colour, what was heard in quotes and italics, a hairline, then the reply a size larger. The "using this computer" pill: a hairline between the title and the last thing done.
- `CLAUDE.md`'s Status section cut back to the current state; what it held is in `docs/status-history.md`.

## Desktop app 0.7.5 (2026-10-13)

- The face has no disc and no outline any more (owner: the black background with a coloured border looked odd): it sits on a soft dark pool that fades to nothing at its edge, and each dot gives off a little light of its own colour. Window 200 px, the figure in the middle 60 %.

## Desktop app 0.7.4 (2026-10-13)

- **Vortex's face on the computer** (owner's layout: words at the top, the face at the bottom). The boards' face on a dark disc, 132 px, at the bottom centre of the main screen: it fades in for a voice turn (listening follows the microphone, thinking shows the tool icon Axis names, speaking pulses) and while an agent is using the computer (thinking, with the computer icon), and fades out 2.5 s after. Click-through, never takes the focus, out of the picture for captures. Tray: "Show Vortex's face" (on) and "Keep the face on screen (click it to talk)" (off): kept, it idles through the idle looks and a click is the talk key.
- The face is `Face` in Core, a line-for-line port of `web/vortex.js` that gives the platform circles to paint; its icons come from `web/icons.js` by `scripts/gen-icons.mjs` (`FaceIcons.g.cs`). docs/face.md now has three copies to keep in step. Frames rendered on Linux from the real class and looked at: idle, listening, thinking, the computer icon in dots and as a line, speaking. The window itself not run on Windows.
- `Voice.Doing`: what Axis says the agent is doing while it thinks.

## Desktop app 0.7.3 (2026-10-13)

- The voice pill has the look of the "using this computer" pill and sits at the top of the main screen too (it was at the bottom): near-black, a thin edge in the state's colour (mint listening, violet thinking, cyan speaking, blue for a question), as wide as its words up to 460 px. When both show, it sits just under the other and moves up when that one goes.

## Desktop app 0.7.2 and board firmware 0.18.2 (2026-10-13)

- **The computer shows when an agent is using it.** A pill at the top of the main screen, "VorteX is using this computer" with a breathing rose dot and the last thing done, from an agent's first desktop command until 8 s after its last. Click-through, never takes the focus, steps out of the picture for looks that read pixels and for screenshots. Tray: "Show when an agent is using this computer" (on by default). Not while paused, and not for the admin page's "Show the pointer".
- **Boards:** the "Computer in use" glow shows only while the face is idle, not round the thinking face, where it cost frames; the computer icon says it there.

## 0.40.1 and board firmware 0.18.1 (2026-10-13)

- **Swipe down puts finished tasks away.** A `swipe_down` from any device clears the tasks that are done from every screen (`Progress.clearDone`); ones under way or waiting stay. A board sends that swipe while a finished task shows even with its "gestures" setting off.
- **A computer icon** among the tool icons (now thirteen): shown while the agent uses the desktop tool, a harness's computer use or a node's screen snapshot (`doingFor`: desktop, computer, screen snapshot). Rose, like the "Computer in use" glow. Defined in `web/icons.js`, `icons.h` regenerated.
- **Admin Live page:** finished tasks, tool calls, turns and wake words each scroll in their own box (420 px), table headings staying in view.

## Desktop app 0.7.1 (2026-10-13)

- The same as 0.7.0 as described below. A first, unfinished 0.7.0 build (no `screen` capability, so no transcript, reply text or questions in the pill) sat in the data folder for a few minutes during development and the owner's computer updated itself to it; a new number makes it update again. `scripts/build-desktop.sh` publishes at once to every computer with auto-update: bump the version only when a build is meant to go out, and build experiments elsewhere.

## 0.40.0, desktop app 0.7.0 and board firmware 0.18.0 (2026-10-13)

- **The computer as a voice device.** Ctrl+Alt+Space talks from the PC: a press listens until a pause (1.2 s), a hold listens until let go, a press while the agent thinks or speaks stops it; answers play on the PC's speakers and are reported (started, finished, stopped) like a board's. A pill at the bottom of the main screen shows listening (a dot that swells with the voice), what was heard, the reply, and questions with their choices (answered with the same key). The app then says `mic`, `speaker` and `screen`, so the agent's turns are marked as coming from the computer and Axis can speak there. Tray: "Talk from this computer" (on by default; off goes back to a computer only, and reconnects). The protocol and timing are in Core (`Voice`), the platform supplies `IVoiceIo` (Windows: NAudio.Core + NAudio.WinMM 2.2.1, MIT, the first audio dependency). Checked against a throwaway Axis with the real speech services: a recorded sentence went up, came back as "What time is it right now", and an announcement was played and reported heard. Not run on Windows.
- **Boards show when an agent is using a computer.** Axis counts a computer as in use from an agent's desktop call until 8 s after its last; the screens in its location (every screen when it has none) are told `desktop.busy {on, computer}`. Boards (firmware 0.18.0) glow rose along the edges while idle or thinking, setting "Computer in use glow" (`handsGlow`); the glow preview has it as "Computer in use". The admin page's Now table lists "Computer in use" with the last thing the agent did.

## 0.39.0 and desktop app 0.6.0 (2026-10-13)

Owner picked four of the proposed desktop features; also kept portable so the same commands can come to a Mac app (new platform calls are on `IDesktop`, the logic in Core).

- **Auto-update.** Axis serves its desktop build to paired computers (`GET /v1/desktop/app`, the computer's own token, `x-sha256`) and sends `update {version, size, sha256, path}` to a computer that connects with an older version (or is connected when a newer build lands; checked every 5 minutes), unless its new setting "Update automatically" (`autoUpdate`) is off. The admin page's Update button works for computers too. The app downloads next to itself, checks size and SHA-256, renames itself to `.old`, puts the new file in place, starts it (`--updated`: it waits for the old one to quit) and quits; the next start deletes `.old`. Download and checks are in Core (`AppUpdate`); the swap is the Windows app's. A computer offered a version and refusing is not asked again for that version.
- **scroll** (`go` up/down/left/right/top/bottom, `pages` 1-10; a name or id scrolls that list or page): UI Automation's scroll on the element or what holds it, else the mouse wheel over it (or the window in front), the mouse put back.
- **wait for**: `wait` with `name` (in the window in front) or `window`, `gone: true` for until it goes, `seconds` 1-20 (Axis waits that long plus 5 s); checks twice a second; not in time fails saying what is there.
- **clipboard** reads copied text (up to 4000 characters back, `more` when longer); refuses what a password manager marked private; says so when it holds a picture or files. Under "Let agents read the screen".
- **paste** puts any text up to 20,000 characters into a field by name or the focus via the clipboard and Ctrl+V, kept out of Windows' clipboard history, and puts the person's clipboard back afterwards. Its text travels as the command's data. Same rules as type (window brought back, never a password field). Also a step.
- The update cannot reach a computer still on 0.5.0 or older (it has no `update`); install 0.6.0 by hand once.

## Board firmware 0.17.3 (2026-10-13)

- A picture on the board stays through a follow-up: while Axis works out the spoken words and while the agent thinks, the picture keeps showing with the thinking glow around it, as it already did while listening. Before, the picture closed and the face came back as soon as the words were being worked out. A tap, a question with choices, a newer picture or the time running out still close it.

## 0.38.0 and desktop app 0.5.0 (2026-10-12)

Screenshots for agents, as a last resort (owner's design: for understanding only; the agent still acts by name or id, never by coordinates read off a picture).

- **`vortex_axis_desktop` action `screenshot`:** the window in front (default), `id` to crop around an element from the last look or find (with a margin), or `scope: screen`; `detail` low/normal/high = longest side 640/1024/1568 px (a 16:9 window at normal is about 800 tokens). JPEG quality 72, the app's pointer hidden for the capture, refused while a password field has the focus (and when that cannot be checked).
- **Off by default, per computer:** setting "Let agents take screenshots" (`allowScreenshot`), checked by Axis and by the app.
- **An image to the model:** the MCP door lifts `image` out of a result into an MCP image block beside the text; `structuredContent` has no picture. The Live page keeps "[picture]", not the picture.
- **Description:** use only when absolutely necessary (look/find cannot tell: games, 3D/Unity/WebGL, canvases, images, charts; something visual to check; or the person asks to have their screen seen), then act through find/click/type.

## Desktop app 0.4.5 (2026-10-12; replaces 0.4.4, which was never installed)

**The real cause of unanswered looks, since 0.4.0.** 0.4.3's new warning on the owner's PC said it: "the answer could not be sent: JsonSerializerOptions instance must specify a TypeInfoResolver". 0.4.0 made a look's elements plain strings and added them with `JsonArray.Add<string>`, which wraps them so that writing them needs a type resolver; AxisLink writes every message with its own options object, made by hand without one, so turning a look's answer into text threw, and the old code swallowed the error. `find` built its list with explicit `JsonNode` casts and kept working. The look itself took 189 ms on Notepad; nothing was slow.

- Elements are added as `JsonNode`, and AxisLink's options carry a resolver, so the trap is closed twice. Reproduced exactly (same message) with the real Core and the default runtime setting, and fixed.
- Audit: every desktop command (look in all scopes, find, point, hide, wait, hello, click, type, keys, open, switch, window, desktop, steps passing and failing, an unknown command) and the describe message, through the real Core, serialize even with the old resolver-less options.
- 0.4.4 also switched reflection-based JSON off for all desktop builds; that would have broken the app's saved pairing file (`Saved.cs` uses reflection), so 0.4.5 takes it back out.
- The thread-pool explanation given for 0.4.1 was a guess and was wrong about looks; 0.4.1-0.4.3's deadlines on Windows calls, the OCR deadline, the 12 s fallback and the send-failure warnings stay as hardening.

## 0.37.3 and desktop app 0.4.3 (2026-10-12)

On 0.4.2 a look at Notepad showed "Looked at the window: 85 things" in the app, yet Axis heard nothing in 15 s; not even the 12 s fallback answer arrived. The same look answer, built by the real Core from a fake Notepad, is 3.5 KB and passes Axis's protocol check, so the answer is being held up or lost on the PC. Instrumented instead of guessed:

- **Axis logs a late answer** (`answered "desktop.look" N ms after it was sent, too late`), so a slow answer is told apart from a lost one.
- **The app no longer swallows a failed send:** it says so in its own list, as it does an answer that took over 10 s (work vs sending time) and a command that waited over 1 s to start; each with the thread pool's state.
- **Look timings** in the app's list: total, reading the controls, reading the pixels, and the thread pool's state. The list shows seconds.
- **Thread pool floor** of 32 workers, in case slow Windows calls are starving it (what broke 0.4.0).

## 0.37.2 and desktop app 0.4.2 (2026-10-12)

The owner's first run of 0.4.1: open Notepad and type worked, but every `look` still went unanswered while `find` (the same read) answered in 0.2 s.

- **Looks that read pixels never answered.** Every failing look was on a window with few controls (Notepad, a page still loading, the area under the mouse), which turns on OCR; `find` on busy windows never did. The pointer hide, the capture and Windows' OCR now run off the look's thread under one 4 s deadline; past it the look answers without the pixel text and says why (`ocr`). Which of the three hung is not known (no Windows here).
- **Backstop:** look and find always answer within 12 s, naming the trouble, instead of Axis timing out at 15 s.
- **"Brave Windows is not a computer":** an agent that passes the device the person spoke from as `client` now gets the computer (the only one online, or the one in that device's location) instead of an error. Axis also logs a message from a device that it refuses.

## 0.37.1 and desktop app 0.4.1 (2026-10-12)

Fixes from the owner's first use of 0.4.0 (looks never answered; "open Notepad and type hello world" typed into another window's chat box; the pointer barely moved).

- **Looks hung:** every UI Automation call now runs on its own thread with a deadline (`Uia.Run`), never on the thread pool. In 0.4.0 the before/after focus reads gave up after 2 s but left their pool thread blocked inside a window that did not answer; enough of them starved the app until even a look could not reach its own 10 s limit, and Axis gave up at 15 s. A read past its deadline now fails with the window named; with 8 reads stuck, calls fail at once saying a window is frozen. The window title comes from Windows, not UI Automation. OCR has a 4 s limit.
- **open waits for its window:** it waits up to 8 s for a new window (or the front to change, or a window of that app), brings it to the front and answers `note` when none showed. The agent no longer needs a `wait` step.
- **type and keys go to the right window:** the app remembers the window last opened, switched to, clicked or typed in (for 90 s). If something else has taken the front, it is brought back first; when it cannot be, nothing is typed and the error says which window is in front. A dialog that window owns counts as it.
- **The pointer shows every action:** open and switch point at the window, typing points at the field with the text in the bubble (it stays up while typing), keys point at the window; the pointer gets a little longer to glide there.
- Tool description: open and type say the above; the steps example has no `wait`. Package versions back in step.

## 0.37.0 and desktop app 0.4.0 (2026-10-12)

Fewer tokens per task on a computer (owner picked three of the ideas).

- **`after` on every action:** click, type, keys, open, switch, window, desktop and steps answer with the window in front (`new` when it is not the one in front before), what has the focus and its value, read about 0.3 s after the action (1.2 s after an open). Two small UI Automation reads, not a look; the description tells agents to trust it instead of looking again. `steps` carries one `after` at the end (also when a step fails).
- **Leaner looks:** each element is one line, `id kind x,y wxh name [= value] [*focus] [(ocr)]`, about half the text of the old object; `screen`, `mouse`, `window` and `monitors` likewise. `find` matches use the same lines.
- **Shorter tool:** the `vortex_axis_desktop` definition is about 37 % shorter (description and parameters); it now states how looks are ranked (focus, under the mouse, then usable things nearest the mouse). The app's own refusals are no longer listed to agents; they still apply.

## 0.36.0 and desktop app 0.3.0 (2026-10-12)

Fewer model turns per task on a computer (owner's idea: preset commands; the time goes to the agent thinking between calls, not to the PC).

- **By name:** `click`, `point` and `type` (`into`) take a `name` (and `kind` to narrow it), matched in a fresh read of the window in front: same name, then starts with, then a word, then anywhere; usable things first, big containers last; a button wins over its own label inside it. Several equal matches fail with their ids. **`find`** returns the five best matches with ids instead of a whole look.
- **`steps`:** up to 10 of open, switch, window, desktop, click, type, keys, wait, find and point in one call, run in order with a short settle between, stopping at the first that fails; the answer says how each went (`done`, `failed`, `error`). Sent as the new optional `data` on `command` (protocol 1; only the desktop app is ever sent it).
- **Presets:** `open` (a Start-menu app by name, through shell:AppsFolder, or an http(s) address; never a path or a command), `switch` (bring a window to the front by app or title), `window` (minimize, maximize, restore, move to display n; no close), `desktop` (next or previous virtual desktop). All held by the computer's **Let agents click and type** switch.

## 0.35.0 and desktop app 0.2.0 (2026-10-12)

- **Computers can be clicked and typed on (experimental).** `vortex_axis_desktop` gains `click` (an element from the last look, pressed directly through UI Automation where it can be, else a real click there with the mouse put back; or `x`,`y`; `button` left, right or double), `type` (up to 500 characters a call, into an element or whatever has the focus) and `keys` (one combination: enter, ctrl+s, alt+tab…). The app's pointer glides to where it acts first.
- **Limits the agent cannot lift:** never types into a password field (the one named or the one with the focus); never presses lock (Win+L), the security screen, Task Manager, Alt+F4, Win+R or Win+X; everything stops while the app is paused (Ctrl+Alt+S).
- **Off switch:** the computer's setting **Let agents click and type** (`allowInput`, on by default) on its admin page. Axis refuses before asking the computer, and the app refuses too. Looking and pointing go on.
- The tool's description tells agents to look again after anything that changes the screen and to ask with `vortex_axis_ask` before anything hard to undo.

## 0.34.1 and desktop app 0.1.1 (2026-10-12)

- **Several displays:** a look now says where the whole desktop starts (`screen` x, y) and gives each display's box (`monitors`). The first live test had a Discord window on a display above the main one; its buttons had negative y, and the agent took them for off-screen.
- **The best 250, not the first 250:** a busy window's elements are picked before the cut (`DesktopCommands.Pick`): the window, what has the focus and what holds the mouse always; then things that can be used, nearest the mouse first; then the rest. Sent in the window's own order. The app now reads up to 1500 to pick from.
- **A look no longer fails on one odd element:** an element that will not describe itself is left out. In the first live test, two looks at a Brave window failed in 0.4 s with an empty error, and the agent pointed at a guessed spot. Errors now always say what kind they are, in the app's Recently list as well, and Axis words an empty one. The tool's description asks agents to say a look failed rather than point at a guess.

## 0.34.0 and desktop app 0.1.0 (2026-10-12)

- **Computers, experimental: seeing and pointing.** A Windows desktop app (`clients/windows-desktop/`, C#/.NET 8, one self-contained `.exe`, styled like the web client) pairs with Axis as a client with the new `desktop` capability. An agent with the new tool `vortex_axis_desktop` can **look** (the window in front, what is under the mouse, or the open windows: controls by UI Automation, text by Windows' OCR when a window says little; ids, kinds, names, boxes; never a password's value) and **point** (the app's own glowing pointer with the agent's words beside it; the mouse is not moved). The person can pause it from the window, the tray or Ctrl+Alt+S. The tool is MCP only (not on the OpenClaw node, so no re-approval) and, like any experimental tool, off until switched on under Agent tools. `command.result` gains an optional `data` (any JSON). The admin page's **Add a device** offers the app for download once `scripts/build-desktop.sh` has built it into the data folder (`GET /admin/desktop`, `/admin/desktop/app`).

## Board firmware 0.17.2 (2026-10-11)

- Fixed: **Show on the device** (and Find) only sometimes worked. Commands run on the client's task on the other core; the handler stamped the start with `millis()`, which could be later than the screen loop's frame time, so the unsigned elapsed time wrapped round and the glow was cancelled before it was drawn. The handler now leaves a request (under a lock) and the screen loop starts it on its own clock; the corner curve is also only changed from the screen loop now.

## 0.33.1 and board firmware 0.17.1 (2026-10-11)

- The glow preview's **Show on the device** puts the kind of glow picked there on the board for five seconds (the timer's countdown for ten), with the curve on the slider whether saved or not; it ran Find before. `POST /admin/clients/:id/glow` `{kind, corner}` sends the admin-only `command` `glow.show` `{kind, corner, ms}`; the board goes back to its saved curve afterwards. Find stays as the button beside the device's state.

## 0.33.0 and board firmware 0.17.0 (2026-10-11)

- **Find this device.** Boards offer a `find` action: three chimes over about five seconds and a quick white pulse round the screen's edges for eight, ahead of everything but a conversation. The admin page puts a **Find** button beside any device that offers it, on the Clients list and next to the device's state.
- **Blue glow while a question waits elsewhere** (firmware 0.17.0). Axis tells every screen how many questions wait for the person where it is not showing them (`server/src/asklight.ts`, the `command` `ask.waiting` with `elsewhere`): a question open on another device, or an OpenClaw agent's question or approval that is on no device (shown nowhere, or given up on by the device while the gateway still waits; `AgentAsks.unshown`). An idle board pulses its edges blue while there are any, ahead of a task's amber; under the **Notification light** setting. Sent only when a screen's number changes, and on connect.
- **Edge glow preview** on a device's admin page, for devices that offer `glowCorner`: the glow drawn the way the board draws it (glow.cpp ported: depth, curve, colours, paces, the timer's sweep), each kind on a button, a **Glow corner curve** slider that redraws live and saves for that device, and a dashed guide for where the glass hides the corners (kept in the browser only).
- Fixed: the protocol tests had no samples for `gesture`, `reply.image` and `image.*`, so two of them failed since 0.28.0/0.29.0.

## 0.32.0 and board firmware 0.16.0 (2026-10-11)

- **Agent tool calls on the Live page.** Every call of an Axis tool shows as it starts and ends: the tool, who made it (OpenClaw, `MCP: <token name>` or the admin page), what it was given and gave back (click the tool name), how long it took, and done or the reason it was refused (a switched-off tool included). Last 40 kept in memory; what was given and given back is deleted after ten minutes like a turn's words, and with **Clear now**. `InvokeHandler` takes an optional `via`; `Live.recordTools` wraps the guarded handler.
- **Timer countdown glow** (firmware 0.16.0). In a timer's last ten seconds, an idle board's edges glow red, lit clockwise from the top middle and shrinking as the seconds run out, beating once a second. It comes before the notification light. Board setting **Timer countdown glow** (`timerGlow`), on by default.
- Fixed: 0.31.0 raised the version in the top-level `package.json` only; `server/` and `protocol/` now carry the same number again.

## 0.31.0 (2026-10-11)

- **Try a tool** on the admin page's Agent tools page: every agent tool can be called from one form drawn from the tool's own parameters, with a **Send to** choice where the tool can reach more than one device (the device last spoken to, one device, a location, or every device when the tool takes `everywhere`), and the answer shown as the agent would get it. A Try button on each tool's row opens it. It goes through the same function and on/off switch as an agent's call (`POST /admin/mcp/tools/try`), so it acts for real; a reboot asks first. `GET /admin/mcp` now carries each tool's parameters.

## Board firmware 0.15.2 (2026-10-11)

- The glow's corner curve is wider (56 px) and a board setting, **Glow corner curve** (`glowCorner`), so it can be matched to the glass; at 32 px it sat inside the panel's rounded corners and was hidden there.
- Where the glow runs across the face, it now lands in the right place when the board is turned: the face's frame is sent in the panel's own orientation, and `glow::tint` was laying the glow into it as if it were turned, so the amber line showed down the face's side instead of along the top edge.

## Board firmware 0.15.1 (2026-10-11)

- The edge glow turns the corners on a curve (32 px) instead of two bands crossing in a square, so it follows the panel's rounded corners as one line.
- The notification light no longer breaks where the face meets the top edge (sideways, with a caption up): the glow is laid into the face's own frame there (`glow::tint`), so it runs on unbroken.

## Board firmware 0.15.0 (2026-10-11)

- **Notification light.** While a board is idle, its screen edges glow amber, breathing slowly, while a task waits for the person, and flash green for a moment when a task finishes (silent, so also in quiet hours). It never draws over the face and goes away during a conversation. Board setting **Notification light** turns it off. Built on the edge glow (`glow.cpp`), which now also lays itself over a black screen and leaves a given rectangle alone.

## 0.30.1 (2026-10-11), board firmware 0.14.1

- **Web client:** a picture from a reply shows on the main screen under the answer too, not only in the history; it goes when the next exchange starts. Tap for full size.
- **Boards:** a picture stays through the follow-up listening after the answer, and until 30 s after the speech ends; it closes on a tap, when you actually say something, on a question, or when the time is up. While it is up, listening, thinking and speaking show as a glow along the screen edges in the face's colours for each (`glow.cpp`), which anything full screen can use later.

## 0.30.0 (2026-10-11), board firmware 0.14.0

- **Pictures on boards.** A board shows a picture from an agent's reply full screen for 30 s; a tap, listening or a question closes it. Axis shrinks the picture to the board's screen as a JPEG (`fit.ts`, in a worker thread) and sends it over the board's socket (new capability `image-frames`, messages `image.start`, `image.data`, `image.end`), since a board cannot open a second encrypted connection. First server dependencies besides `ws`: `pngjs` 7.0.0 and `jpeg-js` 0.4.4, pinned. Board firmware uses JPEGDEC 1.8.4.

## 0.29.0 (2026-10-11)

- **Pictures in replies.** A picture an agent attaches to a reply (`MEDIA:` line) is fetched from the gateway and shown under the answer on clients with the new `images` capability (the web client, so phones and the Quest panel too); tap to open it full size. New server message `reply.image`. The `MEDIA:` line itself is no longer spoken or shown. Pictures are kept a day, in memory. A handed-over run's pictures come with its answer. Boards do not show pictures yet.

## 0.28.1 (2026-10-11)

- **A finished task leaves the screens again.** Since 0.27 the live activities look at the task list every few seconds; a look that found a finished task expired took it away without telling the screens, so boards and web clients kept showing it. Whoever finds a task gone now tells the screens.

## 0.28.0 (2026-10-11), board firmware 0.13.1

- **Boards as Home Assistant sensors.** A board reports how loud its room is (`soundDb`, dB of microphone full scale over 5 s, in 2 dB steps) and whether there has been sound well above the room's usual level in the last 15 s (`soundActive`), levels only and never audio, with its own speech left out; Axis shows them as a **Sound level** sensor and a **Sound** binary sensor (device class sound), unavailable while the board is offline. Board setting **Room sound to Axis** turns it off.
- Firmware 0.13.1: a reading that changes is sent on the next pass; before, any change in the first minute after a start held all readings back until the minute was up.
- **Touch gestures as events.** A hold or a swipe (left, right, up, down, as the screen shows it) on a board goes to Axis as a new client message `gesture` and on to Home Assistant as an event of the board's **Gesture** entity, for automations. Taps still talk and answer. Board setting **Gestures to Axis** turns it off.

## 0.27.4 (2026-10-11)

- **Live activities sooner on the phone.** Every change of state (needs you, done, back to work, a timer going off) now goes at full priority, with a sound; only a step within the same state goes quietly, at the low priority iOS may hold back. A timer's activity says "Done" the moment it is due, not once the device has finished announcing it.

## 0.27.3 (2026-10-11)

- **Back out 0.27.2.** The "needs you" notification is sent again while away even when a phone also shows the live activity: tapping the notification opens the installed web app, which tapping a live activity cannot (iOS opens it in the browser).

## 0.27.2 (2026-10-11)

- **No double "needs you".** When a task's "needs you" went to a phone as a live activity and Home Assistant says it passed that one on within 10 s, Axis no longer also sends its own notification for it (that was the one case where both sounded). Without that word, the notification goes as before.

## 0.27.1 (2026-10-11)

- **Send a test (live activities)** uses a new tag each time (iOS may not start an activity again on a tag just ended, and a second press no longer ends the first one's test early), and waits up to 5 s to say which phones Home Assistant passed it to, or that it did not.

## 0.27.0 (2026-10-11)

- **Live activities on phones.** Tasks and timers can show on the lock screen and in the Dynamic Island of a phone with the Home Assistant app (Live Updates on Android), through Home Assistant (`liveactivity.ts`). Axis only speaks MQTT to Home Assistant, so it publishes each activity on `vortex-axis/live` and a blueprint it serves (`/ha/vortex_axis_live_activities.yaml`, local network only, with an import link on the Integrations page) passes it to the chosen phone and acknowledges on `vortex-axis/live/ack`. Off by default; offered only while the Home Assistant link is connected, with a switch and a Send a test button on the Integrations page (`liveActivities`, or `AXIS_LIVE_ACTIVITIES`).
- What shows, with iOS's limits in mind: a task once it has run 30 s, or at once when it waits for the person ("needs you", the only update that sounds); a finished task quietly, until it leaves the screens; a timer of a minute or more as a countdown, "Done" with a sound when it goes off, gone a minute later or at once when cancelled. Updates to one activity are at least 10 s apart unless its state changes. Activities left by an Axis that restarted are ended. Tapping one opens the web client when Axis has a public name.

## 0.26.0 (2026-10-10)

- **Long agent work carries on without the device.** When the agent has said nothing new for 30 s (`AXIS_HANDOVER_MS`, 0 to switch off), the device says "On it, I'll tell you when it's done" and is free again. Axis keeps following the run (`background.ts`; the gateway follow limit is now 30 minutes instead of 120 s), shows it as a task on the screens (or the agent's own progress card, when it keeps one), and says the first few sentences of the answer where the person last was, or on a phone while away. A run that fails says so. Taking its task off the screens stops the run. Axis announces the answer even when the agent also spoke on its own during the run.
- **Turns while a conversation is busy.** OpenClaw answers one message at a time per conversation (a second one waits behind a running one; tested 2026-10-10). While the conversation turns would go to (Axis's own, or an attached one) has a run going, whether Axis handed it over or it came from elsewhere (the gateway's `hasActiveRun`), new turns go to `<sessionKey>-busy` instead, told on the device line what holds the usual one and to read, not message, that conversation if asked how it is going.
- The activity log marks turns that were handed over.

## 0.25.1 (2026-10-10)

- **Said on several devices, made once.** Something said everywhere or in one location is synthesized once per voice and the same audio is played on each device (`SpeechShare` in `speech.ts`), so devices in one room start together instead of one after another, and the speech service is not asked for the same sentence again for each device. Stopping one device does not cut the others off.
- **Voiceprints from the admin page wait longer.** A recording to teach or check a voice may wait up to 20 s for the service (a busy host once took over 5 s, and Axis gave up); a spoken turn still waits at most 3 s, so a slow service never holds up an answer.
- **Speech services:** a caller that hangs up before the answer is ready is one log line, not a traceback.

## 0.25.0 (2026-10-10)

- **Local speech in the stack.** `compose.yaml` now runs speech recognition (Parakeet), synthesis (Supertonic 3) and voiceprints (WeSpeaker) as three CPU containers from one new image, `speech/`, each behind OpenAI's audio API although none of the models has one. Each fetches its model on first start into `AXIS_MODELS_PATH`. Point `AXIS_STT_URL` and `AXIS_TTS_URL` (or the Speech page) at `vortex-axis-stt` and `vortex-axis-tts`, or anywhere else as before.
- **Voice recognition.** Off until switched on in the Speech page's new section. Taught voices are told from guests by voiceprint (known, guest or unsure, with two cut-offs); the agent sees whose voice it was on the device line; a guest's turn can be only labelled, sent to a guest conversation of the same agent or another agent, or turned away. Voices are taught by recording on the admin page or from turns heard in the last ten minutes. Only voiceprints are kept. The Live page and the recent turns show whose voice each turn was.
- **Wording:** the Speech page calls the recognition and voice "Custom STT/TTS".

## 0.24.0 (2026-10-10)

- **Attach the devices to another conversation.** A tenth tool, `vortex_axis_session`: "attach to internship hunt" points every device at that conversation of the agent's, so what is said next, on whichever device hears it, goes there; "detach" goes back to the usual voice conversation. It is one pointer for the whole hub, not one per device, because the devices are one way into one agent and any of them may pick up the wake word. It lets go by itself after half an hour with nothing said. The Live page shows it under Now, with a Detach button. The realtime voice follows it. An OpenClaw gateway must allow the new command `vortex.axis.session` beside the others.
- **A check of what Axis relies on in OpenClaw.** Each time the gateway link comes up, and on request, Axis asks the gateway what it offers (its methods and events), looks at the scopes it holds, and tries what can be tried without changing anything, for each of: turns, progress cards, questions, approvals, tool icons, realtime voice. The OpenClaw page lists how each stands; one that has stopped working is in the Overview's list of what needs attention and in the events, once when it breaks and once when it is back. Only what is switched on can be a problem.

## 0.23.1 (2026-10-10)

- A realtime voice is played at 70 % of how it arrives: it comes in louder than the local voice, and a board's small speaker buzzed with it. The setting `realtimeVolume` (10 to 100 %) changes that, for all devices or one.

## 0.23.0 (2026-10-10)

- **Realtime voice is a proper option now**, no longer a prototype. The Speech page has a **Realtime voice** section: one switch for what every device uses (Axis's own recognition and voice, or the realtime voice), the choice among the realtime voices the gateway offers, and **Try it**, which opens a session with the voice and closes it again to say whether it really works. A device can still be set differently on its own page.
- It is offered only while the agent is an OpenClaw gateway that Axis is connected to. Otherwise the section says so, and a device set to realtime is answered the usual way instead of failing.
- **The agent is asked to talk, not to write.** The note Axis adds for an OpenClaw agent, and the prompt it sends a plain chat endpoint, now ask for speech as a person speaks it: the answer first in a sentence or two, contractions, a small spoken touch where it fits, more offered instead of said, no opening praise or filler. The earlier wording ("short, plain sentences") was reaching the agent and got exactly that.

## 0.22.2 (2026-10-10)

- **Speech no longer races after a pause in it.** Axis sends a device no more sound than its buffer holds, by reckoning how much it has played. A gap in the sound was reckoned as room in the buffer, so whatever came after the gap went out all at once: more than a board could hold, and it dropped pieces, which sounded like the speech being wound forward. Now a device that has played everything simply has nothing in hand. This is in the part every voice goes through, though only a voice that arrives in fits and starts, like the realtime one, showed it.
- The 0.6 s head start of 0.22.1 is gone: the realtime voice is sent on as it comes.

## 0.22.1 (2026-10-10)

Still the realtime voice prototype of 0.22.0.

- **One turn in the chat, not two.** Work the voice model hands to the agent is now run by the gateway itself (`talk.client.toolCall`), which keeps it out of the conversation's visible turns. Before, Axis asked the agent with a message of its own, so the session showed what was said twice: once as the voice's transcript and once with Axis's bracketed line.
- **A head start of sound.** The model's voice arrives about as fast as it is spoken, and a board that started playing the first piece at once ran dry between pieces, heard as a buzz. Axis now has 0.6 s in hand before it sends a device any. Not yet confirmed on a board.

## 0.22.0 (2026-10-10)

Built as a prototype to try; kept, and made a proper option in 0.23.0.

- **Realtime voice as a second way to answer a spoken turn.** A device set to `voiceMode: realtime` has what it hears sent through the OpenClaw gateway's Talk relay to a realtime voice model, which answers in its own voice. Small things it answers itself; real work it hands to the agent, which Axis asks as it always does (same conversation, tool icons on the face) and whose answer the model then says. Off unless a device is set to it; `voiceProvider` picks the gateway's provider (`google`, or `openai/gpt-realtime-2.1-mini` for a model of one).
- Server only: no firmware and no protocol change. It is half-duplex: the device still decides when the person has stopped, and an interrupt stops the playback. Talking over the answer is not part of it.
- The sound leaves the house and the model is paid for by its provider's rates. Speech recognition and the voice of the `local` way stay where they are.
- Tried on the real gateway 2026-10-10 with a recorded question through a test client: with Google's provider, "what is two plus two" had its first words 2.5 s after the question ended (5.1 s the local way), and "are the lights on in my room" went to the agent, used Home Assistant and was answered by voice in about 10 s. OpenAI and xAI refused for want of credentials on that gateway. Not yet heard on a real device by anybody.

## 0.21.0 (2026-10-10)

- **The face shows when the agent's run is held up.** Two new looks while thinking: `compacting`, when the agent stops to tidy its memory (wound in tight, slow, deep blue), and `retrying`, when its provider failed and it is trying again (amber, turning backwards). A long silence for either reason no longer looks like a hang. When the run is under way again the face goes back to plain thinking, or to the icon of the tool in hand.
- With an OpenClaw gateway this comes from the run's own events (the `compaction` and `run_status` streams); nothing else reports it. It rides on `doing` of the `turn` message, which also gains `none` for "neither any more" (additive to protocol 1).
- The Face page shows both among the state looks. Board firmware 0.12.4 draws them.

## 0.20.1 (2026-10-10)

- Two more shared settings for tool icons, with sliders on the Face page: `toolIconMs`, how long the face takes to turn into an icon and back (150 to 3000 ms, 700 as before), and `toolIconDots`, how many of the 78 dots draw a dot shape (12 to 78). The dots left over stand off in a ring round the shape and go on turning. "Play it again" on the Face page takes the icons down and puts them up, to watch the change.
- Board firmware 0.12.3 follows both.

## 0.20.0 (2026-10-10)

- **Tool icons made of the face's own dots.** A third way to show what the agent has picked up: all 78 dots leave their arms and settle along the icon's strokes, in a colour of its kind, with a wave of light running along them, then swirl back into the vortex. No drawn lines; the same twelve shapes, each sampled into 78 points.
- **Three styles, chosen on the Face page:** dot shapes (the default now), the line icon at the core from 0.19, or off. It is the shared setting `toolIcons` (`dots`, `line`, `off`), so it can also be set per type or device like any other. The Face page draws all twelve kinds live in the style chosen, and any one large.
- Board firmware 0.12.2 draws the dot shapes and follows the setting.

## 0.19.1 (2026-10-10)

- Board firmware 0.12.1: the icon stands upright whichever way the screen is turned. The face is sent to the panel unturned, being round, and the icon went with it: on a board standing at 90 degrees it lay on its side.

- An agent's own housekeeping (looking up its tools, keeping its plan, loading a skill) no longer shows as an icon. On the first real turn the harness's tool lookup showed as a search.

## 0.19.0 (2026-10-10)

- **The face shows what the agent is doing.** While it thinks, an icon appears in the middle of the vortex for the kind of work the agent has just picked up: search, web, home, calendar, list, files, code, timer, message, memory, image, or a small cog for anything else. The arms stand back from the centre to make room and the icon takes the core's place and colour. Twelve icons, each a few strokes, defined once in `web/icons.js`; `scripts/gen-icons.mjs` writes the board's copy.
- With an OpenClaw gateway this needs nothing from the agent: Axis's operator link now declares `tool-events`, the gateway says which tools a turn picks up, and `server/src/doing.ts` reads the kind from the tool's name. Another agent backend shows the plain thinking face unless its reply stream names its tools.
- `turn` gains an optional `doing` with `thinking` (additive to protocol 1). The web client draws it; board firmware 0.12.0 draws it.

## 0.18.1 (2026-10-10)

- The scopes for questions and approvals are asked for when Axis is paired again with a setup code, and granted when that pairing is approved. 0.18.0 asked for them on a third link beside the two it has; the real gateway refuses that (a token for fewer scopes is refused when more are asked with it, and so is a connection with no credential), so the third link is gone. With either switch on and the scope missing, the Agent tools page says to pair again. If the gateway refuses the wider set after all, the operator link goes back to the scopes it had.

## 0.18.0 (2026-10-10)

- **An OpenClaw agent's questions reach you on a device.** When an agent on the linked gateway asks the person something (`question.requested`), Axis puts it to them the way its own ask tool does: spoken and shown on the device last used, with the choices to tap or say, and the answer goes back to the gateway (`question.resolve`). While Home Assistant's Away switch is on it goes to a phone as a notification. It can still be answered wherever else the gateway shows it; the first answer counts and Axis takes its own question back. Secrets and picks of several are never asked for on a device. A switch on the Agent tools page, on by default (`AXIS_MIRROR_QUESTIONS=0` to start with it off).
- **Approvals on a device.** When an agent waits for leave to run a command or use a tool (`exec.approval.requested`, `plugin.approval.requested`), a device with a screen shows what it is, silently, with Allow once and Deny. Only a tap allows; something heard can only refuse; a standing permission is never given from a device. A switch on the Agent tools page, off by default (`AXIS_MIRROR_APPROVALS=1` to start with it on).
- **The task line says what is being waited on.** A mirrored task whose session has a question or an approval open reads "needs you" with the question, or "approve: <command>", while the agent's turn is still running.
- Both need a scope the gateway has not given Axis before (`operator.questions`, `operator.approvals`). See 0.18.1 for how they are granted.
- `ask` inside Axis can be shown without being spoken and can be taken back.

## 0.17.0 (2026-10-10)

- **OpenClaw progress cards show by themselves.** An agent on the linked OpenClaw gateway keeps a list of steps for long work (its progress card). Axis now hears the gateway say a card changed (`progressCard.changed`), reads it (`progressCard.get`) and shows it as a task, with no tool call from the agent. The task is named after where the person talks to the agent (the channel or the session's label). It is done when every step is; with steps left and the agent's turn over it reads "needs you"; it goes back to running when the agent is at work again. Scheduled jobs are left out. A switch on the Agent tools page turns it off (`AXIS_MIRROR_CARDS=0` to start with it off). The progress tool is unchanged and is still how anything else reports: another harness, a script, a scheduled job.
- **Several tasks at once.** One that waits for the person always has the line; otherwise the one reported on last. The line counts the rest ("+2"), and the list a press or a tap opens names them above the steps. `progress.show` gains `others` (a line per other task, led by `!` when it waits for the person; additive to protocol 1).
- Tasks that finish within 30 seconds of each other chime once between them.
- A task whose reporter is known to be at work is not taken for abandoned after half an hour without a new word.
- Board firmware 0.11.9 shows the count and the other tasks.

## 0.16.1 (2026-10-10)

- Board firmware 0.11.8: a tap anywhere under the face lists a task's steps, not only a tap on its line, which was too small to hit. A tap on the face still starts listening.

- `vortex_axis_progress` reads `steps` that arrive as the text of a list. An agent whose harness had listed the tools before 0.16.0 sent them that way and was refused.

## 0.16.0 (2026-10-10)

- **Steps by name.** `vortex_axis_progress` takes `steps`: up to twelve short names, plain or each with how it stands (pending, in_progress, completed, as an agent's own plan has them). Axis remembers them, so later reports only say how far along.
- **A bar, and the steps on a press.** Screens draw a thin bar under the task's line. A press on the line in the web client, or a tap under the face on a board (on the line itself before firmware 0.11.8), lists the steps with the one in hand marked; on a board the list goes away after 20 seconds or on a tap. A tap anywhere else on a board still starts listening. With steps counted in the line, a board shows the words on what is happening under it.
- **A finish you can hear.** A task that finishes is marked with two soft notes, once, on each screen: the board's "Task chime" setting (on by default) and the web client unless it is muted. Never in quiet hours.
- **Your phone when you are away.** The hub has a new Home Assistant switch, **Away**. While an automation there keeps it on, a task that finishes or starts waiting for you is also sent as a notification to browsers that allowed them and are closed. Off, nothing goes to a phone.
- **Finished tasks are kept.** The Live page lists tasks that are over: how each ended (done, cleared, or no word for half an hour), how far it got and how long it took. They are kept as long as the rest of the activity (7 days unless changed), then dropped. A task under way is still in memory only.
- `progress.show` gains `steps` (one line per step, led by `x` done, `>` in hand, `-` to come) and `chime` (additive to protocol 1). Board firmware 0.11.7.

## 0.15.0 (2026-10-10)

- A ninth tool, `vortex_axis_progress`: an agent doing long work reports a title, what is happening, steps done of steps in all, and whether it is running, waiting for the person or done. Screens show it as one silent line ("Backup 3/5"); the admin page lists it under Now on the Live page, where it can be taken off. Kept in memory only; a finished task leaves after 90 seconds and one nobody reports on after 30 minutes.
- Clients with a screen are sent the `command` `progress.show` (additive to protocol 1; a client that shows nothing answers `ok: false`). The web client shows it; board firmware 0.11.6 shows it, taking turns with a timer.
- An OpenClaw gateway must allow the new command `vortex.axis.progress` beside the others.

## 0.14.2 (2026-10-10)

- A spoken turn records what made the device listen: the wake word, a tap, a press held down, listening on after an answer, or a question. The Overview's recent turns and the Live view show it ("spoken, tap"). Until now every such turn read just "spoken".
- Protocol 1 gains an optional `trigger` on `audio.start` (additive: an older device says nothing, and Axis then knows only whether there was a wake word). The web client sends it; board firmware 0.11.5 sends it.

## 0.14.1 (2026-10-09)

- The admin page says "protocol 1", not "device protocol 1".
- The README says what Axis is for: OpenClaw first, and any other agent harness through MCP and a chat address.
- Nothing in the repository names one installation any more: real host names, addresses, the public name and device names moved to `CLAUDE.local.md`, which is not committed, and the examples use made-up addresses.

## 0.14.0 (2026-10-09)

The first numbered release. The number and the commit of the build are shown at the foot of the admin page's sidebar, and the web client reports the number as its own.

- **Tools for any agent.** Axis is an MCP server (`POST /mcp`) offering the same eight tools as the OpenClaw node, from one list and one function. Agent tokens and a switch per tool are on the admin page under Agent tools.
- **Backup built in.** Axis copies its database, firmware and wake words to a mounted folder on a schedule, with settings, a Back up now button and warnings on the admin page. The host cron job and its script are gone.
- **Admin page.** Live view (each turn step by step, wake words, timers, questions, kept messages, Clear now); Activity folded into Overview; Integrations with editable hub settings; a Say something box; wake word scores per device; remembered sign-in; a phone layout with a menu drawer; switches drawn properly.
- **Web client.** History that marks announcements, notifications and questions (answered or not) and keeps them in the browser; volume and mute, notifications and history as small marks in the corner; forgetting a pairing takes two presses; the timer is a small chip; sound recovers on an iPhone; holding the face to talk survives a drifting finger.
- **Server.** Words held in memory for the admin page are deleted after ten minutes; a client that says it is not playing sound is no longer waited for; the chat endpoint's default system prompt knows about the tools.

## Earlier on 2026-10-09 (before numbering)

- Web client as an installable app with notifications (Web Push), questions answered from a notification, hold-to-talk, screen kept awake, a timer countdown with cancel.
- Messages kept for clients that are away; say on every device; quiet hours; every client as a Home Assistant device through MQTT.
- Web files loaded by stamped addresses, and a page that reloads itself when Axis has a newer one.
- Admin page in the web client's theme, a Face page, a sketch of each device, test buttons for a chat endpoint and a notification.
- A wake word ignored while another device speaks in the same location. Firmware 0.11.0 to 0.11.4: echo cancelling, more idle looks, encrypted connections taking memory from PSRAM.

## 2026-10-08

- Admin page redesign: sections, a page per device and per client type, fleet-first settings; activity log, uptime and charts.
- Agent commands ask, timer and admin; firmware updates over Wi-Fi; TLS for devices; protections for a public address; wake word models served by Axis; moving a device to another address; resetting a device.
- A system prompt for chat endpoints and a note for OpenClaw agents; "room" became "location".
- Speech synthesized a sentence ahead, one at a time; a crash on streamed replies fixed.
- Firmware for the Waveshare ESP32-S3 AMOLED board from first boot to 0.10.3: setup network, pairing, the vortex face, speaker, microphone, the on-device wake word, follow-up listening.

## 2026-10-07

- The client protocol (version 1 draft); the server: pairing, tokens, settings sync, the admin API, a Docker image.
- Voice and text turns: wake arbitration, recognition, the agent, sentence-by-sentence speech.
- The OpenClaw gateway link: device identity, the operator and node roles, pairing by setup code; commands named `vortex.axis.*`.
- The first admin page and web client; a headless browser check.
