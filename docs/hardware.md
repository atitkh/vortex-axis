# Hardware

What you can talk to Axis through, and how to get each one going. A browser needs no hardware at all: start there if you just want to try Axis.

## The board: Waveshare ESP32-S3-Touch-AMOLED-1.8

The one board Axis has firmware for today. It is sold by Waveshare and its resellers under that name; nothing has to be soldered or added.

| | |
| --- | --- |
| Chip | ESP32-S3R8: dual core, Wi-Fi, 8 MB PSRAM, 16 MB flash |
| Screen | 1.8 inch AMOLED, 368 x 448, touch |
| Sound | A microphone and a small speaker on an ES8311 codec |
| Also on it | A motion sensor (the picture turns with the board), a battery connector and charger, USB-C |

What it does with Axis: shows the face, listens for "Hey Vortex" on the device itself (nothing leaves the board until it hears it), takes a tap to talk, speaks answers, shows questions with buttons, timers, pictures and long tasks, glows along its edges for things that want your attention, and updates itself over Wi-Fi.

A battery is optional. Without one it runs from USB-C.

### First install

A new board needs the firmware put on it once, by cable. After that it updates from your Axis.

**From the browser (easiest).** Open the project's flasher page in Chrome or Edge on a computer, plug the board in with a USB-C cable that carries data, and press **Connect and install**. The page says what to do if the board is not found (hold BOOT while plugging in). The page is published with each release; `flasher/README.md` says how to serve it yourself.

**From the command line.** Download `firmware-waveshare-amoled-1.8-<version>-factory.bin` from a release and write it at offset 0:

```bash
pip install esptool
esptool.py --chip esp32s3 write_flash 0x0 firmware-waveshare-amoled-1.8-<version>-factory.bin
```

**From source.** With [PlatformIO](https://platformio.org/install/cli), in `firmware/waveshare-amoled-1.8`: `pio run --target upload`. See [firmware/README.md](../firmware/README.md) for the serial port on Linux and everything else about the firmware.

### Setting it up

1. The board starts its own Wi-Fi network, `VorteX-Axis-XXXX`, and shows the name. Join it from a phone; the setup page opens by itself (or go to `http://192.168.4.1`).
2. Pick your Wi-Fi and enter its password.
3. On the Axis admin page open **Add a device**, make a pairing code and copy the **setup string** (it looks like `axis://192.168.1.20:8440/483-221`) into the same form.
4. The board joins, pairs and shows its face. Say "Hey Vortex", or tap the screen.

If it cannot join the saved network, the setup network comes back by itself. The admin page can also reset a board, move it to another address for Axis, and update its firmware.

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

## A computer (Windows)

The desktop app turns a Windows computer into a device: a key to talk (Ctrl+Alt+Space), answers on its speakers, Vortex's face on screen, and, if you allow it, the agent reading the screen and acting on it. It is experimental; read [SECURITY.md](../SECURITY.md) before switching the agent's access on.

Download it from the admin page's **Add a device** (a release image comes with it), run it, and enter Axis's address and a pairing code. It updates itself from Axis. Windows warns the first time it runs, because the app is not signed yet: choose **More info**, then **Run anyway**.

## A phone or any browser

Open Axis's address, enter a pairing code, and it is a device: type, tap to talk, hold to talk. On a phone, add it to the Home Screen and turn on notifications to get questions and finished tasks when you are away. Speaking needs `https` or `localhost` ([setup.md](setup.md) shows how).

## Another board, or your own device

A device only has to speak the protocol: one socket to Axis, JSON for control, raw audio in binary frames. [client-guide.md](client-guide.md) is the contract (what each capability obliges a client to do, the settings and commands every client answers, a checklist), `protocol/` the message definitions, and `firmware/common/` a client core for ESP32 boards that a new board can reuse: most of a new board is describing its pins, screen and codec.
