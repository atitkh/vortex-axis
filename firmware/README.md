# Firmware

Clients for VorteX Axis that run on microcontrollers.

| Path | Contents |
| --- | --- |
| `common/` | The shared client core: Wi-Fi setup, pairing, the socket to Axis, settings sync, audio framing. Board-independent. |
| `waveshare-amoled-1.8/` | Waveshare ESP32-S3-Touch-AMOLED-1.8: pins, audio codec, display, touch, and the face. |
| `waveshare-amoled-1.75/` | Waveshare ESP32-S3-Touch-AMOLED-1.75, the round one: the same firmware laid out in a circle, with two microphones. See "The round board" below. |
| `wake/` | The wake word detector (`axis-wake`): the TFLite Micro audio frontend and a streaming model. Board-independent. |
| `models/` | Wake word models. See its README. |
| `lib/` | Vendored libraries: TensorFlow Lite Micro with the ESP-NN kernels, and its audio frontend. Each has a `PATCHES.md` saying where it comes from and what was changed. |
| `tools/` | Build helpers: `gen_model_header.py` turns a model into a C header, `model_header.py` runs it during the build, `gfx_font.py` makes a font header from a TrueType font. Bench helpers for the round board: `screen_shot.py`, `send_file.py`. |

Each board folder is a PlatformIO project. A new board should mostly describe its hardware and reuse `common/`.

Firmware versions are counted per board type. The 1.8 uses the client core's default (`AXIS_FIRMWARE_VERSION` in `common/src/axis_client.h`); a board that counts its own sets `-D AXIS_FIRMWARE_VERSION=\"x.y.z\"` in its `platformio.ini`. `node scripts/firmware-version.mjs <board folder>` prints the one a folder builds, and the release and upload scripts use it.

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

## Updating over Wi-Fi

Since 0.8.0 a device updates itself from Axis, so the cable is only for the first install and for rescue.

```
~/.platformio/penv/bin/pio run                                   # in the board folder, after bumping AXIS_FIRMWARE_VERSION
AXIS_ADMIN_TOKEN=... node scripts/push-firmware.mjs waveshare-amoled-1.8 --update   # from the repository root
```

Without `--update` it only puts the build on Axis, where the admin page and the web flasher at `/flash` offer it (the flasher lists only boards whose firmware was pushed); with `--update` it also tells every online device of the type that is on another version to install it. A release of a board's firmware is tagged `fw-<board>-v<version>` on the commit that set the version; the full list of steps is in `docs/release.md` (**Firmware**), and `node scripts/release-check.mjs` checks the version, the CHANGELOG, the tag and what the hub offers. The screen shows "Updating" with a percentage; the device restarts by itself after about 25 seconds. The same can be done on the admin page, on the client type's page. The new firmware is kept once it has reached Axis; if it cannot within three minutes the device goes back to the old one by itself. Done three times on the real board (0.8.0 to 0.8.3).

## Setting up a device

1. A device with no Wi-Fi starts its own network, `VorteX-Axis-XXXX`, and shows the name on screen. Join it and open `http://192.168.4.1` (phones usually open it by themselves).
2. Pick your Wi-Fi and enter its password.
3. On the Axis admin page press **New pairing code** and copy the **setup string**. It looks like `axis://192.168.1.20:8440/483-221`: the address the device should reach Axis at, and a one-time pairing code. Paste it into the same form.
4. The device joins Wi-Fi, pairs, stores its token and fetches its settings.

The same page stays available at the device's own address afterwards, to change Wi-Fi or pair with a different Axis. If the device cannot join the saved network at boot (three failed tries or 45 seconds), the setup network comes back; with nobody on it for five minutes, the device tries the saved network again.

The serial port takes the same things as typed commands: `status`, `wifi <name> <password>`, `setup <axis://...>`, `text <words>` (a typed turn), `stop` (stop speaking), `forget`, `forget wifi`, `reboot`.

A setup string that starts `axis+tls://` (the admin page makes one when the device address is typed with `https://`) makes the device talk to Axis over TLS, on port 443 unless another is given. Axis must then present a certificate from a public authority. Type `tlscheck https://that-address/` on the serial console first: it says whether the device can reach and trust it. Since 0.8.2; checked against public sites, not yet against a real Axis address.

## The round board (Waveshare ESP32-S3-Touch-AMOLED-1.75)

`waveshare-amoled-1.75/`, type `waveshare-amoled-1.75`, its own firmware versions from 0.1.0. It does what the 1.8 does, with its `main.cpp` following the 1.8's line for line; the face (`vortex.cpp`, `icons.h`) and the fonts are the 1.8's files, linked, so there is still one copy of the board face. What differs, and why:

- **Zoomed in** (since 0.3.0): the same layout about 1.2 times the 1.8's, to fill the bigger screen. The face is drawn 288 pixels square instead of 240 (`-D VORTEX_SIZE=288` in `platformio.ini`; `vortex.cpp` scales every size in it, dots, wander, core and icons, by `vortex::SCALE`), body text is FreeSans 12 point (the 1.8's 9), headings FreeSans Bold 15 (12) and buttons FreeSans 15 (12), with the bands and buttons sized to match (body rows 28 pixels, headings 38, button rows up to 68). The 15-point fonts were made with `tools/gfx_font.py` from GNU FreeFont, as the Adafruit GFX Library makes its own.
- **Text size** (since 0.3.1): the `textSize` setting picks the text and buttons, live, without a restart; the face over text stays 288. `small` is 0.2.2's look (body 9 point, headings Bold 12, buttons 12; rows 22, 30, up to 56; four body rows under the heading), `medium` the default (11, Bold 14, 14; rows 26, 36, up to 64; three body rows), `large` 0.3.0's (12, Bold 15, 15; three body rows). Every measure that follows from the size is in one table in `display.cpp` (`SIZES`); `main.cpp` asks `display::lineHeight()` and `display::buttons()` each time it lays out, so nothing holds an old size, and a change clears the screen and draws it again. The 11- and 14-point fonts were made with `tools/gfx_font.py` too.
- **A bigger face when idle** (since 0.4.0): with the screen to itself the face is drawn at the `idleFace` setting's size, `normal` 288 (as before), `large` 360 (the default) or `max` 380, in the middle; when text, a question, a timer or anything else needs room it shrinks to 288 while it slides to the top, both together over 300 ms (eased in and out), and grows back the same way. The face's frame is made once at the biggest size in PSRAM (`-D VORTEX_MAX_SIZE=380`) and `vortex::setSize()` draws at any size up to it, everything to scale. Text, a question's words and its buttons appear only once a frame has gone out at the small size at the top (that frame blacks out what the bigger one left). 380, not 400: at 400 the widest idle looks (open, orbit) would come within about 36 pixels of the glass; measured over two minutes each, the figure came no closer than 50 pixels at `max` and 55 at `large`.
- **Only what the face drew is sent** (since 0.4.0): `vortex::drawn()` gives the box the dots covered, and each frame sends that box and last frame's, blacking out any of last frame's box that falls outside the square now (when it moved or shrank); the frame itself is blacked out only where it was drawn on (`setLazyClear`, on for this board only). Writes go to the panel with their bytes turned round in internal memory first (`display.cpp`'s `send()`), a third quicker than the library's own pixel path.

- **Screen.** 466 by 466, round, CO5300 driver with its own reset pin (nothing behind the IO expander). The panel's columns start 6 in (`screenOffset` defaults to 6; "Show screen edges" draws a ring along the glass). Rotation is still done in software; the panel is square, so the layout is the same each way up. Default `rotation` 0.
- **Layout in a circle.** A line of text is only as wide as the chord across the circle at its row (`display::roomAt`): headings are cut to it, replies are wrapped row by row to it (broken at the narrowest width when they run over and scroll), rows narrower than 270 pixels are not used, question buttons share the chord of their row with a margin to the edge, and a question that takes the whole screen starts where the circle is wide enough. The face sits at the very top while there is text (its round figure still inside the glass), leaving three rows of body text under the heading, and in the middle otherwise. A question with the face keeps to two lines; one that takes the whole screen may have three.
- **Edge glow** is a ring 12 pixels deep just inside the glass, drawn in bands; there are no corners, so there is no `glowCorner` setting. Since 0.4.0 it works in the panel's own coordinates: how much glow each pixel gets (and how far round the screen it is, for a timer's sweep) is a table made once in PSRAM, so no square roots or angles are worked out as it draws, and each band of 12 rows goes out as one or two writes whatever the rotation; over black (most of it) the colour is looked up too. Where the face's box overlaps the ring the face lays the glow into its own frame (`glow::tint`), and the ring leaves that box alone. The board reports `screenRound` 1, and the admin page draws it, and its glow preview, as a circle.
- **Touch** is a CST9217 at 0x5A with its own reset pin. It needs a repeated start between the register address and the read (with a STOP it carries on reading from where it was), and its interrupt only pulses, so it is read every frame; a finger counts as lifted after 200 ms without a report.
- **Sound.** ES8311 plays, ES7210 records, on one 16 kHz I2S stream with 32-bit slots. With four inputs on, the ES7210 packs two 16-bit samples into each slot: MIC1 then MIC3 on the left, MIC2 then MIC4 on the right. MIC1 and MIC2 are the two microphones, averaged into the one stream the client core and the wake word use; MIC3 is the ES8311's output, the echo canceller's reference (the 1.8 gets the same from its codec's loopback). Same 30 dB microphone gain as the 1.8, 0 dB on the reference. The amplifier enable (GPIO46) is switched on once at boot and left alone.
- **Motion.** QMI8658 at 0x6B as on the 1.8; the axes are taken to run as on the 1.8 (X towards the panel's top, Y towards its right), which is what Waveshare's own tilt demo implies. Not yet seen turning by a person.
- **Not used yet:** the IO expander's inputs (power button state, RTC, power chip and motion interrupts), the power chip's battery readings, the clock, the TF card slot.

Serial commands on this board besides the shared ones: `mics` (rms of the four 16-bit inputs as they arrive, `mics tone` plays a 1 kHz tone meanwhile), `motion` (gravity and the rotation it calls for), `touch` (raw reports), `pcm` (a file sent over the cable, played as speech or shown as a JPEG), `edges`, `glow <kind>`, `preview <state>` (a made-up question, reply, timer, task, listening, setup screen or error laid over the screen for a minute, to check a layout without Axis; `preview` alone lists them), `capsoff mic,speaker,screen` (acts as if an admin had switched those off on the Axis admin page; `capsoff` alone goes back to the setting), `set textSize small|medium|large` and `set idleFace normal|large|max` (stand in for those settings the same way; `set textSize` alone goes back to it), `preview idle` (nothing to say: the face with the screen to itself), `glow <kind> [seconds]`, `fps` (frames a second since it was last asked, the time a face frame takes and how much of it is drawing, the edge glow's share, the heap, and how close the figure came to the glass), `still` and `still off` (the face is sent as usual but holds still, and so does a slide under way, so `shot held` shows the panel without tearing), `bench` (what panel writes of a few shapes cost), `shot held` (prints what the panel holds as it is, nothing drawn again, to check that nothing was left behind; the face may tear, since it moves while the rows go out), and `shot`, which prints the whole screen as runs of colour (draws everything again into a kept copy first, since the panel cannot be read back). `tools/screen_shot.py` turns `shot` into a PNG (it can send a `preview` first), and `tools/send_file.py` sends a file for `pcm` ("Hey Vortex" from the speech service, or a test JPEG).

Measured on the real board (2026-10-26, nobody watching the screen; the screen checked through `shot`): 29 fps with the face at 21.7 ms a frame (0.1.0's 240 face; 0.3.0's 288 face over text: 26 to 28 fps; 0.4.0: see its CHANGELOG entry), the wake word 3.2 ms a run, no microphone stalls, touch read 30 times a second with no failed reads, a 1 kHz tone through the speech path heard at 1000 Hz with the 2nd harmonic 35 dB down, room level about 15 (rms) on each microphone in a quiet room.

## Settings a device reads

Set these in the admin page: open the device under Clients, then pick the layer (this device, all devices of this type, or everything). The board describes them itself (`SETTINGS` and `ACTIONS` in `main.cpp`, sent as `describe` when it connects), so a new setting needs one line there and nothing on the server. Keep that table in step with `applySettings()` and the client core's `vadLimits()`: a listed key that nothing reads does nothing.

| Key | Meaning | Default |
| --- | --- | --- |
| `rotation` | Screen rotation in degrees: 0, 90, 180 or 270 | 90 |
| `brightness` | Screen brightness, 10 to 255 | 200 |
| `textSize` | Size of the words and buttons, `small`, `medium` or `large`; the face does not change. `small` is the 1.8's look before 0.20.0 (body 9 point, headings Bold 12, buttons 12), `medium` 11, 14, 14, `large` 12, 15, 15. The 1.8 since 0.20.0, the round board since 0.3.1 | `medium` |
| `idleFace` | Size of the face with the screen to itself; with text it shrinks to its normal size at the top. 1.8 (since 0.20.0): `normal` 240 pixels, `large` 264, `max` 288. Round board (since 0.4.0): 288, 360, 380 | `large` |
| `maxFps` | Frame rate limit: the most frames a second the screen draws, 20, 30, 45 or 60. The 1.8 since 0.20.0, the round board since 0.4.1 | 30 |
| `glowCorner` | 1.8 only: how round the edge glow turns the corners, 12 to 120 pixels | 56 |
| `volume` | Speaker volume, 0 to 100 | 60 |
| `wakeListen` | 1 to listen for the wake word, 0 for tap-to-talk only | 1 |
| `wakeSense` | Wake word cutoff in percent, 50 to 99. Lower wakes more easily. 0 uses the model's own (87) | 0 |
| `bargeIn` | 1 lets the wake word interrupt the device while it talks, 0 ignores it until it has finished. Experimental: see "Interrupting" | 0 |
| `echoCancel` | 1 takes the device's own voice out of the microphone while it talks. Only used when `bargeIn` is 1 | 1 |
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

Text sits under the face: what was heard, the reply, or what is wrong (which service is down, "Can't reach Axis"). With nothing to say, the face sits in the middle of the screen; when text is needed it slides up and the text appears once it is out of the way. On both boards the face is also bigger in the middle (`idleFace`; the 1.8 since 0.20.0) and shrinks as it slides up, size and place together over 300 ms.

On the 1.8 since 0.20.0 (the round board's 0.3.1 to 0.4.1, on a rectangle):

- **Text size** (`textSize`): the same three sizes as the round board, in one table in `display.cpp` (`SIZES`: body rows 22, 26, 28 pixels, headings 30, 36, 38, button rows up to 56, 64, 68); `main.cpp` asks `display::lineHeight()` and `display::buttons()` each time it lays out. Under the face that leaves 7, 5 and 5 body rows standing up, 4, 3 and 3 lying down. A question that takes the whole screen may have three lines (two under the face).
- **Idle face** (`idleFace`): 240, 264 or 288 in the middle (`-D VORTEX_MAX_SIZE=288`, `vortex::setSize()`), shrinking to 240 at the top for text, a question or a timer; text and buttons appear once a frame has gone out at 240 at the top. Measured with the widest idle look (`set idleLook open`, `fps`): the figure stays 66 pixels from the nearest edge at 240, 54 at 264 and 42 at 288, outside the 12-pixel glow.
- **Only what the face drew is sent**, writes byte-swapped into internal memory first, and text bands lying sideways sent a few panel rows per write: a face frame takes 7 to 11 ms (was about 22).
- **Edge glow** from a table made once in PSRAM in the panel's own coordinates (the rounded rectangle is the panel's whatever the rotation; made again when `glowCorner` changes), over black looked up, down the sides joined into one write per piece; the face lays the glow into its own frame where they meet (`glow::tint`). A glow no longer costs frames: 30 fps with `waiting` or `timer` (0.19.1: 6.8 and 4.3).
- **Console**: `set textSize|idleFace|maxFps|rotation|idleLook <value>` (stand in for the setting, or turn the screen, on the bench; the key alone goes back), `preview <state>` (as the round board's), `glow <kind> [seconds]`, `fps` (frame rate, frame and glow cost, heap, how near the figure came to the edge), `still`/`still off`, `edges`, `shot` (the screen as runs of colour; `tools/screen_shot.py OUT.png --turn 270` turns it the right way up), `shot keep`/`shot keep off` (this board keeps no copy of the panel unless asked) and `shot held` (that copy as it stands).

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
- **Interrupting.** The wake word works while the device is talking (`bargeIn`): speech stops at once and a new recording begins. The device's own voice is kept out of the room-level estimate, and the quarter second after cutting speech is ignored so the tail of the old sentence is not mistaken for the new one. There is no echo cancellation and the speaker sits next to the microphone, so the wake word scores low over speech (0.36 to 0.43 against a cutoff of 0.87 in a real test). When it scores 0.25 or more while the device talks, the speaker ducks to 12% for 1.5 s so the rest of the phrase arrives clean (`[wake] ... ducking the speaker` in the log). 

  Since 0.11.0 there is an echo canceller (`echoCancel`, used only while `bargeIn` is on), and `bargeIn` is off by default. The codec returns what it is playing on the right I2S channel (ES8311 register 0x44 = 0x58), which is the reference Espressif's `esp_aec` needs, already lined up with the microphone. Measured on a real board with real speech (2026-10-09, the `[aec]` line in the log after each stretch of speech):
  - At full microphone gain the speaker drives the microphone into its limit (rms 17000, 21% of samples at the limit, volume 87). Nothing can be cancelled from that, so the microphone's analog gain drops 24 dB while the device talks and the cleaned signal is multiplied back up.
  - Own voice taken out: about 21 dB at volume 40 and below, 10 to 12 dB at volume 87. The small speaker distorts when loud, and distortion is not in the reference.
  - Cost: 4 to 5.5 ms per 32 ms frame on core 0, 7 KB of internal memory and 100 KB of PSRAM (`AEC_MODE_SR_HIGH_PERF`, filter length 4).
  - It does NOT stop the device waking on its own voice. With cancelling off, five of its own "Hey Vortex" scored nothing (the overloaded microphone hears mush). With cancelling on, the cleaned signal is intelligible and one of five scored 0.96. That is why `bargeIn` is off by default.
  - Not tried: a person saying the wake word over speech with cancelling on. Worth trying at volume 50 or lower before giving up on it.
  - Seen in the same test: a second board in the room woke on the first board's spoken "Hey Vortex". `bargeIn` does not cover that.

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

Milestone 5 and after (firmware 0.8 to 0.11.4, all on both boards):

- Updates over Wi-Fi with rollback; an encrypted link (`axis+tls://`); moving to another address for Axis without pairing again; wake word models fetched from Axis; a reset from the admin page.
- A smoother font, auto-rotate from the motion sensor, an adjustable picture offset.
- **Memory:** the framework takes the buffers for an encrypted connection from internal memory (about 45 KB), which left about 32 KB free and 15 KB at worst. Since 0.11.2 they come from PSRAM (`mbedtls_platform_set_calloc_free` in `Client::begin`): about 83 KB free, 68 KB at worst, with no change in connect time.
- An echo canceller (0.11.0), used only with `bargeIn`; `bargeIn` is off by default. See "Interrupting".
- Seven more idle looks, with arms that sway and a figure tipped at an angle (0.11.1); idle looks can be switched off from Axis (`idleLooksOff`, 0.11.3).
- The board reports its screen size, the way up it stands (`screenW`, `screenH`, through `Client::setReading`, 0.11.4).

Known and unexplained: after a reset triggered over the serial cable, the log can fill with `i2cWrite(): i2c_master_transmit failed: [259] ESP_ERR_INVALID_STATE` (the touch and motion sensors' bus). A power-on start does not show it.

## Tests for a person

All done by the owner on 2026-10-08, with the exceptions noted.

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
14. [x] Open `http://<the board's address>/logs` after trying "Hey Vortex" over a long answer and look for `[wake]` lines.
15. [x] Say "Hey Vortex" over a long answer again (any volume): the speech should dip as you start the phrase and the device should stop and listen. If not, `/logs` shows whether the score rose (`ducking the speaker`). **Tried 2026-10-08: does not work** (the wake word does not stop speech mid-answer even with ducking). Accepted for now; tap the screen to interrupt. An echo canceller is the real fix.
16. [x] Is the buzz gone or lighter (0.5.1 resampler)? No report back after the 0.5.1 resampler fix.

Resampling: speech arrives at 24 kHz and the codec runs at 16 kHz. Until 0.5.1 this used linear interpolation, which let everything above 8 kHz fold down into the audible range (measured with `probe`: a 1 kHz tone came back with a 7 kHz ghost only 34 dB down, a 9 kHz tone folded to 7 kHz at full strength). It is now a 24-tap windowed-sinc low-pass evaluated at the exact output time (ghost -53 dB, 9 kHz tone about 25 dB lower). The display is NOT the source of the buzz: `probe` shows no sidebands at the frame rate with the face running or paused.

Added in 0.10.0 (wake words from Axis):

26. [ ] On the admin page, Wake words: "Hey Vortex" is stored and this board is set to listen with the stored copy (`wakeWord` = `hey-vortex` on the device). It should wake exactly as before; the log's first `[wake]` line says `"Hey Vortex" loaded` without "(built-in)". Set Wake word back to `built-in` on the device's page: the board restarts within a few seconds of being idle and the log says "(built-in)" again.
27. [ ] Upload a different microWakeWord model with its manifest, choose it, and say the new phrase.

How it works: `axis::loadStoredWakeModel` (client core) reads `/wake.tflite` from the flash partition for files into PSRAM, checked against the checksum Axis gave, and `mic::loadWakeWord` hands it to `wake::begin`, which falls back to the built-in model if it will not load. The `wake.model` command from Axis fetches or drops the file and restarts the device when it is idle. Measured with the stored copy: 2.5 ms an inference, the same as the built-in.

Added in 0.9.0, not yet seen by a person:

23. [ ] The text. Everything is now drawn in FreeSans (headings bold, body regular, buttons a size up) and not the blocky built-in font. Check a long reply, a question with buttons, the timer line and the setup screens. Curly quotes, dashes and accented letters should come out as plain ones, and emoji as nothing.
24. [ ] Turn with the device (`autoRotate`, on by default). Stand the board on each of its four edges for a second: the picture should turn upright each time. Lying flat it should stay as it was. 0.9.0 had this a quarter turn out (standing upright showed the picture sideways); 0.9.1 corrects it. The two landscape ways are set from a reading on the real board, the two portrait ways are worked out from the sensor's axes and not yet seen. If one way comes out wrong, run the "Which way up" action on the admin page in that position and report the numbers.

25. [ ] Picture offset (0.9.2). On this board everything sat to one side in portrait, and in flipped landscape the top of the picture came back in at the bottom and stayed as stains: the panel driver's column offset (16, the value that suited another unit of this board) was too large for this unit. It is now the `screenOffset` setting, set to 0 for this device. Run "Show screen edges": all four sides of the frame should be visible and the cross in the middle. If one side is missing or doubled, change `screenOffset` while the frame shows.

Text: `display::textLine` takes 2 (body) or 3 (heading); widths are measured (`display::textWidth`), lines are wrapped by width in `main.cpp`, and `display::plain` turns UTF-8 into what the fonts hold. The fonts are in `src/fonts/`, from the Adafruit GFX Library (the round board's 15-point ones made the same way by `tools/gfx_font.py`). Motion: `src/imu.cpp` reads the QMI8658 accelerometer from the main loop; an edge must carry 0.55 g and hold for 0.9 s before the picture turns.

Added in 0.7.0 (questions and timers). Tried by the owner on 2026-10-08: tapping a choice and all the timer tests work. The 0.7.1 button layout and timers showing on every screen are not yet seen by a person:

17. [ ] Have the agent ask a question with choices ("ask me on the board whether I want tea or coffee"). It should speak the question, play the cue, and show the question with one choice per row filling the screen. Tap a choice: the agent should get exactly that one. Check the row you tapped is the one it took (the log line `[ask] tap at ...` shows where the tap landed); try it at another `rotation` too.
18. [ ] The same question, answered by voice ("coffee", "the second one"). The question text turns green while it listens. The agent should get the choice, and the words must not be answered as a normal turn.
19. [ ] An open question with no choices ("ask me what to call the new timer"): the face stays, the question shows under it, and the agent gets your words.
20. [ ] Ask a question and say nothing: after the timeout the choices go away and the face comes back.
21. [ ] Set a timer by voice ("set a two minute pasta timer"). "pasta 1:59" should count down above the face area while idle. When it is due: the chime, then "Your pasta timer is done." Set two and check "(+1)". Cancel one by voice.
22. [ ] Unplug the board with a timer running and plug it back in before it is due: the countdown should come back.

Questions: `ask` from Axis puts the question in the snapshot (`askId`, `question`, `choices`). The core opens the microphone with the cue for up to 20 seconds and leaves matching a spoken answer to Axis. With choices the face stays at the top, green while it listens; the question goes under it and the choices are rounded buttons below, laid out by `askLayout()` in `main.cpp` (as many to a row as fit the longest choice; when they do not fit under the face, the question and buttons take the whole screen). A tap is turned from panel to logical coordinates (`display::toLogical`) and the button under it is sent with `client.answer(index)`. Since 0.7.1; 0.7.0 drew plain text rows over the whole screen. `ask.end`, the question's own timeout or a lost connection clears it. Timers live on Axis; the board only shows the one Axis names in the `timer.next` command.

Added in 0.6.0 (device editor in the admin page): open the board under Clients. Its settings are grouped (Screen, Sound, Listening) with the three layers as tabs and "On this device: X (from ...)" next to each; actions are `Play listening cue`, `Play chime`, `Start listening`, `Microphone levels`, `Diagnostics`, `Reboot`; links open its log and setup page; Announce speaks a line on it.

Serial commands added: `talk` (tap-to-talk), `mic` (room level and thresholds), `wake` (pretend the wake word was heard), `chime` (play the boot chime), `cue` (play the listening cue), `probe HZ RATE [pause]` (play a tone through the speech path, record it with the microphone and print the spectrum; `pause` stops drawing the face meanwhile).
