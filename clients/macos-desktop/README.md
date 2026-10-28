# VorteX Axis for Mac (experimental)

A menu bar app that makes a Mac an Axis client of type `macos-desktop` with the `desktop` capability, so an agent can read what is on the screen, point at things, and click, type and press keys there (`vortex_axis_desktop`). Version 0.4.0 covers pairing, the link, reading, input, talking from the Mac, Vortex's face, the notices at the top of the screen, the logo, (0.3.1) the Windows app's pointer, (0.3.2) a face that follows the admin page's Face settings, and (0.4.0) typing to the agent, the long-task and timer pills, sounds and pictures in replies. It does not update itself.

**Status: experimental.** Up to 0.2.0 the app has been built and run on a Mac (MacBook Air, with Brave as the browser). Later versions have not yet been compiled as an app: the Core (`AxisDesktopCore`) and its 166 tests compile and pass under Swift 5.10 on Linux, but the AppKit and SwiftUI parts are untested. See "Known limitations" below.

- `Sources/AxisDesktopCore/`: Foundation only. Pairing, the socket (protocol 1), the `desktop.*` commands, the geometry, the Accessibility role to kind table, the key combinations (`KeyCombo`), which window is in front (`WindowPick`), the voice part (`Voice`, `TalkKey`, `PCM`), the face (`Face`, `FaceIcons.g.swift` written by `scripts/gen-icons.mjs`), where the face and the pills go (`FaceLayout`, `PillLayout`) and what they say (`PillWords`), the task line, the next timer and the chime command (`Notices`), the sounds and quiet hours (`Sounds`, `SoundRules`), hold-or-tap and typed turns (`Typing`). A port of the Windows app's `Axis.Desktop.Core`; `Desktop` is what a platform supplies.
- `Sources/AxisMacPlatform/`: Accessibility (`AXReader`, `AXActions`), the window list and displays (`WindowList`, Quartz), mouse and keys (`InputEvents`, CGEvent), apps and windows (`Apps`), pictures (`ScreenCapture`) and text from the pixels (`TextReader`, Vision), the clipboard (`Pasteboard`), permissions, the saved pairing (`~/Library/Application Support/VorteX Axis/desktop.json`, token in the Keychain). `MacDesktop` puts them together.
- `Sources/AxisMacUI/`: the menu bar item and its icon (`MenuBarIcon`, drawn in code), the window (pairing, talking, face and notices, permissions, Recently, About), the pointer, the face (`FacePanel`), the pills (`Pills`; the task, timer and typing pills in `NoticePills`).
- `App/`: `Info.plist`, the entitlements, the app icon (`AppIcon.icns` and its `AppIcon.iconset`, made by `scripts/make-icns.sh` from `AppIcon-1024.png`, which `scripts/draw-app-icon.py` draws from the logo).
- `Sources/VortexAxisMac/`: the app. Its version is `appVersion` in `App.swift`, counted apart from Axis's, the boards' and the Windows app's.
- `Tests/AxisDesktopCoreTests/`: the Core's checks: the Windows smoke test's clipping and browser-bar checks, every command against a fake screen (input included), the coordinate rules, the role table, the key table, the front-window and window-list rules, the voice part, the face (its looks, icon and timing), where the face and the pills go (the notch included), the pills' words, the menu bar icon's state. No Mac APIs, no Axis.

## Build and run (on the Mac)

Needs macOS 13 or newer and Xcode 15 or newer (or its Command Line Tools: `xcode-select --install`).

```bash
cd clients/macos-desktop
swift build                 # everything, debug
swift test                  # the Core's checks
scripts/build-mac.sh        # build/VorteX Axis.app (release, signed, Info.plist with LSUIElement, the icon)
open "build/VorteX Axis.app"
```

`swift run VortexAxisMac` also works for a quick try, but macOS then gives the permissions to Terminal (or Xcode), not to the app; use the `.app` for anything real.

Signing: the script signs with a "Developer ID Application" or "Apple Development" certificate if the keychain has one, else ad hoc. macOS ties Accessibility and Screen Recording to the signature, so with ad hoc signing they reset on every build: remove the old entry in System Settings and allow it again. A free Apple ID in Xcode (Settings > Accounts) gives an Apple Development certificate. Notarisation is not done (M5); a copy given to another Mac needs right-click > Open the first time.

## Permissions

The app's window (menu bar item > Open VorteX Axis…) shows each and has buttons for them.

1. **Accessibility** (needed for everything: reading other apps' controls, pressing them, and posting mouse and key events). Click Ask, or System Settings > Privacy & Security > Accessibility, switch on VorteX Axis (use + to add `build/VorteX Axis.app` if it is not listed). Without it every look fails with words saying so, not an empty list. The window's "Mouse and keyboard" line reads the same grant from the event side (`CGPreflightPostEventAccess`); if it stays off while Accessibility is on, remove the app from the Accessibility list and add it again. No Input Monitoring is needed: the talk key and the typing key are Carbon hot keys (no permission; they tell press from release, which is all hold-or-tap needs), and Fn alone is seen through Accessibility. The typing field gets keys only because its own panel is the key window while it is open.
2. **Screen Recording** (screenshots, text from the pixels when a window exposes fewer than eight named controls, and other apps' window titles in a look at the screen and the window list). System Settings > Privacy & Security > Screen Recording (on macOS 15, "Screen & System Audio Recording"), switch on VorteX Axis, then quit and start the app again. Without it, `screenshot` and OCR say why; titles fall back to app names.
3. **Microphone** (talking from this Mac): click Ask in the window, or allow it when macOS asks on the first press of the talk key. System Settings > Privacy & Security > Microphone. Without it the voice pill says so (on a hold; a tap still opens the typing pill). Since 0.4.0 the microphone starts at every key-down, so macOS's orange microphone dot also shows for a moment on a tap.
4. **Local Network** (macOS 15, a hub on the LAN): allow it when macOS asks on the first connection.

The face, the pills and the icons need no permission.

## Pair

1. On Axis's admin page: Add a device, copy the setup string (`axis://192.168.1.20:8440/123-456`, or `axis+tls://axis.example.org/123-456`).
2. In the app's window, paste it into the address field (or give the address and the code separately), give the Mac a name, Pair.
3. The admin page shows the Mac online, type `macos-desktop`, with its eight settings. "Show the pointer" there draws the pointer in the middle of the main display.
4. Switch the desktop tool on (Agent tools page) and ask an agent to look at the window in front.

A bare `host:port` is plain `ws://` (fine on a trusted LAN or tailnet); a name is `wss://`. The token travels in the hello, so use TLS outside your own network.

## What it does in 0.2.0

Every `desktop.*` command the Windows app has, with the same answers, line format and limits, and the same safety: pause, `allowLook`, `allowInput`, `allowScreenshot` (off unless switched on), the block list (checked on the window in front before every command, again right before each input and before each step of `steps`), no typing, pasting or screenshot with a password field named or focused, blocked key chords.

- **Reading**: `look` (window, mouse, screen; `ocr`), `find`, `window do=list`, `clipboard`. The window in front is the focused window Accessibility gives (its box, its title), checked against Quartz's windows on the current Space; never a desktop or a 0x0 window. Chromium and Firefox browsers are asked to build their tree (`AXEnhancedUserInterface`), Electron apps too (`AXManualAccessibility`); the first look at such an app waits 300 ms for it. The menu bar's first 14 titles come after the window's controls. A screen look and the window list are one list: every normal window on this Space, then titled windows on other Spaces or minimised, marked `= on another Space, or minimised`.
- **Clicking** (`click`, left/right/double): by id, name or x,y. A control is read again and clicked where it shows now; a field (`edit`, an editable `combobox`) is given the focus (`how: focused`); a control that offers AXPress (or AXPick, for menu items) is pressed with no mouse (`how: invoked`); a right click outside web pages uses the control's own AXShowMenu when it has one; otherwise a real click (`how: mouse`) and the pointer is put back. Under 40% showing: AXScrollToVisible, else refused with words. The browser-bar guard knows the Mac browsers by name and bundle id.
- **Typing**: `type` (Unicode key events in pieces of 16, Return and Tab as keys), `paste` (the clipboard borrowed and every item put back after 400 ms, marked `org.nspasteboard.TransientType`; a clipboard marked `ConcealedType` is never read), `keys`. Type, paste and keys go to the app the agent last opened, switched to or acted in, brought back first (90 s), else nothing is typed.
- **Keys**: `ctrl` on a common shortcut key is sent as cmd: `ctrl+` s c v x a z f t w n o p r q l k b i u / [ ] , + - 0 = becomes `cmd+`, `ctrl+y` becomes `shift+cmd+z` (redo). `ctrl` stays Control elsewhere (`ctrl+tab`, `ctrl+left`, `ctrl+space`, other letters), and `control+…` spelled out is always the Control key. `cmd`/`command`/`win`/`meta`, `alt`/`option`/`opt`, `shift`, `fn` as written. Never pressed: cmd+Q (quitting the app), ctrl+cmd+Q (lock), shift+cmd+Q and shift+option+cmd+Q (log out), option+cmd+Esc (Force Quit); ctrl+Q is cmd+Q and refused too. Print Screen, Insert, the menu key, Caps Lock and media keys are refused with words. Letters are US-layout key positions (other layouts: M6).
- **Scrolling** (`scroll`): the scroll bar of the area holding the target when it can be set (`how: scrolled`), else the wheel in pixels, a page being 85% of the target or window (`how: wheel`). Marks the last look stale, as on Windows.
- **Drag** (`drag`): mouse down, held (`holdMs`, 80 ms at least), `leftMouseDragged` steps over 400 ms, a rest, up; the button always released and the pointer put back.
- **Apps and windows**: `open` (an `.app` in /Applications, /Applications/Utilities, /System/Applications(/Utilities), ~/Applications, matched by name or display name; or an http(s) address; waits up to 8 s for its window), `switch` (best match by app or title, Spaces included; Accessibility raise plus activation), `window` (minimize; maximize = fill the display's visible area, never macOS full screen; restore = un-minimise, or the box before maximize; move to display n, centred), `desktop` (next/previous Space: control+right/left, the Mission Control shortcuts, which must be on in System Settings > Keyboard > Keyboard Shortcuts > Mission Control), `wait`, `steps`.
- **Screenshot** (`screenshot`, `allowScreenshot` on): ScreenCaptureKit (macOS 14+; the app's own windows left out) or the older Quartz capture on macOS 13 (the pointer hidden first), only as many pixels as the answer needs (640, 1024, 1568 on the longer side), JPEG quality 72, as the Windows app sends.
- **Coordinates**: points with the origin at the top left of the main display (the one with the menu bar), y down; displays left of or above it are negative. That is Accessibility's, CGEvent's and Quartz's own space, so a point is used as is on whichever display it is; a bare x,y on no display is refused rather than clamped (`Coordinates.display(at:)`, tested with displays above, left and right).
- Not here: self-update (Axis never offers this Mac the Windows build; update by building again), a hotkey to pause (the Windows app's ctrl+alt+S), an Esc key that cancels (the Windows app has none either).

## Readings: power and use (0.7.0)

The app sends `sense` readings (client guide, section 11), as the Windows app does:

- `battery` (0 to 100 %) and `charging` (1/0), from the Mac's internal battery; `onPower` (1/0), whether it runs on mains power (a UPS's or the battery's power is not); `uptimeS`, seconds since the Mac started (`kern.boottime`); `turnsToday`, turns started on this Mac since local midnight (talk key or typed text; the count restarts when the app does).
- What macOS does not say is left out, never guessed: a Mac with no battery sends `onPower` only.
- When: as soon as the connection is up, then on a change at most every 30 s, and every minute otherwise. IOKit's power sources are read on a task of their own every 5 s, and at once when macOS reports a change (`IOPSNotificationCreateRunLoopSource`) or the Mac wakes; never on the main thread or the talk key's path.
- `AxisDesktopCore/Readings.swift` holds the logic behind a `PowerSource` protocol (tested on Linux with a fake); `AxisMacPlatform/MacPower.swift` is the IOKit part. That part has not been compiled yet.

## What is new in 0.4.0

The five gaps of `docs/client-parity.md` section 4 that are the Mac's own, with talking from this Mac on (Axis sends all of it only to a client with `screen`).

- **Typing to the agent.** Hold the talk key: talk, as before, but the microphone now starts at key-down and the first second is kept (`PreRoll`), so no syllable is lost; let go before 220 ms (`TapHold`): a tap, the audio is thrown away (never sent) and the **typing pill** opens in the voice pill's slot: "Typing", a field that grows from one line to three and then scrolls. Return sends `{t: "text", turnId, text}` (1 to 4000 characters, as the web client; `Voice.type` stops speech and any recording and sends `interrupt` first), Shift+Return (or Option+Return) is a new line, Esc closes, ↑ in an empty field brings back the last message. Then it is the voice pill again: Thinking, the reply (clipped as before), spoken. With a question open, the typed text is its answer (Axis decides) and the pill keeps the question and its buttons. The pill is a non-activating panel that may become key (`KeyablePanel`): the app is not brought forward, the app in front stays in front and gets its keys back when the pill closes (a click elsewhere with nothing typed closes it too). Optional **typing key** of its own in the window, next to the talk key (default none); with one set, a tap of the talk key listens until a pause, as before 0.4.0. The menu has "Type to VorteX…". Never captured, like the other pills.
- **The task pill** (`progress.show`): under the voice pill, the task's title, "3/5 · deploying" or the note, a thin bar when the steps are counted, "+N" for the other tasks; amber "needs you" when it waits for the person, green "done". A click opens the list (the other tasks, then the steps, at most 8 rows; the rest on the admin page's Live page). A finished task leaves after 90 s, as on the boards, or at once with its ×, which also tells Axis (`gesture` `swipe_down`, a board's swipe) so finished tasks leave every screen.
- **The timer pill** (`timer.next`): the timer's name, the time left and "+N", red in the last 10 s; its × cancels it (`POST /v1/timers/cancel` with the client's token, as the web client). Ringing is Axis's: the chime (below), then the words.
- **Sounds**, made in code (`Sounds`: sine notes with a short rise and an exponential fall, no sound files), on the chosen speaker with an engine of their own: the timer's bell (a `chime` action is declared, so Axis plays it before saying a timer is done, and waits for it only when it played), the soft task-finished chime (two notes, as the web client's; when Axis asks for it), the listening cue (a short rising tone when a hold starts listening). Two settings are declared for the admin page, the boards' `listenCue` and `taskChime` (group Sound, on by default). **Never in quiet hours**: `quietFrom`/`quietTo` from Axis's settings, read on the Mac's clock (Axis reads them in the hub's time zone: the same unless the Mac is elsewhere).
- **Pictures in replies**: the `images` capability (only with talking on); a `reply.image` is fetched from Axis (`/v1/media/…`, no credentials) and shown under the reply in the voice pill, at most 360 by 240 pt, rounded; it goes with the reply and is never captured.

## What is new in 0.3.2

- **The face follows the admin page's Face page, as the boards do**, live, from the settings Axis sends (global, type and device layers): `toolIcons` (dots, line or off), `toolIconMs` (how long an icon takes to form, 150 to 3000 ms), `toolIconDots` (how many of the 78 dots draw the shape, 12 to 78; the rest turn in a ring 80 out round it) and `idleLooksOff` (idle looks it never drifts into; one on show when it is switched off is left at once). Before, it always drew 78 dots in 700 ms, every idle look, and ignored `toolIcons`. `Face.useSettings`, tested in `FaceTests` (the face tests were run on Linux; the panel wiring was not compiled).

## What is new in 0.3.1

- **The pointer looks and moves like the Windows one**: an arrow in the face's cyan with a soft glow, its tip exactly on the spot (no longer a ring centred on it), a ring breathing round the tip while it waits, the agent's words in a dark pill with a thin cyan edge on whichever side of the pointer has room (never off the display, never over the tip or into the notch; `PointerLayout.bubble`). It glides from its last spot (220 ms, eased) and an action waits for it (250 ms after a glide, 100 ms when it appears; `PointerLayout.waitMs`); after open, switch and window commands it points at the window's title bar. Its size is the `pointerSize` setting. Reduce motion: no breathing, no glide, a plain fade. Like the face and pills it is never captured.

## What is new in 0.3.0

- **Talking from this Mac** (on unless switched off in the window): press the talk key (ctrl+option+space; the window records another, or Fn alone) and talk; it listens until you pause, or hold it and it listens until you let go; press it while the agent speaks to stop it. Microphone and speaker are chosen in the window (the system's default unless chosen). Axis's questions show in the voice pill with their buttons.
- **The face**: the boards' face on a frosted disc at the bottom middle of the main display. It springs in when you talk and while an agent is using the Mac (then it shows the computer icon), its mouth follows the voice, and it goes 2.5 s after. "Keep it on screen" (window or menu) leaves it there, idling; then a click on it talks, and a drag with the right button (or with Control held) puts it anywhere (remembered, kept on the displays). Size and place in the window. Light and Dark follow the Mac; Reduce motion turns off the spring and slows the face.
- **The pills** at the top middle: "VorteX is using this computer" with the last thing the agent did (from its first desktop command until 8 s after the last; the admin page's "Show the pointer" does not count), and the voice pill under it (Listening, Thinking, Speaking, what was heard, the reply, a question with its buttons; it goes 6 s after the answer). On a MacBook with a notch the first pill grows out of the notch and draws back into it. Both are click-through (the question's buttons apart) and never take the focus.
- **Out of the picture**: the face and the pills are marked as never captured (`sharingType = .none`), so screenshots and OCR never see them (the Windows app hides them for a moment instead). The same holds for screen recordings and screen sharing you make.
- **The logo**: the app has the Vortex icon (Finder, the window's About, Force Quit); the menu bar icon is the spiral drawn in code, with a mark for the state: drawn in (listening), sound arcs (speaking), a pointer (an agent is using this Mac), pause bars (paused), struck through (offline).

## Trying the face, the pills and the logo

1. Build with `scripts/build-mac.sh` and open the app: Finder shows the Vortex icon on `build/VorteX Axis.app`; the menu bar shows the spiral (struck through until it is online).
2. In the window, "Face and notices" > **Try them**: the "using this computer" pill comes at the top (out of the notch on a MacBook that has one) and the face at the bottom with the computer icon; both go about 10 s later. The menu bar icon shows the pointer meanwhile.
3. Switch on "Keep it on screen": the face stays, idling through its looks. Click it: it listens (green, the mouth following your voice; the voice pill says Listening). Drag it with the right button: it moves and stays there after a restart; "Place" now offers "Where you put it".
4. Ask the agent to look at the window in front (talking or typing): the pill says what it did; take a screenshot through the agent with the face kept on: the face is not in it.
5. Ask something that needs an answer here (anything Axis confirms, such as sending a message, with "Ask before risky actions" on): the voice pill shows the question with Allow and Deny; click one.
6. Switch the Mac to Light mode and Reduce motion (System Settings > Accessibility > Display): the disc follows, the face no longer springs in.
7. Pause from the menu: the menu bar icon shows the pause bars, the pill goes, the face stays idle (or away).

## What changed in 0.2.1 (from 0.2.0's live test on Brave)

- **The window is the app's real top-level window, toolbar included.** 0.2.0 walked only the focused AXWindow; Brave (in full screen at least, where Chromium shows its tabs and address bar in a window of their own over the page window) gave its page window (`0,114 1470x842`), so the toolbar, address bar and tabs were never read and `find "Address and search bar"` found nothing. Now `AXReader.realWindow` (rules in `WindowPick.real`, tested) takes the focused window (else main, else biggest) that is not a toolbar strip of another, swaps a page window lying inside a bigger standard window for that window (a dialog or sheet never), walks its toolbar windows too, and joins any toolbar strip Quartz shows over it (`WindowPick.strip`) to its box. Element 1 and the header give the whole window; page elements are still cut to the page; the browser-bar guard now refuses a page click anywhere between the window's top and the page's top (else the top 100 pt, as before).
- **One entry per window** in `window do=list` and a screen look: an untitled toolbar strip is folded into its window (the box grows to hold both), and an untitled window under 200 pt wide is left out when its app has another window listed (`WindowPick.merged`).
- **`window` acts on the real window and says what happened.** Minimize, maximize, restore and move go to that window (`Apps.realWindow`); a window in full screen leaves it first to be minimised or moved (macOS ignores both in full screen: the likely reason 0.2.0's minimize answered ok and did nothing); every change is read back (kAXMinimized, the box) and a change that did not take fails with words. The answer has `minimized: true/false`. Restore finds minimised windows: by name through Quartz, else through every app's AX windows; with no name, the window the app last minimised.
- **Less noise in looks**: a `text` or `image` inside an actionable control whose name is the same or holds it is left out, and so is a `group` named as an element inside it (`ReadingOrder.dropEchoes`, tested); the focus always stays.

## Trying each command (ask the agent)

- look: "look at the window in front" (check the header's window box matches element 1, and a browser shows its toolbar and page); "look at the screen"; "list the open windows" (windows on other Spaces marked).
- find/click: "find the address bar in Brave and click it" (answer `how: focused`), "click the Reload button" (`invoked`), "right-click the first link" (a context menu, then "look" lists its items first).
- type/keys: "type hello into the address bar", "press cmd+l", "press ctrl+a" (sent as cmd+a), "press ctrl+tab", "press cmd+q" (refused).
- paste/clipboard: "paste this paragraph into Notes", then "read the clipboard" (what you had copied before is back).
- scroll: "scroll down two pages", then click an id from the look before (read again, or refused as moved).
- drag: "drag the file from this Finder window to that one".
- open/switch/window/desktop: "open TextEdit", "open https://example.org", "switch to Terminal", "maximize the window", "move it to display 2", "minimize it", "go to the next desktop".
- screenshot (switch it on first on the admin page): "take a screenshot of the window, low detail".

## Known limitations (untested on a Mac; 0.2.1 to 0.4.0 not yet compiled)

0.4.0 first: that it builds (`NoticePills.swift`, the `KeyablePanel`, `PillStack`, `AudioIO.playSound`); then that the typing pill takes keystrokes while another app stays in front, and that this app's window gets them back on Esc/Return (the likeliest trouble: the app in front getting its keys back only after a click); Return against Shift+Return (`NSApp.currentEvent`) and with an input method (Japanese, Chinese) composing; that a tap under 220 ms feels right and a hold does not lose the first word; the orange microphone dot on a tap; the field growing from one to three lines; the pills stacking (control, voice/typing, task, timer) round a real notch; the task pill's click and ×; the timer's × (`/v1/timers/cancel`); the chimes' loudness on MacBook speakers and that none plays in quiet hours; a picture's fetch and size.

0.3.0 first: that it builds (SwiftUI in panels, `NSHostingView` subclassing, the `CASpringAnimation` on the face's layer, the Carbon hot key, AVAudioEngine); the face's frame rate (a 60 Hz timer while it shows) and how it looks on light and dark wallpapers; the pill's fit around a real notch (`safeAreaInsets`, `auxiliaryTopLeftArea`); that the question's buttons take a click without the panel taking the focus; the talk key with other apps holding the same combination; whether macOS 15 still keeps `sharingType = .none` windows out of ScreenCaptureKit (the app's own windows are excluded there anyway).


0.2.0 was built and its reading and input worked on Brave (type, click by name, keys, scroll, refusals, the window list across Spaces); what is below was not yet tried there. 0.2.1 is not compiled: first, that it builds; then a look at Brave windowed and in full screen (toolbar, address bar and tabs listed, element 1 the whole window), `window do=list` (one Brave entry), minimize/restore with and without a name (`minimized` in the answer), and the click guard just under the address bar. Older items, roughly in order:

- That it compiles: Swift concurrency (closures crossing to the accessibility and input queues, `MainActor.run` around the pointer, the pasteboard and `NSScreen`), CF casts in `AXReader`/`AXActions`/`Apps`, `Carbon.HIToolbox` key codes, the ScreenCaptureKit availability checks, the run-time lookup of `CGWindowListCreateImage` for macOS 13.
- Chromium: whether `AXEnhancedUserInterface` plus the 300 ms settle gives Brave/Chrome/Edge/Arc their toolbar and page on the first look, or only on the second; whether 1 s of walking reaches a long page's controls.
- Clicks: AXPress on Chromium page elements, the focus of web fields, AXShowMenu, `cannotComplete` treated as pressed, the double click's click state, the browser-bar band of 100 pt on Safari's compact bar.
- Activation from an accessory app on macOS 14/15 (`AXFrontmost` plus `activate()`): the likeliest "it did not come forward".
- Typing into terminals, remote desktops and some Electron fields that ignore Unicode key events (paste is the way round); Secure Event Input silently dropping keys while any password field has the focus.
- Scroll directions of the synthetic wheel with natural scrolling on or off; scroll bars that refuse to be set.
- `window`: maximize/restore by position and size on apps that clamp them; move to a display above or left.
- Screenshots and OCR: ScreenCaptureKit's `sourceRect` per display, the composite across two displays, the speed now that only the area is captured at the needed size with Vision's fast recogniser (4 s limit).
- `desktop next/previous` with the Mission Control shortcuts on, and the arrows' fn/numpad flags.
- Window titles without Screen Recording (the AX title for the front window; app names for others).
