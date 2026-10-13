# The browser flasher

`index.html` is a page that puts the board firmware on a new board over USB, using [ESP Web Tools](https://esphome.github.io/esp-web-tools/) (Chrome or Edge on a computer; the page must be served over https or from localhost).

It needs two files beside it, which are not in the repository:

- `firmware-factory.bin`: the factory image of a build (`firmware.factory.bin` from PlatformIO: bootloader, partitions and application in one, written at offset 0).
- `manifest.json`: what ESP Web Tools reads. `scripts/make-flasher.mjs` writes it.

The release workflow builds both and publishes the folder to GitHub Pages. To try it on your own machine after a build:

```bash
node scripts/make-flasher.mjs firmware/waveshare-amoled-1.8 /tmp/flasher
python3 -m http.server -d /tmp/flasher 8000      # then open http://localhost:8000
```
