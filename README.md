# VorteX Axis

A hub that sits between small "thin client" devices and an [OpenClaw](https://docs.openclaw.ai) agent.

Clients (ESP32 boards, a web page, later a watch) connect to Axis. Axis connects to OpenClaw as a single node and to the speech services (STT and TTS). A client only needs a microphone, a speaker or a screen, and one connection to Axis. Everything else lives in the hub.

Axis is a bridge, not an agent runtime. It does not think; it routes.

**Status:** early. The client protocol has a first draft, and the server handles pairing, connections and settings. Voice turns and the OpenClaw link are next. See [docs/design.md](docs/design.md) and [protocol/README.md](protocol/README.md).

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

What exists today: client pairing, per-client tokens, the client socket handshake, and settings sync. Voice turns and the OpenClaw link are not built yet.

```bash
cp .env.example .env      # then set AXIS_ADMIN_TOKEN
docker compose up -d --build
curl http://localhost:8440/healthz
```

Axis is one container with one data volume. Everything host-specific is an environment variable, so moving hosts means copying the volume and the `.env` file.

### Admin API

Every admin call needs `Authorization: Bearer $AXIS_ADMIN_TOKEN`. Keep these routes on the local network.

| Call | Does |
| --- | --- |
| `POST /admin/pairing-codes` | Creates a one-time pairing code (valid 10 minutes by default). |
| `GET /admin/clients` | Lists clients, whether each is online, and its resolved settings. |
| `GET /admin/clients/:id` | One client. |
| `DELETE /admin/clients/:id` | Removes a client. Its token stops working and it is disconnected. |
| `GET` or `PATCH /admin/settings/global` | Reads or changes settings for every client. |
| `GET` or `PATCH /admin/settings/type/:type` | Same, for one client type. |
| `GET` or `PATCH /admin/settings/device/:id` | Same, for one client. |

`PATCH` takes `{"values": {"volume": 60}}`. Setting a key to `null` removes it from that layer.

### Development

```bash
npm install
npm test
npm run build && AXIS_ADMIN_TOKEN=dev npm start
```

Needs Node 24 or newer (the server uses Node's built-in SQLite).
