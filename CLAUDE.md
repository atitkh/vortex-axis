# CLAUDE.md

Guidance for coding agents working in this repository.

## Project

VorteX Axis is a hub between thin client devices and an AI agent: made for OpenClaw first, and usable with any other agent harness through MCP and an OpenAI-style chat address. Clients hold one WebSocket to Axis. Axis holds the connections to the OpenClaw gateway (as one node), STT and TTS, and owns the client registry, settings and routing.

Read [docs/design.md](docs/design.md) before changing behavior. It records what was agreed and marks what is still proposed or open.

## Status

Last updated: 2026-10-13 02:10, at Axis 0.40.0, board firmware 0.18.0 and desktop app 0.7.1 (NOTE: scripts/build-desktop.sh puts the build in the data folder, which auto-updates every paired computer within 5 minutes: only run it for a build meant to ship, with a new version number. 0.7.0: the PC as a voice device, Ctrl+Alt+Space, pill, `Voice` in Core + `IVoiceIo`, NAudio on Windows, capabilities desktop+mic+speaker+screen; boards glow rose (`desktop.busy`, handsGlow) while an agent uses a computer, `Desktops.inUse` on the Now table; voice smoke-tested against a throwaway Axis, not on Windows. 0.6.0: auto-update from Axis (`server/src/desktopapp.ts`, `AppUpdate`, setting autoUpdate), scroll, wait for name/window, clipboard read, paste via data; platform calls on IDesktop so a Mac app can reuse Core; Windows parts NOT run by me. firmware 0.17.3: a picture stays through transcribing/thinking with the thinking glow; 0BF8 updated over Wi-Fi, C484 was offline. 0.5.0: desktop `screenshot` (window/element crop/screen, 640/1024/1568 px JPEG), off per computer unless `allowScreenshot`, MCP door turns a result's `image` into an image block; Windows capture NOT run by me. 0.4.5: looks unanswered since 0.4.0 were a JSON bug: strings added via JsonArray.Add<T> need a type resolver and AxisLink's hand-made options had none; fixed by (JsonNode?) casts AND a DefaultJsonTypeInfoResolver on those options; do NOT switch reflection-based JSON off, Saved.cs relies on it. 0.4.3 instrumentation: late answers logged by Axis, send failures and slow answers in the app's list, look stage timings, pool floor 32; 0.4.2: the OCR step of a look (pointer hide, capture, Windows OCR) under one 4 s deadline, look/find always answer within 12 s; looks needing OCR never answered in 0.4.0/0.4.1, cause inside that step unknown; Axis takes a non-computer `client` as a place. 0.4.1: every UI Automation call on its own thread with a deadline, `Uia.Run`, never the thread pool: 0.4.0 starved itself on a frozen window and looks went unanswered; open waits for its window and fronts it; type/keys go to the window last opened/switched/clicked and bring it back or refuse; pointer shown on open/switch/type/keys; built, NOT run on Windows by me. 0.37.0: `after` on desktop actions, one-line elements, shorter desktop tool; checked with a fake desktop, not on Windows. 0.36.0: desktop by-name targeting, find, steps, open/switch/window/desktop presets; protocol `command.data`; smoke-tested, the Windows parts (Start-menu launch, window focus and moves, virtual desktops) NOT run by me; desktop click/type/keys with per-computer `allowInput` and the app's own limits, NOT yet tried on Windows by me; owner's first live use: looks and points worked on his PC; fixed after it: displays above the main one (negative coordinates, `monitors`), elements ranked before the 250 cap, one bad element no longer fails a look; EXPERIMENTAL computers: `clients/windows-desktop/` WPF app pairs as capability `desktop`; `server/src/desktop.ts` + MCP-only tool `vortex_axis_desktop` look/point/hide, experimental tools off until switched on; Core proven against a real Axis by `Axis.Desktop.Smoke` on Linux; the Windows app itself only BUILT, never run by me (no Windows here): the window, tray, pointer, UI Automation and OCR are untested; commands from Axis run on the other core: leave a request for the screen loop, never stamp times or touch drawing state from the handler; the glow preview's Show on the device sends `glow.show` to put one kind of glow on a board for a few seconds; Find this device: board action `find`, three chimes and a white edge pulse, a Find button on the admin Clients list and device page; boards pulse blue while a question waits for the person on another device or on none, `server/src/asklight.ts` sends `ask.waiting`; an edge glow preview with a live corner-curve slider on a device's admin page; NOT yet seen or heard on a board by anyone, the preview checked only in headless Chrome; agent tool calls on the Live page, `Live.recordTools`, by every door with who called; a red timer countdown glow in a timer's last 10 s on boards, setting `timerGlow`; NOT yet seen on a board by anyone; every agent tool can be tried from the admin page's Agent tools page, a form drawn from the tool's parameters, `POST /admin/mcp/tools/try`, through the same guard as agents; checked by tests and the browser check, NOT yet used by the owner; pictures in agent replies: web clients get an address, `images`; boards get a shrunk JPEG over the socket, `image-frames`, `server/src/media.ts` + `fit.ts`, first deps pngjs/jpeg-js; boards report room sound level/activity and hold/swipe gestures, shown in Home Assistant as Sound level, Sound and Gesture entities; firmware 0.13.1; tasks and timers as phone live activities through Home Assistant, `server/src/liveactivity.ts`: MQTT `vortex-axis/live` plus a blueprint Axis serves, off by default; a long agent run is handed over after 30 s with nothing new and followed in the background, `server/src/background.ts`, its answer said when it lands; turns go to `<sessionKey>-busy` while the usual conversation has a run, since OpenClaw queues a second message behind a run; NOT yet tried with a real long run on a board; something said on several devices is synthesized once and shared, `SpeechShare`; NOT yet heard on two real boards side by side) and board firmware 0.15.0 (local speech in the stack: `speech/` builds one image run as three CPU containers, recognition, synthesis and voiceprints, behind OpenAI's audio API; voice recognition, `server/src/voiceprint.ts`, off unless switched on, labels each spoken turn's voice and can send a guest elsewhere, NOT yet taught or tried with a real person's voice; a tenth tool `vortex_axis_session` points every device at another of the agent's conversations, `server/src/attach.ts`, NOT yet tried on a real gateway; a self-check of what Axis relies on in OpenClaw, `server/src/selfcheck.ts`, on the admin OpenClaw page; realtime voice kept since 0.23; held-up looks since 0.21; tool icons since 0.19/0.20; questions/approvals since 0.18; progress cards since 0.17). Update this line whenever you change this section.

**Running now:** see `CLAUDE.local.md`. That file is NOT in the repository (it is in `.gitignore`): it holds what is particular to one installation, such as host names, addresses, the public name, device names and which agent answers. If you are working on the installation this checkout belongs to, read it and keep it current; never write such details in this file or anywhere else that is committed. In general terms: Axis runs in Docker on port 8440 with its data folder on a local disk, backs itself up hourly to a mounted folder, is reached from outside under a public name through a tunnel with `/admin` kept to the local network, and serves two Waveshare boards and a few browser clients through an OpenClaw gateway.

**Added 2026-10-08 and 09, all deployed** (details in docs/design.md from "Location, not room" to the end):
- Devices: admin reset; echo canceller (only with `bargeIn`, which is off by default); encrypted connections take memory from PSRAM (free internal memory 32 KB to 83 KB); `idleLooksOff`; seven more idle looks with `wave` and `tilt`; readings `screenW`/`screenH` (`Client::setReading`).
- Server: `delivery.ts` (say to a client that is away: Web Push to a closed browser, else kept 10 minutes; `everywhere`; `urgent`; questions by notification), `push.ts`, `quiet.ts` (quiet hours), `homeassistant.ts` + `mqtt.ts` (MQTT discovery), a wake word ignored while another device speaks in the same location, speech status needs two misses, a system prompt for chat endpoints and a note (`extraSystemPrompt`) for OpenClaw agents, "room" renamed to "location".
- Web client: installable app, notifications, hold-to-talk beside tap, wake lock, timer countdown with cancel, badge, self-reload when the page is stale.
- Admin page: the web client's black theme, full width, Face page (every look, on/off per idle look), device sketch (shape, state, words, question, timer), test buttons for a chat endpoint and for a notification.
- Web files are served with stamped addresses (`?v=<hash>`, `stampWebFiles` in `http.ts`): Cloudflare kept scripts for four hours regardless of `no-cache`.

**Added 2026-10-09 afternoon, deployed** (docs/design.md, "Watching it work"): admin page `#live` (each turn stage by stage with its words and timings, and wake words as they are heard, over the `GET /admin/live` stream; words are memory only), `#integrations` (Home Assistant link, notifications, backup, public address, gateway), a "Say something" box on the Overview (`POST /admin/announce`: every device, a location or one device), "Remember on this device" on sign-in, and wake scores per device on the Wake words page (`wakes` table, `GET /admin/wakes`). (The backup script mentioned then has since been replaced by `server/src/backup.ts`.) Checked with tests and the browser check (stub speech). Not yet seen with a real voice turn or a real wake word by anyone, and not looked at at phone width.

**Changed 2026-10-09 14:10, deployed:** there is no `#activity` page any more: its charts, turns and events are on `#overview` (an old `#activity` link lands there). The Now table is on `#live`, which also has **Clear now** (`POST /admin/live/clear`). Words held in memory (live turns, device sketches, kept messages) are deleted when their time is up by a one-minute clock in `app.ts`, not just hidden. Hub settings (Home Assistant broker, public names, trusted proxies, time zone, history days, message hold) are editable on `#integrations` and saved in `meta` (`server/src/hubconfig.ts`); **a value saved there wins over `.env`**, so check the page before concluding an `.env` change did nothing. Checked with tests and the browser check only.

**Changed 2026-10-09 15:05, deployed:** the admin page has a phone layout below 720 px (menu drawer, larger fields and buttons, tables scroll in place); the browser check opens all 14 pages at 390 px and fails on anything wider than the screen. The Live page's Now table also lists unopened notifications (`notified` on a client). Checked by measurement in headless Chrome only: nobody has looked at it on a real phone, and no screenshot was taken.

**Web client, 2026-10-09 15:45, deployed** (docs/design.md, "The web client's history, sound and timer"): the history drawer marks announcements, notifications and questions (answered with what, or not answered), has an All / Conversation / Notifications filter and a Clear button, and keeps the unasked half in the browser's storage (last twenty); a volume slider (`POST /v1/volume`) and a Mute button behind one speaker mark in the top corner, notifications behind a bell beside it, and Forget this pairing behind the "Paired as …" name in the footer, two presses (the owner found controls in the footer intrusive: keep the page minimal, tuck controls away); the timer is a small chip. A client that reports `playback: blocked` no longer holds its turn open for five seconds. Checked with tests and the browser check; not tried on a real phone or with a real notification, and keeping across a reload was not exercised by the check.

**iPhone sound, 2026-10-09 16:40, deployed, UNCONFIRMED:** the owner reported that in the Home Screen app the "Sound is off" notice stays and sound only sometimes comes back on a tap. `player.ensure(pressed)` in `web/client.js` now wakes from any non-running state, rebuilds a stuck engine on the next press, and listens for touch-end events (see design.md, "Sound on an iPhone"). Desktop browser check passes; whether it cures the iPhone is for the owner to say.

**MCP, 2026-10-09 20:05, deployed** (docs/design.md, "Tools for any agent"): Axis is also an MCP server at `POST /mcp` (same process, same port), offering the same tools as the OpenClaw node from the same list and the same function. Agent tokens and a tool on/off list (applies to both doors) are on the admin page's `#tools`. To add a tool: one entry in `NODE_TOOLS` and one case in `createInvokeHandler`, nothing else in this repository. Not yet used by a real agent harness by anyone.

**Not verified by anyone:** the wake-while-another-speaks rule on real boards; a person interrupting with echo cancelling on; the admin page at phone width. **Verified by the owner:** notifications on iPhone and Brave, a question answered from an iPhone notification, two boards arbitrating a wake word, fresh setup and Wi-Fi reset of a board.

**Known and open:** `i2cWrite ... ESP_ERR_INVALID_STATE` floods on a board after a serial-triggered reset (unexplained); agents reach Axis through the general `nodes` tool (the nine `vortex_axis_*` tools are published but not in the agents' tool policy).

Built and running:

- `protocol/`: version 1 draft, including the `describe` message a device uses to declare its settings, actions and links.
- `server/`: client pairing, tokens, three-layer settings sync, the admin API, wake arbitration, voice and text turns, and the OpenClaw gateway link (an operator link that sends turns to a named agent, and a node link that declares the command list, publishes tools and carries out `vortex.axis.say`, `vortex.axis.clients`, `vortex.axis.config`, `vortex.axis.sense`, `vortex.axis.diag` and `system.notify`). An empty or `NO_REPLY` answer is held back: nothing is spoken or shown and no follow-up opens. Speech: sentences are synthesized one at a time, the next while the one before plays (one ahead at most), with a deliberate pause between sentences (`sentencePauseMs`, a built-in setting, 300 ms) that counts the engine's own trailing silence. The owner heard per-sentence synthesis and smooth playback live. Axis pings every client socket (`AXIS_PING_INTERVAL_MS`, 15 s) and drops one that misses a ping, so a board that loses power or Wi-Fi shows offline within about 30 s; before this it stayed online until the OS gave up on the socket. Not yet watched with the real board unplugged.
- `web/`: the web client and the admin page. The web client (`index.html`, `client.js`, `style.css`) looks like the board: black, the vortex face from `web/vortex.js` (a port of the firmware's `vortex.cpp`; keep the two in step), tap the face to talk, finish or stop, or hold it to talk for as long as it is held (release sends, `HOLD_MS` 350 ms; a short press is still a tap); the words under it, a history drawer, a big timer countdown with a cancel button (`/v1/timers/cancel`, needs the timer id from `timer.next`, which older Axis versions did not send); while the page is in front it holds a screen wake lock so the phone does not lock mid-conversation. Used by the owner in a desktop browser after `f935546` and working; not yet tried on a phone. The admin page (`admin.html`, `admin.js`, its own `admin.css`; the web client keeps `style.css`) has a sidebar and shows one section at a time, chosen by the address hash: `#overview` (the home page, which now includes what the Activity page had), `#live`, `#integrations`, `#tools`, `#clients`, `#clients/<id>`, `#type/<type>`, `#settings` (all devices), `#pair`, `#openclaw`, `#agent`, `#speech`. Settings are managed fleet first: each client type in use gets a settings page (what all its devices share, which devices differ, actions run on every online device), and a device's page shows each setting's value and where it comes from, with "Use shared" and "Share with type". A value equal to what the layers below give is removed instead of stored, so it keeps following. Name and room are edited at the top of a device's page (`PATCH /admin/clients/:id` renames). Adding a device notices when the new code is used. The Overview lists what needs attention (services down, devices offline, failed turns, crashes) with Axis uptime, devices online, turns and time to first sound, and 24 h uptime strips. Activity has charts of time to first sound and turns, where the wait goes, uptime strips, recent turns (timings only) and a filterable event list; a device's page has its own 24 h history. Charts are hand-drawn SVG in `web/charts.js`. Running on the live hub; the owner has used the Activity page.
- `firmware/`: a working client for the Waveshare ESP32-S3-Touch-AMOLED-1.8, flashed and used by a person: setup network, pairing, socket, face, speaker, microphone with tap-to-talk, on-device "Hey Vortex" wake word, follow-up listening, listen cue, a log page at `/logs` on the device. See `firmware/README.md`.

Proven with a real gateway, a real board and a real voice: pairing, typed and spoken turns, `vortex.axis.say`, tap-to-talk, wake word, follow-up.

Known not working, accepted for now: saying the wake word over the device's own speech (barge-in). The board has no echo canceller. Tap interrupts instead. Do not build an echo canceller without being asked.

Built 2026-10-08 and covered by `server/test/commands.test.ts`, but NOT yet tried by the owner on a real device or through a real agent: `vortex.axis.ask` (question with choices to tap or say, or an open question), `vortex.axis.timer` (timers kept on Axis, announced when due, counted down on a screen) and `vortex.axis.admin` (list and run device actions, rename, pairing code). Design section 6 says how each behaves. The owner has since tried them on the board (2026-10-08): tapping a choice works, and the timer tests passed. A fix after that, deployed but not yet retried by the owner: an agent asking mid-turn on the device it is talking to was refused as busy (see `thinking` in `turns.ts`). `firmware/README.md` tests 17 to 22 are the list for a person.

Built 2026-10-08, milestone 5: firmware updates over Wi-Fi (design 7.1; done three times on the real board) and TLS from devices (`axis+tls://`, design 7.2; the board trusts public certificates and refuses a self-signed one, but it has NOT been used against a real Axis address, because none with a public certificate exists yet).

Built 2026-10-08 after milestone 5: protections for a public address (design 9.0: `AXIS_PUBLIC_HOSTS` hides the admin side, attempt limits, trusted proxies; tested, not yet used with a real domain), display names for client types, and on the board (0.9.0) FreeSans text and turning the picture with the device. The last two are NOT yet seen by the owner, and two of the four auto-rotate directions are a guess (`firmware/README.md` test 24).

`docs/client-guide.md` is the contract for a new client type: what each capability obliges a client to do, the shared setting keys, the commands every client answers, and a checklist. Read it before writing firmware for a new board, and change it in the same commit as any change to what clients must do.

Not built yet: staged rollout of updates, signed firmware, a wake word in the web client, firmware built in CI on a tag. Wake words from Axis ARE built (design 7.3, `server/src/wakewords.ts`, the Wake words page, the `wake.model` command). The owner asked about these on 2026-10-08; they were discussed, not started.

Deployed: Axis runs with `AXIS_PUBLIC_HOSTS` set to its public name and `AXIS_TRUSTED_PROXIES` to the tunnel's address as the container sees it; the public name is live through a tunnel (the exact values are in `CLAUDE.local.md`). Checked through the real name: `/admin` and the admin API are 404, the client side and the socket work. The board is on firmware 0.10.2 and reaches Axis at the public name (moved with the `address` command, pairing kept); it is set to the stored copy of "Hey Vortex"; `screenOffset` is 0 for its type. KNOWN PROBLEM, cause not found: on the encrypted link the board once restarted by itself about a minute after the move, and one update over the encrypted link left it unreachable for two and a half minutes before it came back on the old firmware; the same update worked on a second try from a fresh start. An encrypted connection leaves about 47 KB of free memory (low mark 34 KB), so memory is the suspect. `diag` and the `lastStart` reading now say why a device last started ("panic", "watchdog", "software", ...): check it first.

Loose ends, not yet done:

- The owner saw the "Agent" time (Axis asking OpenClaw to its first words) grow. Nothing in Axis touches that stretch; not investigated on the OpenClaw side.
- Not watched yet: a board unplugged going offline within about 30 s; a long spoken answer after the fetch crash fix (`drain()`).
- `browser-check` needs `google-chrome`, or `CHROME=<path>`; on the owner's Mac it was run with Brave.

Next: find out why the board hung during an update over the encrypted link (watch `lastStart`; log free memory in `runUpdate`; consider closing more before the download). Then a wake word in the web client.

What a real gateway taught is in section 13 of the design doc, and `server/test/fake-gateway.ts` behaves the same way.

## Working alongside other agents

More than one agent works on this repository, in separate sessions that share no memory. This file and the git history are the handoff.

- Before starting, read this file, then `git log` since the commit named in Status, and `git status` for work left uncommitted.
- When you finish a change that alters behavior, layout, commands or what is built, update this file in the same commit: the Status section, the maps, and the dated line.
- Write commit messages that say what changed and what version the firmware is now at. The next agent reads them instead of the diff.
- Say in Status what you did not verify (not heard, not seen on the panel, not run against the real gateway). Do not record something as working because it compiled or a test passed.
- Leave the tree clean. If you must stop mid-change, commit to a branch or note the loose files under Status.
- Do not undo a rule under "Rules that are settled" or a decision in `docs/design.md` on your own. Those came from the owner; ask.
- A deployed server and a flashed board are shared state. If you redeploy or flash, say so in the commit message or Status so the next agent knows what is actually running.

## Rules that are settled

- Axis is a bridge. Do not add agent logic, conversation history or decision making beyond routing.
- Axis is ONE OpenClaw node. The target client or location is a command parameter (`room` is the old word for it and is still accepted from agents). Do not open one node connection per client.
- Clients are types with capabilities (`mic`, `speaker`, `screen`, `buttons`, `vibration`, `sensors`). Route on capabilities, never on a hard-coded device name.
- The wake word and silence detection run on the client. Axis never receives audio before a wake event.
- Axis is the source of truth for settings: global, then client type, then device.
- The web client is a normal client. It pairs and uses the same socket as firmware, with no private shortcuts.
- Pages put untrusted text (client names, replies) into the page as text, never as markup.
- Name things `vortex-axis`, never plain `axis`, in hostnames, containers and Home Assistant entities. Plain `axis` collides with Axis Communications cameras and Home Assistant's `axis` integration.
- Gateway commands are named `vortex.axis.*` and the tools agents see `vortex_axis_*`. A bare `axis.` prefix could collide with someone else's plugin.
- No host-specific values in code. Addresses come from environment variables.
- Version 1 scope is in the README. Do not build the "later" items without being asked.

## Stack

- Server and web: TypeScript on Node.
- Storage: SQLite, one file in one data folder bind-mounted from the host. It uses a rollback journal (not WAL) so the folder can live on network storage.
- Client transport: one WebSocket per client, JSON for control and binary frames for audio.
- Firmware: PlatformIO, one shared core in `firmware/common/` and one folder per device type.

- Tooling: npm workspaces, TypeScript 5.9, TypeBox for message schemas, Vitest for tests.
- Server: Node's built-in `node:http` and `node:sqlite` (needs Node 24 or newer), plus `ws` for WebSockets. No web framework on the server; keep dependencies few.

- Web: plain HTML, CSS and browser JavaScript modules in `web/`, with no framework and no build step. The server reads the folder into memory at startup and serves only those files. Keep it that way unless asked.

## Layout

```
server/            Axis (TypeScript)
web/               web client and admin page
protocol/          versioned client-to-Axis message definitions
firmware/common/   shared client core
firmware/<type>/   board-specific code only
clients/           non-firmware clients
docs/              design and decisions, the face, and the guide for new client types
```

`protocol/` is the single definition of the client messages. Server, web and firmware follow it. Change the protocol there first, bump its version, and keep the server accepting the previous version. Regenerate and commit `protocol/schema/` in the same change. `protocol/README.md` explains the protocol in prose; keep it in step with `src/messages.ts`.

## OpenClaw gateway

The gateway protocol has traps that are not obvious from its docs. Section 13 of the design doc lists the ones already paid for. Check that list before writing or debugging the gateway client.

The command surface in section 6 is declared in full at first pairing. Adding a command later forces a human re-approval of the node, so do not add commands casually.

## Commands

Run from the repository root:

```bash
npm install
npm test          # all workspaces
npm run typecheck
npm run build
npm run schema --workspace protocol   # regenerate protocol/schema/*.json
npm run browser-check                 # both pages in headless Chrome, stub speech unless TTS and STT are set; CHROME=<path> for another Chromium browser
AXIS_ADMIN_TOKEN=... npm run latency-probe   # times real turns through a running Axis (uses the real agent)
AXIS_ADMIN_TOKEN=... npm run push-firmware -- <type> --update   # upload a firmware build and update devices over Wi-Fi
AXIS_ADMIN_TOKEN=dev npm start        # after a build; listens on 8440
npm run deploy                        # docker compose up -d --build with the commit passed in; needs .env, see .env.example
scripts/build-desktop.sh              # builds the Windows desktop app in the .NET SDK container into the data folder, for the admin page's download
```

`npm test` and `npm run typecheck` build `protocol/` first, because the server imports its compiled output.

## Server map

- `server/src/store.ts`: everything on disk (clients, pairing codes, settings). Tokens and codes are stored as hashes only.
- `server/src/hub.ts`: connected clients and the client protocol, including what each device described and commands sent to a device. Live state stays in memory.
- `server/src/http.ts`: pairing, health and the admin API.
- `server/src/turns.ts`: one turn from input to spoken reply, plus pacing of audio to the client.
- `server/src/wake.ts`: picks one client when several hear the wake word.
- `server/src/sentences.ts`: cuts a streaming reply into pieces to synthesize one at a time.
- `server/src/speech.ts`, `server/src/agent.ts`: upstream clients behind small interfaces. Every streamed `fetch` body is read through `drain()` (`server/src/drain.ts`): Node's fetch crashes the whole process, uncatchably, when a server closes while a body sits unread under backpressure (nodejs/undici#5360), and speech is read at real-time pace. Do not iterate `res.body` directly. Tests pass fakes through `startApp`'s third argument.
- `server/src/app.ts`: wires them together. Tests start a real server on a free port through `startApp`, using `server/test/harness.ts`.

- `server/src/gateway/wire.ts`: frames, the device identity and the signed connect text.
- `server/src/gateway/link.ts`: one gateway connection in one role, with its retry rules.
- `server/src/gateway/client.ts`: both links, credentials, agent turns, node commands.
- `server/src/commands.ts`: the node's command list, the tools agents see, and what each command does.
- `server/src/ask.ts`: matches what a person said or typed to one of a question's choices. The question's life (speak it, send `ask`, take the answer from a tap, a recording or typed text, time out) is in `turns.ts`, because a spoken answer arrives as an ordinary recording and must be kept from the agent.
- `server/src/firmware.ts`: the firmware builds kept per client type (the last five, one current) for updates over Wi-Fi. The routes are in `http.ts`; the admin page's Firmware section manages them.
- `server/src/wakewords.ts`: wake word models kept for devices, and the sync that tells each microphone client which one its `wakeWord` setting chooses.
- `server/src/timers.ts`: timers agents set. Kept in the `timers` table, announced with `hub.say` when due, retried while nobody can be reached, and told to screens with the `timer.next` command.

- `server/src/live.ts`: turns and wake words as they happen, for the admin page's Live view. Memory only; `turns.ts` reports each stage to it and `http.ts` streams it at `GET /admin/live`.
- `server/src/mcp.ts`: the MCP server: JSON-RPC over `POST /mcp`, answering `initialize`, `tools/list` and `tools/call` from `NODE_TOOLS` and the one invoke function. No SDK, no session.
- `server/src/tools.ts`: which tools are switched on (for every agent, by either door) and the agent tokens for MCP. `guard()` wraps the invoke function; `app.ts` gives the wrapped one to both the gateway link and MCP.
- `server/src/backup.ts`: copies the data folder to the backup folder on a schedule (database snapshot checked before it replaces the last, daily copies, firmware and wake words mirrored). Everything that touches the backup folder is asynchronous, because it is usually network storage. Off unless `AXIS_BACKUP_DIR` is set, which `compose.yaml` does when `AXIS_BACKUP_PATH` is.
- `server/src/hubconfig.ts`: the hub's own settings an admin can change while it runs (Home Assistant broker, public names, proxies, time zone, how long things are kept), saved over the environment's.
- `server/src/activity.ts`: the activity log: turn timings and outcomes (never words), events (connections, service states, Axis start and stop, settings and admin changes), uptime timelines and the summary `GET /admin/activity` returns. Stored in the `turns` and `events` tables, pruned after `AXIS_ACTIVITY_DAYS`.
- `server/src/upstream.ts`: the speech and agent settings an admin can change at runtime, and the speech test.
- `server/src/voiceprint.ts`: telling voices apart. The voiceprint service's client, the taught voices (`voices`, `voice_samples`: voiceprints only), the settings in `meta`, `identify` (known, guest or unsure; never throws), `routeFor` (where a guest's turn goes, as an `AgentRoute` for `Agent.reply`) and the device-line label. `turns.ts` calls it beside speech recognition.
- `speech/`: the local speech services' image (Python, sherpa-onnx): `stt.py`, `tts.py`, `voiceprint.py`, `common.py`. `compose.yaml` runs it three times. Models are fetched on first start into `/models`.
- `server/src/progress.ts`: tasks agents report on, in memory, told to every screen; `server/src/cards.ts` feeds it from the OpenClaw gateway's progress cards.
- `server/src/agentasks.ts`: questions and approvals OpenClaw agents wait on, put to the person through `hub.ask` and answered back to the gateway.
- `server/src/desktop.ts`: computers with the desktop app (experimental): which one a call means, and `desktop.look`/`point`/`hide` carried there. The app is `clients/windows-desktop/` (see its README).
- `server/src/asklight.ts`: tells each screen how many questions wait where it is not showing them (`ask.waiting`), from `hub.askingClients()` and `AgentAsks.unshown()`.
- `server/src/delivery.ts`: gets agent-started speech to a client by whatever route it has: live, a notification to a closed browser, or kept until it is back; one message to many clients; questions by notification. `commands.ts` and `homeassistant.ts` both go through it.
- `server/src/push.ts`: Web Push with Node's own crypto (the `aes128gcm` encryption and the VAPID signature). Subscriptions are in the `push_subscriptions` table, Axis's key pair in `meta`.
- `server/src/quiet.ts`: quiet hours by the clock. The hub caps volume and brightness in the settings it sends (`withQuiet`) and `delivery.ts` shows without speaking; no firmware knows about quiet hours.
- `server/src/homeassistant.ts`, `server/src/mqtt.ts`: clients as Home Assistant devices through MQTT discovery, over a small MQTT client of our own.
- `web/sw.js`: the web client's service worker. It only shows notifications and carries answers back; it caches nothing. Served at `/sw.js` so it can act for the whole client.

The agent is an OpenClaw gateway reached over its WebSocket, or any OpenAI-style chat endpoint when the admin picks that. The gateway client always exists, so its node link keeps working either way.

Speech and agent settings come from the environment first and from the `meta` table after an admin saves them; the saved value wins. `app.ts` keeps one `services` object for the life of the process and replaces its fields in place, which is how a change reaches the next turn.

The gateway's device tokens and the setup code are stored in the SQLite `meta` table as plain text, because Axis has to present them. Treat the data folder as secret.

## Firmware map

- `firmware/common/src/axis_client.*`: the shared client core: socket, pairing, settings sync, audio framing, `describe`, commands.
- `firmware/common/src/log_buffer.h`: the in-memory log served at `/logs`, also copied to USB serial.
- `firmware/common/src/vad.h`: energy-based speech detection.
- `firmware/wake/`: the wake word detector. `firmware/lib/` holds vendored TensorFlow Lite Micro and the audio front end; do not edit them.
- `docs/face.md`: the vortex face's specification: the 20 looks with their numbers, the drawing steps, how a voice level is measured, and which look shows when. A new board draws the face from it. `vortex.cpp` and `web/vortex.js` follow it; change all three in one commit.
- `firmware/waveshare-amoled-1.8/src/`: board code only: `main.cpp` (wiring, settings table, actions), `display`, `vortex` (the face), `speaker` (includes the 24 kHz to 16 kHz low-pass resampler), `mic`, `codec`, `touch`, `imu` (which way up the board is), `fonts/` (vendored, do not edit).

A setting or action a device offers is declared once, in the board's table in `main.cpp`. The server validates against that description and the admin page draws from it, so do not add per-board code to `web/` or the server.

Build in a board folder with `~/.platformio/penv/bin/pio run`. Ship it over Wi-Fi with `AXIS_ADMIN_TOKEN=... node scripts/push-firmware.mjs <type> --update` from the repository root (the token is in the untracked `.env`); use the cable (`pio run --target upload`) only for a first install or a board that will not start. Bump `AXIS_FIRMWARE_VERSION` with every flashed change. Flashing resets a device someone may be using, and anything that makes sound or changes the picture needs a person to confirm it; say so instead of calling it tested.

## Conventions

- Keep docs current: a decision that changes behavior goes into `docs/design.md` in the same change.
- No secrets, tokens or internal addresses in the repository, and nothing that names one installation: no real host names, domains, LAN addresses, device names, people's names or agent names, in code, tests, comments or docs. Use `axis.example.org`, `192.168.1.20` and the like. One installation's details go in `CLAUDE.local.md`, which is not committed.
- **Versions.** Axis (server, admin page and web client together) has ONE version, written once in the top-level `package.json`; `server/src/version.ts` reads it and the web files are handed it when served. `server/package.json` and `protocol/package.json` carry the same number (a test fails if they differ). Bump all three and the lockfile with one command, `npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`, in the commit that changes what Axis does: the middle number for a batch of new things, the last for fixes, and add a line to `CHANGELOG.md` in the same commit. Tag a release `vX.Y.Z`.
- It is NOT the protocol's version (`PROTOCOL_VERSION`, one whole number, changed only when devices and Axis must talk differently; always written with the word, "protocol 1", never as a bare "version 1") and NOT a firmware version (counted per device type, in the firmware's own files). Never write one where another is meant.
- Deploy with `npm run deploy`, not bare `docker compose up -d --build`: it passes the commit into the build, which the admin page shows beside the version.
- Releases are git tags.
- `.gitea/workflows/test.yml` runs the type check, the tests and a schema freshness check on every push to `main`.
