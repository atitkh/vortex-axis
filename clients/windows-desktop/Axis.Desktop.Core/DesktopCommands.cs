using System.Text.Json;
using System.Text.Json.Nodes;

namespace Axis.Desktop;

/** Something readable on the screen: a control the window exposes, or text read from its pixels. */
public sealed record ScreenElement(string Kind, string Name, int X, int Y, int W, int H, string? Value = null, bool Focused = false, string Source = "ui")
{
    /** The platform's own handle on the control, to act on it directly. Never sent. */
    public object? Ref { get; init; }
}

/** Which click: one with the left button, one with the right, or two quick left ones. */
public enum ClickKind { Left, Right, Double }

/** When to read text from the pixels: never, only when the window exposes little, or always. */
public enum OcrMode { Never, Auto, Always }

public sealed record WindowInfo(string Title, string App, int X, int Y, int W, int H);

/** One display, in screen pixels. With several, the ones left of or above the main one have negative coordinates. */
public sealed record Display(int X, int Y, int W, int H, bool Primary);

/**
 * A picture of part of the screen, already shrunk and encoded: `Area` is what it shows in screen pixels,
 * `W` x `H` its own size.
 */
public sealed record Shot(byte[] Jpeg, int W, int H, int X, int Y, int AreaW, int AreaH, WindowInfo? Window);

/** The window in front and what has the focus, read cheaply after an action instead of a whole look. */
public sealed record ScreenState(WindowInfo? Window, ScreenElement? Focus);

/**
 * What a look found. Coordinates are screen pixels, the same ones pointing takes; the whole desktop is
 * the box (ScreenX, ScreenY, ScreenW, ScreenH), which starts left of or above 0 when a display sits there.
 */
public sealed record LookResult(WindowInfo? Window, int MouseX, int MouseY, IReadOnlyList<ScreenElement> Elements, int ScreenW, int ScreenH, bool Ocr,
    int ScreenX = 0, int ScreenY = 0, IReadOnlyList<Display>? Monitors = null)
{
    /** Why reading the pixels was skipped, when it was wanted and did not work. */
    public string? OcrFailed { get; init; }
    /** How long reading the controls and the pixels took, for the app's own list (finding where a look spends its time). */
    public long ReadMs { get; init; }
    public long OcrMs { get; init; }
}

/** What the computer itself does: read the screen, draw the pointer. The Windows app supplies it; the smoke test fakes it. */
public interface IDesktop
{
    /** `scope` is window, mouse or screen. */
    Task<LookResult> LookAsync(string scope, OcrMode ocr, CancellationToken ct);
    /** Shows the pointer at (x, y) with `text` beside it (none when null) for `seconds`. */
    Task PointAsync(int x, int y, string? text, double seconds, CancellationToken ct);
    Task HideAsync();
    /** The middle of the main screen, for "show the pointer". */
    (int X, int Y) Centre { get; }

    /**
     * Clicks `target` (from the last look) or (x, y). Returns how and where: "invoked" when the control was pressed
     * directly, without the mouse; "focused" when a field was given the focus that way; "mouse" when a real click
     * was sent (and the mouse put back). With a target it can read again, the platform clicks where it shows now
     * (scrolled into view first when little of it does) and refuses a click that would land on a browser's own bar.
     */
    Task<(string How, int X, int Y)> ClickAsync(ScreenElement? target, int x, int y, ClickKind kind, CancellationToken ct);
    /** `e` (one with a Ref) as it is now, its box cut to what shows; null when it is gone or none of it shows. */
    Task<ScreenElement?> RefreshAsync(ScreenElement e, CancellationToken ct);
    /**
     * Drags with the left button from (x1, y1) to (x2, y2): down, held `holdMs` first when asked, moved in steps,
     * up. A real mouse drag, never an automation pattern; the mouse is put back after. Returns how ("mouse").
     */
    Task<string> DragAsync(ScreenElement? from, int x1, int y1, ScreenElement? to, int x2, int y2, int holdMs, CancellationToken ct);
    /** Types `text` into `target`, or into whatever has the focus. Refuses a password field. */
    Task TypeAsync(ScreenElement? target, string text, CancellationToken ct);
    /** Presses one key combination. */
    Task KeysAsync(KeyCombo combo, CancellationToken ct);
    /**
     * Starts a Start-menu app matched by name, or opens an http(s) address in the default browser, waits for
     * its window and brings it to the front. Returns what it opened and that window (null if none showed).
     */
    Task<(string Opened, WindowInfo? Window)> OpenAsync(string? app, string? url, CancellationToken ct);
    /** Brings to the front the window best matching an app name or a title. */
    Task<WindowInfo> SwitchAsync(string window, CancellationToken ct);
    /** Minimizes, maximizes, restores or moves to display `display` (1-based) the named window, or the one in front. */
    Task<WindowInfo> WindowAsync(string op, string? window, int? display, CancellationToken ct);
    /** The next or previous virtual desktop. */
    Task DesktopAsync(bool next, CancellationToken ct);
    /** The window in front and the focused control, without reading the rest of the window. */
    Task<ScreenState> StateAsync(CancellationToken ct);
    /**
     * A picture of the window in front (`scope` window), the whole desktop (screen), or `region` (an element
     * from the last look, with a margin), shrunk so its longer side is at most `maxSide`. The app's own pointer
     * is out of it. Throws when a password field has the focus.
     */
    Task<Shot> ScreenshotAsync(string scope, ScreenElement? region, int maxSide, CancellationToken ct);
    /**
     * Scrolls `target` (a list, page or field; or what holds it), else the window in front, `go` up, down, left,
     * right, top or bottom, `pages` at a time. Returns how: "scrolled" (the control did it) or "wheel".
     */
    Task<string> ScrollAsync(ScreenElement? target, string go, int pages, CancellationToken ct);
    /** The open window best matching an app name or title, or null. Does not bring it forward. */
    Task<WindowInfo?> FindWindowAsync(string query, CancellationToken ct);
    /** The text on the clipboard, or null with why (empty, not text, or marked private by a password manager). */
    Task<(string? Text, string? Why)> ReadClipboardAsync(CancellationToken ct);
    /** Puts `text` into `target` (or the focus) by the clipboard and Ctrl+V, then puts the clipboard back. */
    Task PasteAsync(ScreenElement? target, string text, CancellationToken ct);
}

/** A key with the modifiers held for it: "ctrl+shift+t", "enter", "alt+tab". */
public sealed record KeyCombo(bool Ctrl, bool Alt, bool Shift, bool Win, string Key)
{
    static readonly HashSet<string> Named =
    [
        "enter", "tab", "escape", "backspace", "delete", "insert", "space", "up", "down", "left", "right",
        "home", "end", "pageup", "pagedown", "printscreen", "capslock", "menu",
        "volumeup", "volumedown", "volumemute", "mediaplaypause", "medianext", "mediaprevious", "mediastop",
    ];
    static readonly Dictionary<string, string> Aliases = new()
    {
        ["return"] = "enter", ["esc"] = "escape", ["del"] = "delete", ["ins"] = "insert", ["pgup"] = "pageup", ["pgdn"] = "pagedown",
        ["arrowup"] = "up", ["arrowdown"] = "down", ["arrowleft"] = "left", ["arrowright"] = "right", ["spacebar"] = "space",
        ["playpause"] = "mediaplaypause", ["mute"] = "volumemute",
    };

    /** Reads "Ctrl+Shift+T" and the like. Throws FormatException on anything it does not know. */
    public static KeyCombo Parse(string text)
    {
        var parts = (text ?? "").ToLowerInvariant().Replace(" ", "").Split('+', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) throw new FormatException("keys is empty");
        bool ctrl = false, alt = false, shift = false, win = false;
        foreach (var m in parts[..^1])
        {
            switch (m)
            {
                case "ctrl" or "control": ctrl = true; break;
                case "alt" or "option": alt = true; break;
                case "shift": shift = true; break;
                case "win" or "windows" or "meta" or "super" or "cmd": win = true; break;
                default: throw new FormatException($"\"{m}\" is not a modifier (ctrl, alt, shift, win)");
            }
        }
        var key = parts[^1];
        key = Aliases.GetValueOrDefault(key, key);
        var known = Named.Contains(key) || key.Length == 1 && key[0] is >= ' ' and <= '~'
            || key.Length is 2 or 3 && key[0] == 'f' && int.TryParse(key[1..], out var f) && f is >= 1 and <= 24;
        if (!known) throw new FormatException($"\"{parts[^1]}\" is not a key this knows");
        return new KeyCombo(ctrl, alt, shift, win, key);
    }

    /**
     * Combinations the app never presses, whatever an agent asks: locking the computer, signing out or
     * the security screen, Task Manager, and closing the window in front.
     */
    public string? Blocked() => this switch
    {
        { Win: true, Key: "l" } => "locking the computer",
        { Ctrl: true, Alt: true, Key: "delete" or "end" } => "the security screen",
        { Ctrl: true, Shift: true, Key: "escape" } => "Task Manager",
        { Alt: true, Key: "f4" } => "closing the window",
        { Win: true, Key: "x" or "r" } => "the power menu or Run",
        _ => null,
    };

    public override string ToString() =>
        string.Join("+", new[] { Ctrl ? "ctrl" : null, Alt ? "alt" : null, Shift ? "shift" : null, Win ? "win" : null, Key }.Where(s => s != null));
}

/**
 * Turns Axis's `desktop.*` commands into calls on the desktop and answers. Keeps the elements of the
 * last look by id, so the agent can point at "17". Refuses everything while the person has paused the
 * app, or switched looking off: those are the computer's own say, whatever an agent asks.
 */
public sealed class DesktopCommands
{
    /** Most elements a look sends back; the busiest windows have thousands. */
    public const int MaxElements = 250;
    const int MaxText = 160;

    readonly IDesktop desktop;
    readonly object gate = new();
    IReadOnlyList<ScreenElement> last = [];
    /** A scroll since the last look: the ids still name the same things, but their boxes may have moved. */
    bool scrolled;
    IReadOnlyDictionary<string, JsonElement> settings = new Dictionary<string, JsonElement>();

    /** Set by the person in the app. While true, nothing is read and nothing is shown. */
    public bool Paused { get; set; }

    /** Told after each command, for the app's own list of what was done. */
    public event Action<string>? Did;

    public DesktopCommands(IDesktop desktop) => this.desktop = desktop;

    public void UseSettings(IReadOnlyDictionary<string, JsonElement> values) => settings = values;

    bool Toggle(string key, bool fallback) =>
        settings.TryGetValue(key, out var v) ? v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number => v.GetDouble() != 0,
            JsonValueKind.String => v.GetString() is "1" or "true",
            _ => fallback,
        } : fallback;

    public async Task<CommandAnswer> HandleAsync(string name, JsonElement p, CancellationToken ct)
    {
        try
        {
            if (await BlockedFrontAsync(name, p, ct) is string hit)
            {
                Did?.Invoke($"Refused {name["desktop.".Length..]}: the window in front is on the user's block list");
                return CommandAnswer.Fail($"the window in front is blocked by the user (it matches \"{hit}\"): the app neither reads it nor acts on it. Tell the person; do not try another way");
            }
            if (name is "desktop.look" or "desktop.find" or "desktop.screenshot") return await WithinAsync(RunAsync(name, p, ct), ReadDeadlineMs, name);
            if (!Changes.Contains(name)) return await RunAsync(name, p, ct);
            var before = await StateOrNullAsync(ct);
            var answer = await RunAsync(name, p, ct);
            return await WithAfterAsync(answer, name, p, before, ct);
        }
        catch (Exception e)
        {
            // Said in the app as well as to the agent, so the person sees why it failed.
            var why = string.IsNullOrWhiteSpace(e.Message) ? $"{e.GetType().Name} (0x{e.HResult:X8})" : $"{e.Message} ({e.GetType().Name})";
            Did?.Invoke($"{name} failed: {why}");
            return CommandAnswer.Fail(why);
        }
    }

    /** The user's block list, sent by Axis with each command as `blocked` ("bank|keepass"), lower case. */
    static List<string> Blocked(JsonElement p) =>
        (Str(p, "blocked") ?? "").ToLowerInvariant().Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

    /** The block list's entry a window's title or app contains, any case, or null. */
    static string? BlockedBy(List<string> blocked, string? title, string? app)
    {
        var name = $"{title} {app}".ToLowerInvariant();
        return blocked.FirstOrDefault(b => name.Contains(b, StringComparison.Ordinal));
    }

    /**
     * The block list's entry the window in front matches, when a command would read it or act on it; null to go on.
     * Open, switch, window and a look at the whole screen are let through: they name or list other windows, and a
     * screen look names a blocked one only as blocked.
     */
    async Task<string?> BlockedFrontAsync(string name, JsonElement p, CancellationToken ct)
    {
        var blocked = Blocked(p);
        if (blocked.Count == 0 || name is "desktop.hello" or "desktop.hide" or "desktop.open" or "desktop.switch" or "desktop.window"
            || name == "desktop.look" && Str(p, "scope") == "screen") return null;
        var front = (await StateOrNullAsync(ct))?.Window;
        return front == null ? null : BlockedBy(blocked, front.Title, front.App);
    }

    async Task<CommandAnswer> RunAsync(string name, JsonElement p, CancellationToken ct)
    {
        if (name.StartsWith("desktop.", StringComparison.Ordinal) && Paused)
            return CommandAnswer.Fail("the person at the computer has paused the VorteX Axis desktop app");
        switch (name)
        {
            case "desktop.look":
            {
                if (!Toggle("allowLook", true)) return CommandAnswer.Fail("reading the screen is switched off for this computer");
                var scope = Str(p, "scope") ?? "window";
                if (scope is not ("window" or "mouse" or "screen")) return CommandAnswer.Fail("scope must be window, mouse or screen");
                var ocr = Bool(p, "ocr") ? OcrMode.Always : Toggle("autoOcr", true) ? OcrMode.Auto : OcrMode.Never;
                var started = System.Diagnostics.Stopwatch.StartNew();
                var look = await desktop.LookAsync(scope, ocr, ct);
                if (scope == "screen" && Blocked(p) is { Count: > 0 } blocked)
                    look = look with { Elements = look.Elements.Select(e => e.Kind == "window" && BlockedBy(blocked, e.Name, null) != null ? e with { Name = "blocked by the user", Value = null, Ref = null } : e).ToList() };
                var elements = Pick(look.Elements, look.MouseX, look.MouseY, MaxElements);
                lock (gate) (last, scrolled) = (elements, false);
                var data = LookData(look, elements);
                Did?.Invoke($"Looked at the {scope}: {elements.Count} things{(look.Ocr ? ", text read from the pixels" : look.OcrFailed != null ? $", pixels skipped ({look.OcrFailed})" : "")} " +
                    $"in {started.ElapsedMilliseconds} ms (controls {look.ReadMs}, pixels {look.OcrMs}; {Busy()})");
                return CommandAnswer.Done(data: data);
            }
            case "desktop.find":
            {
                if (!Toggle("allowLook", true)) return CommandAnswer.Fail("reading the screen is switched off for this computer");
                var query = Str(p, "name") ?? "";
                var look = await FreshLookAsync(ct);
                var found = Match(look.Elements, query, Str(p, "kind")).Take(5).ToList();
                Did?.Invoke($"Looked for \"{Clip(query, 40)}\": {found.Count} found");
                var list = new JsonArray(found.Select(m => (JsonNode?)Line(look.Elements[m.Index], m.Index + 1)).ToArray());
                var data = new JsonObject { ["matches"] = list };
                if (look.Window is { } w) data["window"] = $"{Clip(w.Title, 200)} ({w.App})";
                return CommandAnswer.Done(data: data);
            }
            case "desktop.screenshot":
            {
                if (!Toggle("allowScreenshot", false)) return CommandAnswer.Fail("screenshots are switched off for this computer (admin page, the computer's settings)");
                var scope = Str(p, "scope") ?? "window";
                if (scope is not ("window" or "screen")) return CommandAnswer.Fail("scope must be window or screen");
                ScreenElement? region = null;
                if (Int(p, "id") is int id)
                {
                    string? fail;
                    (region, fail) = await ByIdAsync(id, ct);
                    if (fail != null) return CommandAnswer.Fail(fail);
                }
                var detail = Str(p, "detail") ?? "normal";
                if (!ShotSides.TryGetValue(detail, out var side)) return CommandAnswer.Fail("detail must be low, normal or high");
                var shot = await desktop.ScreenshotAsync(scope, region, side, ct);
                Did?.Invoke($"Took a {shot.W}x{shot.H} picture of {(region != null ? Clip(region.Name, 40) : scope == "screen" ? "the screen" : shot.Window?.Title is { } t ? Clip(t, 40) : "the window")}");
                var data = new JsonObject
                {
                    ["image"] = new JsonObject { ["data"] = Convert.ToBase64String(shot.Jpeg), ["mimeType"] = "image/jpeg" },
                    ["picture"] = $"{shot.W}x{shot.H} of {shot.X},{shot.Y} {shot.AreaW}x{shot.AreaH}",
                };
                if (shot.Window is { } w) data["window"] = $"{Clip(w.Title, 200)} ({w.App})";
                return CommandAnswer.Done(data: data);
            }
            case "desktop.point":
            {
                int x, y;
                string? label = null;
                var (target, fail) = await TargetAsync(p, ct);
                if (fail != null) return CommandAnswer.Fail(fail);
                if (target != null) (x, y, label) = (target.X + target.W / 2, target.Y + target.H / 2, target.Name);
                else if (Int(p, "x") is int px && Int(p, "y") is int py) (x, y) = (px, py);
                else return CommandAnswer.Fail("point needs a name, an id, or x and y");
                var words = Toggle("bubble", true) ? Str(p, "text") : null;
                var seconds = Math.Clamp(Int(p, "seconds") ?? 6, 1, 60);
                await desktop.PointAsync(x, y, words, seconds, ct);
                Did?.Invoke($"Pointed at {label ?? $"{x}, {y}"}{(words != null ? $": \"{words}\"" : "")}");
                var payload = new JsonObject { ["x"] = x, ["y"] = y };
                if (label != null) payload["name"] = Clip(label, 200);
                return CommandAnswer.Done(payload);
            }
            case "desktop.hide":
                await desktop.HideAsync();
                return CommandAnswer.Done();
            case "desktop.wait":
                if (Str(p, "name") != null || Str(p, "window") != null) return await WaitForAsync(p, ct);
                await Task.Delay(Math.Clamp(Int(p, "ms") ?? 500, 50, 3000), ct);
                return CommandAnswer.Done();
            case "desktop.clipboard":
            {
                if (!Toggle("allowLook", true)) return CommandAnswer.Fail("reading the screen is switched off for this computer");
                var (text, why) = await desktop.ReadClipboardAsync(ct);
                Did?.Invoke(text != null ? $"Read the clipboard: {text.Length} characters" : $"Clipboard: {why}");
                if (text == null) return CommandAnswer.Done(data: new JsonObject { ["clipboard"] = null, ["why"] = why });
                var data = new JsonObject { ["clipboard"] = Clip(text, MaxClipboard) };
                if (text.Length > MaxClipboard) data["more"] = text.Length - MaxClipboard;
                return CommandAnswer.Done(data: data);
            }
            case "desktop.steps":
                return await StepsAsync(p, ct);
            case "desktop.window" when Str(p, "do") == "list":
            {
                // The windows open, as a look at the screen sees them (blocked ones named only as blocked).
                if (!Toggle("allowLook", true)) return CommandAnswer.Fail("reading the screen is switched off for this computer");
                var look = await desktop.LookAsync("screen", OcrMode.Never, ct);
                var blocked = Blocked(p);
                var windows = look.Elements.Where(e => e.Kind == "window" && e.Name.Length > 0)
                    .Select(e => (JsonNode?)(BlockedBy(blocked, e.Name, null) != null ? "blocked by the user" : $"{Clip(e.Name, 120)} {e.X},{e.Y} {e.W}x{e.H}")).ToArray();
                Did?.Invoke($"Listed {windows.Length} open windows");
                return CommandAnswer.Done(data: new JsonObject { ["windows"] = new JsonArray(windows) });
            }
            case "desktop.click" or "desktop.drag" or "desktop.type" or "desktop.keys" or "desktop.open" or "desktop.switch" or "desktop.window" or "desktop.desktop"
                or "desktop.scroll" or "desktop.paste":
                return await ActAsync(name, p, ct);
            case "desktop.hello":
            {
                // The admin page's "Show the pointer": proof the app is there and drawing.
                var (cx, cy) = desktop.Centre;
                await desktop.PointAsync(cx, cy, "Hi, I'm here", 4, ct);
                Did?.Invoke("Showed the pointer for the admin page");
                return CommandAnswer.Done();
            }
            default:
                return CommandAnswer.Fail("not implemented on this device");
        }
    }

    /** The thread pool's state, for the app's list: a starved pool is what made 0.4.0 looks go unanswered. */
    public static string Busy()
    {
        System.Threading.ThreadPool.GetAvailableThreads(out var free, out _);
        return $"pool {System.Threading.ThreadPool.ThreadCount} threads, {System.Threading.ThreadPool.PendingWorkItemCount} waiting";
    }

    /**
     * Longest side of a picture, by `detail`. A model reads about w*h/750 tokens from one, so normal (1024) on a
     * 16:9 window is about 800; low suits "what is this window showing", high small text (or use an id to crop).
     */
    static readonly Dictionary<string, int> ShotSides = new() { ["low"] = 640, ["normal"] = 1024, ["high"] = 1568 };

    /** Axis waits 15 s for a look; past this the app answers anyway, so the agent hears why instead of a timeout. */
    const int ReadDeadlineMs = 12000;

    async Task<CommandAnswer> WithinAsync(Task<CommandAnswer> work, int ms, string name)
    {
        if (await Task.WhenAny(work, Task.Delay(ms)) == work) return await work;
        _ = work.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
        var why = $"reading the screen took longer than {ms / 1000} s (the window in front is not answering); try again, or switch to another window";
        Did?.Invoke($"{name} failed: {why}");
        return CommandAnswer.Fail(why);
    }

    /** Commands that change the screen: their answer says what is in front afterwards, so the agent need not look again. */
    static readonly HashSet<string> Changes =
        ["desktop.click", "desktop.drag", "desktop.type", "desktop.keys", "desktop.open", "desktop.switch", "desktop.window", "desktop.desktop", "desktop.steps",
         "desktop.scroll", "desktop.paste"];
    /** How long the screen gets to catch up before it is read again; an app being started takes longer. */
    const int AfterMs = 300, AfterOpenMs = 400;

    async Task<ScreenState?> StateOrNullAsync(CancellationToken ct)
    {
        try { return await desktop.StateAsync(ct); }
        catch (Exception) { return null; }
    }

    /**
     * Adds `after` to an action's answer: the window in front (with `new` when it is not the one in front
     * before), what has the focus and its value. A few dozen characters instead of a look.
     */
    async Task<CommandAnswer> WithAfterAsync(CommandAnswer answer, string name, JsonElement p, ScreenState? before, CancellationToken ct)
    {
        var opened = name == "desktop.open" || name == "desktop.steps" && StepsInclude(p, "open");
        await Task.Delay(opened ? AfterOpenMs : AfterMs, ct);
        var now = await StateOrNullAsync(ct);
        if (now == null) return answer;
        var after = new JsonObject();
        if (now.Window is { } w)
        {
            after["window"] = $"{Clip(w.Title, 120)} ({w.App})";
            if (before?.Window is { } b && (b.Title != w.Title || b.App != w.App)) after["new"] = true;
        }
        if (now.Focus is { } f)
        {
            after["focus"] = $"{f.Kind} {Clip(f.Name, 80)}".TrimEnd();
            if (!string.IsNullOrEmpty(f.Value)) after["value"] = Clip(f.Value!, 120);
        }
        var data = answer.Data as JsonObject ?? new JsonObject();
        data["after"] = after;
        return answer with { Data = data };
    }

    static bool StepsInclude(JsonElement p, string action) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object
        && d.TryGetProperty("steps", out var s) && s.ValueKind == JsonValueKind.Array && s.EnumerateArray().Any(e => Str(e, "action") == action);

    /** What a step in `steps` may be. */
    static readonly HashSet<string> StepActions = ["click", "drag", "type", "keys", "open", "switch", "window", "desktop", "wait", "point", "find", "scroll", "paste"];
    public const int MaxSteps = 10;
    /** A moment between steps, for the screen to catch up with the last one. */
    const int SettleMs = 150;

    /** Runs steps in order, stopping at the first that fails. Says how each went. */
    async Task<CommandAnswer> StepsAsync(JsonElement p, CancellationToken ct)
    {
        if (!(p.ValueKind == JsonValueKind.Object && p.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object
              && data.TryGetProperty("steps", out var steps) && steps.ValueKind == JsonValueKind.Array))
            return CommandAnswer.Fail("steps needs a list of steps");
        if (steps.GetArrayLength() > MaxSteps) return CommandAnswer.Fail($"at most {MaxSteps} steps in one call");
        var report = new JsonArray();
        var i = 0;
        foreach (var step in steps.EnumerateArray())
        {
            i++;
            var action = Str(step, "action") ?? "";
            if (!StepActions.Contains(action))
                return StepsFailed(report, i, action, $"{action} cannot be a step");
            if (i > 1) await Task.Delay(SettleMs, ct);
            CommandAnswer answer;
            try { answer = await RunAsync($"desktop.{action}", step, ct); }
            catch (Exception e) { answer = CommandAnswer.Fail(string.IsNullOrWhiteSpace(e.Message) ? e.GetType().Name : e.Message); }
            var line = new JsonObject { ["action"] = action, ["ok"] = answer.Ok };
            if (answer.Payload != null) foreach (var (k, v) in answer.Payload) line[k] = v?.DeepClone();
            if (answer.Data is JsonObject d && d["matches"] is JsonNode m) line["matches"] = m.DeepClone();
            if (!answer.Ok) return StepsFailed(report, i, action, answer.Error ?? "failed", line);
            report.Add(line);
        }
        Did?.Invoke($"Ran {i} steps");
        return CommandAnswer.Done(data: new JsonObject { ["steps"] = report, ["done"] = i, ["of"] = i });
    }

    CommandAnswer StepsFailed(JsonArray report, int at, string action, string error, JsonObject? line = null)
    {
        line ??= new JsonObject { ["action"] = action, ["ok"] = false };
        line["error"] = error;
        report.Add(line);
        Did?.Invoke($"Steps stopped at step {at} ({action}): {error}");
        return new CommandAnswer(false, $"step {at} ({action}) failed: {error}", null,
            new JsonObject { ["steps"] = report, ["done"] = at - 1, ["failed"] = at, ["error"] = error });
    }

    /** The window in front, read afresh, every element kept (not just the 250 a look sends), for finding by name. */
    async Task<LookResult> FreshLookAsync(CancellationToken ct)
    {
        var look = await desktop.LookAsync("window", Toggle("autoOcr", true) ? OcrMode.Auto : OcrMode.Never, ct);
        lock (gate) (last, scrolled) = (look.Elements, false);
        return look;
    }

    /**
     * The element a command means: `id` from the last look or find, or `name` (with `kind`) matched in a fresh
     * look at the window in front. Neither: no element, and no failure. A name that matches nothing, or several
     * equally, is a failure that lists what it found, with ids that hold for the next call.
     */
    async Task<(ScreenElement? Target, string? Fail)> TargetAsync(JsonElement p, CancellationToken ct)
    {
        if (Int(p, "id") is int id) return await ByIdAsync(id, ct);
        var query = Str(p, "name");
        if (query == null) return (null, null);
        var look = await FreshLookAsync(ct);
        var matches = Match(look.Elements, query, Str(p, "kind"));
        if (matches.Count == 0) return (null, $"nothing called \"{query}\" in the window in front ({look.Window?.Title ?? "none"}); try find, look, or switch first");
        var top = matches[0];
        var tied = matches.TakeWhile(m => m.Score == top.Score).ToList();
        if (tied.Count > 1 && !Nested(look.Elements, tied))
        {
            var which = string.Join("; ", tied.Take(5).Select(m => $"id {m.Index + 1}: {look.Elements[m.Index].Kind} \"{Clip(look.Elements[m.Index].Name, 40)}\""));
            return (null, $"\"{query}\" matches {tied.Count} things equally ({which}); use one of the ids");
        }
        // Several the same, one inside another (a button and its own label): the innermost.
        var chosen = tied.Count > 1 ? tied.MinBy(m => (long)look.Elements[m.Index].W * look.Elements[m.Index].H) : top;
        return (look.Elements[chosen.Index], null);
    }

    /**
     * Element `id` of the last look. After a scroll its box is read again where the platform can (it may have moved
     * under the page's top, or off it); text read from the pixels cannot be, and is a failure.
     */
    async Task<(ScreenElement? Target, string? Fail)> ByIdAsync(int id, CancellationToken ct)
    {
        ScreenElement? e;
        bool moved;
        lock (gate) (e, moved) = (id >= 1 && id <= last.Count ? last[id - 1] : null, scrolled);
        if (e == null) return (null, $"no element {id} in the last look; look again");
        if (!moved) return (e, null);
        if (e.Ref == null) return (null, $"scrolled since the last look, so element {id} may have moved; look again");
        var now = await desktop.RefreshAsync(e, ct);
        return now == null ? (null, $"element {id} is off the screen since the scroll; look again") : (now, null);
    }

    static bool Nested(IReadOnlyList<ScreenElement> all, List<(int Index, int Score)> tied)
    {
        var boxes = tied.Select(m => all[m.Index]).ToList();
        var inner = boxes.MinBy(e => (long)e.W * e.H)!;
        return boxes.All(e => inner.X >= e.X && inner.Y >= e.Y && inner.X + inner.W <= e.X + e.W && inner.Y + inner.H <= e.Y + e.H);
    }

    static string Norm(string s) => string.Join(' ', s.ToLowerInvariant().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim('.', '…', ':', ' ');

    /**
     * Elements whose name fits `query`, best first: the same name, then starting with it, then holding it at a
     * word, then anywhere, then all its words. Things that can be used and things of the `kind` asked come
     * before the rest; big containers (a window, a pane, a page) after.
     */
    public static List<(int Index, int Score)> Match(IReadOnlyList<ScreenElement> all, string query, string? kind)
    {
        var q = Norm(query);
        if (q.Length == 0) return [];
        var words = q.Split(' ');
        var k = kind?.ToLowerInvariant();
        var found = new List<(int Index, int Score)>();
        for (var i = 0; i < all.Count; i++)
        {
            var e = all[i];
            var n = Norm(e.Name);
            if (n.Length == 0) continue;
            var score = n == q ? 100
                : n.StartsWith(q + " ", StringComparison.Ordinal) || n.StartsWith(q, StringComparison.Ordinal) && q.Length >= 3 ? 85
                : n.Contains(" " + q, StringComparison.Ordinal) ? 75
                : q.Length >= 3 && n.Contains(q, StringComparison.Ordinal) ? 65
                : words.Length > 1 && words.All(w => n.Contains(w, StringComparison.Ordinal)) ? 55
                : 0;
            if (score == 0) continue;
            if (Actionable.Contains(e.Kind)) score += 8;
            if (k != null && e.Kind == k) score += 12;
            if (e.Kind is "window" or "pane" or "group" or "document" or "titlebar") score -= 15;
            found.Add((i, score));
        }
        return found.OrderByDescending(m => m.Score).ToList();
    }

    /**
     * One element as one short line, about half the text of an object with named fields:
     * `id kind x,y wxh name`, then `= value`, `*focus`, `(ocr)` when they apply. "17 button 1510,-100 60x40 Send".
     */
    public static string Line(ScreenElement e, int id)
    {
        var line = $"{id} {e.Kind} {e.X},{e.Y} {e.W}x{e.H} {Clip(e.Name, MaxText)}".TrimEnd();
        if (!string.IsNullOrEmpty(e.Value)) line += $" = {Clip(e.Value!, MaxText)}";
        if (e.Focused) line += " *focus";
        if (e.Source != "ui") line += $" ({e.Source})";
        return line;
    }

    /** Everything that changes the screen: switched off by the person (Axis's allowInput), and held to the app's own limits. */
    async Task<CommandAnswer> ActAsync(string name, JsonElement p, CancellationToken ct)
    {
        if (!Toggle("allowInput", true)) return CommandAnswer.Fail("clicking and typing are switched off for this computer");
        switch (name)
        {
            case "desktop.click":
            {
                var (target, fail) = await TargetAsync(p, ct);
                if (fail != null) return CommandAnswer.Fail(fail);
                int x, y;
                if (target != null) (x, y) = (target.X + target.W / 2, target.Y + target.H / 2);
                else if (Int(p, "x") is int px && Int(p, "y") is int py) (x, y) = (px, py);
                else return CommandAnswer.Fail("click needs a name, an id, or x and y");
                var kind = (Str(p, "button") ?? "left") switch
                {
                    "left" => ClickKind.Left,
                    "right" => ClickKind.Right,
                    "double" => ClickKind.Double,
                    var other => throw new FormatException($"button must be left, right or double, not {other}"),
                };
                // Where it was clicked: where the control shows now, which may not be where the look saw it.
                string how;
                (how, x, y) = await desktop.ClickAsync(target, x, y, kind, ct);
                Did?.Invoke($"{(kind == ClickKind.Left ? "Clicked" : kind == ClickKind.Right ? "Right-clicked" : "Double-clicked")} {(target != null ? Clip(target.Name, 60) : $"{x}, {y}")}");
                var payload = new JsonObject { ["x"] = x, ["y"] = y, ["how"] = how };
                if (target != null) payload["name"] = Clip(target.Name, 200);
                return CommandAnswer.Done(payload);
            }
            case "desktop.drag":
            {
                var (from, fail) = await TargetAsync(p, ct);
                if (fail != null) return CommandAnswer.Fail(fail);
                int x1, y1;
                if (from != null) (x1, y1) = (from.X + from.W / 2, from.Y + from.H / 2);
                else if (Int(p, "x") is int px && Int(p, "y") is int py) (x1, y1) = (px, py);
                else return CommandAnswer.Fail("drag needs where from: a name, an id, or x and y");
                // Where to: by id from the last look, by name (read afresh), or a point.
                var toward = new JsonObject();
                if (Int(p, "toId") is int toId) toward["id"] = toId;
                else if (Str(p, "toName") is string toName) toward["name"] = toName;
                var (to, toFail) = await TargetAsync(JsonDocument.Parse(toward.ToJsonString()).RootElement, ct);
                if (toFail != null) return CommandAnswer.Fail(toFail);
                int x2, y2;
                if (to != null) (x2, y2) = (to.X + to.W / 2, to.Y + to.H / 2);
                else if (Int(p, "toX") is int tx && Int(p, "toY") is int ty) (x2, y2) = (tx, ty);
                else return CommandAnswer.Fail("drag needs where to: toName, toId, or toX and toY");
                var hold = Math.Clamp(Int(p, "holdMs") ?? 0, 0, 2000);
                var how = await desktop.DragAsync(from, x1, y1, to, x2, y2, hold, ct);
                Did?.Invoke($"Dragged {(from != null ? Clip(from.Name, 60) : $"{x1}, {y1}")} to {(to != null ? Clip(to.Name, 60) : $"{x2}, {y2}")}{(hold > 0 ? $" after holding {hold} ms" : "")}");
                var payload = new JsonObject { ["x"] = x1, ["y"] = y1, ["toX"] = x2, ["toY"] = y2, ["how"] = how };
                if (from != null) payload["name"] = Clip(from.Name, 200);
                if (to != null) payload["toName"] = Clip(to.Name, 200);
                return CommandAnswer.Done(payload);
            }
            case "desktop.type":
            {
                var text = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString()! : "";
                if (text.Length == 0) return CommandAnswer.Fail("type needs text");
                if (text.Length > MaxTyped) return CommandAnswer.Fail($"at most {MaxTyped} characters at a time");
                var (target, fail) = await TargetAsync(p, ct);
                if (fail != null) return CommandAnswer.Fail(fail);
                if (target?.Kind == "password") return CommandAnswer.Fail("the app never types into a password field");
                await desktop.TypeAsync(target, text, ct);
                Did?.Invoke($"Typed {text.Length} characters{(target != null ? $" into {Clip(target.Name, 60)}" : "")}");
                var payload = new JsonObject { ["typed"] = text.Length };
                if (target != null) payload["into"] = Clip(target.Name, 200);
                return CommandAnswer.Done(payload);
            }
            case "desktop.keys":
            {
                var combo = KeyCombo.Parse(Str(p, "keys") ?? "");
                if (combo.Blocked() is string why)
                {
                    Did?.Invoke($"Refused to press {combo} ({why})");
                    return CommandAnswer.Fail($"the app never presses {combo} ({why})");
                }
                await desktop.KeysAsync(combo, ct);
                Did?.Invoke($"Pressed {combo}");
                return CommandAnswer.Done(new JsonObject { ["pressed"] = combo.ToString() });
            }
            case "desktop.open":
            {
                var url = Str(p, "url");
                if (url != null && !(url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
                    return CommandAnswer.Fail("the app only opens http and https addresses");
                var app = Str(p, "app");
                if ((url == null) == (app == null)) return CommandAnswer.Fail("open needs app or url");
                var (opened, window) = await desktop.OpenAsync(app, url, ct);
                Did?.Invoke($"Opened {Clip(opened, 60)}{(window == null ? " (no window showed yet)" : "")}");
                var payload = new JsonObject { ["opened"] = Clip(opened, 200) };
                // No window: the next type or keys would land wherever the focus already is, so the agent is told.
                if (window == null) payload["note"] = "no window showed within 8 s; check before typing";
                return CommandAnswer.Done(payload);
            }
            case "desktop.switch":
            {
                var to = Str(p, "window");
                if (to == null) return CommandAnswer.Fail("switch needs window");
                var w = await desktop.SwitchAsync(to, ct);
                Did?.Invoke($"Switched to {Clip(w.Title, 60)}");
                return CommandAnswer.Done(WindowPayload(w));
            }
            case "desktop.window":
            {
                var op = Str(p, "do") ?? "";
                if (op is not ("minimize" or "maximize" or "restore" or "move")) return CommandAnswer.Fail("window needs do: minimize, maximize, restore or move");
                var display = Int(p, "display");
                if (op == "move" && display is not >= 1) return CommandAnswer.Fail("move needs display, 1 or more");
                var w = await desktop.WindowAsync(op, Str(p, "window"), display, ct);
                Did?.Invoke($"{char.ToUpper(op[0])}{op[1..]}{(op == "move" ? $" to display {display}" : "")}: {Clip(w.Title, 60)}");
                return CommandAnswer.Done(WindowPayload(w));
            }
            case "desktop.scroll":
            {
                var go = Str(p, "go") ?? "down";
                if (go is not ("up" or "down" or "left" or "right" or "top" or "bottom")) return CommandAnswer.Fail("scroll needs go: up, down, left, right, top or bottom");
                var pages = Math.Clamp(Int(p, "pages") ?? 1, 1, 10);
                var (target, fail) = await TargetAsync(p, ct);
                if (fail != null) return CommandAnswer.Fail(fail);
                var how = await desktop.ScrollAsync(target, go, pages, ct);
                lock (gate) scrolled = true;
                Did?.Invoke($"Scrolled {go}{(go is "top" or "bottom" ? "" : $" {pages} page{(pages == 1 ? "" : "s")}")}{(target != null ? $" in {Clip(target.Name, 40)}" : "")}");
                var payload = new JsonObject { ["scrolled"] = go, ["how"] = how };
                if (target != null) payload["in"] = Clip(target.Name, 200);
                return CommandAnswer.Done(payload);
            }
            case "desktop.paste":
            {
                // Its text comes as the command's data (a direct call) or as the step's own text.
                var text = Str(p, "text") ?? (p.ValueKind == JsonValueKind.Object && p.TryGetProperty("data", out var d) ? Str(d, "text") : null) ?? "";
                if (text.Length == 0) return CommandAnswer.Fail("paste needs text");
                if (text.Length > MaxPasted) return CommandAnswer.Fail($"at most {MaxPasted} characters in one paste");
                var (target, fail) = await TargetAsync(p, ct);
                if (fail != null) return CommandAnswer.Fail(fail);
                if (target?.Kind == "password") return CommandAnswer.Fail("the app never pastes into a password field");
                await desktop.PasteAsync(target, text, ct);
                Did?.Invoke($"Pasted {text.Length} characters{(target != null ? $" into {Clip(target.Name, 60)}" : "")}");
                var payload = new JsonObject { ["pasted"] = text.Length };
                if (target != null) payload["into"] = Clip(target.Name, 200);
                return CommandAnswer.Done(payload);
            }
            default:
            {
                var go = Str(p, "go");
                if (go is not ("next" or "previous")) return CommandAnswer.Fail("desktop needs go: next or previous");
                await desktop.DesktopAsync(go == "next", ct);
                Did?.Invoke($"Went to the {go} desktop");
                return CommandAnswer.Done(new JsonObject { ["went"] = go });
            }
        }
    }

    static JsonObject WindowPayload(WindowInfo w) =>
        new() { ["window"] = $"{Clip(w.Title, 200)} ({w.App}) {w.X},{w.Y} {w.W}x{w.H}" };

    /** Most text one type sends. */
    public const int MaxTyped = 500;
    /** Most text one paste sends, and most clipboard text read back. */
    public const int MaxPasted = 20000, MaxClipboard = 4000;

    /**
     * Waits until an element called `name` is in the window in front, or a window called `window` is open
     * (`gone`: until it is not), looking twice a second, for up to `seconds`. Not finding it in time is a failure
     * that says what is there instead.
     */
    async Task<CommandAnswer> WaitForAsync(JsonElement p, CancellationToken ct)
    {
        var name = Str(p, "name");
        var window = Str(p, "window");
        var gone = Int(p, "gone") == 1 || Bool(p, "gone");
        var seconds = Math.Clamp(Int(p, "seconds") ?? 10, 1, 20);
        var started = System.Diagnostics.Stopwatch.StartNew();
        string? lastWindow = null;
        while (true)
        {
            bool there;
            if (name != null)
            {
                var look = await FreshLookAsync(ct);
                lastWindow = look.Window?.Title;
                there = Match(look.Elements, name, Str(p, "kind")).Count > 0;
            }
            else there = await desktop.FindWindowAsync(window!, ct) != null;
            if (there != gone)
            {
                Did?.Invoke($"Waited {started.ElapsedMilliseconds} ms for {(name != null ? $"\"{Clip(name, 40)}\"" : $"window \"{Clip(window!, 40)}\"")}{(gone ? " to go" : "")}");
                return CommandAnswer.Done(new JsonObject { ["waited"] = started.ElapsedMilliseconds });
            }
            if (started.Elapsed.TotalSeconds >= seconds)
            {
                var what = name != null ? $"\"{name}\" {(gone ? "is still" : "did not appear")} in {lastWindow ?? "the window in front"}" : $"window \"{window}\" {(gone ? "is still open" : "did not open")}";
                return CommandAnswer.Fail($"{what} after {seconds} s");
            }
            await Task.Delay(500, ct);
        }
    }

    static readonly HashSet<string> Actionable =
    [
        "button", "edit", "hyperlink", "menuitem", "checkbox", "radiobutton", "combobox", "tabitem", "listitem",
        "treeitem", "slider", "spinner", "splitbutton", "menubaritem", "dataitem", "password", "document",
    ];

    /**
     * The `max` elements most worth sending, kept in the order the window listed them. The window itself,
     * what has the focus and what holds the mouse always go; then things that can be used, nearest the
     * mouse first; then the rest, nearest the mouse first.
     */
    public static List<ScreenElement> Pick(IReadOnlyList<ScreenElement> all, int mouseX, int mouseY, int max)
    {
        if (all.Count <= max) return all.ToList();
        static double Distance(ScreenElement e, int x, int y)
        {
            var dx = Math.Max(Math.Max(e.X - x, 0), x - (e.X + e.W));
            var dy = Math.Max(Math.Max(e.Y - y, 0), y - (e.Y + e.H));
            return Math.Sqrt((double)dx * dx + (double)dy * dy);
        }
        int Rank(ScreenElement e, int i)
        {
            if (i == 0 || e.Kind == "window" || e.Focused) return 0;
            if (Distance(e, mouseX, mouseY) == 0 && Actionable.Contains(e.Kind)) return 0;
            return Actionable.Contains(e.Kind) ? 1 : 2;
        }
        return all
            .Select((e, i) => (e, i, rank: Rank(e, i), far: Distance(e, mouseX, mouseY)))
            .OrderBy(t => t.rank).ThenBy(t => t.far).ThenBy(t => t.i)
            .Take(max)
            .OrderBy(t => t.i)
            .Select(t => t.e)
            .ToList();
    }

    static JsonObject LookData(LookResult look, List<ScreenElement> elements)
    {
        int? under = null;
        // The smallest element holding the mouse is the one it is on.
        var best = long.MaxValue;
        var list = new JsonArray();
        for (var i = 0; i < elements.Count; i++)
        {
            var e = elements[i];
            if (look.MouseX >= e.X && look.MouseX < e.X + e.W && look.MouseY >= e.Y && look.MouseY < e.Y + e.H && (long)e.W * e.H < best)
            {
                best = (long)e.W * e.H;
                under = i + 1;
            }
            // As a JsonNode: a plain string goes through JsonArray.Add<T>, which needs reflection the published app does not have (0.4.0-0.4.3 looks never answered).
            list.Add((JsonNode?)Line(e, i + 1));
        }
        // Boxes as "x,y wxh", the same form as the element lines.
        var data = new JsonObject
        {
            ["screen"] = $"{look.ScreenX},{look.ScreenY} {look.ScreenW}x{look.ScreenH}",
            ["mouse"] = $"{look.MouseX},{look.MouseY}",
        };
        if (look.Window is { } w) data["window"] = $"{Clip(w.Title, 200)} ({w.App}) {w.X},{w.Y} {w.W}x{w.H}";
        if (look.Monitors is { Count: > 0 } monitors)
            data["monitors"] = new JsonArray(monitors.Select(m => (JsonNode?)$"{m.X},{m.Y} {m.W}x{m.H}{(m.Primary ? " main" : "")}").ToArray());
        if (under is int u) data["underMouse"] = u;
        data["elements"] = list;
        if (look.Elements.Count > elements.Count) data["more"] = look.Elements.Count - elements.Count;
        if (look.OcrFailed != null) data["ocr"] = $"text from the pixels skipped: {look.OcrFailed}";
        else if (elements.Any(e => e.Source == "ocr"))
            data["ocr"] = "the window exposes few controls, so its text was read from the pixels: lines marked (ocr), positions approximate; click them by name";
        return data;
    }

    static string Clip(string s, int n) => s.Length > n ? s[..(n - 1)] + "…" : s;
    static string? Str(JsonElement p, string key) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 } s ? s : null;
    static bool Bool(JsonElement p, string key) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;
    static int? Int(JsonElement p, string key) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? (int)Math.Round(v.GetDouble()) : null;
}

/** How this app introduces itself to Axis, and what it offers the admin page. */
public static class DesktopIdentity
{
    public const string Type = "windows-desktop";

    /**
     * With `voice`, also a microphone, speakers and a screen (the app's pill, which shows what was heard,
     * the reply and questions) that also shows pictures in replies: the computer is talked to like a board.
     * The sound settings and the `chime` action are declared either way: the admin page keeps one list per kind of
     * device, and a computer with talking off must not take the chime away from one with it on.
     */
    public static ClientIdentity Create(string version, bool voice = false) => new(Type, version, voice ? ["desktop", "mic", "speaker", "screen", "images"] : ["desktop"], new JsonObject
    {
        ["settings"] = new JsonArray(
            Setting("allowLook", "Let agents read the screen", "toggle", "Desktop", "Off refuses every look. The person at the computer can also pause the app from its window or tray.", "1"),
            Setting("allowInput", "Let agents click and type", "toggle", "Desktop", "Off refuses clicks, typing and key presses; looking and pointing go on. The app never types into a password field or presses lock, sign-out, Task Manager or Alt+F4.", "1"),
            Setting("bubble", "Words beside the pointer", "toggle", "Desktop", "Show what the agent says next to its pointer.", "1"),
            Setting("allowScreenshot", "Let agents take screenshots", "toggle", "Desktop", "On, an agent may take a small picture of the window in front or the screen when reading its controls is not enough; the picture goes to the agent's model. Never while a password field has the focus.", "0"),
            Setting("autoUpdate", "Update automatically", "toggle", "Desktop", "When a newer desktop app is on this hub, download it, check it and restart into it.", "1"),
            Setting("confirmRisky", "Ask before risky actions", "toggle", "Desktop", "Axis asks you first (Allow or Deny, here or on a device near you) when an agent would click Send, Delete, Buy and the like, or press Enter in a chat, mail or payment window.", "1"),
            Setting("autoOcr", "Read pixels when a window says little", "toggle", "Desktop", "When a window exposes few controls (games, canvases, some apps), also read its text from the pixels.", "1"),
            Setting("listenCue", "Listening cue", "toggle", "Sound", "A short rising tone when it starts listening. Never in quiet hours.", "1"),
            Setting("taskChime", "Task chime", "toggle", "Sound", "Two soft notes when an agent's long task finishes. Never in quiet hours.", "1"),
            new JsonObject { ["key"] = "pointerSize", ["label"] = "Pointer size", ["kind"] = "number", ["group"] = "Desktop", ["default"] = 44, ["min"] = 24, ["max"] = 120, ["unit"] = "px" }),
        ["actions"] = new JsonArray(
            new JsonObject { ["name"] = "desktop.hello", ["label"] = "Show the pointer", ["help"] = "The pointer appears in the middle of the screen for a few seconds." },
            new JsonObject { ["name"] = "chime", ["label"] = "Play the chime", ["help"] = "A small bell, as before a timer is announced. Needs talking from this computer on; never in quiet hours." }),
        ["links"] = new JsonArray(),
    });

    static JsonObject Setting(string key, string label, string kind, string group, string help, string def) =>
        new() { ["key"] = key, ["label"] = label, ["kind"] = kind, ["group"] = group, ["help"] = help, ["default"] = def };
}

/** How well a name fits what someone asked for, 0 for not at all. Shared by element, app and window matching. */
public static class Fuzzy
{
    public static string Norm(string s) => string.Join(' ', s.ToLowerInvariant().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim('.', '…', ':', ' ');

    public static int Score(string name, string query)
    {
        var n = Norm(name);
        var q = Norm(query);
        if (n.Length == 0 || q.Length == 0) return 0;
        if (n == q) return 100;
        if (n.StartsWith(q, StringComparison.Ordinal)) return 85;
        if (n.Contains(" " + q, StringComparison.Ordinal)) return 75;
        if (q.Length >= 3 && n.Contains(q, StringComparison.Ordinal)) return 65;
        var words = q.Split(' ');
        return words.Length > 1 && words.All(w => n.Contains(w, StringComparison.Ordinal)) ? 55 : 0;
    }
}
