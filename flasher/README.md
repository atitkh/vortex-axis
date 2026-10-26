# The browser flasher

`index.html` is a page that puts the board firmware on a new board over USB, using [ESP Web Tools](https://esphome.github.io/esp-web-tools/) (Chrome or Edge on a computer; the page must be served over https or from localhost).

It is served two ways:

- **By every Axis, at `/flash`** (`server/src/http.ts`). The manifest and the image come from the hub's own firmware shelf: the current build of a type that has a factory image with it (a release image brings one; `scripts/push-firmware.mjs` uploads one beside a build). `types.json` lists every such type, and with more than one the page offers a choice of board (`manifest.json?type=...`).
- **As a folder of plain files**, which the release workflow publishes to GitHub Pages for people with no hub yet. `scripts/make-flasher.mjs` puts it together with each board's factory image (`firmware.factory.bin` from PlatformIO: bootloader, partitions and application in one, written at offset 0) and a manifest for each. It takes several board folders, writes the first also as `manifest.json`, and lists them all in `types.json`.

The installer itself (`esp-web-tools/`) is not in the repository: `node scripts/fetch-esp-web-tools.mjs` fetches it from npm. Nothing is loaded from anywhere else when the page runs.

To try the folder on your own machine after a build:

```bash
node scripts/fetch-esp-web-tools.mjs
node scripts/make-flasher.mjs firmware/waveshare-amoled-1.8 firmware/waveshare-amoled-1.75 /tmp/flasher
python3 -m http.server -d /tmp/flasher 8000      # then open http://localhost:8000
```
