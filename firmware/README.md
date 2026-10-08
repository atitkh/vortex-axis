# Firmware

Clients for VorteX Axis that run on microcontrollers.

| Path | Contents |
| --- | --- |
| `common/` | The shared client core: Wi-Fi setup, pairing, the socket to Axis, settings sync, audio framing. Board-independent. |
| `waveshare-amoled-1.8/` | Waveshare ESP32-S3-Touch-AMOLED-1.8: pins, audio codec, display, touch, and the face. |
| `models/` | Wake word models. See its README. |

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

The serial port takes the same things as typed commands: `status`, `wifi <name> <password>`, `setup <axis://...>`, `text <words>` (a typed turn), `forget`, `forget wifi`, `reboot`.

The address in a setup string must be plain `http` for now. `axis+tls://` is parsed but this firmware cannot connect to it yet, so a device only works on the same network as Axis.

## Settings a device reads

Set these in the admin page, for all clients, for the type `waveshare-amoled-1.8` or for one device.

| Key | Meaning | Default |
| --- | --- | --- |
| `rotation` | Screen rotation in degrees: 0, 90, 180 or 270 | 90 |
| `brightness` | Screen brightness, 10 to 255 | 200 |

## The face

The default face is a vortex: dots on three spiral arms, drawn on the device from the turn state Axis sends. Nothing is streamed as pixels.

| State | Look |
| --- | --- |
| Idle | A slow spin that changes at random every 7 to 17 seconds between seven looks (calm, breathe, unwind, open, curl, drift, shimmer) |
| Listening | Pulls inward, green |
| Thinking | Spins fast, violet |
| Speaking | Opens and pulses, white-blue. It will follow the voice once the speaker is in. |
| Problem | Slow and red |
| No Axis or no Wi-Fi | Small, dim and grey |
| Setup | Amber |

Text sits under the face: what was heard, the reply, or what is wrong (which service is down, "Can't reach Axis").

## Status

Milestone 1 of 5 is done on the Waveshare board: display, Wi-Fi setup network, pairing, the socket to Axis with settings sync, and the face. It has no sound yet, so Axis treats it as a screen: replies and agent messages are shown as text.

Measured on the board: 30 frames a second, 31 ms per frame, of which 3 ms is drawing and the rest is sending 240 rows to the panel one at a time. That leaves no headroom, so the panel writes need to get faster before audio shares the processor.

Build order: (1) display, Wi-Fi setup, pairing and a face that follows Axis's state; (2) speaker; (3) microphone with tap-to-talk; (4) wake word; (5) polish and updates over Wi-Fi.
