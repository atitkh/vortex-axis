using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Interop;
using Forms = System.Windows.Forms;

namespace Axis.Desktop.App;

/** One line in the window's "Recently" list. */
public sealed record Recent(string Time, string Text);

/**
 * The app: one instance, living in the tray. It keeps the pairing, holds the link to Axis, answers
 * Axis's desktop commands through the screen reader and the pointer, and lets the person pause it
 * all, from the window, the tray or Ctrl+Alt+S anywhere.
 */
public partial class App : System.Windows.Application
{
    public static string Version { get; } =
        Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0";

    const int HotkeyId = 0xA515, TalkKeyId = 0xA516, TypingKeyId = 0xA517;

    /** Talk keys to choose from: modifiers and the virtual key Windows knows it by. */
    public static readonly (string Id, string Label, uint Mods, int Vk)[] TalkKeys =
    [
        ("ctrl+alt+space", "Ctrl+Alt+Space", Native.MOD_CONTROL | Native.MOD_ALT, 0x20),
        ("ctrl+shift+space", "Ctrl+Shift+Space", Native.MOD_CONTROL | Native.MOD_SHIFT, 0x20),
        ("ctrl+alt+v", "Ctrl+Alt+V", Native.MOD_CONTROL | Native.MOD_ALT, 0x56),
        ("ctrl+alt+t", "Ctrl+Alt+T", Native.MOD_CONTROL | Native.MOD_ALT, 0x54),
        ("f9", "F9", 0, 0x78),
        ("pause", "Pause/Break", 0, 0x13),
    ];
    IntPtr hotkeyWindow;
    int talkVk = 0x20;
    Voice? voice;
    VoicePill? pill;
    // Tasks and timers Axis tells every client with a screen about, and the pill that shows them.
    readonly Glance glance = new();
    TaskPill? taskPill;
    TypingPill? typing;
    // The window that was in front when the typing pill opened, to give the front back to.
    IntPtr typingFrom;
    WindowsDesktop? desktop;
    ControlPill? controlPill;
    FaceWindow? faceWindow;
    readonly VoiceIo voiceIo = new();
    // The tray menu's switches; their ticks are brought up to date each time it opens.
    Forms.ToolStripMenuItem? voiceItem, faceItem, keepItem, controlItem, startItem, sizeMenu, placeMenu;
    Mutex? single;
    Saved saved = Saved.Load();
    AxisLink? link;
    DesktopCommands? commands;
    Overlay? overlay;
    Forms.NotifyIcon? tray;
    Forms.ToolStripMenuItem? pauseItem;
    MainWindow? window;
    double pointerSize = 44;
    /** What an admin switched off for this computer (the `capabilitiesOff` setting). Usually empty. */
    IReadOnlySet<string> capsOff = new HashSet<string>();
    bool ScreenOff => capsOff.Contains("screen");

    public ObservableCollection<Recent> Recently { get; } = new();
    public Saved Saved => saved;
    public LinkState State => link?.State ?? LinkState.Stopped;
    public string? StateWhy { get; private set; }
    public event Action? Changed;

    public static new App Current => (App)System.Windows.Application.Current;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        // A tray app that nobody is watching must not vanish over one failed call: it is logged and carries on.
        DispatcherUnhandledException += (_, args) =>
        {
            Diag.Log($"error on the window thread: {args.Exception}");
            Note($"⚠ {args.Exception.Message}");
            args.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, args) => Diag.Log($"unhandled: {args.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            Diag.Log($"a task failed unobserved: {args.Exception}");
            args.SetObserved();
        };
        // A monitor plugged or unplugged, or the resolution changed: the face goes back inside the screens.
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += (_, _) => Dispatcher.BeginInvoke(() => faceWindow?.Replace());
        // Sleep, unlock and the network coming back: the connection, the keys, the face and the pills are made good again.
        Microsoft.Win32.SystemEvents.PowerModeChanged += (_, args) =>
        {
            if (args.Mode == Microsoft.Win32.PowerModes.Suspend) Dispatcher.BeginInvoke(Sleeping);
            else if (args.Mode == Microsoft.Win32.PowerModes.Resume) Dispatcher.BeginInvoke(Woke);
        };
        Microsoft.Win32.SystemEvents.SessionSwitch += (_, args) =>
        {
            if (args.Reason is Microsoft.Win32.SessionSwitchReason.SessionUnlock or Microsoft.Win32.SessionSwitchReason.ConsoleConnect
                or Microsoft.Win32.SessionSwitchReason.RemoteConnect or Microsoft.Win32.SessionSwitchReason.SessionLogon)
                Dispatcher.BeginInvoke(Woke);
        };
        System.Net.NetworkInformation.NetworkChange.NetworkAvailabilityChanged += (_, args) =>
        {
            if (args.IsAvailable) link?.Nudge();
        };
        // A floor under the pool, so a few slow Windows calls cannot leave answers to Axis waiting for a thread.
        System.Threading.ThreadPool.GetMinThreads(out var workers, out var io);
        System.Threading.ThreadPool.SetMinThreads(Math.Max(workers, 32), Math.Max(io, 16));
        single = new Mutex(true, "VortexAxisDesktop.single", out var first);
        // Started by an update: the old app is on its way out, so wait for it rather than give up.
        if (!first && e.Args.Contains("--updated"))
        {
            try { first = single.WaitOne(TimeSpan.FromSeconds(20)); }
            catch (AbandonedMutexException) { first = true; }
        }
        if (!first)
        {
            Shutdown();
            return;
        }
        RemoveOldBuild();
        overlay = new Overlay();
        var reader = new ScreenReader();
        desktop = new WindowsDesktop(reader, overlay, () => pointerSize) { StepAside = () => { controlPill?.StepAside(); faceWindow?.StepAside(); } };
        commands = new DesktopCommands(desktop) { Paused = saved.Paused };
        commands.Did += line => Dispatcher.BeginInvoke(() =>
        {
            Note(line);
            controlPill?.Did(line);
        });
        controlPill = new ControlPill();
        // Stacked at the top: the "using this computer" pill, tasks and timers, then the voice or typing pill.
        taskPill = new TaskPill
        {
            Below = () => controlPill?.Room ?? 0,
            CancelTimer = id => _ = CancelTimerAsync(id),
            PutAway = () => _ = link?.TrySendAsync(new System.Text.Json.Nodes.JsonObject { ["t"] = "gesture", ["gesture"] = "swipe_down" }),
        };
        controlPill.Moved += taskPill.Replace;
        typing = new TypingPill { Below = () => (controlPill?.Room ?? 0) + (taskPill?.Room ?? 0) };
        typing.Send += SendTyped;
        typing.Cancel += giveBack => CloseTyping(giveBack);
        typing.Chose += choice =>
        {
            voice?.Answer(choice);
            CloseTyping(true);
        };
        glance.Changed += () =>
        {
            if (saved.Voice && !ScreenOff) taskPill.Show(glance);
            else taskPill.Dismiss();
        };
        glance.TaskChime += () => voice?.Play(SoundKind.TaskDone);
        faceWindow = new FaceWindow();
        faceWindow.Loudness = () => voice?.Loudness ?? -1;
        faceWindow.Clicked += () => { if (voice != null && !Paused && State == LinkState.Online) voice.Press(); };
        controlPill.Moved += ShowFace;
        faceWindow.Moved += (x, y) =>
        {
            saved.FacePlace = FaceWindow.Custom;
            (saved.FaceX, saved.FaceY) = (x, y);
            saved.Store();
            Changed?.Invoke();
        };
        faceWindow.Look(saved.FaceSize, saved.FacePlace, saved.FaceX, saved.FaceY);
        faceWindow.Keep(saved.KeepFace && saved.ShowFace);
        voiceIo.InputDevice = saved.MicDevice;
        voiceIo.OutputDevice = saved.SpeakerDevice;
        BuildTray();
        window = new MainWindow();
        // Started with Windows: straight to the tray. Otherwise the window shows.
        if (!e.Args.Contains("--tray") || saved.Pairing == null) window.Show();
        else window.EnsureHandle();
        RegisterHotkey();
        if (saved.Pairing is { } pairing) Connect(pairing);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        tray?.Dispose();
        // The socket closes with the process; nothing to wait for.
        _ = link?.StopAsync();
        base.OnExit(e);
    }

    public void Quit()
    {
        if (window != null) window.Quitting = true;
        Shutdown();
    }

    // --- pairing and the link ---------------------------------------------------------------

    public async Task PairAsync(string address, string code, string name)
    {
        var where = AxisAddress.Parse(address);
        var pairing = await AxisLink.PairAsync(where, where.Code ?? code, name, DesktopIdentity.Create(Version, saved.Voice));
        saved.Pairing = pairing;
        saved.Store();
        Connect(pairing);
        Note($"Paired with {where} as {pairing.Name}");
    }

    public async Task ForgetAsync()
    {
        if (link != null) await link.StopAsync();
        link = null;
        saved.Pairing = null;
        saved.Store();
        Changed?.Invoke();
    }

    void Connect(Pairing pairing)
    {
        link = new AxisLink(pairing, DesktopIdentity.Create(Version, saved.Voice))
        {
            AudioBufferMs = saved.Voice ? 8000 : 0,
            OnCommand = (name, p, ct) =>
            {
                if (name == "update") return UpdateAsync(pairing, p, ct);
                // The task line and the timer: shown in the task pill (Axis sends them only while talking is on: `screen`).
                if (name is "progress.show" or "timer.next")
                    return Dispatcher.InvokeAsync(() => { glance.Handle(name, p, Environment.TickCount64); return CommandAnswer.Done(); }).Task;
                // Axis's chime, before it says a timer has finished.
                if (name == "chime")
                    return Task.FromResult(voice == null ? CommandAnswer.Fail("talking from this computer is off")
                        : voice.Play(SoundKind.Chime) ? CommandAnswer.Done() : CommandAnswer.Fail("no sound now: quiet hours"));
                // An agent at this computer is shown for as long as it is (not the admin page's "Show the pointer").
                if (name.StartsWith("desktop.", StringComparison.Ordinal) && name != "desktop.hello" && !Paused && !capsOff.Contains("desktop") && saved.ShowControl)
                    Dispatcher.BeginInvoke(() => controlPill?.Touch());
                return commands!.HandleAsync(name, p, ct);
            },
        };
        link.Trouble += line => Dispatcher.BeginInvoke(() => Note("⚠ " + line));
        link.StateChanged += (state, why) => Dispatcher.BeginInvoke(() =>
        {
            StateWhy = why;
            if (state == LinkState.Refused) Note(why ?? "Axis refused this computer");
            // Axis tells tasks and timers again on the next connection; until then they may be out of date.
            if (state != LinkState.Online && state != LinkState.Connecting) glance.Clear();
            UpdateTray();
            Changed?.Invoke();
        });
        link.SettingsChanged += values => Dispatcher.BeginInvoke(() =>
        {
            commands!.UseSettings(values);
            faceWindow?.UseSettings(values);
            if (values.TryGetValue("pointerSize", out var size) && size.ValueKind == JsonValueKind.Number) pointerSize = size.GetDouble();
            voice?.Sounds.UseSettings(values);
            var off = DesktopCommands.CapabilitiesOff(values);
            if (off.Count > 0 || capsOff.Count > 0) UseCapabilitiesOff(off);
        });
        if (saved.Voice)
        {
            voice = new Voice(link, voiceIo);
            voice.UseCapabilitiesOff(capsOff);
            voice.Failed += why => Diag.Log($"voice: {why}");
            if (pill == null)
            {
                pill = new VoicePill { Below = () => (controlPill?.Room ?? 0) + (taskPill?.Room ?? 0), Chose = choice => voice?.Answer(choice) };
                if (controlPill != null) controlPill.Moved += () => pill.Replace();
                if (taskPill != null) taskPill.Moved += () => pill.Replace();
            }
            voice.Changed += () => Dispatcher.BeginInvoke(() =>
            {
                // While typing, the typing pill has the place; the voice pill comes back when it closes.
                if (voice != null && typing?.IsOpen != true && !ScreenOff) pill.Show(voice);
                ShowFace();
            });
        }
        else voice = null;
        link.Start();
    }

    DateTime lastWoke = DateTime.MinValue;

    /** The computer is going to sleep: nothing half-said, half-heard or half-typed goes with it. */
    void Sleeping()
    {
        if (typing?.IsOpen == true) CloseTyping(true);
        voice?.Interrupt();
    }

    /** The computer woke or was unlocked: whatever the sleep broke is set up again. On the UI thread. */
    void Woke()
    {
        // Resume and unlock arrive together: once is enough.
        if (DateTime.UtcNow - lastWoke < TimeSpan.FromSeconds(3)) return;
        lastWoke = DateTime.UtcNow;
        Note("Woke: reconnecting");
        link?.Nudge();
        // The talk key's registration can be lost over a sleep.
        RegisterShortcuts();
        // A moment on, when the screens are back, the face and pills are put in front again.
        _ = Task.Delay(1000).ContinueWith(_ => Dispatcher.BeginInvoke(() =>
        {
            faceWindow?.Refresh();
            ShowFace();
            pill?.Replace();
            taskPill?.Replace();
            typing?.Replace();
        }));
    }

    /** The face follows the voice part and whether an agent is at this computer. On the UI thread. */
    void ShowFace()
    {
        if (faceWindow == null) return;
        if (!saved.ShowFace || Paused || ScreenOff) { faceWindow.Set(VoiceMode.Idle, -1, null, false); return; }
        faceWindow.Set(voice?.Mode ?? VoiceMode.Idle, voice?.Level ?? -1, voice?.Doing, controlPill?.Active ?? false);
    }

    /**
     * An admin switched part of this computer off on the Axis admin page, or on again. Each part off is that part of
     * talking off: `mic` no talk key, `speaker` nothing played, `screen` no face and no pills (nor typing, whose answer
     * would show nowhere). `desktop` off refuses every desktop command (`DesktopCommands`). On the UI thread.
     */
    void UseCapabilitiesOff(IReadOnlySet<string> off)
    {
        capsOff = off;
        voice?.UseCapabilitiesOff(off);
        if (ScreenOff)
        {
            if (typing?.IsOpen == true) CloseTyping(true);
            pill?.Dismiss();
            taskPill?.Dismiss();
        }
        else
        {
            if (voice != null && typing?.IsOpen != true) pill?.Show(voice);
            if (saved.Voice) taskPill?.Show(glance);
        }
        ShowFace();
        Note(off.Count > 0 ? $"Switched off on the Axis admin page: {string.Join(", ", off)}" : "Everything switched on again on the Axis admin page");
    }

    /** Talking from this computer on or off: the hub hears of it on the next connection, so it reconnects now. */
    public async Task SetVoiceAsync(bool on)
    {
        saved.Voice = on;
        saved.Store();
        if (voiceItem != null) voiceItem.Checked = on;
        if (typing?.IsOpen == true) CloseTyping(true);
        voice?.Interrupt();
        voice = null;
        pill?.Dismiss();
        glance.Clear();
        if (link != null && saved.Pairing is { } pairing)
        {
            await link.StopAsync();
            Connect(pairing);
        }
        Note(on ? $"Talking from this computer: on ({TalkKeyLabel})" : "Talking from this computer: off");
    }

    // --- updating -----------------------------------------------------------------------------

    /**
     * Axis's `update`: downloads the newer build next to this one and checks it, swaps the files (Windows lets a
     * running program be renamed, not overwritten), answers, then starts the new one and quits. The new one waits
     * for this one to go, and deletes the old file.
     */
    async Task<CommandAnswer> UpdateAsync(Pairing pairing, JsonElement p, CancellationToken ct)
    {
        try
        {
            var offer = AppUpdate.Read(p);
            var exe = Environment.ProcessPath ?? throw new InvalidOperationException("this app does not know where it is");
            if (!exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("only the published app updates itself");
            await Dispatcher.InvokeAsync(() => Note($"Downloading version {offer.Version}"));
            var fresh = exe + ".new";
            await AppUpdate.DownloadAsync(pairing, offer, fresh, ct);
            var old = exe + ".old";
            if (System.IO.File.Exists(old)) System.IO.File.Delete(old);
            System.IO.File.Move(exe, old);
            try { System.IO.File.Move(fresh, exe); }
            catch
            {
                System.IO.File.Move(old, exe);
                throw;
            }
            await Dispatcher.InvokeAsync(() => Note($"Updated to {offer.Version}; restarting"));
            _ = Dispatcher.InvokeAsync(async () =>
            {
                await Task.Delay(1500);
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exe, "--tray --updated") { UseShellExecute = false });
                Quit();
            });
            return CommandAnswer.Done(new System.Text.Json.Nodes.JsonObject { ["version"] = offer.Version });
        }
        catch (Exception e)
        {
            await Dispatcher.InvokeAsync(() => Note($"⚠ Update failed: {e.Message}"));
            return CommandAnswer.Fail($"update failed: {e.Message}");
        }
    }

    /** The build an update replaced: in use until that app quit, so deleted on the next start. */
    static void RemoveOldBuild()
    {
        try
        {
            if (Environment.ProcessPath is { } exe && System.IO.File.Exists(exe + ".old")) System.IO.File.Delete(exe + ".old");
        }
        catch { /* still held by the old app for a moment: next start */ }
    }

    // --- pausing ------------------------------------------------------------------------------

    public bool Paused => commands?.Paused ?? false;

    public void SetPaused(bool paused)
    {
        if (commands == null) return;
        commands.Paused = paused;
        saved.Paused = paused;
        saved.Store();
        if (paused) overlay?.HideNow();
        Note(paused ? "Paused: agents can't see or point" : "Resumed");
        UpdateTray();
        Changed?.Invoke();
    }

    public void ShowPointer()
    {
        var area = Forms.Screen.PrimaryScreen!.Bounds;
        overlay?.PointAt(area.X + area.Width / 2, area.Y + area.Height / 2, "Hi, I'm here", 4, pointerSize);
    }

    void Note(string text)
    {
        Recently.Insert(0, new Recent(DateTime.Now.ToString("HH:mm:ss"), text));
        while (Recently.Count > 30) Recently.RemoveAt(Recently.Count - 1);
        Changed?.Invoke();
    }

    // --- tray and hotkey ------------------------------------------------------------------------

    void BuildTray()
    {
        var icon = GetResourceStream(new Uri("pack://application:,,,/app.ico"))!.Stream;
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open", null, (_, _) => OpenWindow());
        pauseItem = new Forms.ToolStripMenuItem("Pause", null, (_, _) => SetPaused(!Paused));
        menu.Items.Add(pauseItem);
        menu.Items.Add("Show the pointer", null, (_, _) => ShowPointer());
        menu.Items.Add(new Forms.ToolStripSeparator());

        // The everyday switches, so they do not need the window. Ticks are brought up to date as the menu opens.
        voiceItem = new Forms.ToolStripMenuItem("Talk from this computer", null, async (_, _) =>
        {
            try { await SetVoiceAsync(!saved.Voice); }
            catch (Exception error) { Note($"⚠ {error.Message}"); }
        });
        faceItem = new Forms.ToolStripMenuItem("Show Vortex's face", null, (_, _) => SetFace(!saved.ShowFace, saved.KeepFace, "", ""));
        keepItem = new Forms.ToolStripMenuItem("Keep the face on screen", null, (_, _) => SetFace(saved.ShowFace, !saved.KeepFace, "", ""));
        sizeMenu = new Forms.ToolStripMenuItem("Face size");
        foreach (var (id, label, _) in FaceWindow.Sizes)
            sizeMenu.DropDownItems.Add(new Forms.ToolStripMenuItem(label, null, (_, _) => SetFace(saved.ShowFace, saved.KeepFace, id, "")) { Tag = id });
        placeMenu = new Forms.ToolStripMenuItem("Face position");
        foreach (var (id, label) in FaceWindow.Places)
            placeMenu.DropDownItems.Add(new Forms.ToolStripMenuItem(label, null, (_, _) => SetFace(saved.ShowFace, saved.KeepFace, "", id)) { Tag = id });
        placeMenu.DropDownItems.Add(new Forms.ToolStripSeparator());
        placeMenu.DropDownItems.Add(new Forms.ToolStripMenuItem("Right-click and drag the face to put it anywhere") { Enabled = false });
        controlItem = new Forms.ToolStripMenuItem("Show when an agent is using this computer", null, (_, _) => SetShowControl(!saved.ShowControl));
        startItem = new Forms.ToolStripMenuItem("Start with Windows", null, (_, _) => SetStartWithWindows(!Saved.StartWithWindows));
        menu.Items.AddRange([voiceItem, faceItem, keepItem, sizeMenu, placeMenu, controlItem, startItem]);
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Settings…", null, (_, _) => { OpenWindow(); window?.ShowSettings(); });
        menu.Items.Add("Quit", null, (_, _) => Quit());
        menu.Opening += (_, _) => RefreshMenu();
        tray = new Forms.NotifyIcon { Icon = new System.Drawing.Icon(icon), Text = "VorteX Axis", ContextMenuStrip = menu, Visible = true };
        tray.MouseClick += (_, e) => { if (e.Button == Forms.MouseButtons.Left) OpenWindow(); };
        UpdateTray();
    }

    /** The menu's ticks and what is on offer, from what is saved. */
    void RefreshMenu()
    {
        if (voiceItem == null) return;
        voiceItem.Checked = saved.Voice;
        faceItem!.Checked = saved.ShowFace;
        keepItem!.Checked = saved.KeepFace;
        controlItem!.Checked = saved.ShowControl;
        try { startItem!.Checked = Saved.StartWithWindows; }
        catch { startItem!.Checked = false; }
        // What the face does only matters when it is shown.
        keepItem.Enabled = saved.ShowFace;
        foreach (Forms.ToolStripItem item in sizeMenu!.DropDownItems)
            if (item is Forms.ToolStripMenuItem m) m.Checked = (string?)m.Tag == saved.FaceSize;
        foreach (Forms.ToolStripItem item in placeMenu!.DropDownItems)
        {
            if (item is not Forms.ToolStripMenuItem { Tag: string id } m) continue;
            // "Where you put it" is offered once there is somewhere put.
            m.Visible = id != FaceWindow.Custom || saved.FaceX != null;
            m.Checked = id == saved.FacePlace;
        }
    }

    void UpdateTray()
    {
        if (tray == null) return;
        if (pauseItem != null) pauseItem.Text = Paused ? "Resume" : "Pause";
        var state = Paused ? "paused" : State switch
        {
            LinkState.Online => "connected",
            LinkState.Connecting => "connecting",
            LinkState.Refused => "pair again",
            LinkState.Stopped => "not paired",
            _ => "offline",
        };
        tray.Text = $"VorteX Axis: {state}";
    }

    /**
     * After the talk key: still down after a moment makes it a hold, which ends when the key comes up. `armed` (a tap
     * types): the microphone is already on; up before TalkPress.TapMs is a tap, which drops it and opens the typing pill.
     */
    void WatchTalkKey(bool armed)
    {
        var pressed = Environment.TickCount64;
        var held = false;
        var watch = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(30) };
        watch.Tick += (_, _) =>
        {
            var now = Environment.TickCount64;
            var down = (Native.GetAsyncKeyState(talkVk) & 0x8000) != 0;
            if (down)
            {
                if (!held && now - pressed >= (armed ? TalkPress.TapMs : 350))
                {
                    held = true;
                    if (armed) voice?.Commit();
                    else voice?.Hold();
                }
                return;
            }
            watch.Stop();
            if (held) voice?.Release();
            else if (armed && voice?.Disarm() == true) OpenTyping();
        };
        watch.Start();
    }

    // --- typing to the agent --------------------------------------------------------------------

    /** A tap on the talk key (or the typing key): the typing pill, in the voice pill's place. Again while open: closes it. */
    void OpenTyping()
    {
        if (typing == null) return;
        if (typing.IsOpen) { CloseTyping(true); return; }
        if (voice == null) { Note("Typing to Vortex needs \"Talk from this computer\" on (Settings)"); return; }
        if (ScreenOff) { Note("Typing needs the screen, which is switched off for this computer on the Axis admin page"); return; }
        if (Paused || State != LinkState.Online) return;
        typingFrom = Native.GetForegroundWindow();
        pill?.Away();
        typing.Open(voice.Question, voice.Choices);
    }

    void SendTyped(string text)
    {
        var v = voice;
        if (v == null || State != LinkState.Online)
        {
            Note("⚠ Not connected to Axis; what you typed was not sent");
            CloseTyping(true);
            return;
        }
        // Sent first, so the voice pill that takes the place back already says it is thinking.
        v.Type(text);
        CloseTyping(true);
    }

    /** Closes the typing pill; `giveBack`: the window that was in front before it is in front again. */
    void CloseTyping(bool giveBack)
    {
        typing?.Shut(giveBack ? GiveBackFront : null);
        typingFrom = giveBack ? IntPtr.Zero : typingFrom;
        if (voice != null && !ScreenOff) pill?.Show(voice);
    }

    void GiveBackFront()
    {
        var to = typingFrom;
        if (to == IntPtr.Zero || !Native.IsWindow(to) || typing == null) return;
        Native.SetForegroundWindow(to);
        // An agent that acted while the pill had the keyboard would otherwise type into the pill's place.
        desktop?.GaveBack(typing.Handle, to);
    }

    /** × on the timer: as the web client's cancel button. Axis then sends the next timer, or none, to every screen. */
    async Task CancelTimerAsync(long id)
    {
        if (link == null) return;
        var ok = await link.PostAsync("/v1/timers/cancel", new System.Text.Json.Nodes.JsonObject { ["id"] = id });
        if (!ok) Note("⚠ The timer could not be cancelled");
    }

    public void OpenWindow()
    {
        if (window == null) return;
        window.Show();
        if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
        window.Activate();
    }

    /** Registers the chosen talk key in place of the one before. */
    void ApplyTalkKey()
    {
        if (hotkeyWindow == IntPtr.Zero) return;
        Native.UnregisterHotKey(hotkeyWindow, TalkKeyId);
        var key = TalkKeys.FirstOrDefault(k => k.Id == saved.TalkKey);
        if (key.Label == null) key = TalkKeys[0];
        talkVk = key.Vk;
        if (!Native.RegisterHotKey(hotkeyWindow, TalkKeyId, key.Mods | Native.MOD_NOREPEAT, (uint)key.Vk))
            Note($"⚠ {key.Label} is taken by another app; pick another talk key in Settings");
        TalkKeyLabel = key.Label;
    }

    /** The talk key as people read it. */
    public static string TalkKeyLabel { get; private set; } = "Ctrl+Alt+Space";

    /** Typing keys to choose from: none (a tap on the talk key types), or one of the talk keys' list. */
    public static IEnumerable<(string Id, string Label)> TypingKeys =>
        new[] { ("", "None: a tap on the talk key") }.Concat(TalkKeys.Select(k => (k.Id, k.Label)));

    /** Registers the typing key, if one is chosen and it is not the talk key. */
    void ApplyTypingKey()
    {
        if (hotkeyWindow == IntPtr.Zero) return;
        Native.UnregisterHotKey(hotkeyWindow, TypingKeyId);
        var key = TalkKeys.FirstOrDefault(k => k.Id == saved.TypingKey);
        if (key.Label == null || key.Id == (TalkKeys.Any(k => k.Id == saved.TalkKey) ? saved.TalkKey : TalkKeys[0].Id))
        {
            TypingKeyLabel = null;
            return;
        }
        if (!Native.RegisterHotKey(hotkeyWindow, TypingKeyId, key.Mods | Native.MOD_NOREPEAT, (uint)key.Vk))
        {
            Note($"⚠ {key.Label} is taken by another app; pick another typing key in Settings");
            TypingKeyLabel = null;
            return;
        }
        TypingKeyLabel = key.Label;
    }

    /** The typing key as people read it; null when a tap on the talk key types. */
    public static string? TypingKeyLabel { get; private set; }

    /** A tap on the talk key types, unless a typing key of its own is chosen. */
    bool TapTypes => TypingKeyLabel == null;

    public void SetTypingKey(string id)
    {
        saved.TypingKey = id;
        saved.Store();
        ApplyTypingKey();
        Note(TypingKeyLabel != null ? $"Typing key: {TypingKeyLabel}" : $"Typing: a tap on {TalkKeyLabel}");
    }

    public void SetTalkKey(string id)
    {
        saved.TalkKey = id;
        saved.Store();
        ApplyTalkKey();
        // The typing key may have been the same key.
        ApplyTypingKey();
        Note($"Talk key: {TalkKeyLabel}");
    }

    public void SetDevices(int mic, int speaker)
    {
        saved.MicDevice = mic;
        saved.SpeakerDevice = speaker;
        saved.Store();
        voiceIo.InputDevice = mic;
        voiceIo.OutputDevice = speaker;
    }

    public void SetFace(bool show, bool keep, string size, string place)
    {
        saved.ShowFace = show;
        saved.KeepFace = keep;
        if (size.Length > 0) saved.FaceSize = size;
        if (place.Length > 0) saved.FacePlace = place;
        saved.Store();
        faceWindow?.Look(saved.FaceSize, saved.FacePlace, saved.FaceX, saved.FaceY);
        faceWindow?.Keep(saved.KeepFace && saved.ShowFace);
        ShowFace();
        Changed?.Invoke();
    }

    public void SetShowControl(bool on)
    {
        saved.ShowControl = on;
        saved.Store();
        Changed?.Invoke();
    }

    public void SetStartWithWindows(bool on)
    {
        try { Saved.StartWithWindows = on; }
        catch (Exception e) { Note($"⚠ Could not change starting with Windows: {e.Message}"); }
        Changed?.Invoke();
    }

    /** The pause key and the talk and typing keys, registered (again: after a sleep). */
    void RegisterShortcuts()
    {
        if (hotkeyWindow == IntPtr.Zero) return;
        // Ctrl+Alt+S: pause or resume, from anywhere.
        Native.UnregisterHotKey(hotkeyWindow, HotkeyId);
        Native.RegisterHotKey(hotkeyWindow, HotkeyId, Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_NOREPEAT, 0x53);
        // The talk key (Settings; Ctrl+Alt+Space unless changed). A press listens until a pause; held, it listens until let go; while the
        // agent thinks or speaks, it stops it.
        ApplyTalkKey();
        ApplyTypingKey();
    }

    void RegisterHotkey()
    {
        var hwnd = new WindowInteropHelper(window!).EnsureHandle();
        hotkeyWindow = hwnd;
        RegisterShortcuts();
        HwndSource.FromHwnd(hwnd)!.AddHook((IntPtr h, int msg, IntPtr w, IntPtr l, ref bool handled) =>
        {
            if (msg == Native.WM_HOTKEY && w.ToInt32() == TalkKeyId)
            {
                handled = true;
                if (voice == null || Paused || State != LinkState.Online) return IntPtr.Zero;
                // The talk key while typing: the typing is put away, and the key does what it always does.
                if (typing?.IsOpen == true) CloseTyping(true);
                // With no typing key, a tap types and a hold talks; the microphone opens at once either way.
                if (TapTypes) { if (voice.Arm()) WatchTalkKey(armed: true); }
                else
                {
                    voice.Press();
                    WatchTalkKey(armed: false);
                }
                return IntPtr.Zero;
            }
            if (msg == Native.WM_HOTKEY && w.ToInt32() == TypingKeyId)
            {
                handled = true;
                OpenTyping();
                return IntPtr.Zero;
            }
            if (msg == Native.WM_HOTKEY && w.ToInt32() == HotkeyId)
            {
                SetPaused(!Paused);
                tray?.ShowBalloonTip(1500, "VorteX Axis", Paused ? "Paused" : "Resumed", Forms.ToolTipIcon.None);
                handled = true;
            }
            return IntPtr.Zero;
        });
    }
}

/** The computer as DesktopCommands sees it: the screen reader, and the pointer drawn on the UI thread. */
sealed class WindowsDesktop : IDesktop
{
    readonly ScreenReader reader;
    readonly Overlay overlay;
    readonly Func<double> size;

    /**
     * The window the agent last opened, switched to or acted in. Typing and keys go there: if something
     * else has taken the front since (a chat window grabbing focus, a slow app opening), it is brought
     * back first, and nothing is typed when it cannot be. Forgotten after IntendedFor.
     */
    IntPtr intended;
    DateTime intendedAt;
    static readonly TimeSpan IntendedFor = TimeSpan.FromSeconds(90);
    /** Longest an app gets to show its window after open. */
    const int OpenPatienceMs = 8000;
    /** How long an open waits for a new window when the app it started already has the one in front. */
    const int SameAppMs = 1500;

    public WindowsDesktop(ScreenReader reader, Overlay overlay, Func<double> size) => (this.reader, this.overlay, this.size) = (reader, overlay, size);

    /** Whatever else of the app's own is on screen and must not be in a capture (the "using this computer" pill). */
    public Action? StepAside { get; set; }

    /** Before the pixels are read: the app's own pointer and pill out of the picture. */
    void HideOwn()
    {
        overlay.HideNow();
        StepAside?.Invoke();
    }

    public (int X, int Y) Centre
    {
        get
        {
            var area = Forms.Screen.PrimaryScreen!.Bounds;
            return (area.X + area.Width / 2, area.Y + area.Height / 2);
        }
    }

    void Intend(IntPtr hwnd)
    {
        intended = hwnd;
        intendedAt = DateTime.UtcNow;
    }

    void IntendFront() => Intend(Native.GetForegroundWindow());

    /**
     * The typing pill gave the front back to `front`. Had an agent acted while the pill had the keyboard, it took the
     * pill for its window; it works in `front` again.
     */
    public void GaveBack(IntPtr pill, IntPtr front)
    {
        if (intended == pill) Intend(front);
    }

    /**
     * Before typing or keys: makes sure the window the agent is working in is in front (a dialog it owns
     * counts as it), bringing it back if needed. Throws, so nothing is typed, when it cannot.
     */
    async Task EnsureFrontAsync(CancellationToken ct)
    {
        var want = intended;
        if (want == IntPtr.Zero || DateTime.UtcNow - intendedAt > IntendedFor || !Native.IsWindow(want)) return;
        var front = Native.GetForegroundWindow();
        if (Windows.SameOrOwned(front, want)) return;
        await Uia.Run(() => Windows.Focus(want), 3000, "bringing the window forward", ct);
        front = Native.GetForegroundWindow();
        if (!Windows.SameOrOwned(front, want))
            throw new InvalidOperationException($"\"{Native.Title(want)}\" could not be brought back to the front (\"{Native.Title(front)}\" is there); nothing was typed");
    }

    public Task<LookResult> LookAsync(string scope, OcrMode ocr, CancellationToken ct) =>
        reader.LookAsync(scope, ocr, () => overlay.Dispatcher.InvokeAsync(HideOwn).Task, ct);

    public Task<ScreenState> StateAsync(CancellationToken ct) => reader.StateAsync(ct);

    public Task PointAsync(int x, int y, string? text, double seconds, CancellationToken ct) =>
        overlay.Dispatcher.InvokeAsync(() => overlay.PointAt(x, y, text, seconds, size())).Task;

    public Task HideAsync() => overlay.Dispatcher.InvokeAsync(overlay.HideAsync).Task.Unwrap();

    /**
     * Shows the pointer where it is about to act, and gives it time to get there so the person can follow: its
     * glide and a moment more, or a short moment when it appears on the spot (0.9.0 waited 450 ms every time).
     */
    async Task ShowAt(int x, int y, string words, CancellationToken ct, double seconds = 3)
    {
        var glides = await overlay.Dispatcher.InvokeAsync(() => overlay.PointAt(x, y, words, seconds, size()));
        await Task.Delay(glides ? (int)Overlay.GlideMs + 30 : 100, ct);
    }

    /**
     * The pointer on a window's title bar: where a person looks for "this one". Nothing waits for it: it only
     * says which window an open, switch or window command left in front, after the fact.
     */
    Task ShowOnWindow(WindowInfo w, string words, CancellationToken ct) =>
        overlay.Dispatcher.InvokeAsync(() => overlay.PointAt(w.X + w.W / 2, w.Y + Math.Min(60, Math.Max(w.H / 2, 1)), words, 3, size())).Task;

    public async Task<(string How, int X, int Y)> ClickAsync(ScreenElement? target, int x, int y, ClickKind kind, CancellationToken ct)
    {
        var e = target?.Ref as AutomationElement;
        var words = kind == ClickKind.Right ? "Right-click" : kind == ClickKind.Double ? "Double-click" : "Click";
        // Where the control shows now, not where the look saw it: the page may have scrolled, or it sits half under its top.
        Spot? at = null;
        if (e != null)
        {
            at = await Uia.Run(() => ScreenReader.Where(e), 3000, "finding the control", ct);
            if (at.Visible is { } v) (x, y) = v.Centre;
        }
        await ShowAt(x, y, words, ct);
        try
        {
            if (kind == ClickKind.Left && e != null)
            {
                // A control that can be pressed directly is, and the mouse stays where it is.
                try
                {
                    if (await Uia.Run(() => Press(e), 3000, "pressing the control", ct)) return ("invoked", x, y);
                }
                // A press that opens a dialog may not come back until it closes; it has happened by then.
                catch (TimeoutException) { return ("invoked", x, y); }
                // A field is given the focus directly, as for typing: the mouse could land on whatever covers it.
                if (target!.Kind is "edit" or "combobox" && await Uia.Run(() => Focus(e), 3000, "focusing the field", ct)) return ("focused", x, y);
            }
            if (e != null && at != null && !Geometry.Enough(at.Full, at.Visible))
            {
                // Too little of it shows to click it surely: scrolled into view and read again, else refused.
                var before = at;
                at = await Uia.Run(() => ScrollIntoView(e) ? ScreenReader.Where(e) : before, 3000, "scrolling it into view", ct);
                if (!Geometry.Enough(at.Full, at.Visible))
                    throw new InvalidOperationException($"only {(int)(Geometry.Fraction(at.Full, at.Visible) * 100)}% of \"{target!.Name}\" shows (the rest is past the edge of the page or window) and it could not be scrolled into view; scroll until it shows, look again, then click");
                (x, y) = at.Visible!.Value.Centre;
                await ShowAt(x, y, words, ct);
            }
            // The last guard: a click meant for the page never lands on the browser's own bar.
            if (Geometry.ChromeRefusal(ScreenReader.Foreground(), y, at?.InPage == true, at?.Page) is string why) throw new InvalidOperationException(why);
            await Uia.Run(() => Input.Click(x, y, kind), 3000, "clicking", ct);
            return ("mouse", x, y);
        }
        finally
        {
            await Task.Delay(150, ct);
            IntendFront();
        }
    }

    /** How long a drag's move takes, after any hold. */
    const int DragMoveMs = 400;

    public async Task<string> DragAsync(ScreenElement? from, int x1, int y1, ScreenElement? to, int x2, int y2, int holdMs, CancellationToken ct)
    {
        await ShowAt(x1, y1, "Drag", ct);
        try
        {
            // The pointer glides to the drop as the mouse moves there.
            var moving = Uia.Run(() => Input.Drag(x1, y1, x2, y2, holdMs, DragMoveMs), 3000 + holdMs + DragMoveMs, "dragging", ct);
            await Task.Delay(Math.Max(80, holdMs), ct);
            _ = overlay.Dispatcher.InvokeAsync(() => overlay.PointAt(x2, y2, "Drop", 3, size()));
            await moving;
            return "mouse";
        }
        finally
        {
            await Task.Delay(150, ct);
            IntendFront();
        }
    }

    /** Presses a control through UI Automation, if it offers a way to. False when it does not. */
    static bool Press(AutomationElement e)
    {
        try
        {
            if (e.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke)) { ((InvokePattern)invoke).Invoke(); return true; }
            if (e.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle)) { ((TogglePattern)toggle).Toggle(); return true; }
            if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var select)) { ((SelectionItemPattern)select).Select(); return true; }
            if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expand))
            {
                var p = (ExpandCollapsePattern)expand;
                if (p.Current.ExpandCollapseState == ExpandCollapseState.Expanded) p.Collapse(); else p.Expand();
                return true;
            }
        }
        catch (Exception) { }
        return false;
    }

    /** Gives a field the focus through UI Automation. False when it cannot take it, or did not. */
    static bool Focus(AutomationElement e)
    {
        try
        {
            if (!e.Current.IsKeyboardFocusable) return false;
            e.SetFocus();
            return e.Current.HasKeyboardFocus;
        }
        catch (Exception) { return false; }
    }

    /** Asks a control to scroll itself into view, and gives the page a moment to settle. False when it offers no way to. */
    static bool ScrollIntoView(AutomationElement e)
    {
        try
        {
            if (!e.TryGetCurrentPattern(ScrollItemPattern.Pattern, out var item)) return false;
            ((ScrollItemPattern)item).ScrollIntoView();
            Thread.Sleep(200);
            return true;
        }
        catch (Exception) { return false; }
    }

    public Task<ScreenElement?> RefreshAsync(ScreenElement e, CancellationToken ct) =>
        e.Ref is not AutomationElement a ? Task.FromResult<ScreenElement?>(null) : Uia.Run<ScreenElement?>(() =>
        {
            try
            {
                if (a.Current.IsOffscreen) return null;
                return ScreenReader.Where(a).Visible is { } shown ? Geometry.Shown(e, shown) : null;
            }
            // Gone from the window, or no longer anywhere on the screen.
            catch (Exception ex) when (ex is ElementNotAvailableException or InvalidOperationException) { return null; }
        }, 3000, "reading the control again", ct);

    public async Task TypeAsync(ScreenElement? target, string text, CancellationToken ct)
    {
        var (x, y) = await PrepareInputAsync(target, ct);
        await ShowAt(x, y, $"Typing \"{(text.Length > 24 ? text[..23] + "…" : text)}\"", ct, 3 + text.Length / 60.0);
        // Checked again right before the keys go: the pointer's moment is long enough for focus to wander.
        if (target == null) await EnsureFrontAsync(ct);
        await Uia.Run(() => Input.Type(text), 30000, "typing", ct);
        IntendFront();
    }

    /**
     * Before typing or pasting: the window the agent works in in front (when no field is named), the named
     * field focused, and never a password field. Returns where to show the pointer.
     */
    async Task<(int X, int Y)> PrepareInputAsync(ScreenElement? target, CancellationToken ct)
    {
        if (target == null) await EnsureFrontAsync(ct);
        var (x, y) = target != null ? (target.X + target.W / 2, target.Y + target.H / 2) : WindowMiddle();
        await Uia.Run(() =>
        {
            // Never into a password field: the one named, or whatever has the focus.
            if (target?.Ref is AutomationElement e)
            {
                if (e.Current.IsPassword) throw new InvalidOperationException("the app never types into a password field");
                try { e.SetFocus(); } catch (Exception) { }
            }
            var focused = AutomationElement.FocusedElement;
            if (focused?.Current.IsPassword == true) throw new InvalidOperationException("the field with the focus is a password field; the app never types there");
            if (target == null && focused != null)
            {
                var box = focused.Current.BoundingRectangle;
                if (!box.IsEmpty && !double.IsInfinity(box.Width) && box.Width > 0)
                    (x, y) = ((int)(box.X + Math.Min(box.Width / 2, 120)), (int)(box.Y + Math.Min(box.Height / 2, 40)));
            }
        }, 3000, "finding where to type", ct);
        return (x, y);
    }

    (int X, int Y) WindowMiddle()
    {
        var w = ScreenReader.Foreground();
        return w == null ? Centre : (w.X + w.W / 2, w.Y + w.H / 2);
    }

    public async Task<(string Opened, WindowInfo? Window)> OpenAsync(string? app, string? url, CancellationToken ct)
    {
        var before = Windows.List().Select(w => w.Handle).ToHashSet();
        var front = Native.GetForegroundWindow();
        string name;
        if (url != null)
        {
            await Uia.Run(() => Windows.Browse(url), 8000, "opening the address", ct);
            name = url;
        }
        else name = await Uia.Run(() => Windows.Launch(app!), 8000, "starting the app", ct);
        // Waits for what was opened to show, then makes sure it is in front, so the next step types into it
        // and not into whatever had the focus before.
        var opened = await WaitForWindowAsync(before, front, url != null ? null : name, ct);
        if (opened == null) return (name, null);
        if (Native.GetForegroundWindow() != opened.Handle)
            await Uia.Run(() => Windows.Focus(opened.Handle), 3000, "bringing the window forward", ct);
        Intend(opened.Handle);
        var info = Windows.Info(opened.Handle, opened.Title, opened.App);
        await ShowOnWindow(info, $"Opened {(name.Length > 30 ? name[..29] + "…" : name)}", ct);
        return (name, info);
    }

    /**
     * The window an open produced: a new window, else (apps that reuse theirs, a browser opening a tab) the
     * window in front once it changed, else an open window matching the app's name. Null if nothing showed.
     * Returns as soon as one is seen (a listed window has a title already; 0.9.0 waited 250 ms more for it to
     * settle). An app whose window was in front already and stays the only one is taken after SameAppMs instead
     * of the whole OpenPatienceMs.
     */
    static async Task<Windows.Open?> WaitForWindowAsync(HashSet<IntPtr> before, IntPtr front, string? app, CancellationToken ct)
    {
        var started = DateTime.UtcNow;
        var until = started.AddMilliseconds(OpenPatienceMs);
        while (DateTime.UtcNow < until)
        {
            await Task.Delay(100, ct);
            var now = Windows.List();
            var fresh = now.FirstOrDefault(w => !before.Contains(w.Handle));
            if (fresh != null) return fresh;
            var f = Native.GetForegroundWindow();
            if (now.FirstOrDefault(w => w.Handle == f) is not { } inFront) continue;
            if (f != front) return inFront;
            if (app != null && DateTime.UtcNow - started > TimeSpan.FromMilliseconds(SameAppMs)
                && Math.Max(Fuzzy.Score(inFront.App, app), Fuzzy.Score(inFront.Title, app)) > 0) return inFront;
        }
        if (app == null) return null;
        try { return Windows.Find(app); } catch (InvalidOperationException) { return null; }
    }

    public async Task<WindowInfo> SwitchAsync(string window, CancellationToken ct)
    {
        var info = await Uia.Run(() =>
        {
            var w = Windows.Find(window);
            Windows.Focus(w.Handle);
            Intend(w.Handle);
            return Windows.Info(w.Handle, w.Title, w.App);
        }, 4000, "switching windows", ct);
        await ShowOnWindow(info, $"Switched to {info.App}", ct);
        return info;
    }

    public async Task<WindowInfo> WindowAsync(string op, string? window, int? display, CancellationToken ct)
    {
        var info = await Uia.Run(() =>
        {
            var w = window != null ? Windows.Find(window) : Windows.Front();
            Windows.Do(w.Handle, op, display);
            if (op == "minimize") { if (intended == w.Handle) intended = IntPtr.Zero; }
            else Intend(w.Handle);
            return Windows.Info(w.Handle, w.Title, w.App);
        }, 4000, "arranging the window", ct);
        if (op != "minimize") await ShowOnWindow(info, op == "move" ? $"Moved to display {display}" : char.ToUpper(op[0]) + op[1..], ct);
        return info;
    }

    // Ctrl+Win+Right and Left: Windows' own keys for the next and previous virtual desktop.
    public async Task DesktopAsync(bool next, CancellationToken ct)
    {
        await Uia.Run(() => Input.Press(new KeyCombo(true, false, false, true, next ? "right" : "left")), 3000, "changing desktop", ct);
        intended = IntPtr.Zero;
    }

    public async Task<Shot> ScreenshotAsync(string scope, ScreenElement? region, int maxSide, CancellationToken ct)
    {
        // Never a picture of a password being typed: checked first, and refused when it cannot be checked.
        bool password;
        try { password = await Uia.Run(() => AutomationElement.FocusedElement?.Current.IsPassword == true, 1500, "checking for a password field", ct); }
        catch (TimeoutException) { throw new InvalidOperationException("could not check whether a password field has the focus, so no picture was taken"); }
        if (password) throw new InvalidOperationException("a password field has the focus; the app never takes a picture then");

        var desktopArea = Forms.SystemInformation.VirtualScreen;
        var window = ScreenReader.Foreground();
        System.Drawing.Rectangle area;
        if (region != null)
        {
            // The element and a margin around it, so its label and neighbours show.
            var pad = Math.Max(24, Math.Min(region.W, region.H) / 2);
            area = System.Drawing.Rectangle.Inflate(new System.Drawing.Rectangle(region.X, region.Y, region.W, region.H), pad, pad);
        }
        else if (scope == "screen" || window == null) area = desktopArea;
        else area = new System.Drawing.Rectangle(window.X, window.Y, window.W, window.H);
        area = System.Drawing.Rectangle.Intersect(area, desktopArea);
        if (area.Width < 8 || area.Height < 8) throw new InvalidOperationException("there is nothing on screen there to take a picture of");

        // The pointer steps out of the picture, and the screen gets a frame to repaint without it.
        var hidden = overlay.Dispatcher.InvokeAsync(HideOwn).Task;
        await Task.WhenAny(hidden, Task.Delay(500, ct));
        await Task.Delay(60, ct);
        return await Task.Run(() => Capture(area, maxSide, window), ct);
    }

    static Shot Capture(System.Drawing.Rectangle area, int maxSide, WindowInfo? window)
    {
        using var full = new System.Drawing.Bitmap(area.Width, area.Height, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
        using (var g = System.Drawing.Graphics.FromImage(full)) g.CopyFromScreen(area.Location, System.Drawing.Point.Empty, area.Size);
        var scale = Math.Min(1.0, (double)maxSide / Math.Max(area.Width, area.Height));
        var (w, h) = (Math.Max(1, (int)Math.Round(area.Width * scale)), Math.Max(1, (int)Math.Round(area.Height * scale)));
        using var small = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
        using (var g = System.Drawing.Graphics.FromImage(small))
        {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            g.DrawImage(full, 0, 0, w, h);
        }
        var jpeg = System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == System.Drawing.Imaging.ImageFormat.Jpeg.Guid);
        using var quality = new System.Drawing.Imaging.EncoderParameters(1);
        quality.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 72L);
        using var bytes = new System.IO.MemoryStream();
        small.Save(bytes, jpeg, quality);
        return new Shot(bytes.ToArray(), w, h, area.X, area.Y, area.Width, area.Height, window);
    }

    public async Task<string> ScrollAsync(ScreenElement? target, string go, int pages, CancellationToken ct)
    {
        if (target == null) await EnsureFrontAsync(ct);
        var (x, y) = target != null ? (target.X + target.W / 2, target.Y + target.H / 2) : WindowMiddle();
        await ShowAt(x, y, $"Scroll {go}", ct, 2);
        // The control itself first (no mouse involved): the target, or what holds it, if it can scroll.
        if (target?.Ref is AutomationElement e)
        {
            try
            {
                if (await Uia.Run(() => ScrollByPattern(e, go, pages), 3000, "scrolling", ct)) return "scrolled";
            }
            catch (TimeoutException) { }
        }
        var sideways = go is "left" or "right";
        var notches = go is "top" or "bottom" ? 200 : pages * 5;
        if (go is "up" or "left" or "top") notches = -notches;
        await Uia.Run(() => Input.Wheel(x, y, notches, sideways), 8000, "scrolling", ct);
        return "wheel";
    }

    static bool ScrollByPattern(AutomationElement start, string go, int pages)
    {
        var e = start;
        for (var i = 0; i < 6 && e != null && e != AutomationElement.RootElement; i++, e = TreeWalker.ControlViewWalker.GetParent(e))
        {
            if (!e.TryGetCurrentPattern(ScrollPattern.Pattern, out var found)) continue;
            var scroll = (ScrollPattern)found;
            var sideways = go is "left" or "right";
            if (sideways ? !scroll.Current.HorizontallyScrollable : !scroll.Current.VerticallyScrollable) continue;
            switch (go)
            {
                case "top": scroll.SetScrollPercent(ScrollPattern.NoScroll, 0); break;
                case "bottom": scroll.SetScrollPercent(ScrollPattern.NoScroll, 100); break;
                default:
                    var amount = go is "up" or "left" ? ScrollAmount.LargeDecrement : ScrollAmount.LargeIncrement;
                    for (var n = 0; n < pages; n++)
                    {
                        if (sideways) scroll.ScrollHorizontal(amount); else scroll.ScrollVertical(amount);
                    }
                    break;
            }
            return true;
        }
        return false;
    }

    public Task<WindowInfo?> FindWindowAsync(string query, CancellationToken ct) =>
        Uia.Run<WindowInfo?>(() =>
        {
            try
            {
                var w = Windows.Find(query);
                return Windows.Info(w.Handle, w.Title, w.App);
            }
            catch (InvalidOperationException) { return null; }
        }, 3000, "listing windows", ct);

    /** Formats password managers put on what they copy, asking others not to keep or read it. */
    static readonly string[] PrivateFormats = ["ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore"];

    public Task<(string? Text, string? Why)> ReadClipboardAsync(CancellationToken ct) =>
        Uia.Run<(string?, string?)>(() =>
        {
            var data = Retry(() => Forms.Clipboard.GetDataObject());
            if (data == null) return (null, "the clipboard is empty");
            if (PrivateFormats.Any(f => data.GetDataPresent(f))) return (null, "what is on the clipboard is marked private (a password manager put it there); not read");
            var text = data.GetData(Forms.DataFormats.UnicodeText) as string ?? data.GetData(Forms.DataFormats.Text) as string;
            if (string.IsNullOrEmpty(text))
                return (null, data.GetDataPresent(Forms.DataFormats.Bitmap) ? "the clipboard holds a picture, not text" : data.GetDataPresent(Forms.DataFormats.FileDrop) ? "the clipboard holds files, not text" : "the clipboard has no text");
            return (text, null);
        }, 3000, "reading the clipboard", ct, ApartmentState.STA);

    public async Task PasteAsync(ScreenElement? target, string text, CancellationToken ct)
    {
        var (x, y) = await PrepareInputAsync(target, ct);
        await ShowAt(x, y, $"Pasting {text.Length} characters", ct);
        if (target == null) await EnsureFrontAsync(ct);
        // What the person had copied is kept, and put back once the paste has landed.
        var saved = await Uia.Run(() =>
        {
            var before = Retry(() => Forms.Clipboard.GetDataObject());
            var copy = new Forms.DataObject();
            var any = false;
            if (before != null)
                foreach (var format in before.GetFormats(false))
                {
                    try
                    {
                        if (before.GetData(format, false) is { } value) { copy.SetData(format, false, value); any = true; }
                    }
                    catch { /* a format that will not hand itself over is left out */ }
                }
            var mine = new Forms.DataObject();
            mine.SetData(Forms.DataFormats.UnicodeText, false, text);
            // Kept out of Windows' clipboard history.
            mine.SetData("ExcludeClipboardContentFromMonitorProcessing", false, new System.IO.MemoryStream(new byte[4]));
            // Copied in (true): the thread doing this ends, and the clipboard must not depend on it.
            Retry(() => { Forms.Clipboard.SetDataObject(mine, true); return true; });
            return any ? copy : null;
        }, 3000, "using the clipboard", ct, ApartmentState.STA);
        await Uia.Run(() => Input.Press(KeyCombo.Parse("ctrl+v")), 3000, "pasting", ct);
        await Task.Delay(400, ct);
        await Uia.Run(() =>
        {
            if (saved != null) Retry(() => { Forms.Clipboard.SetDataObject(saved, true); return true; });
            else Retry(() => { Forms.Clipboard.Clear(); return true; });
        }, 3000, "putting the clipboard back", ct, ApartmentState.STA);
        IntendFront();
    }

    /** The clipboard is shared, and another app may hold it for a moment. */
    static T Retry<T>(Func<T> work)
    {
        for (var i = 0; ; i++)
        {
            try { return work(); }
            catch (System.Runtime.InteropServices.ExternalException) when (i < 5) { Thread.Sleep(60); }
        }
    }

    public async Task KeysAsync(KeyCombo combo, CancellationToken ct)
    {
        await EnsureFrontAsync(ct);
        var (x, y) = WindowMiddle();
        await ShowAt(x, y, combo.ToString(), ct);
        await Uia.Run(() => Input.Press(combo), 3000, "pressing keys", ct);
        // Keys may move to another window on purpose (alt+tab, ctrl+n): wherever they land is where the agent is now.
        await Task.Delay(150, ct);
        IntendFront();
    }
}
