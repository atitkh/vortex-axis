# Releasing

Run `node scripts/release-check.mjs` before saying anything is done, and again after the build and the deploy. It checks the things we have forgotten before; a ✗ is a failure, a ⚠ is something to look at.

## What changed → what to do

Do the steps in order. Each says what the check will look for.

1. **Bump the number where it is written.**
   - Axis (server, admin page, web client): `npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`. Middle number for a batch of new things, last for fixes.
   - Windows app: `<Version>` in `clients/windows-desktop/Directory.Build.props`.
   - Mac app: `appVersion` in `clients/macos-desktop/Sources/VortexAxisMac/App.swift`.
   - Board firmware: `AXIS_FIRMWARE_VERSION` in `firmware/common/src/axis_client.h`.
   - The protocol changes (`protocol/src/messages.ts`): regenerate with `npm run schema --workspace protocol`, commit `protocol/schema/`, update `protocol/README.md`, and `docs/client-guide.md` if clients must act. The protocol number itself moves only when devices and Axis must change how they talk; a new message old clients can ignore does not move it.
2. **Write it down in the same commit.**
   - `CHANGELOG.md`: a `## Axis X (date)`, `## Desktop app X (date)` or `## Mac desktop app X (date)` entry, newest first.
   - `CLAUDE.md`: the **Versions** line (and what is built, what is not, what the owner has tried).
   - Anything a client does differently: `docs/client-parity.md`.
3. **Test.** `npm test` and `npm run typecheck` for Axis; `npm run browser-check` when the admin page (`/admin`, `web/admin-next.*` and `web/adm-*.js`) or the web client changed (until the classic page goes, it also checks `/admin-classic` loads and signs in). Windows: the Docker build in `scripts/build-desktop.sh` compiles it; `Axis.Desktop.Smoke check` for clicks. Mac: `swift build && swift test` on a Mac only (the owner runs them; paste errors back).
4. **Commit and push.** The message says what changed and what version each part is now at.
5. **Ship what changed.**
   - Axis: `npm run deploy`, then `scripts/release-check.mjs` (it reads the commit the running container was built from).
   - Windows app: `scripts/build-desktop.sh` puts it on the shelf; the PC takes it in about 5 minutes. The server must be deployed first when the app needs a new message.
   - Mac app: the owner builds it. Nothing is served yet (notarization and an update path come with the Developer ID certificate).
   - Firmware: `scripts/push-firmware.mjs` (boards update themselves).
6. **Tag.** `vX.Y.Z` for Axis when it is a release (runs `.github/workflows/release.yml`: firmware, desktop app, image). `desktop-vX.Y.Z` and `quest-vX.Y.Z` are markers on the commit that changed that client; they build nothing. Push tags with `git push --tags`.
7. **The project card** (`memory/projects/vortex-hub.md`): a dated line with versions, commits, what is deployed and what is not yet tried by the owner; bump `updated:`. Mirror a short version to the Discord post when it is a milestone.
8. **Run the check again.** Everything ✓ means the code, the changelog, the notes, the tags, the running server and the shelf agree.

## Order matters when

- A client starts sending a message the server does not know: deploy the server first. (An old server answers an unknown message with an `error` that clients ignore, so nothing breaks, but the feature does not work.)
- The server drops something a client still uses: ship the client first, keep the server accepting the old form.
