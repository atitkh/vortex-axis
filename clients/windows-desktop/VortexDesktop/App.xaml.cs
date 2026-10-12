using System;
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

    const int HotkeyId = 0xA515;
    Mutex? single;
    Saved saved = Saved.Load();
    AxisLink? link;
    DesktopCommands? commands;
    Overlay? overlay;
    Forms.NotifyIcon? tray;
    Forms.ToolStripMenuItem? pauseItem;
    MainWindow? window;
    double pointerSize = 44;

    public ObservableCollection<Recent> Recently { get; } = new();
    public Saved Saved => saved;
    public LinkState State => link?.State ?? LinkState.Stopped;
    public string? StateWhy { get; private set; }
    public event Action? Changed;

    public static new App Current => (App)System.Windows.Application.Current;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        single = new Mutex(true, "VortexAxisDesktop.single", out var first);
        if (!first)
        {
            Shutdown();
            return;
        }
        overlay = new Overlay();
        var reader = new ScreenReader();
        commands = new DesktopCommands(new WindowsDesktop(reader, overlay, () => pointerSize)) { Paused = saved.Paused };
        commands.Did += line => Dispatcher.BeginInvoke(() => Note(line));
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
        var pairing = await AxisLink.PairAsync(where, where.Code ?? code, name, DesktopIdentity.Create(Version));
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
        link = new AxisLink(pairing, DesktopIdentity.Create(Version)) { OnCommand = commands!.HandleAsync };
        link.StateChanged += (state, why) => Dispatcher.BeginInvoke(() =>
        {
            StateWhy = why;
            if (state == LinkState.Refused) Note(why ?? "Axis refused this computer");
            UpdateTray();
            Changed?.Invoke();
        });
        link.SettingsChanged += values => Dispatcher.BeginInvoke(() =>
        {
            commands!.UseSettings(values);
            if (values.TryGetValue("pointerSize", out var size) && size.ValueKind == JsonValueKind.Number) pointerSize = size.GetDouble();
        });
        link.Start();
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
        Recently.Insert(0, new Recent(DateTime.Now.ToString("HH:mm"), text));
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
        menu.Items.Add("Quit", null, (_, _) => Quit());
        tray = new Forms.NotifyIcon { Icon = new System.Drawing.Icon(icon), Text = "VorteX Axis", ContextMenuStrip = menu, Visible = true };
        tray.MouseClick += (_, e) => { if (e.Button == Forms.MouseButtons.Left) OpenWindow(); };
        UpdateTray();
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

    public void OpenWindow()
    {
        if (window == null) return;
        window.Show();
        if (window.WindowState == WindowState.Minimized) window.WindowState = WindowState.Normal;
        window.Activate();
    }

    void RegisterHotkey()
    {
        var hwnd = new WindowInteropHelper(window!).EnsureHandle();
        // Ctrl+Alt+S: pause or resume, from anywhere.
        Native.RegisterHotKey(hwnd, HotkeyId, Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_NOREPEAT, 0x53);
        HwndSource.FromHwnd(hwnd)!.AddHook((IntPtr h, int msg, IntPtr w, IntPtr l, ref bool handled) =>
        {
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

    public WindowsDesktop(ScreenReader reader, Overlay overlay, Func<double> size) => (this.reader, this.overlay, this.size) = (reader, overlay, size);

    public (int X, int Y) Centre
    {
        get
        {
            var area = Forms.Screen.PrimaryScreen!.Bounds;
            return (area.X + area.Width / 2, area.Y + area.Height / 2);
        }
    }

    public Task<LookResult> LookAsync(string scope, OcrMode ocr, CancellationToken ct) =>
        reader.LookAsync(scope, ocr, () => overlay.Dispatcher.InvokeAsync(overlay.HideNow).Task, ct);

    public Task PointAsync(int x, int y, string? text, double seconds, CancellationToken ct) =>
        overlay.Dispatcher.InvokeAsync(() => overlay.PointAt(x, y, text, seconds, size())).Task;

    public Task HideAsync() => overlay.Dispatcher.InvokeAsync(overlay.HideAsync).Task.Unwrap();

    /** Shows the pointer where it is about to act, and gives it a moment to get there. */
    async Task ShowAt(int x, int y, string words, CancellationToken ct)
    {
        await overlay.Dispatcher.InvokeAsync(() => overlay.PointAt(x, y, words, 3, size()));
        await Task.Delay(350, ct);
    }

    public async Task<string> ClickAsync(ScreenElement? target, int x, int y, ClickKind kind, CancellationToken ct)
    {
        await ShowAt(x, y, kind == ClickKind.Right ? "Right-click" : kind == ClickKind.Double ? "Double-click" : "Click", ct);
        // A control that can be pressed directly is, and the mouse stays where it is.
        if (kind == ClickKind.Left && target?.Ref is AutomationElement e)
        {
            var pressed = Task.Run(() => Press(e), ct);
            // A press that opens a dialog may not come back until it closes; it has happened by then.
            if (await Task.WhenAny(pressed, Task.Delay(3000, ct)) != pressed || pressed.Result) return "invoked";
        }
        await Task.Run(() => Input.Click(x, y, kind), ct);
        return "mouse";
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

    public async Task TypeAsync(ScreenElement? target, string text, CancellationToken ct)
    {
        var (x, y) = target != null ? (target.X + target.W / 2, target.Y + target.H / 2) : Centre;
        await Task.Run(() =>
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
                if (!box.IsEmpty && !double.IsInfinity(box.Width)) (x, y) = ((int)(box.X + box.Width / 2), (int)(box.Y + box.Height / 2));
            }
        }, ct);
        await ShowAt(x, y, "Typing", ct);
        await Task.Run(() => Input.Type(text), ct);
    }

    public async Task<string> OpenAsync(string? app, string? url, CancellationToken ct)
    {
        if (url != null)
        {
            await Task.Run(() => Windows.Browse(url), ct);
            return url;
        }
        return await Task.Run(() => Windows.Launch(app!), ct);
    }

    public async Task<WindowInfo> SwitchAsync(string window, CancellationToken ct) =>
        await Task.Run(() =>
        {
            var w = Windows.Find(window);
            Windows.Focus(w.Handle);
            return Windows.Info(w.Handle, w.Title, w.App);
        }, ct);

    public async Task<WindowInfo> WindowAsync(string op, string? window, int? display, CancellationToken ct) =>
        await Task.Run(() =>
        {
            var w = window != null ? Windows.Find(window) : Windows.Front();
            Windows.Do(w.Handle, op, display);
            return Windows.Info(w.Handle, w.Title, w.App);
        }, ct);

    // Ctrl+Win+Right and Left: Windows' own keys for the next and previous virtual desktop.
    public Task DesktopAsync(bool next, CancellationToken ct) =>
        Task.Run(() => Input.Press(new KeyCombo(true, false, false, true, next ? "right" : "left")), ct);

    public async Task KeysAsync(KeyCombo combo, CancellationToken ct)
    {
        Native.GetCursorPos(out var at);
        await ShowAt(at.X, at.Y, combo.ToString(), ct);
        await Task.Run(() => Input.Press(combo), ct);
    }
}
