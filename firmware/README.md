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

## Status

Bring-up only: the Waveshare project boots, starts the display and logs to serial. It does not talk to Axis yet.

Build order: (1) display, Wi-Fi setup, pairing and a face that follows Axis's state; (2) speaker; (3) microphone with tap-to-talk; (4) wake word; (5) polish and updates over Wi-Fi.
