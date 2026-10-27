# Admin revamp: progress

The new page is at `/admin-next` (local network only, as `/admin`). Built in stages from `ia.md` section 4.1.

| Stage | State | Axis | Commit |
|---|---|---|---|
| 0. Second page, vendored libraries, link from the classic page | done | 0.52.0 | f168da4 |
| 1. Shell: tokens, sign-in, health strip, grouped nav, router, command bar, data layer, themes | done | 0.52.0 | 6f749a3 |
| 2. Devices: All devices, device page and tabs, settings editor, types, Defaults, Add a device | done | 0.53.0 | the commit after 6f749a3 |
| 3. Overview and Activity: dashboard, Live (stream), History (charts) | done | 0.54.0 | the commit after 692ba35 |
| 4. Agent and voice: Who answers, OpenClaw gateway, Tools and MCP, Speech, Voices | done | 0.55.0 | the commit after 44a6cdc |
| 5. The rest (Face, Firmware, Wake words, Apps, Integrations, System) | next | | |
| 6. Switch `/admin` to the new page | | | |

**Next (stage 5):** Face and screen (`#face`), Firmware (`#firmware`, and the type page's "Manage builds in the classic
admin" links), Wake words (`#wakewords`, with the scores Live links to and the wake words poll), Apps, Integrations
(`#integrations`; its read-only gateway card goes, ia.md 1) and System (`#system`, backup, network, clock); point the
remaining `/admin#…` links (backup and Home Assistant in the health strip and attention list) at them; their
browser-check steps.

## How it is built

- `web/admin-next.html` loads `admin-next-theme.js` (sets the theme before drawing), `admin-next.css`, `admin-next.js`.
- `adm-core.js`: the store the 3 s poll fills, `api()`, sign-in (the classic page's token keys), toasts, dialogs
  (`ask()` replaces `confirm()`/`prompt()`), staged edits (`drafts`), helpers, the theme.
- `adm-shell.js`: router (`parseRoute`), sidebar, health strip, attention list, command bar, sign-in, the cards for
  pages not ported yet. `adm-devices.js`: the Devices area. `adm-activity.js`: the Overview, Live (the stream) and History (charts.js). `adm-agent.js`: the Agent and voice pages; each stages its form under the draft entity `page:<name>` (`useForm`, `saveForm` with Undo, the floating save bar), actions run at once. `adm-settings.js`: the settings editor. `adm-tools.js`: face,
  device sketch, glow preview, microphone meter.
- Screenshots with pretend devices: `npm run build && node docs/admin-revamp/shots.mjs [folder] [filter]` (filters
  comma-separated, `^name` for a prefix; `SMALL=1` writes JPEGs at most 900 px wide).
- `scripts/qr-read.mjs` reads a QR code back from its modules; browser-check uses it on the setup string's code.

## Checklist: the audited views of the ported areas

Ids are the `audit.md` section and a running number. "Where" is the new page's place for it.

### 1. The page as a whole

| Id | Item | State | Where |
|---|---|---|---|
| 1-1 | Untrusted text as text, never markup | done | htm text holes only; browser-check "names as text" |
| 1-2 | Sign-in: token field, Remember (localStorage) or this tab only (sessionStorage), kept in one place | done | sign-in form (`signIn`) |
| 1-3 | 503 "admin API is off", 401 "not accepted", a later 401 signs out | done | `signIn`, `api()` |
| 1-4 | Sign-in shows the face | done | sign-in |
| 1-5 | One sign-in for both pages (same keys) | done | browser-check "one sign-in for both" |
| 1-6 | Header: menu button on phones, brand face, page name on phones, health summary, Sign out | done | header; Sign out also in the command bar |
| 1-7 | Health: agent, recognition, synthesis, devices online | done | health strip, plus updates waiting, backup, Home Assistant, attention count |
| 1-8 | Sidebar foot: Axis version, commit, protocol | done | sidebar foot |
| 1-9 | Nav counters: attention, devices online/known, firmware behind | done | sidebar (Overview, All devices, Firmware, types) |
| 1-10 | Nav counters: Live (turns running), OpenClaw (down/setup), Integrations (trouble) | done | Live counts devices mid-turn; OpenClaw gateway shows "setup" (warn) or "down" (bad) as the classic page (`gatewayMark`); Integrations trouble is in the health strip (backup, HA) and the attention count |
| 1-11 | Saving rule: a value equal to the layers below is stored as null | done | `saveDraft`; browser-check "inherited value" |
| 1-12 | Toast "X set to V on W" or "now follows the type/default (V)" | done | `saveDraft` toast (one change), "N changes saved" otherwise, with Undo |
| 1-13 | Never redraw under typing (the classic guards) | done | staged values live in drafts; browser-check types, waits for a poll, checks value and focus |
| 1-14 | Errors next to the action or as a red toast (8 s) | done | red toasts, the save bar's error, notes in cards |
| 1-15 | `confirm()` / `prompt()` | replaced | `ask()` dialogs; the device's name typed for Reset and Remove |

### 2. Routes

| Id | Item | State | Where |
|---|---|---|---|
| 2-1 | `#overview`, unknown, no hash → Overview | done | `parseRoute` |
| 2-2 | `#clients`, `#clients/<id>` | done | All devices, device page |
| 2-3 | `#device/<id>` alias | done (new) | `parseRoute` |
| 2-4 | `#type/<type>`; `#type` → the shared settings | done | type page; `#type` → Defaults |
| 2-5 | `#pair`, `#settings` | done | Add a device, Defaults |
| 2-6 | `#openclaw`, `#agent`, `#tools`, `#speech` (+ new `#voices`); `#firmware`, `#wakewords`, `#face`, `#integrations` | done / card | the first four are pages since stage 4; the last four keep the "still in the classic admin" card until stage 5 |
| 2-7 | Tabs in the address (`#clients/<id>/settings`), `?key=` opens and flashes a row | done (new) | device and type tabs, `SettingsEditor` `focusKey` |
| 2-8 | Scroll to the top on a page change | done | router (not on a tab change) |

### 3.1 Overview → Overview dashboard and Activity › History

| Id | Item | State | Where |
|---|---|---|---|
| 3.1-1 | Range 24 h / 3 d / 7 d, activity cached 10 s, charts dimmed while loading | done | History header (segmented, `aria-pressed`); `useActivity`, `.stale` |
| 3.1-2 | Needs attention, worst first, each to where it is fixed; "all good" | done | Overview, first, with fix buttons (Update for old firmware; offline by the Offline alert); failed turns, unclean stops and drops open History |
| 3.1-3 | Getting started: four steps, the other-agent link, Hide/Close (`axis-admin-started`), gone for good once done on a hub in use | done | Overview card |
| 3.1-4 | Tiles: running for (+ availability), devices online, turns (+ answered · heard), failed (+ interrupted), first sound p50 (+ p95) | done | Overview KPI row (24 h); History's for its range |
| 3.1-5 | Say something: text (1000), Every device / in <place> / each device that can speak or show ("page closed", "offline"), Urgent, result per device, "Type what to say first.", list kept while open | done | Overview card; header button and command bar "Say something…" focus it; Ctrl+Enter sends |
| 3.1-6 | Uptime strips: Axis, services (gateway links only when they matter), each device, availability, links, tooltip | done | History; Overview's Last 24 hours shows Axis, services and devices that were away. Service links open Speech, OpenClaw gateway or Who answers (stage 4) |
| 3.1-7 | Charts: first sound (p50/p95 lines), turns (columns), where the wait goes (parts); empty texts; redrawn on resize | done | History (`Chart`: charts.js drawn to its width, ResizeObserver) |
| 3.1-8 | Recent turns: when, device, kind (+ how it started, speaker), outcome (+ not confirmed heard), five timings; scrolls in its box; Watch live | done | History |
| 3.1-9 | Events with the filter (everything, problems, connections, services, changes by an admin), up to 150, scroll box | done | History; browser-check filters to connections |
| 3.1-10 | (ia 2.1) Devices at a glance: state, name, type, location, firmware with "update", what it is doing | done (new) | Overview device cards and an Add a device card |
| 3.1-11 | (ia 2.1) Now on the Overview with Cancel / Clear / Detach | done (new) | Overview's Now card (`NowList`, shared with Live) |
| 3.1-12 | (P13) Overview long, one column | done (new) | split: Overview dashboard (two columns) and History |

### 3.2 Live → Activity › Live

| Id | Item | State | Where |
|---|---|---|---|
| 3.2-1 | Watching / connecting; Clear now (deletes the words of recent turns, toast) | done | page header; also the command bar "Clear live words now"; browser-check "live cleared" |
| 3.2-2 | Now: attached (Detach), computer in use, agent task (step x of y, bar, named steps, Clear), notification waiting, kept message, device mid-turn or asked (question, choices), timer / task for later (may act or look only, Cancel); empty text | done | Live › Now and the Overview; countdowns tick each second on Axis's clock (`nowSkew`) |
| 3.2-3 | Agent tasks finished (task, ending, last word, took, ended) and the "away" line | done | Live › Tasks finished |
| 3.2-4 | Tool calls: when, tool (Given / Gave back / Refused, kept open across redraws), by, took, outcome; last 40 | done | Live › Tool calls (rows keyed, `details` left uncontrolled) |
| 3.2-5 | Turns: card per turn, stage bars counting up every 200 ms while running, heard/said, error, facts (timings, played, voice verdict); last 30 | done | Live › Turns (the default tab); browser-check types a turn on the web client and sees it |
| 3.2-6 | Wake words heard since opened (when, device, score, loudness, outcome), last 20; Scores by device | done | Live › Wake words; the scores link opens the classic Wake words page until stage 5 |
| 3.2-7 | The stream: `GET /admin/live` with the Bearer header, `event:`/`data:` blocks (snapshot, turn, tool, wake), back after 2 s while shown | done | `openLive` in `adm-activity.js`, open while Live is on screen |
| 3.2-8 | (ia) the four lists as tabs | done (new) | tabs in the address: `#live`, `#live/now`, `/calls`, `/wakes`, `/tasks`, with counts |

### 3.3 Clients → All devices

| Id | Item | State | Where |
|---|---|---|---|
| 3.3-1 | Filter by name, type or location | done | All devices filter (also id) |
| 3.3-2 | Add a device button | done | page header |
| 3.3-3 | Online first, then by name | done | grid and list |
| 3.3-4 | State, name, type (link), location, own settings count, version, last seen | done | list view; cards show state, type, version, location |
| 3.3-5 | Find (when offered and online) | done | card and list row |
| 3.3-6 | Row opens the device; keyboard through the link | done | cards are links; rows hold a link |
| 3.3-7 | Empty: no clients / no match | done | empty card; "No device matches. Clear the filters" |
| 3.3-8 | Narrow: settings/version/last seen hidden | done | `.hide-narrow` |
| 3.3-9 | (P8) firmware-behind mark, state, filters by type/location/online/needs update, Update quick action | done (new) | "update" badge, state dot, filter selects, Update button |

### 3.4 One device → device page

| Id | Item | State | Where |
|---|---|---|---|
| 3.4-1 | Crumb, title, state ("offline, last seen …"), Find | done | header band |
| 3.4-2 | Name, saved, "agents address it by this name" | done | Settings › This device (staged) |
| 3.4-3 | Location with the locations in use offered | done | Settings › This device (datalist) |
| 3.4-4 | Type link, raw type, version, Update to <version> (firmware, or the Quest app for headsets), confirm | done | header band and Overview facts; dialog |
| 3.4-5 | Capability switches, help per capability, "nothing" | done | Settings › Capabilities (staged, saved with the rest) |
| 3.4-6 | Address | done | Overview facts |
| 3.4-7 | Pages (the device's own links) when online with an address | done | Overview facts |
| 3.4-8 | Reaches Axis at + Change | done | Overview facts, dialog |
| 3.4-9 | Web clients: notifications + Send a test | done | Overview facts |
| 3.4-10 | Waiting for it (kept messages) | done | Overview facts |
| 3.4-11 | Id | done | Overview facts |
| 3.4-12 | Sketch: frame by type/size/round/orientation, live face with its settings, question and choices, words (20 s), timer, doing, chips | done | `DeviceSketch` (header, Overview and Settings rails) |
| 3.4-13 | Readings | done | Overview › Readings as labelled facts, raw table folded |
| 3.4-14 | Last 24 hours: online %, connections, turns, first sound, strip, events | done | Overview › Last 24 hours (events folded) |
| 3.4-15 | Actions (disabled offline, confirm when asked), answer shown | done | Overview › Actions |
| 3.4-16 | Announce | done | Announce… dialog (header and Actions) |
| 3.4-17 | Microphone levels: Start/Stop, once a second for 60 s, only while on this device, three bars, old-firmware note | done | Tools tab and Settings rail |
| 3.4-18 | Edge glow: the firmware's drawing, nine kinds, corner curve, glass guide (kept in the browser), size, round boards, Show on the device | done | Tools tab and Settings rail |
| 3.4-19 | Glow curve saved only when changed | done | staged with the page's other changes |
| 3.4-20 | "has N values of its own", link to the type's settings | done | tab badge "N set here", banner layer switcher |
| 3.4-21 | Settings grouped by the schema's groups, built-ins included | done | `SettingsEditor`: groups collapsible and remembered, index on the left, filter |
| 3.4-22 | Editors: toggle, choice/client select, number with unit, text | done | `Editor` |
| 3.4-23 | Where the value comes from | done | source chip; a dot for "changed from the default" |
| 3.4-24 | Use shared / Use default | done | "Use <layer>'s <value>" per row |
| 3.4-25 | Share with type | done | per row; browser-check "share with type" |
| 3.4-26 | Rows set here marked, inherited dimmed | done | `.row.mine`, `.row.follows`; unsaved rows amber |
| 3.4-27 | `location`, `capabilitiesOff` never rows | done | `DEVICE_ONLY` |
| 3.4-28 | Empty: not described yet | done | Settings tab |
| 3.4-29 | Reset / Reset and forget Wi-Fi (firmware devices, online), confirm, back to the list | done | Danger zone, name typed |
| 3.4-30 | Remove, confirm, back to the list | done | Danger zone, name typed |
| 3.4-31 | Unknown id | done | "No such device" |

### 3.5 One type → type page

| Id | Item | State | Where |
|---|---|---|---|
| 3.5-1 | Title, Rename (hidden with no devices) | done | header, dialog |
| 3.5-2 | Raw type, N devices, N online | done | header |
| 3.5-3 | Its devices with state, location, own values | done | Devices tab (cards) |
| 3.5-4 | Run on every online device, confirm, toast with failures | done | Devices tab |
| 3.5-5 | Firmware: version sent, who is behind, Update N devices, Manage builds | done | Firmware tab (builds link to the classic Firmware page until stage 5) |
| 3.5-6 | Settings on the type layer, "differs on <device> (value)", Use shared/default | done | Settings tab |
| 3.5-7 | Empty states | done | |

### 3.6 All devices (global layer) → Defaults for everything

| Id | Item | State | Where |
|---|---|---|---|
| 3.6-1 | Voice and Default client | done | Axis group ("Default device") |
| 3.6-2 | (P3) every Axis built-in, not only two | done (new) | every built-in but location |
| 3.6-3 | Settings several types share, "Used by …" | done | "Shared by N types" group |
| 3.6-4 | Other keys: list, Clear, add a raw key (true/false/numbers parsed) | done | "Other keys" group; Another key card (staged) |

### 3.7 Add a device

| Id | Item | State | Where |
|---|---|---|---|
| 3.7-1 | New pairing code, "works once, for N minutes (until …)" | done | step 1 |
| 3.7-2 | Notices the device that pairs, link to it, toast, code cleared | done | step 1 |
| 3.7-3 | Axis address for devices, kept in this browser, default this host on plain http | done | step 2 |
| 3.7-4 | Setup string `axis://` / `axis+tls://`, Copy (clipboard or select) | done | step 3 |
| 3.7-5 | A new board → flasher; a browser → web client | done | By kind |
| 3.7-6 | Windows: download the desktop app (version, size, or "not built") | done | By kind |
| 3.7-7 | QR code of the setup string, drawn again when the code or address changes | done (new) | step 3; browser-check reads it back with `scripts/qr-read.mjs` |
| 3.7-8 | Mac and Quest apps | done (new) | By kind |

### 3.8 OpenClaw → Agent and voice › OpenClaw gateway (`#openclaw`)

| Id | Item | State | Where |
|---|---|---|---|
| 3.8-1 | Link marks "turns: …", "commands: …" (`LINK_STATES`), "setup code waiting"; the error line | done | The link card (`#gw-pills`, `#gw-note`) |
| 3.8-2 | What Axis relies on: `GET /admin/selfcheck`, Check again (POST), working / off / not working / cannot tell, detail, "Last asked …"; the empty text | done | card with Check again; also the command bar "Check the gateway again"; browser-check "commands listed" |
| 3.8-3 | Gateway address + Save (`PATCH /admin/gateway {url}`) | done (staged) | Address and pairing; saved with the save bar |
| 3.8-4 | Reconnect (`POST /admin/gateway/retry`) | done | page header; also the command bar "Reconnect gateway" (browser-check) |
| 3.8-5 | Setup code + Pair (`POST /admin/gateway/setup-code {code, url?}`), "Paste a setup code first." | done | Address and pairing; browser-check "bad setup code" |
| 3.8-6 | Device id | done | Address and pairing |
| 3.8-7 | Pairing steps, opened once while not paired, with the `vortex.axis.*` commands | done | `#gw-steps` (open on arrival while not both links are up) |
| 3.8-8 | (ia 1, from Tools) OpenClaw progress cards, questions, approvals switches; the scope line | done (moved, staged) | The agent's steps, questions and approvals card; browser-check saves a switch and undoes it |

### 3.9 Agent → Agent and voice › Who answers (`#agent`)

| Id | Item | State | Where |
|---|---|---|---|
| 3.9-1 | Answered by: OpenClaw gateway / another chat endpoint, switching the fields shown | done (staged) | segmented control; browser-check "who answers" |
| 3.9-2 | OpenClaw agent with the list from `GET /admin/gateway/agents`, saved by `PATCH /admin/gateway {agentId}` | done | datalist and the names listed under it |
| 3.9-3 | Note to the agent: built-in shown when none saved, saving the built-in stores nothing, "-" sends none | done | `builtIn()` |
| 3.9-4 | Chat endpoint, Model, Token ("set", empty keeps), System prompt (same built-in rule) | done | endpoint fields; a saved token is never sent back by Undo |
| 3.9-5 | Test this endpoint (`POST /admin/config/test-agent`, nothing saved) | done | browser-check "test the endpoint" |
| 3.9-6 | Save → `PATCH /admin/config {agent}` (+ `PATCH /admin/gateway {agentId}`) | done (staged) | save bar, Undo; browser-check "agent staged save" (with the leave question) |

### 3.10 Agent tools → Agent and voice › Tools and MCP (`#tools`)

| Id | Item | State | Where |
|---|---|---|---|
| 3.10-1 | Switch per tool (`PATCH /admin/mcp/tools`), name, one-line reading, Try | done (staged) | Tools card; browser-check switches admin off, MCP drops it, Undo brings it back |
| 3.10-2 | Try a tool: form from the JSON schema (Send to, enums, booleans, numbers, arrays, any-value), "Sends", Try it (`POST /admin/mcp/tools/try`), reboot/reset asks, required fields checked, result | done | Try a tool card (`tryArgs`); the restart question is a dialog; browser-check "trying a tool" |
| 3.10-3 | Progress cards, questions, approvals switches and the scope line | moved | OpenClaw gateway (3.8-8), as ia.md 1 plans |
| 3.10-4 | Apps the desktop tool may not use + Save (`{desktopBlocked}`) | done (staged) | Apps the desktop tool may not use card |
| 3.10-5 | MCP address + Copy, "Also answer under the public name" (`{mcpPublic}`, disabled without public names), snippet | done | Connect a harness by MCP card (switch staged) |
| 3.10-6 | Tokens: for, made, last used, Revoke (`DELETE`); Make a token (`POST`), shown once with Copy | done | Tokens card; Revoke asks in a dialog; browser-check makes one and uses it |

### 3.11 Speech → Agent and voice › Speech (`#speech`) and Voices (`#voices`)

| Id | Item | State | Where |
|---|---|---|---|
| 3.11-1 | Custom STT (address, model, key "set") and TTS (address, model, key, default voice, PCM sample rate): Save (`PATCH /admin/config {stt, tts}`) | done (staged) | Speech; the rate is checked before saving (browser-check "sample rate refused") |
| 3.11-2 | Test both (`POST /admin/config/test`) | done | Speech; says to save first when service fields are staged; browser-check "speech test" |
| 3.11-3 | Realtime voice (`GET /admin/talk`): hidden unless available, "needs OpenClaw"; Devices use (`voiceMode`), devices set otherwise, Voice from (`voiceProvider`), Try it (`POST /admin/talk/test`) | done (staged) | Speech › Realtime voice; browser-check "realtime voice" |
| 3.11-4 | Voice recognition: Off/On, When unsure (were saved at once), service URL (`{voiceprint}`), Known from, Guest below, A guest's turn with Guest agent / note / said to a guest as fits: Save | done (staged) | Voices; browser-check saves Known from |
| 3.11-5 | Voices: samples ◆/● (forget one), Record 5 s (PCM 16 kHz via `pcm-worklet.js`), Forget; Add a voice; Check my voice 4 s | done | Voices; forgetting asks in a dialog; browser-check adds and forgets one (recording needs a microphone, not driven) |
| 3.11-6 | Heard lately: last 10 min with the verdict, "That was <name>" (`{turnId}`); polled while open, not while recording | done | Voices › Heard lately |
| 3.11-7 | (ia 1) Voices as its own page | done (new) | `#voices` |
| 3.11-8 | Wake-up phrases | n/a | the audit lists none on Speech; wake words are the Wake words page (stage 5) |

### 3.12 Agent and voice, around the pages

| Id | Item | State | Where |
|---|---|---|---|
| 3.12-1 | Health strip Agent / Recognition / Synthesis open the new pages | done | `Health`; browser-check "health links" |
| 3.12-2 | Attention items for the agent, self-check problems, speech, gateway approval open the new pages | done | `attentionItems` |
| 3.12-3 | (ia 1.2) Command bar: Back up now (asks), Check the gateway again, Reconnect gateway | done (new) | `commandItems`; browser-check runs Reconnect gateway |
| 3.12-4 | Leave without saving asks on these pages too | done | `entityOf` → `page:<name>`; browser-check "agent staged save" |

### 5. Storage, polling, keyboard, phone

| Id | Item | State | Where |
|---|---|---|---|
| 5-1 | Keys `axis-admin-token`, `axis-admin-started`, `axis.glassCorner`, `axis.deviceAddress` | done | same keys; new: `axis.theme`, `axis.nav`, `axis.groups`, `axis.devices` |
| 5-2 | 3 s poll, paused while hidden | done | `refresh()` (wake words are not polled until stage 5) |
| 5-3 | Integrations every 60 s for attention | done | `loadSlow()` (also config, self-check, activity) |
| 5-4 | Escape closes the drawer; Enter commits fields | done | Escape also closes dialogs and the command bar |
| 5-5 | Segmented buttons with `aria-pressed` | done (new) | themes, grid/list, glow kinds |
| 5-6 | Phone: drawer with shade, closes on a tap (even of the page showing) and Escape; 16 px fields; buttons ≥ 40 px; safe areas | done | browser-check "phone width" |

### The owner's decisions (2026-10-27)

| Item | State | Where |
|---|---|---|
| A's sidebar with B's page content (group index left, tools right, up to 1360 px) | done | device Settings tab, type and Defaults pages |
| Save button: staged edits, save bar, changed/where-set marks, Undo | done | `adm-settings.js` |
| QR code from a vendored MIT library | done | `web/qr.js` |
| Old firmware is an attention item with Update | done | `attentionItems` |
| Offline alert auto/always/never; auto by kind (boards 15 min, computers and Quest 12 h, browsers never), per device and per type | done | built-in `offlineAlert`, never sent to devices (test in `listening.test.ts`) |
| Dark (default), Light, System; every colour a token; face and charts right in both | done | `admin-next.css` |

**Counts:** 140 audited items in the ported areas (stage 4 added 32: 3.8-1 to 3.8-8, 3.9-1 to 3.9-6, 3.10-1 to 3.10-6,
3.11-1 to 3.11-8, 3.12-1 to 3.12-4; and 1-10 went from partly to done): 136 done (18 of them new), 1 moved as planned
(3.10-3, to 3.8-8), 1 not applicable (3.11-8), 1 replaced as planned (1-15), 1 split between done and the card (2-6:
four pages stay in the classic admin until stage 5). Recording a voice (3.11-5) is ported but not driven by browser-check
(no microphone there).
