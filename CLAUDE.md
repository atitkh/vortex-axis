# CLAUDE.md

Guidance for coding agents working in this repository.

## Project

VorteX Axis is a hub between thin client devices and an OpenClaw agent. Clients hold one WebSocket to Axis. Axis holds the connections to the OpenClaw gateway (as one node), STT and TTS, and owns the client registry, settings and routing.

Read [docs/design.md](docs/design.md) before changing behavior. It records what was agreed and marks what is still proposed or open.

## Status

Design agreed on 2026-10-07. No code yet. The first work is `protocol/`, then `server/`, then `web/`.

## Rules that are settled

- Axis is a bridge. Do not add agent logic, conversation history or decision making beyond routing.
- Axis is ONE OpenClaw node. The target client or room is a command parameter. Do not open one node connection per client.
- Clients are types with capabilities (`mic`, `speaker`, `screen`, `buttons`, `vibration`, `sensors`). Route on capabilities, never on a hard-coded device name.
- The wake word and silence detection run on the client. Axis never receives audio before a wake event.
- Axis is the source of truth for settings: global, then client type, then device.
- The web client is a normal client. It pairs and uses the same socket as firmware, with no private shortcuts.
- Name things `vortex-axis`, never plain `axis`, in hostnames, containers and Home Assistant entities. Plain `axis` collides with Axis Communications cameras and Home Assistant's `axis` integration.
- No host-specific values in code. Addresses come from environment variables.
- Version 1 scope is in the README. Do not build the "later" items without being asked.

## Stack

- Server and web: TypeScript on Node.
- Storage: SQLite, one file in one Docker volume.
- Client transport: one WebSocket per client, JSON for control and binary frames for audio.
- Firmware: PlatformIO, one shared core in `firmware/common/` and one folder per device type.

Package manager, web framework and test runner are not chosen yet. Ask before picking one.

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

`protocol/` is the single definition of the client messages. Server, web and firmware follow it. Change the protocol there first, bump its version, and keep the server accepting the previous version.

## OpenClaw gateway

The gateway protocol has traps that are not obvious from its docs. Section 13 of the design doc lists the ones already paid for. Check that list before writing or debugging the gateway client.

The command surface in section 6 is declared in full at first pairing. Adding a command later forces a human re-approval of the node, so do not add commands casually.

## Commands

None yet. Add build, test and run commands here as they come into existence.

## Conventions

- Keep docs current: a decision that changes behavior goes into `docs/design.md` in the same change.
- No secrets, tokens or internal addresses in the repository.
- Releases are git tags.
