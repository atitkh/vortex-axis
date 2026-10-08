# CLAUDE.md

Guidance for coding agents working in this repository.

## Project

VorteX Axis is a hub between thin client devices and an OpenClaw agent. Clients hold one WebSocket to Axis. Axis holds the connections to the OpenClaw gateway (as one node), STT and TTS, and owns the client registry, settings and routing.

Read [docs/design.md](docs/design.md) before changing behavior. It records what was agreed and marks what is still proposed or open.

## Status

Last updated: 2026-10-08, at the commit that added the Firmware page and kept builds (firmware 0.9.1). Update this line whenever you change this section.

Built and running:

- `protocol/`: version 1 draft, including the `describe` message a device uses to declare its settings, actions and links.
- `server/`: client pairing, tokens, three-layer settings sync, the admin API, wake arbitration, voice and text turns, and the OpenClaw gateway link (an operator link that sends turns to a named agent, and a node link that declares the command list, publishes tools and carries out `vortex.axis.say`, `vortex.axis.clients`, `vortex.axis.config`, `vortex.axis.sense`, `vortex.axis.diag` and `system.notify`). An empty or `NO_REPLY` answer is held back: nothing is spoken or shown and no follow-up opens. Speech: sentences are synthesized one at a time, the next while the one before plays (one ahead at most), with a deliberate pause between sentences (`sentencePauseMs`, a built-in setting, 300 ms) that counts the engine's own trailing silence. The owner heard per-sentence synthesis and smooth playback live. Axis pings every client socket (`AXIS_PING_INTERVAL_MS`, 15 s) and drops one that misses a ping, so a board that loses power or Wi-Fi shows offline within about 30 s; before this it stayed online until the OS gave up on the socket. Not yet watched with the real board unplugged.
- `web/`: the web client and the admin page. The web client (`index.html`, `client.js`, `style.css`) looks like the board: black, the vortex face from `web/vortex.js` (a port of the firmware's `vortex.cpp`; keep the two in step), tap the face to talk, finish or stop, the words under it, a history drawer. Used by the owner in a desktop browser after `f935546` and working; not yet tried on a phone. The admin page (`admin.html`, `admin.js`, its own `admin.css`; the web client keeps `style.css`) has a sidebar and shows one section at a time, chosen by the address hash: `#overview` (the home page), `#activity`, `#clients`, `#clients/<id>`, `#type/<type>`, `#settings` (all devices), `#pair`, `#openclaw`, `#agent`, `#speech`. Settings are managed fleet first: each client type in use gets a settings page (what all its devices share, which devices differ, actions run on every online device), and a device's page shows each setting's value and where it comes from, with "Use shared" and "Share with type". A value equal to what the layers below give is removed instead of stored, so it keeps following. Name and room are edited at the top of a device's page (`PATCH /admin/clients/:id` renames). Adding a device notices when the new code is used. The Overview lists what needs attention (services down, devices offline, failed turns, crashes) with Axis uptime, devices online, turns and time to first sound, and 24 h uptime strips. Activity has charts of time to first sound and turns, where the wait goes, uptime strips, recent turns (timings only) and a filterable event list; a device's page has its own 24 h history. Charts are hand-drawn SVG in `web/charts.js`. Running on the live hub; the owner has used the Activity page.
- `firmware/`: a working client for the Waveshare ESP32-S3-Touch-AMOLED-1.8, flashed and used by a person: setup network, pairing, socket, face, speaker, microphone with tap-to-talk, on-device "Hey Vortex" wake word, follow-up listening, listen cue, a log page at `/logs` on the device. See `firmware/README.md`.

Proven with a real gateway, a real board and a real voice: pairing, typed and spoken turns, `vortex.axis.say`, tap-to-talk, wake word, follow-up.

Known not working, accepted for now: saying the wake word over the device's own speech (barge-in). The board has no echo canceller. Tap interrupts instead. Do not build an echo canceller without being asked.

Built 2026-10-08 and covered by `server/test/commands.test.ts`, but NOT yet tried by the owner on a real device or through a real agent: `vortex.axis.ask` (question with choices to tap or say, or an open question), `vortex.axis.timer` (timers kept on Axis, announced when due, counted down on a screen) and `vortex.axis.admin` (list and run device actions, rename, pairing code). Design section 6 says how each behaves. The owner has since tried them on the board (2026-10-08): tapping a choice works, and the timer tests passed. A fix after that, deployed but not yet retried by the owner: an agent asking mid-turn on the device it is talking to was refused as busy (see `thinking` in `turns.ts`). `firmware/README.md` tests 17 to 22 are the list for a person.

Built 2026-10-08, milestone 5: firmware updates over Wi-Fi (design 7.1; done three times on the real board) and TLS from devices (`axis+tls://`, design 7.2; the board trusts public certificates and refuses a self-signed one, but it has NOT been used against a real Axis address, because none with a public certificate exists yet).

Built 2026-10-08 after milestone 5: protections for a public address (design 9.0: `AXIS_PUBLIC_HOSTS` hides the admin side, attempt limits, trusted proxies; tested, not yet used with a real domain), display names for client types, and on the board (0.9.0) FreeSans text and turning the picture with the device. The last two are NOT yet seen by the owner, and two of the four auto-rotate directions are a guess (`firmware/README.md` test 24).

`docs/client-guide.md` is the contract for a new client type: what each capability obliges a client to do, the shared setting keys, the commands every client answers, and a checklist. Read it before writing firmware for a new board, and change it in the same commit as any change to what clients must do.

Not built yet: staged rollout of updates, signed firmware, a wake word in the web client, wake word models sent from Axis, firmware built in CI on a tag. The owner asked about these on 2026-10-08; they were discussed, not started.

Deployed: the container was rebuilt and the board updated over Wi-Fi to firmware 0.9.1 at that commit. 0.9.1 corrects auto-rotate, which 0.9.0 had a quarter turn out; the owner has not yet confirmed the correction.

Loose ends, not yet done:

- The owner saw the "Agent" time (Axis asking OpenClaw to its first words) grow. Nothing in Axis touches that stretch; not investigated on the OpenClaw side.
- Not watched yet: a board unplugged going offline within about 30 s; a long spoken answer after the fetch crash fix (`drain()`).
- `browser-check` needs `google-chrome`, or `CHROME=<path>`; on the owner's Mac it was run with Brave.

Next: the owner sets up the public domain behind his reverse proxy (then `AXIS_PUBLIC_HOSTS` and `AXIS_TRUSTED_PROXIES` go into `.env`, and a device is moved to an `axis+tls://` address), and looks at the 0.9.0 font and auto-rotate.

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
- Axis is ONE OpenClaw node. The target client or room is a command parameter. Do not open one node connection per client.
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
docker compose up -d --build          # needs .env, see .env.example
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
- `server/src/timers.ts`: timers agents set. Kept in the `timers` table, announced with `hub.say` when due, retried while nobody can be reached, and told to screens with the `timer.next` command.

- `server/src/activity.ts`: the activity log: turn timings and outcomes (never words), events (connections, service states, Axis start and stop, settings and admin changes), uptime timelines and the summary `GET /admin/activity` returns. Stored in the `turns` and `events` tables, pruned after `AXIS_ACTIVITY_DAYS`.
- `server/src/upstream.ts`: the speech and agent settings an admin can change at runtime, and the speech test.

The agent is an OpenClaw gateway reached over its WebSocket, or any OpenAI-style chat endpoint when the admin picks that. The gateway client always exists, so its node link keeps working either way.

Speech and agent settings come from the environment first and from the `meta` table after an admin saves them; the saved value wins. `app.ts` keeps one `services` object for the life of the process and replaces its fields in place, which is how a change reaches the next turn.

The gateway's device tokens and the setup code are stored in the SQLite `meta` table as plain text, because Axis has to present them. Treat the data folder as secret.

## Firmware map

- `firmware/common/src/axis_client.*`: the shared client core: socket, pairing, settings sync, audio framing, `describe`, commands.
- `firmware/common/src/log_buffer.h`: the in-memory log served at `/logs`, also copied to USB serial.
- `firmware/common/src/vad.h`: energy-based speech detection.
- `firmware/wake/`: the wake word detector. `firmware/lib/` holds vendored TensorFlow Lite Micro and the audio front end; do not edit them.
- `docs/face.md`: the vortex face's specification: the 13 looks with their numbers, the drawing steps, how a voice level is measured, and which look shows when. A new board draws the face from it. `vortex.cpp` and `web/vortex.js` follow it; change all three in one commit.
- `firmware/waveshare-amoled-1.8/src/`: board code only: `main.cpp` (wiring, settings table, actions), `display`, `vortex` (the face), `speaker` (includes the 24 kHz to 16 kHz low-pass resampler), `mic`, `codec`, `touch`, `imu` (which way up the board is), `fonts/` (vendored, do not edit).

A setting or action a device offers is declared once, in the board's table in `main.cpp`. The server validates against that description and the admin page draws from it, so do not add per-board code to `web/` or the server.

Build in a board folder with `~/.platformio/penv/bin/pio run`. Ship it over Wi-Fi with `AXIS_ADMIN_TOKEN=... node scripts/push-firmware.mjs <type> --update` from the repository root (the token is in the untracked `.env`); use the cable (`pio run --target upload`) only for a first install or a board that will not start. Bump `AXIS_FIRMWARE_VERSION` with every flashed change. Flashing resets a device someone may be using, and anything that makes sound or changes the picture needs a person to confirm it; say so instead of calling it tested.

## Conventions

- Keep docs current: a decision that changes behavior goes into `docs/design.md` in the same change.
- No secrets, tokens or internal addresses in the repository.
- Releases are git tags.
- `.gitea/workflows/test.yml` runs the type check, the tests and a schema freshness check on every push to `main`.
