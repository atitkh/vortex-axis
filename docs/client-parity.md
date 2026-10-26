# Client parity: how the clients differ in how they work

Written 2026-10-20 from the code at Axis 0.47.1, board firmware 0.18.2, Windows desktop app 0.10.5, Mac desktop app 0.3.2, protocol 1. It is an analysis, not a plan that was agreed to: each row says which side would change to make the clients behave alike, and roughly how big that change is (S: under a day, M: a few days, L: a week or more).

**[code]** means read in the code (file named); **[inferred]** means worked out from names, comments or docs, not followed through.

The four clients:

- **Board**: `firmware/waveshare-amoled-1.8/src/main.cpp`, `vortex.cpp`, and `firmware/common/src/axis_client.cpp` (the protocol). Capabilities `screen`, `speaker`, `mic`, `image-frames`. The round Waveshare 1.75 (`firmware/waveshare-amoled-1.75`, added 2026-10-26, firmware 0.1.0) behaves as the 1.8 in every row below; its `main.cpp` follows the 1.8's and it draws the 1.8's `vortex.cpp`. What differs is only geometry and hardware: everything laid out in a circle (no `glowCorner`, a round glow), two microphones averaged, `screenRound` reported.
- **Web**: `web/client.js`, `web/vortex.js`. Capabilities `speaker`, `screen`, `buttons`, `images`, and `mic` when the browser has one.
- **Windows**: `clients/windows-desktop/` (`Axis.Desktop.Core/Voice.cs`, `Face.cs`, `DesktopCommands.cs`, `VortexDesktop/App.xaml.cs`). Capability `desktop`; with "Talk from this computer" on, also `mic`, `speaker`, `screen`.
- **Mac**: `clients/macos-desktop/` (`AxisDesktopCore/Voice.swift`, `Face.swift`, `DesktopIdentity.swift`, `AxisMacUI/AppModel.swift`). Same capabilities and the same switch as Windows.

## 1. The table

| Area | Board | Web | Windows | Mac | To unify | Size |
| --- | --- | --- | --- | --- | --- | --- |
| **Face states and looks** | All 6 state looks, 14 idle, 2 held; `setup` used [code `vortex.cpp`] | The same, the canonical port [code `vortex.js`] | Same looks minus `setup` (never needed); no reduced motion [code `Face.cs`] | Same as Windows; Reduce motion multiplies the whole `dt` by 0.3, so easing and the icon's time to form also slow, where web slows only the phases [code `Face.swift` `frame`] | Mac: apply 0.3 to the phases only, as `vortex.js` does. Windows: read the system's "show animations" setting | S |
| **Which look when** | From its own link state and turn state; listening starts before Axis confirms [code] | From turn state; error shown 5 s [code `client.js`] | From the voice part's mode, plus "an agent is using this computer" shown as thinking with the `computer` icon; the face is only on screen during a turn unless kept [code `FaceWindow.Set`] | Same as Windows (`FaceShow.of`) [code] | Fine as is: per-device freedom (`docs/face.md` 6). Desktops never show `offline` while hidden; acceptable | none |
| **Idle looks and `idleLooksOff`** | Applied live [code `main.cpp applySettings`] | Applied live [code] | Applied live since 0.10.5 [code] | Applied live since 0.3.2 [code] | Done | none |
| **Tool icons** (`toolIcons`, `toolIconMs`, `toolIconDots`) | Applied live [code] | Applied live [code] | Applied live since 0.10.5 [code] | Applied live since 0.3.2 [code] | Done. Note: Axis sends `doing` only to a client with `screen` [code `turns.ts` 916, 1006], so a desktop with talking off never gets tool icons for its own turns (it has none) and shows only the `computer` icon | none |
| **Thinking/progress line** (`progress.show`: tasks, steps, chime) | Line under the face, step list, swipe to dismiss, `taskChime` [code `axis_client.cpp` 1288, `main.cpp`] | Line with bar and step list, chime [code `client.js` 549] | None: answers "not implemented on this device" [code `DesktopCommands.cs` default] | None, same answer [inferred from the same Core port] | Desktops: show it in the voice pill or the control pill. Axis already sends it to every `screen` client [code `progress.ts` 255] | M each |
| **Timers** (`timer.next`, the ringing) | Countdown on screen, red edge glow in the last 10 s (`timerGlow`), chime then speech [code] | Countdown line [code `client.js` 543] | No countdown ("not implemented"); the ring is speech only (no `chime` action declared) [code `timers.ts` 200, 249] | Same as Windows [inferred] | Desktops: a countdown in a pill and a `chime` action (Axis then chimes first by itself) | S to M each |
| **Questions/approvals with buttons** (`ask`, `ask.end`, `answer`) | Question under the face, choices as buttons, also spoken answer [code `main.cpp` 213, 591] | Choices as buttons, typed answer too [code] | Voice pill with buttons; needs talking on (`screen`) [code `Voice.cs` 317] | Same [code `Voice.swift`] | Same mechanism. A desktop with talking off gets questions spoken nowhere: Axis picks another output [inferred `hub.pickOutput`] | none |
| **Questions waiting elsewhere** (`ask.waiting`) | Blue edge glow (`notifyGlow`) [code] | Not handled [code: no case] | Not handled | Not handled | Web and desktops: a small mark; low value | S |
| **Agent at a computer** (`desktop.busy`) | Rose edge glow (`handsGlow`) [code] | Not handled | Not sent to desktops (Axis skips `desktop` clients) [code `desktop.ts` 137] | Same | Web: could show a mark; desktops have their own pill | S |
| **Chime/sounds** | `chime` action (boot chime; Axis plays it before a timer is announced and before a timed task's spoken answer, `timers.ts` 200, `turns.ts` 1097), listening cue (`listenCue`), task chime [code] | Task chime only [code `client.js` 579] | None [code: no cue/chime] | None [code] | Desktops: declare a `chime` action and play a short sound; add a listening cue setting | S each |
| **Quiet hours** | Axis caps `volume` and `brightness` in the settings it sends (`withQuiet`); the board applies both [code `quiet.ts`, `main.cpp`] | Applies the capped `volume` only if a `volume` value is set (web declares none, so usually no cap) [code] | Ignores `volume`: speech plays at the system volume in quiet hours. Unprompted speech is shown silently (Axis side) [code `delivery.ts` 79] | Same as Windows [code: no `volume` in `Voice.swift`] | Server: cap with `quietVolume` even when no `volume` is set (send `volume` = min(100, quietVolume)). Desktops: read `volume` and scale playback | S server, S each desktop |
| **Wake word** | On the board, `wakeListen`, `wakeSense`, custom models via `wake.model` [code] | None (CLAUDE.md "Not built") | None | None | Out of scope unless asked (CLAUDE.md) | L |
| **Listen triggers / hold to talk** | Tap, hold, wake word; follow-up listening (`followUpMs`), `onsetMs`, `silenceMs`, `maxSpeechMs` [code] | Tap and hold the face/button; 1.2 s silence, 6 s nothing said fixed [code `client.js` 952] | Talk key: press, hold; a click on a kept face; 1.2 s silence, 6 s, 30 s fixed [code `Voice.cs` 36] | Same as Windows, Fn alone possible [code] | Web and desktops: read `silenceMs`, `onsetMs`, `maxSpeechMs`, `followUpMs` if the owner wants one place to tune them (they are board-declared today, so desktops would have to declare them) | S each |
| **Barge-in** | Wake word over speech only with `bargeIn`; a tap always stops [code] | A tap stops (`interrupt`) [code] | The talk key while speaking stops [code `Voice.cs` 110] | Same [code] | Alike enough | none |
| **Echo cancellation** | `echoCancel`, only with `bargeIn` [code] | Browser's (`echoCancellation: true`) [code `client.js` 879] | None, never listens while speaking (by decision) [code comment `AudioIO.swift` 87 says "the Windows decision"] | None, same [code] | None needed while desktops do not listen during speech | none |
| **Volume and settings keys** | Declares its own (volume, brightness, rotation, glows, listening timings...) [code `main.cpp` 29] | Declares nothing (no `describe`): the admin page shows only Axis's built-ins for `web`; still reads `volume` [code] | Declares 8 `Desktop` toggles + `pointerSize`; reads none of the sound or listening keys [code `DesktopCommands.cs` 870] | Same 8 + `pointerSize` [code `DesktopIdentity.swift`] | Web: send a `describe` with `volume`. Desktops: declare `volume` (and use it) | S each |
| **Notifications** | Edge glows (`notifyGlow`): amber for a waiting task, blue for a question elsewhere, green flash on done [code] | Web Push to the browser [code `client.js` 1173, `delivery.ts`] | None | None | Desktops: a system notification for a waiting task or a kept message would match the web; M | M each |
| **Pause** | None | None | Pause (tray, hotkey ctrl+alt+S): refuses desktop commands [code `App.xaml.cs`] | Pause from the menu bar, no hotkey [code README] | Fine: pause is about the desktop tool | none |
| **Say/ask from an agent** | Spoken, text on screen [code] | Spoken and shown [code] | Spoken and shown in the voice pill when talking is on; with it off, the desktop is not an output (no `speaker`/`screen`) and Axis picks another device [code `hub.ts` 221] | Same | Same mechanism | none |
| **Kept messages** (said when a device comes back) | Server side, delivered as speech on reconnect [code `delivery.ts` 162] | Same, plus Web Push while away | Same as board when talking is on | Same | Server mechanism, shared | none |
| **Pictures** | `image-frames`: JPEG frames over the socket, fitted to the screen [code `media.ts`] | `images`: `reply.image` with a URL [code] | Neither: pictures in a reply are dropped, with a log line on the server [code `media.ts` "no client that shows pictures"] | Neither | Desktops: declare `images` and show the URL's picture in the voice pill | M each |
| **Admin page settings per client type** | Its 20 declared settings + Axis's built-ins [code] | Built-ins only [code: no describe] | 8 toggles + `pointerSize` + built-ins (the face settings now take effect) [code] | Same as Windows | See "Volume and settings keys" | — |
| **Typed turn** (`text`) | None (no keyboard) | Text box sends `{t:"text", turnId, text}`; typed while a question is open answers it [code `client.js` 1137] | None | None | See section 2 | S to M |
| **Missing capability** | — | — | — | — | Section 3 | — |

## 2. Feasibility: typing to the agent from the Mac and Windows apps

**What the web client sends** [code `web/client.js` 1126-1139]: `{ t: "text", turnId: <new id>, text }` (1 to 4000 characters, protocol `Text` in `protocol/src/messages.ts`). Before sending it stops its own playback and recording.

**What Axis does with it** [code `server/src/turns.ts` 549-559]: if a question is open on that client, the text is the answer (`endAsk ... "typed"`) and the turn goes idle; otherwise any running turn of that client is cancelled and `run(session, turnId, { text })` starts an ordinary turn. No capability is required to send it. The answer comes back as `reply.text` only to a client with `screen` and as speech only to one with `speaker` (`turns.ts` 854, 908, 948, 1055).

**So for the desktop apps:**

- With "Talk from this computer" on (capabilities include `screen` and `speaker`) everything needed is there: the voice part already shows `reply.text`, `turn` states and questions in the voice pill. The work is a text box (a hotkey such as ctrl+alt+T on Windows, cmd+shift+T or a menu bar item on the Mac, opening a small field at the top of the screen like the pills) and one call: `link.TrySendAsync({t:"text", turnId, text})`, after `voice.Interrupt()`. `Voice` needs a `Type(string)` method that stops playback, clears an open question locally if the text answers it (as `settleAsk` does on the web) and sets the turn id so the following `turn`/`reply.text` messages are shown. Windows: Core `Voice.cs` (S), a WPF field window (S to M). Mac: Core `Voice.swift` (S), an `NSPanel` with a text field that takes the focus (S to M; the pills never take the focus today, so this one panel must, and give it back).
- With talking off (capability `desktop` only) a typed turn would run but its answer would go nowhere: Axis sends no `reply.text` and no speech. Either the text box requires talking on, or the app sends a separate capability set. Simplest: offer typing only when talking is on, or advertise `screen` whenever typing is enabled (then questions also come to it, which it already shows).
- No server change is needed. Size: M per app, mostly UI.

## 3. Feasibility: an admin editing a device's capabilities

### What happens today [code]

- A client states its capabilities in `hello`. `hub.handleHello` calls `store.recordHello` (`store.ts` 506), which **overwrites** the stored list on every connection, then reads the record back into `session.client`. So an admin edit stored in the same column would be lost on the next connect.
- Every decision reads `session.client.capabilities` at the moment it is needed: output choice (`hub.ts` 221), announce (`http.ts` 755), wake-word use (`http.ts` 807, `wakewords.ts` 150), progress and timers lines (`progress.ts` 255, `timers.ts` 249), questions spoken when there is no screen (`turns.ts` 664), reply text and `doing` only with a screen (`turns.ts` 854), mic needed for audio (`turns.ts` 777), pictures (`media.ts` 166), delivery in quiet hours (`delivery.ts` 79, 194), the desktop tool (`desktop.ts` 137, 173, 185, 395), the agent's turn header (`turns.ts` 809). There is no separate copy to keep in step.
- A change of capabilities after `hello` is honoured only by reconnecting: the desktop apps reconnect when talking is switched on or off (`App.xaml.cs` `SetVoiceAsync`, Mac `AppModel`), and the new `hello` replaces the list. A board's list is fixed in firmware.
- The admin page's rename already swaps `session.client` for a live session (`http.ts` 764-776), the pattern an edit would follow.

### Proposed design

1. **Store two things per client**: what it reported (`capabilities`, still written by `recordHello`) and what the admin switched off (`capabilities_off`, a new column, JSON list, default `[]`). The **effective** list is reported minus off. `getClient` and `authenticate` return the effective list in `capabilities` and both lists separately (`reported`, `off`) for the admin API. Only removal is allowed: an admin cannot give a board a `desktop` it does not have.
2. **Admin API**: `PATCH /admin/clients/:id` accepts `{ capabilitiesOff: string[] }` (validated against `CAPABILITIES`), stores it, replaces `session.client` for a live session (as rename does), and pushes the change to the device (step 3). `describeClient` shows reported, off and effective.
3. **Telling the device**, with no protocol change: a built-in setting `capabilitiesOff` (kind `text`, group `Axis`, device layer only) in `schema.ts`, written by the same PATCH into the device layer, so it rides the ordinary settings sync (`hub.pushSettings` for that client). A client that knows the key stops doing what it lost; one that does not still gets nothing for it from Axis, because every server decision uses the effective list.
4. **Clients honouring it live**:
   - Board (`main.cpp applySettings`): `screen` off: blank the panel and stop drawing the face, keep the socket; `speaker` off: mute and answer `playback` blocked; `mic` off: stop the wake word and tap-to-talk (`mic::setWakeEnabled(false)`), show nothing. `image-frames` off needs nothing on the board (Axis stops sending).
   - Web (`client.js` `settings` case): hide the face and text for `screen`, mute for `speaker`, disable the talk button for `mic`.
   - Windows and Mac: `mic`, `speaker` or `screen` off behaves like talking switched off for that part (no talk key, no playback, no pills); `desktop` off: every `desktop.*` command refused (the same path as Pause).
5. **Edge cases**: an admin turning off `mic` on the only device with one; turning off `screen` on a device mid-question (Axis should end the question with `ask.end` and ask elsewhere); the hello still lists the full set, so `recordHello` must keep writing only the reported column.

### Touch points

- `server/src/store.ts`: migration for `capabilities_off`; `recordHello` unchanged in meaning; the row mapping (263) computes the effective list; a setter.
- `server/src/http.ts` 764 (`PATCH /admin/clients/:id`) and `describeClient`.
- `server/src/hub.ts`: nothing in `handleHello` beyond reading the effective record it already reads back (358-359); `pushSettings(filter)` after an edit.
- `server/src/schema.ts`: the `capabilitiesOff` built-in; `server/test/device-admin.test.ts` 48 lists built-in keys and must gain it.
- `web/admin.js`: switches per capability on the device page.
- Clients: `firmware/waveshare-amoled-1.8/src/main.cpp` (`applySettings` and the drawing loop), `web/client.js`, `clients/windows-desktop/VortexDesktop/App.xaml.cs` (and `DesktopCommands.Paused`-like refusal in the Core), `clients/macos-desktop/Sources/AxisMacUI/AppModel.swift`.
- Size: M server and admin page, S to M per client.

## 4. The five biggest gaps

1. **Desktops show none of the long-task line** (`progress.show`) or timer countdowns, though Axis sends both to them whenever talking is on, and they answer "not implemented". [code]
2. **Pictures never reach a computer**: neither desktop declares `images`, so a picture in a reply is dropped when the computer is the one talked to. [code]
3. **Quiet hours do not quieten a computer** (nor usually the web): the cap works by lowering a `volume` value that the desktops never read and the web rarely has. [code]
4. **No typed turn from a computer**, though the server needs nothing new for it. [code]
5. **No sounds on a computer**: no `chime` action (timers ring with speech alone), no listening cue, no task chime. [code]
