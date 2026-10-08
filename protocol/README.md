# Axis client protocol, version 1

How a client talks to Axis. The TypeScript in `src/` is the definition; this page explains it. `schema/axis-protocol.v1.json` is the same definition as JSON Schema, generated for firmware and other non-TypeScript clients.

Status: draft. Nothing has run against it yet, so expect changes until the server and the web client exist.

## Transport

- A client pairs once over HTTP, then holds one WebSocket to `/v1/client`.
- **Text frames** are JSON control messages. Each is an object with a `t` field naming its type. Unknown types and unknown fields are rejected.
- **Binary frames** are raw audio. They carry no header: a binary frame belongs to the audio stream currently open in that direction. Only one stream is open per direction at a time.
- Keep-alive uses WebSocket ping and pong. There is no protocol-level heartbeat.

## Pairing

`POST /v1/pair` with a one-time code:

```json
{ "code": "483-221", "type": "esp32s3-speaker", "version": "0.1.0", "capabilities": ["mic", "speaker", "screen"] }
```

Axis replies with the client's identity. The token is shown once; the client stores it.

```json
{ "clientId": "c_desk", "token": "…", "name": "Desk speaker" }
```

## Connecting

The first frame on every connection is `hello`. Axis answers `welcome`, then `settings` if the client's copy is out of date, then `status`.

```json
{ "t": "hello", "protocol": 1, "clientId": "c_desk", "token": "…", "type": "esp32s3-speaker",
  "version": "0.1.0", "capabilities": ["mic", "speaker", "screen"], "settingsVersion": 0, "maxFrameBytes": 4096 }
```

- `protocol` is the version the client speaks. Axis accepts the current version and the one before it. Anything else gets `error` with `unsupported_protocol` and the connection closes.
- `maxFrameBytes` is the largest binary frame the client can receive. Axis never sends a larger one. The default is 4096.
- `audioBufferMs` is how much audio the client can hold before playing it. Axis paces speech so it never runs further ahead of real time than this. The default is 2000.
- `version` is the firmware or app version without a leading "v".

## A voice turn

```
client                                   Axis
  │ wake {wakeId, score, level}  ───────▶ │   client is already buffering audio
  │ ◀─────── wake.result {granted:true}   │   after about 200 ms of arbitration
  │ audio.start {turnId, format, wakeId} ▶│
  │ <binary> <binary> …  ────────────────▶│   16 kHz, 16-bit, mono PCM
  │ audio.end {turnId, reason}  ─────────▶│
  │ ◀────── turn {state:"transcribing"}   │
  │ ◀────── transcript {text}             │
  │ ◀────── turn {state:"thinking"}       │
  │ ◀────── speak.start {turnId, format}  │
  │ ◀────── <binary> <binary> …           │   sentence by sentence, as it is synthesized
  │ ◀────── reply.text {text, final}      │   for clients with a screen
  │ ◀────── speak.end {turnId}            │
  │ playback {state:"finished"}  ────────▶│   the client has actually stopped playing
  │ ◀────── turn {state:"idle"}           │
```

- A client that receives `wake.result` with `granted: false` discards its buffer and stays quiet.
- A client that is the only one online is granted immediately.
- A turn can also start without a wake: a button press sends `audio.start` directly, and a typed message sends `text`.
- `turnId` is chosen by the client. `wakeId` links the turn to the wake that began it.
- `transcript` and `reply.text` are sent only to clients with the `screen` capability. Each `reply.text` with `final: false` carries the next piece of the reply; the one with `final: true` carries the whole reply.
- A client without the `speaker` capability gets no `speak.*` frames, only text.

A client that cannot make sound at all reports `playback` with `blocked` instead of `started`. Axis then stops waiting and tells whoever asked that the words were not heard.

## Stopping

- The user taps, presses a button or repeats the wake word: the client sends `interrupt`.
- Axis wants the client to go quiet (a newer turn, a stand-down): Axis sends `stop`.

Either way the client stops playback, drops buffered audio and reports `playback` with `stopped`.

## Agent-initiated output

- **Speech:** Axis sends `speak.start`, audio and `speak.end` with a fresh `turnId` and no preceding client input.
- **Questions:** Axis sends `ask` with up to six choices. The client shows or speaks them and replies with `answer`. If nothing arrives within `timeoutMs`, Axis treats the question as unanswered.

## Settings

`settings` carries the full resolved set for this client, with the global, type and device layers already merged, plus a version number. Clients store the values and the version. A client that suspects it is stale sends `settings.get` with the version it has.

Values are flat: strings, numbers, booleans or null.

## Commands

`command` asks the client to do something outside a turn, such as change volume, set a timer, report diagnostics or reboot. The client replies with `command.result` carrying the same `id`. A client that does not implement a command replies `ok: false`.

Command names and their parameters are not fixed in version 1. They are defined alongside the server.

## Health and errors

- `status` reports whether OpenClaw, speech recognition and speech synthesis are up, so a client can say or show which part is down. Axis sends it after `welcome` and whenever it changes.
- `error` reports a problem with a code from a closed list: `bad_message`, `unsupported_protocol`, `unauthorized`, `busy`, `upstream_down`, `timeout`, `not_supported`, `internal`. When `fatal` is true, Axis closes the connection next.
- `sense` lets a client report sensor readings as flat key-value pairs.

## Message list

Client to Axis: `hello`, `wake`, `audio.start`, `audio.end`, `text`, `interrupt`, `answer`, `playback`, `sense`, `settings.get`, `command.result`.

Axis to client: `welcome`, `settings`, `wake.result`, `turn`, `transcript`, `reply.text`, `speak.start`, `speak.end`, `ask`, `stop`, `status`, `command`, `error`.

Field-level detail is in `src/messages.ts`.

## Working on the protocol

```bash
npm install            # from the repository root
npm test               # validates a sample of every message type
npm run typecheck
npm run schema --workspace protocol   # regenerates schema/axis-protocol.v1.json
```

Any change visible on the wire needs a new `PROTOCOL_VERSION` in `src/version.ts`, and the server must keep accepting the previous one. Regenerate and commit the schema file in the same change.
