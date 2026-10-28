# Hardware

What you can talk to Axis through, and how to get each one going. A browser needs no hardware at all: start there if you just want to try Axis.

## The board: Waveshare ESP32-S3-Touch-AMOLED-1.8

The first board Axis had firmware for (the round 1.75 below is the other). It is sold by Waveshare and its resellers under that name; nothing has to be soldered or added.

| | |
| --- | --- |
| Chip | ESP32-S3R8: dual core, Wi-Fi, 8 MB PSRAM, 16 MB flash |
| Screen | 1.8 inch AMOLED, 368 x 448, touch |
| Sound | A microphone and a small speaker on an ES8311 codec |
| Power | An AXP2101 power chip (I2C 0x34): charger and fuel gauge for a 3.7 V lithium battery on an MX1.25 two-pin connector |
| Also on it | A motion sensor (the picture turns with the board), a clock, a TF card slot, USB-C |

What it does with Axis: shows the face, listens for "Hey Vortex" on the device itself (nothing leaves the board until it hears it), takes a tap to talk, speaks answers, shows questions with buttons, timers, pictures and long tasks, glows along its edges for things that want your attention, and updates itself over Wi-Fi.

A battery is optional. Without one it runs from USB-C. Use a protected single-cell 3.7 V lithium battery with an MX1.25 plug, and check its polarity against the connector before plugging it in: lead colours are not standard. With a battery the board reports its charge, whether it is charging and its voltage to Axis; without one it reports none of these (see `firmware/README.md`, "Vitals"). The face shows it too: a sleepy idle face and a battery mark at low battery, a short cyan glow and a bolt when charging begins (the 1.8 since 0.23.0, the round board since 0.7.0; `docs/face.md` section 10).

### First install

A new board needs the firmware put on it once, by cable. After that it updates from your Axis.

**From the browser (easiest).** Your Axis serves a flasher page at `/flash` (there is a link on the admin page's **Add a device**). Open it in Chrome or Edge on a computer, plug the board in with a USB-C cable that carries data, and press **Connect and install**: it puts on the firmware your hub came with. Browsers only allow USB access over `https` or from `localhost`, so open the page through your hub's https address, or on the machine Axis runs on as `http://localhost:8440/flash`. The page says what to do if the board is not found (hold BOOT while plugging in). The same page is published with each release for people who have no hub yet.

**From the command line.** Download `firmware-waveshare-amoled-1.8-<version>-factory.bin` from a release and write it at offset 0:

```bash
pip install esptool
esptool.py --chip esp32s3 write_flash --flash_size 16MB 0x0 firmware-waveshare-amoled-1.8-<version>-factory.bin
```

**From source.** With [PlatformIO](https://platformio.org/install/cli), in `firmware/waveshare-amoled-1.8`: `pio run --target upload`. See [firmware/README.md](../firmware/README.md) for the serial port on Linux and everything else about the firmware.

### Setting it up

1. The board starts its own Wi-Fi network, `VorteX-Axis-XXXX`, and shows the name. Join it from a phone; the setup page opens by itself (or go to `http://192.168.4.1`).
2. Pick your Wi-Fi and enter its password.
3. On the Axis admin page open **Add a device**, make a pairing code and copy the **setup string** (it looks like `axis://192.168.1.20:8440/483-221`) into the same form.
4. The board joins, pairs and shows its face. Say "Hey Vortex", or tap the screen.

A board remembers up to five Wi-Fi networks and joins whichever is in range. Add another from the setup page at the board's own address (or its serial console); the same page lists the saved ones and forgets them (`firmware/README.md`, "Saved networks"). If it cannot join any saved network after it starts, the setup network comes back by itself. The admin page can also reset a board, move it to another address for Axis, and update its firmware.

### Using it

| You do | It does |
| --- | --- |
| Say "Hey Vortex" | Listens (green), then answers |
| Tap the screen | Starts listening; while listening, finishes; while thinking or speaking, stops |
| Swipe down | Puts finished tasks away |
| Reply within a few seconds of an answer | No wake word needed |

Its settings (volume, brightness, rotation, wake word, how long it waits for you) are on its page in the admin, for this board, for every board of its type, or for everything.

### Known limits

- Saying the wake word over the board's own voice does not interrupt it; tap instead. (There is an experimental setting, `bargeIn`.)
- Two boards in one room both hear you; Axis lets one answer.
- The firmware is not signed.

## The round board: Waveshare ESP32-S3-Touch-AMOLED-1.75 (new)

The same firmware as the 1.8, laid out on a round screen. Type `waveshare-amoled-1.75`; it counts its own firmware versions (0.1.0 is the first). **Status: new**, not yet tested in everyday use; see `firmware/README.md`, "The round board", for what has been checked on a real one.

| | |
| --- | --- |
| Chip | ESP32-S3R8: dual core, Wi-Fi, 8 MB PSRAM, 16 MB flash |
| Screen | 1.75 inch round AMOLED, 466 x 466, touch |
| Sound | Two microphones on an ES7210, a small speaker on an ES8311 |
| Power | An AXP2101 power chip (I2C 0x34, the same as the 1.8's): charger and fuel gauge for a 3.7 V lithium battery on an MX1.25 two-pin connector |
| Also on it | A motion sensor, a clock, a TF card slot, USB-C. The `-G` version adds GPS, which the firmware does not use. |

It does everything the 1.8 does, the same way: face, "Hey Vortex", tap to talk, questions with buttons, timers, pictures, long tasks, edge glows (round here), gestures, updates over Wi-Fi. Text and buttons are fitted inside the circle. The two microphones are averaged; the speaker's own sound comes back to the ES7210 for the echo canceller, as on the 1.8.

First install and setup are the same as for the 1.8: the browser flasher offers a choice of board when the hub has both, or `firmware-waveshare-amoled-1.75-<version>-factory.bin` from a release written at offset 0, or `pio run --target upload` in `firmware/waveshare-amoled-1.75`.

## A computer (Windows)

The desktop app turns a Windows computer into a device: a key to talk (Ctrl+Alt+Space), answers on its speakers, Vortex's face on screen, and, if you allow it, the agent reading the screen and acting on it. It is experimental; read [SECURITY.md](../SECURITY.md) before switching the agent's access on.

Download it from the admin page's **Add a device** (a release image comes with it), run it, and enter Axis's address and a pairing code. It updates itself from Axis. Its settings (talk key, microphone and speaker, the face's size and place, what shows on screen) are under **Settings** in its window; the everyday ones (talking, the face, its size and place, starting with Windows) are also in the tray icon's right-click menu. A face kept on screen can be moved anywhere by right-clicking it and dragging.

### "Windows protected your PC"

The app is not code-signed yet (a signing certificate costs money every year), so the first time it runs Windows SmartScreen shows a blue box, **Windows protected your PC**, with only a **Don't run** button. That is Windows saying it has not seen this program before, not that anything is wrong with it.

1. Click **More info** (small text under the message).
2. Check the publisher line says "Unknown publisher" and the name is `VortexAxisDesktop.exe`.
3. Click **Run anyway**.

Windows remembers the choice for that file. An update from Axis is a new file, but it is put in place of the old one by the app itself, so SmartScreen does not ask again. If your browser also warns when downloading it ("not commonly downloaded"), choose **Keep** in its download list.

Only do this for a copy that came from your own Axis or from the project's releases. If you would rather not trust a download at all, build it yourself: `scripts/build-desktop.sh` in the repository.

## A Meta Quest headset (experimental)

The Quest app lets an agent read and use the headset's 2D panels (Store, Browser, Settings, Android apps) with the same desktop tool as a computer. It has no voice and draws nothing yet, and it never touches immersive apps. It works through the headset's own adb, so it needs developer mode, and after every restart of the headset a computer with a cable to run `adb tcpip 5555` once. The first time, the headset asks to allow the app's key: tick **Always allow**. Since 0.3.0 it installs and starts a small helper of its own through that adb (the "fast engine"), which reads and uses the panels much more quickly than `uiautomator`; when the helper is not running, the app does it the slower way. It shows on the admin page as a **Meta Quest**.

Take `quest-client-<version>.apk` from the release (it is also inside the Axis image), or build it with `scripts/build-quest-client.sh` (Docker; the APK lands in the data folder's `quest/`), and install it the first time with `adb install -r quest-client.apk`, open it from **Unknown Sources**, and pair it with a code like any device. After that it updates itself from Axis, like the desktop app, whenever a newer build is in the data folder; only a build signed with the same key installs over it (builds from that script share one key, kept in a Docker volume; release builds share one only when the repository sets `QUEST_KEYSTORE_B64`; one signed with another key needs an uninstall first, which loses the pairing). [clients/quest-client/README.md](../clients/quest-client/README.md) has the steps and the limits; read [SECURITY.md](../SECURITY.md) first.

## A phone or any browser

Open Axis's address, enter a pairing code, and it is a device: type, tap to talk, hold to talk. On a phone, add it to the Home Screen and turn on notifications to get questions and finished tasks when you are away. Speaking needs `https` or `localhost` ([setup.md](setup.md) shows how).

## Another board, or your own device

A device only has to speak the protocol: one socket to Axis, JSON for control, raw audio in binary frames. [client-guide.md](client-guide.md) is the contract (what each capability obliges a client to do, the settings and commands every client answers, a checklist), `protocol/` the message definitions, and `firmware/common/` a client core for ESP32 boards that a new board can reuse: most of a new board is describing its pins, screen and codec.
