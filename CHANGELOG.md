# Changelog

What changed in VorteX Axis, newest first. One number covers the server and its web pages (the admin page and the web client), which ship together; it is written once, in the top-level `package.json`. Firmware counts its own versions per device type, and the protocol between devices and Axis has its own single number that changes only when devices and Axis must change how they talk.

Numbers go `0.middle.last`: the middle one for a batch of new things, the last for fixes. Before 0.14.0 everything called itself 0.1.0; the entries below that are written back from the history.

## 0.16.1 (2026-10-10)

- Board firmware 0.11.8: a tap anywhere under the face lists a task's steps, not only a tap on its line, which was too small to hit. A tap on the face still starts listening.

- `vortex_axis_progress` reads `steps` that arrive as the text of a list. An agent whose harness had listed the tools before 0.16.0 sent them that way and was refused.

## 0.16.0 (2026-10-10)

- **Steps by name.** `vortex_axis_progress` takes `steps`: up to twelve short names, plain or each with how it stands (pending, in_progress, completed, as an agent's own plan has them). Axis remembers them, so later reports only say how far along.
- **A bar, and the steps on a press.** Screens draw a thin bar under the task's line. A press on the line in the web client, or a tap under the face on a board (on the line itself before firmware 0.11.8), lists the steps with the one in hand marked; on a board the list goes away after 20 seconds or on a tap. A tap anywhere else on a board still starts listening. With steps counted in the line, a board shows the words on what is happening under it.
- **A finish you can hear.** A task that finishes is marked with two soft notes, once, on each screen: the board's "Task chime" setting (on by default) and the web client unless it is muted. Never in quiet hours.
- **Your phone when you are away.** The hub has a new Home Assistant switch, **Away**. While an automation there keeps it on, a task that finishes or starts waiting for you is also sent as a notification to browsers that allowed them and are closed. Off, nothing goes to a phone.
- **Finished tasks are kept.** The Live page lists tasks that are over: how each ended (done, cleared, or no word for half an hour), how far it got and how long it took. They are kept as long as the rest of the activity (7 days unless changed), then dropped. A task under way is still in memory only.
- `progress.show` gains `steps` (one line per step, led by `x` done, `>` in hand, `-` to come) and `chime` (additive to protocol 1). Board firmware 0.11.7.

## 0.15.0 (2026-10-10)

- A ninth tool, `vortex_axis_progress`: an agent doing long work reports a title, what is happening, steps done of steps in all, and whether it is running, waiting for the person or done. Screens show it as one silent line ("Backup 3/5"); the admin page lists it under Now on the Live page, where it can be taken off. Kept in memory only; a finished task leaves after 90 seconds and one nobody reports on after 30 minutes.
- Clients with a screen are sent the `command` `progress.show` (additive to protocol 1; a client that shows nothing answers `ok: false`). The web client shows it; board firmware 0.11.6 shows it, taking turns with a timer.
- An OpenClaw gateway must allow the new command `vortex.axis.progress` beside the others.

## 0.14.2 (2026-10-10)

- A spoken turn records what made the device listen: the wake word, a tap, a press held down, listening on after an answer, or a question. The Overview's recent turns and the Live view show it ("spoken, tap"). Until now every such turn read just "spoken".
- Protocol 1 gains an optional `trigger` on `audio.start` (additive: an older device says nothing, and Axis then knows only whether there was a wake word). The web client sends it; board firmware 0.11.5 sends it.

## 0.14.1 (2026-10-09)

- The admin page says "protocol 1", not "device protocol 1".
- The README says what Axis is for: OpenClaw first, and any other agent harness through MCP and a chat address.
- Nothing in the repository names one installation any more: real host names, addresses, the public name and device names moved to `CLAUDE.local.md`, which is not committed, and the examples use made-up addresses.

## 0.14.0 (2026-10-09)

The first numbered release. The number and the commit of the build are shown at the foot of the admin page's sidebar, and the web client reports the number as its own.

- **Tools for any agent.** Axis is an MCP server (`POST /mcp`) offering the same eight tools as the OpenClaw node, from one list and one function. Agent tokens and a switch per tool are on the admin page under Agent tools.
- **Backup built in.** Axis copies its database, firmware and wake words to a mounted folder on a schedule, with settings, a Back up now button and warnings on the admin page. The host cron job and its script are gone.
- **Admin page.** Live view (each turn step by step, wake words, timers, questions, kept messages, Clear now); Activity folded into Overview; Integrations with editable hub settings; a Say something box; wake word scores per device; remembered sign-in; a phone layout with a menu drawer; switches drawn properly.
- **Web client.** History that marks announcements, notifications and questions (answered or not) and keeps them in the browser; volume and mute, notifications and history as small marks in the corner; forgetting a pairing takes two presses; the timer is a small chip; sound recovers on an iPhone; holding the face to talk survives a drifting finger.
- **Server.** Words held in memory for the admin page are deleted after ten minutes; a client that says it is not playing sound is no longer waited for; the chat endpoint's default system prompt knows about the tools.

## Earlier on 2026-10-09 (before numbering)

- Web client as an installable app with notifications (Web Push), questions answered from a notification, hold-to-talk, screen kept awake, a timer countdown with cancel.
- Messages kept for clients that are away; say on every device; quiet hours; every client as a Home Assistant device through MQTT.
- Web files loaded by stamped addresses, and a page that reloads itself when Axis has a newer one.
- Admin page in the web client's theme, a Face page, a sketch of each device, test buttons for a chat endpoint and a notification.
- A wake word ignored while another device speaks in the same location. Firmware 0.11.0 to 0.11.4: echo cancelling, more idle looks, encrypted connections taking memory from PSRAM.

## 2026-10-08

- Admin page redesign: sections, a page per device and per client type, fleet-first settings; activity log, uptime and charts.
- Agent commands ask, timer and admin; firmware updates over Wi-Fi; TLS for devices; protections for a public address; wake word models served by Axis; moving a device to another address; resetting a device.
- A system prompt for chat endpoints and a note for OpenClaw agents; "room" became "location".
- Speech synthesized a sentence ahead, one at a time; a crash on streamed replies fixed.
- Firmware for the Waveshare ESP32-S3 AMOLED board from first boot to 0.10.3: setup network, pairing, the vortex face, speaker, microphone, the on-device wake word, follow-up listening.

## 2026-10-07

- The client protocol (version 1 draft); the server: pairing, tokens, settings sync, the admin API, a Docker image.
- Voice and text turns: wake arbitration, recognition, the agent, sentence-by-sentence speech.
- The OpenClaw gateway link: device identity, the operator and node roles, pairing by setup code; commands named `vortex.axis.*`.
- The first admin page and web client; a headless browser check.
