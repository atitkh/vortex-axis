# VorteX Axis design

This document describes how VorteX Axis is built and why: its architecture, the client protocol, routing, storage, deployment and security, and the features built on top of them. The protocol messages themselves are specified in [`protocol/`](../protocol/README.md).

## 1. Purpose and boundaries

Axis fronts a set of thin clients and presents them to OpenClaw as one node. It owns the connections to OpenClaw, STT and TTS, the client registry, the settings, and the routing of input and output between clients.

Axis is not an agent harness. It holds no conversation history and makes no decisions beyond routing.

The thin-client model follows an earlier, standalone ESP32 voice device that talks to the gateway by itself. That device is a separate project, not an Axis client.

## 2. Architecture

### 2.1 One OpenClaw node

OpenClaw has no sub-device concept: a node is one WebSocket connection with one cryptographic device identity, and capabilities and commands are declared per connection. Axis therefore registers once and takes the target as a parameter on its own commands, for example a location or a client name. Routing lives in Axis.

Consequence: OpenClaw sees only "Axis" as online. Per-client presence is available through an Axis command, not through OpenClaw's node list.

### 2.1.1 Two links to OpenClaw

Axis joins the gateway over its WebSocket with one device identity (an Ed25519 key) and two connections, because a connection carries one role:

- **Operator link:** sends each turn to an agent with the `agent` method and reads the reply from the `agent` event stream, matched by run id. The agent is chosen by name (`AXIS_AGENT_ID`, or at runtime through the admin API); with none chosen, the gateway's default agent answers. A fixed session key puts all clients in one conversation.
- **Node link:** declares the commands in section 6, publishes the tools agents see, reports presence every minute, and carries out commands agents send.

Pairing uses a setup code from `openclaw qr`, given to Axis at runtime. The operator link presents it first and a person approves the device on the gateway. Then the node link asks for its role, which is approved separately unless the gateway granted both at once. The code is kept until both links are connected.

The gateway's OpenAI-style chat endpoint is not used. Axis can still have any OpenAI-style chat endpoint answer turns instead, chosen on the admin page, which is useful for trying other agent harnesses. The node link keeps running either way.

### 2.2 Clients are types with capabilities

A client is described by what it can do: `mic`, `speaker`, `screen`, `buttons`, `vibration`, `sensors`. A client type is a named set of capabilities plus shared defaults, for example "desk speaker" (mic, speaker, screen) or "watch" (screen, buttons, vibration, sensors).

Axis routes on capabilities. A spoken reply needs a speaker. A yes/no question can go to any client with buttons.

An admin can switch off, per device, any of the capabilities it reports (the switches beside "Can" on the device's page; `docs/client-parity.md` section 3). This only removes capabilities: nothing a device does not report can be given to it. Axis keeps what the device reported (`capabilities`, rewritten by every `hello`) apart from what was switched off (`capabilities_off`), and every decision goes by the first less the second. The device is told through a built-in setting, `capabilitiesOff` (names separated by commas, device layer only, set only through `PATCH /admin/clients/:id`), and a client that knows it stops doing what was switched off; one that does not is simply no longer used for it. A question open on a device whose screen is switched off is ended there (`ask.end`) and put to another device that can answer it, for the time it had left. With nothing switched off, the setting is absent.

### 2.3 One conversation

All clients share one OpenClaw session, so a question asked at one client can be followed up from another. Axis gives the agent context in three ways:

- **Session prompt (stable):** what Axis is, that replies may be spoken, and that client tools exist. OpenClaw applies this only when a session is created, so changing it starts a new session; it is therefore kept small and changed rarely.
- **Message header (per turn):** one short line added to each message naming the source client, its location and its capabilities, for example `[from: Desk, type: esp32s3-speaker, location: office, can: mic+speaker+screen]`.
- **Client list tool (on demand):** returns registered clients, which are online and what each can do.

## 3. Client protocol

Each client holds one WebSocket to Axis (over TLS when the address is public), carrying:

- JSON text frames for control: hello, pairing, settings, wake events, turn state, errors.
- Binary frames for audio. Upstream is 16 kHz, 16-bit, mono PCM. Downstream is PCM. There is no compressed audio format yet for clients on mobile data.

Plain HTTP is used only for pairing, health checks and firmware downloads.

The protocol carries its own version number, a single whole number written as "protocol 1" so it cannot be mistaken for a release. It changes only when the messages change in a way old devices could not follow, and Axis keeps accepting the previous version so that updating the server never strands a client that has not been updated.

Every client reports its type and firmware version when it connects.

The message set is specified in [`protocol/`](../protocol/README.md).

### 3.1 Pairing

A new client is given Wi-Fi credentials, the Axis address and a one-time pairing code. Axis exchanges the code for a long-lived token that belongs to that client and can be revoked. After that the client configures itself from Axis.

### 3.2 Wake word arbitration

The wake word runs on the client, offline. When two clients hear it at once:

1. Each client starts recording into a local buffer immediately and sends Axis a wake event with a score (detection confidence and loudness).
2. Axis collects wake events for about 200 ms, grants the best-scoring client and tells the others to stand down.
3. The granted client sends its buffered audio, so speech during the wait is not lost.

If only one client with a microphone is online, Axis grants immediately. Scores tie-break on loudness. Audio that names a wake is accepted only from the client that was granted it.

### 3.3 Interrupting

A tap, a button press or a repeated wake word stops playback. Interrupting by speaking over the reply is not supported: it needs echo cancellation on the client.

### 3.4 Audio out

Replies are synthesized sentence by sentence while the agent is still writing, and each sentence's audio is sent as soon as it exists. The next sentence is synthesized while the one before is still playing, up to one sentence ahead, so it is usually ready when the last ends. Only one synthesis runs at a time: a small speech server shares its processor between requests, and a second request would delay the first sentence's first sound. Between sentences Axis puts a deliberate pause (`sentencePauseMs`, 300 ms by default; half after a comma cut, one and a half at a new paragraph), counting any silence the speech engine already left at the end of the clip, so the rhythm does not depend on how fast synthesis is. A sentence's text goes to a screen as its audio starts. Axis cuts audio into frames no larger than the client asked for and paces them so it is never further ahead of real time than the client's stated buffer (`audioBufferMs`, 2 seconds by default). After the last frame Axis waits for the client to report that playback finished before marking the turn idle.

Only that report counts as "heard". When an agent speaks through Axis, the result says whether the client confirmed playback (`heard`) and whether the words were also put on a screen (`shown`). A client that cannot make sound, such as a browser page nobody has clicked on yet, reports `blocked` straight away, so Axis neither waits nor claims the person heard anything.

## 4. Settings

Axis is the source of truth. Settings have three layers, with the more specific layer winning:

1. Global: wake word, voice, persona.
2. Client type: defaults shared by all clients of that type.
3. Device: volume and location.

Settings carry a version number. It is one counter for the whole hub, raised on any change in any layer. A client asks for anything newer than what it has and keeps its last copy for when Axis is unreachable. A client that is reset gets everything back from Axis.

## 5. Routing

- A reply returns to the client that asked.
- For output the agent starts unprompted, the default is the last client used for input. After a timeout this falls back to a configured default client.
- If the chosen client is offline, Axis falls through to the next client that has the needed capability.
- There is no presence-based routing. Axis uses whatever sensor data clients report.

## 6. Agent command surface

OpenClaw filters node commands through an allowlist, and widening a node's declared commands forces a re-approval. The full surface is therefore declared up front and grouped by permission, not by feature.

The commands:

| Command | Purpose |
| --- | --- |
| `vortex.axis.say` | Speak or show something on a client or at a location. |
| `vortex.axis.ask` | Ask a question with choices and return the answer. |
| `vortex.axis.clients` | List clients, their state and capabilities. |
| `vortex.axis.config` | Read or change a client's settings. |
| `vortex.axis.sense` | How one client or every client is doing: for each, its raw readings, its info (online, state, version, capabilities, vitals, attention) and a one-sentence `summary` meant to be spoken; for every client, also `lowest`, the one most in need (lowest battery not charging, else weakest signal). |
| `vortex.axis.progress` | Show, silently, how long work of the agent's is going. |
| `vortex.axis.diag` | Read diagnostics for Axis or a client. |
| `vortex.axis.session` | Point every device at another of the agent's conversations, and back. |
| `vortex.axis.timer` | Set and manage timers on a client. |
| `vortex.axis.admin` | Reboot, re-pair and similar actions. |

Agents only see a command after Axis publishes it as a tool, so Axis publishes its tool descriptors on every connect. Only commands that work get a tool. All ten have one, and Axis also handles `system.notify` (spoken as a message).

**`vortex.axis.ask`** (`question`, optional `choices` up to six, `timeoutSeconds` 5 to 300, default 30, and a target). Axis speaks the question as agent-initiated speech, then sends `ask`. The client offers the choices and opens its microphone. Three things answer it: a choice picked on a screen (`answer`), something said, or something typed. Axis, not the client, matches spoken or typed words to a choice (`server/src/ask.ts`): a choice named in full, then "the second one", then plain yes and no when those are the choices. Those words never go to the agent as a turn. The result is `{client, answer, said?, how?, timedOut?}`: `answer` is the choice exactly as offered, or null; `said` is the person's own words. Null with `said` set means nothing matched, and the agent decides. With no choices the question is open and `said` is the answer. A client with no screen has the choices read out after the question. The target must have a microphone, or a screen when there are choices. Somebody still talking at the timeout is given up to 30 seconds more. An agent may ask (or say something) in the middle of its own turn on the same client: a turn that is still waiting for the agent's first words does not make the client busy, the question borrows the client, and the turn carries on with the agent's answer afterwards. Once a turn has started speaking, a question waits for it, up to 20 seconds.

**`vortex.axis.timer`** (`action` set, list or cancel). Axis keeps the timers, not the client (`server/src/timers.ts`, table `timers`), so one survives a restart of Axis or of the device. When one is due Axis runs the device's `chime` action if it has one and waits 0.9 seconds for it, and says "Your pasta timer is done." on the timer's own client, or wherever agent speech goes when that client is off. One that cannot be announced is tried again every 15 seconds for 10 minutes, then dropped with a note in the activity log. Every client with a screen is told the next timer with the `command` `timer.next` (on connect and on every change) so it can count down: a timer shows everywhere, but chimes and is announced only where it was set. At most 50 timers, each at most seven days.

**`vortex.axis.progress`** (`action` update, clear or list). For work that takes an agent minutes: it reports a title, a few words on what is happening, steps done of steps in all, and a state (running, blocked when it waits for the person, done). Axis keeps the latest word on each task in memory only (`server/src/progress.ts`): nothing is stored, nothing is spoken, and a restart of Axis forgets them. Every client with a screen is sent the task reported on last with the `command` `progress.show`, on connect and on every change; the admin page lists the tasks under Now on the Live page, where one can be taken off. A finished task stays on show for 90 seconds; one nobody reports on for 30 minutes is taken to be abandoned and removed. At most eight tasks. On the board the line shares the place above the words with a timer, four seconds each. It depends on the agent calling the tool, so it is a courtesy and not a guarantee.

The agent can name the steps (`steps`, twelve at most), and screens draw a bar and list the steps on a press. A task that ends is told to whoever listens (`onEnd` in `progress.ts`): `app.ts` writes it to the `tasks` table, pruned with the rest of the activity, and, while the hub's Home Assistant switch **Away** is on (kept in `meta`), sends a notification to closed browsers that allowed them; the same for a task that starts waiting for the person. Axis has no idea where the person is, so presence stays Home Assistant's to decide. A finish is marked with `chime: true` to each screen once, never in quiet hours.

An OpenClaw agent's own plan is mirrored with no tool call (`server/src/cards.ts`). The gateway broadcasts `progressCard.changed` (`sessionKey`, `revision`; `operator.read` is enough) to Axis's operator link; Axis reads the card with `progressCard.get` and the session with `sessions.list` (its name from `origin.label`, `classification` "cron" or `isBackground` for a scheduled job, `hasActiveRun`), and reports to `Progress.update` under an id made from the session key. A card has only steps, so the state is worked out: all completed is done; steps left with no run active is "blocked", since the agent stopped to ask or was stopped; a run active again is running. Sessions with a task on show are asked every 10 seconds, which is also what keeps a long quiet step from looking abandoned (`Progress.touch`). Scheduled jobs are not shown. A card already finished when Axis first hears of it is not shown. `mirrorCards` in the hub settings switches it off. An agent in such a session should not also call the progress tool, or its work shows twice.

What such an agent waits on the person for is put to them too (`server/src/agentasks.ts`). The gateway announces `question.requested` (a record: `id`, up to three `questions` each with `questionId`, `question`, up to four `options`, `multiSelect`, `isOther`, `isSecret`; `sessionKey`; `expiresAtMs`) to operators holding `operator.questions`, and `exec.approval.requested` / `plugin.approval.requested` (`id`, `request` with the command or the tool, `expiresAtMs`) to those holding `operator.approvals`. Axis asks through `hub.ask`, or a notification while away, and answers with `question.resolve` (`answers: {answers: {questionId: [label]}}`) or `exec.approval.resolve` / `plugin.approval.resolve` (`decision`: `allow-once` or `deny`). `question.resolved` and the approvals' `resolved` take Axis's own question back. An approval is shown and not spoken, never offers `allow-always`, and is allowed only by a tap.

The two scopes go beyond what the device first pairs with. The gateway refuses a request for them made with the operator token (`AUTH_SCOPE_MISMATCH`) and holds no request for anybody to approve; a connection with no credential is refused too (`AUTH_PASSWORD_MISSING`). The gateway's "scope upgrade" request is only raised once a connection has authenticated some other way than by a device token, which for Axis means a setup code. So `GatewayClient.watch` only records what is wanted; `applySetupCode` asks for `operator.read`, `operator.write` and the wanted ones, and the granted set is kept in `meta` (`gateway_operator_scopes`) once that pairing connects. The default setup code (`openclaw qr --setup-code-only --limited`) may carry both scopes. A refusal of the wider set puts the operator link back on the two it had (`onRefused`). Resolving an approval also requires the gateway to allow Axis's device to resolve approvals (`approvalReviewerDeviceIds`).

**Realtime voice (`server/src/talk.ts`).** A second way to answer a spoken turn, chosen with the setting `voiceMode: realtime`: for every device on the admin Speech page, or for one on its own page. It is used only while the agent is an OpenClaw gateway Axis is connected to (`RealtimeTalk.available`); otherwise such a device is answered the usual way. The Speech page lists the gateway's realtime voices (`talk.catalog`) and tries one (`POST /admin/talk/test`, which opens a session, waits for `ready` or `error`, and closes it). The utterance the device sends (16 kHz) is resampled to 24 kHz and appended to a gateway Talk relay session (`talk.session.create` with `mode: realtime`, `transport: gateway-relay`, `brain: agent-consult`; `talk.session.appendAudio` in base64, then 0.9 s of silence so the provider's own end-of-speech detection fires; 0.7 s was not enough for Google's). The relay answers on the operator link with `talk.event`: `ready`, `transcript` (role, text, final), `audio` (base64 PCM16 24 kHz, sent on through the same `Speaker` the local voice uses), `mark` (acknowledged at once with `talk.session.acknowledgeMark`), `audioDone`, `error`, `close`. A `toolCall` named `openclaw_agent_consult` is the model handing work to the agent: the relay client has to get it done and hand the answer back with `talk.session.submitToolResult` (`result: {result: text}`), after which the model says it. Axis has the gateway run it (`talk.client.toolCall` with the relay's session key, `relaySessionId`, `callId` and `args`; `GatewayClient.consult`), which answers with a `runId` whose `agent` events are followed like any turn's; the gateway keeps such a run out of the visible conversation, where the voice's own transcript already stands. An agent that is not behind an OpenClaw gateway is asked with `reply` instead. The voice is sent on as it comes. It arrives in fits and starts, so `Speaker` does not count a gap in the sound as room in the device's buffer. One session per device, closed after three minutes unused; the gateway allows two per connection. `operator.write` covers the `operator.talk` scope these need. The gateway's `talk.catalog` calls a provider "configured" before its credentials have been tried: only opening a session and waiting for `ready` or `error` tells.

**Attaching (`server/src/attach.ts`).** Axis's devices are one way into one agent, and whichever of them hears the wake word answers. So the conversation they are heard in is one setting for the hub, never one per device: two devices that woke together would otherwise talk into two places. `vortex.axis.session` moves it: `attach` finds the conversation by the name a person says (`sessions.list`, titles as the progress mirror makes them, scheduled jobs and Axis's own left out; a name in full wins, several that fit are handed back to ask about), `detach` goes home, `current` and `list` tell. While attached, `GatewayClient.reply` sends the `agent` request with that conversation's whole key and the agent the key names, and the realtime voice opens its session there. The pointer is kept in `meta` and lets go after 30 minutes without a turn.
**The self-check (`server/src/selfcheck.ts`).** Everything in this section rests on methods and events the gateway never promised Axis. The link keeps what the gateway advertises at connect (`hello` `features.methods` and `features.events`); the check compares that with what each feature needs, looks at the granted scopes, and makes one harmless call where there is one (`agents.list`, `sessions.list`, `progressCard.get`, `question.list`, `talk.catalog`). It runs 1.5 s after the operator link connects and on `POST /admin/selfcheck`. A feature that is off is reported as off; one that breaks is noted in the events once, and once more when it works again.

With several tasks, `Progress.list` puts one that waits for the person first and then the one reported on last; screens show the first and count the rest, and are sent the rest as `others` for the list.

**`vortex.axis.admin`** (`action` actions, run, rename or pairing_code). `actions` lists what each device described; `run` carries one of those out and returns what the device reported (never an action the device did not describe); `rename` renames a client; `pairing_code` makes a one-time code for a new device. Removing a client is deliberately not offered to agents: it cannot be undone and stays on the admin page.

Where agent-started output goes: a named client, else a named location, else the client last spoken to (for 10 minutes by default), else the client named in the global `defaultClient` setting, else any client that can speak or show text. A client in a conversation is waited for, up to 20 seconds.

## 7. Failure behavior

- A client that cannot reach Axis has a local response for it, so it fails audibly or visibly.
- When Axis is up but OpenClaw, STT or TTS is down, the client says, shows or indicates which part is down.
- There is no backup voice path.

## 8. Storage

SQLite, one file in one data folder bind-mounted from the host, through Node's built-in `node:sqlite`. It uses a rollback journal instead of write-ahead logging so the folder can live on network storage.

- Stored: clients (name, type, location, last seen), client types and capabilities, the three settings layers and their version, pairing codes, token hashes, Axis's own OpenClaw identity and tokens, and the activity log described below.
- In memory only: who is online, the current output client, the active turn.
- Not stored: audio and conversation history.

### 8.1 Firmware updates over Wi-Fi

- Axis keeps the last five builds of each client type in `<data folder>/firmware/<type>/` (`server/src/firmware.ts`), one of them marked current: that is the one devices are sent. `POST /admin/firmware/:type?version=` with the file as the body adds a build and makes it current; `GET /admin/firmware` lists them; `GET /admin/firmware/:type/:version` downloads one; `PUT /admin/firmware/:type/:version/current` chooses which is sent; `DELETE` removes one build or a whole type. A file that does not start like an ESP32 application image is refused. Going back to an older firmware is: make it current, then update the devices.
- The admin page's Firmware section shows every client type with its builds, which devices are on which version, and does all of the above.
- `POST /admin/clients/:id/update` sends the device the `update` command. The device fetches `GET /v1/firmware/:type` with its own token, so only a paired device of that type can download it.
- The device writes the file to its spare app slot, checks the MD5 Axis gave, and restarts. The new firmware is kept only once it has connected to Axis; if it has not within three minutes, the device restarts into the old one. A failed download or check leaves the running firmware untouched and is reported on the screen and as the reading `updateFailed`.
- `scripts/push-firmware.mjs <type> [--update]` uploads a build and, with `--update`, starts a staged rollout over the boards of that type that are behind. The admin page's Update all (on Firmware and on each client type's Firmware tab) starts the same rollout; the Update button on a device's page updates that one device on its own, without a canary. A device counts as behind only when the current build is newer than the version it reports, compared as dotted numbers (`server/src/versions.ts`, `olderThanHeld`); one on that build or newer, or with a version that is not dotted numbers, is not offered an update and is not listed under attention. Axis decides and hands the admin page `updateAvailable`.
- **Staged rollout** (`server/src/rollout.ts`; routes `POST`/`GET /admin/updates/rollout`, `POST /admin/updates/rollout/cancel`). It runs on the server, so closing the admin page does not stop it, and only one runs at a time (409 for a second). It covers the given boards or every board on an older build than the shelf's; computers, headsets and browsers update themselves and are not part of it. One board goes first, the canary: of those not in a turn, the one with the strongest reported Wi-Fi signal (one with no signal reading comes last). It is sent the update, and the rollout waits until it is proven: connected again after the command, reporting the build it was sent, with readings that arrived on that connection. That is past the point where the firmware keeps the new build. It may take up to 6 minutes, longer than the firmware's 3-minute window. If the canary refuses the command, comes back on another version (rolled back, or the build did not install) or is not proven within 6 minutes, the rollout stops: the boards not yet sent are marked held with the reason, listed under attention (until they are on the build some other way or another rollout starts), and the activity log has the stop. Once the canary is proven the rest follow at most two at a time, each waited on the same way; a failure stops the queue, boards already updated stay, boards already sent are still watched. A board in a turn waits and is tried again on the next look (every 2 s), and is skipped after 15 minutes busy; a board offline when its turn comes is listed as skipped: offline, not as a failure. Cancel sends no more updates. The state is in memory and saved in the `meta` table on every change; at the next start after a restart, a rollout that was running is marked interrupted (boards not yet sent held, boards updating not watched) and is not resumed.
- The admin page shows the current or last rollout (for a day after it ended) on Firmware and on a type's Firmware tab: the stage (the first board, the rest), which board went first and why, each board's from, to, current version and status (waiting, updating, proven, held, skipped, failed) with its detail, why it stopped, and Cancel. It follows the admin page's 3 s poll. While one runs the map's Axis node has a line saying so.
- Not built: building firmware in CI on a tag, signed firmware (the MD5 guards against a broken download, not a hostile one; anyone with the admin token can already do anything).

### 8.2 Encrypted link from devices

A setup string that starts `axis+tls://` makes the device pair, connect and update over TLS (port 443 unless given). It checks Axis's certificate against the certificate authorities the ESP32 core ships with, so the address needs a certificate from a public authority (Let's Encrypt behind a reverse proxy is fine); a self-signed one is refused. The serial command `tlscheck <https://...>` says whether a device can reach and trust an address before it is moved to it. An encrypted connection costs about 45 KB of the board's memory, so the socket is closed while an update downloads.
### 8.2.1 Moving a device to another address

`POST /admin/clients/:id/address {address}` sends a device the `address` command with the new base address for the same Axis (for example its public https name in place of a LAN address). The device first asks the new address for `/healthz`, over TLS with the certificate checked when it is https, and changes nothing if that fails. Then it connects through the new address with the pairing it already has, so it stays the same client with the same settings. It keeps the old address until that connection has been welcomed, and returns to it by itself after a minute and a half otherwise, also across a restart. A device reports the address it uses as the reading `axis`.

`POST /admin/clients/:id/reset {wifi?}` sends the `reset` command, also admin only. The device answers, then clears its pairing, its address for Axis, its synced settings and any stored wake word, and restarts; with `wifi` it forgets the Wi-Fi as well and comes back as its setup network. Its firmware is not touched. Axis removes the client once the device has agreed; a device that refuses (older firmware) is left as it was.

This command, `update`, `wake.model`, `timer.next`, `progress.show`, `ask.waiting` and `glow.show` are for Axis and the admin page only. `vortex.axis.admin` refuses to run them for an agent even if a device lists one among its actions (`ADMIN_ONLY_COMMANDS` in `commands.ts`).

### 8.3 Wake words from Axis

- Axis keeps wake word models in `<data folder>/wakewords/`, one per phrase and with no history (`server/src/wakewords.ts`). Each has an id made from its phrase (`hey-vortex`), a cutoff in percent and a window. `POST /admin/wakewords?name=&cutoff=&window=` with the `.tflite` as the body adds or replaces one; `PATCH` changes the cutoff or window; there are `GET` (list, and download one) and `DELETE`. The admin page's Wake words section does all of it and reads a model's manifest to fill in the fields.
- Which one a device listens with is the `wakeWord` setting, a choice between `built-in` (the model inside its firmware) and the stored ids, set like any other setting for all devices, a type or one device. Axis makes this setting's choices from what is stored.
- Axis sends every client with a microphone the `wake.model` command on connect and whenever a setting or a stored model changes: the id, name, checksum, size, cutoff, window and where to fetch it, or an empty id for the built-in. A device already on that model does nothing. Otherwise it fetches the file with its own token (`GET /v1/wakewords/:id`), checks it, keeps it in its own storage and restarts when nobody is talking to it, because the detector loads its model once at start.
- Safety: the built-in model always remains. A stored model that the detector refuses, or that the device starts with twice without reaching Axis, is set aside until Axis sends another. A client with no wake word of its own answers `ok: false`, which is ignored.
- Models must be microWakeWord streaming models with a 10 ms feature step and the same operations as the built-in one. Axis only checks that a file is TensorFlow Lite; the device finds out whether it can run it.
- Not built: a wake word in the web client.

### 8.4 What is going on now

`GET /admin/now` returns the timers running (label, client, when due) and what each client is in the middle of (listening, waiting for the agent, speaking, or asked a question, with the question). The admin overview draws it as the "Now" table, refreshed with the rest of the page, with a Cancel button per timer (`DELETE /admin/timers/:id`). Nothing here is stored beyond the timers themselves.

### 8.4.1 Device info and the system map

`server/src/deviceinfo.ts` makes one plain object per client from what Axis holds: its record, its resolved settings, its connection, what it is in the middle of, the build Axis holds for its type, and its `sense` readings put into `vitals` (battery, signal, uptime, memory, chip temperature, today's use, mains power, last restart, room sound, and the charger). A reading a client did not send is left out. The charger comes from a board's `chargerState` (the power chip's phase, 0 trickle, 1 pre-charge, 2 constant current, 3 constant voltage, 4 done, 5 stopped), `chargeHeld` (1 while the charge limit holds charging off) and `usbMv` (USB input millivolts), each dropped after five minutes like the other vitals, as one plain line: "charging (constant current)", "charging, tapering", "full", "held at 80% by the charge limit", "not charging". The admin page shows the line with the USB volts ("USB 4.98 V"); the spoken summary says the line only when it explains the battery (held or full) and never the volts. A battery held by the limit is not named the lowest. The same object carries `attention`, short lines such as `battery low (14%)`, `weak Wi-Fi (-75 dBm)`, `old firmware (0.20.1; 0.21.0 is available)` and `offline for 3 hours`. The offline rule (by kind and the `offlineAlert` setting: boards after 15 minutes, computers and headsets after 12 hours, browsers never) is decided here only; the admin page reads a client's `kind` and `offlineAfterMs` from `GET /admin/clients`. The agent's `vortex.axis.sense` and the map both use it.

`GET /admin/map` puts the clients beside the services behind Axis and the links between them; `GET /admin/map/stream` sends what changes, with a client's readings at most every 5 s and turn stages without words (`server/src/mapfeed.ts`). Both are read-only.

### 8.5 Activity log

The activity log (`server/src/activity.ts`) feeds the admin page's overview.

- **Turns:** one row per turn with the device, the kind (spoken, typed, said by an agent), the outcome (answered, no reply, nothing heard, interrupted, failed, with the error), how long the person spoke, and the time taken by recognition, by the agent to its first words, to the first audio sent, and in total. Never the words.
- **Events:** clients connecting and dropping (a dropped ping is told apart from a clean close), each service and gateway link changing state, Axis starting and stopping, settings changes with old and new values, and admin actions (pairing, renaming, removing, saving speech or agent settings, choosing the agent).
- Uptime timelines are drawn from the events with a state. Axis notes once a minute that it is running, so after a crash the time it was down shows.
- Kept for `AXIS_ACTIVITY_DAYS` (7 by default), pruned hourly. Writes are one row per turn or change plus one small write a minute, which is fine on network storage.

## 9. Deployment

- One Docker container and one data folder on the host.
- All host-specific addresses (OpenClaw gateway, STT, TTS) are environment variables. Moving hosts means copying the data folder and the environment file.
- TLS is terminated by a reverse proxy in front of Axis.
- Axis can be reachable on a public domain for portable clients. Only the client endpoint is public; the admin page stays on the local network. The auth is designed for public exposure.

### 9.1 A public address

Axis can sit behind a reverse proxy on a public domain. The rules below keep the admin side private and limit guessing.

- **The admin side is not public.** Host names listed in `AXIS_PUBLIC_HOSTS` get the client side only: the web client, pairing, the client socket and firmware downloads. `/admin`, `/admin-next` (its old address, a redirect to `/admin`) and `/admin/*` answer "not found" under those names, with or without the token. The admin page is reached on the local network or the tailnet. This is checked on the `Host` header and on `X-Forwarded-Host`, which can only ever take access away.
- **Who is asking.** Behind a proxy every connection comes from the proxy. `AXIS_TRUSTED_PROXIES` names the addresses whose `X-Forwarded-For` is believed, so attempt limits count visitors and not the proxy. From anyone else that header is ignored.
- **Admin token.** Ten wrong tokens from one address shut that address out for five minutes, right token or not. Asking with no token at all (the sign-in page) does not count.
- **Pairing codes** are six digits, single use, ten minutes. One address gets ten tries a minute, and thirty wrong codes from anywhere within a code's lifetime throw every unused code away, so guessing across many addresses cannot work a code out. A person then makes a new one.
- **Client tokens** are long random values stored as hashes, one per client, revoked by removing the client. A web client is a paired client like any other: its login is a pairing code from the admin page, entered once per browser. There are no accounts or passwords for clients.
- **Pages** are sent with a content security policy that keeps them to their own files and to Axis, and cannot be framed.
- Deliberately not built: user accounts, single sign-on. If the admin page ever has to be reached from outside the home, do it through the tailnet or put the proxy's own access control in front of it; do not add its host to `AXIS_PUBLIC_HOSTS`.

A caveat for Docker: with the default bridge network, connections published through the host arrive from the bridge's gateway address, so every local visitor looks like one address to the attempt limits, and naming that gateway in `AXIS_TRUSTED_PROXIES` means any local machine could set `X-Forwarded-For`. That only matters for an attacker already on the local network.

### 9.2 Setup and the web pages

Only the admin token comes from the environment. The gateway address and setup code, the agent, and the speech service addresses, models, voice and keys are set on the admin page, stored in the data folder, and applied to the next turn without a restart. Environment values are the starting point and are overridden by anything saved.

The admin page and the web client are plain files served by the hub. The pages hold no secrets: every action goes through the same endpoints, with the same checks, as any other caller. The admin token is kept in the browser tab only.

The web client is a normal client with the capabilities `speaker`, `screen`, `buttons`, and `mic` when the browser allows the microphone (https or localhost only). It has no wake word. It looks and behaves like the board: a black page with the same vortex face (`web/vortex.js`, ported from the firmware), which is also the button: tap to talk, tap to finish, tap to stop a reply. Silence also ends listening. What was heard and the reply appear under the face, and the whole conversation is in a history drawer.

## 10. Firmware

- `firmware/common/` holds the client core. A new device type should mostly describe its hardware.
- Releases are git tags. Each build knows its type and version. Firmware versions (for example `0.11.4`) are counted per device type, separately from Axis's own version, and Axis compares them when it offers an update.
- The first flash is over USB. After that, updates go through Axis over Wi-Fi (section 8.1): Axis holds the builds per type, devices can be updated one at a time, and a device that cannot reconnect after an update rolls back.
- A board keeps up to five Wi-Fi networks, most recently joined first, and joins the strongest saved one in range (`firmware/README.md`, "Saved networks"). Networks are added on the device only (its setup page or serial console); Axis never receives or sends a Wi-Fi password, and sees the network in use and the count as the readings `wifi` and `wifiNetworks`.
- Tagged releases can be built by a Gitea Actions runner.

## 11. Testing

- The web client is the first client and the main way to test Axis end to end.
- A scripted fake client pairs, plays a recorded question and checks that audio comes back. It can run in CI.
- A spare ESP32-S3 board is available for hardware tests.

## 12. Roadmap and known limitations

- **Latency.** There is no target for time to first sound. A measurement with `scripts/latency-probe.mjs` through a live gateway (typed turns, an agent on a local model, speech services on a small board on the same network, median of three) gave first reply text after 2.1 seconds and first audio after 3.2 seconds. A spoken turn adds speech recognition (about 0.15 seconds for a 2 second clip) and the client's wait for silence. The agent is the largest share, then synthesis at about 1.1 to 1.4 seconds to first audio.
- **Barge-in.** Speaking over a reply does not interrupt it (section 3.3).
- **Compressed audio** for clients on mobile data is not supported (section 3).
- **Presence-based routing** is not built (section 5).
- **Backup voice path** when speech services are down is not built (section 7).
- **Firmware delivery:** no CI build on a tag and no signed firmware (section 8.1).
- **Wake word in the web client** is not available (section 8.3).
- **Computer control** is experimental. There is no line about the computer on each spoken turn and no "hands on" glow; the Quest panel client is experimental and cannot use the desktop, clipboard or paste actions.
- **Bangle.js 2:** it has Bluetooth only, so it would need a phone or a relay to reach Axis.

## 13. Notes on the OpenClaw gateway

Behaviour of the OpenClaw gateway (2026.9.4, protocol 4) that a node has to respect:

- `client.id` and `client.mode` are closed enums. A node uses `node-host` and `node`.
- Do not send an `Origin` header, or the gateway treats the connection as a browser session.
- Device tokens are issued per role. The operator and node roles are separate connections with separate tokens.
- Custom command names must be added to `gateway.nodes.commands.allow`. Unknown names are dropped silently.
- `paramsJSON` in an invoke request is a string, not an object.
- Long invokes need progress frames, and nodes must report presence or they show as offline.
- Back off on auth rejections. Retrying a rejected credential on a fixed interval trips rate limiting.
- Read `error.details.code`, not the error message.
- Always pass a limit to `sessions.list`.

Pairing:

- Two roles must not present one setup code at the same moment. While one role's pairing request is waiting for approval, the gateway refuses the same code from the other role as invalid. The operator link pairs first; the node link starts once it is connected.
- Approving a device approves the role it asked for. The node role then arrives as a second request ("asking for a higher role"), which needs its own approval.
- Do not report the platform as `linux`. The gateway takes a Linux node host to be its own headless node: it warns about version drift, and it pins a device family (`Linux`) that the operator link, which sends none, then fails to match ("device identity changed and must be re-approved"). Axis reports the platform `vortex-axis`, which the gateway treats as a plain custom device.
- `node.pluginSurface.refresh` is not a way to refresh tools. It wants a `surface` and fails without one. Publishing tools needs only `node.pluginTools.update`.
- A gateway that is restarting answers connects with `UNAVAILABLE`. That is not a credential failure; retry soon.

## Location, not room

Where a device is, is its `location`, not its room, because a device may be in a car or anywhere else that is not a room. The setting key, the agent tools' target parameter, the client list and the per-turn header (`location: office`) all use `location`. The field was once called `room`; stored values were converted by a migration, and agents may still pass `room` as a target or as the setting name in `vortex.axis.config`, which is accepted. The header and the client list never say `room`.

## System prompt for a chat endpoint

A plain OpenAI-style chat endpoint has no prompt of its own, so Axis sends one as the `system` message ahead of every turn: `DEFAULT_SYSTEM_PROMPT` in `server/src/agent.ts` (voice assistant, short spoken answers, no markdown, how to read the bracketed device line, no tools), or the admin's own text from the Agent page (`agent.systemPrompt` in the runtime settings; empty means the built-in one). The device line stays in the user message because it differs per turn. An OpenClaw agent is never sent this: it has its own prompt, and the gateway link carries only the message.

## Note to an OpenClaw agent

An OpenClaw agent has its own prompt, tools and memory, but nothing in it says that a turn from Axis is spoken or what the bracketed line means. Axis therefore sends a short note as `extraSystemPrompt` on the gateway `agent` request, beside the message, not inside it: `DEFAULT_GATEWAY_NOTE` in `server/src/agent.ts`, or the admin's own text (`agent.gatewayNote`; empty means the built-in one, `-` means none). The note must not change from turn to turn: OpenClaw starts a fresh model process when the system prompt changes, so per-turn facts stay in the bracketed line. A gateway that refuses the field gets the turn again without it, and no note from then on.

## Reaching a client that is not there, and several at once

What an agent wants said goes by whatever route the client has at that moment (`server/src/delivery.ts`):

- **Connected:** spoken and shown.
- **A browser with its page closed** that allowed notifications: a notification through the browser's push service (Web Push; `server/src/push.ts` implements the encryption and the VAPID signature with Node's own crypto, no dependency). `vortex.axis.ask` with choices works too: the notification carries them, as buttons where the system has them, and tapping the notification opens the page with the choices. The answer comes back to `POST /v1/push/answer` with a one-time token from the notification.
- **Otherwise** it is kept for `AXIS_MESSAGE_HOLD_MS` (10 minutes) and said if the client comes back in time. The result says `held: true`, so an agent knows it has not been heard.

`vortex.axis.say` takes `everywhere: true` to speak on every connected client with a speaker, in one `location` or in the whole place, and `urgent: true` to speak through quiet hours.

The web client is installable (manifest, icons, a service worker at `/sw.js` that only shows notifications and never caches). A browser subscribes with `POST /v1/push/subscription`, proving itself with its client token. On an iPhone, notifications are only offered to a page added to the Home Screen.

## Quiet hours

Quiet hours (`server/src/quiet.ts`) are four of Axis's own settings, so they can differ per type or device: `quietFrom`, `quietTo` (times as HH:MM in `AXIS_TIMEZONE`), `quietVolume`, `quietBrightness`. In a client's quiet hours the settings it is sent have volume and brightness capped (Axis sends them again when the stretch begins and ends; no firmware knows about quiet hours), and what an agent says unprompted is shown without sound, or not at all on a client with no screen, unless marked urgent. Replies to a person talking to the device, and timers, always sound.

## Profiles

A profile (`server/src/profiles.ts`) is a named set of overrides on settings that already exist. No firmware or app knows about profiles: a device is sent ordinary values.

- **Precedence:** the device's own setting (through its three layers), then the profile, then quiet hours, which stay the hard cap on volume and brightness. `Hub.effectiveSettings` gives the result; it is what a device is sent and what the admin page shows as in effect.
- **Overrides:** power saver caps `brightness` at 100 and `maxFps` at 15 (a lower value is kept; a choice sent as text stays text); silent sets `volume` 0, `listenCue` 0 and `taskChime` 0. Only keys the device has are touched: a saved value, or a default its own description declares. Dock is normal in every respect but one: it sets `chargeLimit` to the hub's `dockChargeLimit` (System page, 50 to 100, default 80, `AXIS_DOCK_CHARGE_LIMIT`); in every other profile the device's own `chargeLimit` applies. A new Dock charge limit is sent at once to the devices on Dock.
- **Charge limit:** `chargeLimit` is an Axis built-in (group Battery, 50 to 100 in whole numbers, the admin page offers steps of 5, default 100 = no limit), always sent like the listening defaults, so a device leaving Dock is sent its own value again. On USB a board with a power path charges its battery only to the limit and holds it there (the power chip's charger switched off while the board runs from USB), charging again 5 points below, with a 4.1 V charge target as a backstop while a limit is set (never above 4.2 V); on battery nothing changes. The firmware does the holding (the 1.8 since 0.24.0, the round board since 0.8.0): charging is switched on at full target at every start, whenever USB goes away and when the limit is lifted; a client that does not know the key ignores it.
- **Choice and rule:** the `profile` setting (server-only, never sent) is `auto` by default, or a profile chosen by hand, which always wins until it is set back to `auto`. On `auto`, the one rule is the battery: from fresh vitals (readings older than five minutes count as unknown), a device not charging goes to power saver at or below the hub's `powerSaverBelow` (default 20, 0 off) and back to normal at that plus 10, or as soon as it charges. The rule's state is kept in memory and worked out again from the next readings. A change of profile sends the device its settings again and is a client change for the map's stream.
- **Silent by client type:** a board with a screen is sent volume 0 and no cues, and its replies and `say` arrive as text (`reply.text`, no speech), urgent or not; tap to talk still works. A client without a screen keeps messages and hears them once it leaves silent, within the message hold time. A web client or computer changes only what it declares (usually `volume`, if anything) and gets the same text path. Timers do not chime on a silent device. The agent's context line for a turn says the device is silent and to answer in short text.
- **Auto never picks Dock** (nor silent): Dock is a manual choice only, on the Overview's Profile switch, in Settings or by `vortex_axis_config` key `profile`.
- **Reported:** `deviceinfo.ts` carries `profile` and `profileReason` (`manual`, `battery`, `auto`) and the `chargeLimit` in force to `vortex_axis_sense`, the map and the admin page. Dock is worded "Dock: charging held at 80%" in the spoken summary and the admin page's profile line.

## Pictures in replies

Pictures are handled in `server/src/media.ts`. An OpenClaw agent attaches a file to its final reply with a line of its own, `MEDIA:<path or https URL>`; the gateway also streams that line as ordinary text. `GatewayClient.follow` takes such lines out of the stream (`MediaLines`: a line that could still become one is held until it ends; lines inside fenced code are left alone), so they are never spoken or shown, and reports them when the run ends. Axis fetches each one (an https address directly; a path on the gateway's machine through the gateway's `/__openclaw__/assistant-media` route with Axis's operator token, which checks the conversation may read it and returns a short-lived ticket), keeps pictures only (png, jpeg, gif, webp; up to four a reply, 10 MB each) in memory for a day under an unguessable address `/v1/media/<id>` (also served under a public name, since the address is the key), and sends `reply.image` to the client the reply was for when it has the `images` capability. A handed-over run's pictures go with its answer to the client that asked or, failing that, every online client that shows pictures. Boards declare `image-frames`: a board has room for one encrypted connection, so it cannot fetch an address while its socket is open, and agents' pictures are often megabyte PNGs. Axis shrinks each picture to the board's screen as a baseline JPEG (`server/src/fit.ts`, with `pngjs` and `jpeg-js`, the server's first dependencies besides `ws`, pinned; decoding runs in a worker thread stopped after 15 s, pictures over 16 megapixels are refused before decoding, enlarging is capped at 2x, transparency is laid on black) and sends it over the socket as `image.start`, base64 `image.data` frames that fit the client's frame size, and `image.end`. Binary frames stay audio. The board decodes it with JPEGDEC and shows it full screen until 30 s after its speech ends; a tap, a new spoken turn (transcribing) or a question closes it, follow-up listening does not. While something has the whole screen, the board shows listening, thinking and speaking as a glow along the edges in the face's colour for each state (`firmware/waveshare-amoled-1.8/src/glow.cpp`), drawn over the pixels underneath so taking it away restores them. The same glow is a notification light while the board is idle: amber, breathing, while the top task waits for the person, and a green flash when a task turns done; it keeps off the face and hides during a turn (board setting `notifyGlow`). The web client shows the picture under the answer on its main screen as well as in the history.

## Home Assistant

Home Assistant support lives in `server/src/homeassistant.ts` and `server/src/mqtt.ts`. With `AXIS_MQTT_URL` set to the broker Home Assistant uses, every client is published through MQTT discovery as a device with a State sensor (offline, idle, listening, thinking, speaking, asked), an Online binary sensor, a Say notify entity and, where the client has one, a Volume number. The hub is a device with Say everywhere and a count of clients online. Text sent to a Say entity takes the same route as an agent's `say`; a title of "urgent" speaks through quiet hours. A removed client is removed from Home Assistant. The MQTT client is Axis's own small implementation (QoS 0, a retained last will), again with no dependency.

**Boards as sensors.** A client that reports `soundDb` and `soundActive` in its `sense` readings gets a Sound level sensor (dBFS, uncalibrated) and a Sound binary sensor; one that reports `gestures: 1` gets a Gesture event entity, and each `gesture` message it sends (hold, or a swipe in screen directions) is published as an event. These entities use two availability topics (Axis's status and the client's Online) so they read unavailable, not stale, while the board is away. The board measures the room in its microphone task: mean power over 5 s in 2 dB steps, and "sound" when a tenth of a window is well above the room's slow average, held 15 s; blocks while it speaks (and 0.8 s after) are left out. Only levels leave the board, and each part has a board setting to turn it off. Taps are not sent: they stay the board's own (talk, answer).

## The web client as an app, and the admin page

**Web client.** Beside tapping the face, holding it listens for as long as it is held and sends on release; while held, the pauses that end a tapped turn do not. The page keeps the screen on while it is in front (a wake lock, taken again each time the page becomes visible). A running timer is a large countdown with a Cancel button: `timer.next` carries the timer's `id`, and the client cancels with `POST /v1/timers/cancel`. A notification raises a badge on the app's icon; opening the app clears it, and the page asks `GET /v1/push/asks` for what it missed (messages, once, and questions still open), because a phone does not reliably hand the page the notification that opened it.

**Stale pages.** A proxy or a phone may keep scripts and styles for hours whatever headers Axis sends; Cloudflare, for example, rewrites the cache time to four hours. So the server stamps every reference from one web file to another with a hash of all web files (`?v=…`) when it loads them, serves stamped addresses as immutable and everything else as `no-cache`, and offers `GET /v1/web-version`. The web client compares that with its own stamp each time its socket reconnects (which is what an Axis update causes) and reloads when nothing is going on.

**Admin page.** Its dark theme is the web client's: black, the idle face's cyan as the accent, the listening green for "good", charts in the face's colours, the live face in the header and on sign-in. It fills the window. The Face page draws every look with `web/vortex.js` and switches idle looks on and off (`idleLooksOff`). A device's page has a sketch of it beside its details: a frame at the shape the device reports (readings `screenW` and `screenH`, sent by the board through `Client::setReading` and by the web client on connect and resize; `screenRound` 1 draws it as a circle, as the round 1.75 board reports), the face in the state Axis knows, the words it was last sent, a question it is asking and a running timer. The words come from `hub.showing()`, which keeps them in memory for a minute; nothing said is written to disk.

**How the admin page is built.** It is served at `/admin` (`/admin-next`, an older address, redirects there). It uses Preact with htm, vendored as one file (`web/preact.js`), with no build step; the web client does not use it. Settings are edited as staged changes with a save bar and Undo; a value equal to what the layers below give is still stored as nothing. Dark by default, with a light theme and "as the system", chosen per browser; the face, device screens and glow previews stay black in both. Needs attention lists a device on other firmware than the shelf holds for its type (with an Update button), and an offline device only after its **Offline alert** time: `auto` is 15 minutes for a board, 12 hours for a computer or a headset (they sleep), never for a browser (they close all the time); `always` 10 minutes; `never`. The setting is a built-in device setting, so it can be set for everything, a type or a device, and Axis keeps it out of what devices are sent.

**The system map** (`web/adm-map.js`, `#map`) draws `GET /admin/map` as one SVG in fixed columns, without a physics layout: devices on the left grouped by location (Unplaced last), Axis in the middle, the agent, the gateway command link, speech recognition, speech synthesis, voiceprints and Home Assistant on the right, each coloured by state, with the last latency of each service. Under 720 px wide it becomes one column: devices, Axis, then the services. It follows `GET /admin/map/stream` (read with `fetch`, like the Live view, since the admin token travels in a header), redraws at most five times a second, closes the stream while the tab is hidden, and reconnects with a back-off of 1 to 30 s while reading `GET /admin/map` every 10 s; a pill says live, reconnecting or paused. A turn lights its path stage by stage (the device's line, recognition, the agent, synthesis) with each stage's time as the page received it, and fades 2 s after it ends; the line of the current stage has a moving dash, left out under reduced motion. The drawing is symbolic: it shows where a turn is, not traffic. A wake word heard by devices is drawn too: the stream sends each report as `wake` with the device's score and loudness and its outcome, never the word, and Axis gives the reports it settled together one contest id (those within the wake window plus 300 ms of the first, since all of a contest's reports are decided when the window closes). The map shows the latest contest for 6 s after its last report, then fades it over 0.6 s: beside each device that heard it, a score bar and a loudness bar with the outcome; the device that answered outlined and labelled with its margin over the best other score ("won by 0.12", or "won on loudness" when it scored lower but within the margin and was louder), the others dimmed. A single device hearing it shows one pair, answered. Under reduced motion it appears and goes without fading. The live view of one device (`web/adm-twin.js`, which also holds the stream) is the Overview of the device page (`#clients/<id>`): its sketch with the live face, its readings as gauges (only those it reports; a board lists the ones it did not), attention, settings in effect, its last turns from the activity log and its capabilities, above the device's details, actions and history. `#map/<id>`, the device's separate map page in Axis 0.61, opens the device page. Both the map and the Overview are read-only; settings stay under the device page's Settings.

## Watching it work: live turns, wake scores, integrations

**Live view.** `server/src/live.ts` keeps, in memory only, the last thirty turns as they go: each stage a turn reached (listening, recognition, the agent, speaking) and when, its words, and at the end its outcome and timings. `GET /admin/live` holds one request open and sends them as a server-sent event stream (`snapshot` first, then `turn` and `wake`); the admin page reads it with `fetch`, because an `EventSource` cannot send the admin token. The stream is only open while the Live page is. The rule that nothing said is stored still holds: the words exist only in this process's memory and are deleted from it ten minutes after a turn ends (a clock in `app.ts` runs `live.forgetOldWords()`, `hub.forgetScreens()` and `delivery.prune()` every minute, so this does not wait for a restart or for somebody to look). **Clear now** on the Live page (`POST /admin/live/clear`) deletes them at once, with every finished turn and the words kept for the device sketches. The activity log keeps timings only.

**Wake scores.** Every `wake` a device sends is written to the `wakes` table with its score, loudness, the wake word the device was listening with and what came of it (answered, stood down for another device, ignored because a device nearby was speaking). `GET /admin/wakes?hours=` returns them and the Wake words page sums them per device. They are pruned with the activity log. A device only reports a wake that passed its own cutoff, so near misses are not in this table; they are in the device's log. Reporting them to Axis would need a firmware change.

**Announce from the admin page.** `POST /admin/announce {text, client?, location?, urgent?}` goes through `delivery.ts` like an agent's `say`: one client (kept or sent as a notification when it is away), one location, or every client that can speak.

**Hub settings.** The Home Assistant broker (host, port, name, password, discovery prefix), the public names, the trusted proxies, the time zone, the days of history and the minutes a message is kept can be changed on the Integrations page (`PATCH /admin/integrations`, `server/src/hubconfig.ts`). As with speech and agent settings, the environment is the starting point and a saved value wins over it from then on; they are stored in `meta` under `hub_config` and written into the `Config` object, so the next request, the next quiet-hours check and a rebuilt MQTT link use them without a restart. The broker's password is never sent back to the page. The name the page is being used at cannot be made a public name. Backup and browser notifications stay read-only: one is a job on the host, the other is switched on in each browser.

**One page for how it is going.** The Overview holds the activity tiles, strips, events and charts, with a 24 hours / 3 days / 7 days choice. The Now table (timers, questions, devices mid-turn, messages kept for a device that is away) is on the Live page, which is the one place for what is happening this moment.

**Phones.** Below 720 px the admin page is laid out for a phone: the sidebar is a drawer behind a menu button (the bar names the page that is open), fields are 16 px so iOS does not zoom on a tap, buttons are at least 40 px tall, any table that cannot shrink scrolls inside itself, long ids and addresses wrap, and the bar and page edges keep clear of the notch and the home indicator. `npm run browser-check` opens every admin page at 390 px and fails if anything reaches past the screen outside a box that scrolls, or a button is under 32 px tall.

**Now, on the Live page.** Beside devices mid-turn, questions and timers, the Now table lists messages kept for a device that is away (`waiting`) and messages sent to a closed browser as notifications that its page has not shown yet (`notified`), both from `GET /admin/clients`.

**Integrations.** `GET /admin/integrations` reports how the things around Axis stand: the MQTT link to Home Assistant (broker host, never the password), which browsers have notifications on, the public names, the gateway links, and the backup (see "Backup" below).

**Sign-in.** The admin token is kept for the tab (`sessionStorage`) unless "Remember on this device" is ticked, when it goes in `localStorage` until sign-out. The admin page is not served under a public name, so this is a convenience for the administrator's own browsers.

## The web client's history, sound and timer

**History in two halves.** The drawer holds the conversation (what was said to Axis and what it answered) and, marked and timed, what arrived unasked: an **announcement** (anything said on a `say-…` turn: an agent's own message, a timer going off), a **notification** (sent while the page was closed, handed over by `GET /v1/push/asks` as `received` with the time), and a **question** with how it ended: answered and with what, or not answered. A filter shows all, the conversation or the notifications. The conversation lives in the page and goes on a reload. The unasked half is kept in the browser's own storage (`axis-client-inbox`, the last twenty) until Clear is pressed or the pairing is forgotten. Axis keeps none of it.

**Questions that got no answer.** A question put to an open page is marked not answered when it ends with nothing tapped, said or typed. One sent as a notification that ran out of time is kept by `delivery.ts` for the message hold time and handed to the page once as `missed`.

**Volume and mute.** `POST /v1/volume {volume}` lets a client set its own `volume` (its device layer, nothing else), with its own token; the web client's slider uses it, and the value comes back with the settings like any other. The controls stay out of the way: one small speaker mark in the top corner (struck through when muted, one wave when quiet), which opens a slim slider and a Mute button when pressed and closes on a press anywhere else. History is a mark there too (a clock with a turning arrow), and its drawer closes with a cross. Notifications work the same way: a bell beside it (struck through when off) opens the one button that turns them on or off, with a line of explanation when something stands in the way (an iPhone before it is added to the Home Screen, a browser that has them blocked). The footer shows only "Paired as …"; pressing that opens Forget this pairing, which takes a second press within four seconds and no browser dialog. Mute is the browser's alone (`axis-client-muted`): the client answers `speak.start` with `playback: blocked`, the words are shown, and `say` reports `heard: false`. A client that reports `blocked` is not paced or waited for: the rest of the audio is dropped and the turn ends at once instead of waiting out the five seconds allowed for playback to finish.

**Timer.** The countdown is a small chip under the words (label, time, Cancel) in the same hairline pill as the rest of the page, not large accent text.

**Sound on an iPhone.** A page's sound engine there has a state of its own, "interrupted", entered when the page goes to the background, the screen locks, or the microphone is let go; a page added to the Home Screen sometimes cannot be woken from it at all. And only the end of a touch counts as the press that may switch sound on, not its start. So the web client wakes the engine from any state that is not running (not only "suspended"), listens on `pointerup`, `touchend`, `click` and `keydown`, plays one sample of silence inside the press, and if the engine is still not running half a second later it is closed and built again on the next press. The notice follows the engine's state both ways. Known limitation: the phone's silent switch also silences a page's sound without the page knowing, and nothing in the web client can detect that.

## Backup

The backup is part of Axis (`server/src/backup.ts`), not a script run by the host's scheduler: a cron line outside the project would not move with the container, would not be described in the repository, and Axis could only read what it left behind.

The host names a second folder with `AXIS_BACKUP_PATH`; `compose.yaml` mounts it at `/backup` and sets `AXIS_BACKUP_DIR` only when that is given, so with none there is no backup and the admin page says so. Where the folder is has to be the host's decision, since a container writes only where it is let. How often (hours; 0 for only when asked) and how many daily copies are kept are hub settings, changed on the Integrations page like the others and saved over the environment's `AXIS_BACKUP_EVERY_HOURS` and `AXIS_BACKUP_KEEP_DAYS`.

A run copies the database with SQLite's own backup to a file beside it, checks that copy, and only then sends it to the backup folder under a temporary name and moves it into place; it keeps one dated copy a day and mirrors `firmware/` and `wakewords/`. Every call that touches the backup folder is asynchronous: the folder is usually network storage, and a saturated share would otherwise stall the whole server through synchronous writes. The result of the last run is kept in `meta` and shown with a **Back up now** button; a failure, or no copy for well over the interval, goes on the Overview's attention list and, on a change, into the events.

## Tools for any agent: MCP beside the OpenClaw node

Besides offering its tools as an OpenClaw node's commands, Axis is an MCP server, so any harness that speaks the Model Context Protocol gets the same tools. This matters most when an OpenAI-style chat endpoint answers turns: the agent behind it has no other way to reach Axis's tools.

**One list, two doors.** The tools are `NODE_TOOLS` in `commands.ts`, carried out by `createInvokeHandler`. `app.ts` builds that function once, wraps it in `ToolAccess.guard` (`server/src/tools.ts`) and hands the same wrapped function to the gateway link and to the MCP handler (`server/src/mcp.ts`). A new tool is one entry in the list and one case in the function; both doors have it. (The gateway additionally needs a new command name in `gateway.nodes.commands.allow` and the node approved again; that is the gateway's rule.)

**The MCP door.** `POST /mcp`, MCP's streamable HTTP in its plainest form: one JSON-RPC message or a batch in, JSON out, no session and no event stream, since Axis sends nothing unasked. It answers `initialize` (with `instructions` telling an agent what the bracketed line at the top of a turn means and to pass that device as `client`), `ping`, `tools/list`, `tools/call`, and empty `resources/list` and `prompts/list`. A tool that could not do what was asked answers with `isError: true` and the reason as text; only a malformed request is a protocol error. It is written against the specification directly, with no SDK. It is part of the one Axis server and port, not a container of its own, and is there whichever backend answers turns.

**The harness connects itself.** The turns Axis sends an agent (over the gateway or a chat endpoint) carry words only. A harness with a chat endpoint is given Axis's MCP address and a token in its own settings, once, and its agent then calls the tools over that connection while answering a turn. Axis runs no tool loop of its own: a bare model server with no harness around it gets no tools, on purpose (Axis is a bridge).

**Tokens.** An agent token is made on the admin page (Agent tools), shown once, kept as a hash in `agent_tokens`, and revoked there. There is one kind: a token holder may use every tool that is switched on, as the node may. Several can exist, one per harness, so one can be revoked alone. Ten wrong tokens from an address shut it out for five minutes. Under a public name the door does not exist unless `mcpPublic` is switched on (hub setting, `AXIS_MCP_PUBLIC`).

**Tools on and off.** One list on the admin page, kept in `meta` as `tools_off`, for every agent alike. MCP stops listing a tool that is off and refuses a call to it. The node still declares all its commands to the gateway (changing the declared list can cost a re-approval) and Axis refuses the call; `system.notify` follows `vortex_axis_say`.

## Local speech and telling voices apart

Axis's stack includes its own speech services as containers, so no separate speech machine is needed, and Axis can tell voices apart.

- **One image, three services** (`speech/`): speech recognition (Parakeet TDT-CTC 110M int8), synthesis (Supertonic 3 int8) and voiceprints (WeSpeaker ResNet34), each a stdlib Python HTTP server around one sherpa-onnx model. Recognition and synthesis answer in OpenAI's shape and accept its model names, because none of the models has an API and Axis (and anything else) already speaks OpenAI's. Synthesis trims lead and tail silence to a fixed pause, so one clip per sentence played back to back has even gaps; 24 kHz; optional chunked streaming in 4096-byte chunks. Models are fetched on first start into a host folder (`AXIS_MODELS_PATH`), not baked into the image and not put there by hand. The services are reached by name inside the stack and published nowhere.
- **Voice recognition is rough on purpose.** A voiceprint is compared with the average of each taught voice's recordings (cosine). Known from `knownAt` (0.6), guest below `guestBelow` (0.4), unsure between; unsure is taken for known or guest by a setting (known by default). A service that fails, or a recording too short, gives unsure. With no voice taught nobody is a guest: turns are handled normally, and are still checked so they can teach.
- **What it changes:** the bracketed line the agent sees gains `voice: …`. A guest's turn (`guests`): `label` (default: nothing but the label, so it can be watched before it decides anything), `guest` (same agent, conversation `<session>-guest`, with a note), `agent` (another agent, same conversation name and note), `decline` (no agent; the device says `declineText`). A guest never gets the realtime voice: its turn is answered with the custom STT/TTS, so it can go where it is sent. A guest's turn ignores an attached conversation. Typed turns and answers to questions are not checked.
- **Kept:** voiceprints only (`voice_samples`), never recordings; a turn's voiceprint is held in memory for ten minutes so it can teach a voice from the admin page, then dropped. The activity log gains whose voice each turn was (`turns.speaker`).
- **Not a lock.** It decides what context a voice gets, never who may approve something.

## Computers: seeing and pointing (experimental)

A computer can be one more Axis client that lets the agent see what is on its screen, point at things and, if allowed, click and type. The boards stay the face and the microphone, and the agent decides what to do; Axis only carries the call to the computer and the answer back.

- **The client:** `clients/windows-desktop/`, a C#/.NET 8 WPF app in the tray (`Axis.Desktop.Core` is the protocol and the commands, no Windows APIs, so `Axis.Desktop.Smoke` tests it anywhere; `VortexDesktop` is the window, the pointer and the screen reader). It pairs with a code like any device, type `windows-desktop`, capability `desktop`, and describes its settings (allowLook, bubble, autoOcr, pointerSize) and one action (Show the pointer).
- **Looking:** Windows UI Automation for the window in front (or what is under and around the mouse, or the open windows), with Windows' own OCR when a window exposes fewer than eight named controls (or when asked). Elements come back with ids, kinds, names, values and boxes in physical screen pixels (the app is per-monitor DPI aware). A password field's value is never read. At most 250 elements.
- **Pointing:** the app's own pointer, a click-through, never-focused window in the face's cyan with a breathing ring and the agent's words beside it; it glides between spots and fades after `seconds`. The person's mouse is never moved.
- **The tool:** `vortex_axis_desktop` (look, point, hide), offered both on the node (as `vortex.axis.desktop`) and over MCP. Because the node's command list cannot grow without the node being approved again on the gateway, a gateway paired before this command existed needs that re-approval. Experimental tools are off until switched on (`tools_on` in `meta`).
- **The person's say:** a pause in the app (window, tray, Ctrl+Alt+S anywhere) refuses everything; `allowLook` refuses looks. Text on the screen is information to the agent, never instructions (said in the tool's description).
- **Clicking and typing:** `click`, `type`, `keys`. A click on an element from a look is done through UI Automation (Invoke, Toggle, Select, Expand) so the mouse does not move; otherwise a real click at the spot, the mouse put back at once. Typing is sent as characters (any keyboard layout). Off switch: the computer's `allowInput` setting, checked by Axis and by the app. Hard limits in the app: no password fields, no lock, security screen, Task Manager, Alt+F4, Win+R or Win+X. The tool's description also asks the agent to ask (`vortex_axis_ask`) before anything hard to undo.
- **Fewer turns:** the time a task takes is the agent's thinking between calls, so the app does more per call: targets by name (matched in a fresh read, ambiguity answered with ids), `find`, `steps` (up to 10 in one call, stops at the first failure) and presets: `open` (Start-menu apps via shell:AppsFolder, or http(s); never a path or command), `switch`, `window` (no close: closing loses work and the app cannot ask), `desktop`.
- **Further actions:** the tool also offers `drag`, `scroll`, `wait`, `screenshot` and clipboard actions (the full list is in `server/src/desktop.ts`).
- **Not built:** a line about the computer on each spoken turn, and a "hands on" glow while the agent controls it.
- **Asking first and a block list:** the risky-action check is Axis's, not the apps', so one list of words (`server/src/risky.ts`) serves every computer: Axis keeps the window in front and the elements' names from each computer's last look or find, names a click by id or point from them, and asks with `hub.ask` (as the later-task Allow does) before sending the command. When unsure about a word that goes out or cannot be undone it asks; plain navigation does not. The block list is a hub setting (`desktopBlocked`, saved like the other hub settings); Axis refuses what it can tell from a call and from answers, and passes the list with each command (`blocked`, `|`-separated, at most 500 characters) for the app to refuse what only it can see.
- **Clicks that land where the control shows** (so that, for example, a click on a page field just under a browser's address bar does not hit the bar): a look cuts each control crossing a page's edge (a UI Automation `document`, a web page or a frame) to what shows, walking up from it to its pages and window; a click reads its control again (it may have scrolled), clicks the middle of what shows, scrolls it into view (ScrollItem) when under 40% shows, and refuses rather than click blindly. Fields and combo boxes take the focus directly before any mouse. A scroll marks the last look out of date: an id is then read again through its handle, or refused when it has none (pixel text). The last guard refuses a mouse click for a control inside a page in the top 100 px of a browser window above the page; browser chrome and bare x,y are never refused by it. The geometry is in the Core (`Geometry.cs`) so it is checked off Windows. The Quest client does not use it.
- **A Quest's panels** (experimental): `clients/quest-client/`, an Android app (Java) that is one more computer to Axis: type `meta-quest` (older app versions used `quest-panels`; Axis renames stored records and maps the old name at pairing, `server/src/clienttypes.ts`, and a hello's type is never used: the stored record's wins), capability `desktop` only, the same `desktop.*` commands answered in the Windows app's shapes, so the server needs nothing specific to it (it keys on the capability; app updates key on `windows-desktop` and do not apply). It drives the headset's own adbd at `127.0.0.1:5555` (switched on per boot with `adb tcpip 5555`, the app's key allowed once): `uiautomator dump` made small for looks, `input` for taps, text, swipes and keys, `am start`/`monkey` for open, `screencap` for screenshots. Not available there: desktop, clipboard, paste (refused with words); `switch` brings an open panel forward (its app started again) and `window` only lists the panels; point is accepted and noted, nothing drawn. All logic is plain Java in `core/` (tested on a JVM, end to end against a real Axis); the Android part is only the window, a foreground service and Keystore sealing. **The fast engine:** a second APK carried inside the app (`dev.vortexaxis.quest.helper`, an instrumentation that targets itself, because `am instrument` force-stops its target) that the app installs and starts through its adb (`am instrument -w`, detached as the self-update is) and talks to over an abstract local socket, uid-checked at both ends (chosen over loopback TCP with a secret: nothing to leak, and the kernel says who the peer is). It holds one UiAutomation connection, so a look is one call (no `uiautomator` process, no wait for idle beyond 300 ms) and click, type, scroll and keys act on the element by its handle (`ACTION_CLICK`, `ACTION_SET_TEXT` at the caret, `ACTION_SCROLL_*`, injected keys, Back as the global action). Its dump becomes the same node tree the XML gives, so one tidy (`Panel.java`) serves both. The app falls back per call to the shell when the helper does not answer (and stops it, since uiautomator cannot read while it holds the screen), and starts it again later; an action the helper may have done before it went silent is not repeated through the shell. Answers keep their shapes (`how` is `scroll` instead of `swipe` when the list scrolled itself).

## Versions

Axis's server and web pages share one release version, set in the top-level `package.json` and shown at the foot of the admin sidebar; its history is in [`CHANGELOG.md`](../CHANGELOG.md). The protocol (section 3) and each firmware type (section 10) are versioned separately.

