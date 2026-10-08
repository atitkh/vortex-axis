# VorteX Axis

A hub that sits between small "thin client" devices and an [OpenClaw](https://docs.openclaw.ai) agent.

Clients (ESP32 boards, a web page, later a watch) connect to Axis. Axis connects to OpenClaw as a single node and to the speech services (STT and TTS). A client only needs a microphone, a speaker or a screen, and one connection to Axis. Everything else lives in the hub.

Axis is a bridge, not an agent runtime. It does not think; it routes.

**Status:** early. The hub handles client pairing, settings, full voice and text turns, and the link to an OpenClaw gateway in both directions. It has an admin page and a web client. There is no firmware client yet, and the gateway link has not run against a real gateway. See [docs/design.md](docs/design.md) and [protocol/README.md](protocol/README.md).

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
| `web/` | The web client and the admin page: plain HTML and JavaScript, served by the Axis container. |
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

What exists today: client pairing, per-client tokens, settings sync, wake word arbitration, voice and text turns, the OpenClaw gateway link (turns to an agent, and agents speaking through Axis), an admin page and a web client. Not built yet: firmware clients, and the `vortex.axis.ask`, `vortex.axis.timer` and `vortex.axis.admin` commands.

```bash
cp .env.example .env      # set AXIS_ADMIN_TOKEN; the rest can be done on the admin page
mkdir -p data             # or the folder AXIS_DATA_PATH names
docker compose up -d --build
curl http://localhost:8440/healthz
```

Then open:

- `http://<host>:8440/admin` to set Axis up: pair with OpenClaw, pick the agent, point it at the speech services and test them, create pairing codes, manage clients and shared settings.
- `http://<host>:8440/` for the web client: pair this browser with a code, then type or speak.

Browsers only allow the microphone on `https` or on `localhost`. Over plain `http` from another machine the web client still works by typing. To speak to it from other devices, give Axis an HTTPS address. Either works:

- **Tailscale**, reachable only from your own tailnet, with a real certificate and nothing to configure in Axis:
  `sudo tailscale serve --bg --https=8444 http://127.0.0.1:8440`, then open `https://<machine>.<tailnet>.ts.net:8444/`.
- **A reverse proxy** such as Nginx Proxy Manager: point a host name at port 8440 and turn on WebSocket support, since clients hold a socket on `/v1/client`.

Whichever you use, think about `/admin`: it is protected by the admin token only, so do not put it on a public address.

Axis is one container with one data folder on the host (`./data` by default, or wherever `AXIS_DATA_PATH` points). Everything host-specific is an environment variable, so moving hosts means copying that folder and the `.env` file. The folder may sit on network storage: the database uses a rollback journal, which is safe there.

### Speech services

Axis reaches speech recognition and synthesis through OpenAI-style HTTP endpoints, so each can be swapped by changing an address in `.env`:

| Service | Setting | Endpoint shape |
| --- | --- | --- |
| Speech recognition | `AXIS_STT_URL` | `/v1/audio/transcriptions` |
| Speech synthesis | `AXIS_TTS_URL` | `/v1/audio/speech`, asked for raw PCM |

A service left unset is reported to clients as down. In the code both sit behind small interfaces (`server/src/speech.ts`), so an engine running inside Axis could replace either later.

The addresses in `.env` are starting points. Anything saved on the admin page is stored in the data folder and wins from then on, and it applies to the next turn without a restart. The admin page's "Test both" button synthesizes a sentence and has recognition transcribe it back, with timings.

### Pairing Axis with OpenClaw

Axis joins the gateway the way a device does: one identity, an operator link for turns and a node link for commands. The admin page does steps 2 and 5 for you; the calls below are what it uses.

0. If the gateway runs on the Docker host and that host has a firewall, let the container reach it. The compose file gives Axis a fixed subnet for this: `sudo ufw allow from 10.84.40.0/24 to any port 18789 proto tcp`. Published ports are not affected by this; only calls from the container to the host are.
1. On the gateway host, print a setup code: `openclaw qr --setup-code-only`
2. Give it to Axis:
   ```bash
   curl -X POST http://localhost:8440/admin/gateway/setup-code \
     -H "Authorization: Bearer $AXIS_ADMIN_TOKEN" -H "content-type: application/json" \
     -d '{"code": "<setup code>"}'
   ```
3. Approve the device on the gateway (`openclaw devices list`, then `openclaw devices approve <id>`, or Settings, Devices in the Control UI). Axis retries every 10 seconds until then. Expect two requests one after the other: first the device itself, then its request to also act as a node.
4. Allow Axis's commands in the gateway config under `gateway.nodes.commands.allow`: `vortex.axis.say`, `vortex.axis.ask`, `vortex.axis.clients`, `vortex.axis.config`, `vortex.axis.sense`, `vortex.axis.diag`, `vortex.axis.timer`, `vortex.axis.admin`. Then approve the node's commands if the gateway asks (`openclaw nodes approve <id>`).
5. Check: `GET /admin/gateway` should show both links `connected`.

Pick the agent that answers with `AXIS_AGENT_ID`, or at runtime on the admin page (`PATCH /admin/gateway` with `{"agentId": "name"}`). With neither, the gateway's default agent answers.

To have something other than OpenClaw answer, choose "Another OpenAI-style chat endpoint" on the admin page and give its address. That is useful for trying other agent harnesses. The gateway link keeps running if it is paired.

### Admin API

Every admin call needs `Authorization: Bearer $AXIS_ADMIN_TOKEN`. Keep these routes on the local network.

| Call | Does |
| --- | --- |
| `POST /admin/pairing-codes` | Creates a one-time pairing code (valid 10 minutes by default). |
| `GET /admin/clients` | Lists clients with whether each is online, its address, its resolved settings and the three layers they come from, plus `types`: what each client type described (settings, actions, links). |
| `POST /admin/clients/:id/commands/:name` | Sends one of the actions the device offered and returns its answer (`{ok, payload, error}`). 409 when offline, 504 when it does not answer. |
| `POST /admin/clients/:id/announce` | Body `{ text }`. Speaks or shows it on that device and returns `{heard}`. |
| `GET /admin/clients/:id` | One client. |
| `DELETE /admin/clients/:id` | Removes a client. Its token stops working and it is disconnected. |
| `GET /admin/status` | Version, upstream health and client counts. |
| `GET` or `PATCH /admin/config` | Speech and agent settings. Secrets are accepted but never returned. |
| `POST /admin/config/test` | Synthesizes a sentence and transcribes it back, with timings. |
| `GET /admin/gateway` | State of both gateway links, the device id and the chosen agent. |
| `POST /admin/gateway/setup-code` | Starts pairing with `{"code": "...", "url": "optional address"}`. |
| `PATCH /admin/gateway` | Chooses the agent (`{"agentId": "name"}`, `null` for the gateway default) or sets the gateway address (`{"url": "..."}`). |
| `GET /admin/gateway/agents` | Lists the agents the gateway offers. |
| `POST /admin/gateway/retry` | Reconnects now, skipping any backoff. |
| `GET` or `PATCH /admin/settings/global` | Reads or changes settings for every client. |
| `GET` or `PATCH /admin/settings/type/:type` | Same, for one client type. Values for settings the type described are checked (range, options, toggles as 1 or 0). |
| `GET` or `PATCH /admin/settings/device/:id` | Same, for one client. |

`PATCH` takes `{"values": {"volume": 60}}`. Setting a key to `null` removes it from that layer.

### Development

```bash
npm install
npm test
npm run build && AXIS_ADMIN_TOKEN=dev npm start
npm run browser-check     # drives both pages in headless Chrome; needs google-chrome
AXIS_ADMIN_TOKEN=... npm run latency-probe   # times real turns through a running Axis
```

Needs Node 24 or newer (the server uses Node's built-in SQLite).
