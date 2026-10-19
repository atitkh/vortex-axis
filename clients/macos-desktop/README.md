# VorteX Axis for Mac (experimental, never built)

A menu bar app that makes a Mac an Axis client of type `macos-desktop` with the `desktop` capability, so an agent can read what is on the screen and point at things there (`vortex_axis_desktop`). Version 0.1.0 is milestones M0 and M1 of `docs/mac-port.md`: pairing, the link, and reading. It cannot click or type yet, has no voice and does not update itself.

**It was written on Linux without a Swift toolchain and has never been compiled or run.** Expect the first build to need fixes; see "Not verified" below.

- `Sources/AxisDesktopCore/`: Foundation only. Pairing, the socket (protocol 1), the `desktop.*` commands, the geometry, the Accessibility role to kind table. A port of the Windows app's `Axis.Desktop.Core`; `Desktop` is what a platform supplies.
- `Sources/AxisMacPlatform/`: Accessibility (`AXReader`), the window list and displays (`WindowList`, Quartz), text from the pixels (`TextReader`, ScreenCaptureKit and Vision), permissions, the saved pairing (`~/Library/Application Support/VorteX Axis/desktop.json`, token in the Keychain).
- `Sources/AxisMacUI/`: the menu bar item, the window (pairing, permissions, Recently), the pointer.
- `Sources/VortexAxisMac/`: the app. Its version is `appVersion` in `App.swift`, counted apart from Axis's, the boards' and the Windows app's.
- `Tests/AxisDesktopCoreTests/`: the Core's checks (the Windows smoke test's clipping and browser-bar checks, the commands against a fake screen, the coordinate flips, the role table). No Mac APIs, no Axis.

## Build and run (on the Mac)

Needs macOS 13 or newer and Xcode 15 or newer (or its Command Line Tools: `xcode-select --install`).

```bash
cd clients/macos-desktop
swift build                 # everything, debug
swift test                  # the Core's checks
scripts/build-mac.sh        # build/VorteX Axis.app (release, signed, Info.plist with LSUIElement)
open "build/VorteX Axis.app"
```

`swift run VortexAxisMac` also works for a quick try, but macOS then gives the permissions to Terminal (or Xcode), not to the app; use the `.app` for anything real.

Signing: the script signs with a "Developer ID Application" or "Apple Development" certificate if the keychain has one, else ad hoc. macOS ties Accessibility and Screen Recording to the signature, so with ad hoc signing they reset on every build: remove the old entry in System Settings and allow it again. A free Apple ID in Xcode (Settings > Accounts) gives an Apple Development certificate. Notarisation is not done (M5); a copy given to another Mac needs right-click > Open the first time.

## Permissions

The app's window (menu bar item > Open VorteX Axis…) shows both and has buttons for them.

1. **Accessibility** (needed: reading other apps' controls). Click Ask, or System Settings > Privacy & Security > Accessibility, switch on VorteX Axis (use + to add `build/VorteX Axis.app` if it is not listed). Without it every look fails with words saying so, not an empty list.
2. **Screen Recording** (optional: text from the pixels when a window exposes fewer than eight named controls, and other apps' window titles in a look at the screen). System Settings > Privacy & Security > Screen Recording (on macOS 15, "Screen & System Audio Recording"), switch on VorteX Axis, then quit and start the app again. Reading the pixels needs macOS 14; on 13 a look says it was skipped.
3. **Local Network** (macOS 15, a hub on the LAN): allow it when macOS asks on the first connection.

## Pair

1. On Axis's admin page: Add a device, copy the setup string (`axis://192.168.1.20:8440/123-456`, or `axis+tls://axis.example.org/123-456`).
2. In the app's window, paste it into the address field (or give the address and the code separately), give the Mac a name, Pair.
3. The admin page shows the Mac online, type `macos-desktop`, with its eight settings. "Show the pointer" there draws the pointer in the middle of the main display.
4. Switch the desktop tool on (Agent tools page) and ask an agent to look at the window in front.

A bare `host:port` is plain `ws://` (fine on a trusted LAN or tailnet); a name is `wss://`. The token travels in the hello, so use TLS outside your own network.

## What it does in 0.1.0

- `desktop.look` (`scope` window, mouse, screen; `ocr`), `desktop.find`, `desktop.point`, `desktop.hide`, `desktop.hello`, `desktop.window` with `do: list`. The same answers, line format and limits as the Windows app (`docs/mac-port.md` section 2).
- Pause from the menu (every command refused, the pointer hidden), the `allowLook` and `bubble` settings, the block list (the window in front, and blocked windows named only as blocked in a screen look; on a Mac the app's name is in a window's name, so an entry naming an app matches there too).
- Every other `desktop.*` command answers "not implemented on this device yet". Axis never offers this Mac the Windows app's update; update by building again.

## Not verified (everything Mac-side)

Nothing here has been compiled. Things most likely to need work, roughly in order:

- That it compiles at all: Swift concurrency annotations (`@MainActor` on AppKit delegates, `Sendable` warnings), CF bridging casts in `AXReader`, ScreenCaptureKit availability checks.
- The AX walk: whether the 0.45 s budget is enough for a busy window (Mail, Xcode, a long web page), whether `AXManualAccessibility` makes Electron apps (VS Code, Slack) and Chrome expose their pages, where an open context menu is in the tree, and the role to kind table in `AXKinds.swift` against real apps (AppKit, SwiftUI, Catalyst, Electron, Qt).
- That a window's AX position and the CGWindowList bounds agree (both top-left points) on a Mac with two displays, one above or left of the main one; that the pointer lands where a look says (the one AppKit flip in `PointerPanel`).
- Window titles without Screen Recording (the AX fallback), and that `CGPreflightScreenCaptureAccess` reflects a grant without a restart.
- OCR: the capture of the right display, the crop on a Retina display, Vision's boxes turned into points, the 4 s limit.
- The pointer panel above full-screen apps and on other Spaces; its glide and fade.
- The link: `URLSessionWebSocketTask` with Axis (hello, settings, the 20 s ping, a dropped connection and the backoff), ATS with a plain `ws://` LAN address, the Keychain item with an ad hoc signature.
