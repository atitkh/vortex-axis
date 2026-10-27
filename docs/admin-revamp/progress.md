# Admin revamp: progress

The new page is at `/admin-next` (local network only, as `/admin`). Built in stages from `ia.md` section 4.1.

| Stage | State | Axis | Commit |
|---|---|---|---|
| 0. Second page, vendored libraries, link from the classic page | done | 0.52.0 | f168da4 |
| 1. Shell: tokens, sign-in, health strip, grouped nav, router, command bar, data layer, themes | done | 0.52.0 | 6f749a3 |
| 2. Devices: All devices, device page and tabs, settings editor, types, Defaults, Add a device | done | 0.53.0 | the commit after 6f749a3 |
| 3. Overview and Activity | next | | |
| 4. Agent and voice | | | |
| 5. The rest (Face, Firmware, Wake words, Apps, Integrations, System) | | | |
| 6. Switch `/admin` to the new page | | | |

**Next (stage 3):** port the Overview's Getting started, KPI tiles, Now (timers, questions, tasks, attached conversation
with their buttons), Say something and the 24 h uptime mini-strip; Activity › History (range, uptime strips, the three
charts, recent turns, events with the filter) and Activity › Live (the stream, the four lists, Clear now). Then add their
steps to the "new admin" part of `scripts/browser-check.mjs`, as stage 2 did.

## How it is built

- `web/admin-next.html` loads `admin-next-theme.js` (sets the theme before drawing), `admin-next.css`, `admin-next.js`.
- `adm-core.js`: the store the 3 s poll fills, `api()`, sign-in (the classic page's token keys), toasts, dialogs
  (`ask()` replaces `confirm()`/`prompt()`), staged edits (`drafts`), helpers, the theme.
- `adm-shell.js`: router (`parseRoute`), sidebar, health strip, attention list, command bar, sign-in, the cards for
  pages not ported yet. `adm-devices.js`: the Devices area. `adm-settings.js`: the settings editor. `adm-tools.js`: face,
  device sketch, glow preview, microphone meter.
- Screenshots with pretend devices: `npm run build && node docs/admin-revamp/shots.mjs [folder] [filter]`.
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
| 1-10 | Nav counters: Live (turns running), OpenClaw (down/setup), Integrations (trouble) | partly | the health strip shows the agent link, backup and HA; the Live and OpenClaw counters come with stages 3 and 4 |
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
| 2-6 | `#openclaw`, `#agent`, `#tools`, `#speech`, `#firmware`, `#wakewords`, `#face`, `#integrations`, `#live`, `#activity` | card | "still in the classic admin" card linking `/admin#…` until their stage |
| 2-7 | Tabs in the address (`#clients/<id>/settings`), `?key=` opens and flashes a row | done (new) | device and type tabs, `SettingsEditor` `focusKey` |
| 2-8 | Scroll to the top on a page change | done | router (not on a tab change) |

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

### 5. Storage, polling, keyboard, phone

| Id | Item | State | Where |
|---|---|---|---|
| 5-1 | Keys `axis-admin-token`, `axis.glassCorner`, `axis.deviceAddress` | done | same keys; new: `axis.theme`, `axis.nav`, `axis.groups`, `axis.devices` |
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

**Counts:** 88 audited items in the ported areas: 85 done (12 of them new), 1 partly (1-10), 1 replaced as planned
(1-15), 1 carried by a card to the classic page until its stage (2-6).
