# CLAUDE.md

Guidance for coding agents working in this repository.

## Project

VorteX Axis is a hub between thin client devices and an AI agent: made for OpenClaw first, and usable with any other agent harness through MCP and an OpenAI-style chat address. Clients hold one WebSocket to Axis. Axis holds the connections to the OpenClaw gateway (as one node), STT and TTS, and owns the client registry, settings and routing.

Read [docs/design.md](docs/design.md) before changing behavior. It records what was agreed and marks what is still proposed or open.

## Status

Last updated: 2026-10-13. Keep this section to what is true NOW, in a screen or two: what runs, what is unproven, what is broken, what is next. What changed in each version goes in `CHANGELOG.md` (newest first); how something was built or tried goes in `docs/design.md`. The notes that used to be here are in `docs/status-history.md`.

**Versions:** Axis 0.42.3, board firmware 0.18.2, desktop app 0.9.0, protocol 1. Licence Apache-2.0 (`LICENSE`, `NOTICE`). Releases: a tag `vX.Y.Z` matching `package.json` runs `.github/workflows/release.yml` (firmware, desktop app, image with both in `bundled/`); the repository is on a private Gitea for now (its runner builds the release, results readable in Gitea's database) and will be mirrored to GitHub. `SECURITY.md` says what protects what; change it with any change to auth, tokens, exposure or the desktop app's limits. One number for the server and its web pages (top-level `package.json`); firmware and the desktop app count their own.

**Running now:** see `CLAUDE.local.md`. That file is NOT in the repository (it is in `.gitignore`): it holds what is particular to one installation, such as host names, addresses, the public name, device names and which agent answers. If you are working on the installation this checkout belongs to, read it and keep it current; never write such details in this file or anywhere else that is committed. In general terms: Axis runs in Docker on port 8440 with its data folder on a local disk, backs itself up hourly to a mounted folder, is reached from outside under a public name through a tunnel with `/admin` kept to the local network, and serves two Waveshare boards, a few browser clients and one Windows computer through an OpenClaw gateway.

**What there is**

- `protocol/`: version 1, the one definition of the messages between a client and Axis.
- `server/`: pairing and tokens, three-layer settings, voice and text turns (local speech services, or a realtime voice model), wake arbitration between devices, the OpenClaw gateway link (operator and node), the same tools over MCP (`POST /mcp`), questions and approvals, timers, long tasks on the screens, pictures in replies, messages kept for a device that is away, Web Push, quiet hours, voiceprints, Home Assistant over MQTT, backups, firmware and desktop app updates, the admin API.
- `web/`: the web client (an installable page that looks and behaves like a board) and the admin page.
- `firmware/`: the Waveshare ESP32-S3-Touch-AMOLED-1.8 board: face, wake word, tap and hold to talk, pictures, edge glows, gestures, updates over Wi-Fi.
- `clients/windows-desktop/`: the desktop app (EXPERIMENTAL, its tool is off until switched on): an agent reads the screen and acts on it (`vortex_axis_desktop`: look, find, click, type, paste, keys, scroll, wait, open, switch, window, steps, clipboard, screenshot), and the computer is a voice device too (talk key, speakers, pills at the top of the screen, the face at the bottom). It updates itself from Axis.
- Timers may carry a task (`then` on the timer tool): when due, Axis starts a turn for the agent (`Turns.task`) instead of ringing; computers are look-only meanwhile (`Desktops.holdLookOnly`) unless the person said Allow when Axis asked. Once only; the owner said repeating tasks are not Axis's job.
- `speech/`: one image run as three CPU services (recognition, synthesis, voiceprints) behind OpenAI's audio API.

**Proven by the owner on real devices:** he tries each feature after it is built and has said (2026-10-13) that everything up to then works, including the desktop app's actions, updates, voice, pills and face on his computer. Treat a feature as unproven only if it is listed below or was added after that date.

**Never run by its author:** the Windows parts of the desktop app (there is no Windows where it is written). What is checked before a build goes out: the Core against a fake screen (every command's answer built and serialized), the voice part against a throwaway Axis with the real speech services, the face by rendering frames from `Face`. Expect the owner's first use to find what those cannot.

**Known and open**

- `i2cWrite ... ESP_ERR_INVALID_STATE` floods on a board after a serial-triggered reset (unexplained).
- Agents reach Axis through the general `nodes` tool unless the `vortex_axis_*` tools are in their tool policy; the desktop tool is MCP-only (adding a node command forces the node to be approved again).
- Saying the wake word over the device's own speech does not interrupt it (no echo canceller unless `bargeIn` is on). A tap does. Do not build more here without being asked.
- A screenshot an agent takes stays in that agent harness's own conversation history; Axis keeps none. The owner decided against cleaning other programs' folders from here.
- Not built: staged rollout of updates, signed firmware or a signed desktop app, a wake word in the web client or on a computer, firmware built in CI on a tag, a Mac desktop app (the plan: reuse `Axis.Desktop.Core`, write the platform part).

**Things that have bitten, so that they do not again**

- `scripts/build-desktop.sh` puts the build in the data folder, and every paired computer with "Update automatically" takes it within five minutes. Run it only for a build meant to go out, with a new version number.
- A setting saved on the admin page's Integrations page wins over `.env` (`server/src/hubconfig.ts`): check the page before concluding an `.env` change did nothing.
- Every streamed `fetch` body is read through `drain()`; never iterate `res.body` (Node crashes).
- Desktop app JSON: add strings to a `JsonArray` as `(JsonNode?)` casts; `AxisLink`'s options carry a type resolver; do not switch reflection-based JSON off (`Saved.cs` needs it). Never swallow a failed send: 0.4.0 to 0.4.3 lost every look that way.
- Desktop app: every UI Automation call goes through `Uia.Run` (its own thread, a deadline), never the thread pool.
- On a board, a command handler runs on the other core: leave a request for the screen loop; never stamp times or touch drawing state from the handler.
- A factory image for the flasher comes from `scripts/factory-image.mjs`, never PlatformIO's `firmware.factory.bin` as it is: that file's header says 8 MB flash and a board flashed with it from a browser does not start.
- The face has three copies that must stay in step with `docs/face.md`: `web/vortex.js`, the board's `vortex.cpp` and the desktop app's `Face.cs`. Icons are defined once in `web/icons.js`; `node scripts/gen-icons.mjs` writes the other two. The GIFs in `docs/media/` (README, `docs/face.md`) are drawn from `web/vortex.js` by `node scripts/make-face-gifs.mjs` (needs google-chrome and ffmpeg); run it again when a look or the drawing changes.
- After changing what a tool can do, a long-lived agent conversation may go on describing the old tool until it is reset.
- Tests start real servers and wait on sockets, so a busy machine makes them time out. `server/vitest.config.ts` gives them longer limits and a retry (two on CI, with two workers). A test that still fails is probably broken; run its file alone to be sure.

**Getting ready to be public (owner's order, 2026-10-13):** done: scrub, security pass (`SECURITY.md`), Apache-2.0, releases built from a tag with firmware and the desktop app bundled, a README for strangers with a quick start from published images (`compose.release.yaml`), a Getting started list on the admin Overview, a browser flasher for boards (`flasher/`: served by every Axis at `/flash` from the shelf's factory image, and published to GitHub Pages by the release workflow; run `node scripts/fetch-esp-web-tools.mjs` once after cloning), `docs/hardware.md`, `CONTRIBUTING.md`, issue forms. Left: mirror to GitHub (then enable Pages with source "GitHub Actions" and private vulnerability reporting) (the images are only pushed there; `ghcr.io/atitkh/...` in `compose.release.yaml` and the README assumes that owner), Docker Hub later, signing the Windows app, confirmation for risky desktop actions and a per-app block list. Then: refine the Windows app so it can be ported to a Mac.

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
- Do not build what `README.md`'s Status or this file's "Not built" list names as not there yet without being asked.

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
- `.github/workflows/test.yml` runs the type check, the tests and a schema freshness check on every push to `main`; `.github/workflows/release.yml` builds a release from a version tag. Both run on GitHub and on a Gitea runner labelled `linux`.
