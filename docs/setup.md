# Setting up and running Axis

The longer account behind the README's quick start: addresses and HTTPS, agents and tools, backups, speech services, pairing with OpenClaw, the admin API, and developing.

## Running it from this repository

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

### Agents and tools

An agent uses Axis through eleven tools (say, show, ask, timer, clients, config, sense, progress, session, diag, admin), and the experimental desktop tool when it is switched on. `show` puts a picture (an https address, a file on the OpenClaw gateway's machine, or base64) on a device's screen for 1 to 300 seconds; boards take PNG and JPEG, the web client also WebP and GIF. The OpenClaw gateway gets them through the node link. Any other harness gets them by MCP: on the admin page under **Agent tools**, make a token, then add Axis to the harness as a remote MCP server:

```json
{ "mcpServers": { "vortex-axis": { "type": "http", "url": "http://<axis host>:8440/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
```

To have that harness also answer when somebody speaks, give its OpenAI-style chat address on the **Agent** page. The two are separate connections: Axis sends the words over the chat address, and the harness calls the tools over MCP. The same page switches individual tools off for every agent.

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

A service left unset is reported to clients as down. In the code both sit behind small interfaces (`server/src/speech.ts`).

`compose.yaml` runs local ones beside Axis, on the CPU, from one small image (`speech/`): `vortex-axis-stt` (NVIDIA Parakeet TDT-CTC 110M), `vortex-axis-tts` (Supertonic 3, ten voices, `"voice": "0"` to `"9"`) and `vortex-axis-voiceprint` (WeSpeaker ResNet34, for telling voices apart). None of the three models has an API of its own; each service puts OpenAI's audio API in front of one through sherpa-onnx, so a client asking for `whisper-1` or `tts-1` gets them. Each fetches its model from the sherpa-onnx releases into `AXIS_MODELS_PATH` on first start (about 250 MB together) and answers on port 8000 inside the stack only; Axis reaches them by name, as `.env.example` shows. `AXIS_SPEECH_THREADS` (2) sets the CPU threads for recognition and synthesis. Pointing the addresses anywhere else that speaks OpenAI's API works as before.

**Telling voices apart** is off until it is switched on in the Speech page's "Voice recognition" section, and does nothing until a voice is taught (recorded on that page, or picked from turns a device heard in the last ten minutes). Each spoken turn then gets a voiceprint beside speech recognition, compared with the taught voices: known, guest or unsure. The agent sees `voice: <name>`, `voice: guest` or `voice: unsure` on the bracketed device line, and a guest's turn can go on as usual, go to the same agent in a guest conversation (`<session>-guest`), go to another agent there, or be turned away. Only voiceprints are stored, never recordings. It is not a lock: a recording of a taught voice passes.

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
4. Allow Axis's commands in the gateway config under `gateway.nodes.commands.allow`: `vortex.axis.say`, `vortex.axis.ask`, `vortex.axis.clients`, `vortex.axis.config`, `vortex.axis.sense`, `vortex.axis.progress`, `vortex.axis.session`, `vortex.axis.diag`, `vortex.axis.timer`, `vortex.axis.admin`. Then approve the node's commands if the gateway asks (`openclaw nodes approve <id>`).
5. Check: `GET /admin/gateway` should show both links `connected`.

Pick the agent that answers with `AXIS_AGENT_ID`, or at runtime on the admin page (`PATCH /admin/gateway` with `{"agentId": "name"}`). With neither, the gateway's default agent answers.

To have something other than OpenClaw answer, choose "Another OpenAI-style chat endpoint" on the admin page and give its address. That is useful for trying other agent harnesses. The gateway link keeps running if it is paired.

### Profiles

A profile is a named set of overrides on a device's own settings. There are four: **Dock** (normal, but on USB the battery charges only to the hub's Dock charge limit, then holds; see below), **Normal** (the device's settings as set), **Power saver** (brightness at most 100, at most 15 frames a second) and **Silent** (volume 0, no listening cue or task chime, nothing spoken: replies and messages are shown as text, tap to talk still works; a device without a screen keeps messages until it leaves silent). Overrides apply only to settings a device has, so a web client or a computer on silent changes no setting it does not declare, and still gets its replies as text.

- **Per device:** the `profile` setting (group Axis) is `auto` by default, which is normal, and power saver while the device reports a battery at or below the hub's level and is not charging. Any other choice holds until it is set back to `auto`. It is edited like every other setting under the device's **Settings**, with the Save bar, and can be set for a type or for everything the same way.
- **Hub setting:** **Power saver below** on **System** (`/admin#system`), a battery percent from 0 to 90, 20 by default, 0 for never (`AXIS_POWER_SAVER_BELOW` in `.env`; the page's value wins). Power saver ends 10 points above it, or as soon as the device charges. Beside it, **Dock charge limit**, 50 to 100, 80 by default (`AXIS_DOCK_CHARGE_LIMIT`): what a device on Dock holds its battery at.
- **Charge limit and Dock:** a device with a battery has **Charge limit** (`chargeLimit`) in the **Battery** group of its Settings, beside **Low battery look**: 50 % to 95 % by fives, or **No limit** (100, the default). On USB a board that can hold its battery charges only to the limit and holds there, charging again 5 points below; on battery nothing changes. The **Dock** profile puts the hub's Dock charge limit in its place; every other profile uses the device's own. Auto never picks Dock: choose it by hand for a board that lives on a charger. The device's Overview shows a **Charger** gauge ("charging (constant current)", "full", "held at 80% by the charge limit") with the USB volts under it, from firmware that reports them.
- **Charge current:** **Charge current** on **System** (`/admin#system`, beside Dock charge limit), 100 to 1000 mA, 1000 by default (`AXIS_CHARGE_CURRENT` in `.env`; the page's value wins), is the most any board's charger draws, the same for every board and every profile. A board tapers it by itself as the battery nears the limit in force (no limit counts as 100 %): the full current up to three quarters of the limit, half to 87.5 %, a quarter to 95 %, a tenth above that (at a limit of 80: from 60, 70 and 76 %), one step less above 40 C on its power chip and two above 50 C. 1000 mA is 1C for the boards' 1000 mAh cell; with a smaller battery set it to the battery's capacity or less. Firmware 1.8 0.26.0 and round board 0.10.0 and later; older firmware ignores it and charges at what its chip holds.
- **On the Overview:** a device's **Overview** is read-only with one exception, the **Profile** switch (Auto, Normal, Power saver, Silent, Dock), which applies at once with no Save bar. Beside it is the profile in force and why: `on silent (manual)`, `on power saver (battery 17%)`, `Dock: charging held at 80%`. **Settings in effect** there lists the values the device is sent, with the profile and quiet hours applied. A device on a profile other than normal carries a chip on the **Map** and in **Devices**.
- **Agents:** `vortex_axis_config` with key `profile` switches it (`auto`, `normal`, `power-saver`, `silent`, `dock`), key `chargeLimit` sets the device's own limit,, and `vortex_axis_sense` reports each device's `info.profile` and `info.profileReason` (`manual`, `battery` or `auto`).

### The system map

The admin page's **Map** (`/admin#map`) draws every device grouped by its location, Axis, and the services behind it (the agent, speech recognition and synthesis, voiceprints, Home Assistant), coloured by state and kept current while the page is open. A running turn lights its path with the time of each stage. When devices hear the wake word, each one that heard it shows two bars beside it for about 6 s, how sure it was and how loud, with what came of it: the one that answered is outlined and says by how much its score won, the others are dimmed as stood down or ignored. Selecting a device opens its device page (`/admin#clients/<client id>`), whose Overview is the same live view of that one device: its sketch with the face, its readings as gauges and, in the same card, the device's details (type, version and its update, what it can do, its address and pages, where it reaches Axis, the offline alert, its id; **Name and location** beside the status line), then what needs attention, the settings in effect, its last turns and what it can do, above its actions and last 24 hours. The older address `/admin#map/<client id>` opens that page too, and the device page's **On the map** opens the map with the device picked out (`/admin#map?device=<client id>`). The map and the Overview are read-only; settings are changed under the device page's Settings.

### The battery preview

A board with the battery look (it offers **Low battery look**, `lowBatteryBelow`) has a **Battery** card beside **Edge glow** on its **Tools** tab. The previews (edge glow, battery, microphone levels) are on the Tools tab only; the side column of **Settings** holds the device's sketch, and the glow and battery rows there link to the Tools tab. It draws the board's screen at a made-up charge the way the board does (the sleepy idle face, the battery mark, the charging swell and bolt; `docs/face.md` section 10): a **Charge** slider, a **Charging** switch, and quick choices **Low** (12 %), **Critical** (4 %), **Charging** (64 %, with the cue) and **Full/none** (nothing shown). The slider marks the threshold the look starts at, with a staged **Low battery look** or **Battery mark** drawn before it is saved.

**Show on the device** has the board show the same for 20 s, then its own battery again; **Off** ends it sooner. Nothing is sent while the slider moves. A board on firmware from before the command (1.8 0.23.1, 1.75 0.7.1) is reported as needing newer firmware.

### Admin API

Every admin call needs `Authorization: Bearer $AXIS_ADMIN_TOKEN`. Keep these routes on the local network.

| Call | Does |
| --- | --- |
| `POST /admin/pairing-codes` | Creates a one-time pairing code (valid 10 minutes by default). |
| `GET /admin/clients` | Lists clients with whether each is online, its address, its resolved settings and the three layers they come from, its `kind` (board, round, browser, computer, headset) and `offlineAfterMs` (how long it may be offline before the attention list names it; null for never), plus `types`: what each client type described (settings, actions, links). |
| `POST /admin/clients/:id/commands/:name` | Sends one of the actions the device offered and returns its answer (`{ok, payload, error}`). 409 when offline, 504 when it does not answer. |
| `POST /admin/clients/:id/battery` | Body `{ percent?, charging?, ms?, off? }` (percent 0 to 100, 12 by default; ms 2000 to 60000, 20000 by default). Shows a made-up battery state on a board for that long; `off` ends it. 400 when the board has no battery look. |
| `POST /admin/clients/:id/announce` | Body `{ text }`. Speaks or shows it on that device and returns `{heard}`. |
| `POST /admin/clients/:id/show` | JSON body with exactly one of `url` (https), `path` (a file on the OpenClaw gateway's machine) or `base64` (with `mime`), and `seconds` (1 to 300, 10 by default), `alt`, `fit` (`cover` by default, or `contain`). Puts the picture on that device's screen, as the `show` tool does, and returns `{client, shown, seconds, note}`. 5 MB at most. |
| `POST /admin/clients/:id/show/clear` | Takes the picture down early (`image.clear`). Returns `{client, cleared}`. |
| `GET /admin/pictures` | The last 30 pictures shown (memory only): `id`, `at`, `by` (agent or admin), `device`, `seconds`, `alt`, `fit`, `shown`, `note`, `url` and `thumb` (media addresses, a day at most), `available`. |
| `POST /admin/pictures/:id/show` | Body `{ client?, seconds? }`. Shows a picture from that list again, on its device or the one given; 410 when it is no longer kept. |
| `GET /admin/clients/:id` | One client. |
| `PATCH /admin/clients/:id` | Body `{ name }`. Renames a client (1 to 60 characters). 409 when another client already has that name, ignoring case. |
| `DELETE /admin/clients/:id` | Removes a client. Its token stops working and it is disconnected. |
| `GET /admin/status` | Version, upstream health, client counts, and when Axis started (`startedAt`, `uptimeMs`). |
| `GET /admin/activity` | `?hours=24` (up to the retention period) and optionally `&client=<id>`. Turn counts, outcomes and timings (typical and slowest 5 %), per-bucket figures for charts, uptime timelines for Axis, each service and each client, the recent turns (timings only, never words) and recent events. |
| `GET` or `PATCH /admin/config` | Speech and agent settings. Secrets are accepted but never returned. |
| `POST /admin/config/test` | Synthesizes a sentence and transcribes it back, with timings. |
| `GET` or `PATCH /admin/voices` | Telling voices apart: the settings (`enabled`, `knownAt`, `guestBelow`, `unsure`, `guests`, `guestAgent`, `guestNote`, `declineText`), the voiceprint service and whether it answers, the voices taught with their recordings, and spoken turns of the last ten minutes with whose voice each was taken for. |
| `POST /admin/voices` | Body `{ name }`. Adds a voice to teach. `DELETE /admin/voices/:id` forgets it. |
| `POST /admin/voices/:id/samples` | Teaches a voice: raw 16-bit mono PCM with `?rate=16000`, or `{ turnId }` for a turn heard in the last ten minutes. `DELETE /admin/voices/samples/:id` forgets one. |
| `POST /admin/voices/check` | Raw PCM with `?rate=`. Whose voice it is and the score against each voice taught; nothing is kept. |
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
| `POST /admin/clients/:id/update` | Tells a device to install the current firmware build for its type, on its own (no staged rollout). |
| `POST /admin/updates/rollout` | Body `{ ids? }`. Starts a staged firmware rollout over these boards, or every board on an older build than the shelf's: one first, the rest two at a time once it is proven. Answers with the rollout (id, state, stage, each board's status). 409 while one runs. |
| `GET /admin/updates/rollout` | The current or last rollout, or `null`. |
| `POST /admin/updates/rollout/cancel` | Sends no more updates in the running rollout; boards already updating are still watched. 409 when none runs. |
| `POST /admin/clients/:id/notify-test` | Sends a browser client a test notification, page open or closed. 409 when it has notifications off. |
| `POST /v1/volume` | A client setting its own volume, with its own token: `{volume: 0-100}`. Nothing else can be changed this way. |
| `POST /mcp` | The MCP server (streamable HTTP, JSON answers): `initialize`, `tools/list`, `tools/call`. Needs an agent token as a Bearer token. Hidden under a public name unless switched on. |
| `GET /admin/mcp` | Agent tools: each tool and whether it is on, the agent tokens (never the tokens themselves), and whether MCP answers under the public name. |
| `POST /admin/mcp/tokens` | `{name}`. Makes an agent token and returns it, once. `DELETE /admin/mcp/tokens/:id` revokes one. |
| `PATCH /admin/mcp/tools` | `{tool_name: true or false, ...}`. Switches tools on or off for every agent, by MCP and by the OpenClaw node. |
| `GET /admin/live` | A stream that stays open (server-sent events): `snapshot` with the recent turns, then `turn` each time a turn reaches a stage or ends, and `wake` for each wake word a device reports. Words are memory only. |
| `POST /admin/live/clear` | Deletes, now, the words Axis holds in memory for the admin page: finished live turns and the device sketches. |
| `GET /admin/map` | The system map, read-only: `nodes` (every client with its info: online, state, version, capabilities, `vitals` from its readings and `attention`), `services` (agent, gateway command link, speech recognition and synthesis, voiceprints, Home Assistant: each with its state and, where a turn used it, `lastMs` and `lastAt`), `edges` (`{from, to, kind}`; `axis` is Axis itself), `axis` (version, start time) and `at`. |
| `GET /admin/map/stream` | A stream that stays open (server-sent events) for the map: `snapshot` (as `GET /admin/map`), then `client` with one client's info when it comes online or goes offline (at once), when it reports readings (at most once every 5 s per client, the latest kept) and when one of its turns changes stage; and `turn` (`{key, clientId, stage, startedAt, endedAt?, outcome?}`: listening, transcribing, thinking, speaking, done) with no words; and `wake` (`{contest, at, clientId, client, score, level, outcome}`: score and level 0 to 1, outcome answered, stood_down or ignored) for each device that reported the wake word, without the word; reports within the wake window (`AXIS_WAKE_WINDOW_MS`) plus 300 ms of the first share one `contest`. A comment line every 20 s keeps it open. |
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
npm run build && AXIS_ADMIN_TOKEN=$(openssl rand -hex 24) npm start
npm run browser-check     # drives both pages in headless Chrome, with stub speech unless STT and TTS are set; needs google-chrome, or CHROME=<path to a Chromium browser>
AXIS_ADMIN_TOKEN=... npm run latency-probe   # times real turns through a running Axis
```

Needs Node 24 or newer (the server uses Node's built-in SQLite).
