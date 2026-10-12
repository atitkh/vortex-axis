# VorteX Axis desktop (experimental)

A Windows tray app that makes a computer an Axis client with the `desktop` capability, so an agent can see what is on the screen and point at things there (`vortex_axis_desktop`). It cannot click or type yet.

- `Axis.Desktop.Core/`: pairing, the socket (protocol 1), and the `desktop.*` commands, with no Windows APIs. `IDesktop` is what a platform supplies.
- `VortexDesktop/`: the WPF app: window, tray, Ctrl+Alt+S pause, the pointer overlay (`Overlay.xaml`), the screen reader (`ScreenReader.cs`: UI Automation, Windows OCR), the saved pairing (`%APPDATA%\VorteX Axis\desktop.json`, token encrypted with DPAPI).
- `Axis.Desktop.Smoke/`: a pretend computer that pairs with a running Axis and answers from a fake screen. Runs on any OS.

Build everything with Docker, nothing on the host:

```bash
scripts/build-desktop.sh     # from the repository root: publishes the .exe into Axis's data folder for the admin page
docker run --rm -v "$PWD/clients/windows-desktop":/src -w /src/Axis.Desktop.Smoke mcr.microsoft.com/dotnet/sdk:8.0 dotnet run -- 192.168.1.20:8440 123-456 20
```

The version is in `Directory.Build.props`, counted apart from Axis's and the boards'.
