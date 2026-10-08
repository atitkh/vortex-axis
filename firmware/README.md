# Firmware

Clients for VorteX Axis that run on microcontrollers.

| Path | Contents |
| --- | --- |
| `common/` | The shared client core: Wi-Fi setup, pairing, the socket to Axis, settings sync, audio framing. Board-independent. |
| `waveshare-amoled-1.8/` | Waveshare ESP32-S3-Touch-AMOLED-1.8: pins, audio codec, display, touch, and the face. |
| `wake/` | The wake word detector (`axis-wake`): the TFLite Micro audio frontend and a streaming model. Board-independent. |
| `models/` | Wake word models. See its README. |
| `lib/` | Vendored libraries: TensorFlow Lite Micro with the ESP-NN kernels, and its audio frontend. Both come from the Mylo firmware; each has a `MYLO-PATCH.md` saying what was changed. |
| `tools/` | Build helpers: `gen_model_header.py` turns a model into a C header, `model_header.py` runs it during the build. |

Each board folder is a PlatformIO project. A new board should mostly describe its hardware and reuse `common/`.

## Building

PlatformIO lives in `~/.platformio/penv`. From a board folder:

```bash
~/.platformio/penv/bin/pio run                    # build
~/.platformio/penv/bin/pio run --target upload    # flash over USB
~/.platformio/penv/bin/pio device monitor         # serial log
```

On Linux the serial port needs to be accessible to your user. A udev rule for Espressif devices does it without a re-login:

```bash
echo 'SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", MODE="0666"' | sudo tee /etc/udev/rules.d/99-espressif.rules
sudo udevadm control --reload && sudo udevadm trigger
```

If reads or flashing fail with corrupt data, check that nothing else has the port open. On the development host a container that expects a different device on `/dev/ttyACM0` did exactly that. `/dev/serial/by-id/` gives each device a name that does not change with plug order.

## Setting up a device

1. A device with no Wi-Fi starts its own network, `VorteX-Axis-XXXX`, and shows the name on screen. Join it and open `http://192.168.4.1` (phones usually open it by themselves).
2. Pick your Wi-Fi and enter its password.
3. On the Axis admin page press **New pairing code** and copy the **setup string**. It looks like `axis://10.0.0.6:8440/483-221`: the address the device should reach Axis at, and a one-time pairing code. Paste it into the same form.
4. The device joins Wi-Fi, pairs, stores its token and fetches its settings.

The same page stays available at the device's own address afterwards, to change Wi-Fi or pair with a different Axis. If the device cannot join the saved network at boot (three failed tries or 45 seconds), the setup network comes back; with nobody on it for five minutes, the device tries the saved network again.

The serial port takes the same things as typed commands: `status`, `wifi <name> <password>`, `setup <axis://...>`, `text <words>` (a typed turn), `stop` (stop speaking), `forget`, `forget wifi`, `reboot`.

The address in a setup string must be plain `http` for now. `axis+tls://` is parsed but this firmware cannot connect to it yet, so a device only works on the same network as Axis.

## Settings a device reads

Set these in the admin page: open the device under Clients, then pick the layer (this device, all devices of this type, or everything). The board describes them itself (`SETTINGS` and `ACTIONS` in `main.cpp`, sent as `describe` when it connects), so a new setting needs one line there and nothing on the server. Keep that table in step with `applySettings()` and the client core's `vadLimits()`: a listed key that nothing reads does nothing.

| Key | Meaning | Default |
| --- | --- | --- |
| `rotation` | Screen rotation in degrees: 0, 90, 180 or 270 | 90 |
| `brightness` | Screen brightness, 10 to 255 | 200 |
| `volume` | Speaker volume, 0 to 100 | 60 |
| `wakeListen` | 1 to listen for the wake word, 0 for tap-to-talk only | 1 |
| `wakeSense` | Wake word cutoff in percent, 50 to 99. Lower wakes more easily. 0 uses the model's own (87) | 0 |
| `bargeIn` | 1 lets the wake word interrupt the device while it talks, 0 ignores it until it has finished | 1 |
| `followUpMs` | After an answer that was spoken to the end, keep listening this long for a reply without the wake word. 0 turns it off | 6000 |
| `listenCue` | 1 plays a short rising tone whenever the device starts listening, 0 is silent | 1 |
| `onsetMs` | How long to wait for the first word after a wake or tap, 1000 to 20000 | 6000 |
| `silenceMs` | Quiet that ends what you said, 300 to 5000 | 900 |
| `maxSpeechMs` | Longest single utterance, 3000 to 60000 | 20000 |

## The face

The full specification (every look's numbers, the drawing steps, the voice rules and which look shows when) is [docs/face.md](../docs/face.md). A new board should draw the face from it. The web client draws the same face from `web/vortex.js`; a change to a look or a rule goes into the spec and both implementations together.

The default face is a vortex: dots on three spiral arms, drawn on the device from the turn state Axis sends. Nothing is streamed as pixels.

| State | Look |
| --- | --- |
| Idle | A slow spin that changes at random every 7 to 17 seconds between seven looks (calm, breathe, unwind, open, curl, drift, shimmer) |
| Listening | Pulls inward, green |
| Thinking | Spins fast, violet |
| Speaking | Opens and pulses with the loudness of the voice as it plays, white-blue |
| Problem | Slow and red |
| No Axis or no Wi-Fi | Small, dim and grey |
| Setup | Amber |

Text sits under the face: what was heard, the reply, or what is wrong (which service is down, "Can't reach Axis"). With nothing to say, the face sits in the middle of the screen; when text is needed it slides up and the text appears once it is out of the way.

## Sound

Speech arrives as raw audio on the socket and is queued in a four-second buffer (Axis is told two seconds and paces itself to that). A separate task plays it through the ES8311 codec. The codec always runs at 16 kHz, so audio at any other rate is resampled on the device; the microphone will share that clock.

The device tells Axis when sound actually starts and when the last sample has left the speaker, which is what lets an agent know a message was heard. A short two-note chime at boot shows the speaker works before anything is connected.

## Listening

The microphone and the speaker share one 16 kHz stream from the ES8311 codec. A task of its own reads it in 10 ms blocks. Every block goes to two places: the shared client core, and the wake word detector.

- **Wake word.** "Hey Vortex" is built into the firmware from `models/hey_vortex.tflite` (the model's cutoff and window come from its `.json`, so the two cannot drift apart). The detector costs about 3 ms of every 30 ms, all the time, on the device. Audio never leaves the device before it fires.
- **After a wake** the device tells Axis (`wake` with a score and loudness), keeps listening meanwhile, and starts a recording when Axis grants it. If another device is closer, Axis tells this one to stand down and it throws the audio away.
- **Tap to talk.** One tap on the screen starts listening when idle, ends a recording early while listening, and stops an answer while it is speaking or being worked out. Taps are short and do not move; anything longer or wider is ignored.
- **Where speech starts and ends** is decided on the device from loudness alone. The room's own level is followed all the time, so a fan raises the bar instead of sounding like a person. Speech starts when it clears that level by a good margin for two blocks in a row, and ends after `silenceMs` of quiet or at `maxSpeechMs`. If nobody speaks within `onsetMs` the recording is cancelled and Axis is told.
- **Only what was said is sent**: about 200 ms before the first word, through the last. Silence before it is never uploaded.
- **Interrupting.** The wake word works while the device is talking (`bargeIn`): speech stops at once and a new recording begins. The device's own voice is kept out of the room-level estimate, and the quarter second after cutting speech is ignored so the tail of the old sentence is not mistaken for the new one. There is no echo cancellation and the speaker sits next to the microphone, so the wake word scores low over speech (0.36 to 0.43 against a cutoff of 0.87 in a real test). When it scores 0.25 or more while the device talks, the speaker ducks to 12% for 1.5 s so the rest of the phrase arrives clean (`[wake] ... ducking the speaker` in the log). A proper fix would be an echo canceller: the exact playback signal is known on the device.

- **Follow-up.** When an answer to something you said has been spoken to the end, the device listens for `followUpMs` without the wake word. Silence ends it quietly. It does not open after an answer that was cut off, after something Axis said unprompted, or when the agent answered `NO_REPLY` or nothing (Axis neither shows nor speaks those, so there is no speech to follow).
- **Cue.** A short soft rising tone plays when listening starts after a wake or a tap. Not for follow-ups: the face turning green is enough when the device was just talking. The microphone ignores the next 300 ms so the cue is not taken for speech. Set `listenCue` to 0 to turn it off.
- **Log over Wi-Fi.** `http://<device address>/logs` shows the last ~64 KB of the device log (about two hours when idle), stamped with the uptime in seconds; `?tail=4000` limits it to the last bytes. It also appears as "Device log" on the setup page. The wake detector logs "near miss" lines (score and whether the device was speaking), which is what to read when "Hey Vortex" is not heard.

The face goes green and pulses with your voice while listening (the size follows how far you are above the room's own level).

## Status

Milestones 1 to 4 of 5 are done on the Waveshare board: display, Wi-Fi setup network, pairing, the socket to Axis with settings sync, the face, the speaker, the microphone with tap-to-talk, and the "Hey Vortex" wake word.

Tried on the real board with nobody in the room, using the board's own speaker as the sound source: tap-to-talk into a quiet room (cancels after `onsetMs`), tap-to-talk with a sound (recorded, trimmed by silence, transcribed, answered, spoken), the wake word recognised from the board's own voice saying "Hey Vortex" (scores 0.94 to 0.98), a wake being granted by Axis, and interrupting a spoken answer with the wake word.

**Tried by a person (2026-10-08):** wake word, tap-to-talk, follow-up, NO_REPLY, cue, green face, transcripts: all good. Wake word over a long answer does NOT stop speech (accepted for now, tap to interrupt). See "Tests for a person".

Measured: the face is now sent to the panel four rows at a time (960 pixels, under the driver's 1024 limit), which cut a frame from 31 ms to about 21 ms. The wake word costs about 3 ms in every 30, on the other core. With everything running, 118 KB of internal memory is free and the lowest seen is 115 KB.

Build order: (1) display, Wi-Fi setup, pairing and a face that follows Axis's state; (2) speaker; (3) microphone with tap-to-talk; (4) wake word; (5) polish and updates over Wi-Fi.

Also built (0.7.0): questions from an agent with choices to tap or say, and a countdown for timers kept on Axis.

Not built yet: updates over Wi-Fi, `axis+tls://`, choosing the wake word model from Axis instead of at build time.

## Tests for a person

All done by Atit on 2026-10-08, with the exceptions noted.

1. [x] Say "Hey Vortex" from a metre away. The face should turn green within about half a second. Then ask something. Repeat from across the room and with the TV on. Note misses and false wakes.
2. [x] Tap the screen while idle: green face, speak, stop talking. It should send after about a second of quiet.
3. [x] Tap once while it is listening, before and after you speak: it should finish early, or cancel if you had said nothing.
4. [x] Tap while it is speaking or thinking: it should go quiet and return to the idle face.
5. [x] Say "Hey Vortex" while it is speaking a long answer: it should stop and listen. If it triggers on its own voice, set `bargeIn` to 0 in the admin page. **Tried 2026-10-08: does not work** (the wake word does not stop speech mid-answer even with ducking). Accepted for now; tap the screen to interrupt. An echo canceller is the real fix.
6. [x] Say nothing after the wake word: it should give up after about six seconds with no error.
7. [x] Check the transcripts: words cut at the start mean the pre-roll or settle time is wrong, misheard words mean the microphone gain is.
8. [x] Leave it alone for an hour and read the `[mic]` serial lines for false wakes (`wake: N heard`).
9. [x] Say whether the speaker buzz you reported is gone (codec gain and resampling changed in 0.3.x). No report back after the 0.5.1 resampler fix.

Added in 0.5.0 (follow-up, cue, log page, livelier listening face):

10. [x] Ask something, let it answer, then reply WITHOUT the wake word within six seconds: it should take your reply. Say nothing: the green face should end quietly after six seconds.
11. [x] Make the agent answer nothing (ask it to reply `NO_REPLY`): nothing is spoken or shown and it does not open a follow-up.
12. [x] Listen for the rising tone on wake and on tap (not on follow-up, removed at his request). Check it is not so loud it is picked up as your speech, and that your first word after it is not lost. `listenCue` 0 turns it off.
13. [x] While listening, talk at different volumes: the green face should swell and shrink with your voice.
14. [x] Open `http://10.0.0.49/logs` after trying "Hey Vortex" over a long answer and look for `[wake]` lines.
15. [x] Say "Hey Vortex" over a long answer again (any volume): the speech should dip as you start the phrase and the device should stop and listen. If not, `/logs` shows whether the score rose (`ducking the speaker`). **Tried 2026-10-08: does not work** (the wake word does not stop speech mid-answer even with ducking). Accepted for now; tap the screen to interrupt. An echo canceller is the real fix.
16. [x] Is the buzz gone or lighter (0.5.1 resampler)? No report back after the 0.5.1 resampler fix.

Resampling: speech arrives at 24 kHz and the codec runs at 16 kHz. Until 0.5.1 this used linear interpolation, which let everything above 8 kHz fold down into the audible range (measured with `probe`: a 1 kHz tone came back with a 7 kHz ghost only 34 dB down, a 9 kHz tone folded to 7 kHz at full strength). It is now a 24-tap windowed-sinc low-pass evaluated at the exact output time (ghost -53 dB, 9 kHz tone about 25 dB lower). The display is NOT the source of the buzz: `probe` shows no sidebands at the frame rate with the face running or paused.

Added in 0.7.0 (questions and timers), not yet tried by a person:

17. [ ] Have the agent ask a question with choices ("ask me on the board whether I want tea or coffee"). It should speak the question, play the cue, and show the question with one choice per row filling the screen. Tap a choice: the agent should get exactly that one. Check the row you tapped is the one it took (the log line `[ask] tap at ...` shows where the tap landed); try it at another `rotation` too.
18. [ ] The same question, answered by voice ("coffee", "the second one"). The question text turns green while it listens. The agent should get the choice, and the words must not be answered as a normal turn.
19. [ ] An open question with no choices ("ask me what to call the new timer"): the face stays, the question shows under it, and the agent gets your words.
20. [ ] Ask a question and say nothing: after the timeout the choices go away and the face comes back.
21. [ ] Set a timer by voice ("set a two minute pasta timer"). "pasta 1:59" should count down above the face area while idle. When it is due: the chime, then "Your pasta timer is done." Set two and check "(+1)". Cancel one by voice.
22. [ ] Unplug the board with a timer running and plug it back in before it is due: the countdown should come back.

Questions: `ask` from Axis puts the question in the snapshot (`askId`, `question`, `choices`). The core opens the microphone with the cue for up to 20 seconds and leaves matching a spoken answer to Axis. With choices the board hides the face and draws the question (two lines) and one row per choice; a tap is turned from panel to logical coordinates (`display::toLogical`) and the row under it is sent with `client.answer(index)`. `ask.end`, the question's own timeout or a lost connection clears it. Timers live on Axis; the board only shows the one Axis names in the `timer.next` command.

Added in 0.6.0 (device editor in the admin page): open the board under Clients. Its settings are grouped (Screen, Sound, Listening) with the three layers as tabs and "On this device: X (from ...)" next to each; actions are `Play listening cue`, `Play chime`, `Start listening`, `Microphone levels`, `Diagnostics`, `Reboot`; links open its log and setup page; Announce speaks a line on it.

Serial commands added: `talk` (tap-to-talk), `mic` (room level and thresholds), `wake` (pretend the wake word was heard), `chime` (play the boot chime), `cue` (play the listening cue), `probe HZ RATE [pause]` (play a tone through the speech path, record it with the microphone and print the spectrum; `pause` stops drawing the face meanwhile).
