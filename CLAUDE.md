# CLAUDE.md

Guidance for coding agents working in this repository.

## Project

VorteX Axis is a hub between thin client devices and an OpenClaw agent. Clients hold one WebSocket to Axis. Axis holds the connections to the OpenClaw gateway (as one node), STT and TTS, and owns the client registry, settings and routing.

Read [docs/design.md](docs/design.md) before changing behavior. It records what was agreed and marks what is still proposed or open.

## Status

Design agreed on 2026-10-07. `protocol/` has a version 1 draft. `server/` handles client pairing, tokens, settings sync, the admin API, wake arbitration, voice and text turns, and the OpenClaw gateway link: an operator link that sends turns to a named agent, and a node link that declares the command list, publishes tools and carries out `vortex.axis.say`, `vortex.axis.clients`, `vortex.axis.config`, `vortex.axis.sense`, `vortex.axis.diag` and `system.notify`.

`web/` holds the admin page and the web client.

Not built yet: `vortex.axis.ask`, `vortex.axis.timer`, `vortex.axis.admin` (declared, answered with "not built yet"), the `ask` and `command` flows to clients, and firmware.

The gateway link has paired with a real gateway once (2026-10-07). What that taught is in section 13 of the design doc, and `server/test/fake-gateway.ts` was changed to behave the same way. Agent turns and agent commands over a real gateway are still unproven.

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
docs/              design and decisions
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
npm run browser-check                 # both pages in headless Chrome; set TTS and STT to include real speech
AXIS_ADMIN_TOKEN=dev npm start        # after a build; listens on 8440
docker compose up -d --build          # needs .env, see .env.example
```

`npm test` and `npm run typecheck` build `protocol/` first, because the server imports its compiled output.

## Server map

- `server/src/store.ts`: everything on disk (clients, pairing codes, settings). Tokens and codes are stored as hashes only.
- `server/src/hub.ts`: connected clients and the client protocol. Live state stays in memory.
- `server/src/http.ts`: pairing, health and the admin API.
- `server/src/turns.ts`: one turn from input to spoken reply, plus pacing of audio to the client.
- `server/src/wake.ts`: picks one client when several hear the wake word.
- `server/src/sentences.ts`: cuts a streaming reply into pieces to synthesize one at a time.
- `server/src/speech.ts`, `server/src/agent.ts`: upstream clients behind small interfaces. Tests pass fakes through `startApp`'s third argument.
- `server/src/app.ts`: wires them together. Tests start a real server on a free port through `startApp`, using `server/test/harness.ts`.

- `server/src/gateway/wire.ts`: frames, the device identity and the signed connect text.
- `server/src/gateway/link.ts`: one gateway connection in one role, with its retry rules.
- `server/src/gateway/client.ts`: both links, credentials, agent turns, node commands.
- `server/src/commands.ts`: the node's command list, the tools agents see, and what each command does.

- `server/src/upstream.ts`: the speech and agent settings an admin can change at runtime, and the speech test.

The agent is an OpenClaw gateway reached over its WebSocket, or any OpenAI-style chat endpoint when the admin picks that. The gateway client always exists, so its node link keeps working either way.

Speech and agent settings come from the environment first and from the `meta` table after an admin saves them; the saved value wins. `app.ts` keeps one `services` object for the life of the process and replaces its fields in place, which is how a change reaches the next turn.

The gateway's device tokens and the setup code are stored in the SQLite `meta` table as plain text, because Axis has to present them. Treat the data folder as secret.

## Conventions

- Keep docs current: a decision that changes behavior goes into `docs/design.md` in the same change.
- No secrets, tokens or internal addresses in the repository.
- Releases are git tags.
