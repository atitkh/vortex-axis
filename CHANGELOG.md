# Changelog

What changed in VorteX Axis, newest first. One number covers the server and its web pages (the admin page and the web client), which ship together; it is written once, in the top-level `package.json`. Firmware counts its own versions per device type, and the protocol between devices and Axis has its own single number that changes only when devices and Axis must change how they talk.

Numbers go `0.middle.last`: the middle one for a batch of new things, the last for fixes. Before 0.14.0 everything called itself 0.1.0; the entries below that are written back from the history.

## Axis 0.68.3 (2026-10-29)

- **`show`'s tool text no longer names a screen size:** it said boards are about 368x448 and the round one 466 across, and agents used those numbers for every picture whatever the device. It now says to take the size from the device's own screenW and screenH. No behaviour change.

## Axis 0.68.2 (2026-10-29)

- **`show`'s `fit` description tells the agent to leave it out:** agents kept passing `fit: contain` on every picture (an agent session also kept the schema it first loaded, which said contain was the default), so pictures stayed shrunk, on a round board inside the circle. The tool text now says cover is the default and right for nearly everything, and contain is for when the whole picture must stay visible. No behaviour change. An agent session may need a new session to see the new text.

## Axis 0.68.1 (2026-10-29)

- **`show` fills the screen by default:** `fit` is now `cover` unless `contain` is asked for (the tool, the node command, `POST /admin/clients/:id/show`, and the Show a picture form on the Tools tab, which starts on Fill the screen). A picture now fills a round board's whole circle rather than sitting inside it, so a card meant for that board should keep its content in the middle. `contain` still keeps the whole picture.

## Round board firmware 0.9.0 (Waveshare 1.75) (2026-10-29)

- **Pictures for the `show` tool (Axis 0.68.0):** a picture stays up for `image.start`'s `seconds` (1 to 300) when given, otherwise 30 s as before, and the time counted from the end of the speech uses the same length; `image.clear` closes the picture on screen as its time running out would (with a `turnId` only that turn's picture) and drops one still arriving or not yet shown. The client core (`axis_client.*`): `takePicture(..., seconds)` beside the old call, `pictureCleared(turnId)`. Serial log `[picture] N bytes, shown with S s` and `[picture] closed by time|tap|clear|question|edges`.
- **Console:** `pcm picture [SECONDS]` (turn `say-console`) and `pictureclear [TURN]`.
- Flashed by USB to the bench round board (D460), back on Axis at 0.9.0; checked on the console: 5 s closed by time after 5.0 s, a newer picture replaced the one up, `pictureclear` and `pictureclear say-console` closed it, `pictureclear say-other` left it, 30 s without seconds, 60 s with 60. NOT verified: `seconds` and `image.clear` from Axis (the hub runs 0.67.0, without the show routes), a tap closing it (nobody at the bench; that code is unchanged).

## Board firmware 0.25.0 (Waveshare 1.8) (2026-10-29)

- The round board's 0.9.0 picture handling (`seconds`, `image.clear`), same code. Built, NOT flashed (no 1.8 attached), not pushed.

## Axis 0.68.0 (2026-10-29)

- **The `show` tool** (`vortex_axis_show`, node command `vortex.axis.show`, and over MCP; `server/src/show.ts`): a picture on a device's screen for `seconds` (1 to 300, 10 by default), silently, with no turn behind it. The picture is exactly one of `url` (https only, fetched once: 5 MB, 10 s, no redirects, refused when the host is on this machine or a private or link-local network unless it is the OpenClaw gateway's host), `path` (a file on the gateway's machine, only through its media route) or `base64` with `mime`; the type is read from the bytes. `client` (default the device last spoken to), `alt`, `fit` (`contain` or `cover`), `clear: true`. The result says per device `shown` and why not: no screen, its screen switched off on the admin page, offline, a WebP or GIF to a board. Allowed in quiet hours and on the silent profile. Screens do not confirm a picture.
- **Protocol 1, additions old clients ignore:** `seconds` (1 to 300) on `image.start` and `reply.image`; `image.clear` (optional `turnId`) takes a picture down early. Turn ids of shown pictures start with `say-`.
- **Fit:** `fit.ts` can fill the screen (`cover`, the middle kept), and a round board (`screenRound` 1) gets a whole picture fitted inside its circle.
- **Recent pictures:** the last 30 shown, in memory, with thumbnails in the media store (a day at most); `GET /admin/pictures`, `POST /admin/pictures/:id/show`; routes `POST /admin/clients/:id/show` (JSON, base64 up to 5 MB) and `/show/clear`. The activity log gets "picture shown on <device>, <description>", never the picture. MCP takes bodies large enough for a picture in base64.
- **Admin page:** a device that shows pictures has **Show a picture** (a file or an https address, seconds, a description, Whole picture or Fill the screen, Show, Clear) and **Recent pictures** (thumbnail, device, description, time, Show again) on its Tools tab.
- **Agents are told:** the tool's description, the chat endpoint's system prompt and the OpenClaw note say a device with `images` or `image-frames` in `can` shows pictures with `vortex_axis_show`.
- A gateway paired before needs `vortex.axis.show` added to `gateway.nodes.commands.allow` and the node approved again; MCP has the tool at once. Board firmware does not read `seconds` or `image.clear` yet (keeps its 30 s); the web client neither.

## Board firmware 0.24.0 (Waveshare 1.8) (2026-10-28)

- The charge limit, for Axis 0.67.0's `chargeLimit` (50 to 100, 100 = no limit) and the Dock profile. On USB with a battery, at or above the limit the AXP2101's charger is switched off (the board keeps running from USB) and switched on again 5 % below it; while a limit is set the charge target is 4.1 V as a backstop, 4.2 V again when it is lifted. Charging is switched on at 4.2 V at every start (a hold is never carried over a restart), whenever USB goes away and when the limit goes back to 100; the target is never set above 4.2 V; a failed read or write changes nothing. A new limit is applied at once. The rule is `common/src/charge_hold.h`, checked on a computer by `common/test/charge_hold_test.cpp`.
- New readings with a battery: `chargerState` (the charger's state, 0 trickle to 5 stopped), `chargeHeld` (1 while the limit holds charging off) and, with USB, `usbMv`. The `charging` reading stays what the chip says, so a held board shows no charging bolt or cue. Console `power` shows the USB millivolts, the limit and whether it holds.
- `lowBatteryBelow` and `batteryGlyph` moved to the Battery group, beside Charge limit.
- Bench console words: `powerregs` (the chip's registers, read only), `charge on|off|4000|4100|4200` (the charger by hand, until the limit's next read), `chargelimit N` (a limit in place of the setting; alone, back to the setting).
- Built, NOT flashed (no 1.8 attached); the same code as the round board's 0.8.0.

## Round board firmware 0.8.0 (Waveshare 1.75) (2026-10-28)

- The charge limit, its readings, the Battery group and the bench console words as in the 1.8's 0.24.0. Flashed by USB to the round board on the bench (94 % on USB): back on Axis at 0.8.0 with `usbMv` 4983, `chargerState` 2, `chargeHeld` 0. `chargeLimit` 80 set on the device through the admin API (the hub still on 0.66.2, which passes the key on): within 8 s `power` said `not charging (charger state 5), limit 80%, held` and the hub showed `charging` 0, `chargerState` 5, `chargeHeld` 1; registers 0x18 = 08 (charger off) and 0x64 = 02 (4.1 V). Back to 100: `charging ... no limit` at once, charger state 2 (constant current) at the next read, `chargeHeld` 0, registers 0A and 03 (4.2 V). `chargelimit 80` and `chargelimit` on the console did the same. NOT verified: the release at limit minus 5 on a real discharge, USB pulled while held, the Dock profile through Axis 0.67.0 (not deployed), the face while held (not looked at).

## Axis 0.67.0 (2026-10-28)

- **Charge limit** (`chargeLimit`, an Axis built-in in a new **Battery** group): 50 to 100 in whole numbers, 100 (no limit) by default, always sent to every client beneath the saved layers. On USB a board that can hold its battery charges only to the limit and holds it, charging again 5 points below; on battery nothing changes. The holding is the firmware's (next board firmware); a client that does not know the key ignores it. Checked as a whole number in range by the admin API and `vortex_axis_config`.
- **The Dock profile** (`server/src/profiles.ts`): normal in every respect but one, `chargeLimit` set to the hub's new **Dock charge limit** (`dockChargeLimit`, System page beside Power saver below, 50 to 100, 80 by default, `AXIS_DOCK_CHARGE_LIMIT`); sent again at once to devices on Dock when it changes. Chosen by hand only: Auto never picks it. On the Overview's Profile switch, in Settings, and `vortex_axis_config` key `profile` `dock`; worded "Dock: charging held at 80%" in the admin page's profile line and the spoken summary.
- **Charger readings** (`server/src/deviceinfo.ts`): `usbMv`, `chargerState` (0 trickle, 1 pre-charge, 2 constant current, 3 constant voltage, 4 done, 5 stopped) and `chargeHeld`, dropped after five minutes like the other vitals, turned into one charger line ("charging (constant current)", "charging, tapering", "full", "held at 80% by the charge limit", "not charging") in `vitals.charger`, with `USB 4.98 V` for the admin page only. Spoken only when held or full. A held battery is not named the lowest.
- **Admin page:** a **Charger** gauge on the device Overview (the line, the USB volts beneath); **Charge limit** in a device's Settings as a list by fives with 100 named **No limit**, in the Battery group together with the board's **Low battery look** and **Battery mark** (shown only for devices with a battery); a Dock option on the Profile switch and in the profile choices.
- **Protocol:** `SettingDef` gains an optional `step` (the steps an editor moves a number by; a whole step means whole numbers only). Additive: protocol 1 still, older clients unaffected.
- Tests: `server/test/dock.test.ts` (the overlay, auto never Dock, the device's limit outside Dock, validation, the hub setting, the charger lines, freshness, the spoken summary). browser-check: Dock on the Overview with the board sent 80, the charger gauge, the charge limit list in the Battery group staged, saved and undone, the Dock charge limit on System.
- NOT verified: any board holding its battery (needs the firmware that reads `chargeLimit` and reports the charger readings); the look of the new gauge and list (no screenshot taken). Not deployed.

## Axis 0.66.2 (2026-10-28)

- **The device page's Overview is one card** (`web/adm-twin.js`, `web/adm-devices.js`): the status line (with **Name and location** beside it), the sketch and the gauges, then the device's details in the same card: type, version with its update, what it can do, address, pages, where it reaches Axis, the web client's notifications, messages waiting, the offline alert and the id. The separate **About this device** card is gone. `DeviceTwin` takes the details as children and shows them in the card drawn while the map's data is missing too.
- **The previews are on the Tools tab only**: the side column of a device's **Settings** holds its sketch; the edge glow, battery and microphone level cards there are gone, with the `compact` previews they used (`GlowPreview` always lists every glow). The **Glow corner curve**, **Low battery look** and **Battery mark** rows link to the Tools tab.
- browser-check: the overview's details sit inside `#map-device`, no About card; the Settings side column holds one card and no canvas; the battery threshold tick is checked on the Tools tab.

## Axis 0.66.1 (2026-10-28)

- **The battery preview draws the boards' new mark** (`web/adm-tools.js`, `drawBatteryMark`; firmware 1.8 0.23.2, 1.75 0.7.2): a battery outline with soft edges and its fill, the bolt as a filled shape, and the percent as text beside it, in the fill's colour, laid out with the numbers in `docs/face.md` section 10. The percent is drawn in a 22 px sans (Arial or Helvetica, the same figure height and widths as the boards' FreeSans 11 pt), so its letters are an approximation.
- browser-check's battery step looks for an amber fill inside the battery and amber figures beside it at 12 %. NOT verified: the preview side by side with a board's screen.

## Board firmware 0.23.2 (Waveshare 1.8) (2026-10-28)

- **The battery mark looks like the rest of the screen** (`battery_cue.cpp`, `docs/face.md` section 10). The percent is body text in FreeSans (9, 11 or 12 pt with `textSize`), drawn through the same canvas as every other line (`display::textInto`), in the fill's colour: amber, red below 5 %, green while charging. The battery (34 by 16: rounded body, 2-pixel outline, tip, a fill as wide as the charge) and the bolt (a filled polygon) have soft edges, each pixel coloured by how much the shape covers it (4 by 4 samples); the outline and the bolt are worked out once into PSRAM (under 1 KB). The block is 140 by 24 (was 22). Before, all of it was drawn from a 5 by 7 grid at 3 pixels a cell.
- Put on the bench 1.8 over Wi-Fi by a staged rollout from 0.23.1: proven 36 s after it was told to update. NOT verified: its screen.

## Round board firmware 0.7.2 (Waveshare 1.75) (2026-10-28)

- The battery mark as in the 1.8's 0.23.2. Flashed by USB to the round board on the bench: back on Axis at 0.7.2. Pictures of its screen (`shot`) at `preview lowbattery`, `preview charging` and `preview battery 4`: the mark inside the glass, nothing cut off. Frames a second (`fps`, 19 s each, medium text): idle 60.2, low battery 55.1, charging 52.4; listening 62.5 (11 s); before, idle about 60, low battery about 51, listening about 62.

## Axis 0.66.0 (2026-10-28)

The boards' battery look, previewed on the admin page and shown on a board from there.

- **Battery preview** (`web/adm-tools.js`, `BatteryPreview`; `docs/setup.md`, "The battery preview"). Beside the edge glow on a board's Tools tab and in the side column of its Settings, for boards that offer `lowBatteryBelow`: the board's screen drawn at a made-up charge as the board draws it (`docs/face.md` section 10): the idle face sleepy (60 % speed, 75 % brightness, eased in and out), the battery mark with the percent at the bottom middle (inside the glass on a round board), amber cells, red and pulsing every 2.5 s below 5 %, green with the bolt while charging, and the 3 s cyan swell in the edge glow when charging begins. A Charge slider (with the threshold marked, staged values included), a Charging switch, and Low (12 %), Critical (4 %), Charging (64 %, with the cue) and Full/none. `web/vortex.js` still has no battery look.
- **Show on the device** and **Off** call `POST /admin/clients/:id/battery` (`{ percent, charging }` or `{ off: true }`; the board shows it for 20 s, firmware 1.8 0.23.1 and 1.75 0.7.1); only on a button, never while the slider moves. Firmware without the command, or an Axis without the route, is reported as needing newer firmware.
- The glow preview's blend is shared with the battery preview: the glow is mixed over what is underneath, as on the board (over black, as before, on the glow card).
- Checked by browser-check (a pretend board that declares the battery look: the mark's amber cells at 12 %, the quick choices, the bodies sent, the refusals, the threshold mark) and three screenshots. NOT verified: Show on the device against a real board (needs the new firmware and this Axis deployed); the drawing was not compared pixel by pixel with a board's screen.

## Board firmware 0.23.1 (Waveshare 1.8) (2026-10-28)

- **The battery preview from the admin page**: the admin-only command `battery.show` `{ percent, charging, ms, off }` (`firmware/README.md`, "Vitals"), what the console's `preview battery N` and `preview charging` show, for `ms` (2 to 60 s, 20 s by default), then the real state; `off` ends it, a newer one replaces it. The console's previews still last a minute. Axis's side is `POST /admin/clients/:id/battery` (admin only; 400 for a board without `lowBatteryBelow`; the board's own error passed on), in the server since commit 0941515, released with Axis 0.66.0.
- Put on the bench 1.8 (VorteX-Axis-C484) over Wi-Fi by a staged rollout from 0.23.0: proven 34 s after it was told to update. NOT verified: `battery.show` sent to it through Axis (not deployed when this was written), its screen.

## Round board firmware 0.7.1 (Waveshare 1.75) (2026-10-28)

- `battery.show`, the same as the 1.8's 0.23.1. Flashed by USB to the round board on the bench (VorteX-Axis-D460): back on Axis showing 0.7.1; `preview lowbattery` and `preview off` on the console still switch it (`power` said `low battery (preview)`, then nothing). NOT verified: `battery.show` through Axis, the screen while it shows (no picture taken).

## Board firmware 0.23.0 (Waveshare 1.8) (2026-10-28)

- **Low battery and charging on the face** (`battery_cue.*`, `docs/face.md` section 10, `firmware/README.md`, "Vitals"). At or below `lowBatteryBelow` (default 15 %, 0 off, clears 3 above) while not charging, the idle face turns sleepy (60 % speed, 75 % brightness) and a battery mark with the percent stays at the bottom of the screen, amber, red and slowly pulsing below 5 %. When charging begins while the board runs, the edge glow swells once in the idle face's cyan over 3 s and a bolt shows by the mark; while charging the mark stays with the bolt. Never a sound. Follows the power chip's 30 s readings; with no battery nothing shows.
- Settings `lowBatteryBelow` and `batteryGlyph` (the mark on or off). Console `preview lowbattery`, `preview charging`, `preview battery N`.
- The mark's block is in PSRAM, not internal memory.
- Put on the bench 1.8 over Wi-Fi on 2026-10-28 by the hub's staged rollout, from 0.22.0: it was the only board in the rollout, so it went first, and it was proven 36 s after it was told to update. The hub showed 0.23.0, fresh readings and both settings. NOT verified: its screen (no picture taken), a real battery, a real start of charging.

## Round board firmware 0.7.0 (Waveshare 1.75) (2026-10-28)

- **Low battery and charging on the face**, the same as the 1.8's 0.23.0 (the round board links to its `battery_cue.cpp`). The mark sits 26 pixels up from the bottom edge, inside the round glass.
- Flashed by USB on 2026-10-28 to the round board on the bench: the hub showed 0.7.0; screen shots of `preview lowbattery`, `preview charging` and listening showed the mark and the face without clipping. NOT verified: a real battery, a real start of charging, long reply text against the mark.

## Axis 0.65.0 (2026-10-28)

Staged rollout of board firmware: one board first, the rest only once it is proven.

- **Rollout** (`server/src/rollout.ts`, `docs/design.md`, section 8.1). Update all runs on the server over the given boards, or every board on an older build than the shelf's. The first board (the canary) is one not in a turn with the strongest reported Wi-Fi. It counts as proven once it has connected again on the build it was sent and sent readings on that connection, within 6 minutes (the firmware's own window before it rolls back is 3). If it refuses, comes back on another version or does not come back, the rollout stops and the other boards are held, with the reason, under attention and in the activity log. Once it is proven the rest follow at most two at a time; a failure stops the queue. Boards in a turn are tried again; offline ones are listed as skipped. One rollout at a time; one that was running when Axis stopped is marked interrupted at the next start, not resumed.
- **Routes:** `POST /admin/updates/rollout` (`{ ids? }`, 409 while one runs), `GET /admin/updates/rollout`, `POST /admin/updates/rollout/cancel`.
- **Admin page.** Update all on Firmware and on a type's Firmware tab starts the rollout; the rollout card shows the stage, which board went first and why, each board's versions and status (waiting, updating, proven, held, skipped, failed), why it stopped, and Cancel, through the 3 s poll. The map's Axis node says when one runs. A device's own Update button still updates it alone, and its dialog says so. The Quest app's Update all is unchanged.
- `scripts/push-firmware.mjs --update` starts the same rollout.
- Server tests with pretend boards and a pretend clock; `browser-check` runs a rollout over two pretend boards. NOT verified: a real rollout on two real boards; a real rolled-back canary.

## Round board firmware 0.6.0 (Waveshare 1.75) (2026-10-28)

- **Several saved Wi-Fi networks** (`firmware/README.md`, "Saved networks"): up to five, most recently joined first, in a Preferences namespace of their own. At start, and when a dropped connection has not come back within 45 s, the board scans and tries the saved networks in range, strongest first, 12 s each; with none in sight it tries the most recent one. A board that was online looks again every minute and never opens its setup network by itself.
- The one network an older firmware had is kept: at the first start it becomes the list's first entry (`network list started with 1 network`).
- The setup page lists the saved names (never the passwords) with a Forget button; a saved name with an empty password keeps its password. Console `wifi`, `wifi scan`, `wifi add <name> <password>`, `wifi forget <name>`. Axis cannot add a network.
- Readings `wifi` (the network in use) and `wifiNetworks` (how many are saved).
- Flashed by USB on 2026-10-28 to the round board on the bench: the hub showed 0.6.0, `wifi` and `wifiNetworks` 1; a network added from the console that is not in range was listed second, the board rejoined the real network after a reboot, and forgetting it brought the count back to 1. NOT verified: a real second access point, moving between networks, the setup page on a phone in setup mode.

## Board firmware 0.22.0 (Waveshare 1.8) (2026-10-28)

- **Several saved Wi-Fi networks**, the same client core as the round board's 0.6.0.
- Built; NOT flashed (no 1.8 attached), not run on a 1.8.

## Desktop app 0.14.0 (2026-10-28)

- **Power and use as readings** (`sense`, client guide section 11): `battery` (0 to 100 %), `charging` (1/0), `onPower` (1/0), `turnsToday` (turns started on this computer since local midnight: a hold or a press of the talk key, or typed text) and `uptimeS`. Each is left out when Windows does not say; a computer with no battery sends `onPower` only, and only when Windows reports mains power.
- Sent when the connection comes up, on a change at most every 30 s, and otherwise every minute. Windows is asked (`GetSystemPowerStatus`) on the readings' own loop every 5 s, never on the UI thread or the talk key's path; `PowerModeChanged` (a power status change, waking) makes it look at once.
- Core `Readings` (`PowerState.FromWin32`, `TurnCount`, `ReadingsPace`) and `AxisLink.TurnStarted`. Smoke checks 233 (the message's shape, what is left out, the day's count, the pace); the WPF app compiled in the SDK container, not built into the data folder, never run on Windows, never seen on a laptop with a battery.

## Mac desktop app 0.7.0 (2026-10-28)

- **The same readings as the Windows app 0.14.0**, from IOKit's power sources (`AxisMacPlatform/MacPower.swift`: `IOPSCopyPowerSourcesInfo`, `IOPSGetProvidingPowerSourceType`, the internal battery's description; `IOPSNotificationCreateRunLoopSource` for changes) and `kern.boottime` for `uptimeS`. A Mac with no battery sends `onPower` only; a UPS is not taken for the Mac's battery.
- The Core stays Foundation only: `Readings`, `PowerState.fromPowerSources`, `TurnCount` (the local calendar day), `ReadingsPace`, a `PowerSource` protocol (a fake in the tests) and `AxisLink.onTurnStarted`. Core XCTest on Linux under Swift 5.10 with stand-ins: 183 passing. `MacPower` and the `AppModel` wiring were never compiled (no macOS here).

## Board firmware 0.21.0 (Waveshare 1.8) (2026-10-28)

- **Vitals as readings**, the same code as the round board's 0.5.0 (`common/src/axis_power.*`, the 1.8's `imu` and `main.cpp`): the AXP2101 power chip read every 30 s from the screen loop; `chipTempC` always, `battery`, `charging` and `batteryMv` only with a battery connected; `pickupsToday`, `touchesToday`, `turnsToday` counted from the last start; console `power` and `i2c`.
- Client core: 16 board readings (was 8), `Client::clearReading`, and `setReading(key, value, false)` for a value that goes with the regular minute instead of straight away.
- Built; NOT flashed (no 1.8 attached), not run on a 1.8; the 1.8's power chip is taken from Waveshare's documentation and example code (AXP2101, I2C 0x34, SDA 15, SCL 14), not seen on its bus.

## Round board firmware 0.5.0 (Waveshare 1.75) (2026-10-28)

- **Vitals as readings** (`firmware/README.md`, "Vitals"): the AXP2101 power chip at 0x34 (found by its chip ID 0x4A and the console's `i2c` scan) read every 30 s from the screen loop, which only switches on its measurements; `chipTempC` (the power chip's own temperature) always; `battery` (its fuel gauge), `charging` and `batteryMv` only with a battery connected, none of them without one.
- **Use:** `pickupsToday` (motion sensor: more than 0.15 g off the resting pull after 5 s still), `touchesToday` (taps the board acted on) and `turnsToday` (voice turns whose audio went to Axis), counted from the last start: the board has no clock and no time zone.
- Console `power` (the last reading and the counts) and `i2c` (what answers on the bus).
- Flashed by USB on 2026-10-28 to the round board on the bench: boot says `power chip AXP2101 found`, `i2c` lists 0x18 0x20 0x34 0x40 0x50 0x51 0x5A 0x6B 0x7E, `power` says `USB yes, battery none; power chip 49.9 C, processor 54.4 C`, and Axis's `/admin/map` shows its `chipTempC` 50 and the three counts at 0 with no battery block. Pushed to the hub without `--update`. Not exercised: anything with a battery (none connected), a real pickup, tap or turn being counted.

## Axis 0.64.0 (2026-10-28)

Device profiles: normal, power saver and silent, as overrides between a device's own settings and quiet hours.

- **Profiles** (`server/src/profiles.ts`, `docs/design.md`, "Profiles"). Power saver caps `brightness` at 100 and `maxFps` at 15; silent sets `volume` 0 and switches off `listenCue` and `taskChime`, and nothing is spoken on the device: replies and `say` are shown as text, and a device without a screen keeps messages until it leaves silent. Only settings a device has are overridden, so no firmware or app changes. Quiet hours stay the hard cap.
- **Per-device `profile` setting** (group Axis, server-only): `auto` by default (normal, with power saver while a reported battery is at or below the hub's level and not charging, back at that plus 10 or on charging), or a profile chosen by hand, which holds until set back to `auto`.
- **Hub setting `powerSaverBelow`** (0 to 90, default 20, 0 off; `AXIS_POWER_SAVER_BELOW`), edited as **Power saver below** on the admin page's System page.
- **Admin page.** A device's Overview has a **Profile** switch (Auto, Normal, Power saver, Silent) that applies at once, the one control there that does, with the profile in force and why (`on silent (manual)`, `on power saver (battery 17%)`); **Settings in effect** shows the values sent, with the profile and quiet hours applied (`effective` on `GET /admin/clients/:id`, with `profile` and `profileReason`). Settings labels the choices with a line each. A device not on normal carries a chip on the map and in Devices.
- **Agents.** `vortex_axis_config` with key `profile` switches it; `vortex_axis_sense` reports `info.profile` and `info.profileReason`; a turn's context line says a device is silent and to answer in short text.

## Axis 0.63.0 (2026-10-28)

Fixes for board vitals and firmware updates.

- **Readings that stop arriving expire.** Axis keeps when each reading last arrived (`Session.readAt`). A vital (`battery`, `charging`, `batteryMv`, `chipTempC`, `rssi`, `heap`, `soundDb`, `soundActive`) not reported for five minutes (`STALE_READING_MS`) is left out of the device's vitals, attention and spoken summary, so a battery taken out of a running board stops being shown. Other readings, and clients that send only some readings in a message, are unchanged; readings are still cleared on disconnect.
- **Only an older firmware is old.** A device is behind only when the build on the shelf is newer than its version, compared as dotted numbers (`server/src/versions.ts`, `olderThanHeld`); a version Axis cannot read is never flagged. A board ahead of the shelf is no longer listed as "old firmware" and is not offered an Update. The admin page (attention list, Update buttons, badges, type pages, Overview, map) reads `updateAvailable` from Axis instead of comparing versions itself.

## Axis 0.62.0 (2026-10-28)

Wake contests on the map, and the device's live view as the Overview of its device page.

- **Wake words on the map:** `GET /admin/map/stream` sends `wake` (`{contest, at, clientId, client, score, level, outcome}`, never the word) for each device that reported the wake word; reports within the wake window (`AXIS_WAKE_WINDOW_MS`) plus 300 ms of the first share a `contest`. The map draws the latest contest beside each device that heard it: a score bar and a loudness bar with the outcome; the one that answered outlined with its margin ("won by 0.12", or "won on loudness"), the others dimmed as stood down or ignored; a line above the drawing says it in words. It stays 6 s after the last report, then fades (no fade under reduced motion). One device hearing it shows one pair, answered.
- **Device page Overview:** the live view of the device that was its map page (sketch with the face, gauges, attention, settings in effect, last turns, capabilities) now heads the device page's Overview, above About, Actions, the last 24 hours and Readings, which are unchanged; read-only. The shared drawing and the stream live in `web/adm-twin.js`, used by the map and the device page.
- `#map/<client id>` opens the device page. A device on the map opens its device page. The device page's **Map** button became **On the map**, opening the map with that device picked out (`#map?device=<client id>`).
- `npm run browser-check` stages a two-device contest (a pretend second device) and a single wake, checks the fade, the device page's Overview, **On the map** and the old `#map/<id>` address; a server test covers the stream's `wake` event and its grouping.

## Axis 0.61.0 (2026-10-28)

The system map on the admin page, read-only.

- **Map** (`#map`, `web/adm-map.js`, in the sidebar under Overview and in the command bar): one SVG in fixed columns. Devices on the left grouped by location (Unplaced last), each with its name, kind, state colour (idle, listening, thinking, speaking, offline), battery, Wi-Fi bars and version when reported, and a badge with the number of attention items; Axis in the middle; the agent, gateway command link, speech recognition, speech synthesis, voiceprints and Home Assistant on the right with their state and last latency. The lines are the links `GET /admin/map` reports, coloured by state. Under 720 px wide it becomes one column: devices, Axis, services.
- **Live:** follows `GET /admin/map/stream`. A device's colour changes as its state does; a running turn lights its path (the device's line, recognition, the agent, synthesis) with each stage's time, and fades 2 s after it ends. The current stage's line has a moving dash, left out under reduced motion. At most five redraws a second; the stream is closed while the tab is hidden and reopened with a back-off of 1 to 30 s, with `GET /admin/map` read every 10 s meanwhile. A pill shows live, reconnecting or paused.
- **A device's map page** (`#map/<client id>`): its sketch with the live face, its readings as gauges (battery ring, Wi-Fi bars, uptime, free memory, chip temperature, today's use, sound level), only those it reports, with the ones a board did not report listed; attention, version, settings in effect, its last turns and its capabilities (in effect and switched off), and a link to the device page.
- A **Map** link on the Overview and on each device page.
- `npm run browser-check` opens the map (Axis, the device and its line, the services, the stream live), checks that a typed turn lights its path, and opens the device's map page.

## Axis 0.60.0 (2026-10-28)

How each device is doing, in one place, for the agent and for the admin page's system map.

- **Device info** (`server/src/deviceinfo.ts`): one object per client with who it is, whether it is online, what it is doing, its version and capabilities, its `vitals` from its `sense` readings (battery and charging, Wi-Fi signal in words, uptime, free memory, chip temperature, today's pickups, touches and turns, mains power, last restart, room sound) and `attention` (low battery, weak Wi-Fi, an update waiting, offline past its alert time). A reading a device does not send is left out.
- **The readings contract**, in `docs/client-guide.md` section 11: `battery` (0 to 100 %), `charging` (1/0), `batteryMv`, `chipTempC`, `pickupsToday`, `touchesToday`, `turnsToday`, `onPower` (1/0), beside `rssi`, `heap`, `uptimeS` and `lastStart`. Signal: strong at -60 dBm and above, ok to -70, weak to -80, poor below. A battery under 20 % is low.
- **`vortex_axis_sense`** keeps each device's raw `readings` and adds `info` and a `summary` sentence to be spoken ("Desk board: online, battery 62% and charging, strong Wi-Fi, up 3 days."). Without a device named it covers every paired device, offline ones too, and adds `lowest`, the one most in need. Its description now names battery, signal, uptime, restarts and use.
- **`GET /admin/map`** (read-only): the devices with their info, the services behind Axis (agent, gateway command link, speech recognition and synthesis, voiceprints, Home Assistant) with their state and last latency, and the links between them. **`GET /admin/map/stream`** (server-sent events): a device when it comes online or goes offline, when it reports readings (at most every 5 s each) and when its turn changes stage, plus turn stages without words.
- The offline rule for the attention list (boards after 15 minutes, computers and headsets after 12 hours, browsers never, or the `offlineAlert` setting) is decided by Axis only: `GET /admin/clients` gives each client's `kind`, `offlineAfterMs` and `offlineAfterAutoMs`, and the admin page reads them.
- Tests: `server/test/deviceinfo.test.ts` (thresholds, omissions, offline by kind and setting, the spoken summary, `lowest`, the stream's limit and turn stages, `sense` through a running Axis, the map's admin token and shape).

## Mac desktop app 0.6.1 (2026-10-27)

- **The talk key no longer waits for the microphone** (the Windows app 0.13.1's fix). `Voice.keyDown` started a new `AVAudioEngine` (`AudioIO.startCapture`: device choice, tap, converter, `prepare`, `start`) on the main thread under the voice part's lock, and the hold's listening cue opened an output engine the same way; a Bluetooth headset switching profile or a cold input device could freeze the app, the hold timer and the pills for seconds. Now `WarmMic` (`AxisDesktopCore/TalkMic.swift`) opens and closes it in order on its own queue; a hold shows listening at 220 ms, the pre-roll still keeps what was said once the device is on, a failure is said at the hold (a tap types), and the cue plays on that queue.
- **Warm for 3 s** after a release so a quick second press is instant; closed at once when the agent's speech starts, when it is interrupted (sleep included), when the link drops and when the microphone is switched off on the admin page.
- **Timing lines** in Recently, the last five kept: `Talk key: handler +3 ms, mic open +412 ms, first audio +450 ms, listening shown +460 ms` (from the hot key's event time, `GetEventTime`, or the Fn key's `NSEvent.timestamp`). A press while the link is not online says so instead of doing nothing silently.
- Ping and watchdog unchanged (not on the key's path). Core XCTest on Linux under Swift 5.10 with stand-ins: 177 passing (the warm microphone, a slow one on the real queue, failure at a tap and a hold, the line). The AppKit part (`TalkKeyWatcher`'s event time, `AppModel`'s lines and marks) is not compiled.

## Desktop app 0.13.1 (2026-10-27)

- **The talk key no longer waits for the microphone.** The key's handler opened the microphone on the UI thread (`WaveInEvent.StartRecording`, and the listening cue's `waveOutOpen` at the hold), so a slow device (a Bluetooth headset switching to its call profile, a microphone waking up) froze the app, the 220 ms tap/hold timer and the pills for as long as it took, seconds at worst. Now every open and close runs in order on a worker (`WarmMic`, `Axis.Desktop.Core/TalkMic.cs`); a hold shows listening at 220 ms whatever the device is doing, the pre-roll still keeps what was said from key-down once the device is on, and a microphone that fails is said at the hold as before (a tap types and says nothing). The listening cue plays on the same worker.
- **Warm for 3 s.** Let go, the microphone stays on 3 s so a quick second press is instant, then closes; it closes at once when the agent's speech starts (no echo canceller, and a headset leaves its call profile), when talking is stopped, on sleep, when the link drops and when the microphone is switched off on the admin page.
- **Timing lines.** Each press of the talk key adds a line to Recently and the log: `Talk key: handler +3 ms, mic open +412 ms, first audio +450 ms, listening shown +460 ms` (from the key's message: the handler running, the microphone on, or `mic warm` when it already was, its first audio, the listening or typing pill shown); the last five are kept. A press while the link is not online says so (`Talk key: not connected to Axis (connecting)`) instead of doing nothing silently.
- The connection's ping and watchdog are not on the key's path and are unchanged. Smoke checks 211 (the warm microphone, a slow microphone on the real worker, failure at a tap and a hold, the timing line); the WPF app compiled in the SDK container, not run on Windows.

## Axis 0.59.0 (2026-10-27)

When several devices hear the wake word, the nearest one answers, not the one with the marginally best score.

- Wake arbitration (`server/src/wake.ts`): every device scoring within the wake margin of the best score is a candidate, and the loudest candidate answers (ties go to the better score). A device further below the best never answers, however loud. A farther device can score a little higher on the wake word yet hear what follows worse: in a real log three boards scored 95 %, 92 % and 93 % at loudness 2 %, 4 % and 6 %, and the quietest answered.
- The margin is a hub setting, `wakeMargin` (0 to 0.5, default 0.10; `AXIS_WAKE_MARGIN` sets the starting value, a saved one wins), edited on the admin page's **Wake words** page under "When several devices hear it" (in points, 0 to 50) with Save and Undo. 0 is the old rule exactly. It applies to the next wake word, without a restart.
- The activity line of a contested wake word says when loudness decided it: "... answered (chosen by loudness among 3 within 10 points of the best score); stood down: ...". A wake word heard while another device speaks in the same location is still ignored, as before.
- Loudness now means the same on every board (firmware 0.20.1 and 0.4.2 below): decibels over the device's own room noise, divided by 40. The protocol is unchanged (`level` is still 0 to 1), so older firmware keeps working, its loudness only less comparable. `docs/client-guide.md` says what a client with a wake word should send.
- Tests: `server/test/wake.test.ts` (margin 0 is the old rule, close scores go to the louder, a far worse score loses however loud, a score exactly at the margin, one report, ties, the margin read at each decision) and two in `turns.test.ts` (the real three-board case and its log line; the setting saved through `PATCH /admin/integrations`, 0.6 refused); `browser-check` saves the margin on the Wake words page.

## Board firmware 0.20.1 (Waveshare 1.8) (2026-10-27)

- The wake word's loudness (`level` in `wake`) is how far it stood out over the board's own room noise: `clamp(20 × log10(speech / room) / 40, 0, 1)`, with `speech` the loudest ~100 ms running average of the mean absolute sample over the last ~1.3 s and `room` the board's room level as it was before the wake word (the lowest of the last ~2.6 s). A ratio of two figures from the same microphone, so it does not depend on the gain and reads the same on a round board. It was the raw loudness, so a board with more gain (the 1.75 since 0.2.1) or a quieter microphone looked nearer or farther than it was. Shared with the round board in `common/src/wake_level.h`. The log shows it: `[wake] heard it (score 0.98, level 0.97: 38.7 dB over the room, speech 1136, room 13.2)`.
- Built; NOT flashed (no 1.8 attached), not pushed over Wi-Fi.

## Round board firmware 0.4.2 (Waveshare 1.75) (2026-10-27)

- The same wake word loudness as the 1.8's 0.20.1 (`common/src/wake_level.h`): decibels over the board's own room noise / 40, independent of the microphone gain raised in 0.2.1.
- Flashed by USB on 2026-10-27 to the round board on the bench (VorteX-Axis-D460), which reconnected to Axis (room level 16). "Hey Vortex" played through its own speaker with `pcm` at full volume, −6 dB and −12 dB: score 0.98, 0.94, 0.88; 38.7, 34.1 and 28.2 dB over the room, level 0.97, 0.85, 0.70; full volume again 38.6 dB. Nobody said it at two distances; not pushed over Wi-Fi.

## Axis 0.58.0 (2026-10-27)

The classic admin page is removed, and firmware releases are checked like the rest.

- `web/admin.html`, `admin.js` and `admin.css` are gone, and `/admin-classic` answers 404 (a server test says so). The new page's sidebar no longer has **Open the classic admin**. A token kept by the classic page still signs in: the keys are the same. `/admin-next` still redirects to `/admin`.
- `browser-check` drops its classic steps and gets back the one they carried: a running agent task is listed on the admin page under Live > Now and, once over, under Tasks finished. It also checks that no page links to `/admin-classic` and that the address answers 404; the wrong-token and right-token sign-in on `/admin` was already checked.
- `scripts/release-check.mjs` checks each board's firmware: the CHANGELOG heading and the CLAUDE.md Versions line name the code's version, the `fw-<board>-v<version>` tag exists (a warning when not), and the running hub's `/flash/types.json` offers that version (a failure naming `node scripts/push-firmware.mjs <board>` when not).
- Firmware releases are tagged `fw-<board>-v<version>` on the commit that set the version: `fw-waveshare-amoled-1.8-v0.20.0` and `fw-waveshare-amoled-1.75-v0.4.1` are the first under this rule. `docs/release.md` has a Firmware section (bump, `pio run`, flash the bench board, `push-firmware.mjs` with or without `--update`, the tag; `/flash` lists only boards whose firmware was pushed); `firmware/README.md` and `CLAUDE.md` point to it.

## Axis 0.57.0 (2026-10-27)

The new admin page, stage 6 of `docs/admin-revamp/ia.md` section 4.1: the switch.

- `/admin` serves the new admin page. Every old address still works there (`#clients/<id>`, `#device/<id>`, `#type/...`, `#settings`, `#live`, ...), and the sign-in is the same stored token, so nobody signs in again.
- The classic admin page moves to `/admin-classic` for this release only (local network only, as `/admin`); its sidebar link now reads **Back to the new admin**, and the new page's sidebar foot has **Open the classic admin**. Its files (`web/admin.html`, `admin.js`, `admin.css`) go in the next release.
- `/admin-next` redirects to `/admin`, keeping the `#route`, so bookmarks of the page while it was built still work.
- `browser-check` signs in and makes the pairing code on `/admin` and drives every area there; of the classic page it only checks that it loads, signs in and links back. The server tests cover the three addresses, inside and under a public name.
- No cache to bump: the service worker caches nothing and the pages are served `no-cache` with stamped script addresses.

## Axis 0.56.0 (2026-10-27)

The new admin page, stage 5 of `docs/admin-revamp/ia.md` section 4.1: the rest of the pages at `/admin-next` (`web/adm-hardware.js`, `web/adm-system.js`). Every page of the classic `/admin` now has its new one; the classic page is unchanged and stays until stage 6.

- **Face and screen** (`#face`): the large face with its name, reading and 13 numbers, the voice level for listening and speaking; idle looks with their ticks (one stays on), state looks, tool icons (Dot shapes / Line at the core / Off, time to form, dots in the shape, Play it again, 13 icon tiles). The idle looks and tool icon settings are staged and saved with Save, with Undo; sliders show the change at once.
- **Firmware** (`#firmware`): Add a build (type from the types in use and on the shelf, version, `.bin`, Upload); per type its devices (behind, offline), the builds with size, upload time, checksum and which is sent, Send this one, Download, Remove (asks), Update N devices (asks), and Remove every build (the type typed to confirm; was API-only).
- **Wake words** (`#wakewords`): the stored models with who listens with each, cutoff and window staged and saved with Save, Download, Remove (asks); What devices heard (24 hours / 7 days) with the score strips and the cutoff; Add a wake word, the manifest filling in phrase, cutoff and window.
- **Apps** (`#apps`, new): the Windows desktop app (version, size, Download, each Windows computer with an Update when it runs another version), the Quest app (version, size, checksum, headsets with Update), the Mac app (built on a Mac, its Macs listed).
- **Integrations** (`#integrations`): Home Assistant (broker, port, user, password never shown, discovery prefix; connected or the last error, devices published), Live activities on phones (switch, blueprint, Send a test), notifications to browsers (with Send a test per browser). Staged with Save and Undo (no Undo once a password was typed). The read-only gateway card is gone (ia.md 1).
- **System** (`#system`, `#system/network`, `#system/clock`, `#system/backup`, `#system/about`): public address and trusted proxies, time zone, history kept, messages kept, backup (every N hours, daily copies kept, folder, last run, Back up now) and the new **Download a copy of the database**: `GET /admin/backup/download` makes a fresh copy (as a backup does) and hands it over, whether or not a backup folder is set up (tested in `backup.test.ts`); about this hub, Sign out.
- Every "still in the classic admin" card and every link to `/admin` is gone from the new page: the health strip and attention list send backup trouble to System and Home Assistant to Integrations, the type page's firmware tab to Firmware or Apps, Live's wake words to Wake words; Integrations and System carry a mark in the sidebar when something of theirs is in trouble; the command bar gains Download a copy of the database, Upload a firmware build and Add a wake word.
- `browser-check` drives the new pages (face staged save and Undo, firmware upload, download and remove, a wake word added from a manifest, tuned, downloaded and removed, Apps, Home Assistant saved and undone, System saved, a backup and a database download, no link back to `/admin`, 25 pages at phone width); the classic page's steps still pass. `docs/admin-revamp/shots.mjs` renders the new pages.

## Axis 0.55.0 (2026-10-27)

The new admin page, stage 4 of `docs/admin-revamp/ia.md` section 4.1: Agent and voice at `/admin-next` (`web/adm-agent.js`). The classic `/admin` is unchanged.

- **Who answers** (`#agent`): the OpenClaw gateway (agent from the gateway's list, note to the agent with the built-in one shown) or another chat endpoint (address, model, token kept when left empty, system prompt), Test this endpoint without saving.
- **OpenClaw gateway** (`#openclaw`): the turn and command links, the error, What Axis relies on with Check again, the gateway address, Reconnect, Pair with a setup code, the device id, the pairing steps with the commands to allow (open while not paired), and the agent's progress cards, questions and approvals switches with the scope line (moved here from Tools). The sidebar marks it "setup" or "down" as the classic page does.
- **Tools and MCP** (`#tools`): a switch per tool, Try a tool with its form drawn from the tool's parameters (Send to, Sends, the restart question for a reboot), the desktop block list, the MCP address and settings to copy, the public-name switch, tokens made once and revoked after asking.
- **Speech** (`#speech`): custom STT and TTS with keys kept when left empty, Test both, and the realtime voice (Devices use, Voice from, Try it; "needs OpenClaw" otherwise).
- **Voices** (`#voices`, was the bottom of Speech): voice recognition settings with the guest fields that fit, taught voices (forget one recording or a whole voice after asking, Record 5 s), Add a voice, Check my voice, Heard lately with "That was <name>".
- Settings on these pages are staged: a save bar per page, Save and Undo, the leave question; actions (Test, Pair, Reconnect, Check again, Try it, tokens, recording) run at once.
- The health strip, the attention list, Getting started and the History service strips open these pages; the command bar gains Back up now, Check the gateway again and Reconnect gateway.
- `npm run browser-check` drives the five pages (endpoint test, staged save and Undo, bad setup code, a mirror switch, a token made and a tool switched off reaching MCP, Try a tool, speech test, realtime voice, sample rate refused, voice settings and a voice added and forgotten, the command bar's Reconnect, phone width).

## Axis 0.54.0 (2026-10-27)

The new admin page, stage 3 of `docs/admin-revamp/ia.md` section 4.1: the Overview and Activity at `/admin-next` (`web/adm-activity.js`). The classic `/admin` is unchanged.

- **Overview** as a dashboard: Needs attention first (old firmware with Update, devices offline past their Offline alert, services down, failed turns, unclean stops, silent drops: the last three now open History), Getting started on a new hub (same rules and `axis-admin-started` key), the day's numbers (Axis running for, devices online, turns, failed, time to first sound), device cards with what each is doing and an Add a device card, **Now** (timers and tasks for later with Cancel, agent tasks with their steps and Clear, the attached conversation with Detach, computers in use, questions waiting, kept messages and notifications; countdowns tick every second on Axis's clock), **Say something** (every device, a place or one device, Urgent, the result per device; also in the command bar and the header button) and the last 24 hours' uptime (Axis, services, devices that were away).
- **Activity › Live** (`#live`, tabs in the address: `#live/now`, `/calls`, `/wakes`, `/tasks`): the stream from `GET /admin/live` with turn cards whose steps count up while running, tool calls with what they were given and gave back, wake words, tasks finished; watching/connecting, **Clear now** (also in the command bar). The sidebar's Live entry counts devices mid-turn.
- **Activity › History** (`#activity`): range 24 hours, 3 days, 7 days; the numbers for the range, uptime strips for Axis, services and every device, the three charts of `web/charts.js` drawn to their width (redrawn on resize), recent turns, events with the filter. Dimmed while a range loads.
- The "still in the classic admin" cards for these pages are gone. `scripts/browser-check.mjs` drives them (numbers, an empty and a real Say something, History with the filter and range, a typed turn on Live, Clear now, the tabs, phone width); `docs/admin-revamp/shots.mjs` renders Live and History and writes small JPEGs with `SMALL=1`.

## Axis 0.53.0 (2026-10-27)

The new admin page, stage 2 of `docs/admin-revamp/ia.md` section 4.1: the Devices area at `/admin-next`. The classic `/admin` is unchanged; the other pages of the new one still link to it.

- **All devices**: a card per device (its picture, state, type, version with an "update" mark, location) or a list, filters by name, type, location and state (online, offline, needs an update), Find and Update on each.
- **A device**: a header with its picture, state, type, version and Find, Update, Announce; tabs (each its own address, `#clients/<id>/settings`): **Overview** (what it is and can do, address, its pages, where it reaches Axis with Change, notifications and a test for a browser, kept messages, id, its offline alert; actions; the last 24 hours; readings as named facts), **Settings**, **Tools** (the edge glow drawn as the board draws it, with Show on the device; microphone levels) and **Danger zone** (Reset, Reset and forget Wi-Fi, Remove, each confirmed by typing the device's name). `#device/<id>` works too.
- **The settings editor** (a device, a type, everything): a banner that says which layer is edited with a way to the others; groups that fold and remember it, an index of them on the left, a filter, the device's picture and tools on the right. Changes are staged: the banner becomes a save bar ("2 unsaved changes · Discard · Save"), one save sends them all (the server refuses the lot for one bad value, and the bar says why), then Undo. Each row says where its value comes from (this device, type, everything, default), marks a value changed from the default, and has the way back ("Use type's 45"); Share with type on a device, "differs on Desk (35 %)" on a type. A value equal to what it would follow anyway is still stored as nothing. Name, location, capability switches and the glow's corner curve save with the rest. Leaving with unsaved changes asks first.
- **Types**: Devices (run an action on every online one), Settings, Firmware (who is behind, update them), Rename.
- **Defaults for everything** (`#settings`): every Axis built-in (the classic page showed two), the settings several types share, and other keys.
- **Add a device**: the pairing code, the address and the setup string with a **QR code** of it (`axis://` or `axis+tls://`), drawn in the page by the vendored `web/qr.js` and drawn again when either changes; steps for a board, a browser, a Windows computer (download), a Mac and a Meta Quest headset.
- **Needs attention** (Overview, header): a device whose version differs from the build on the shelf for its type, with Update; an offline device only after its **Offline alert** time (`offlineAlert`, set per device, type or everything: `auto` is 15 minutes for a board, 12 hours for a computer or a headset, never for a browser; `always` 10 minutes; `never`). The classic page still warns after 10 minutes for every device.
- `scripts/browser-check.mjs` drives the new page too (routes, command bar, the staged editor through a poll, Undo, refusals, share with type, type and Defaults, actions, mic panel, the typed confirmation, the setup string and its QR code read back by `scripts/qr-read.mjs`, themes, every page at phone width). `docs/admin-revamp/shots.mjs` renders it with pretend devices.

## Axis 0.52.0 (2026-10-27)

The new admin page, stage 0 of `docs/admin-revamp/ia.md` section 4.1: it is served beside the classic one while it is built.

- `/admin-next` serves `web/admin-next.html` with the same rule as `/admin`: on the local network only, nothing under a public name. The classic page's sidebar foot links to it ("Try the new admin").
- Stage 1, the new page's frame (`web/adm-core.js`, `adm-shell.js`, `admin-next.css`): the same sign-in token as the classic page (one sign-in serves both), a sidebar with collapsible groups that remember their state (device names under All devices, one entry per type, counts), a header health strip (agent, recognition, synthesis, devices online, updates waiting, backup and Home Assistant when in trouble, the attention count), a router that keeps every classic address (`#clients/<id>`, `#type/<type>`, `#settings`, `#pair`, …) and adds `#device/<id>`, tabs in the address (`#clients/<id>/settings`) and links to one setting (`?key=volume`), a command bar (Ctrl+K, ⌘K or /: devices, settings, pages, actions), the 3 s poll as one store, dialogs instead of `confirm()`/`prompt()`, toasts with Undo, dark and light themes (Dark, Light or System, kept per browser, dark by default) with every colour a token, and a card linking to the classic page for each page not yet ported.
- Vendored for it, one file each in `web/`, no build step: `preact.js` (Preact 10 with hooks and htm, htm 3.1.1's `preact/standalone.module.js`; MIT and Apache-2.0) and `qr.js` (qrcode-generator 2.0.4, MIT), each with its source, version and checksum in a comment.
- A new built-in device setting, **Offline alert** (`offlineAlert`: `auto`, `always`, `never`; default `auto`), read only by the new admin page to decide when an offline device needs attention. It is kept out of the settings devices are sent (`SERVER_ONLY_KEYS`), so no firmware or app sees it.
- `GET /admin/settings/global` also returns `builtIns`, the settings Axis itself reads for every client, so a page can offer them for everything before any device has described itself.

## Board firmware 0.20.0 (Waveshare 1.8) (2026-10-27)

The round board's 0.3.1, 0.4.0 and 0.4.1 on the 1.8, with the same setting keys, groups, labels, help text, choices and defaults, so the admin page shows the same for both.

- **Text size from the admin page**: `textSize` (Screen, "Text size": `small`, `medium`, `large`), applied at once. `small` is 0.19.1's text (body FreeSans 9, headings Bold 12, buttons 12), `medium` the new default (11, Bold 14, 14), `large` 12, Bold 15, 15, the fonts the round board already had. Every measure that follows from the size is in `display.cpp`'s `SIZES`; under the face that leaves 7, 5 and 5 body rows standing up and 4, 3 and 3 lying down. A question that takes the whole screen may have three lines.
- **A bigger face with the screen to itself**: `idleFace` (Screen, "Idle face size"): `normal` 240 (0.19.1's), `large` 264 (the default), `max` 288. With text, a question or a timer it shrinks to 240 while it slides to the top, size and place together over 300 ms (smoothstep, the shared `vortex::setSize`, `-D VORTEX_MAX_SIZE=288`), and grows back; text and buttons appear only after a frame went out at 240 at the top. This replaces 0.19.1's slide in steps of up to 24 pixels. With the widest idle look the figure stays 66 pixels from the nearest edge at 240, 54 at 264 and 42 at 288 (measured, `set idleLook open`).
- **Frame rate limit**: `maxFps` (Screen, "Frame rate limit": 20, 30, 45 or 60; default 30). It was a fixed 33 ms.
- **Faster frames**: the face sends only what it drew now and last time and blacks out only that (`setLazyClear`, as the round board), writes go out byte-swapped from internal memory, and text lying sideways goes out a few panel rows per write. A face frame takes 7 to 11 ms (0.19.1: 22.6).
- **The edge glow no longer drops the frame rate.** On 0.19.1 with the face over text: 6.8 fps with the `waiting` glow, 4.3 with `timer`, 6.7 with `hands` (the glow took 0.6 to 0.7 s of every second: a square root in the corners, an arc tangent for a timer, every pixel, ten times a second, and lying down one write per column). Now the rounded rectangle's fall-off and angle are a table made once in PSRAM in the panel's own coordinates (made again when `glowCorner` changes; a glow on show is taken off along the old curve first), the colour over black is looked up, and pieces down the sides are joined into single writes. Checked on the host against 0.19.1's sums: 99.6% or more of lit pixels identical at corners 12, 56 and 120 and each rotation, the rest within 2 steps but for up to 20 pixels where a timer's sweep cuts off.
- Measured on the bench board, 20 s each, lying down (rotation 270): idle 30.3 fps at each size; `waiting` glow 30.3 over the idle face at 264 and 288 and over text, `timer` over text 30.3; at limit 45: 45.3, with `waiting` 44.8; at limit 60: 61.7, with `waiting` 57.1 idle and 56.8 over text, `timer` 56.0. Heap 53 KB free, lowest 36.8 KB (0.19.1: 52 and 36.6).
- Console: `set textSize|idleFace|maxFps|rotation|idleLook <value>` (stand-ins for the setting, or a way up, on the bench), `preview <state>` (the round board's list), `glow <kind> [seconds]`, `fps`, `still`, `edges`, `shot`, `shot keep` and `shot held`. `tools/screen_shot.py` reads the size from the board (`--size` when lost) and turns the picture (`--turn`); the round board's use is unchanged.
- Flashed by USB to the bench 1.8 (2026-10-27), online with Axis, which shows 0.20.0; every `preview` captured with `shot` at each text size lying down and standing up. Not seen by a person, not pushed over Wi-Fi.

## Round board firmware 0.4.1 (Waveshare 1.75) (2026-10-27)

- **Frame rate limit setting** (Screen, "Frame rate limit": 20, 30, 45 or 60; default 30). The screen loop used a fixed 33 ms between frames. Measured on the board at 60: 61.6 fps with the 288 face (8.9 ms a face frame). The big idle face and the glow stay slower, since a frame there takes longer than the limit.

## Round board firmware 0.4.0 (Waveshare 1.75) (2026-10-27)

- **A bigger face with the screen to itself**: an `idleFace` setting (Screen, "Idle face size"): `normal` 288 pixels (0.3.1's), `large` 360 (the default) and `max` 380, applied at once. When text, a question, a timer or anything else needs room the face shrinks to 288 while it slides to the top, size and place together over 300 ms (smoothstep), and grows back the same way; text, a question's words and its buttons appear only once a frame has gone out at the small size at the top (so the clean-up of the bigger frame never wipes them). A question now waits for the face like text does (it used to jump). 380 rather than 400: measured with the widest idle look held ("open"), the figure comes within 45 pixels of the glass at 380 and 55 at 360 (about 100 at 288); at 400 it would be about 36, inside the glow ring's 12 plus margin.
- `vortex.cpp`/`vortex.h` (shared with the 1.8): the face draws at a size set at run time (`setSize`, up to `VORTEX_MAX_SIZE`, the buffer made once at that size in PSRAM), every size in it scaled as before; it can report what it drew (`drawn`, `drawnRow`) and black out only that before the next frame (`setLazyClear`); `farthest` (diagnostics). The 1.8 never calls these: it draws at `SIZE` with `SCALE`, clears the whole frame as before, and builds (checked, not flashed).
- **Faster frames**: a frame sends, pair of rows by pair of rows, only what the face drew now and last time (was: every row that was not black, the full width), and blacks out only what it drew before drawing the next; writes go out with their bytes turned round in internal memory first instead of through the library's per-pixel path, a third quicker (`bench` on the console: 920 pixels 160 against 242 us). With the face over text, 30 fps (the frame cap) against 26 to 27; idle, 30 fps at every size with the widest look.
- **The edge glow no longer drops the frame rate**. On 0.3.1 with the face over text: 5.0 fps with the `waiting` glow, 3.6 with `timer` (the glow took 700 to 750 ms of every second: a square root, and for a timer an arc tangent, for every pixel of the ring ten times a second, sent one row of each piece at a time). Now the ring's fall-off and angle are a table made once in PSRAM in the panel's own coordinates, the colour over black is looked up, and each band of 12 rows goes out in one or two writes whatever the rotation: 28.1 fps with `waiting`, 26.9 with `timer`, 26.8 with `listening` over text; over the big idle face with the widest look, 26.2 to 26.5 at `large` and 24.8 to 25.1 at `max`. The ring looks the same: 98 to 99.6% of its pixels in captures exactly as 0.3.1's sums give them, the rest one or two steps of a 5- or 6-bit channel off. Where the face's box crosses the ring the face lays the glow into its frame and sends it, and the ring leaves that box alone.
- Two minutes idle at each size (looks changing as usual): 30.3 fps at `normal`, `large` and `max` (face frames 14.5, 17.3 and 20.9 ms). Heap: 35.7 KB free, lowest 20.1 KB (0.3.1: 31.7 and 16.3); the glow's strip is now one write's worth.
- Console: `set idleFace normal|large|max` (and `set idleFace` back to the setting), `set idleLook <name>` (only that idle look, for measuring), `preview idle`, `glow <kind> [seconds]`, `fps` (frame rate since last asked, frame time and drawing time, the glow's share and its pieces, heap, how close the figure came to the glass; also over a picture), `still`/`still off` (the face and any slide hold still, for `shot held`), `bench` (panel write costs and a byte-order check).
- Checked on the bench board by USB, rotation 90, nobody watching: idle at each size, glows (waiting, thinking, timer, listening) over idle and text faces, the listening glow over a picture, transitions caught half way with `still` and after repeated idle/reply/question switching with `shot held` (nothing left behind), every `preview` (questions of 2, 4 and 6 choices, timer, task, steps, thinking, listening, setup, error) and text at small, medium and large.

## Round board firmware 0.3.1 (Waveshare 1.75) (2026-10-26)

- **Text size from the admin page**: a `textSize` setting (Screen, "Text size": `small`, `medium`, `large`), applied at once without a restart; the face stays 288. `small` is 0.2.2's text (body FreeSans 9, headings Bold 12, buttons 12), `medium` is new and the default (11, Bold 14, 14; rows 26, 36 and up to 64 pixels), `large` is 0.3.0's (12, Bold 15, 15). The 11- and 14-point fonts are new, from GNU FreeFont by `firmware/tools/gfx_font.py`. Under the face: four body rows at small, three at medium and large. All the measures that change with the size are one table in `display.cpp`; a change clears the screen and lays everything out again.
- Console: `set textSize <size>` stands in for the setting on the bench (`set textSize` alone goes back to it); `shot held` prints what the panel holds as it is, with nothing drawn again, and `tools/screen_shot.py --held` asks for it. Lines and pixels drawn straight to the panel (the bands the face leaves as it slides, the edge ring) now update the kept copy of the panel too, so a later write that is widened to even pixels no longer sends stale pixels back.
- Client core (`firmware/common`, shared with the 1.8): a board's declared default that is not a number (here `medium`) is sent in `describe` as text; it was sent as 0. Every default the 1.8 declares is a number, so what it sends is unchanged (not rebuilt or flashed for this).

## Round board firmware 0.3.0 (Waveshare 1.75) (2026-10-26)

- **Zoomed in about 1.2 times**, to use more of the round screen; the layout is otherwise the same. The face is drawn 288 pixels square (was 240; `-D VORTEX_SIZE=288`), with every size in it scaled (dots, wander, core, both kinds of icon), so it is the same face, bigger. Body text is FreeSans 12 point (was 9), headings FreeSans Bold 15 (was Bold 12), buttons FreeSans 15 (was 12), in rows of 28, 38 and up to 68 pixels (were 22, 30 and 56). The 15-point fonts are new, made from GNU FreeFont by `firmware/tools/gfx_font.py` the way the Adafruit GFX Library makes its own (it gives that library's 12-point fonts back, but for a few pixels in some letters).
- With text, the face sits at the very top (was 12 pixels down) and three rows of body text fit under the heading (were five, of smaller letters); longer replies scroll as before. A question with the face keeps two lines; one that takes the whole screen may now have three. Buttons go side by side when they fit in the rows they will actually take (they were judged on the narrowest row of the screen), so "Tea | Coffee" still shares a row.
- Kept at the same speed: rows of the face black in this frame and the last are not sent again, the face sits on an even pixel so its rows go straight to the panel, and the edge glow over the face skips the middle of each row. 26 to 28 fps on the bench with the face over text (0.2.2: 23), heap about 32 KB free (0.2.2: 30 KB).
- The console's `preview` has `listening` and `setup` too.
- `vortex.cpp`/`vortex.h` (shared with the 1.8): the size comes from `VORTEX_SIZE` (240 unless set) and every pixel quantity is multiplied by `vortex::SCALE`, which is exactly 1 on the 1.8, so the 1.8 draws as before (not rebuilt or flashed for this).

## Axis 0.51.0 (2026-10-26)

- **One set of listening numbers for every client.** `onsetMs` (wait for the first word), `silenceMs` (quiet that ends a sentence), `maxSpeechMs` (longest sentence) and `followUpMs` (listening on after a spoken answer) are now Axis's own settings (group Listening, the boards' labels, ranges and defaults: 6000, 900, 20000, 6000 ms), and Axis sends their defaults to every client beneath what is saved, so a value set for everything, a type or a device reaches boards, the web client and both desktop apps alike. Nothing is stored for them unless an admin saves a value; the admin page shows them at every level as before. The boards still declare the same four (Axis's definition wins, as for every built-in), so their firmware is unchanged. When the defaults sent change, Axis moves the settings' version on once at start, so devices holding the old copy take the new one.
- **Quiet hours quieten a device that has no volume saved**, from the default it declares: the desktop apps (which now declare `volume`, default 100) get `quietVolume` (25 unless set), and so does a board with nothing saved for its type or itself (its own default is 60). A volume saved anywhere is capped as before; a client that declares no `volume` (the web client) is still left alone. The same for `brightness`. A device that describes itself during quiet hours with a new default is sent its settings again at once.
- **Microphone levels on a device's page** (devices offering the `mic` action, the boards): Start reads the action about once a second for up to a minute and draws three bars on a dB scale, the room's level, the level speech must pass, and the loudest sound since the last reading (boards from 0.19.1 and 0.2.2; older firmware shows the first two and says so). Stop, or leaving the page, ends it.
- The web client listens by them: a sentence ends after `silenceMs` (900 ms, was a fixed 1.2 s), it gives up after `onsetMs` (6 s, as before) and stops at `maxSpeechMs` (20 s, was 30 s). It still has no follow-up listening (a browser would open the microphone unasked; not built).

## Board firmware 0.19.1 (Waveshare 1.8) and round board firmware 0.2.2 (Waveshare 1.75) (2026-10-26)

- The `mic` action also reports `level`: the loudest block the microphone heard since the last reading (mean absolute sample value, as `room` and `speechAbove`), for the admin page's level bars. `Client::MicStats` gained `level`; reading it starts the count again. Nothing else changed; the listening numbers still come from the settings, now always sent by Axis 0.51.0.

## Desktop app 0.13.0 (2026-10-26)

- **Listens by Axis's shared Listening settings** instead of its own fixed 1.2 s, 6 s and 30 s: a sentence ends after `silenceMs`, a press with nothing said gives up after `onsetMs`, a recording stops at `maxSpeechMs`. Its own loudness threshold for speech is unchanged.
- **Its own volume** (`volume`, Sound, 0 to 100, default 100): a gain on its own speech and sounds (the chime, the cue, the task chime); the computer's own volume is never touched. Announcements and timers are spoken through the same speech, so they follow it too; quiet hours lower it through Axis. The face is measured before the gain, so it moves the same at any volume.
- **Questions waiting on another device** (`ask.waiting`, which it answered "not implemented" before): a small blue dot and a dim line, "A question waits for you elsewhere" (or "2 questions ..."), in the task pill, under a task or timer when there is one, alone when not; gone at 0 and when the link drops. Only with talking on (Axis sends it to screens only).
- **Follow-up listening, as on the boards:** after a spoken answer to what was said at this computer has played to the end, it listens `followUpMs` more (6 s unless set, 0 turns it off) without the talk key and with no cue; silence ends it quietly. Never after an announcement or a timer, nor when the answer was stopped.

## Mac desktop app 0.6.0 (2026-10-26)

- **The same as the Windows app 0.13.0**: the shared Listening settings and follow-up listening, ported line for line in `AxisDesktopCore/Voice.swift`; `volume` (declared with talking on, default 100) as a gain on its own speech and sounds in `AudioIO`, never the Mac's volume; and `ask.waiting` as the same blue line in the task pill (`Notices`, `TaskPillWords.of(_:elsewhere:)`).

## Board firmware 0.19.0 (Waveshare 1.8) and round board firmware 0.2.0 (Waveshare 1.75) (2026-10-26)

- **Both boards follow what an admin switched off** (Axis 0.50.0, the `capabilitiesOff` setting). `screen` off: the panel goes blank (cleared, brightness 0) and nothing is drawn, pictures are dropped, the connection stays and a tap still talks; only while paired, so Wi-Fi setup and pairing always show. `speaker` off: volume 0, and speech from Axis is answered `playback` blocked (what is playing stops). `mic` off: no wake word, and nothing opens the microphone (a tap, a question, a follow-up). Each comes back when switched on again; with nothing switched off the board does what it did. The client core gained `Client::setOff` (two flags, false unless set).
- The round board's console has `capsoff <names>`, which acts as if Axis had sent that setting. Tried on the round board over USB (it stays paired with a running Axis that does not know the setting yet): `capsoff screen` left the screen black in a capture while the link stayed online, and `capsoff` brought the face and task line back; `capsoff mic` made `talk` refuse; `capsoff speaker` kept a test tone off the speaker's reference input (room level, 12 to 15, against about 770 with it on). Not tried: speech from Axis being refused, by eye or ear, or anything on the 1.8 (not connected; built only).

## Desktop app 0.12.0 (2026-10-26)

- **Follows what an admin switched off for this computer** (Axis 0.50.0, the `capabilitiesOff` setting). `mic` off: the talk key does nothing (a recording under way is dropped); `speaker` off: nothing plays, no sounds, and Axis is told the speech was blocked; `screen` off: no face, no voice, task or typing pill; `desktop` off: every `desktop.*` command is refused, as when paused. Each comes back when switched on again. With nothing switched off nothing differs.
- Built in the .NET SDK container and its smoke checks run (164 passing, new ones for this included); not run on Windows. Not put in the data folder.

## Mac desktop app 0.5.0 (2026-10-26)

- **The same as the Windows app 0.12.0**: `mic`, `speaker`, `screen` and `desktop` switched off on the admin page are followed live, the same way. `AxisDesktopCore` (with the new tests) was type-checked and its XCTest checks run on Linux under Swift 5.10, with two stand-ins for Apple-only calls (`NSLock.withLock`, `URLSession.data`) kept outside the repository: 168 passing. The AppKit part (`AppModel.swift`) is not compiled.

## Board firmware waveshare-amoled-1.75 0.2.1 (2026-10-26)

- **Listening no longer ends mid-sentence.** The two microphones hear a voice quieter than the 1.8's (room 8, speech peaking near 176 against a keep threshold of 76), so ordinary speech counted as silence. Microphone gain is up 6 dB (ES7210 step 12 instead of 10).

## Axis 0.50.0 (2026-10-26)

- **An admin can switch off what a device can do.** The device's page has a switch for each capability it reports (`mic`, `speaker`, `screen`, `desktop` and so on), on when Axis uses it. Switching one off only takes away: Axis stops using it on that device at once (where speech goes, questions, wake words, the desktop tool, the agent's turn header), and the device is told through a new built-in setting, `capabilitiesOff`, so one that knows it stops doing it too. Nothing a device does not report can be switched on.
- Stored apart from what the device reports (a new `capabilities_off` column, empty unless set), so a reconnect does not undo it. Set with `PATCH /admin/clients/:id { capabilitiesOff: [...] }`; the client's record on the admin API now carries `reported` and `off` beside the effective `capabilities`. The setting itself cannot be written through the settings routes.
- A question open on a device whose screen is switched off is ended there and put to another device that can answer it, for the time it had left; with none it ends unanswered.
- With nothing switched off, nothing differs: the setting is absent and every device is sent exactly what it was before.
- The web client follows it: `screen` off hides the face and the words, `speaker` off plays nothing (Axis is told it was blocked), `mic` off leaves the face as a button for nothing and says to type. Each comes back when switched on again.

## Round board firmware 0.1.0 (2026-10-26)

- **A second board: the round Waveshare ESP32-S3-Touch-AMOLED-1.75** (`firmware/waveshare-amoled-1.75`, type `waveshare-amoled-1.75`, its own firmware versions). Everything the 1.8 does, with the same face (the 1.8's `vortex.cpp` and `icons.h`, linked), laid out inside a 466 by 466 circle: text fitted to the chord at each row, question buttons kept off the edge, a round edge glow, a ring for "Show screen edges". Two microphones on an ES7210, averaged; the speaker's own output comes back on the ES7210's third input as the echo canceller's reference. CST9217 touch. No `glowCorner` (no corners); `screenOffset` defaults to 6 and `rotation` to 0.
- Checked on a real board over serial and through screen captures (the new `shot` console command): boots, setup network, 29 fps, touch read with no bus errors, its own spoken "Hey Vortex" woke it three times out of three (0.90 to 0.98), a 1 kHz tone through the speech path came back clean, a 466 by 466 JPEG shown, and the setup, question, reply, timer, task, thinking and glow screens all drawn inside the circle. Not yet used by a person: touch, gestures and turning with the board have not been tried by hand, and it has not been on Wi-Fi or paired.
- Console diagnostics on this board: `shot`, `preview <state>`, `pcm` (sound or a JPEG over the cable), `mics`, `motion`, `touch`, `edges`, `glow <kind>`.
- The 1.8's firmware is unchanged (0.18.2). The client core's `AXIS_FIRMWARE_VERSION` is now a default a board can override from its `platformio.ini`.

## Axis 0.49.1 (2026-10-26)

- **The admin page's glow preview works on the round 1.75 board.** The server refused it ("has no edge glow") because that board has no `glowCorner` setting; it now accepts a board that reports a round screen.

## Axis 0.49.0 (2026-10-26)

- **The flasher offers a choice of board** when the hub has factory images for more than one type (`/flash/types.json`; `scripts/make-flasher.mjs` takes several board folders and writes the same for the published page). One type looks as before.
- **Round screens on the admin page.** A device that reports `screenRound` 1 is drawn round, and its edge glow preview is a ring with no corner controls.
- Firmware versions are read per board (`scripts/firmware-version.mjs`) by `push-firmware.mjs`, `make-flasher.mjs`, `release-check.mjs` and the release workflow, which now builds both boards.

## Mac desktop app 0.4.3 (2026-10-23)

- **The face, pills and pointer are on every Space more reliably.** Each showing sets the all-Spaces behaviour again before ordering the panel in; a panel faded out and back in could return on the current Space only. Not compiled on a Mac yet.

## Mac desktop app 0.4.2 (2026-10-23)

- **Fix: 0.4.1 could stay at "Connecting…" for good.** The network watcher's first report called `nudge`, which could cancel the socket before it was started. The socket is now started before anything can cancel it, and the watcher acts only when the network comes back from none.

## Axis 0.48.0 (2026-10-23)

- **`ping` / `pong`.** A client that cannot see the WebSocket's own pings (browsers, .NET, Apple's URLSession) sends `ping` and Axis answers `pong`, so a client can tell a silently dead connection from a quiet one. Additive: protocol stays 1; old clients never send it.
- `scripts/release-check.mjs` and `docs/release.md`: one checklist for versions, CHANGELOG, CLAUDE.md, tags, pushes, the running server and the shelf.

## Mac desktop app 0.4.1 (2026-10-23)

- **Recovers from sleep.** On wake, screen wake and session return the link drops its (probably dead) socket and connects at once, the talk and typing keys are registered again, the face and pills are put in front again (a fade cut off by the sleep could leave the face invisible), a half-done turn is cancelled when going to sleep. The network coming back also reconnects (NWPathMonitor).
- **Silent drops.** A `ping` every 15 s; 40 s without a frame from Axis drops the connection and reconnects.
- Not compiled on a Mac yet.

## Desktop app 0.11.1 (2026-10-23)

- **Recovers from sleep.** Resume, unlock and the network coming back drop the old connection and connect at once (no leftover wait); the pause, talk and typing keys are registered again; the face and pills are put in front again; a half-done turn is cancelled when going to sleep.
- **Silent drops.** A `ping` every 15 s (needs Axis 0.48.0; an older Axis answers with an error, which also counts as heard); 40 s without a frame aborts the connection and it connects again.

## Mac desktop app 0.4.0 (2026-10-20)

- **Typing to the agent.** Tap the talk key (or the optional typing key) for a typing pill; hold it to talk as before (the mic opens at key-down with a one-second pre-roll; a release under 220 ms is a tap and drops the audio). Return sends, Shift/Option+Return adds a line, Esc closes, Up recalls the last message. It answers an open question too. A "Type to VorteX…" menu item. Needs talking on.
- **Task and timer pills** (progress.show, timer.next): title, progress bar, +N, steps on a click, "needs you"; a finished task leaves after 90 s or with its ×, which sends swipe_down; timers count down and cancel with ×.
- **Sounds** generated in code: timer bell (the chime action), task-finished chime, listening cue; never in quiet hours. **Pictures in replies** (images capability while talking is on).
- Never compiled on a Mac in the AppKit/SwiftUI part; the Core's 166 tests pass under Swift 5.10 on Linux.

## Desktop app 0.11.0 (2026-10-20)

- **Typing to the agent**, the same way as on the Mac: tap the talk key (or a Typing key) for a typing pill, hold to talk with the mic opened at key-down; the previous window gets the focus back on send or Esc.
- **Task and timer pill** (progress.show, timer.next) with the step list on a click, × to put away or cancel; chime, task chime and listening cue (never in quiet hours); pictures in the voice pill. The `images` capability is declared while talking is on.
- All pills are kept out of screen captures now (the old ones too).

## Mac desktop app 0.3.2 (2026-10-20)

- **The face follows the Face page's settings, as the boards and the Windows app 0.10.5 do**: `toolIcons`, `toolIconMs`, `toolIconDots`, `idleLooksOff`, live from the settings Axis sends (`Face.useSettings`, `setIconTuning`, `setIdleOff`, `shapePoint`, ported from `web/vortex.js`). `Face.swift` and its tests compiled and passed under Swift 5.10 on Linux; the app itself not compiled.

## Desktop app 0.10.5 (2026-10-20)

- **The face follows the admin page's Face page, as the boards do**: `toolIcons` (dots, line, off), `toolIconMs` (time to form, 150 to 3000 ms), `toolIconDots` (12 to 78 dots in a shape; the rest stand off in a ring 80 out and go on turning) and `idleLooksOff` (idle looks it never drifts into; one on show when it is switched off is left at once), live, from the settings Axis sends (all layers: global, type, device). Before, the face always drew 78 dots in 700 ms, every idle look, and ignored `toolIcons`. Ported from `web/vortex.js` (`Face.SetIconTuning`, `SetIdleOff`, `UseSettings`, `ShapePoint`), checked in `Axis.Desktop.Smoke check`. Not built into the data folder.

## Mac desktop app 0.3.1 (2026-10-20)

- **The pointer like the Windows one**: an arrow in the face's cyan with a glow, its tip on the spot, a ring breathing round the tip (still with Reduce motion), the agent's words in a dark pill with a cyan edge on the roomier side of the pointer, kept on the display, off the tip and out of the notch (`PointerLayout.bubble`, tested at every edge and corner, on a display above and left of the main one, under the notch). It glides 220 ms from its last spot and an action waits 250 ms for it (100 ms when it appears; `PointerLayout.waitMs`, as on Windows); after open, switch and window commands it points at the window's title bar, as before. Out of screen captures like the face and the pills. Not compiled yet.

## Mac desktop app 0.3.0 (2026-10-20)

- **Talking from this Mac** (as on Windows): the talk key (press, hold, release; ctrl+option+space unless another is recorded, Fn alone possible), the microphone at 16 kHz to Axis and its speech through the speakers, a question with Allow/Deny buttons; the Mac then also offers `mic`, `speaker` and `screen`. Needs the Microphone permission.
- **The face**: Vortex's face (a Swift copy of `Face.cs`, the fourth copy of `docs/face.md`) on a small frosted disc at the bottom middle of the main display, springing in for a voice turn and while an agent uses the Mac (the computer icon), its mouth following the voice's loudness, gone 2.5 s after. Keep it on screen and a click on it talks; drag it with the right button (or Control) to put it anywhere. Small, medium (132 pt) or large; bottom centre, left, right or where it was put. Follows Light and Dark, Reduce motion; never takes the focus.
- **The pills**: "VorteX is using this computer" with the last thing done (8 s after the last command) and the voice pill (listening, thinking, speaking, what was heard, the reply, a question's buttons) at the top middle; on a MacBook with a notch the first one grows out of the notch like the Dynamic Island. The face and the pills are left out of every screen capture.
- **The logo**: an app icon (`App/AppIcon.icns`, made by `scripts/make-icns.sh` from the logo) and a menu bar icon drawn in code that shows idle, listening, speaking, using this Mac, paused and offline. The window has a section for the face and the pills (with "Try them") and an About section.
- **Fixes from the live test of 0.2.1 on Brave**: a window taken out of full screen to be minimised goes back into full screen on restore; looks leave out slivers, one-letter groups and doubled lines.
- Written on Linux, not compiled, its tests not run.

## Mac desktop app 0.2.1 (2026-10-20)

- **Fixes from the live test of 0.2.0 on Brave.** A look reads the app's real top-level window with its toolbar, address bar and tabs (it read only Chromium's page window, so `find "Address and search bar"` found nothing); element 1 is the whole window and the browser-bar guard is everything above the page. `window do=list` shows one entry per window (Brave's toolbar strip is folded into its window; small untitled helpers are left out). `window` acts on the real window, leaves full screen first to minimise or move, reads the result back and says it (`minimized`), failing with words when it did not take; restore finds minimised windows. Looks leave out a text or image that repeats the link or button holding it, and a group named as what is inside it.
- Written on Linux, not compiled, its tests not run.

## Axis 0.47.1 (2026-10-20)

- The desktop tool's words fit a Mac too: `open` takes a "Start-menu or Applications name", and `keys` says a Mac sends ctrl+letter shortcuts as cmd. Nothing else changed on the server.

## Mac desktop app 0.2.0 (2026-10-20)

- **Input (M2)**: click (left, right, double), drag, type, paste, keys, scroll, open, switch, window, desktop (Spaces), wait, steps, clipboard and screenshot, with the Windows app's answers, `after`, ids read again after a scroll, the browser-bar guard (Mac browsers by name and bundle id), the 40% rule, the "intended window", and its refusals (password fields named or focused, a screenshot while one has the focus, input switched off, pause). Clicks press controls through Accessibility first (focus for fields, AXPress, AXPick, AXShowMenu) and use the mouse only when that does not take, putting the pointer back.
- **Keys on a Mac**: `ctrl` with a common shortcut key (s c v x a z f t w n o p r q l k b i u / [ ] , + - 0 =) is sent as cmd, `ctrl+y` as shift+cmd+z; `ctrl+tab`, `ctrl+arrows`, `ctrl+space` and `control+...` stay Control. Never pressed: cmd+Q, ctrl+cmd+Q, shift+cmd+Q, shift+option+cmd+Q, option+cmd+Esc.
- **The block list is checked again right before each input and before every step** of `steps` (Windows checks once per command).
- **Fixes from the first live test of 0.1.0** on a MacBook Air: Brave (and other Chromium browsers, Firefox) now show their toolbar and page (`AXEnhancedUserInterface`, a short settle the first time); the window in front is the focused window Accessibility gives, so its box matches the look's element 1 (not a Chromium helper strip); Finder's empty desktop is never the front window; the window list and a screen look include windows on other Spaces and minimised ones, marked; OCR captures only the area, at the size it needs, and reads it with Vision's fast recogniser (it timed out); menu bar titles are `menuitem`.
- Written on Linux, not compiled, its tests not run.

## Axis 0.47.0 (2026-10-19)

- **A Mac can be a computer too.** Axis knows the client type `macos-desktop` (the Mac app, `clients/macos-desktop/`). The desktop tool already went by the `desktop` capability, so a paired Mac is looked at and pointed with like a Windows computer; what is new is that it is never offered the Windows app's update (`/v1/desktop/app` answers 404 for it, and the admin page's Update says a Mac is updated by hand for now).

## Axis 0.46.1 (2026-10-16)

- **The desktop tool is a node tool too.** `vortex.axis.desktop` is declared on the OpenClaw node (it was MCP only), so agents that go through the general `nodes` tool can use it as well. The node's command list grew, so the gateway asks for the node to be approved again after this version is deployed. The tool is still experimental: off until switched on on the Agent tools page. (The first deploy of 0.46.1 published nothing: the gateway refuses the `experimental` flag on a node tool, so only name, description, command and parameters are sent now.)

## Desktop app 0.10.4 (2026-10-16)

- **A click on a field half scrolled under the top of a web page no longer lands on the address bar.** A look reported such a field with its whole box, which reached up into the browser's bar, and a click went to its middle. Now a look gives the part that shows (the box cut to the page, a frame in it, and the window), and a click reads the control again and goes to the middle of what shows now; when under 40% of it shows (and not a piece at least 40 px each way) it is scrolled into view first (ScrollItem) and read again, and refused with words when it cannot be.
- **A text field or combo box is clicked by giving it the focus** through UI Automation, as typing already did; the mouse is used only when that does not take. The answer's `how` is `focused`.
- **Ids after a scroll**: a scroll marks the last look out of date. An id then has its control read again where it is now (and refused as "off the screen since the scroll" when none of it shows); text read from the pixels cannot be, and is refused with "scrolled since the last look, so element N may have moved; look again". A look or find makes the ids current again. A click's answer gives the x,y it was actually clicked at.
- **A last guard**: with a browser in front, a mouse click meant for a control in the page is refused when it would land in the top 100 px of the window above the page (its tabs and address bar). Clicks on the browser's own tabs, address bar and buttons, and clicks at a bare x,y, go as before; a page shown full screen is clicked at the top.
- The geometry is in `Axis.Desktop.Core` (`Geometry.cs`) and checked on any OS by `Axis.Desktop.Smoke check`.
- Not run on Windows by its author: built in the SDK container, the Core's checks run there.

## Axis 0.46.0 (2026-10-15)

- **The Quest panel client now ships with every release**: the release workflow builds its APK (JVM tests first, then Gradle in Docker), attaches it to the release as `quest-client-<version>.apk`, and puts it inside the Axis image (`bundled/quest`), so a fresh hub offers it to headsets from the start, like the desktop app. It is debug-signed: install it by hand (`adb install`, or Unknown Sources on the headset). Updates over the last build need the same signing key, so a repository that wants that sets the secret `QUEST_KEYSTORE_B64` (a base64 `debug.keystore`); without it every release has a fresh key and a headset uninstalls first.
- **`scripts/build-quest-client.sh`** copies the source into the build container instead of bind-mounting it (so it works from a CI job that is itself in a container), writes to `$AXIS_QUEST_OUT` when set, and takes the keystore from `QUEST_KEYSTORE_B64`. The local signing key volume is unchanged.
- **The throwaway Quest probe is removed** (`clients/quest-probe/`, `scripts/build-quest-probe.sh`); the build image moved to `clients/quest-client/Dockerfile`.

## Desktop app 0.10.3 (2026-10-15)

- **Speech that never played, and the link dropping each time it was due**: when the chosen speaker could not be opened (its number had changed or it was gone), starting playback threw inside the link's receive loop, which ended the connection; the pill showed Speaking and nothing came out. Now it falls back to the default speaker, and with none it carries on silently (the words still show); a failure while handling any one message from Axis is logged and no longer takes the connection down.

## Desktop app 0.10.2 (2026-10-15)

- A drop of the link to Axis in the middle of a turn no longer leaves the pill on "Thinking" with the reply's words in it: the turn, a question or playback that was waiting is let go when the link goes away.

## Desktop app 0.10.1 (2026-10-15)

- A question shown on the PC (the confirm step of 0.45.0, or any `ask`) now has real **buttons** in the voice pill; before, the choices were only words to say. The pill takes clicks only while a question shows, and never the focus.

## Desktop app 0.10.0 (2026-10-15)

- **Drag**: from a name, an id or x,y to `toName`, `toId` or `toX`,`toY`. A real mouse drag: the pointer glides to the start as for a click, the left button goes down (held `holdMs` when asked, up to 2 s), the mouse moves in steps over 400 ms as input a drag's own loop sees, rests a moment over the target, and lets go; the button is always released and the mouse put back.
- **Context menus by name**: a right click's menu (or a drop-down) is a window of its own, which looks, finds and clicks by name did not read, so "Copy" right after a right click was not found. The reader now reads Windows' own menus and the popups the app in front owns that sit above it, first, with the window in front.
- **Tab order**: `keys` with `tab` and `shift+tab` moves the focus forward and back, and the answer's `after` says what has it; no separate action was added.
- **Reading the pixels** when a window exposes few controls was already there (the "Read pixels when a window says little" switch, on): a look now says so (`ocr`: lines marked `(ocr)`, positions approximate) and those lines are clicked by name like any other (with the mouse, at their middle).
- **The block list** (Axis 0.45.0 sends it with each command): with a blocked window in front, nothing is read and nothing is done; a look at the screen and `window` list name a blocked window only as blocked. `window` takes `do: list`.
- Offers "Ask before risky actions" (`confirmRisky`, on) on the computer's page; Axis does the asking.
- Not run on Windows by its author: built in the SDK container and run as the fake computer (`Axis.Desktop.Smoke`) against a throwaway Axis from this checkout.

## Quest panel client 0.4.0 (experimental) (2026-10-15)

- **Drag**, as a real touch: from a name, an id or x,y to `toName`, `toId` or `toX`,`toY`, with `holdMs` to long-press first. The fast engine puts a finger down, holds, moves in steps over 400 ms and lifts (a new helper op, `drag`); through the shell it is `input swipe`, or `input draganddrop` when there is a hold.
- **Switch between panels**: `switch` brings an open panel forward by its app's name, package or title (the app is started again, and the front watched for it), and says plainly when it is not open or did not come forward. `window` with `do: list` lists the open panels; a look names them (`panels`) when the fast engine is running and there is more than one. Minimize, maximize and move are still refused.
- **The block list**: with a blocked app's panel in front (Axis 0.45.0 sends the list with each command), the app neither reads it nor acts on it; a blocked panel is named only as blocked in lists.
- Offers the "Ask before risky actions" switch (`confirmRisky`, on) on the headset's page; Axis does the asking.
- versionCode 15 (helper too). Needs Axis 0.45.0 for `drag`, the block list and `window` list; `switch` works with older Axis too.

## Axis 0.45.0 (2026-10-15)

- **Drag** (`vortex_axis_desktop` action `drag`): from `name`, `id` or `x`,`y` to `toName`, `toId` or `toX`,`toY`, with `holdMs` (up to 2000) to long-press first; in `steps` too, held by the same switches as a click. The tool's description tells agents to ask first when a drop could lose or move something important, and to prefer names to coordinates. Needs desktop app 0.10.0 or Quest app 0.4.0; older apps answer that they do not know it.
- **Axis asks before a risky action.** A click or drag on an element named with a word that sends, deletes, buys or signs out (send, post, publish, submit, delete, remove, buy, purchase, pay, order, confirm, transfer, sign out, log out, uninstall, format, erase, reset, install, accept), or Enter / Ctrl+Enter (and typed or pasted text that ends a line) in a window whose title says mail, chat or payment, is put to the person first: on the computer when it can ask, else on a device near it, "Allow" or "Deny", 30 seconds, no answer is no. Deny reaches the agent as "the user declined"; Allow counts for that one call (a `steps` call asks once). The answer says `confirmed` when it was asked; both show in the call on the Live page. Ids and points are named from the computer's last look or find (`server/src/risky.ts` holds the words, with its tests). Per computer, switch `confirmRisky`: on unless switched off (the apps from 0.10.0 / 0.4.0 offer it on the computer's page).
- **A block list for the desktop tool** (Agent tools page, or `AXIS_DESKTOP_BLOCKED`): parts of app, window or process names. Axis refuses an `open`, `switch`, `window` or `wait` naming one, refuses a look, find or screenshot whose window in front matches ("blocked by the user", nothing of it), names it only as blocked in a list of windows and in `after`, and sends the list to the computer with every command (`blocked`), which refuses to read or act on such a window itself (desktop app 0.10.0, Quest app 0.4.0).
- `switch` and `window` reach a Quest: Axis never refused them (it keys on the capability); the Quest app did, until 0.4.0. `window` takes `do: list` (the open windows; on a Quest the only one it does).

## Quest panel client 0.3.11 (experimental) (2026-10-14)

- **The fast engine's real fault, found from the headset's logcat:** the helper's UiAutomation is a binder that lives in the `am instrument` process. Without `-w` (0.3.8 to 0.3.10) `am` returned at once and the helper logged "no UiAutomation"; with `-w` under nohup in the background (0.3.0 to 0.3.7) Android could end `am` with the adb stream, and the helper went on answering pings while seeing nothing (the empty looks). The app now runs `am instrument -w` on a second adb connection of its own and holds it open for as long as the helper runs; when it ends, the helper is taken as lost and started again. Closing it never waits on the command reading it (a deadlock found in the tests).
- versionCode 14 (helper too). Axis is unchanged.

## Quest panel client 0.3.10 (experimental) (2026-10-14)

- **The app's window no longer takes taps meant for another panel.** 0.3.8 moved the window aside only when it was "resumed", but with another panel focused it is paused and still on top, so it went on taking the taps for the Browser's tab strip (checked on the headset: a tap at "Create tab" gave the focus to this app and added no tab). A paused window now ignores touches (`FLAG_NOT_TOUCHABLE`), and takes them again when it is in front. The Live view stays where it is.
- The helper's failure message reads more of the system log (crashes, process starts, instrumentation lines) and leaves out the harmless `base.dm` noise.
- versionCode 13 (helper too). Axis is unchanged.

## Quest panel client 0.3.9 (experimental) (2026-10-14)

- **When the helper logs nothing at all, the app says what the system logged about its package.** After 0.3.8 the helper (started without `-w`) still never reached its first line, so its own steps said nothing; the message now also carries the last lines of logcat that mention `dev.vortexaxis.quest.helper`, `FATAL EXCEPTION` or `AndroidRuntime` ("the system said: ..."), which is where a crash before the helper's own code would be.
- versionCode 12 (helper too). Axis is unchanged.

## Quest panel client 0.3.8 (experimental) (2026-10-14)

- **Taps meant for the Browser went to this app's own window.** The headset stacks panels as overlapping windows on one display, and a tap goes to the topmost one at that spot. On the owner's headset this app's panel sat above the Browser's and below Settings': a tap at "Create tab" gave the focus to this app (the answer's `after` named it) and added nothing, while a tap in Settings worked. While an agent acts, the app's own window now steps aside first (`moveTaskToBack`; it says so in Recently), and comes back when the app is opened again. Looks and finds leave it alone.
- **The fast engine starts reliably.** The helper was started with `am instrument -w` under `nohup` in the background of the adb stream; Android may end that with the stream, and after an update the new start sometimes never ran (its log was an older helper's, on a port the app was not using). It is now `am instrument` without `-w`: it returns at once and the instrumentation goes on inside the system. When it does not answer, the helper's steps are read from logcat (tag `VortexAxisHelper`, the port tells this try's lines from older ones).
- `desktop.hello`'s `windows` lists the windows top to bottom with their displays, repeats counted and the system's layer surfaces left out.
- versionCode 11 (helper too). Axis is unchanged.

## Quest panel client 0.3.7 (experimental) (2026-10-14)

- **"Check the headset" answers again.** 0.3.6 put the helper's whole start message in `desktop.hello`, and Axis refuses any value over 240 characters ("Expected union value"), so the answer was dropped and the admin page timed out. Long things now come as pieces of at most 200 characters (`why`, `why2` ...), and the engine line is short.
- **Shows how the headset lays its windows out.** `desktop.hello` carries `windows`: each window with the display it is on (`com.oculus.browser@0 dev.vortexaxis.quest@0 ...`) and the focus. Found on the owner's headset: with the app's own panel open, a tap at the Browser's "Create tab" put the focus on the app's panel instead (`after` named the app) and added no tab. It looks like the tap goes to a different window than the one read, and this tells where each panel lives.
- versionCode 10 (helper too). Axis is unchanged.

## Quest panel client 0.3.6 (experimental) (2026-10-14)

- **The fast engine's start failures can be read.** After 0.3.5 the helper installed and started but never answered, for minutes, and the app could only say "it wrote no status": the status file may not be writable by the helper at all. The helper now reports each step as an `INSTRUMENTATION_STATUS: note=...` line, which `am instrument` prints and the app already reads back, and the failure message carries them ("the helper got as far as: onCreate | checks passed | UiAutomation connected ...") along with how `am` ended. `desktop.hello` (the admin page's Check the headset) shows the whole message, not its first 80 characters.
- versionCode 9 (helper too). Axis is unchanged.

## Quest panel client 0.3.5 (experimental) (2026-10-14)

- **Clicks are a real touch again.** With the fast engine a click on an element was an accessibility press (`ACTION_CLICK`), and the Browser's tab strip ignores that while reporting success: "Close tab" and "Create tab" did nothing (tested: the press changed nothing, the same spot by coordinates added a tab). The click is now a touch at the element's centre, as the shell's `input tap` was; the press is only the fallback when the touch is not taken. The answer's `how` was always "tap"; it now says `tap`, `double tap`, `long press` or `press`.
- **A helper that cannot see is restarted.** On the owner's headset the fast engine went on answering pings while its UiAutomation was dead, so every look was empty ("unknown panel", 40 ms) and `open` waited out its full 2 s. A look with no tree at all now stops the helper, reads that look with uiautomator once and starts the helper again (at most once a minute, so an immersive app with nothing to read does not restart it over and over); an empty look says so in a `note` instead of passing for a blank panel.
- **The helper reads a window when none is active** (the focused application window, else the topmost with content), and its focus check refuses to guess when there is no window, so the password guard stays strict.
- **A restart takes seconds, not minutes:** a second's pause after the helper is stopped (the old UiAutomation connection is still clearing) and the first retries at 4 s, 8 s, 16 s instead of 10 s, 20 s, 40 s.
- versionCode 8 (helper too). Axis is unchanged.

## 0.44.3 (2026-10-14)

- **A board could be left glowing "computer in use" with nothing in use** (and the other way round). Axis marked a screen as told before its `desktop.busy` had been delivered, and dropped a failure: the command has a 3 s timeout and a board busy with a conversation can miss it, which left the board's flag stuck until the next change, so the rose glow came on whenever its face went idle. A screen now counts as told only once it took the command; a miss is asked again (up to five times, 3 s apart), and a late failure never undoes a newer state. The glow stays off over the thinking face by design (it cost frames there; the computer icon says it instead).

## 0.44.2 and Quest panel client 0.3.4 (2026-10-14)

- **Agents were pausing three seconds after every open and click** (two `wait ms=3000` calls were over half the time of one task on the owner's PC). A fixed pause (`wait` with `ms`) is now cut to at most 1000 ms, its answer carries a `hint` ("paused N ms ... not needed after open or click ... use wait with name or window, or find"), and the desktop tool's description and `ms` field say to prefer waiting for a name and that acting answers already say what is in front.
- **Quest 0.3.4:** with the fast engine, a fixed pause ends as soon as the panel has been quiet a moment (at least 150 ms, at most the time asked, answered `settled`); without it the whole time passes as before. versionCode 7 (helper too).

## Quest panel client 0.3.3 (experimental) (2026-10-14)

Quicker actions, from timings on the owner's headset (a click took about 490 ms, typing about 1 s, open about 1.8 s).

- **`after` from the fast engine.** An action's `before` and `after` were two `dumpsys window` calls through adb (100 to 150 ms each) and a fixed 300 ms wait. With the fast engine running they are one call to the helper, `front` (the active window's package and title), made as soon as the panel is still: no accessibility event for 100 ms, 400 ms at most (the helper counts events with UiAutomation's listener; without one, `waitForIdle`). `before` is what the last look or action saw when that was under a second ago. Without the fast engine nothing changed.
- **`open` waits for the app**, not a fixed 1.2 s: it looks at what is in front every 100 ms (through the shell every 250 ms) until the started app (or, for an address or Settings, anything new) is there, 2 s at most, and that is `after`.
- **Typing blind into the focus** asks the helper what has the focus (`focus`: password, editable, name, handle) instead of reading the whole panel; still refused when a password field has it, and when the helper cannot tell, the panel is read as before.
- **A look's `device` line** says actions answer with `after` (no need to look again) and to wait for a name, not a number of milliseconds.
- Tests: UpdateTest's "adb not there" failed now and then on a busy machine: the pretend adbd still took a connection after it was closed (the JDK closes a listening socket only once the thread in `accept()` wakes). It now waits for that thread and drops anything accepted after closing.
- versionCode 6 (helper too). Axis is unchanged.

## Desktop app 0.9.1 (2026-10-14)

Quicker actions, from timings on the owner's computer (a click took about 1.1 s, opening an app 4 to 8.6 s).

- **The pointer waits less.** It waited 450 ms before every click, type, scroll and key press; now its glide (220 ms, was 320) and 30 ms more, or 100 ms when it appears on the spot. After open, switch and window it is shown without waiting at all.
- **Open returns as soon as the window is there**: polled every 100 ms (was 150), without the extra 250 ms for its title, and without bringing it forward when it is in front already. An app whose window was in front before and stays the only one is taken after 1.5 s instead of 8 s (likely the 8.6 s seen). The list of Start-menu apps is read again in the background when it is old, so an open no longer waits for the shell to list them (an app not in the list kept is looked for in a fresh one).
- Guards unchanged (password fields, Pause, deadlines). Not run on Windows by its author.

## Quest panel client 0.3.2 (experimental) (2026-10-14)

- **The fast engine's helper connects to the app now.** From the owner's headset log: the helper installed and started, and the app got "Connection refused" while it was still starting and then **"Permission denied"**: the headset's SELinux policy does not let an app connect to the abstract local socket the helper had made. The helper now listens on `127.0.0.1` at a port the app picks per start and the app proves it holds a secret (a challenge each way, an HMAC; the secret is never sent), see `HelperProtocol` and `HandshakeTest`. The helper's package now declares INTERNET (Android requires it for any socket, loopback included).
- **A started helper gets 25 s to answer, not 8.** Connecting its UiAutomation took most of 8 s on the headset; the app killed it and started it again, so it never got further.
- **The status trail works.** 0.3.1 wrote it to /data/local/tmp, which the helper's process (the helper package's own uid, not the shell's) cannot write: "it wrote no status" was our own bug. It goes to the helper's external files folder (`/sdcard/Android/data/dev.vortexaxis.quest.helper/files/status.txt`), which the app reads over adb.
- versionCode 5 (helper too). Axis is unchanged.

## Quest panel client 0.3.1 (experimental) (2026-10-14)

- **Updates from Axis now install.** On the owner's headset the update command arrived and said "Updating", and nothing was installed: the install was started detached from the app's adb stream (`nohup ... &`) and never ran, and nothing said so. The app now runs `pm install -r` in its own adb stream a few seconds after answering, waits for it, and says what pm said if it fails (Recently, the log, the admin page's answer). When it works Android replaces the app and starts it again through a new `UpdatedReceiver` (ACTION_MY_PACKAGE_REPLACED, which may start the foreground service). The 0.3.0 on a headset still has the old way: install 0.3.1 once by hand (`adb install -r`), and updates from Axis are the new way after that.
- **The fast engine says why it did not start.** The helper writes how far it got (and any crash, with its stack) to `/data/local/tmp/vortex-axis-helper.status`; when it does not answer, the app's message carries that trail, what `am instrument` said, and why connecting to its socket failed. Copy diagnostics has it. (On the owner's headset the helper installed and started, then did not answer within 8 s, and "Process crashed" was all the app could say.)
- versionCode 4 (helper too). Axis is unchanged.

## 0.44.1 (2026-10-14)

- **An agent waiting for its subagents no longer shows as "needs you".** The progress cards Axis mirrors from an OpenClaw gateway counted a session with steps left and no run of its own as waiting for the person. A session that has started subagents still running is at work now, and its task says so in the note: "2/3 agents running · <step>". When they have all finished and the agent has not come back, the task is the person's move as before, and the note keeps the count ("3/3 agents done · <step>"). It reads the session list Axis already polls for open tasks (`childSessions`, each child's `hasActiveRun`, and the session's `hasActiveSubagentRun`); nothing new is asked of the gateway.

## Quest panel client 0.3.0 (experimental) (2026-10-14)

- **Type `meta-quest`** (was `quest-panels`); shown as "Meta Quest" on the admin page. Needs Axis 0.44.0, which takes either. The update route and command are unchanged, so a headset on 0.2.0 updates to this as before.
- **A fast engine.** The app carries a small second APK, `dev.vortexaxis.quest.helper`, installs it through its own adb when it is missing or another build, and starts it as adb's shell user (`am instrument -w`, detached). The helper holds one UiAutomation connection and answers the app alone over an abstract local socket, checked by uid at both ends. A look is one call instead of a `uiautomator dump` process; taps press the element by its handle, typing sets the text at the caret (any Unicode, so no more plain-ASCII limit and no `%s` quirk, and never into a password field, which the helper also refuses), scrolling uses the list's own scrolling, keys are injected (key combinations without Android 13's `keycombination`), Back is the system's Back, screenshots come from UiAutomation. Answers keep their shapes; `scroll` says `how: "scroll"` when the list scrolled itself.
- **Falls back per call** to `uiautomator`, `input` and `screencap` when the helper does not answer (it is stopped, since uiautomator cannot read while it holds the screen, and started again after a wait that grows each time); an action it may have done before going silent is not done again through the shell. "Use fast engine" (on by default) switches it off. The helper dies with the headset's restart, like `adb tcpip`, and is started again by itself; it ends on its own when the app has not been heard for ten minutes.
- **Live tab**: what the app is doing in plain words ("Tapping "Elixir"…", "Typing 11 characters", "Idle"), when the last thing happened and how long it took, Axis, adb and the engine as coloured dots, the last eight actions and a big Pause. The notification says the same line.
- **Test** reads the panel with the fast engine, then with uiautomator normally and compressed (stopping the helper meanwhile), and shows all three timings; Copy diagnostics and the admin page's Check say which engine is in use.
- versionCode 3; the helper is versionCode 3 too. Not run on a headset yet: none of the fast engine (the helper starting and staying up under `am instrument`, UiAutomation from a shell-started instrumentation on Horizon OS, its screenshots, `ACTION_SET_TEXT` in Quest apps, which windows it sees), nor the Live tab.

## 0.44.0 (2026-10-14)

- **The Quest panel client's type is `meta-quest` now** (it was `quest-panels`), shown as "Meta Quest" on the admin page. On start Axis moves what it kept under the old name: the clients, the type layer of settings, what the type described and the name given to it (the new name's rows win if both exist; it does nothing when there is nothing to move). A headset still on the app's 0.2.0 that pairs with the old name is kept as `meta-quest`, and its hello's type was never used, so it connects, is offered the update and downloads it through `GET /v1/quest/app` as before. The one place the old name is mapped is `server/src/clienttypes.ts`.

## Quest panel client 0.2.0 (experimental) (2026-10-14)

- **Tidier, shorter looks.** Things come in reading order (bands from the top, left to right in a band), so a header row drawn last in the dump comes first; a list's items still follow their list. A tile's short texts are folded into its name (`Unplugged: Air Guitar, $19.99 — 4.3 (1.2K), Games • Rhythm`, the trailing bullet cut), and a tile without a name of its own is named by its first label. Decoration pictures ("Star icon representing rating", "…, image"), a text or picture repeating a tappable thing in the same box, and an unnamed disabled copy of something in the same place are left out. A line shows at most 80 characters of a name (120 with a tile's details), cut at a word; finding and clicking by name still uses all of it. On a fixture modelled on a real look at the Store's front page: 52 lines before, 24 after.
- **Where a look's time goes**: the Test button and Copy diagnostics say adb connect (when there was one), dump, read-back and parse milliseconds, the total and the node counts. The dump and the read-back are two adb calls now, to time them apart.
- **Faster looks** (a switch in the app, off by default, kept): `uiautomator dump --compressed`, which may leave out things an agent needs. Test reads the panel both ways and shows both timings and counts.
- **Updates from Axis**, as the desktop app has them: Axis's `update` command is taken only for a newer version, only from the paired Axis (plain http only nearby), downloaded with the headset's token, checked by size, SHA-256 and Android's package manager (same app, same signing key, not an older build number), then installed through the app's own adb with `pm install -r`, detached so it finishes after the app ends, and the app started again. Recently says "Updated to X" after the restart, or pm's words when the install failed. A new setting on the headset's page, "Update automatically" (on).
- versionCode 2. Not run on a headset yet: the self-update and restart, `--compressed`, the new reading order on real panels.

## 0.43.0 (2026-10-14)

- **Axis keeps Quest headsets on the newest Quest app** in the data folder's `quest/` (or a release image's `bundled/quest/`): a headset with an older version is told to update when it connects, or when a newer build lands, unless its "Update automatically" is off; never to an older or the same build. `GET /v1/quest/app` serves the APK to a `quest-panels` client's own token only; `GET /admin/quest` says what is there.
- **Update on a headset's admin page**, and `POST /admin/clients/:id/update` works for `quest-panels` (it answered 404 before).

## Quest panel client 0.1.0 (experimental) (2026-10-14)

- **A Meta Quest is a computer to Axis now**, for its 2D panels (Store, Browser, Settings, Android apps): `clients/quest-client/`, an Android app that pairs like any device (type `quest-panels`, capability `desktop`) and answers the desktop tool's `look`, `find`, `wait`, `click`, `type`, `keys`, `scroll`, `open`, `screenshot` and `steps` in the Windows app's shapes, through the headset's own adb (`adb tcpip 5555` from a computer after each restart, the app's key allowed once on the headset). Panels are read with `uiautomator dump` and made small: labels from `content-desc` for React Native panels, a tile named from the text inside it, everything clipped to the 1280x800 panel and what is off it left out. `switch`, `window`, `desktop`, `clipboard` and `paste` are refused with words; `point` is accepted and noted. The Windows app's guards, ported: Pause, the device's switches, no password fields, refused keys (power, sleep, recents), only http(s) addresses and installed apps opened, a deadline on every adb call, one command at a time.
- The window (pairing, connection and adb state, Set up steps, Pause, Test, Recently, Copy diagnostics, Forget), a foreground service with Pause in its notification, the token and the adb key sealed with the Android Keystore, a rolling log without tokens or typed text.
- `scripts/build-quest-client.sh` builds it in Docker into the data folder's `quest/`; `scripts/test-quest-client.sh` runs its JVM tests and an end-to-end test against a real Axis from the checkout (pairing, the socket, the desktop tool through `POST /mcp`, a pretend adbd). No change to Axis itself.
- Not run on a headset yet. Not built: voice, a pointer in the headset, updates from Axis, starting at boot.

## Desktop app 0.9.0 (2026-10-13)

- **The face can be put anywhere.** While it is kept on screen, right-click it and drag. Where it is let go is remembered (and held inside the screens: if a monitor goes away, it comes back). Settings and the tray list it as "Where you put it" next to bottom centre, left and right.
- **The tray icon's right-click menu has the everyday switches again:** talk from this computer, show the face, keep it on screen, its size and place, show when an agent is using this computer, start with Windows. Settings has the rest. The window and the menu always agree.
- **The connected indicator has rounded corners, not an oval**, like the buttons.
- **Steadier:** the settings file is written whole or not at all, with the last good copy kept (a cut-short write used to be able to cost the pairing); an error in one handler is logged and the app carries on instead of vanishing from the tray; a failing sound-device list no longer stops the window opening; a log at `%APPDATA%\VorteX Axis\desktop.log` keeps what went wrong.

## Desktop app 0.8.1 (2026-10-13)

- **Buttons have rounded corners, not a pill shape**, the same radius as the text boxes and drop-downs.

## Desktop app 0.8.0 (2026-10-13)

- **Settings in the app's window.** Beside "Recently" there is now "Settings": talk from this computer on or off, the **talk key** (Ctrl+Alt+Space, Ctrl+Shift+Space, Ctrl+Alt+V, Ctrl+Alt+T, F9 or Pause), the **microphone** and **speaker** (Windows' default or a named one), Vortex's face (show it, keep it on screen, **small, medium or large**, **bottom centre, left or right**), and the "using this computer" pill. The tray's switches moved there; the tray has "Settings" instead. A key another app holds is said in Recently, with a pointer to pick another. The voice pill names the chosen key for a question.
- `docs/hardware.md` says what to do about the "Windows protected your PC" box the unsigned app gets on first run, and how to build it yourself instead.

## 0.42.3 (2026-10-13)

- **A task's spoken answer starts with the chime**, the way a timer does, on a device that has one: Axis plays it, gives it a moment, then says "About <title>: ...". Only when there is something to say: a task that answers `NO_REPLY` stays silent and does not chime, and a device without a chime action or a speaker just shows or says the answer as before.

## 0.42.2 (2026-10-13)

- **A task's answer says what it is about.** It opened cold, some minutes after it was asked for. It now begins "About <the task's label, or the start of what was asked>:", as the answer of a run handed over to the background does, in speech and on the screen. A task with nothing to tell still says nothing.
- **A device waits 45 seconds** for the agent before it stops waiting and the run carries on in the background (it was 30, which had started to cut in on ordinary answers). `AXIS_HANDOVER_MS` changes it.

## 0.42.1 (2026-10-13)

- **A board flashed from the flasher page did not start** (owner's first try: "partition 3 invalid ... exceeds flash chip size 0x800000", over and over). PlatformIO's factory image says in its header that the flash is 8 MB, the generic board definition's size, while this board is built for 16 MB; a cable upload corrects the header on the way, a browser flasher writes the file as it is. `scripts/factory-image.mjs` now makes the factory image with esptool, with the size from the board's `platformio.ini` and the checksum renewed, and checks the result; the flasher folder, `push-firmware.mjs` and the release workflow all use it. A board left in that state is fine: flash it again from the page (hold BOOT while plugging in if it is not found). Fixed at the source as well: the board's `platformio.ini` now sets `board_upload.flash_size`, so the bootloader PlatformIO builds has the right size in its header to begin with; the script stays as the check. Only the factory image was affected: updates over Wi-Fi send the application alone, and boards flashed by cable had their header corrected by the upload.

## 0.42.0 (2026-10-13)

**Timers that do something** (owner: "check on it in 20 minutes" set a timer that only reminded him).

- The timer tool's `set` takes **`then`**: an instruction the agent writes to its later self. When the timer is due it does not ring: Axis gives the agent that instruction as a turn of its own (marked as scheduled, with how long ago it was asked for) and the answer is spoken on the device the timer belongs to, like any reply. An answer of `NO_REPLY` says nothing, for "tell me only if it failed". It runs once; repeating is not Axis's job. The countdown on the screens says "Task" for one without a label.
- **Look-only on computers unless the person allowed it, and Axis asks them itself.** While a scheduled task runs, clicking, typing and every other desktop action that changes something is refused (looking goes on), and the agent is told so. To act, the agent sets the task with `act: true`; the device then asks the person, in Axis's own words, "may it click and type on your computer?" with Allow and Look only to tap or say. Only "Allow" counts: no answer, a device that cannot ask, or anything else leaves it look-only, and the tool's answer tells the agent which. An agent saying the person agreed is not enough. A task whose run is handed over to the background stays look-only for 15 minutes more.
- The limit is on Axis's own desktop tool. What an agent does with tools Axis does not provide is its harness's to govern (`SECURITY.md` says so).
- The admin page's Now table shows such a timer as "Task for later" with what it is to do and whether it may act. If a task cannot be carried out, the person is told rather than hearing nothing.
- `Turns.task` starts a turn nobody is asking for just now; `Desktops.holdLookOnly`; timers keep `task` and `may_act`.

## 0.41.3 (2026-10-13)

- **Every Axis serves the flasher, at `/flash`** (owner: why wait for a page on GitHub?). It installs the firmware on the hub's own shelf, so the board ends up on what the hub has; the installer's files are in the image (fetched from npm when it is built), so nothing is loaded from anywhere else. Linked from **Add a device**. Browsers allow USB access only over https or from localhost, and the page says so when it is opened otherwise.
- The firmware shelf keeps a **factory image** beside a build when it is given one: a release image brings it (`bundled/firmware/manifest.json`, `factory`), `scripts/push-firmware.mjs` uploads it, and `POST /admin/firmware/<type>?version=..&part=factory` takes one by hand. Removing a build removes it.
- The standalone flasher folder (GitHub Pages) carries the installer too; no CDN.

## 0.41.2 (2026-10-13)

More of what a stranger needs.

- **A browser flasher for boards** (`flasher/`): a page that puts the firmware on a new board over USB from Chrome or Edge, with ESP Web Tools; no PlatformIO. `scripts/make-flasher.mjs` puts the page, a build's factory image and the manifest together; the release workflow publishes it to GitHub Pages. Checked here that the page loads and its install button comes alive; flashing a board from it has not been tried.
- **`docs/hardware.md`:** the board (what it is, first install three ways, setting up, using it, its limits), the Windows app, a phone or browser, and where to start for another device.
- **`CONTRIBUTING.md`** and issue forms for a bug and an idea. `SECURITY.md` says how to report a problem privately.
- Tests: longer limits and a retry, and fewer at once on CI. The suite timed out on a busy runner (40 of 148 runs on the project's runner had failed that way).

## 0.41.1 (2026-10-13)

Set-up for somebody who has never seen the project.

- **README** rewritten for strangers: what Axis is, what you get, a quick start from the published images, the devices, where to read more. What it held about running and operating Axis is in `docs/setup.md`, unchanged.
- **`compose.release.yaml`:** Axis and its speech services from published images, nothing to build (`compose.yaml` still builds from the repository). The release workflow also pushes the speech image, on GitHub.
- **Getting started** on the admin page's Overview: speech working, an agent that answers (OpenClaw or a chat endpoint, with a link to the other), a first device, a first turn; each step links to the page that does it. It goes when all four are done, or when it is put away.
- `scripts/browser-check.mjs` uses an admin token long enough for 0.40.2's rule, and counts thirteen tool icons.

## 0.41.0 (2026-10-13)

The first release built by the release workflow: the project is free software under the Apache License 2.0, and one version tag now builds everything a person needs.

- **Licence:** Apache-2.0 (`LICENSE`), with `NOTICE` naming what the repository includes from others and what builds fetch.
- **Releases:** a tag `vX.Y.Z` (it must match `package.json`) runs `.github/workflows/release.yml`: the board firmware (an image for updates over Wi-Fi and a factory image for a first flash by cable), the Windows desktop app, and the Axis image with both inside it. On GitHub the image goes to `ghcr.io` for amd64 and arm64 and the files to the release; on a Gitea runner the image is built and checked, and the files go to the release. The test workflow moved beside it to `.github/workflows/` (one place for both); it chooses its runner the same way.
- **A fresh Axis comes with firmware and the desktop app.** A release image carries them in `bundled/`. At start, Axis puts the bundled firmware on the shelf when it is newer than every build of its type there (boards are still only updated when somebody presses Update); the desktop app offered and auto-updated is the newer of the image's and one built on the hub (`scripts/build-desktop.sh`). `AXIS_BUNDLED_DIR` points elsewhere.

## 0.40.2 and desktop app 0.7.7 (2026-10-13)

First part of getting ready to be public: a scrub and a security review (`SECURITY.md`, new).

- **The admin token must be 24 characters or more.** Shorter, the admin side stays off and the log says why (`.env.example` says so too).
- **The data folder and database are for Axis's own user only** (`700`, `600`), and so are backup copies, where the folder allows it. They hold the gateway's private key, the push keys and every token's hash; they were readable by every user on the host.
- **The desktop app will not update over plain HTTP across the internet**: only over https, or to Axis on the same computer, the local network or a tailnet. The checksum came the same way as the program, so it could not protect a download on an open link.
- Scrub: no secret was ever committed (no token, key, `.env` or database in any commit). Current files: a test used the owner's first name, and the status history named the boards; both made generic. The git history still holds installation details (see the project's notes before publishing it).

## Desktop app 0.7.6 (2026-10-13)

- **The face follows the agent's voice.** While it speaks, the figure swells with what is coming out of the speakers (`IVoiceIo.PlayLevel`, measured as the audio is handed to the device; `Voice.Loudness`), as it follows the microphone while listening. It only pulsed on its own before.
- **The pills at the top** share one look (`Pill`): a dark surface a little lighter at the top, a soft shadow, an edge with a hint of the moment's colour, a dot that glows in it, and they fade in and out instead of popping. The voice pill: the word for the moment in its colour, what was heard in quotes and italics, a hairline, then the reply a size larger. The "using this computer" pill: a hairline between the title and the last thing done.
- `CLAUDE.md`'s Status section cut back to the current state; what it held is in `docs/status-history.md`.

## Desktop app 0.7.5 (2026-10-13)

- The face has no disc and no outline any more (owner: the black background with a coloured border looked odd): it sits on a soft dark pool that fades to nothing at its edge, and each dot gives off a little light of its own colour. Window 200 px, the figure in the middle 60 %.

## Desktop app 0.7.4 (2026-10-13)

- **Vortex's face on the computer** (owner's layout: words at the top, the face at the bottom). The boards' face on a dark disc, 132 px, at the bottom centre of the main screen: it fades in for a voice turn (listening follows the microphone, thinking shows the tool icon Axis names, speaking pulses) and while an agent is using the computer (thinking, with the computer icon), and fades out 2.5 s after. Click-through, never takes the focus, out of the picture for captures. Tray: "Show Vortex's face" (on) and "Keep the face on screen (click it to talk)" (off): kept, it idles through the idle looks and a click is the talk key.
- The face is `Face` in Core, a line-for-line port of `web/vortex.js` that gives the platform circles to paint; its icons come from `web/icons.js` by `scripts/gen-icons.mjs` (`FaceIcons.g.cs`). docs/face.md now has three copies to keep in step. Frames rendered on Linux from the real class and looked at: idle, listening, thinking, the computer icon in dots and as a line, speaking. The window itself not run on Windows.
- `Voice.Doing`: what Axis says the agent is doing while it thinks.

## Desktop app 0.7.3 (2026-10-13)

- The voice pill has the look of the "using this computer" pill and sits at the top of the main screen too (it was at the bottom): near-black, a thin edge in the state's colour (mint listening, violet thinking, cyan speaking, blue for a question), as wide as its words up to 460 px. When both show, it sits just under the other and moves up when that one goes.

## Desktop app 0.7.2 and board firmware 0.18.2 (2026-10-13)

- **The computer shows when an agent is using it.** A pill at the top of the main screen, "VorteX is using this computer" with a breathing rose dot and the last thing done, from an agent's first desktop command until 8 s after its last. Click-through, never takes the focus, steps out of the picture for looks that read pixels and for screenshots. Tray: "Show when an agent is using this computer" (on by default). Not while paused, and not for the admin page's "Show the pointer".
- **Boards:** the "Computer in use" glow shows only while the face is idle, not round the thinking face, where it cost frames; the computer icon says it there.

## 0.40.1 and board firmware 0.18.1 (2026-10-13)

- **Swipe down puts finished tasks away.** A `swipe_down` from any device clears the tasks that are done from every screen (`Progress.clearDone`); ones under way or waiting stay. A board sends that swipe while a finished task shows even with its "gestures" setting off.
- **A computer icon** among the tool icons (now thirteen): shown while the agent uses the desktop tool, a harness's computer use or a node's screen snapshot (`doingFor`: desktop, computer, screen snapshot). Rose, like the "Computer in use" glow. Defined in `web/icons.js`, `icons.h` regenerated.
- **Admin Live page:** finished tasks, tool calls, turns and wake words each scroll in their own box (420 px), table headings staying in view.

## Desktop app 0.7.1 (2026-10-13)

- The same as 0.7.0 as described below. A first, unfinished 0.7.0 build (no `screen` capability, so no transcript, reply text or questions in the pill) sat in the data folder for a few minutes during development and the owner's computer updated itself to it; a new number makes it update again. `scripts/build-desktop.sh` publishes at once to every computer with auto-update: bump the version only when a build is meant to go out, and build experiments elsewhere.

## 0.40.0, desktop app 0.7.0 and board firmware 0.18.0 (2026-10-13)

- **The computer as a voice device.** Ctrl+Alt+Space talks from the PC: a press listens until a pause (1.2 s), a hold listens until let go, a press while the agent thinks or speaks stops it; answers play on the PC's speakers and are reported (started, finished, stopped) like a board's. A pill at the bottom of the main screen shows listening (a dot that swells with the voice), what was heard, the reply, and questions with their choices (answered with the same key). The app then says `mic`, `speaker` and `screen`, so the agent's turns are marked as coming from the computer and Axis can speak there. Tray: "Talk from this computer" (on by default; off goes back to a computer only, and reconnects). The protocol and timing are in Core (`Voice`), the platform supplies `IVoiceIo` (Windows: NAudio.Core + NAudio.WinMM 2.2.1, MIT, the first audio dependency). Checked against a throwaway Axis with the real speech services: a recorded sentence went up, came back as "What time is it right now", and an announcement was played and reported heard. Not run on Windows.
- **Boards show when an agent is using a computer.** Axis counts a computer as in use from an agent's desktop call until 8 s after its last; the screens in its location (every screen when it has none) are told `desktop.busy {on, computer}`. Boards (firmware 0.18.0) glow rose along the edges while idle or thinking, setting "Computer in use glow" (`handsGlow`); the glow preview has it as "Computer in use". The admin page's Now table lists "Computer in use" with the last thing the agent did.

## 0.39.0 and desktop app 0.6.0 (2026-10-13)

Owner picked four of the proposed desktop features; also kept portable so the same commands can come to a Mac app (new platform calls are on `IDesktop`, the logic in Core).

- **Auto-update.** Axis serves its desktop build to paired computers (`GET /v1/desktop/app`, the computer's own token, `x-sha256`) and sends `update {version, size, sha256, path}` to a computer that connects with an older version (or is connected when a newer build lands; checked every 5 minutes), unless its new setting "Update automatically" (`autoUpdate`) is off. The admin page's Update button works for computers too. The app downloads next to itself, checks size and SHA-256, renames itself to `.old`, puts the new file in place, starts it (`--updated`: it waits for the old one to quit) and quits; the next start deletes `.old`. Download and checks are in Core (`AppUpdate`); the swap is the Windows app's. A computer offered a version and refusing is not asked again for that version.
- **scroll** (`go` up/down/left/right/top/bottom, `pages` 1-10; a name or id scrolls that list or page): UI Automation's scroll on the element or what holds it, else the mouse wheel over it (or the window in front), the mouse put back.
- **wait for**: `wait` with `name` (in the window in front) or `window`, `gone: true` for until it goes, `seconds` 1-20 (Axis waits that long plus 5 s); checks twice a second; not in time fails saying what is there.
- **clipboard** reads copied text (up to 4000 characters back, `more` when longer); refuses what a password manager marked private; says so when it holds a picture or files. Under "Let agents read the screen".
- **paste** puts any text up to 20,000 characters into a field by name or the focus via the clipboard and Ctrl+V, kept out of Windows' clipboard history, and puts the person's clipboard back afterwards. Its text travels as the command's data. Same rules as type (window brought back, never a password field). Also a step.
- The update cannot reach a computer still on 0.5.0 or older (it has no `update`); install 0.6.0 by hand once.

## Board firmware 0.17.3 (2026-10-13)

- A picture on the board stays through a follow-up: while Axis works out the spoken words and while the agent thinks, the picture keeps showing with the thinking glow around it, as it already did while listening. Before, the picture closed and the face came back as soon as the words were being worked out. A tap, a question with choices, a newer picture or the time running out still close it.

## 0.38.0 and desktop app 0.5.0 (2026-10-12)

Screenshots for agents, as a last resort (owner's design: for understanding only; the agent still acts by name or id, never by coordinates read off a picture).

- **`vortex_axis_desktop` action `screenshot`:** the window in front (default), `id` to crop around an element from the last look or find (with a margin), or `scope: screen`; `detail` low/normal/high = longest side 640/1024/1568 px (a 16:9 window at normal is about 800 tokens). JPEG quality 72, the app's pointer hidden for the capture, refused while a password field has the focus (and when that cannot be checked).
- **Off by default, per computer:** setting "Let agents take screenshots" (`allowScreenshot`), checked by Axis and by the app.
- **An image to the model:** the MCP door lifts `image` out of a result into an MCP image block beside the text; `structuredContent` has no picture. The Live page keeps "[picture]", not the picture.
- **Description:** use only when absolutely necessary (look/find cannot tell: games, 3D/Unity/WebGL, canvases, images, charts; something visual to check; or the person asks to have their screen seen), then act through find/click/type.

## Desktop app 0.4.5 (2026-10-12; replaces 0.4.4, which was never installed)

**The real cause of unanswered looks, since 0.4.0.** 0.4.3's new warning on the owner's PC said it: "the answer could not be sent: JsonSerializerOptions instance must specify a TypeInfoResolver". 0.4.0 made a look's elements plain strings and added them with `JsonArray.Add<string>`, which wraps them so that writing them needs a type resolver; AxisLink writes every message with its own options object, made by hand without one, so turning a look's answer into text threw, and the old code swallowed the error. `find` built its list with explicit `JsonNode` casts and kept working. The look itself took 189 ms on Notepad; nothing was slow.

- Elements are added as `JsonNode`, and AxisLink's options carry a resolver, so the trap is closed twice. Reproduced exactly (same message) with the real Core and the default runtime setting, and fixed.
- Audit: every desktop command (look in all scopes, find, point, hide, wait, hello, click, type, keys, open, switch, window, desktop, steps passing and failing, an unknown command) and the describe message, through the real Core, serialize even with the old resolver-less options.
- 0.4.4 also switched reflection-based JSON off for all desktop builds; that would have broken the app's saved pairing file (`Saved.cs` uses reflection), so 0.4.5 takes it back out.
- The thread-pool explanation given for 0.4.1 was a guess and was wrong about looks; 0.4.1-0.4.3's deadlines on Windows calls, the OCR deadline, the 12 s fallback and the send-failure warnings stay as hardening.

## 0.37.3 and desktop app 0.4.3 (2026-10-12)

On 0.4.2 a look at Notepad showed "Looked at the window: 85 things" in the app, yet Axis heard nothing in 15 s; not even the 12 s fallback answer arrived. The same look answer, built by the real Core from a fake Notepad, is 3.5 KB and passes Axis's protocol check, so the answer is being held up or lost on the PC. Instrumented instead of guessed:

- **Axis logs a late answer** (`answered "desktop.look" N ms after it was sent, too late`), so a slow answer is told apart from a lost one.
- **The app no longer swallows a failed send:** it says so in its own list, as it does an answer that took over 10 s (work vs sending time) and a command that waited over 1 s to start; each with the thread pool's state.
- **Look timings** in the app's list: total, reading the controls, reading the pixels, and the thread pool's state. The list shows seconds.
- **Thread pool floor** of 32 workers, in case slow Windows calls are starving it (what broke 0.4.0).

## 0.37.2 and desktop app 0.4.2 (2026-10-12)

The owner's first run of 0.4.1: open Notepad and type worked, but every `look` still went unanswered while `find` (the same read) answered in 0.2 s.

- **Looks that read pixels never answered.** Every failing look was on a window with few controls (Notepad, a page still loading, the area under the mouse), which turns on OCR; `find` on busy windows never did. The pointer hide, the capture and Windows' OCR now run off the look's thread under one 4 s deadline; past it the look answers without the pixel text and says why (`ocr`). Which of the three hung is not known (no Windows here).
- **Backstop:** look and find always answer within 12 s, naming the trouble, instead of Axis timing out at 15 s.
- **"Brave Windows is not a computer":** an agent that passes the device the person spoke from as `client` now gets the computer (the only one online, or the one in that device's location) instead of an error. Axis also logs a message from a device that it refuses.

## 0.37.1 and desktop app 0.4.1 (2026-10-12)

Fixes from the owner's first use of 0.4.0 (looks never answered; "open Notepad and type hello world" typed into another window's chat box; the pointer barely moved).

- **Looks hung:** every UI Automation call now runs on its own thread with a deadline (`Uia.Run`), never on the thread pool. In 0.4.0 the before/after focus reads gave up after 2 s but left their pool thread blocked inside a window that did not answer; enough of them starved the app until even a look could not reach its own 10 s limit, and Axis gave up at 15 s. A read past its deadline now fails with the window named; with 8 reads stuck, calls fail at once saying a window is frozen. The window title comes from Windows, not UI Automation. OCR has a 4 s limit.
- **open waits for its window:** it waits up to 8 s for a new window (or the front to change, or a window of that app), brings it to the front and answers `note` when none showed. The agent no longer needs a `wait` step.
- **type and keys go to the right window:** the app remembers the window last opened, switched to, clicked or typed in (for 90 s). If something else has taken the front, it is brought back first; when it cannot be, nothing is typed and the error says which window is in front. A dialog that window owns counts as it.
- **The pointer shows every action:** open and switch point at the window, typing points at the field with the text in the bubble (it stays up while typing), keys point at the window; the pointer gets a little longer to glide there.
- Tool description: open and type say the above; the steps example has no `wait`. Package versions back in step.

## 0.37.0 and desktop app 0.4.0 (2026-10-12)

Fewer tokens per task on a computer (owner picked three of the ideas).

- **`after` on every action:** click, type, keys, open, switch, window, desktop and steps answer with the window in front (`new` when it is not the one in front before), what has the focus and its value, read about 0.3 s after the action (1.2 s after an open). Two small UI Automation reads, not a look; the description tells agents to trust it instead of looking again. `steps` carries one `after` at the end (also when a step fails).
- **Leaner looks:** each element is one line, `id kind x,y wxh name [= value] [*focus] [(ocr)]`, about half the text of the old object; `screen`, `mouse`, `window` and `monitors` likewise. `find` matches use the same lines.
- **Shorter tool:** the `vortex_axis_desktop` definition is about 37 % shorter (description and parameters); it now states how looks are ranked (focus, under the mouse, then usable things nearest the mouse). The app's own refusals are no longer listed to agents; they still apply.

## 0.36.0 and desktop app 0.3.0 (2026-10-12)

Fewer model turns per task on a computer (owner's idea: preset commands; the time goes to the agent thinking between calls, not to the PC).

- **By name:** `click`, `point` and `type` (`into`) take a `name` (and `kind` to narrow it), matched in a fresh read of the window in front: same name, then starts with, then a word, then anywhere; usable things first, big containers last; a button wins over its own label inside it. Several equal matches fail with their ids. **`find`** returns the five best matches with ids instead of a whole look.
- **`steps`:** up to 10 of open, switch, window, desktop, click, type, keys, wait, find and point in one call, run in order with a short settle between, stopping at the first that fails; the answer says how each went (`done`, `failed`, `error`). Sent as the new optional `data` on `command` (protocol 1; only the desktop app is ever sent it).
- **Presets:** `open` (a Start-menu app by name, through shell:AppsFolder, or an http(s) address; never a path or a command), `switch` (bring a window to the front by app or title), `window` (minimize, maximize, restore, move to display n; no close), `desktop` (next or previous virtual desktop). All held by the computer's **Let agents click and type** switch.

## 0.35.0 and desktop app 0.2.0 (2026-10-12)

- **Computers can be clicked and typed on (experimental).** `vortex_axis_desktop` gains `click` (an element from the last look, pressed directly through UI Automation where it can be, else a real click there with the mouse put back; or `x`,`y`; `button` left, right or double), `type` (up to 500 characters a call, into an element or whatever has the focus) and `keys` (one combination: enter, ctrl+s, alt+tab…). The app's pointer glides to where it acts first.
- **Limits the agent cannot lift:** never types into a password field (the one named or the one with the focus); never presses lock (Win+L), the security screen, Task Manager, Alt+F4, Win+R or Win+X; everything stops while the app is paused (Ctrl+Alt+S).
- **Off switch:** the computer's setting **Let agents click and type** (`allowInput`, on by default) on its admin page. Axis refuses before asking the computer, and the app refuses too. Looking and pointing go on.
- The tool's description tells agents to look again after anything that changes the screen and to ask with `vortex_axis_ask` before anything hard to undo.

## 0.34.1 and desktop app 0.1.1 (2026-10-12)

- **Several displays:** a look now says where the whole desktop starts (`screen` x, y) and gives each display's box (`monitors`). The first live test had a Discord window on a display above the main one; its buttons had negative y, and the agent took them for off-screen.
- **The best 250, not the first 250:** a busy window's elements are picked before the cut (`DesktopCommands.Pick`): the window, what has the focus and what holds the mouse always; then things that can be used, nearest the mouse first; then the rest. Sent in the window's own order. The app now reads up to 1500 to pick from.
- **A look no longer fails on one odd element:** an element that will not describe itself is left out. In the first live test, two looks at a Brave window failed in 0.4 s with an empty error, and the agent pointed at a guessed spot. Errors now always say what kind they are, in the app's Recently list as well, and Axis words an empty one. The tool's description asks agents to say a look failed rather than point at a guess.

## 0.34.0 and desktop app 0.1.0 (2026-10-12)

- **Computers, experimental: seeing and pointing.** A Windows desktop app (`clients/windows-desktop/`, C#/.NET 8, one self-contained `.exe`, styled like the web client) pairs with Axis as a client with the new `desktop` capability. An agent with the new tool `vortex_axis_desktop` can **look** (the window in front, what is under the mouse, or the open windows: controls by UI Automation, text by Windows' OCR when a window says little; ids, kinds, names, boxes; never a password's value) and **point** (the app's own glowing pointer with the agent's words beside it; the mouse is not moved). The person can pause it from the window, the tray or Ctrl+Alt+S. The tool is MCP only (not on the OpenClaw node, so no re-approval) and, like any experimental tool, off until switched on under Agent tools. `command.result` gains an optional `data` (any JSON). The admin page's **Add a device** offers the app for download once `scripts/build-desktop.sh` has built it into the data folder (`GET /admin/desktop`, `/admin/desktop/app`).

## Board firmware 0.17.2 (2026-10-11)

- Fixed: **Show on the device** (and Find) only sometimes worked. Commands run on the client's task on the other core; the handler stamped the start with `millis()`, which could be later than the screen loop's frame time, so the unsigned elapsed time wrapped round and the glow was cancelled before it was drawn. The handler now leaves a request (under a lock) and the screen loop starts it on its own clock; the corner curve is also only changed from the screen loop now.

## 0.33.1 and board firmware 0.17.1 (2026-10-11)

- The glow preview's **Show on the device** puts the kind of glow picked there on the board for five seconds (the timer's countdown for ten), with the curve on the slider whether saved or not; it ran Find before. `POST /admin/clients/:id/glow` `{kind, corner}` sends the admin-only `command` `glow.show` `{kind, corner, ms}`; the board goes back to its saved curve afterwards. Find stays as the button beside the device's state.

## 0.33.0 and board firmware 0.17.0 (2026-10-11)

- **Find this device.** Boards offer a `find` action: three chimes over about five seconds and a quick white pulse round the screen's edges for eight, ahead of everything but a conversation. The admin page puts a **Find** button beside any device that offers it, on the Clients list and next to the device's state.
- **Blue glow while a question waits elsewhere** (firmware 0.17.0). Axis tells every screen how many questions wait for the person where it is not showing them (`server/src/asklight.ts`, the `command` `ask.waiting` with `elsewhere`): a question open on another device, or an OpenClaw agent's question or approval that is on no device (shown nowhere, or given up on by the device while the gateway still waits; `AgentAsks.unshown`). An idle board pulses its edges blue while there are any, ahead of a task's amber; under the **Notification light** setting. Sent only when a screen's number changes, and on connect.
- **Edge glow preview** on a device's admin page, for devices that offer `glowCorner`: the glow drawn the way the board draws it (glow.cpp ported: depth, curve, colours, paces, the timer's sweep), each kind on a button, a **Glow corner curve** slider that redraws live and saves for that device, and a dashed guide for where the glass hides the corners (kept in the browser only).
- Fixed: the protocol tests had no samples for `gesture`, `reply.image` and `image.*`, so two of them failed since 0.28.0/0.29.0.

## 0.32.0 and board firmware 0.16.0 (2026-10-11)

- **Agent tool calls on the Live page.** Every call of an Axis tool shows as it starts and ends: the tool, who made it (OpenClaw, `MCP: <token name>` or the admin page), what it was given and gave back (click the tool name), how long it took, and done or the reason it was refused (a switched-off tool included). Last 40 kept in memory; what was given and given back is deleted after ten minutes like a turn's words, and with **Clear now**. `InvokeHandler` takes an optional `via`; `Live.recordTools` wraps the guarded handler.
- **Timer countdown glow** (firmware 0.16.0). In a timer's last ten seconds, an idle board's edges glow red, lit clockwise from the top middle and shrinking as the seconds run out, beating once a second. It comes before the notification light. Board setting **Timer countdown glow** (`timerGlow`), on by default.
- Fixed: 0.31.0 raised the version in the top-level `package.json` only; `server/` and `protocol/` now carry the same number again.

## 0.31.0 (2026-10-11)

- **Try a tool** on the admin page's Agent tools page: every agent tool can be called from one form drawn from the tool's own parameters, with a **Send to** choice where the tool can reach more than one device (the device last spoken to, one device, a location, or every device when the tool takes `everywhere`), and the answer shown as the agent would get it. A Try button on each tool's row opens it. It goes through the same function and on/off switch as an agent's call (`POST /admin/mcp/tools/try`), so it acts for real; a reboot asks first. `GET /admin/mcp` now carries each tool's parameters.

## Board firmware 0.15.2 (2026-10-11)

- The glow's corner curve is wider (56 px) and a board setting, **Glow corner curve** (`glowCorner`), so it can be matched to the glass; at 32 px it sat inside the panel's rounded corners and was hidden there.
- Where the glow runs across the face, it now lands in the right place when the board is turned: the face's frame is sent in the panel's own orientation, and `glow::tint` was laying the glow into it as if it were turned, so the amber line showed down the face's side instead of along the top edge.

## Board firmware 0.15.1 (2026-10-11)

- The edge glow turns the corners on a curve (32 px) instead of two bands crossing in a square, so it follows the panel's rounded corners as one line.
- The notification light no longer breaks where the face meets the top edge (sideways, with a caption up): the glow is laid into the face's own frame there (`glow::tint`), so it runs on unbroken.

## Board firmware 0.15.0 (2026-10-11)

- **Notification light.** While a board is idle, its screen edges glow amber, breathing slowly, while a task waits for the person, and flash green for a moment when a task finishes (silent, so also in quiet hours). It never draws over the face and goes away during a conversation. Board setting **Notification light** turns it off. Built on the edge glow (`glow.cpp`), which now also lays itself over a black screen and leaves a given rectangle alone.

## 0.30.1 (2026-10-11), board firmware 0.14.1

- **Web client:** a picture from a reply shows on the main screen under the answer too, not only in the history; it goes when the next exchange starts. Tap for full size.
- **Boards:** a picture stays through the follow-up listening after the answer, and until 30 s after the speech ends; it closes on a tap, when you actually say something, on a question, or when the time is up. While it is up, listening, thinking and speaking show as a glow along the screen edges in the face's colours for each (`glow.cpp`), which anything full screen can use later.

## 0.30.0 (2026-10-11), board firmware 0.14.0

- **Pictures on boards.** A board shows a picture from an agent's reply full screen for 30 s; a tap, listening or a question closes it. Axis shrinks the picture to the board's screen as a JPEG (`fit.ts`, in a worker thread) and sends it over the board's socket (new capability `image-frames`, messages `image.start`, `image.data`, `image.end`), since a board cannot open a second encrypted connection. First server dependencies besides `ws`: `pngjs` 7.0.0 and `jpeg-js` 0.4.4, pinned. Board firmware uses JPEGDEC 1.8.4.

## 0.29.0 (2026-10-11)

- **Pictures in replies.** A picture an agent attaches to a reply (`MEDIA:` line) is fetched from the gateway and shown under the answer on clients with the new `images` capability (the web client, so phones and the Quest panel too); tap to open it full size. New server message `reply.image`. The `MEDIA:` line itself is no longer spoken or shown. Pictures are kept a day, in memory. A handed-over run's pictures come with its answer. Boards do not show pictures yet.

## 0.28.1 (2026-10-11)

- **A finished task leaves the screens again.** Since 0.27 the live activities look at the task list every few seconds; a look that found a finished task expired took it away without telling the screens, so boards and web clients kept showing it. Whoever finds a task gone now tells the screens.

## 0.28.0 (2026-10-11), board firmware 0.13.1

- **Boards as Home Assistant sensors.** A board reports how loud its room is (`soundDb`, dB of microphone full scale over 5 s, in 2 dB steps) and whether there has been sound well above the room's usual level in the last 15 s (`soundActive`), levels only and never audio, with its own speech left out; Axis shows them as a **Sound level** sensor and a **Sound** binary sensor (device class sound), unavailable while the board is offline. Board setting **Room sound to Axis** turns it off.
- Firmware 0.13.1: a reading that changes is sent on the next pass; before, any change in the first minute after a start held all readings back until the minute was up.
- **Touch gestures as events.** A hold or a swipe (left, right, up, down, as the screen shows it) on a board goes to Axis as a new client message `gesture` and on to Home Assistant as an event of the board's **Gesture** entity, for automations. Taps still talk and answer. Board setting **Gestures to Axis** turns it off.

## 0.27.4 (2026-10-11)

- **Live activities sooner on the phone.** Every change of state (needs you, done, back to work, a timer going off) now goes at full priority, with a sound; only a step within the same state goes quietly, at the low priority iOS may hold back. A timer's activity says "Done" the moment it is due, not once the device has finished announcing it.

## 0.27.3 (2026-10-11)

- **Back out 0.27.2.** The "needs you" notification is sent again while away even when a phone also shows the live activity: tapping the notification opens the installed web app, which tapping a live activity cannot (iOS opens it in the browser).

## 0.27.2 (2026-10-11)

- **No double "needs you".** When a task's "needs you" went to a phone as a live activity and Home Assistant says it passed that one on within 10 s, Axis no longer also sends its own notification for it (that was the one case where both sounded). Without that word, the notification goes as before.

## 0.27.1 (2026-10-11)

- **Send a test (live activities)** uses a new tag each time (iOS may not start an activity again on a tag just ended, and a second press no longer ends the first one's test early), and waits up to 5 s to say which phones Home Assistant passed it to, or that it did not.

## 0.27.0 (2026-10-11)

- **Live activities on phones.** Tasks and timers can show on the lock screen and in the Dynamic Island of a phone with the Home Assistant app (Live Updates on Android), through Home Assistant (`liveactivity.ts`). Axis only speaks MQTT to Home Assistant, so it publishes each activity on `vortex-axis/live` and a blueprint it serves (`/ha/vortex_axis_live_activities.yaml`, local network only, with an import link on the Integrations page) passes it to the chosen phone and acknowledges on `vortex-axis/live/ack`. Off by default; offered only while the Home Assistant link is connected, with a switch and a Send a test button on the Integrations page (`liveActivities`, or `AXIS_LIVE_ACTIVITIES`).
- What shows, with iOS's limits in mind: a task once it has run 30 s, or at once when it waits for the person ("needs you", the only update that sounds); a finished task quietly, until it leaves the screens; a timer of a minute or more as a countdown, "Done" with a sound when it goes off, gone a minute later or at once when cancelled. Updates to one activity are at least 10 s apart unless its state changes. Activities left by an Axis that restarted are ended. Tapping one opens the web client when Axis has a public name.

## 0.26.0 (2026-10-10)

- **Long agent work carries on without the device.** When the agent has said nothing new for 30 s (`AXIS_HANDOVER_MS`, 0 to switch off), the device says "On it, I'll tell you when it's done" and is free again. Axis keeps following the run (`background.ts`; the gateway follow limit is now 30 minutes instead of 120 s), shows it as a task on the screens (or the agent's own progress card, when it keeps one), and says the first few sentences of the answer where the person last was, or on a phone while away. A run that fails says so. Taking its task off the screens stops the run. Axis announces the answer even when the agent also spoke on its own during the run.
- **Turns while a conversation is busy.** OpenClaw answers one message at a time per conversation (a second one waits behind a running one; tested 2026-10-10). While the conversation turns would go to (Axis's own, or an attached one) has a run going, whether Axis handed it over or it came from elsewhere (the gateway's `hasActiveRun`), new turns go to `<sessionKey>-busy` instead, told on the device line what holds the usual one and to read, not message, that conversation if asked how it is going.
- The activity log marks turns that were handed over.

## 0.25.1 (2026-10-10)

- **Said on several devices, made once.** Something said everywhere or in one location is synthesized once per voice and the same audio is played on each device (`SpeechShare` in `speech.ts`), so devices in one room start together instead of one after another, and the speech service is not asked for the same sentence again for each device. Stopping one device does not cut the others off.
- **Voiceprints from the admin page wait longer.** A recording to teach or check a voice may wait up to 20 s for the service (a busy host once took over 5 s, and Axis gave up); a spoken turn still waits at most 3 s, so a slow service never holds up an answer.
- **Speech services:** a caller that hangs up before the answer is ready is one log line, not a traceback.

## 0.25.0 (2026-10-10)

- **Local speech in the stack.** `compose.yaml` now runs speech recognition (Parakeet), synthesis (Supertonic 3) and voiceprints (WeSpeaker) as three CPU containers from one new image, `speech/`, each behind OpenAI's audio API although none of the models has one. Each fetches its model on first start into `AXIS_MODELS_PATH`. Point `AXIS_STT_URL` and `AXIS_TTS_URL` (or the Speech page) at `vortex-axis-stt` and `vortex-axis-tts`, or anywhere else as before.
- **Voice recognition.** Off until switched on in the Speech page's new section. Taught voices are told from guests by voiceprint (known, guest or unsure, with two cut-offs); the agent sees whose voice it was on the device line; a guest's turn can be only labelled, sent to a guest conversation of the same agent or another agent, or turned away. Voices are taught by recording on the admin page or from turns heard in the last ten minutes. Only voiceprints are kept. The Live page and the recent turns show whose voice each turn was.
- **Wording:** the Speech page calls the recognition and voice "Custom STT/TTS".

## 0.24.0 (2026-10-10)

- **Attach the devices to another conversation.** A tenth tool, `vortex_axis_session`: "attach to internship hunt" points every device at that conversation of the agent's, so what is said next, on whichever device hears it, goes there; "detach" goes back to the usual voice conversation. It is one pointer for the whole hub, not one per device, because the devices are one way into one agent and any of them may pick up the wake word. It lets go by itself after half an hour with nothing said. The Live page shows it under Now, with a Detach button. The realtime voice follows it. An OpenClaw gateway must allow the new command `vortex.axis.session` beside the others.
- **A check of what Axis relies on in OpenClaw.** Each time the gateway link comes up, and on request, Axis asks the gateway what it offers (its methods and events), looks at the scopes it holds, and tries what can be tried without changing anything, for each of: turns, progress cards, questions, approvals, tool icons, realtime voice. The OpenClaw page lists how each stands; one that has stopped working is in the Overview's list of what needs attention and in the events, once when it breaks and once when it is back. Only what is switched on can be a problem.

## 0.23.1 (2026-10-10)

- A realtime voice is played at 70 % of how it arrives: it comes in louder than the local voice, and a board's small speaker buzzed with it. The setting `realtimeVolume` (10 to 100 %) changes that, for all devices or one.

## 0.23.0 (2026-10-10)

- **Realtime voice is a proper option now**, no longer a prototype. The Speech page has a **Realtime voice** section: one switch for what every device uses (Axis's own recognition and voice, or the realtime voice), the choice among the realtime voices the gateway offers, and **Try it**, which opens a session with the voice and closes it again to say whether it really works. A device can still be set differently on its own page.
- It is offered only while the agent is an OpenClaw gateway that Axis is connected to. Otherwise the section says so, and a device set to realtime is answered the usual way instead of failing.
- **The agent is asked to talk, not to write.** The note Axis adds for an OpenClaw agent, and the prompt it sends a plain chat endpoint, now ask for speech as a person speaks it: the answer first in a sentence or two, contractions, a small spoken touch where it fits, more offered instead of said, no opening praise or filler. The earlier wording ("short, plain sentences") was reaching the agent and got exactly that.

## 0.22.2 (2026-10-10)

- **Speech no longer races after a pause in it.** Axis sends a device no more sound than its buffer holds, by reckoning how much it has played. A gap in the sound was reckoned as room in the buffer, so whatever came after the gap went out all at once: more than a board could hold, and it dropped pieces, which sounded like the speech being wound forward. Now a device that has played everything simply has nothing in hand. This is in the part every voice goes through, though only a voice that arrives in fits and starts, like the realtime one, showed it.
- The 0.6 s head start of 0.22.1 is gone: the realtime voice is sent on as it comes.

## 0.22.1 (2026-10-10)

Still the realtime voice prototype of 0.22.0.

- **One turn in the chat, not two.** Work the voice model hands to the agent is now run by the gateway itself (`talk.client.toolCall`), which keeps it out of the conversation's visible turns. Before, Axis asked the agent with a message of its own, so the session showed what was said twice: once as the voice's transcript and once with Axis's bracketed line.
- **A head start of sound.** The model's voice arrives about as fast as it is spoken, and a board that started playing the first piece at once ran dry between pieces, heard as a buzz. Axis now has 0.6 s in hand before it sends a device any. Not yet confirmed on a board.

## 0.22.0 (2026-10-10)

Built as a prototype to try; kept, and made a proper option in 0.23.0.

- **Realtime voice as a second way to answer a spoken turn.** A device set to `voiceMode: realtime` has what it hears sent through the OpenClaw gateway's Talk relay to a realtime voice model, which answers in its own voice. Small things it answers itself; real work it hands to the agent, which Axis asks as it always does (same conversation, tool icons on the face) and whose answer the model then says. Off unless a device is set to it; `voiceProvider` picks the gateway's provider (`google`, or `openai/gpt-realtime-2.1-mini` for a model of one).
- Server only: no firmware and no protocol change. It is half-duplex: the device still decides when the person has stopped, and an interrupt stops the playback. Talking over the answer is not part of it.
- The sound leaves the house and the model is paid for by its provider's rates. Speech recognition and the voice of the `local` way stay where they are.
- Tried on the real gateway 2026-10-10 with a recorded question through a test client: with Google's provider, "what is two plus two" had its first words 2.5 s after the question ended (5.1 s the local way), and "are the lights on in my room" went to the agent, used Home Assistant and was answered by voice in about 10 s. OpenAI and xAI refused for want of credentials on that gateway. Not yet heard on a real device by anybody.

## 0.21.0 (2026-10-10)

- **The face shows when the agent's run is held up.** Two new looks while thinking: `compacting`, when the agent stops to tidy its memory (wound in tight, slow, deep blue), and `retrying`, when its provider failed and it is trying again (amber, turning backwards). A long silence for either reason no longer looks like a hang. When the run is under way again the face goes back to plain thinking, or to the icon of the tool in hand.
- With an OpenClaw gateway this comes from the run's own events (the `compaction` and `run_status` streams); nothing else reports it. It rides on `doing` of the `turn` message, which also gains `none` for "neither any more" (additive to protocol 1).
- The Face page shows both among the state looks. Board firmware 0.12.4 draws them.

## 0.20.1 (2026-10-10)

- Two more shared settings for tool icons, with sliders on the Face page: `toolIconMs`, how long the face takes to turn into an icon and back (150 to 3000 ms, 700 as before), and `toolIconDots`, how many of the 78 dots draw a dot shape (12 to 78). The dots left over stand off in a ring round the shape and go on turning. "Play it again" on the Face page takes the icons down and puts them up, to watch the change.
- Board firmware 0.12.3 follows both.

## 0.20.0 (2026-10-10)

- **Tool icons made of the face's own dots.** A third way to show what the agent has picked up: all 78 dots leave their arms and settle along the icon's strokes, in a colour of its kind, with a wave of light running along them, then swirl back into the vortex. No drawn lines; the same twelve shapes, each sampled into 78 points.
- **Three styles, chosen on the Face page:** dot shapes (the default now), the line icon at the core from 0.19, or off. It is the shared setting `toolIcons` (`dots`, `line`, `off`), so it can also be set per type or device like any other. The Face page draws all twelve kinds live in the style chosen, and any one large.
- Board firmware 0.12.2 draws the dot shapes and follows the setting.

## 0.19.1 (2026-10-10)

- Board firmware 0.12.1: the icon stands upright whichever way the screen is turned. The face is sent to the panel unturned, being round, and the icon went with it: on a board standing at 90 degrees it lay on its side.

- An agent's own housekeeping (looking up its tools, keeping its plan, loading a skill) no longer shows as an icon. On the first real turn the harness's tool lookup showed as a search.

## 0.19.0 (2026-10-10)

- **The face shows what the agent is doing.** While it thinks, an icon appears in the middle of the vortex for the kind of work the agent has just picked up: search, web, home, calendar, list, files, code, timer, message, memory, image, or a small cog for anything else. The arms stand back from the centre to make room and the icon takes the core's place and colour. Twelve icons, each a few strokes, defined once in `web/icons.js`; `scripts/gen-icons.mjs` writes the board's copy.
- With an OpenClaw gateway this needs nothing from the agent: Axis's operator link now declares `tool-events`, the gateway says which tools a turn picks up, and `server/src/doing.ts` reads the kind from the tool's name. Another agent backend shows the plain thinking face unless its reply stream names its tools.
- `turn` gains an optional `doing` with `thinking` (additive to protocol 1). The web client draws it; board firmware 0.12.0 draws it.

## 0.18.1 (2026-10-10)

- The scopes for questions and approvals are asked for when Axis is paired again with a setup code, and granted when that pairing is approved. 0.18.0 asked for them on a third link beside the two it has; the real gateway refuses that (a token for fewer scopes is refused when more are asked with it, and so is a connection with no credential), so the third link is gone. With either switch on and the scope missing, the Agent tools page says to pair again. If the gateway refuses the wider set after all, the operator link goes back to the scopes it had.

## 0.18.0 (2026-10-10)

- **An OpenClaw agent's questions reach you on a device.** When an agent on the linked gateway asks the person something (`question.requested`), Axis puts it to them the way its own ask tool does: spoken and shown on the device last used, with the choices to tap or say, and the answer goes back to the gateway (`question.resolve`). While Home Assistant's Away switch is on it goes to a phone as a notification. It can still be answered wherever else the gateway shows it; the first answer counts and Axis takes its own question back. Secrets and picks of several are never asked for on a device. A switch on the Agent tools page, on by default (`AXIS_MIRROR_QUESTIONS=0` to start with it off).
- **Approvals on a device.** When an agent waits for leave to run a command or use a tool (`exec.approval.requested`, `plugin.approval.requested`), a device with a screen shows what it is, silently, with Allow once and Deny. Only a tap allows; something heard can only refuse; a standing permission is never given from a device. A switch on the Agent tools page, off by default (`AXIS_MIRROR_APPROVALS=1` to start with it on).
- **The task line says what is being waited on.** A mirrored task whose session has a question or an approval open reads "needs you" with the question, or "approve: <command>", while the agent's turn is still running.
- Both need a scope the gateway has not given Axis before (`operator.questions`, `operator.approvals`). See 0.18.1 for how they are granted.
- `ask` inside Axis can be shown without being spoken and can be taken back.

## 0.17.0 (2026-10-10)

- **OpenClaw progress cards show by themselves.** An agent on the linked OpenClaw gateway keeps a list of steps for long work (its progress card). Axis now hears the gateway say a card changed (`progressCard.changed`), reads it (`progressCard.get`) and shows it as a task, with no tool call from the agent. The task is named after where the person talks to the agent (the channel or the session's label). It is done when every step is; with steps left and the agent's turn over it reads "needs you"; it goes back to running when the agent is at work again. Scheduled jobs are left out. A switch on the Agent tools page turns it off (`AXIS_MIRROR_CARDS=0` to start with it off). The progress tool is unchanged and is still how anything else reports: another harness, a script, a scheduled job.
- **Several tasks at once.** One that waits for the person always has the line; otherwise the one reported on last. The line counts the rest ("+2"), and the list a press or a tap opens names them above the steps. `progress.show` gains `others` (a line per other task, led by `!` when it waits for the person; additive to protocol 1).
- Tasks that finish within 30 seconds of each other chime once between them.
- A task whose reporter is known to be at work is not taken for abandoned after half an hour without a new word.
- Board firmware 0.11.9 shows the count and the other tasks.

## 0.16.1 (2026-10-10)

- Board firmware 0.11.8: a tap anywhere under the face lists a task's steps, not only a tap on its line, which was too small to hit. A tap on the face still starts listening.

- `vortex_axis_progress` reads `steps` that arrive as the text of a list. An agent whose harness had listed the tools before 0.16.0 sent them that way and was refused.

## 0.16.0 (2026-10-10)

- **Steps by name.** `vortex_axis_progress` takes `steps`: up to twelve short names, plain or each with how it stands (pending, in_progress, completed, as an agent's own plan has them). Axis remembers them, so later reports only say how far along.
- **A bar, and the steps on a press.** Screens draw a thin bar under the task's line. A press on the line in the web client, or a tap under the face on a board (on the line itself before firmware 0.11.8), lists the steps with the one in hand marked; on a board the list goes away after 20 seconds or on a tap. A tap anywhere else on a board still starts listening. With steps counted in the line, a board shows the words on what is happening under it.
- **A finish you can hear.** A task that finishes is marked with two soft notes, once, on each screen: the board's "Task chime" setting (on by default) and the web client unless it is muted. Never in quiet hours.
- **Your phone when you are away.** The hub has a new Home Assistant switch, **Away**. While an automation there keeps it on, a task that finishes or starts waiting for you is also sent as a notification to browsers that allowed them and are closed. Off, nothing goes to a phone.
- **Finished tasks are kept.** The Live page lists tasks that are over: how each ended (done, cleared, or no word for half an hour), how far it got and how long it took. They are kept as long as the rest of the activity (7 days unless changed), then dropped. A task under way is still in memory only.
- `progress.show` gains `steps` (one line per step, led by `x` done, `>` in hand, `-` to come) and `chime` (additive to protocol 1). Board firmware 0.11.7.

## 0.15.0 (2026-10-10)

- A ninth tool, `vortex_axis_progress`: an agent doing long work reports a title, what is happening, steps done of steps in all, and whether it is running, waiting for the person or done. Screens show it as one silent line ("Backup 3/5"); the admin page lists it under Now on the Live page, where it can be taken off. Kept in memory only; a finished task leaves after 90 seconds and one nobody reports on after 30 minutes.
- Clients with a screen are sent the `command` `progress.show` (additive to protocol 1; a client that shows nothing answers `ok: false`). The web client shows it; board firmware 0.11.6 shows it, taking turns with a timer.
- An OpenClaw gateway must allow the new command `vortex.axis.progress` beside the others.

## 0.14.2 (2026-10-10)

- A spoken turn records what made the device listen: the wake word, a tap, a press held down, listening on after an answer, or a question. The Overview's recent turns and the Live view show it ("spoken, tap"). Until now every such turn read just "spoken".
- Protocol 1 gains an optional `trigger` on `audio.start` (additive: an older device says nothing, and Axis then knows only whether there was a wake word). The web client sends it; board firmware 0.11.5 sends it.

## 0.14.1 (2026-10-09)

- The admin page says "protocol 1", not "device protocol 1".
- The README says what Axis is for: OpenClaw first, and any other agent harness through MCP and a chat address.
- Nothing in the repository names one installation any more: real host names, addresses, the public name and device names moved to `CLAUDE.local.md`, which is not committed, and the examples use made-up addresses.

## 0.14.0 (2026-10-09)

The first numbered release. The number and the commit of the build are shown at the foot of the admin page's sidebar, and the web client reports the number as its own.

- **Tools for any agent.** Axis is an MCP server (`POST /mcp`) offering the same eight tools as the OpenClaw node, from one list and one function. Agent tokens and a switch per tool are on the admin page under Agent tools.
- **Backup built in.** Axis copies its database, firmware and wake words to a mounted folder on a schedule, with settings, a Back up now button and warnings on the admin page. The host cron job and its script are gone.
- **Admin page.** Live view (each turn step by step, wake words, timers, questions, kept messages, Clear now); Activity folded into Overview; Integrations with editable hub settings; a Say something box; wake word scores per device; remembered sign-in; a phone layout with a menu drawer; switches drawn properly.
- **Web client.** History that marks announcements, notifications and questions (answered or not) and keeps them in the browser; volume and mute, notifications and history as small marks in the corner; forgetting a pairing takes two presses; the timer is a small chip; sound recovers on an iPhone; holding the face to talk survives a drifting finger.
- **Server.** Words held in memory for the admin page are deleted after ten minutes; a client that says it is not playing sound is no longer waited for; the chat endpoint's default system prompt knows about the tools.

## Earlier on 2026-10-09 (before numbering)

- Web client as an installable app with notifications (Web Push), questions answered from a notification, hold-to-talk, screen kept awake, a timer countdown with cancel.
- Messages kept for clients that are away; say on every device; quiet hours; every client as a Home Assistant device through MQTT.
- Web files loaded by stamped addresses, and a page that reloads itself when Axis has a newer one.
- Admin page in the web client's theme, a Face page, a sketch of each device, test buttons for a chat endpoint and a notification.
- A wake word ignored while another device speaks in the same location. Firmware 0.11.0 to 0.11.4: echo cancelling, more idle looks, encrypted connections taking memory from PSRAM.

## 2026-10-08

- Admin page redesign: sections, a page per device and per client type, fleet-first settings; activity log, uptime and charts.
- Agent commands ask, timer and admin; firmware updates over Wi-Fi; TLS for devices; protections for a public address; wake word models served by Axis; moving a device to another address; resetting a device.
- A system prompt for chat endpoints and a note for OpenClaw agents; "room" became "location".
- Speech synthesized a sentence ahead, one at a time; a crash on streamed replies fixed.
- Firmware for the Waveshare ESP32-S3 AMOLED board from first boot to 0.10.3: setup network, pairing, the vortex face, speaker, microphone, the on-device wake word, follow-up listening.

## 2026-10-07

- The client protocol (version 1 draft); the server: pairing, tokens, settings sync, the admin API, a Docker image.
- Voice and text turns: wake arbitration, recognition, the agent, sentence-by-sentence speech.
- The OpenClaw gateway link: device identity, the operator and node roles, pairing by setup code; commands named `vortex.axis.*`.
- The first admin page and web client; a headless browser check.
