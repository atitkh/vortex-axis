# Changelog

What changed in VorteX Axis, newest first. One number covers the server and its web pages (the admin page and the web client), which ship together; it is written once, in the top-level `package.json`. Firmware counts its own versions per device type, and the protocol between devices and Axis has its own single number that changes only when devices and Axis must change how they talk.

Numbers go `0.middle.last`: the middle one for a batch of new things, the last for fixes. Before 0.14.0 everything called itself 0.1.0; the entries below that are written back from the history.

## 0.27.0 (2026-10-11)

- **Live activities on phones.** Tasks and timers can show on the lock screen and in the Dynamic Island of a phone with the Home Assistant app (Live Updates on Android), through Home Assistant (`liveactivity.ts`). Axis only speaks MQTT to Home Assistant, so it publishes each activity on `vortex-axis/live` and a blueprint it serves (`/ha/vortex_axis_live_activities.yaml`, local network only, with an import link on the Integrations page) passes it to the chosen phone and acknowledges on `vortex-axis/live/ack`. Off by default; offered only while the Home Assistant link is connected, with a switch and a Send a test button on the Integrations page (`liveActivities`, or `AXIS_LIVE_ACTIVITIES`).
- What shows, with iOS's limits in mind: a task once it has run 30 s, or at once when it waits for the person ("needs you", the only update that sounds); a finished task quietly, until it leaves the screens; a timer of a minute or more as a countdown, "Done" with a sound when it goes off, gone a minute later or at once when cancelled. Updates to one activity are at least 10 s apart unless its state changes. Activities left by an Axis that restarted are ended. Tapping one opens the web client when Axis has a public name.

## 0.26.0 (2026-10-10)

- **Long agent work carries on without the device.** When the agent has said nothing new for 30 s (`AXIS_HANDOVER_MS`, 0 to switch off), the device says "On it, I'll tell you when it's done" and is free again. Axis keeps following the run (`background.ts`; the gateway follow limit is now 30 minutes instead of 120 s), shows it as a task on the screens (or the agent's own progress card, when it keeps one), and says the first few sentences of the answer where the person last was, or on a phone while away. A run that fails says so. Taking its task off the screens stops the run. Axis announces the answer even when the agent also spoke on its own during the run.
- **Turns while a conversation is busy.** OpenClaw answers one message at a time per conversation (a second one waits behind a running one; tested 2026-10-10). While the conversation turns would go to (Axis's own, or an attached one) has a run going, whether Axis handed it over or it came from elsewhere (the gateway's `hasActiveRun`), new turns go to `<sessionKey>-busy` instead, told on the device line what holds the usual one and to read, not message, that conversation if asked how it is going.
- The activity log marks turns that were handed over.

## 0.25.1 (2026-10-10)

- **Said on several devices, made once.** Something said everywhere or in one location is synthesized once per voice and the same audio is played on each device (`SpeechShare` in `speech.ts`), so devices in one room start together instead of one after another, and the speech service is not asked for the same sentence again for each device. Stopping one device does not cut the others off.
- **Voiceprints from the admin page wait longer.** A recording to teach or check a voice may wait up to 20 s for the service (a busy host once took over 5 s, and Axis gave up); a spoken turn still waits at most 3 s, so a slow service never holds up an answer.
- **Speech services:** a caller that hangs up before the answer is ready is one log line, not a traceback.

## 0.25.0 (2026-10-10)

- **Local speech in the stack.** `compose.yaml` now runs speech recognition (Parakeet), synthesis (Supertonic 3) and voiceprints (WeSpeaker) as three CPU containers from one new image, `speech/`, each behind OpenAI's audio API although none of the models has one. Each fetches its model on first start into `AXIS_MODELS_PATH`. Point `AXIS_STT_URL` and `AXIS_TTS_URL` (or the Speech page) at `vortex-axis-stt` and `vortex-axis-tts`, or anywhere else as before.
- **Voice recognition.** Off until switched on in the Speech page's new section. Taught voices are told from guests by voiceprint (known, guest or unsure, with two cut-offs); the agent sees whose voice it was on the device line; a guest's turn can be only labelled, sent to a guest conversation of the same agent or another agent, or turned away. Voices are taught by recording on the admin page or from turns heard in the last ten minutes. Only voiceprints are kept. The Live page and the recent turns show whose voice each turn was.
- **Wording:** the Speech page calls the recognition and voice "Custom STT/TTS".

## 0.24.0 (2026-10-10)

- **Attach the devices to another conversation.** A tenth tool, `vortex_axis_session`: "attach to internship hunt" points every device at that conversation of the agent's, so what is said next, on whichever device hears it, goes there; "detach" goes back to the usual voice conversation. It is one pointer for the whole hub, not one per device, because the devices are one way into one agent and any of them may pick up the wake word. It lets go by itself after half an hour with nothing said. The Live page shows it under Now, with a Detach button. The realtime voice follows it. An OpenClaw gateway must allow the new command `vortex.axis.session` beside the others.
- **A check of what Axis relies on in OpenClaw.** Each time the gateway link comes up, and on request, Axis asks the gateway what it offers (its methods and events), looks at the scopes it holds, and tries what can be tried without changing anything, for each of: turns, progress cards, questions, approvals, tool icons, realtime voice. The OpenClaw page lists how each stands; one that has stopped working is in the Overview's list of what needs attention and in the events, once when it breaks and once when it is back. Only what is switched on can be a problem.

## 0.23.1 (2026-10-10)

- A realtime voice is played at 70 % of how it arrives: it comes in louder than the local voice, and a board's small speaker buzzed with it. The setting `realtimeVolume` (10 to 100 %) changes that, for all devices or one.

## 0.23.0 (2026-10-10)

- **Realtime voice is a proper option now**, no longer a prototype. The Speech page has a **Realtime voice** section: one switch for what every device uses (Axis's own recognition and voice, or the realtime voice), the choice among the realtime voices the gateway offers, and **Try it**, which opens a session with the voice and closes it again to say whether it really works. A device can still be set differently on its own page.
- It is offered only while the agent is an OpenClaw gateway that Axis is connected to. Otherwise the section says so, and a device set to realtime is answered the usual way instead of failing.
- **The agent is asked to talk, not to write.** The note Axis adds for an OpenClaw agent, and the prompt it sends a plain chat endpoint, now ask for speech as a person speaks it: the answer first in a sentence or two, contractions, a small spoken touch where it fits, more offered instead of said, no opening praise or filler. The earlier wording ("short, plain sentences") was reaching the agent and got exactly that.

## 0.22.2 (2026-10-10)

- **Speech no longer races after a pause in it.** Axis sends a device no more sound than its buffer holds, by reckoning how much it has played. A gap in the sound was reckoned as room in the buffer, so whatever came after the gap went out all at once: more than a board could hold, and it dropped pieces, which sounded like the speech being wound forward. Now a device that has played everything simply has nothing in hand. This is in the part every voice goes through, though only a voice that arrives in fits and starts, like the realtime one, showed it.
- The 0.6 s head start of 0.22.1 is gone: the realtime voice is sent on as it comes.

## 0.22.1 (2026-10-10)

Still the realtime voice prototype of 0.22.0.

- **One turn in the chat, not two.** Work the voice model hands to the agent is now run by the gateway itself (`talk.client.toolCall`), which keeps it out of the conversation's visible turns. Before, Axis asked the agent with a message of its own, so the session showed what was said twice: once as the voice's transcript and once with Axis's bracketed line.
- **A head start of sound.** The model's voice arrives about as fast as it is spoken, and a board that started playing the first piece at once ran dry between pieces, heard as a buzz. Axis now has 0.6 s in hand before it sends a device any. Not yet confirmed on a board.

## 0.22.0 (2026-10-10)

Built as a prototype to try; kept, and made a proper option in 0.23.0.

- **Realtime voice as a second way to answer a spoken turn.** A device set to `voiceMode: realtime` has what it hears sent through the OpenClaw gateway's Talk relay to a realtime voice model, which answers in its own voice. Small things it answers itself; real work it hands to the agent, which Axis asks as it always does (same conversation, tool icons on the face) and whose answer the model then says. Off unless a device is set to it; `voiceProvider` picks the gateway's provider (`google`, or `openai/gpt-realtime-2.1-mini` for a model of one).
- Server only: no firmware and no protocol change. It is half-duplex: the device still decides when the person has stopped, and an interrupt stops the playback. Talking over the answer is not part of it.
- The sound leaves the house and the model is paid for by its provider's rates. Speech recognition and the voice of the `local` way stay where they are.
- Tried on the real gateway 2026-10-10 with a recorded question through a test client: with Google's provider, "what is two plus two" had its first words 2.5 s after the question ended (5.1 s the local way), and "are the lights on in my room" went to the agent, used Home Assistant and was answered by voice in about 10 s. OpenAI and xAI refused for want of credentials on that gateway. Not yet heard on a real device by anybody.

## 0.21.0 (2026-10-10)

- **The face shows when the agent's run is held up.** Two new looks while thinking: `compacting`, when the agent stops to tidy its memory (wound in tight, slow, deep blue), and `retrying`, when its provider failed and it is trying again (amber, turning backwards). A long silence for either reason no longer looks like a hang. When the run is under way again the face goes back to plain thinking, or to the icon of the tool in hand.
- With an OpenClaw gateway this comes from the run's own events (the `compaction` and `run_status` streams); nothing else reports it. It rides on `doing` of the `turn` message, which also gains `none` for "neither any more" (additive to protocol 1).
- The Face page shows both among the state looks. Board firmware 0.12.4 draws them.

## 0.20.1 (2026-10-10)

- Two more shared settings for tool icons, with sliders on the Face page: `toolIconMs`, how long the face takes to turn into an icon and back (150 to 3000 ms, 700 as before), and `toolIconDots`, how many of the 78 dots draw a dot shape (12 to 78). The dots left over stand off in a ring round the shape and go on turning. "Play it again" on the Face page takes the icons down and puts them up, to watch the change.
- Board firmware 0.12.3 follows both.

## 0.20.0 (2026-10-10)

- **Tool icons made of the face's own dots.** A third way to show what the agent has picked up: all 78 dots leave their arms and settle along the icon's strokes, in a colour of its kind, with a wave of light running along them, then swirl back into the vortex. No drawn lines; the same twelve shapes, each sampled into 78 points.
- **Three styles, chosen on the Face page:** dot shapes (the default now), the line icon at the core from 0.19, or off. It is the shared setting `toolIcons` (`dots`, `line`, `off`), so it can also be set per type or device like any other. The Face page draws all twelve kinds live in the style chosen, and any one large.
- Board firmware 0.12.2 draws the dot shapes and follows the setting.

## 0.19.1 (2026-10-10)

- Board firmware 0.12.1: the icon stands upright whichever way the screen is turned. The face is sent to the panel unturned, being round, and the icon went with it: on a board standing at 90 degrees it lay on its side.

- An agent's own housekeeping (looking up its tools, keeping its plan, loading a skill) no longer shows as an icon. On the first real turn the harness's tool lookup showed as a search.

## 0.19.0 (2026-10-10)

- **The face shows what the agent is doing.** While it thinks, an icon appears in the middle of the vortex for the kind of work the agent has just picked up: search, web, home, calendar, list, files, code, timer, message, memory, image, or a small cog for anything else. The arms stand back from the centre to make room and the icon takes the core's place and colour. Twelve icons, each a few strokes, defined once in `web/icons.js`; `scripts/gen-icons.mjs` writes the board's copy.
- With an OpenClaw gateway this needs nothing from the agent: Axis's operator link now declares `tool-events`, the gateway says which tools a turn picks up, and `server/src/doing.ts` reads the kind from the tool's name. Another agent backend shows the plain thinking face unless its reply stream names its tools.
- `turn` gains an optional `doing` with `thinking` (additive to protocol 1). The web client draws it; board firmware 0.12.0 draws it.

## 0.18.1 (2026-10-10)

- The scopes for questions and approvals are asked for when Axis is paired again with a setup code, and granted when that pairing is approved. 0.18.0 asked for them on a third link beside the two it has; the real gateway refuses that (a token for fewer scopes is refused when more are asked with it, and so is a connection with no credential), so the third link is gone. With either switch on and the scope missing, the Agent tools page says to pair again. If the gateway refuses the wider set after all, the operator link goes back to the scopes it had.

## 0.18.0 (2026-10-10)

- **An OpenClaw agent's questions reach you on a device.** When an agent on the linked gateway asks the person something (`question.requested`), Axis puts it to them the way its own ask tool does: spoken and shown on the device last used, with the choices to tap or say, and the answer goes back to the gateway (`question.resolve`). While Home Assistant's Away switch is on it goes to a phone as a notification. It can still be answered wherever else the gateway shows it; the first answer counts and Axis takes its own question back. Secrets and picks of several are never asked for on a device. A switch on the Agent tools page, on by default (`AXIS_MIRROR_QUESTIONS=0` to start with it off).
- **Approvals on a device.** When an agent waits for leave to run a command or use a tool (`exec.approval.requested`, `plugin.approval.requested`), a device with a screen shows what it is, silently, with Allow once and Deny. Only a tap allows; something heard can only refuse; a standing permission is never given from a device. A switch on the Agent tools page, off by default (`AXIS_MIRROR_APPROVALS=1` to start with it on).
- **The task line says what is being waited on.** A mirrored task whose session has a question or an approval open reads "needs you" with the question, or "approve: <command>", while the agent's turn is still running.
- Both need a scope the gateway has not given Axis before (`operator.questions`, `operator.approvals`). See 0.18.1 for how they are granted.
- `ask` inside Axis can be shown without being spoken and can be taken back.

## 0.17.0 (2026-10-10)

- **OpenClaw progress cards show by themselves.** An agent on the linked OpenClaw gateway keeps a list of steps for long work (its progress card). Axis now hears the gateway say a card changed (`progressCard.changed`), reads it (`progressCard.get`) and shows it as a task, with no tool call from the agent. The task is named after where the person talks to the agent (the channel or the session's label). It is done when every step is; with steps left and the agent's turn over it reads "needs you"; it goes back to running when the agent is at work again. Scheduled jobs are left out. A switch on the Agent tools page turns it off (`AXIS_MIRROR_CARDS=0` to start with it off). The progress tool is unchanged and is still how anything else reports: another harness, a script, a scheduled job.
- **Several tasks at once.** One that waits for the person always has the line; otherwise the one reported on last. The line counts the rest ("+2"), and the list a press or a tap opens names them above the steps. `progress.show` gains `others` (a line per other task, led by `!` when it waits for the person; additive to protocol 1).
- Tasks that finish within 30 seconds of each other chime once between them.
- A task whose reporter is known to be at work is not taken for abandoned after half an hour without a new word.
- Board firmware 0.11.9 shows the count and the other tasks.

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
