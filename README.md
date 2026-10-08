# VorteX Axis

A hub that sits between small "thin client" devices and an [OpenClaw](https://docs.openclaw.ai) agent.

Clients (ESP32 boards, a web page, later a watch) connect to Axis. Axis connects to OpenClaw as a single node and to the speech services (STT and TTS). A client only needs a microphone, a speaker or a screen, and one connection to Axis. Everything else lives in the hub.

Axis is a bridge, not an agent runtime. It does not think; it routes.

**Status:** early. The server handles client pairing, settings, full voice and text turns, and the link to an OpenClaw gateway in both directions. There is no client yet (web or firmware), and none of it has run against a real gateway. See [docs/design.md](docs/design.md) and [protocol/README.md](protocol/README.md).

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

What exists today: client pairing, per-client tokens, settings sync, wake word arbitration, voice and text turns, and the OpenClaw gateway link (turns to an agent, and agents speaking through Axis). Not built yet: any client (web or firmware), and the `axis.ask`, `axis.timer` and `axis.admin` commands.

```bash
cp .env.example .env      # then fill in the token and the three upstream addresses
docker compose up -d --build
curl http://localhost:8440/healthz
```

Axis is one container with one data volume. Everything host-specific is an environment variable, so moving hosts means copying the volume and the `.env` file.

### Speech services

Axis reaches speech recognition and synthesis through OpenAI-style HTTP endpoints, so each can be swapped by changing an address in `.env`:

| Service | Setting | Endpoint shape |
| --- | --- | --- |
| Speech recognition | `AXIS_STT_URL` | `/v1/audio/transcriptions` |
| Speech synthesis | `AXIS_TTS_URL` | `/v1/audio/speech`, asked for raw PCM |

A service left unset is reported to clients as down. In the code both sit behind small interfaces (`server/src/speech.ts`), so an engine running inside Axis could replace either later.

### Pairing Axis with OpenClaw

Axis joins the gateway the way a device does: one identity, an operator link for turns and a node link for commands.

1. On the gateway host, print a setup code: `openclaw qr --setup-code-only`
2. Give it to Axis:
   ```bash
   curl -X POST http://localhost:8440/admin/gateway/setup-code \
     -H "Authorization: Bearer $AXIS_ADMIN_TOKEN" -H "content-type: application/json" \
     -d '{"code": "<setup code>"}'
   ```
3. Approve the device on the gateway (`openclaw devices list`, then `openclaw devices approve <id>`, or Settings, Devices in the Control UI). Axis retries every 10 seconds until then.
4. Allow Axis's commands in the gateway config under `gateway.nodes.commands.allow`: `axis.say`, `axis.ask`, `axis.clients`, `axis.config`, `axis.sense`, `axis.diag`, `axis.timer`, `axis.admin`. Then approve the node's commands if the gateway asks (`openclaw nodes approve <id>`).
5. Check: `GET /admin/gateway` should show both links `connected`.

Pick the agent that answers with `AXIS_AGENT_ID`, or at runtime with `PATCH /admin/gateway` and `{"agentId": "name"}`. With neither, the gateway's default agent answers.

### Admin API

Every admin call needs `Authorization: Bearer $AXIS_ADMIN_TOKEN`. Keep these routes on the local network.

| Call | Does |
| --- | --- |
| `POST /admin/pairing-codes` | Creates a one-time pairing code (valid 10 minutes by default). |
| `GET /admin/clients` | Lists clients, whether each is online, and its resolved settings. |
| `GET /admin/clients/:id` | One client. |
| `DELETE /admin/clients/:id` | Removes a client. Its token stops working and it is disconnected. |
| `GET /admin/gateway` | State of both gateway links, the device id and the chosen agent. |
| `POST /admin/gateway/setup-code` | Starts pairing with `{"code": "...", "url": "optional address"}`. |
| `PATCH /admin/gateway` | Chooses the agent: `{"agentId": "name"}`, or `null` for the gateway default. |
| `GET /admin/gateway/agents` | Lists the agents the gateway offers. |
| `POST /admin/gateway/retry` | Reconnects now, skipping any backoff. |
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
