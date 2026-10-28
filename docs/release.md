# Releasing

Run `node scripts/release-check.mjs` before saying anything is done, and again after the build and the deploy. It checks the things we have forgotten before; a ✗ is a failure, a ⚠ is something to look at.

## What changed → what to do

Do the steps in order. Each says what the check will look for.

1. **Bump the number where it is written.**
   - Axis (server, admin page, web client): `npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`. Middle number for a batch of new things, last for fixes.
   - Windows app: `<Version>` in `clients/windows-desktop/Directory.Build.props`.
   - Mac app: `appVersion` in `clients/macos-desktop/Sources/VortexAxisMac/App.swift`.
   - Board firmware, per board (each counts its own; `node scripts/firmware-version.mjs <board>` prints it): the round board `waveshare-amoled-1.75` in its `platformio.ini` (`-D AXIS_FIRMWARE_VERSION=\"x.y.z\"`), the 1.8 `waveshare-amoled-1.8` in `firmware/common/src/axis_client.h` (`#define AXIS_FIRMWARE_VERSION`, the client core's default). See **Firmware** below.
   - The protocol changes (`protocol/src/messages.ts`): regenerate with `npm run schema --workspace protocol`, commit `protocol/schema/`, update `protocol/README.md`, and `docs/client-guide.md` if clients must act. The protocol number itself moves only when devices and Axis must change how they talk; a new message old clients can ignore does not move it.
2. **Write it down in the same commit.**
   - `CHANGELOG.md`: a `## Axis X (date)`, `## Desktop app X (date)`, `## Mac desktop app X (date)`, `## Board firmware X (Waveshare 1.8) (date)` or `## Round board firmware X (Waveshare 1.75) (date)` entry, newest first.
   - `CLAUDE.md`: the **Versions** line (and what is built, what is not, what the owner has tried).
   - Anything a client does differently: `docs/client-parity.md`.
3. **Test.** `npm test` and `npm run typecheck` for Axis; `npm run browser-check` when the admin page (`/admin`, `web/admin-next.*` and `web/adm-*.js`) or the web client changed. Since the classic page was removed (Axis 0.58.0) it drives only the new page: sign-in (a wrong token, then the right one), every area, a running agent task under Live > Now and then Tasks finished, and that `/admin-classic` answers 404. Windows: the Docker build in `scripts/build-desktop.sh` compiles it; `Axis.Desktop.Smoke check` for clicks. Mac: `swift build && swift test` on a Mac only (the owner runs them; paste errors back).
4. **Commit and push.** The message says what changed and what version each part is now at.
5. **Ship what changed.**
   - Axis: `npm run deploy`, then `scripts/release-check.mjs` (it reads the commit the running container was built from).
   - Windows app: `scripts/build-desktop.sh` puts it on the shelf; the PC takes it in about 5 minutes. The server must be deployed first when the app needs a new message.
   - Mac app: the owner builds it. Nothing is served yet (notarization and an update path come with the Developer ID certificate).
   - Firmware: build, flash the bench board, publish to the hub; see **Firmware** below.
6. **Tag.** `vX.Y.Z` for Axis when it is a release (runs `.github/workflows/release.yml`: firmware, desktop app, image). `desktop-vX.Y.Z`, `quest-vX.Y.Z` and `fw-<board>-vX.Y.Z` (e.g. `fw-waveshare-amoled-1.8-v0.20.0`, `fw-waveshare-amoled-1.75-v0.4.1`) are markers on the commit that changed that client or board to that version; they build nothing. Push tags with `git push origin <tag>` (never force).
7. **The project card** (`memory/projects/vortex-hub.md`): a dated line with versions, commits, what is deployed and what is not yet tried by the owner; bump `updated:`. Mirror a short version to the Discord post when it is a milestone.
8. **Run the check again.** Everything ✓ means the code, the changelog, the notes, the tags, the running server and the shelf agree.

## Firmware

For each board whose firmware changed (`waveshare-amoled-1.8`, `waveshare-amoled-1.75`):

1. Bump its version (step 1 above) and write its CHANGELOG entry and the CLAUDE.md Versions line in the same commit.
2. Build: `~/.platformio/penv/bin/pio run` in `firmware/<board>/`.
3. If that board is on the bench and attached by USB, flash it: `pio run --target upload` in the same folder, and check it (`firmware/README.md`).
4. Publish to the hub, from the repository root: `AXIS_ADMIN_TOKEN=... node scripts/push-firmware.mjs <board> [--update]` (the token from `.env`, through the environment only). Without `--update` it only puts the build on the hub, where the admin page and the web flasher offer it; with `--update` every online board of that type also installs it over Wi-Fi.
5. Tag the commit that set the version: `git tag fw-<board>-v<version> <commit>` and `git push origin fw-<board>-v<version>`.

The web flasher at `/flash` lists only the boards whose firmware was pushed to the hub, at the version pushed. `release-check` fails when the hub's `/flash/types.json` offers another version than the code (the fix is step 4) and warns when the `fw-` tag is missing.

## Order matters when

- A client starts sending a message the server does not know: deploy the server first. (An old server answers an unknown message with an `error` that clients ignore, so nothing breaks, but the feature does not work.)
- The server drops something a client still uses: ship the client first, keep the server accepting the old form.
