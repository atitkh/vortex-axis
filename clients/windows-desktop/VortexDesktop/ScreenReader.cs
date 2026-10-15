using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace Axis.Desktop.App;

/**
 * Reads what is on the screen: the controls a window exposes through UI Automation (names, kinds,
 * boxes, values), and, when a window exposes little, its text from the pixels with Windows' own OCR.
 * Everything is in physical screen pixels (the app is per-monitor DPI aware). A password field's
 * value is never read.
 */
sealed class ScreenReader
{
    /** Most controls taken from one window; the best of them are picked to send (DesktopCommands.Pick). */
    const int MaxCollected = 1500;
    /** Fewer named controls than this, and auto OCR reads the pixels too. */
    const int SparseBelow = 8;
    static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);
    static readonly TimeSpan OcrPatience = TimeSpan.FromSeconds(4);
    /** How long the after-an-action read of the focus may take; past it the answer goes without the focus. */
    const int StatePatienceMs = 1500;

    static readonly CacheRequest Cache = MakeCache();

    static CacheRequest MakeCache()
    {
        var c = new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.Full };
        c.Add(AutomationElement.NameProperty);
        c.Add(AutomationElement.ControlTypeProperty);
        c.Add(AutomationElement.BoundingRectangleProperty);
        c.Add(AutomationElement.IsOffscreenProperty);
        c.Add(AutomationElement.HasKeyboardFocusProperty);
        c.Add(AutomationElement.IsPasswordProperty);
        c.Add(AutomationElement.IsValuePatternAvailableProperty);
        c.Add(ValuePattern.ValueProperty);
        return c;
    }

    public async Task<LookResult> LookAsync(string scope, OcrMode ocr, Func<Task> hideOwn, CancellationToken ct)
    {
        Native.GetCursorPos(out var mouse);
        var screen = System.Windows.Forms.SystemInformation.VirtualScreen;
        var clock = Stopwatch.StartNew();
        (WindowInfo?, List<ScreenElement>, Rectangle?) got;
        try { got = await Uia.Run(() => Read(scope, mouse), (int)Patience.TotalMilliseconds, "reading the window", ct); }
        catch (TimeoutException) when (Uia.Stuck < 8)
        {
            throw new TimeoutException($"{Foreground()?.Title ?? "the window in front"} took too long to describe itself; try scope mouse, or ocr");
        }
        var (window, elements, area) = got;

        var readMs = clock.ElapsedMilliseconds;
        string? ocrFailed = null;
        var named = elements.Count(e => e.Kind is not ("window" or "pane" or "group") && e.Name.Length > 0);
        var read = ocr == OcrMode.Always || (ocr == OcrMode.Auto && named < SparseBelow && scope != "screen");
        if (read && area is { Width: > 8, Height: > 8 } box)
        {
            // The pointer would be read as text; it steps out of the picture for the capture. All of it (the hide,
            // the capture, Windows' OCR) off this thread and under one deadline: a stuck one leaves the text out,
            // not the look. 0.4.0 and 0.4.1 looks that needed OCR never answered.
            var reading = Task.Run(async () =>
            {
                var hidden = hideOwn();
                await Task.WhenAny(hidden, Task.Delay(500));
                return await OcrAsync(box, ct);
            }, ct);
            if (await Task.WhenAny(reading, Task.Delay(OcrPatience, ct)) == reading && reading.IsCompletedSuccessfully) elements.AddRange(reading.Result);
            else ocrFailed = reading.IsFaulted ? reading.Exception!.GetBaseException().Message : "took too long";
        }
        var monitors = System.Windows.Forms.Screen.AllScreens
            .Select(m => new Display(m.Bounds.X, m.Bounds.Y, m.Bounds.Width, m.Bounds.Height, m.Primary)).ToList();
        return new LookResult(window, mouse.X, mouse.Y, elements, screen.Width, screen.Height, read && ocrFailed == null, screen.X, screen.Y, monitors)
            { OcrFailed = ocrFailed, ReadMs = readMs, OcrMs = clock.ElapsedMilliseconds - readMs };
    }

    /** The window in front and the focused control: two small reads, for the answer after an action. */
    public async Task<ScreenState> StateAsync(CancellationToken ct)
    {
        ScreenElement? focus = null;
        try
        {
            focus = await Uia.Run(() =>
            {
                var found = new List<ScreenElement>();
                using (Cache.Activate()) Add(found, AutomationElement.FocusedElement?.GetUpdatedCache(Cache));
                return found.FirstOrDefault();
            }, StatePatienceMs, "reading the focus", ct);
        }
        // A window that will not answer leaves the focus out, not the action's answer.
        catch (Exception) when (!ct.IsCancellationRequested) { }
        return new ScreenState(Foreground(), focus);
    }

    /** Runs on its own thread (Uia.Run): UI Automation calls cross into other processes and can hang. */
    static (WindowInfo?, List<ScreenElement>, Rectangle?) Read(string scope, Native.POINT mouse)
    {
        var list = new List<ScreenElement>();
        using (Cache.Activate())
        {
            if (scope == "screen")
            {
                // The windows open, not what is in them.
                foreach (AutomationElement w in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition))
                    Add(list, w);
                return (Foreground(), list, null);
            }

            if (scope == "mouse")
            {
                var at = AutomationElement.FromPoint(new System.Windows.Point(mouse.X, mouse.Y));
                // What the mouse is on, what that holds, and what holds it, a few levels up.
                Add(list, at);
                foreach (AutomationElement child in at.FindAll(TreeScope.Children, Condition.TrueCondition)) Add(list, child);
                var walker = TreeWalker.ControlViewWalker;
                var up = at;
                for (var i = 0; i < 4; i++)
                {
                    up = walker.GetParent(up, Cache);
                    if (up == null || up == AutomationElement.RootElement) break;
                    Add(list, up);
                }
                var near = Rectangle.Inflate(new Rectangle(mouse.X, mouse.Y, 1, 1), 300, 120);
                return (Foreground(), list, near);
            }

            var hwnd = Native.GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return (null, list, null);
            var window = AutomationElement.FromHandle(hwnd);
            Add(list, window);
            // A menu that opened from it (a right click's, a drop-down) is a window of its own: read it too, and first (the
            // window's own controls may fill the list), so its items can be clicked by name straight after the right click.
            foreach (var popup in Windows.Popups(hwnd))
            {
                var menu = AutomationElement.FromHandle(popup);
                Add(list, menu);
                foreach (AutomationElement e in menu.FindAll(TreeScope.Descendants, Condition.TrueCondition))
                {
                    if (list.Count >= MaxCollected) break;
                    Add(list, e);
                }
            }
            var all = window.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            foreach (AutomationElement e in all)
            {
                if (list.Count >= MaxCollected) break;
                Add(list, e);
            }
            var info = Foreground();
            return (info, list, info == null ? null : new Rectangle(info.X, info.Y, info.W, info.H));
        }
    }

    /** The window in front, from Windows itself (never UI Automation, so a frozen window cannot hold it up). */
    public static WindowInfo? Foreground()
    {
        var hwnd = Native.GetForegroundWindow();
        if (hwnd == IntPtr.Zero || !Native.GetWindowRect(hwnd, out var r)) return null;
        string title = Native.Title(hwnd), app = "";
        try
        {
            Native.GetWindowThreadProcessId(hwnd, out var pid);
            app = Process.GetProcessById((int)pid).ProcessName;
        }
        catch { }
        return new WindowInfo(title, app, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    static void Add(List<ScreenElement> list, AutomationElement? e)
    {
        if (e == null) return;
        try
        {
            var c = e.Cached;
            if (c.IsOffscreen) return;
            var box = c.BoundingRectangle;
            if (box.IsEmpty || box.Width < 2 || box.Height < 2 || double.IsInfinity(box.Width)) return;
            var kind = Kind(c.ControlType);
            var name = (c.Name ?? "").Trim();
            string? value = null;
            if (c.IsPassword) kind = "password";  // never its contents
            else if (e.GetCachedPropertyValue(AutomationElement.IsValuePatternAvailableProperty) is true)
                value = (e.GetCachedPropertyValue(ValuePattern.ValueProperty) as string)?.Trim();
            // A container with no name says nothing; a field says something even unnamed.
            if (name.Length == 0 && string.IsNullOrEmpty(value) && kind is not ("edit" or "document" or "password" or "combobox")) return;
            list.Add(new ScreenElement(kind, name, (int)box.X, (int)box.Y, (int)box.Width, (int)box.Height, value, c.HasKeyboardFocus) { Ref = e });
        }
        // One element that will not describe itself (gone, or an app's own oddity) is left out, not the whole look.
        catch (Exception) { }
    }

    /** "ControlType.Button" → "button". */
    static string Kind(ControlType type)
    {
        var name = type?.ProgrammaticName ?? "ControlType.Custom";
        return name[(name.IndexOf('.') + 1)..].ToLowerInvariant();
    }

    /** Text read from the pixels in `area`, a line each. */
    static async Task<List<ScreenElement>> OcrAsync(Rectangle area, CancellationToken ct)
    {
        var found = new List<ScreenElement>();
        var engine = OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null) return found;
        // OCR takes images up to a size; a bigger area is shrunk and the boxes grown back.
        var max = (int)OcrEngine.MaxImageDimension;
        var scale = Math.Min(1.0, (double)max / Math.Max(area.Width, area.Height));
        using var shot = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(area.Location, System.Drawing.Point.Empty, area.Size);
        using var sized = scale < 1 ? new Bitmap(shot, (int)(area.Width * scale), (int)(area.Height * scale)) : (Bitmap)shot.Clone();
        using var png = new MemoryStream();
        sized.Save(png, ImageFormat.Png);
        using var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(png.ToArray().AsBuffer());
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        ct.ThrowIfCancellationRequested();
        var result = await engine.RecognizeAsync(bitmap);
        foreach (var line in result.Lines)
        {
            if (line.Words.Count == 0) continue;
            double l = double.MaxValue, t = double.MaxValue, r = 0, b = 0;
            foreach (var w in line.Words)
            {
                l = Math.Min(l, w.BoundingRect.X);
                t = Math.Min(t, w.BoundingRect.Y);
                r = Math.Max(r, w.BoundingRect.X + w.BoundingRect.Width);
                b = Math.Max(b, w.BoundingRect.Y + w.BoundingRect.Height);
            }
            found.Add(new ScreenElement("text", line.Text, area.X + (int)(l / scale), area.Y + (int)(t / scale),
                (int)((r - l) / scale), (int)((b - t) / scale), Source: "ocr"));
        }
        return found;
    }
}

static class BufferExtensions
{
    public static IBuffer AsBuffer(this byte[] bytes)
    {
        var writer = new DataWriter();
        writer.WriteBytes(bytes);
        return writer.DetachBuffer();
    }
}
