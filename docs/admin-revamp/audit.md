# Admin page revamp, stage 1: audit

Written 2026-10-27 against `main` at `82f3e94` (Axis 0.51.0). Nothing in `web/` or `server/` was changed for this.
Read with: `web/admin.html` (698 lines), `web/admin.js` (3996), `web/admin.css` (801), `web/charts.js`, `web/vortex.js`,
`web/icons.js`, `server/src/http.ts` (1531), `server/src/schema.ts`, the boards' `main.cpp` and the Windows app's
`DesktopCommands.cs` (for which settings and actions devices declare).

References are `file:line` at that commit. "Flag" marks something I could not settle from the code.

Contents: 1. How the page works as a whole · 2. Routes · 3. Every view · 4. API calls · 5. Storage, polling, keyboard,
phone · 6. UX problems with evidence · 7. Where each feature goes in the new layout.

---

## 1. How the page works as a whole

- **One HTML page, one module.** `admin.html` holds every view as a `<section class="view">`; `admin.js` shows one at a
  time (`route()`, admin.js:693). Elements are built by `h()` (admin.js:35), which puts text in as text, never markup
  (a settled rule: untrusted names and replies stay text).
- **Sign-in** (admin.html:13-23, admin.js:129-177): admin token in a password field, "Remember on this device"
  (ticked: `localStorage`; unticked: `sessionStorage`, kept in only one of them, admin.js:160). Sign-in calls
  `GET /admin/status`; 503 means `AXIS_ADMIN_TOKEN` is unset, 401 a wrong token (messages at admin.js:152-155). Any
  later 401 signs out with "That token was not accepted." The sign-in page shows the face (`#signin-face`).
- **Header bar** (admin.html:26-31): menu button (phones only), brand (face canvas `#brand-face` + "VorteX Axis" +
  `#where`, the page name on phones), health summary `#summary` (agent, recognition, synthesis as up/down marks and
  "N of M clients online", admin.js:224-234), Sign out.
- **Sidebar** (admin.html:34-52): Overview, Live, Clients, Add a device; "Settings": All devices + one link per client
  type in use (`#nav-types`, admin.js:1127, name and device count); "Hub": OpenClaw, Agent, Agent tools, Speech,
  Firmware, Wake words, Face, Integrations; footer `#about`: "Axis 0.51.0", commit, "protocol 1" (admin.js:216).
  Counters: `#nav-overview` (attention items, red if any is bad, admin.js:3019), `#nav-live` (turns running,
  admin.js:3297), `#nav-clients` (online/known), `#nav-openclaw` ("down"/"setup", admin.js:254), `#nav-firmware`
  (devices behind, admin.js:2075), `#nav-integrations` (HA not connected + backup trouble, admin.js:3876).
- **Saving.** Two models live side by side (see problem P5):
  - *Saved on change*: every row of a settings table (`saveSetting`, admin.js:1178), capability switches, name and
    location, Face idle looks, tool icon style and sliders, tool switches, OpenClaw mirrors, MCP public, realtime
    voice mode and provider, voiceprint On/Off and When unsure, wake word cutoff and window.
  - *Saved by a button*: Agent, Speech (STT/TTS), Voice recognition form, gateway address, setup code, Integrations
    cards, desktop block list, glow corner curve.
  - A setting saved with the value the layers below already give is stored as `null` (removed), so it keeps following
    the shared value (admin.js:1179). The toast says either "X set to V on W" or "X on W now follows the type/default
    (V)" (admin.js:1184). **Keep this rule.**
- **Redraw guards.** The 3 s poll redraws views, so several guards stop it redrawing under the person:
  `busy(box)` (focus is in an input inside the box, admin.js:116) on device, type, All devices, wake words, tools,
  integrations, voiceprint form; `dataset.drawn` keys (only redraw when data changed) on firmware, type firmware,
  wake words, tools, announce target list, device history; `dataset.dirty` on Integrations once anything is typed
  (admin.js:3811); `recordingNow` while the microphone records (admin.js:399); `gatewayUrlTouched` / `agentTouched`
  (admin.js:236). Any rewrite must keep the behaviour (never lose what is being typed) even if it drops the guards.
- **Errors.** `act(button, noteId, fn)` disables the button, shows a failure in the note next to it or as a red toast
  (8 s; good toasts 3.5 s), and signs out on 401 (admin.js:85, 76). Confirmations use `confirm()`; two inputs use
  `prompt()` (type rename admin.js:2297, device's Axis address admin.js:1531).

## 2. Routes (hash addresses)

`route()` (admin.js:693): splits `location.hash` at "/", first part is the view, the rest (joined by "/" again and
URI-decoded) is the id. Every hash change scrolls to the top (admin.js:726).

| Address | Shows | Notes |
|---|---|---|
| `#overview` | Overview | Also anything unknown, and no hash. Old `#activity` (folded into Overview) lands here on purpose (comment admin.js:696). |
| `#live` | Live | Opens the live stream only while shown (admin.js:721). |
| `#clients` | Clients list | |
| `#clients/<id>` | One device | **The device address is `#clients/<id>`, not `#device/<id>`.** `#device/...` is not a route today: `device` is not in `VIEWS` (admin.js:690), so it falls to Overview. The new router may add `#device/<id>` as an alias, but `#clients/<id>` is what every link, the Live page and old bookmarks use. Ids are `c_` + 10 characters (`newClientId`, server/src/secrets.ts:32), never containing "/". |
| `#type/<type>` | One client type | `#type` alone shows All devices (admin.js:699). Type ids contain dots (`waveshare-amoled-1.8`). |
| `#pair` | Add a device | Also checks for the desktop app (admin.js:719). |
| `#settings` | All devices (the global layer) | |
| `#openclaw`, `#agent`, `#tools`, `#speech`, `#firmware`, `#wakewords`, `#face`, `#integrations` | as named | `#face` starts its canvases and stops them on leaving (admin.js:710). |

In-page links that must keep resolving: `#clients/<id>` (Live turns, recent turns, uptime strips, wake scores, Now,
notifications, attention), `#type/<type>`, `#pair`, `#speech`, `#openclaw`, `#agent`, `#tools`, `#live`,
`#wakewords`, `#settings`, `#firmware`, `#integrations`, `#overview`. External: `/flash/`, `/` (web client).
`scripts/browser-check.mjs` drives the admin by ids (`#device-settings input[data-edit=volume]`, `#type-settings`,
`#device-head`, `#summary`, `#gw-pills`, …, about 160 references): it has to move with the page.

## 3. Every view

For each: what it shows, every control and what it calls, empty and error states, special behaviour.

### 3.1 Overview `#overview` (admin.html:56-114, admin.js:2715-3104)

- **Range** 24 hours / 3 days / 7 days (`#activity-range`) → `GET /admin/activity?hours=24|72|168`, cached 10 s
  (admin.js:2637). Charts dim (`.stale`) while it loads.
- **Needs attention** `#attention` (`attentionItems`, admin.js:2791), worst first, each a link to where it is fixed:
  agent unreachable (→ `#openclaw` or `#agent`), each failing gateway self-check (→ `#openclaw`), STT down, TTS down
  (→ `#speech`), gateway approval waiting, command link down (→ `#openclaw`), each device never connected or offline
  > 10 min (→ `#clients/<id>`), backup failed/overdue (→ `#integrations`), failed turns in the last hour, unclean Axis
  stops in 24 h, ≥ 3 silent device drops in 24 h (→ `#overview`). Empty: "all good · Nothing needs attention."
- **Getting started** `#getting-started` (admin.js:2721): four steps (speech working, an agent answers, a first device,
  say something) with links and an "Use a chat endpoint instead / Use OpenClaw instead" alternative; Hide/Close sets
  `localStorage["axis-admin-started"]`; hides itself for good once all done and > 3 turns.
- **Tiles** (admin.js:3033): Axis running for (+ availability), Devices online (warn if any offline), Turns (+ answered
  · heard to the end), Failed (+ interrupted), Time to first sound p50 (+ p95).
- **Say something** (admin.html:67-77, admin.js:3129-3178): text (max 1000), target select (Every device / Every device
  in <location> / each device that can speak or show, marked "(page closed)" or "(offline)"), Urgent switch, Say it →
  `POST /admin/announce {text, urgent, client|location}`. Result table per device: heard / kept for later / shown /
  not delivered, with a note. Empty text: "Type what to say first." The target list is not redrawn while open.
- **Uptime** strips (admin.js:2664-2696): Axis, each service (gateway links hidden when a chat endpoint answers and
  they were never set up), each device; availability %; links to `#speech`, `#openclaw`, `#clients/<id>`. Tooltip
  `.viz-tip` from charts.js.
- **Charts** (charts.js): time to first sound (line, p50 and p95), Turns (columns, went through / failed), where the wait
  goes (parts bar: recognition, agent's first words, synthesis). Empty: "No spoken replies/turns in this period yet."
  Redrawn on window resize (admin.js:3990).
- **Recent turns** (admin.js:3071): When, Device, Kind (spoken/typed/agent spoke + how it started + speaker), Outcome
  (+ "not confirmed heard"), Spoke, Recognition, Agent, First sound, Total; scrolls in its box. Link "Watch live".
- **Events** with a filter (Everything / Problems only / Connections / Services / Changes by an admin), up to 150, in a
  scroll box (admin.js:2700, 2993).

### 3.2 Live `#live` (admin.html:117-132, admin.js:2828-2982, 3180-3350)

- `#live-state`: watching / connecting. **Clear now** → `POST /admin/live/clear` (deletes words of recent turns from
  memory and from device sketches).
- **Now** (`renderNow`, from `GET /admin/now`): rows for Attached conversation (Detach → `DELETE /admin/attached`),
  Computer in use, Agent task (step x of y, progress bar, named steps with states; Clear → `DELETE /admin/tasks/<id>`),
  Notification waiting, Kept message, each device mid-turn or asked (question and choices), each timer or task for later
  ("may act on a computer"/"look only"; Cancel → `DELETE /admin/timers/<id>`). Empty: "Nothing is running right now…".
- **Agent tasks finished** (`now.tasksEnded`): task, how it ended, last word, took, ended; "Home Assistant says you are
  away…" line.
- **Agent tool calls** (stream): when, tool (expandable Given / Gave back / Refused, kept open across redraws), by,
  took, outcome; last 40.
- **Turns** (stream): a card per turn with stage bars (listening, recognising, agent, speaking) counting up every
  200 ms while running, heard and said words, error, facts (timings, played to the end, voice verdict); last 30.
- **Wake words heard** (stream): when, device, score, loudness, outcome; last 20 since opened. Link "Scores by device".
- Stream: `GET /admin/live` read with `fetch` and the Bearer header, SSE-style blocks `event:`/`data:`; events
  `snapshot`, `turn`, `tool`, `wake`; reconnects after 2 s while the view is open (admin.js:3199-3253).

### 3.3 Clients `#clients` (admin.html:142-149, admin.js:1340-1397)

- Filter by name, type or location (only search on the page). "Add a device" button.
- Table, online first then by name: State, Name, Type (display name, links to `#type/`), Location, Settings ("N own
  values" with the keys as title, or "shared"), Version, Last seen, **Find** (only when the type offers `find` and it is
  online → `POST /admin/clients/<id>/commands/find`). Row click opens the device. Settings/Version/Last seen hidden
  under 720 px.
- Empty: "No clients yet. Add a device to get started." / "No client matches that filter."
- Missing (P8): no firmware-behind mark, no capabilities, no state (listening/speaking), no location grouping.

### 3.4 One device `#clients/<id>` (admin.html:152-199, admin.js:1050-1105, 1399-2024)

Top to bottom, as it is now:

1. **Crumb** "Clients /", title = name, state mark ("online" / "offline, last seen …"), Find button.
2. **Head form** (`#device-head`, admin.js:1493-1565):
   - Name (saved on change, `PATCH /admin/clients/<id> {name}`; toast "Agents address it by this name now").
   - Location (with `#location-list` datalist of locations in use; saved as the device-layer `location` setting).
   - Type link + raw type + "version X" + **Update to <version>** when the hub holds a newer build for the type (or the
     Quest app for `meta-quest`, from `GET /admin/quest`), online only, confirm → `POST /admin/clients/<id>/update`.
   - **Can**: capability switches (admin.js:1418), one per reported capability; off = `PATCH /admin/clients/<id>
     {capabilitiesOff:[…]}` at once; help lists what each off means (`CAPABILITY_OFF`, admin.js:1402: mic, speaker,
     screen, buttons, vibration, sensors, images, image-frames, desktop). "nothing" when none reported.
   - Address (when reported); **Pages** (the device's own web pages from its schema `links`, e.g. its log, only when
     online and it has an address).
   - **Reaches Axis at** + Change (prompt; `POST /admin/clients/<id>/address {address}`; device falls back after 90 s).
   - Web clients: **When its page is closed** (notifications on/off) + Send a test (`POST …/notify-test`).
   - Waiting for it (kept messages count). Id (mono).
3. **Sketch** (`#device-preview`, admin.js:1050): a frame shaped for the device (board, round board when
   `readings.screenRound` = 1, browser window, or a plain disc without a screen), sized by `readings.screenW/H` and
   the way up it stands, the live face in its current state with its idle-look and tool-icon settings, the question
   and choices, last heard/said words (20 s), the nearest running timer; "Listening / Waiting for the agent / Speaking /
   Waiting for an answer / Idle / Offline"; chips microphone / speaker / screen (struck through when missing).
4. **Readings** (all `readings` keys as a raw key/value table, admin.js:1987), e.g. screenW, screenH, screenRound, axis,
   battery… (whatever the device reports).
5. **Last 24 hours** (`GET /admin/activity?hours=24&client=<id>`): tiles Online % (+ connections), Turns, Typical first
   sound; an uptime strip; its events (up to 100).
6. **Actions** (admin.js:1584): one button per action in the type's schema (disabled offline; `confirm` when the action
   says so) → `POST /admin/clients/<id>/commands/<name>`, answer shown as "Label: done · key: value". The boards offer
   cue, chime, talk, mic, find, edges, motion (their tables in `main.cpp`) plus Diagnostics (`diag`) and Reboot
   (confirm) added by the shared core (firmware/common/src/axis_client.cpp:1189-1197), which also adds the links
   "Device log" (`/logs`) and "Device page" (`/`). `preview` is a serial-console command, not an action. **Announce** field + button for anything with a speaker or
   screen → `POST /admin/clients/<id>/announce {text}` ("played it to the end" / "did not report playing it").
7. **Microphone levels** (only when the type offers `mic`, admin.js:1878-1969): Start/Stop; calls `commands/mic` once a
   second for at most 60 s, only while the page stays on this device; bars for room level, speech starts above, loudest
   since last (dB of full scale, −70…0); older firmware without `level` gets a note.
8. **Edge glow** (only when the schema has `glowCorner` or the screen is round, admin.js:1713-1866): an animated canvas
   computed like the firmware (`glowMap`, 5-6-5 colour steps, ~20 fps), nine glow kinds (Needs you, Question, Done
   flash, Timer, Find, Computer in use, Listening, Thinking, Speaking). Rectangular boards: Glow corner curve slider
   (min/max from the schema, unsaved state tracked, "Save for this device" enabled only when changed → `PATCH
   /admin/settings/device/<id> {glowCorner}`), Glass corner guide slider (preview only, kept in `localStorage
   ["axis.glassCorner"]`), size note. Round boards: no curve, dims outside the circle, "W × H, round." Both: **Show on
   the device** → `POST /admin/clients/<id>/glow {kind, corner}` ("needs newer firmware" when not implemented).
9. **Settings** (admin.js:1618-1660): help line ("has N values of its own (…)" or "uses the shared settings", link to
   its type's settings), then the settings table for the device layer, grouped by the schema's `group` (Axis, Quiet
   hours, Screen, Listening, Sound, Home Assistant, Desktop… whatever the type declares plus Axis's built-ins,
   server/src/schema.ts:12-230). Each row: label, key (mono), help; editor (toggle switch, choice/client select,
   number with unit, text); where the value comes from ("this device" in bold, or type / all devices / default / not
   set); **Use shared / Use default** (removes this device's value) and **Share with type** (moves the value to the
   type layer: `PATCH /admin/settings/type/<type>` then `PATCH` device `null`). Rows set here have a 3 px cyan bar
   (admin.css:263); inherited values are dimmed. `location` and `capabilitiesOff` never appear as rows (`DEVICE_ONLY`,
   admin.js:1150). Empty: "This device has not described its settings yet…".
10. **Reset** (only devices that report `readings.axis`, i.e. firmware; online only): Reset this device / Reset and
    forget Wi-Fi → confirm → `POST /admin/clients/<id>/reset {wifi}` → back to `#clients`.
11. **Remove** → confirm → `DELETE /admin/clients/<id>` → back to `#clients`.

Unknown id: title "No such client" (or "Loading" before the first poll), Remove disabled.

### 3.5 One client type `#type/<type>` (admin.html:202-221, admin.js:2295-2407)

- Title = display name; **Rename** (prompt; `PATCH /admin/types/<type> {label}`, empty restores the raw type; hidden
  with no devices). Help: raw type, N devices, N online.
- **Devices** of the type: state, name, location, "own: <labels>" / "all shared"; row opens the device.
- **Run on every online device**: each schema action, confirm, run one after the other, toast with the failures.
- **Firmware**: "Devices are sent version X. <who is behind>" + Update N devices to X (confirm; one
  `POST …/update` per device behind). "Manage builds" → `#firmware`.
- **Settings**: the same table on the type layer (`PATCH /admin/settings/type/<type>`); per row "differs on <device>
  (value)" links for devices with their own value; "Use shared/Use default".
- Empty: "No device of this type is paired." / "No device of this type has described its settings yet."

### 3.6 All devices `#settings` (admin.html:388-404, admin.js:2509-2621)

- Axis settings table on the global layer: Voice (`voice`) and Default client (`defaultClient`, a device picker).
  (Defined in admin.js:2512 as `AXIS_SETTINGS`; note the server's built-ins in schema.ts include more `Axis` keys,
  shown on type and device pages but not here unless more than one type declares them; see P3.)
- "Settings several device types share": every setting declared by more than one type, with "Used by …".
- **Other keys** (details, opened once when any exist): keys on the global layer nothing describes, Clear each; add a
  raw key/value (true/false and numbers parsed) → `PATCH /admin/settings/global`.

### 3.7 Add a device `#pair` (admin.html:342-385, admin.js:2411-2507)

- **New pairing code** → `POST /admin/pairing-codes` → big code, "Works once, for N minutes (until hh:mm). This page
  notices when a device uses it." When a new client appears in the poll: "<name> (<type>) paired. Open it …" + toast,
  code cleared.
- **Axis address for devices** (kept in `localStorage["axis.deviceAddress"]`, default this host when on plain http
  and not localhost); **Setup string** `axis://<address>/<code>` or `axis+tls://` when typed with https, Copy (clipboard
  or select-and-copy fallback).
- A new board → `/flash/` flasher. A browser → `/`. A Windows computer: **Download the desktop app** (`GET
  /admin/desktop` for version and size; `GET /admin/desktop/app` as a blob, saved as `VortexAxisDesktop.exe`;
  disabled with "not built on this hub yet").
- **Flag: there is no QR code anywhere in the admin page.** The brief mentions "pairing codes and QR"; the only QR is
  the gateway's `openclaw qr --setup-code-only` text pasted on the OpenClaw page. The Mac app and Quest app are not
  mentioned on this page.

### 3.8 OpenClaw `#openclaw` (admin.html:407-442, admin.js:236-290, 324-343)

- Link marks: "turns: <state>", "commands: <state>", "setup code waiting" (`LINK_STATES`: connected, connecting,
  waiting for approval, refused, unreachable, not paired). Error line.
- **What Axis relies on** + Check again: `GET /admin/selfcheck` (POST to ask again); table label / working, off, not
  working, cannot tell / detail; "Last asked …". Empty: "Nothing to ask: Axis is not connected to an OpenClaw gateway
  as its agent."
- Gateway address + Save (`PATCH /admin/gateway {url}`) + Reconnect (`POST /admin/gateway/retry`). Setup code textarea
  + Pair (`POST /admin/gateway/setup-code {code, url?}`). Device id. **Pairing steps** (opened once while not paired),
  with the `vortex.axis.*` commands to allow.

### 3.9 Agent `#agent` (admin.html:445-487, admin.js:292-322, 636-685)

- Answered by: OpenClaw gateway / another OpenAI-style chat endpoint (switches which fields show).
- Gateway: OpenClaw agent (datalist from `GET /admin/gateway/agents`; saved by `PATCH /admin/gateway {agentId}`), Note to
  the agent (shows the built-in note when none saved; saving the built-in text stores nothing; "-" sends none).
- Endpoint: Chat endpoint, Model, Token ("(set)", empty keeps), System prompt (same built-in rule), **Test this
  endpoint** (`POST /admin/config/test-agent`, nothing saved).
- Save → `PATCH /admin/config {agent:{…}}` (+ `PATCH /admin/gateway {agentId}` for the gateway).

### 3.10 Agent tools `#tools` (admin.html:490-563, admin.js:3433-3737) — from `GET /admin/mcp`

- **Tools**: switch per tool (`PATCH /admin/mcp/tools {name: bool}`), name, one-line reading (`TOOL_READS`), Try.
- **Try a tool**: tool select, form drawn from the tool's JSON schema (Send to: device/location/everywhere; enums,
  booleans, numbers, arrays one per line, any-value fields), "Sends {json}", Try it → `POST /admin/mcp/tools/try`
  (confirm for admin reboot/reset; required fields checked); result in a `<pre>`.
- **OpenClaw progress cards** switch, **questions and approvals** switches (`PATCH /admin/integrations
  {mirrorCards|mirrorQuestions|mirrorApprovals}`), scope state line (missing scopes → how to pair again).
- **Apps the desktop tool may not use** + Save (`PATCH /admin/integrations {desktopBlocked}`).
- **Connect a harness by MCP**: address + Copy, "Also answer under the public name" switch (`{mcpPublic}`; disabled
  without public names), settings snippet to paste.
- **Tokens**: table (for, made, last used, Revoke → `DELETE /admin/mcp/tokens/<id>`), Make a token (`POST
  /admin/mcp/tokens {name}`), shown once with Copy.

### 3.11 Speech `#speech` (admin.html:566-689, admin.js:345-634)

- **Custom STT** (address, model, key "(set)"), **Custom TTS** (address, model, key, default voice, PCM sample rate):
  Save (`PATCH /admin/config {stt, tts}`), Test both (`POST /admin/config/test`: first audio ms, seconds, what was heard).
- **Realtime voice** (`GET /admin/talk`; hidden unless available, "needs OpenClaw"): Devices use Custom STT/TTS /
  Realtime voice (global `voiceMode` via `PATCH /admin/settings/global`), devices set otherwise listed; Voice from
  (global `voiceProvider`), Try it (`POST /admin/talk/test {provider}`).
- **Voice recognition** (`GET /admin/voices`): Off/On and When unsure (saved at once, `PATCH /admin/voices`);
  service URL (`PATCH /admin/config {voiceprint}`), Known from, Guest below, A guest's turn (label / guest conversation
  / another agent / turned away, with Guest agent, guest note, said to a guest shown as fits): Save.
  **Voices**: per voice samples (◆ from a device, ● recorded here, click to forget → `DELETE
  /admin/voices/samples/<id>`), Record 5 s (browser microphone, PCM 16 kHz via `pcm-worklet.js` → `POST
  /admin/voices/<id>/samples?rate=`), Forget (`DELETE /admin/voices/<id>`); Add a voice (`POST /admin/voices`); Check my
  voice 4 s (`POST /admin/voices/check?rate=`). **Heard lately**: turns of the last 10 min with the verdict and "That
  was <name>" buttons (`POST /admin/voices/<id>/samples {turnId}`). Microphone needs https or localhost.

### 3.12 Firmware `#firmware` (admin.html:224-248, admin.js:2026-2158, 2272-2293)

- **Add a build**: client type (free text + datalist of types in use and on the shelf), version, `.bin` file, Upload
  (`POST /admin/firmware/<type>?version=` raw body; becomes the current build).
- Per type: name + raw type, "Devices: name version (offline/behind) …"; builds table: Version, Size, Uploaded,
  Checksum (md5, 10 chars), "sent to devices"; Send this one (`PUT …/<version>/current`), Download (blob), Remove
  (confirm, `DELETE …/<version>`); Update N devices (as on the type page). Empty: "No devices are paired and no builds
  are held yet." / "No builds held for this type."
- Not on the page but in the API: factory image upload (`POST /admin/firmware/<type>?part=factory`, used by scripts),
  deleting a whole shelf (`DELETE /admin/firmware/<type>`).

### 3.13 Wake words `#wakewords` (admin.html:296-339, admin.js:2160-2270, 3352-3431)

- Table: the firmware's own (built-in, who listens with it) + each stored word: phrase, id ("name in settings"),
  Cutoff % and Window (numbers saved on change, `PATCH /admin/wakewords/<id>`), size, listening with it, Download,
  Remove (confirm). Hint: choose one with the **Wake word** setting (all devices, a type or a device).
- **What devices heard** (24 h / 7 days, `GET /admin/wakes?hours=`): per device and word: heard, answered, lowest,
  typical, highest, a strip of every score from 50 to 100 % with the stored cutoff, last; legend.
- **Add a wake word**: model `.tflite`, optional manifest `.json` (fills phrase, cutoff, window; warns on a feature step
  other than 10 ms), phrase, cutoff, window, Add (`POST /admin/wakewords?name&cutoff&window`).

### 3.14 Face `#face` (admin.html:251-293, admin.js:767-1030)

- Big face (300 px) with name, reading, the 13 numbers of the look and units, a Voice level slider for listening and
  speaking looks.
- **Idle looks**: 14 tiles, each with "in the idle looks" tick → global `idleLooksOff` (one look must stay on).
- **State looks**: setup, offline, listening, thinking, speaking, error, compacting, retrying.
- **Tool icons**: style Dot shapes / Line at the core / Off (global `toolIcons`), Time to form 150-3000 ms
  (`toolIconMs`), Dots in the shape 12-78 (`toolIconDots`), Play it again; 13 icon tiles (search, web, home, calendar,
  list, files, code, timer, message, memory, image, computer, tool). Sliders show while dragged, save on release.
- Canvases run only while the page is open.

### 3.15 Integrations `#integrations` (admin.html:135-139, admin.js:3739-3977) — from `GET /admin/integrations`

Cards, each a heading with a state mark, rows, help, and a Save that sends what was typed:
- **Home Assistant** (MQTT host, port, user, password (never shown), discovery prefix; connected since / last error;
  devices published).
- **Live activities on phones** (only when offered; needs HA connected): switch, blueprint import link and address,
  showing now, last passed on; Send a test (`POST /admin/integrations/live-test`).
- **Public address** (public host names, trusted proxies).
- **Clock and keeping** (time zone with a datalist of every zone, history kept days, messages kept minutes).
- **Notifications to browsers** (which browsers have them; read only).
- **Backup** (state, copy every N hours, daily copies kept, folder, last run, duration and size or error; Back up now
  → `POST /admin/backup`; setup hint when not configured).
- **OpenClaw gateway** (read only: address, turn link, command link; link to `#openclaw`).

### 3.16 Things the page does not do (so nothing is lost by not porting them)

No QR code, no light theme, no keyboard shortcuts besides Escape (closes the drawer) and Enter (commits a field,
sends an announce), no search beyond the Clients filter, no undo, no per-setting "changed from default" mark (only "set
on this layer"), no timers view outside Live, no Mac or Quest app download (the Quest app's version is only read for a
headset's Update button).

## 4. API calls the page makes

All with `authorization: Bearer <token>`; JSON unless said. Server: `server/src/http.ts` from line 743 (`/admin/*`
answers 404 under a public name and needs the admin token).

| Method + path | From | http.ts |
|---|---|---|
| GET `/admin/status` | sign-in, poll | 1295 |
| GET `/admin/gateway` · PATCH `{url}` `{agentId}` · POST `/retry` · POST `/setup-code` · GET `/agents` | poll, OpenClaw, Agent, Speech | 1452-1494 |
| GET `/admin/clients` (clients + type schemas) | poll | 751 |
| PATCH `/admin/clients/<id>` `{name}` `{capabilitiesOff}` · DELETE | device | 801-827 |
| POST `/admin/clients/<id>/commands/<action>` | device actions, Find, mic panel, type actions | 757 |
| POST `/admin/clients/<id>/glow` `{kind, corner}` | glow preview | 769 |
| POST `/admin/clients/<id>/announce` `{text}` | device | 788 |
| POST `/admin/clients/<id>/address` · `/notify-test` · `/reset {wifi}` · `/update` | device | 1029, 999, 1011, 1053 |
| PATCH `/admin/types/<type>` `{label}` | type | 829 |
| GET `/admin/settings/global` · PATCH `/admin/settings/global|type/<t>|device/<id>` `{values}` | poll, every settings table, Face, Speech | 1505-1516 |
| GET `/admin/now` | poll | 1254 |
| DELETE `/admin/attached` · `/admin/tasks/<id>` · `/admin/timers/<id>` | Live | 1283-1293 |
| GET `/admin/firmware` · POST `/<type>?version=` (raw) · GET `/<type>/<v>` · PUT `/<type>/<v>/current` · DELETE `/<type>/<v>` | poll, Firmware | 938-998 |
| GET `/admin/wakewords` · POST `?name&cutoff&window` (raw) · GET/PATCH/DELETE `/<id>` | poll, Wake words | 841-912 |
| GET `/admin/wakes?hours=` | Wake words | 1203 |
| GET `/admin/quest` | poll | 932 |
| GET `/admin/desktop` · GET `/admin/desktop/app` | Add a device | 914 |
| POST `/admin/pairing-codes` | Add a device | 748 |
| GET `/admin/config` · PATCH · POST `/test` · POST `/test-agent` | Agent, Speech | 1423-1450 |
| GET/POST `/admin/selfcheck` | OpenClaw | 1309 |
| GET `/admin/talk` · POST `/admin/talk/test` | Speech | 1314-1352 |
| GET/PATCH `/admin/voices` · POST `/admin/voices` · POST `/check?rate=` (raw PCM) · DELETE `/samples/<id>` · DELETE `/<id>` · POST `/<id>/samples` (raw PCM `?rate=` or `{turnId}`) | Speech | 1355-1420 |
| GET `/admin/activity?hours=&client=` | Overview, device | 1496 |
| POST `/admin/announce` | Overview | 1086 |
| GET `/admin/live` (stream) · POST `/admin/live/clear` | Live | 1109, 1196 |
| GET `/admin/mcp` · PATCH `/tools` · POST `/tools/try` · POST `/tokens` · DELETE `/tokens/<id>` | Agent tools | 1134-1187 |
| GET/PATCH `/admin/integrations` · POST `/live-test` | Integrations, Agent tools | 1213-1252 |
| POST `/admin/backup` | Integrations | 1189 |

In the API but not used by the page: GET `/admin/clients/<id>`, GET `/admin/settings/type/<t>` and `/device/<id>`,
POST `/admin/firmware/<type>?part=factory`, DELETE `/admin/firmware/<type>`.

## 5. Storage, polling, keyboard, phone

- **Browser storage**: `axis-admin-token` (localStorage or sessionStorage), `axis-admin-started`, `axis.glassCorner`,
  `axis.deviceAddress`.
- **Polling**: every 3 s unless the tab is hidden: status, gateway, clients, global layer, now, firmware, wake words,
  Quest app (admin.js:181-213). Activity 10 s cache; Integrations every 60 s in the background (for the attention list
  and the nav count) and every 10 s on its page; tools 10 s; wake scores 10 s; self-check, talk, config on sign-in and
  on their page.
- **Keyboard**: Escape closes the phone drawer; Enter blurs (commits) setting fields, name, location and the announce
  field; tabbing works through native controls; nav links are `<a>`; table rows are clickable `<tr>` with a real link
  inside (keyboard users use the link). Segmented buttons have no `aria-pressed` (flag for the rewrite).
- **Phone (≤ 720 px)**: sticky header with menu button, page name, health wrapping under; sidebar becomes a drawer
  (82 vw, max 280 px) with a shade, closed by a link tap, the shade or Escape; fields 16 px (no zoom on focus); buttons
  ≥ 40 px; tables scroll inside themselves, settings tables stack each row into lines; two tiles a row (one under
  380 px); face page and device sketch go full width; safe-area insets respected.

## 6. UX problems, with evidence

| # | Problem | Evidence |
|---|---|---|
| P1 | **Flat navigation of ~15 peers plus one per type**, daily pages (Overview, Live, Clients) beside set-once pages (Speech, Agent, Firmware), with only two thin uppercase headings. | admin.html:35-51; `.navhead` 11 px `--faint` admin.css:529 |
| P2 | **Settings far from devices.** Type settings sit in the sidebar under "Settings", a device's in the middle of its page; the type page is reached from a small link in a help line. | admin.html:39-41, admin.js:1620-1629 |
| P3 | **Unclear which layer is edited.** Same table on three pages; the only clue is the h2 and a 12 px "this device/this type/all devices" in the source column. "All devices" shows only 2 hand-picked keys + keys declared by more than one type, so e.g. quiet hours for everything are edited… only if two types exist. | admin.js:1280, 2512, 2531-2541 |
| P4 | **Same setting edited in several places without saying so**: `idleLooksOff`, `toolIcons*` (Face page = global layer; also rows in every Screen group), `voiceMode`/`voiceProvider` (Speech page = global; also Axis rows per device), `wakeWord` (Wake words page sends you to Settings), `glowCorner` (glow slider and a settings row). | schema.ts:73-130, admin.js:374, 905, 1716 |
| P5 | **Two save models with no visible state.** Most edits save on change with a toast and no undo; some forms need Save; nothing shows "unsaved" except the glow button's enabled state. A mis-typed number is live on the device at once. | admin.js:1178, 1231, 602, 3770, 1749 |
| P6 | **Weak grouping.** Settings groups are a 12 px grey paragraph above a table (`p.group`); 25+ rows on a board; no collapse. | admin.js:1255, admin.css:217 |
| P7 | **"Changed" is only "set on this layer"** (3 px inset bar, admin.css:263). A value equal to its default but set higher up, or a type value that differs from default, looks the same as untouched. | admin.css:261-263 |
| P8 | **Few at-a-glance signals.** Clients table has no firmware-behind mark, no state, no capability; header health omits gateway links, backup, HA; attention only on Overview. | admin.js:1357-1371, 224-234 |
| P9 | **The device page is one long scroll** of 11 blocks; Settings sits under history, actions, mic and glow; destructive Reset/Remove at the very end after settings with no separation beyond a heading. | admin.html:152-199 |
| P10 | **Readings shown raw** (`screenW 368`) and duplicated in the sketch title. | admin.js:1987-1997 |
| P11 | **Agent set-up spread over four pages**: gateway link (OpenClaw), agent id and note (Agent, saved through the gateway API), mirrors of OpenClaw cards/questions/approvals (Agent tools, saved as integrations), a read-only gateway card (Integrations), realtime voice (Speech). | admin.js:680, 3692-3705, 3968 |
| P12 | **"Integrations" holds hub settings** (public names, time zone, history, backup) that are not integrations. | admin.js:3904-3967 |
| P13 | **Overview is long**: attention, getting started, tiles, Say something, uptime, 3 charts, turns, events in one column. | admin.html:56-114 |
| P14 | **No search or jump** beyond the clients filter. | admin.html:145 |
| P15 | **Native `prompt()`/`confirm()`** for rename, address change and every destructive step: unstyled, blocks the page, cannot explain much. | admin.js:1531, 2297, 2004, 2017, 2140 |
| P16 | **CSS layered on itself**: a second generation of rules overrides the first ("the web client's look", admin.css:498-552), switches re-declared with a comment about the general rules "quietly resizing the switch" (admin.css:724-740); inline styles from JS (admin.js:1436, 1609, 2127, 2203). | admin.css:498, 724 |
| P17 | **Redraw-under-typing handled by ad-hoc guards** (`busy`, `drawn`, `dirty`, `touched`) in ten places; easy to miss in new code. | §1 |
| P18 | **Firmware upload type is free text**; a typo makes a new shelf for a type no device has. | admin.html:232 |

## 7. Where each feature goes (target IA from `ia.md`)

| Feature today | Where now | Where in the new layout |
|---|---|---|
| Attention list, nav count | Overview | Overview, first; count also in the header health strip |
| Getting started | Overview | Overview, top (unchanged rules) |
| Tiles | Overview | Overview, KPI row |
| Say something | Overview | Overview card + command bar "Say…" + device Overview tab (Announce) |
| Uptime strips, charts, recent turns, events + range + filter | Overview | **Activity › History** (`#activity`; old `#activity` link now lands here) with a mini uptime on Overview |
| Live: Now, tasks finished, tool calls, turns, wakes, Clear now | Live | **Activity › Live** (`#live`), the four lists as tabs or columns; "Now" also summarised on Overview |
| Clients table, filter, Find | Clients | **Devices › All devices** (`#clients`): grid or list, filters (type, location, online, needs update), Find and Update quick actions |
| Device head (name, location, type, version/update, capabilities, address, pages, reaches Axis at, notifications, waiting, id) | device | Device **Overview** tab (identity card + sketch); capabilities in **Capabilities** tab |
| Sketch | device | Device header, always visible (right rail on desktop) |
| Readings | device | Device **Overview** tab, as labelled facts (screen size, round, orientation…), raw table folded |
| Last 24 h | device | Device **Overview** tab |
| Actions, Announce | device | Device **Overview** tab "Actions" (destructive ones excluded) |
| Microphone levels | device | Device **Tools** tab ("Glow and mic tools") |
| Edge glow preview, corner curve, glass guide, Show on device | device | Device **Tools** tab; the curve row in Settings links to it |
| Device settings table, Use shared, Share with type | device | Device **Settings** tab, layer banner "Editing: this device", grouped collapsible, staged Save/Undo |
| Reset, Reset + Wi-Fi, Remove | device | Device **Danger zone** tab (red, explained, typed confirmation for Reset) |
| Type page (devices, run on all, firmware, settings, rename) | `#type/<t>` | **Devices › Types › <type>** (`#type/<t>` kept), tabs Devices / Settings (banner "Editing: every <type>") / Firmware |
| All devices (Axis keys, shared keys, other keys, add raw key) | `#settings` | **Devices › Defaults for everything** (`#settings` kept), banner "Editing: everything"; shows *every* Axis built-in, not only two |
| Pairing code, setup string, address, flasher, web client, desktop app | `#pair` | **Devices › Add a device** (`#pair`), as steps by kind of device; QR of the setup string optional (open question) |
| OpenClaw link, self-check, address, setup code, steps | `#openclaw` | **Agent and voice › OpenClaw gateway** (`#openclaw`) + the three OpenClaw mirrors moved here from Tools |
| Agent backend, agent id, note, endpoint, prompt, test | `#agent` | **Agent and voice › Who answers** (`#agent`) |
| Tool switches, Try a tool, desktop block list, MCP address, public, snippet, tokens | `#tools` | **Agent and voice › Tools and MCP** (`#tools`) |
| STT/TTS, test, realtime voice | `#speech` | **Agent and voice › Speech** (`#speech`) |
| Voice recognition, voices, heard lately | `#speech` | **Agent and voice › Voices** (`#voices`; `#speech` shows a link card) |
| Face looks, idle looks, tool icons | `#face` | **Devices › Face and screen** (`#face`), saying plainly "these are settings for everything" with the layer banner |
| Firmware builds, upload, update | `#firmware` | **Hardware › Firmware** (`#firmware`), type picked from a list (with "other…") |
| Wake words, scores, upload | `#wakewords` | **Hardware › Wake words** (`#wakewords`) |
| Desktop/Quest app builds held | pair page / device Update | **Hardware › Apps** (read-only status; download stays on Add a device) |
| Home Assistant, Live activities, Notifications to browsers | Integrations | **Integrations** (`#integrations`) |
| Public address, Clock and keeping, Backup | Integrations | **System** (`#system`, sub-anchors) ; attention item for backup links there |
| Read-only OpenClaw card | Integrations | dropped (duplicate of the OpenClaw page; its state is in the header strip) |
| Version, commit, protocol | sidebar foot | **System › About** and the nav foot |
| Sign out | header | header (account menu) and System |
