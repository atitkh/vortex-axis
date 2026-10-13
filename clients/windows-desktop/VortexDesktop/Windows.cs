using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Axis.Desktop.App;

/**
 * The windows that are open and the apps in the Start menu: finding one by name, bringing it to the front,
 * minimizing, maximizing, moving it to another display, and starting an app. Only Start-menu apps are
 * started (by their shell:AppsFolder entry) and only http(s) addresses opened, never a path or a command.
 */
static class Windows
{
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    const int SW_MINIMIZE = 6, SW_MAXIMIZE = 3, SW_RESTORE = 9;
    const uint GW_OWNER = 4;

    public sealed record Open(IntPtr Handle, string Title, string App);

    /** Windows a person would call open: visible, titled, not owned by another, not hidden by the shell, not this app's. */
    public static List<Open> List()
    {
        var own = Environment.ProcessId;
        var found = new List<Open>();
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd) || GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
            if ((Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE) & Native.WS_EX_TOOLWINDOW) != 0) return true;
            if (DwmGetWindowAttribute(hwnd, 14, out var cloaked, sizeof(int)) == 0 && cloaked != 0) return true;  // DWMWA_CLOAKED
            var length = GetWindowTextLength(hwnd);
            if (length == 0) return true;
            var title = new StringBuilder(length + 1);
            GetWindowText(hwnd, title, title.Capacity);
            Native.GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == own) return true;
            string app = "";
            try { app = Process.GetProcessById((int)pid).ProcessName; } catch { }
            found.Add(new Open(hwnd, title.ToString(), app));
            return true;
        }, IntPtr.Zero);
        return found;
    }

    /** The open window best matching `query` by app name or title. EnumWindows lists front to back, so ties go to the one nearest the front. */
    public static Open Find(string query)
    {
        var all = List();
        var best = all
            .Select((w, i) => (w, i, score: Math.Max(Fuzzy.Score(w.App, query) + 5, Fuzzy.Score(w.Title, query))))
            .Where(t => t.score > 5)
            .OrderByDescending(t => t.score).ThenBy(t => t.i)
            .FirstOrDefault();
        if (best.w == null)
            throw new InvalidOperationException($"no open window matches \"{query}\" (open: {string.Join(", ", all.Take(8).Select(w => w.App).Distinct())})");
        return best.w;
    }

    public static WindowInfo Info(IntPtr hwnd, string title, string app)
    {
        Native.GetWindowRect(hwnd, out var r);
        return new WindowInfo(title, app, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    public static Open Front()
    {
        var hwnd = Native.GetForegroundWindow();
        var w = List().FirstOrDefault(o => o.Handle == hwnd);
        return w ?? throw new InvalidOperationException("no window is in front");
    }

    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    const uint GA_ROOTOWNER = 3;

    /** True when `front` is `want`, or a dialog or popup `want` owns (a Save As box counts as its window). */
    public static bool SameOrOwned(IntPtr front, IntPtr want)
    {
        if (front == IntPtr.Zero) return false;
        if (front == want) return true;
        var owner = GetAncestor(front, GA_ROOTOWNER);
        if (owner == want) return true;
        for (var w = GetWindow(front, GW_OWNER); w != IntPtr.Zero; w = GetWindow(w, GW_OWNER))
            if (w == want) return true;
        return false;
    }

    /** Brings a window to the front. Windows lets a background app do that only just after a key press, so one is made (Alt, alone). */
    public static void Focus(IntPtr hwnd)
    {
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        if (Native.GetForegroundWindow() == hwnd) return;
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        SetForegroundWindow(hwnd);
        BringWindowToTop(hwnd);
        Thread.Sleep(120);
    }

    public static void Do(IntPtr hwnd, string op, int? display)
    {
        switch (op)
        {
            case "minimize": ShowWindow(hwnd, SW_MINIMIZE); break;
            case "maximize": ShowWindow(hwnd, SW_MAXIMIZE); break;
            case "restore": ShowWindow(hwnd, SW_RESTORE); break;
            case "move":
            {
                var screens = System.Windows.Forms.Screen.AllScreens;
                if (display is not int n || n < 1 || n > screens.Length) throw new InvalidOperationException($"display must be 1 to {screens.Length}");
                var to = screens[n - 1].WorkingArea;
                var wasMax = IsZoomed(hwnd);
                if (wasMax || IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
                Native.GetWindowRect(hwnd, out var r);
                var (w, h) = (Math.Min(r.Right - r.Left, to.Width), Math.Min(r.Bottom - r.Top, to.Height));
                Native.SetWindowPos(hwnd, IntPtr.Zero, to.X + (to.Width - w) / 2, to.Y + (to.Height - h) / 2, w, h, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
                if (wasMax) ShowWindow(hwnd, SW_MAXIMIZE);
                break;
            }
        }
        Thread.Sleep(120);
    }

    /** Start-menu apps by name, with the id that starts each (shell:AppsFolder). Read once and kept a few minutes. */
    static (DateTime At, List<(string Name, string Id)> Apps) apps = (DateTime.MinValue, new());

    static List<(string Name, string Id)> Apps()
    {
        if (DateTime.UtcNow - apps.At < TimeSpan.FromMinutes(5) && apps.Apps.Count > 0) return apps.Apps;
        var list = new List<(string, string)>();
        var shellType = Type.GetTypeFromProgID("Shell.Application") ?? throw new InvalidOperationException("the Windows shell is not available");
        dynamic shell = Activator.CreateInstance(shellType)!;
        try
        {
            dynamic folder = shell.NameSpace("shell:AppsFolder");
            foreach (dynamic item in folder.Items())
            {
                string name = item.Name;
                string id = item.Path;
                if (!string.IsNullOrWhiteSpace(name) && !string.IsNullOrWhiteSpace(id)) list.Add((name, id));
            }
        }
        finally { Marshal.FinalReleaseComObject(shell); }
        apps = (DateTime.UtcNow, list);
        return list;
    }

    /** Starts the Start-menu app best matching `query`. Returns its name. */
    public static string Launch(string query)
    {
        var all = Apps();
        var best = all.Select(a => (a, score: Fuzzy.Score(a.Name, query))).Where(t => t.score > 0)
            .OrderByDescending(t => t.score).ThenBy(t => t.a.Name.Length).FirstOrDefault();
        if (best.score == 0) throw new InvalidOperationException($"no Start-menu app is called \"{query}\"");
        Process.Start(new ProcessStartInfo("explorer.exe", $"shell:AppsFolder\\{best.a.Id}") { UseShellExecute = false });
        return best.a.Name;
    }

    /** Opens an http(s) address in the default browser. */
    public static void Browse(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https"))
            throw new InvalidOperationException("only http and https addresses are opened");
        Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
}
