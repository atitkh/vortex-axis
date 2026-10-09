# VorteX Axis

A hub that sits between small "thin client" devices and an [OpenClaw](https://docs.openclaw.ai) agent.

Clients (ESP32 boards, a web page, later a watch) connect to Axis. Axis connects to OpenClaw as a single node and to the speech services (STT and TTS). A client only needs a microphone, a speaker or a screen, and one connection to Axis. Everything else lives in the hub.

Axis is a bridge, not an agent runtime. It does not think; it routes.

**Status:** working, version 1 nearly complete. The hub handles pairing, settings, voice and text turns, and the link to an OpenClaw gateway in both directions, proven against a real gateway. There is an admin page (overview, activity and uptime, per-type and per-device settings) and a web client. The first firmware client runs on the Waveshare ESP32-S3-Touch-AMOLED-1.8 with an on-device "Hey Vortex" wake word, tap-to-talk and follow-up listening; see [firmware/README.md](firmware/README.md). Agents can also ask a question with choices and get the answer back, keep timers, and look after devices (`vortex.axis.ask`, `vortex.axis.timer`, `vortex.axis.admin`). Devices take firmware updates over Wi-Fi from Axis, and can connect over TLS (`axis+tls://`), which has been checked against public certificates but not yet used against a real Axis address. See [docs/design.md](docs/design.md) and [protocol/README.md](protocol/README.md).

## Why

Without a hub, every device has to do the same heavy work itself: hold two OpenClaw gateway connections, sign and pair, call STT and TTS, split replies into sentences, and store its own copy of every setting. That makes firmware large, and nothing is shared between devices.

With Axis:

- One connection point to OpenClaw, however many clients exist.
- Thin firmware: capture audio, play audio, show state.
- Settings (voice, persona, wake word, volume, location) are stored once and synced to every client.
- The agent can address a location or a client, and Axis picks the right device.

## How it fits together

```
 thin clients                    Axis                         upstream
 ------------                    ----                         --------
 web page   ─┐                                            ┌─ OpenClaw gateway (one node)
 ESP32-S3   ─┼── one WebSocket ──▶  registry, settings, ──┼─ STT (OpenAI-style HTTP)
 (watch)    ─┘   per client         routing, voice turn   └─ TTS (OpenAI-style HTTP)
```

- **Client to Axis:** one encrypted WebSocket per client. JSON messages for control, binary frames for audio.
- **Axis to OpenClaw:** Axis registers as one node. The target client or location is a parameter on Axis commands.
- **Axis to speech:** OpenAI-compatible HTTP endpoints, so the STT and TTS backends stay swappable.

## Repository layout

Folders appear as the work reaches them; `clients/` does not exist yet.

| Path | Contents |
| --- | --- |
| `server/` | Axis itself (TypeScript, Node). |
| `web/` | The web client and the admin page: plain HTML and JavaScript, served by the Axis container. |
| `protocol/` | The one versioned definition of every client-to-Axis message. |
| `firmware/common/` | Shared client core: Wi-Fi setup, pairing, socket, settings sync, audio framing, updates. |
| `firmware/<type>/` | One folder per device type holding only board-specific code. |
| `clients/` | Clients that are not firmware (for example a watch app). |
| `docs/` | Design and decisions. |

## What it does today

Version 1 (pairing, settings sync, one voice turn end to end, agent-started speech, a web client and an ESP32-S3 client) is done. On top of it:

- **Devices:** updates over Wi-Fi with rollback, an encrypted link over a public address, moving a device to another address without re-pairing, wake words served from Axis, a reset from the admin page.
- **The web client is an app:** installable on a phone, with notifications when its page is closed (including questions with choices), hold-to-talk beside tap-to-talk, a timer countdown with cancel, and the screen kept on while it is open.
- **Reaching people:** say something on one device, at a location, or everywhere; a message for a device that is away is kept for ten minutes; quiet hours by the clock.
- **Home Assistant:** every client appears there as a device (state, online, a "say" entity, volume) through MQTT discovery.
- **Admin page:** overview, activity log, per-device and per-type settings, firmware and wake word pages, a Face page showing every look, a live sketch of each device, all in the web client's black theme.

Not built: a second device type, a Bangle.js client, a wake word in the browser, presence-based routing, staged firmware rollout.

## Running it

What exists today: client pairing, per-client tokens, settings sync, wake word arbitration, voice and text turns, the OpenClaw gateway link (turns to an agent, and agents speaking through Axis), an activity log with uptime, an admin page, a web client and a firmware client, and the whole agent command surface: say, ask, timer, admin, clients, config, sense and diag.

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
- **A reverse proxy** such as Nginx Proxy Manager: point a host name at port 8440 and turn on WebSocket support, since clients hold a socket on `/v1/client`. For a PUBLIC name, set `AXIS_PUBLIC_HOSTS` to that name first, so the admin page and API do not exist there, and `AXIS_TRUSTED_PROXIES` to the proxy's address. Devices then use a setup string beginning `axis+tls://`.

Whichever you use, think about `/admin`: it is protected by the admin token only, so do not put it on a public address.

**A public address** (how the reference setup runs): a Cloudflare Tunnel or any reverse proxy pointed at port 8440, with the host name listed in `AXIS_PUBLIC_HOSTS` and the proxy's address in `AXIS_TRUSTED_PROXIES`. Under that name Axis serves the web client, pairing, the client socket and firmware downloads, and answers "not found" for `/admin`. A proxy may keep scripts and styles for hours whatever Axis says (Cloudflare does, for four), so every address one web file loads another by carries a stamp of the build (`/web/client.js?v=…`), and an open page reloads itself when Axis has a newer one.

**On a phone:** open the public address, pair, then add it to the Home Screen. "Turn on notifications" is at the bottom of the page; an iPhone only offers it to the installed app. Brave needs "Use Google services for push messaging" switched on.

**Home Assistant:** set `AXIS_MQTT_URL` to the broker Home Assistant uses and the devices appear by themselves. **Quiet hours** are times of day in `AXIS_TIMEZONE`. Both are described in `.env.example`.

Axis is one container with one data folder on the host (`./data` by default, or wherever `AXIS_DATA_PATH` points). Everything host-specific is an environment variable, so moving hosts means copying that folder and the `.env` file. The folder may sit on network storage: the database uses a rollback journal, which is safe there. It is safe there but not a good place for it: Axis waits on every database write, so a busy share freezes it, clients drop and the speech services read as down. Keep the folder on a local disk and copy it to the share with `scripts/backup-data.sh <data folder> <backup folder>` from cron; the copy has the same layout, so restoring is copying it back.

### Backup and restore

Set `AXIS_BACKUP_PATH` in `.env` to a folder on the host, on another disk than the data folder, and Axis copies its data there by itself: every hour unless changed, with how often and how many daily copies to keep set on the admin page under Integrations, where there is also a **Back up now** button and the result of the last run. A failed or overdue backup shows on the Overview. Nothing on the host has to be scheduled.

The backup folder holds `axis.sqlite` (the latest copy of the database, checked before it replaces the one before), `daily/axis-YYYY-MM-DD.sqlite` (one a day), and mirrors of `firmware/` and `wakewords/`. The database includes the gateway tokens and client token hashes: keep the folder as private as the data folder.

To restore, on the same host or another:

1. `docker compose down`
2. Copy `axis.sqlite` (or one of the daily copies, renamed to `axis.sqlite`) and the `firmware` and `wakewords` folders from the backup folder into the data folder, replacing what is there. Remove `axis.sqlite-journal` if one is left.
3. `docker compose up -d`

Devices and browsers keep working with the restored database as long as it is newer than their pairing; anything paired after the copy was made has to be paired again.

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
| `PATCH /admin/clients/:id` | Body `{ name }`. Renames a client (1 to 60 characters). 409 when another client already has that name, ignoring case. |
| `DELETE /admin/clients/:id` | Removes a client. Its token stops working and it is disconnected. |
| `GET /admin/status` | Version, upstream health, client counts, and when Axis started (`startedAt`, `uptimeMs`). |
| `GET /admin/activity` | `?hours=24` (up to the retention period) and optionally `&client=<id>`. Turn counts, outcomes and timings (typical and slowest 5 %), per-bucket figures for charts, uptime timelines for Axis, each service and each client, the recent turns (timings only, never words) and recent events. |
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

| `POST /admin/clients/:id/reset` | Body `{ wifi? }`. Tells a device to forget its pairing and settings (and its Wi-Fi), then removes it. 409 when its firmware cannot. |
| `POST /admin/clients/:id/address` | Body `{ address }`. Moves a device to another address for the same Axis, keeping its pairing. |
| `POST /admin/clients/:id/update` | Tells a device to install the current firmware build for its type. |
| `POST /admin/clients/:id/notify-test` | Sends a browser client a test notification, page open or closed. 409 when it has notifications off. |
| `POST /v1/volume` | A client setting its own volume, with its own token: `{volume: 0-100}`. Nothing else can be changed this way. |
| `GET /admin/live` | A stream that stays open (server-sent events): `snapshot` with the recent turns, then `turn` each time a turn reaches a stage or ends, and `wake` for each wake word a device reports. Words are memory only. |
| `POST /admin/live/clear` | Deletes, now, the words Axis holds in memory for the admin page: finished live turns and the device sketches. |
| `PATCH /admin/integrations` | Changes hub settings: `mqtt` `{host, port, user, password, discoveryPrefix}`, `publicHosts`, `trustedProxies`, `timeZone`, `activityDays`, `messageHoldMinutes`. Only the fields given change; a saved value wins over the environment. |
| `GET /admin/wakes` | `?hours=168`. Wake words devices reported: device, score, loudness, the wake word in use and the outcome. |
| `POST /admin/announce` | `{text, client?, location?, urgent?}`. Says it on one client, in one location, or on every client that can speak. |
| `GET /admin/integrations` | How Home Assistant (MQTT), browser notifications, the public address, the gateway links and the backup stand. No secrets. |
| `POST /admin/backup` | Makes a backup now and answers with how it went. 409 when no backup folder is set up. |
| `GET /admin/now` | What is going on this moment: timers, clients mid-turn, and the words on each screen (memory only). |
| `GET`, `POST`, `DELETE /admin/firmware…` | The firmware builds kept per client type. |
| `GET`, `POST`, `DELETE /admin/wakewords…` | The wake word models devices can be given. |
| `POST /admin/config/test-agent` | Tries an OpenAI-style chat endpoint as typed, before it is saved. |

`PATCH` takes `{"values": {"volume": 60}}`. Setting a key to `null` removes it from that layer.

Routes a client calls for itself, with its own token (`Authorization: Bearer <token>`, `X-Axis-Client: <id>`): `GET /v1/firmware/:type`, `GET /v1/wakewords/:id`, `POST` or `DELETE /v1/push/subscription`, `GET /v1/push/asks`, `POST /v1/timers/cancel`. Open to anyone: `GET /v1/push/key`, `GET /v1/web-version`, and `POST /v1/push/answer`, which takes a one-time token from the notification.

### Development

```bash
npm install
npm test
npm run build && AXIS_ADMIN_TOKEN=dev npm start
npm run browser-check     # drives both pages in headless Chrome, with stub speech unless STT and TTS are set; needs google-chrome, or CHROME=<path to a Chromium browser>
AXIS_ADMIN_TOKEN=... npm run latency-probe   # times real turns through a running Axis
```

Needs Node 24 or newer (the server uses Node's built-in SQLite).
