# VorteX Axis

A hub that sits between small "thin client" devices and an [OpenClaw](https://docs.openclaw.ai) agent.

Clients (ESP32 boards, a web page, later a watch) connect to Axis. Axis connects to OpenClaw as a single node and to the speech services (STT and TTS). A client only needs a microphone, a speaker or a screen, and one connection to Axis. Everything else lives in the hub.

Axis is a bridge, not an agent runtime. It does not think; it routes.

**Status:** design agreed. The client protocol has a first draft; the server does not exist yet. See [docs/design.md](docs/design.md) and [protocol/README.md](protocol/README.md).

## Why

Without a hub, every device has to do the same heavy work itself: hold two OpenClaw gateway connections, sign and pair, call STT and TTS, split replies into sentences, and store its own copy of every setting. That makes firmware large, and nothing is shared between devices.

With Axis:

- One connection point to OpenClaw, however many clients exist.
- Thin firmware: capture audio, play audio, show state.
- Settings (voice, persona, wake word, volume, room) are stored once and synced to every client.
- The agent can address a room or a client, and Axis picks the right device.

## How it fits together

```
 thin clients                    Axis                         upstream
 ------------                    ----                         --------
 web page   ─┐                                            ┌─ OpenClaw gateway (one node)
 ESP32-S3   ─┼── one WebSocket ──▶  registry, settings, ──┼─ STT (OpenAI-style HTTP)
 (watch)    ─┘   per client         routing, voice turn   └─ TTS (OpenAI-style HTTP)
```

- **Client to Axis:** one encrypted WebSocket per client. JSON messages for control, binary frames for audio.
- **Axis to OpenClaw:** Axis registers as one node. The target client or room is a parameter on Axis commands.
- **Axis to speech:** OpenAI-compatible HTTP endpoints, so the STT and TTS backends stay swappable.

## Repository layout

Planned layout. Folders appear as the work reaches them.

| Path | Contents |
| --- | --- |
| `server/` | Axis itself (TypeScript, Node). |
| `web/` | The web client and the admin page, served by the Axis container. |
| `protocol/` | The one versioned definition of every client-to-Axis message. |
| `firmware/common/` | Shared client core: Wi-Fi setup, pairing, socket, settings sync, audio framing, updates. |
| `firmware/<type>/` | One folder per device type holding only board-specific code. |
| `clients/` | Clients that are not firmware (for example a watch app). |
| `docs/` | Design and decisions. |

## Version 1 scope

In:

- Axis container with client registration, pairing codes and per-client tokens.
- Settings sync across three layers: global, client type, device.
- One voice turn end to end: client audio in, STT, agent, TTS, audio out.
- The agent speaking unprompted through Axis.
- The web client first, then an ESP32-S3 client.
- A per-message header telling the agent which client spoke, and a tool to list clients.

Out, for later:

- Bangle.js 2 client.
- Exposure on a public domain (the auth is designed for it from the start).
- Presence-based routing.
- Firmware updates delivered through Axis.
- An admin page beyond a bare client list.

## Running it

Nothing to run yet beyond the protocol tests (`npm install && npm test`). Axis will ship as a single Docker container with one data volume, configured entirely through environment variables so it can move between hosts.
