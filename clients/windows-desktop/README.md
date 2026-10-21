# VorteX Axis desktop (experimental)

A Windows tray app that makes a computer an Axis client with the `desktop` capability, so an agent can see what is on the screen and point at things there (`vortex_axis_desktop`). It cannot click or type yet.

- `Axis.Desktop.Core/`: pairing, the socket (protocol 1), and the `desktop.*` commands, with no Windows APIs. `IDesktop` is what a platform supplies.
- `VortexDesktop/`: the WPF app: window, tray, Ctrl+Alt+S pause, the pointer overlay (`Overlay.xaml`), the screen reader (`ScreenReader.cs`: UI Automation, Windows OCR), the saved pairing (`%APPDATA%\VorteX Axis\desktop.json`, token encrypted with DPAPI).
- `Axis.Desktop.Smoke/`: a pretend computer that pairs with a running Axis and answers from a fake screen. Runs on any OS.

Build everything with Docker, nothing on the host:

```bash
scripts/build-desktop.sh     # from the repository root: publishes the .exe into Axis's data folder for the admin page
docker run --rm -v "$PWD/clients/windows-desktop":/src -w /src/Axis.Desktop.Smoke mcr.microsoft.com/dotnet/sdk:8.0 dotnet run -- 192.168.1.20:8440 123-456 20
docker run --rm -v "$PWD/clients/windows-desktop":/src -w /src/Axis.Desktop.Smoke mcr.microsoft.com/dotnet/sdk:8.0 dotnet run -- check   # the Core's checks, no Axis
```

The version is in `Directory.Build.props`, counted apart from Axis's and the boards'.

## Talking, typing, tasks, timers, sounds and pictures (0.11.0)

All of this needs "Talk from this computer" on (capabilities `mic`, `speaker`, `screen`, `images`); with it off the app is a `desktop` client only and none of it is offered.

- **Talk key**: held, it listens until let go. The microphone opens at key down and keeps what it hears; the key coming up before 220 ms (`TalkPress.TapMs`) makes it a tap, and that audio is dropped without anything being sent. A hold sends `audio.start` (trigger `hold`) with what was heard since key down (at most 50 frames, about 1 s). While Vortex thinks or speaks, the key stops it, as before.
- **Typing**: a tap on the talk key opens the typing pill, unless a separate "Typing key" is chosen in Settings (none by default); then the talk key behaves as in 0.10 (a press listens until a pause). Enter sends `{t:"text", turnId, text}` (1 to 4000 characters, trimmed) after `Voice.Interrupt()`, as `web/client.js` does; Shift+Enter is a new line, Esc cancels, Up in an empty field brings back the last message. A question waiting here shows in the pill with its choices; typed text answers it (Axis does that). The pill takes the keyboard, and on send or Esc gives the front back to the window that had it (`WindowsDesktop.GaveBack` keeps an agent's typing aimed at the right window). Clicking elsewhere closes it and leaves the front where the click put it.
- **Tasks and timers** (`progress.show`, `timer.next`, Core `Glance`): a pill under the "using this computer" pill. The timer counts down (red in its last 10 s) with × to cancel (`POST /v1/timers/cancel`, as the web). The task shows its title, `done/total` with a bar, "needs you" when blocked, "+N" for more tasks; a click lists the other tasks and the steps (8 rows at most, then a pointer to the admin Live page). A finished task leaves after 90 s, or at once with ×, which sends the boards' `swipe_down` gesture.
- **Sounds** (Core `Sounds`, made in code, no files): Axis's `chime` action (declared always; a small bell before a timer is announced), the task chime (when Axis marks `chime` on `progress.show`; setting `taskChime`), and the listening cue when a recording starts (setting `listenCue`). Never in quiet hours (`quietFrom`/`quietTo`, read on this computer's clock, normally the hub's time zone too). They play on the chosen speaker beside speech, not through it.
- **Pictures** (`reply.image`): shown in the voice pill under the reply, rounded, at most 360 by 240, fetched from Axis's `/v1/media/<id>`; the pill stays 12 s instead of 6.
- Every pill is left out of screen captures (`SetWindowDisplayAffinity`, `WDA_EXCLUDEFROMCAPTURE`), so neither an agent's look nor anyone's screenshot shows them.
