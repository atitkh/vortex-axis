# Contributing

Thank you for looking. This is a small project with one maintainer; changes that are small, tested and explained are the ones that get in quickly.

By sending a change you agree that it is yours to give and that it is licensed under the [Apache License 2.0](LICENSE), like the rest.

## Before you write code

- **A bug:** open an issue with what you did, what happened and what you expected, the versions (admin page, bottom of the menu; a device's page shows its own), and the relevant lines from `docker logs vortex-axis` or a board's `/logs` page.
- **A feature:** open an issue first and say what you want to be able to do. Much of what looks missing was left out on purpose; [docs/design.md](docs/design.md) says why things are the way they are.
- **Security:** not in a public issue. See [SECURITY.md](SECURITY.md).

## Finding your way

```
protocol/   the messages between a device and Axis: the one definition
server/     Axis (TypeScript, Node 24)
web/        the web client and the admin page (plain JavaScript, no build step)
firmware/   boards (C++, PlatformIO); common/ is the shared client core
clients/    other clients: the Windows desktop app (C#, .NET 8) and the Meta Quest app (Android)
speech/     the local speech services (Python)
docs/       design, the face, the client guide, setup, hardware
```

[`CLAUDE.md`](CLAUDE.md) holds notes for AI coding assistants working in the repository: the current state, the rules that are settled, and maps of the server and the firmware. The maps are useful to anyone finding their way around the code.

## Building and testing

```bash
npm ci
npm run typecheck
npm test                      # starts real servers on free ports; about a minute
npm run browser-check         # the admin page and web client in headless Chrome (needs Chrome, or CHROME=<path>)
```

Run Axis from the repository: `cp .env.example .env`, set `AXIS_ADMIN_TOKEN` (24 characters or more), `mkdir -p data`, `docker compose up -d --build`, then `http://localhost:8440/admin`.

- **Firmware:** `pio run` in `firmware/waveshare-amoled-1.8` and `firmware/waveshare-amoled-1.75` (a change to `firmware/common/` must build in both) ([firmware/README.md](firmware/README.md)).
- **Desktop app:** `scripts/build-desktop.sh` builds it in a .NET container. Mind what the script says: it puts the build where a running Axis hands it to every paired computer. `clients/windows-desktop/README.md` has the rest.
- **Quest app:** `scripts/build-quest-client.sh` builds the APK in a Docker container and puts it where a running Axis hands it to every paired headset. `clients/quest-client/README.md` has the rest.

## What a change needs

- **Tests** for server behaviour, beside the ones that are there (`server/test/`). They talk to a real server through the harness; copy a neighbour.
- **The protocol first.** A change to what devices and Axis say to each other starts in `protocol/src/messages.ts`; regenerate the schema (`npm run schema --workspace protocol`) and keep `protocol/README.md` and `docs/client-guide.md` in step.
- **The face in all three places.** `docs/face.md` is the specification; `web/vortex.js`, the board's `vortex.cpp` and the desktop app's `Face.cs` follow it. Icons are defined once in `web/icons.js` (`node scripts/gen-icons.mjs` writes the others).
- **The changelog.** A line in `CHANGELOG.md` under a new heading, in plain words: what a person can now do, or what no longer goes wrong.
- **No installation details.** No real host names, addresses, device names or tokens in code, tests, comments or docs: `axis.example.org`, `192.168.1.20`.
- **Plain language** in what people read: the admin page, error messages, docs. Say what happens, not how it is built.

## Versions

One number for the server and its web pages, in the top-level `package.json` (the workspaces follow it; a test checks). Board firmware counts its own (`AXIS_FIRMWARE_VERSION`), and so do the desktop app (`Directory.Build.props`) and the Quest app (`clients/quest-client/app/build.gradle`). The protocol's number changes only when devices and Axis must change how they talk. A tag `vX.Y.Z` that matches `package.json` builds a release.

## A new device

Read [docs/client-guide.md](docs/client-guide.md) first: it is the contract for a client, with a checklist. A new ESP32 board mostly describes its hardware and reuses `firmware/common/`. Add it to `docs/hardware.md` when it works.
