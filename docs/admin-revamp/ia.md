# Admin page revamp, stage 1: information architecture, layout system, framework

Companion to `audit.md` (the inventory) and the two mockups (`mockup-a.html`, `mockup-b.html`, rendered to the PNGs in
this folder). Stage 1 only: nothing here is built yet. Same identity as now: black, the idle face's cyan `#6fd4ef`,
the face canvas as the brand mark. Dark only (see 3.4).

## 1. Sitemap

Six sections. The first two pages are what is looked at daily; everything else is set once and visited rarely, so it
sits in groups that can stay closed.

```
Overview                 #overview      attention first, getting started, KPIs, devices at a glance, Say something, Now
Activity
  Live                   #live          now / turns / tool calls / wake words / tasks finished (tabs)
  History                #activity      uptime, charts, recent turns, events (range 24 h · 3 d · 7 d)
Devices
  All devices            #clients       grid or list; filter by type, location, online, needs update; quick Find/Update
    <device>             #clients/<id>[/<tab>]   tabs: Overview · Settings · Tools · Danger zone
  Types                  #type/<type>[/<tab>]    tabs: Devices · Settings · Firmware   (one entry per type in use)
  Defaults for everything  #settings    the global layer: every Axis built-in + shared keys + other keys
  Face and screen        #face          looks, idle looks, tool icons (global-layer settings, said so)
  Add a device           #pair          steps by kind: board, browser, Windows, Mac, Quest
Agent and voice
  Who answers            #agent         gateway or chat endpoint, agent id, note / prompt, test
  OpenClaw gateway       #openclaw      link, self-check, pairing; progress cards, questions, approvals (moved from Tools)
  Tools and MCP          #tools         tool switches, Try a tool, desktop block list, MCP address, tokens
  Speech                 #speech        STT/TTS, test, realtime voice
  Voices                 #voices        voice recognition, taught voices, heard lately (was the bottom half of Speech)
Hardware
  Firmware               #firmware      builds per type, upload (type from a list), update
  Wake words             #wakewords     models, scores, upload
  Apps                   #apps          desktop app and Quest app builds this hub holds (read-only status)
Integrations             #integrations  Home Assistant, Live activities on phones, notifications to browsers
System                   #system        public address and proxies, clock and history kept, backup, about, sign out
```

Why this shape:
- **Daily vs set-once** (audit P1): Overview and Activity at the top; the four set-once sections collapse.
- **Settings next to devices** (P2, P3): types, defaults and the face are all under Devices, so the three layers of
  one setting live in one section, and each page says which layer it edits (2.3).
- **Agent in one place** (P11): everything that decides who answers and what the agent may do is one group; the
  OpenClaw mirrors move from Tools to the OpenClaw page, the read-only gateway card on Integrations goes.
- **Integrations only integrations** (P12): hub housekeeping moves to System.
- **Firmware and wake words are files the hub hands to devices**: Hardware, with the app builds beside them.

### 1.1 Routes, old and new

The new router keeps every old address (audit section 2) working:

| Old | New |
|---|---|
| `#overview`, `#live`, `#clients`, `#pair`, `#settings`, `#openclaw`, `#agent`, `#tools`, `#speech`, `#firmware`, `#wakewords`, `#face`, `#integrations` | same page, now in its group |
| `#clients/<id>` | device page, Overview tab. `#clients/<id>/settings` etc. picks a tab. Ids are `c_` + 10 characters and never hold "/", so the extra segment is safe; a segment that is not a tab name is ignored. |
| `#device/<id>` | (was not a route) alias of `#clients/<id>`, since people say "device" |
| `#type/<type>` | type page, Devices tab; `#type/<type>/settings`, `/firmware`. Type ids hold dots, never "/". |
| `#type` | Defaults for everything (as today) |
| `#activity` (old, folded into Overview long ago) | Activity › History |
| anything unknown | Overview |
| new: `#voices`, `#apps`, `#system`, `#system/backup`, `#system/network`, `#system/clock` | |

A link into a setting: `#clients/<id>/settings?key=volume` (and the same on types and `#settings`) opens the right
tab, expands the group, scrolls to the row and flashes it. The command bar uses this.

### 1.2 Command bar (Ctrl+K, ⌘K, or `/` outside a field)

One field, results grouped, arrows and Enter, Escape closes. Built from what the page already has, no new API:
- **Pages**: every entry in 1.
- **Devices**: by name, type, location, id (from `GET /admin/clients`); Enter opens, Alt+Enter offers Find.
- **Settings**: every setting label and key from the type schemas plus Axis's built-ins, with its group and where it
  can be set ("Volume · Sound · this device / type / everything"); Enter opens the current device's or type's settings
  at that row if one is open, else Defaults.
- **Actions**: New pairing code, Say something…, Back up now, Check the gateway again, Reconnect gateway, Clear live
  words, Find <device>, Update <device>. Actions that change something still ask (2.6) — the bar only gets you there.

### 1.3 Header health strip

Always visible, each mark a link: Agent (gateway turn + command links, or endpoint), Recognition, Synthesis, Devices
"4 / 5 online", Updates "1 behind" (only when any), Backup (only when failing or overdue), Home Assistant (only when set
up and down). Plus the attention count (same list as the Overview) as a badge that opens it. The data is what the 3 s
poll already fetches (`status`, `gateway`, `clients`, `firmware`) and the 60 s integrations read.

## 2. Pages in the new layout

### 2.1 Overview

1. Needs attention (same rules as now, `attentionItems`), each with its fix as a button, problems first; "All good"
   collapses to one line.
2. Getting started (unchanged rules), only on a new hub.
3. KPI row: Axis up for, devices online, turns, failed, time to first sound p50/p95.
4. Devices at a glance: one card per device (state dot, name, type, location, firmware with "update" badge, what it is
   doing now) → device page.
5. Now: timers, questions waiting, tasks running, attached conversation (from `/admin/now`), with the Cancel / Clear /
   Detach buttons.
6. Say something (same form).
7. Uptime mini-strip for the last 24 h → Activity › History.

### 2.2 Device page

Header (always): crumb "Devices / Round board 1.75 / Kitchen", name, state, firmware badge (with Update), Find,
location, the sketch (right rail on desktop). Tabs:
- **Overview**: identity facts (type, version, address, reaches Axis at + Change, pages, notifications + test, kept
  messages, id), readings as labelled facts (raw table folded), last 24 h, actions + Announce.
- **Settings**: the editing banner (2.3), capabilities as the first group ("What Axis uses on this device"), then the
  schema's groups, each collapsible with "N set here · M changed from default"; tools that belong to a group sit beside
  it (glow preview next to Screen's glow rows).
- **Tools**: edge glow preview with corner curve and Show on the device; microphone levels. (The mockups show them in
  the Settings tab's side column as well, since that is where they are used.)
- **Danger zone**: Reset, Reset and forget Wi-Fi, Remove, each explained; Reset and Remove ask for the device's name
  typed in a dialog, not `confirm()`.

### 2.3 Settings editor (device, type, defaults)

- **Banner** at the top of every settings view, sticky: "Editing **this device** — Kitchen. Values here override
  Round board 1.75 and everything." with a layer switcher (This device · Every Round board 1.75 · Everything) that jumps
  to the same group on the other layer. On a type: "Editing **every Round board 1.75** (2 devices, 1 differs)". On
  Defaults: "Editing **everything**".
- **Rows**: label, help, control, then a source chip: `default`, `everything`, `type`, `this device` (cyan, filled when
  set on this layer). A small dot marks "changed from the default" whatever layer set it; the reset button says what
  it goes back to ("Use type's 60 %"). Type pages keep "differs on Desk (35 %)".
- **Saving**: edits are staged. The banner turns into a save bar: "3 unsaved changes · Discard · Save". Save sends one
  `PATCH …/settings/<layer> {values}` with every key (`patchSettings` takes a map, http.ts:386; it validates the whole
  map, so one bad value refuses the lot and the bar must say which), keeping today's rule that a value equal to what
  the layers below give is sent as `null`. After saving, a toast with **Undo** (sends the previous
  values back). Leaving the page with unsaved changes asks first. Capability switches and the glow corner join the same
  bar (capabilities go as their own `PATCH /admin/clients/<id> {capabilitiesOff}`, which the settings route refuses). Fields being edited are never redrawn by the poll (the framework's diffing does this; see 3).
- **Groups** are `<details>` with a summary row: name, counts, chevron. Open state remembered per group in
  `localStorage`. Search within the page filters rows.

### 2.4 Lists and set-once pages

All set-once pages share one layout: page header (title, one-line purpose, status mark, primary action), then cards;
each card is one thing that can be saved, with its own Save and note. Long help moves under an "About this" disclosure
so the controls come first.

## 3. Layout system and tokens

### 3.1 Tokens (from `web/admin.css` `:root`, kept; additions marked +)

```css
/* surfaces */  --bg:#000; --surface:#0b0b0a; --sunk:#111110; --select:#141413; +--raise:#171716;
/* lines */     --line:#262624; --line-strong:#3a3a37;
/* text */      --text:#e9e9e6; --dim:#8d8c86; --faint:#4a4a46;   (+--muted:#b4b3ad, for secondary text on cards)
/* brand */     --accent:#6fd4ef; --on-ink:#00151b; +--accent-soft:rgba(111,212,239,.10); +--accent-line:rgba(111,212,239,.38);
/* states */    --good:#3cf08c; --warn:#f2b84b; --bad:#ff6a5c; +--think:#a98bff (already used for thinking steps)
                +--good-soft/--warn-soft/--bad-soft: the colour at 10 % on black, for badges and banners
/* charts */    --s1:#6fd4ef; --s2:#9e66ff; --s3:#3cf08c; --st-*, --grid  (unchanged)
/* type */      --font: system UI stack (as now); --mono: ui-monospace stack (as now)
                --t-xs 11.5px caps labels · --t-sm 12.5px meta · --t-md 13.5px dense body · --t-base 14.5px (as now)
                · --t-lg 16px card titles · --t-xl 20px page titles · --t-kpi 26px
/* space */     4 px steps: --s-1 4 · --s-2 8 · --s-3 12 · --s-4 16 · --s-5 24 · --s-6 32 · --s-7 48
/* radius */    --r-sm 6 (chips, inputs inside tables) · --r-md 8 (fields, as now) · --r-lg 12 (cards, as now) · --r-pill 999 (buttons, as now)
/* motion */    120 ms for switches and hovers (as now); 180 ms for drawers; none for anything that polls
```

### 3.2 Grid

- Desktop: shell = header 52 px + (A) sidebar 240 px or (B) top bar 52 + section bar 44; content max width 1200 px
  (A) / 1360 px (B), 32 px side padding; 12-column grid with 24 px gutters. A device page is 8 + 4 columns (main + rail).
- Tablet 721-1100 px: the rail drops under the main column; (A) the sidebar becomes the drawer, as on a phone, so
  there is one narrow behaviour, not two.
- Phone ≤ 720 px: one column, the same drawer and menu button as today (keep the safe-area and 16 px field rules,
  audit section 5), tabs scroll sideways, the save bar is fixed to the bottom above the safe area.

### 3.3 Components

App shell · Nav group (collapsible, remembers state, counts) · Command bar · Health strip · Page header (crumb, title,
status, actions) · Tabs (links, so tabs have addresses) · Card (title, state mark, body, footer actions) · KPI tile ·
Status dot + word (the existing `.stat`, round) · Badge (update, own value, experimental) · Chip (capability, source)
· Form row (label + help | control | source chip | reset) · Setting group (`<details>`) · Layer banner / save bar ·
Toast (with Undo) · Dialog (replaces `confirm`/`prompt`; typed confirmation for destructive steps) · Empty state ·
Table (sticky head, scrolls inside on phones) · Device card · Device sketch (today's code) · Segmented control
(`aria-pressed`) · Switch (today's, declared once) · Charts (today's `charts.js`, unchanged).

### 3.4 Light theme?

Not now. The owner has not asked for it, the face tiles, sketches and glow previews must stay black in any theme, and
the chart colours are tuned for black. With every colour a token it would be a contained later change (one more
`:root` block plus a check of the charts), but it is not "trivially cheap": dark only.

## 4. Framework

**Recommendation: Preact with htm, vendored as one ES module file, no build step.** `htm/preact/standalone.module.js`
(MIT, about 13 KB minified, 5 KB gzipped, Preact + hooks + htm's tagged templates) saved as `web/preact.js` with its
version and checksum in a comment; written as plain browser modules like today.

Why not stay as it is: the page is already a hand-made component system (`h()`), but it has no diffing, so every poll
rebuilds DOM and ten guards (`busy`, `dataset.drawn`, `dirty`, `touched`, `recordingNow`: audit P17) keep it from
wiping what someone is typing. Staged edits with Save/Undo (2.3) add per-page state the current pattern has nowhere
to keep. Keyed diffing removes the guards and makes staged state ordinary component state.

Why this one: no toolchain (the server serves `web/` flat as static files, names must match `^[\w.-]+$`, so the
library is one file in `web/`; CSP `default-src 'self'` is fine, htm uses no `eval`), tiny, `h()` code translates
almost line for line, and `charts.js`, `vortex.js`, `icons.js` keep working (they return or draw into DOM nodes; a
component hands them a ref). Lit was the other candidate: shadow DOM fights one shared stylesheet of tokens, and its
templates are no closer to today's code. A dependency-free mini-renderer would be more code to own for the same thing.

What it changes in the rules: CLAUDE.md says "no framework and no build step … Keep it that way unless asked". The
owner allowed a framework if justified; it stays build-free, and the web client (`index.html`, `client.js`) is not
touched. CLAUDE.md's Stack line would say "admin page: Preact + htm, vendored, no build".

**Migration cost**: `admin.js` (4000 lines) and `admin.css` (800) are rewritten, not edited: about 25 modules
(`admin-*.js`, flat in `web/`) and one new stylesheet; `charts.js`, `vortex.js`, `icons.js`, `pcm-worklet.js` reused as
they are; one line in `server/src/http.ts` for the second page; `scripts/browser-check.mjs` (about 160 admin
selectors) ported in step. Estimate: 6 to 8 focused sessions, most of it the device and settings pages.

### 4.1 Stages (each leaves the admin fully working; the old page keeps shipping until the last)

0. **Second page.** `server/src/http.ts` serves `web/admin-next.html` at `/admin-next` with the same local-only rule as
   `/admin` (+ a test). Vendor `web/preact.js`. A link "Try the new admin" in the old page's sidebar foot.
1. **Shell.** Tokens and base CSS, sign-in (same token keys, so one sign-in serves both pages), header with health
   strip, grouped nav, router with every old route, command bar, the shared data layer (`api()`, the 3 s poll as one
   store). Pages not yet ported show a card "This page is still in the classic admin → open it" linking to `/admin#…`.
2. **Devices.** All devices, device page with tabs (sketch, glow, mic panel ported), the settings editor with banner,
   staged saves and Undo, type pages, Defaults, Add a device. `browser-check` gets the same steps against the new page.
3. **Overview and Activity.** Dashboard, Live (stream), History (charts).
4. **Agent and voice.** Who answers, OpenClaw, Tools and MCP, Speech, Voices.
5. **The rest.** Face and screen, Firmware, Wake words, Apps, Integrations, System.
6. **Switch.** `/admin` serves the new page, the old one moves to `/admin-classic` for one release, `browser-check`
   runs only the new one; the release after, the old files go. Axis minor version bump and CHANGELOG at 0, 2 and 6.

Each stage is a normal Axis release (deploy with `npm run deploy`), so the owner can try the new page beside the old
one from stage 1 on.

## 5. The two directions

- **A: sidebar with collapsible groups + command bar** (`mockup-a.html`). The sidebar of today, organised: two daily
  links, then six groups that remember whether they are open, device names under All devices when there are few,
  search at its top. Content up to 1200 px with a right rail on device pages.
- **B: top bar with section tabs + contextual second bar** (`mockup-b.html`). Six sections across the top, the pages of
  the current section in a second bar, the search in the top bar, content up to 1360 px. Device pages get an in-page
  group index on the left and the tools on the right.

**Pick: A.** It holds 20-odd destinations plus one entry per type and a few devices without scrolling sideways or
hiding them under "More"; the same drawer works on a phone, so desktop and phone share one model; it changes least for
someone who knows the current page. B's wider content is real but the device page does not need it once the settings
are grouped, and B's second bar runs out of room on the Devices section as soon as there are four types. B's in-page
group index is worth taking into A on long settings pages (it fits in A's right rail).
