# Building a client for VorteX Axis

This is the contract a new client type has to meet: what it declares, what it must do for each thing it declares, and what a person should be able to expect from any device whatever it is made of. Read it before writing firmware for a new board or an app for a new platform.

It sits next to three other documents and does not repeat them:

- [protocol/README.md](../protocol/README.md): the messages, field by field. The wire format is defined in `protocol/src/messages.ts`.
- [docs/face.md](face.md): the vortex face, for clients with a screen.
- [firmware/README.md](../firmware/README.md): the one board that exists, and how to build and ship it.

When this guide and the code disagree, the code is right and this guide needs fixing in the same change.

## 1. What a client is

A client is one device or app that a person talks to or is spoken to through. It holds one WebSocket to Axis and nothing else: no agent, no speech recognition, no speech synthesis, no settings of its own beyond what it needs to reach Axis. Axis owns all of that. A client should be replaceable by any other client with the same capabilities without anything upstream noticing.

Every client has:

- **A type.** A short identifier the firmware reports, such as `waveshare-amoled-1.8` or `web`. Settings shared by a kind of device, firmware builds and the admin page all go by it. Choose it once: lower case, digits, dots and dashes, naming the hardware or platform and not its place or owner. A person can give a type a display name on the admin page; the identifier itself never changes.
- **A version.** Without a leading "v". It goes up with every build that reaches a device, because Axis compares it to decide who needs an update.
- **Capabilities.** What the device can do, from the fixed list below. Axis routes on these and never on a type or a name.

## 2. Capabilities

Declare a capability only when all of its "must" lines hold. A capability that half works is worse than one that is missing, because Axis will route to it.

| Capability | Declare it when | The client must |
| --- | --- | --- |
| `mic` | It can record a person speaking. | Send speech as 16 kHz, 16-bit, mono PCM. Decide by itself where a sentence starts and ends (section 4). Never send audio before a wake word, a button or a question from Axis opened the microphone. |
| `speaker` | It can play speech. | Play PCM at the rate `speak.start` gives (24 kHz today; do not assume it). Say in `hello` how much it can buffer. Report `playback` truthfully (section 5). Stop at once on `stop`. |
| `screen` | It can show text. | Show `transcript` and `reply.text`. Show what state it is in (section 6). Show a question's choices and take a pick. Show the next timer when it can. |
| `buttons` | It has something to press that is not the screen. | Use it for the three things a tap does (section 3). |
| `vibration` | It can buzz. | Nothing yet. Reserved for wearables. |
| `sensors` | It reports readings besides the basic ones. | Send them with `sense`. |
| `image-frames` | It can show pictures but cannot fetch an address while connected (a board with room for one encrypted connection). | Axis sends each picture over the socket, shrunk to the `screenW`×`screenH` it reports, as a baseline JPEG: `image.start` (size, width, height), then `image.data` frames with the bytes in base64 that fit its frame size, then `image.end`. Show it when complete; drop it when a piece is missing. |
| `images` | It can show pictures. | Show each `reply.image` with its reply (or as an announcement when `turnId` starts with `say-`): fetch `url` from the Axis address it already uses, with no credentials; the address is unguessable and stops working after a day. |

A device with a touchscreen declares `screen` and uses taps as its button; it does not need `buttons`.

## 3. What a person can always do

These hold on every client with a way to take input, so that nobody has to learn a device.

- **One tap (or the button) does the obvious thing for the moment.** Idle: start listening. Listening: finish now and send, or cancel when nothing has been said. Thinking or speaking: stop (`interrupt`).
- **The wake word starts a turn** on a client that has one. It is detected ON the device. Axis decides which device answers when several heard it (`wake` and `wake.result`); a device that is not granted discards what it recorded and stays quiet.
- **A reply can be followed up without the wake word.** After speaking an answer to something the person said, a `mic` client listens for `followUpMs` (6 seconds unless set, 0 turns it off). Silence ends it quietly, with no error and no cue. It does not do this after speech nobody asked for (an announcement, a timer).
- **A problem is said or shown, never swallowed.** A client that cannot reach Axis shows or says so by itself. When Axis reports a service down (`status`), a client with a screen says which.

## 4. Listening

For a `mic` client:

- Keep a short pre-roll (about 200 ms) so the first word is not clipped, and send only what was said: from just before the first word to the end of the last. Silence before it is not uploaded.
- End a sentence after `silenceMs` of quiet (900 unless set). Give up after `onsetMs` with nothing said (6000). Stop at `maxSpeechMs` (20000).
- Judge speech against the room's own level, not a fixed threshold, so a fan does not count as talking.
- Do not hear yourself: while the device is playing speech, or a cue, its own sound must not open or extend a recording.
- A cue when listening starts is optional (`listenCue`). If there is one, the microphone ignores it.
- When Axis sends `ask`, open the microphone straight away (with the cue) for up to 20 seconds. What is said goes up as an ordinary recording. Axis matches it to a choice; the client does not try to.

## 5. Speaking

For a `speaker` client:

- `speak.start` opens a stream, binary frames carry it, `speak.end` closes it. What is already buffered still plays after `speak.end`.
- Send `playback` with `started` when sound actually begins and `finished` when the last sample has played. Axis waits for `finished` before it calls the turn over, and tells an agent "heard" only on it. A client that could not make sound at all sends `blocked`. A client the person stopped sends `stopped`.
- Volume is the `volume` setting, 0 to 100, applied on the device. Declare it with the default the device really uses (a board's own level, 100 for an app on a computer that plays at the computer's volume): in quiet hours Axis sends `volume` capped at `quietVolume`, from the saved value or, when nothing is saved, from that declared default. An app applies it as a gain on its own sound (speech and cues) and never touches the system's volume.

## 6. Showing

For a `screen` client:

- Draw the vortex face from [docs/face.md](face.md). It is the product's look; a new board ports it and does not invent one. The face shows the state: idle, listening (green, moving with the voice), thinking, speaking (moving with the speech), problem, offline, setup.
- Put what was heard and the reply under or beside the face, and keep the END of a long reply visible.
- For `ask` with choices: keep the face when there is room, show the question, and draw each choice as a button big enough to tap. Send `answer` with the choice exactly as it was given. Take the buttons away on `ask.end` or after `timeoutMs`.
- For the `timer.next` command: show the label and the time left.
- For the `progress.show` command: show the task's title and how far along it is in one quiet line, with a thin bar if there is room. List the steps only when the person asks for them (a press on the line), and let no gesture that starts listening be lost to it. Never speak it, and never let it cover a question or a countdown.
- Turn incoming text into what the device's font can draw. Replies are UTF-8 and will contain curly quotes and dashes.

## 7. Settings

Axis is the source of truth. A client keeps a copy for when Axis is unreachable and asks for anything newer on connect.

- A client tells Axis what it reads with `describe`, sent after every `welcome`: each setting's key, label, kind (`number`, `text`, `toggle`, `choice`), group, help text, default, and range or options. The admin page draws its editor from this and Axis refuses values outside it. A setting the client reads but does not describe cannot be edited; a setting it describes but does not read does nothing. Keep the two in step.
- Use the shared keys where they fit, so one value set for all devices means the same thing everywhere:

| Key | Meaning | Default |
| --- | --- | --- |
| `volume` | Speech volume, 0 to 100. | 60 |
| `listenCue` | Play a tone when listening starts. | 1 |
| `wakeListen` | Listen for the wake word. | 1 |
| `wakeSense` | Wake word cutoff in percent, 0 for the model's own. | 0 |
| `followUpMs` | Listen after a spoken answer; 0 is off. Axis's (below). | 6000 |
| `onsetMs` | Wait for the first word. Axis's (below). | 6000 |
| `silenceMs` | Quiet that ends a sentence. Axis's (below). | 900 |
| `maxSpeechMs` | Longest sentence. Axis's (below). | 20000 |
| `rotation` | Screen rotation in degrees. | per board |
| `autoRotate` | Turn the picture with the device. | 1 |
| `brightness` | Screen brightness, 10 to 255. | per board |

- `location`, `voice`, `sentencePauseMs`, `wakeWord` and the four quiet-hours settings (`quietFrom`, `quietTo`, `quietVolume`, `quietBrightness`) belong to Axis. A client does not read or describe them. (`wakeWord` reaches a client as the `wake.model` command, not as a setting to interpret. Quiet hours need nothing from a client beyond reading `volume` and `brightness`: Axis sends them lower while they last, the saved value or else the client's declared default, capped.)
- The four listening keys (`followUpMs`, `onsetMs`, `silenceMs`, `maxSpeechMs`) are Axis's built-in settings (group Listening). Axis always sends them, its defaults beneath whatever is saved, so a `mic` client reads them and needs no numbers of its own beyond a fallback for an older Axis; it need not describe them (a description of the same key is overridden by Axis's). Its own loudness threshold for speech stays its own.
- `toolIcons` is Axis's too: how a client with the vortex face shows the `doing` of a `turn` while thinking, `dots`, `line` or `off` (`docs/face.md`, section 8).
- `idleLooksOff` is Axis's too, but a client with the vortex face reads it: the names of idle looks to leave out, separated by commas (`docs/face.md`, section 5).
- `capabilitiesOff` is Axis's too, set by an admin for one device: the capabilities, of those the device reported, that it should stop using, separated by commas (`mic,screen`). Axis already stops using them; a client that reads it should also stop doing them at once and come back when they leave the list: `screen` shows nothing, `speaker` plays nothing (answer `playback` with `blocked`), `mic` never opens the microphone, `desktop` refuses every `desktop.*` command. Absent or empty means nothing is off. Keep sending the full list in `hello`.
- `offlineAlert` (Axis 0.53.0) is Axis's own and server-only: it says when the admin page lists a device as needing attention for being offline. Axis never sends it to a device (`SERVER_ONLY_KEYS` in `server/src/schema.ts`), so a client neither reads nor describes it.
- A setting takes effect when it arrives, without a restart, unless that is impossible; say so in its help text when it is.

## 8. Commands

`command` asks a client to do something outside a turn; it answers `command.result` with the same `id`. A command it does not know is answered `ok: false`, never ignored.

| Command | Who must implement it | What it does |
| --- | --- | --- |
| `diag` | Every client. | Returns version, uptime, free memory, signal strength: flat values. |
| `reboot` | Every device (not apps). | Answers, then restarts. |
| `update` | Every device that can replace its own firmware. | Section 9. |
| `address` | Devices that store the address of Axis. | Moves to another address for the same Axis, keeping the pairing. Check the new address answers before changing anything, and go back to the old one if the connection through it is not welcomed. |
| `timer.next` | Clients with a screen. | Shows a countdown; `ms` 0 clears it. `id` names the timer: a client with a cancel control sends it to `POST /v1/timers/cancel` with its own token. |
| `desktop.look`, `desktop.point`, `desktop.hide` | Clients with `desktop` (experimental). | See the protocol README, "Computers". The look's answer goes in `command.result`'s `data`. |
| `ask.waiting` | Clients with a screen. | `elsewhere`: how many questions wait for the person that this client is not showing (on another client, or on none). Above 0, show something quiet that says so (boards pulse their edges blue; the desktop apps put a small blue line, "A question waits for you elsewhere", in their task pill); never cover a question, a countdown or a conversation with it. Forget it when the connection drops; Axis sends it again on connect. |
| `progress.show` | Clients with a screen. | Shows long work an agent is doing: `title`, `note`, `done` of `total` (`done` -1 and `total` 0 when the work has no steps), `state` (`running`, `blocked` when it waits for the person, `done`) and `count`. `count` 0 clears it. Optional `steps` (a step to a line, led by `x` done, `>` in hand, `-` to come) to list on request, `others` (the other tasks, a line each, led by `!` when one waits for the person) to list above them, and `chime: true` once when it has just finished, for a short sound if the client has a setting for one. Forget it when the connection drops; Axis sends it again on connect. |
| `reset` | Devices that keep a pairing. | Answers, then forgets its pairing, settings and stored wake word (and its Wi-Fi when `wifi` is 1) and restarts. Sent only from the admin page. |
| `wake.model` | Clients with a wake word of their own. | Switches to the wake word Axis names, fetching and keeping the model; an empty `id` means the built-in one. The built-in model must always remain as the fallback, and a model that will not run must not be retried at every start. |
| Its own actions | Optional. | Anything listed under `actions` in `describe`, such as a test tone. Flag the ones a person should confirm. |

Actions are how a person tests a device from the admin page and how an agent looks after one (`vortex.axis.admin`). A new board should offer at least a sound test when it has a speaker and a microphone level reading when it has one. Call that reading `mic` and return `room` (the room's level), `speechAbove` (the level speech must pass) and `level` (the loudest since the last reading), all on one scale: the admin page draws them as bars, reading it about once a second.

A client with a screen should also report its size in its regular `sense` readings, as `screenW` and `screenH` in pixels, the way up it stands now. The admin page draws the device at that shape. A round screen also reports `screenRound` 1: the admin page then draws it, and its edge glow preview, as a circle.

A client may also report the room it is in, and Axis shows it in Home Assistant when the MQTT link is set up:
- `soundDb`: how loud the room has been over the last few seconds, in dB of the microphone's full scale (a whole number, not calibrated sound pressure), and `soundActive`: 1 while there has been sound well above the room's usual level lately, else 0. Levels only, never audio, with the device's own speech left out. Send them only when they change, and offer a setting to turn them off. They become a **Sound level** sensor and a **Sound** binary sensor.
- Touch gestures it has no use for itself: send `gesture` with `hold`, `swipe_left`, `swipe_right`, `swipe_up` or `swipe_down`, directions as the screen shows them, and the reading `gestures: 1` so Axis knows to make the entity. They become events of a **Gesture** entity, for automations. A tap stays the client's own (talk, answer); do not send it. Drop gestures made while offline.

## 9. Updates

A device that can update itself over the network implements `update`: answer `ok: true`, fetch `path` from the Axis address it is already using with its own token (`Authorization: Bearer <token>`, `X-Axis-Client: <id>`), check the file against `md5`, install it somewhere that leaves the running firmware intact, and restart. The new firmware must be kept only once it has connected to Axis, and the device must go back to the old one by itself when it cannot. A device that cannot do all of that does not implement `update` and is flashed by cable.

## 10. Getting onto the network and pairing

- A device with no Wi-Fi it can join starts its own setup network and serves a page where a person enters the Wi-Fi details and a **setup string** from the admin page: `axis://host:port/code`, or `axis+tls://host/code` for an encrypted address. That one string is all it needs.
- It pairs once with the code and stores the client id and token it gets back. The token is the device's identity from then on; it is never shown, logged or sent anywhere but Axis.
- `unauthorized` from Axis means the pairing is gone: forget it and ask to be paired again. No other error does.
- Over `axis+tls://` the device checks Axis's certificate against public certificate authorities and refuses one it cannot verify.

## 11. Staying honest with Axis

- Answer WebSocket pings. Axis drops a client that misses them and shows it offline.
- A client that cannot see those pings (a browser, .NET, URLSession) sends `ping` every 15 s; Axis answers `pong`. Treat 40 s without any frame from Axis as a dead connection: close it, and connect again straight away when the device wakes or the network returns, without the usual wait.
- Send `sense` about once a minute with at least signal strength, free memory and uptime, so the admin page can show a device's health.
- Reconnect by itself, without a limit, with a few seconds between tries.
- Keep a log a person can read without a cable when the device has the memory for it (the Waveshare board serves its last 64 KB at `/logs`), and list it under `links` in `describe`.

## 12. Before calling a new client done

1. It pairs from a setup string and reconnects after a power cut and after Axis restarts.
2. Every capability it declares passes the "must" column in section 2.
3. A tap does the three things in section 3.
4. `describe` lists every setting it reads, and changing each on the admin page changes the device.
5. `diag` answers; `reboot` restarts it; an unknown command is refused, not ignored.
6. With a speaker: an announcement from the admin page is reported as heard only when it really played.
7. With a microphone: its own speech and cue do not open a recording; a sentence is sent whole, first word included.
8. With a screen: the face follows every turn state; a question's choices can be tapped; a timer counts down.
9. It updates over the network and survives a bad update, or it says it cannot.
10. Its folder has a README with the pins, the build steps and a list of tests a person ran, with what passed.

For an ESP32 board, most of this is already in `firmware/common/` (the shared client core): Wi-Fi setup, pairing, the socket, settings sync, recording with speech detection, the wake path, questions, timers, updates and TLS. A new board supplies the display, the speaker, the microphone and the input, and a table of its settings and actions, as `firmware/waveshare-amoled-1.8/` does.
