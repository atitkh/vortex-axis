# VorteX Axis design

This records what was agreed in the scoping discussion on 2026-10-07. Items marked **proposed** were put forward and not objected to, but have not been tested. Items marked **open** are undecided.

## 1. Purpose and boundaries

Axis fronts a set of thin clients and presents them to OpenClaw as one node. It owns the connections to OpenClaw, STT and TTS, the client registry, the settings, and the routing of input and output between clients.

Axis is not an agent harness. It holds no conversation history and makes no decisions beyond routing.

Mylo, the existing ESP32 voice device, is a separate product and stays as it is. It is the reference for how a thin client behaves today, not a client to migrate.

## 2. Architecture

### 2.1 One OpenClaw node

OpenClaw has no sub-device concept: a node is one WebSocket connection with one cryptographic device identity, and capabilities and commands are declared per connection. Axis therefore registers once and takes the target as a parameter on its own commands, for example a room or a client name. Routing lives in Axis.

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

### 2.3 One conversation

All clients share one OpenClaw session, so a question asked at one client can be followed up from another. Axis gives the agent context in three ways:

- **Session prompt (stable):** what Axis is, that replies may be spoken, and that client tools exist. OpenClaw applies this only when a session is created, so changing it starts a new session. Keep it small and change it rarely.
- **Message header (per turn):** one short line added to each message naming the source client, its room and its capabilities, for example `[from: Desk, type: esp32s3-speaker, room: office, can: mic+speaker+screen]`. Built.
- **Client list tool (on demand):** returns registered clients, which are online and what each can do.

## 3. Client protocol

**Proposed.** One WebSocket per client over TLS, carrying:

- JSON text frames for control: hello, pairing, settings, wake events, turn state, errors.
- Binary frames for audio. Upstream is 16 kHz, 16-bit, mono PCM. Downstream is PCM. A compressed format can be added later for clients on mobile data.

Plain HTTP is used only for pairing, health checks and firmware downloads.

The protocol carries a version number. Axis keeps accepting the previous version so that updating the server never strands a client that has not been updated.

Every client reports its type and firmware version when it connects.

The first draft of the message set is in [`protocol/`](../protocol/README.md).

### 3.1 Pairing

A new client is given Wi-Fi credentials, the Axis address and a one-time pairing code. Axis exchanges the code for a long-lived token that belongs to that client and can be revoked. After that the client configures itself from Axis.

### 3.2 Wake word arbitration

The wake word runs on the client, offline. When two clients hear it at once:

1. Each client starts recording into a local buffer immediately and sends Axis a wake event with a score (detection confidence and loudness).
2. Axis collects wake events for about 200 ms, grants the best-scoring client and tells the others to stand down.
3. The granted client sends its buffered audio, so speech during the wait is not lost.

If only one client with a microphone is online, Axis grants immediately. Scores tie-break on loudness. Audio that names a wake is accepted only from the client that was granted it.

### 3.3 Interrupting

In version 1 a tap, a button press or a repeated wake word stops playback. Interrupting by speaking over the reply needs echo cancellation on the client and is left for later.

### 3.4 Audio out

Replies are synthesized sentence by sentence while the agent is still writing, and each sentence's audio is sent as soon as it exists. Axis cuts audio into frames no larger than the client asked for and paces them so it is never further ahead of real time than the client's stated buffer (`audioBufferMs`, 2 seconds by default). After the last frame Axis waits for the client to report that playback finished before marking the turn idle.

## 4. Settings

Axis is the source of truth. Settings have three layers, with the more specific layer winning:

1. Global: wake word, voice, persona.
2. Client type: defaults shared by all clients of that type.
3. Device: volume and room.

Settings carry a version number. It is one counter for the whole hub, raised on any change in any layer. A client asks for anything newer than what it has and keeps its last copy for when Axis is unreachable. A client that is reset gets everything back from Axis.

## 5. Routing

- A reply returns to the client that asked.
- For output the agent starts unprompted, the default is the last client used for input. After a timeout this falls back to a configured default client.
- If the chosen client is offline, Axis falls through to the next client that has the needed capability.
- Presence-based routing comes later. Until then Axis uses whatever sensor data clients report.

## 6. Agent command surface

OpenClaw filters node commands through an allowlist, and widening a node's declared commands forces a re-approval. The full surface is therefore declared up front and grouped by permission, not by feature.

**Proposed** commands, names to be confirmed before the first pairing:

| Command | Purpose |
| --- | --- |
| `vortex.axis.say` | Speak or show something on a client or in a room. |
| `vortex.axis.ask` | Ask a question with choices and return the answer. |
| `vortex.axis.clients` | List clients, their state and capabilities. |
| `vortex.axis.config` | Read or change a client's settings. |
| `vortex.axis.sense` | Read sensor data a client reports. |
| `vortex.axis.diag` | Read diagnostics for Axis or a client. |
| `vortex.axis.timer` | Set and manage timers on a client. |
| `vortex.axis.admin` | Reboot, re-pair and similar actions. |

Agents only see a command after Axis publishes it as a tool, so Axis publishes its tool descriptors on every connect. Only commands that work get a tool. Built: `vortex.axis.say`, `vortex.axis.clients`, `vortex.axis.config`, `vortex.axis.sense`, `vortex.axis.diag`, and `system.notify` (spoken as a message). Declared but not built: `vortex.axis.ask`, `vortex.axis.timer`, `vortex.axis.admin`.

Where agent-started output goes: a named client, else a named room, else the client last spoken to (for 10 minutes by default), else the client named in the global `defaultClient` setting, else any client that can speak or show text. A client in a conversation is waited for, up to 20 seconds.

## 7. Failure behavior

- A client that cannot reach Axis has a local response for it, so it fails audibly or visibly.
- When Axis is up but OpenClaw, STT or TTS is down, the client says, shows or indicates which part is down.
- A backup voice path is a later addition.

## 8. Storage

SQLite, one file in one data folder bind-mounted from the host, through Node's built-in `node:sqlite`. It uses a rollback journal instead of write-ahead logging so the folder can live on network storage.

- Stored: clients (name, type, room, last seen), client types and capabilities, the three settings layers and their version, pairing codes, token hashes, Axis's own OpenClaw identity and tokens, and a short log of recent turns for debugging.
- In memory only: who is online, the current output client, the active turn.
- Not stored: audio and conversation history.

## 9. Deployment

- One Docker container and one data folder on the host.
- All host-specific addresses (OpenClaw gateway, STT, TTS) are environment variables. Moving hosts means copying the data folder and the environment file.
- TLS is terminated by a reverse proxy in front of Axis.
- Axis will be reachable on a public domain for portable clients. Only the client endpoint is public. The admin page stays on the local network. Version 1 is built local-only, with the auth designed for public exposure.

### 9.1 Setup and the web pages

Only the admin token comes from the environment. The gateway address and setup code, the agent, and the speech service addresses, models, voice and keys are set on the admin page, stored in the data folder, and applied to the next turn without a restart. Environment values are the starting point and are overridden by anything saved.

The admin page and the web client are plain files served by the hub. The pages hold no secrets: every action goes through the same endpoints, with the same checks, as any other caller. The admin token is kept in the browser tab only.

The web client is a normal client with the capabilities `speaker`, `screen`, `buttons`, and `mic` when the browser allows the microphone (https or localhost only). It has no wake word: a click starts listening and silence ends it.

## 10. Firmware

- `firmware/common/` holds the client core. A new device type should mostly describe its hardware.
- Releases are git tags. Each build knows its type and version.
- The first flash is over USB. Updates through Axis come after version 1: Axis holds the latest build per type, one device is updated first, and a device that cannot reconnect after an update rolls back.
- Tagged releases can be built by the existing Gitea Actions runner.

## 11. Testing

- The web client is the first client and the main way to test Axis end to end.
- A scripted fake client pairs, plays a recorded question and checks that audio comes back. It can run in CI.
- A spare ESP32-S3 board is available for hardware tests.

## 12. Open items

- A target for time to first sound. The reference device measured about 8 seconds before it began speaking sentence by sentence, so Axis streams replies from the start. First measurements against the live services on 2026-10-07: speech recognition about 3.5 seconds for a 2 second clip once warm (about 30 seconds on a cold start), speech synthesis about 1.7 seconds to first audio. The agent's own time comes on top.
- Whether to send the agent a stable session prompt (`extraSystemPrompt` on the `agent` method), and when OpenClaw applies it.
- Approvals raised during a turn are not shown to clients yet.
- Final command names (section 6).
- Whether a plain `system.notify` aimed at Axis should be routed to the current output client.
- How the Bangle.js 2 reaches Axis (it has Bluetooth only, so it needs a phone or a relay).

## 13. Lessons carried over from the Mylo firmware

These come from that project's notes on talking to the OpenClaw gateway (2026.9.4, protocol 4). Each one cost a debugging cycle there.

- `client.id` and `client.mode` are closed enums. A node uses `node-host` and `node`.
- Do not send an `Origin` header, or the gateway treats the connection as a browser session.
- Device tokens are issued per role. The operator and node roles are separate connections with separate tokens.
- Custom command names must be added to `gateway.nodes.commands.allow`. Unknown names are dropped silently.
- `paramsJSON` in an invoke request is a string, not an object.
- Long invokes need progress frames, and nodes must report presence or they show as offline.
- Back off on auth rejections. Retrying a rejected credential on a fixed interval trips rate limiting.
- Read `error.details.code`, not the error message.
- Always pass a limit to `sessions.list`.

Found on Axis's own first pairing with a real gateway (2026-10-07):

- Two roles must not present one setup code at the same moment. While one role's pairing request is waiting for approval, the gateway refuses the same code from the other role as invalid. The operator link pairs first; the node link starts once it is connected.
- Approving a device approves the role it asked for. The node role then arrives as a second request ("asking for a higher role"), which needs its own approval.
- Do not report the platform as `linux`. The gateway takes a Linux node host to be its own headless node: it warns about version drift, and it pins a device family (`Linux`) that the operator link, which sends none, then fails to match ("device identity changed and must be re-approved"). Axis reports the platform `vortex-axis`, which the gateway treats as a plain custom device.
- `node.pluginSurface.refresh` is not a way to refresh tools. It wants a `surface` and fails without one. Publishing tools needs only `node.pluginTools.update`.
- A gateway that is restarting answers connects with `UNAVAILABLE`. That is not a credential failure; retry soon.
