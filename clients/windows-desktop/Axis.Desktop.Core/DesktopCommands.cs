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
 * What a look found. Coordinates are screen pixels, the same ones pointing takes; the whole desktop is
 * the box (ScreenX, ScreenY, ScreenW, ScreenH), which starts left of or above 0 when a display sits there.
 */
public sealed record LookResult(WindowInfo? Window, int MouseX, int MouseY, IReadOnlyList<ScreenElement> Elements, int ScreenW, int ScreenH, bool Ocr,
    int ScreenX = 0, int ScreenY = 0, IReadOnlyList<Display>? Monitors = null);

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
     * Clicks `target` (from the last look) or (x, y). Returns how: "invoked" when the control was pressed
     * directly, without the mouse; "mouse" when a real click was sent there (and the mouse put back).
     */
    Task<string> ClickAsync(ScreenElement? target, int x, int y, ClickKind kind, CancellationToken ct);
    /** Types `text` into `target`, or into whatever has the focus. Refuses a password field. */
    Task TypeAsync(ScreenElement? target, string text, CancellationToken ct);
    /** Presses one key combination. */
    Task KeysAsync(KeyCombo combo, CancellationToken ct);
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
            return await RunAsync(name, p, ct);
        }
        catch (Exception e)
        {
            // Said in the app as well as to the agent, so the person sees why it failed.
            var why = string.IsNullOrWhiteSpace(e.Message) ? $"{e.GetType().Name} (0x{e.HResult:X8})" : $"{e.Message} ({e.GetType().Name})";
            Did?.Invoke($"{name} failed: {why}");
            return CommandAnswer.Fail(why);
        }
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
                var look = await desktop.LookAsync(scope, ocr, ct);
                var elements = Pick(look.Elements, look.MouseX, look.MouseY, MaxElements);
                lock (gate) last = elements;
                Did?.Invoke($"Looked at the {scope}: {elements.Count} things{(look.Ocr ? ", text read from the pixels" : "")}");
                return CommandAnswer.Done(data: LookData(look, elements));
            }
            case "desktop.point":
            {
                int x, y;
                string? label = null;
                if (Int(p, "id") is int id)
                {
                    ScreenElement? e;
                    lock (gate) e = id >= 1 && id <= last.Count ? last[id - 1] : null;
                    if (e == null) return CommandAnswer.Fail($"no element {id} in the last look; look again");
                    (x, y, label) = (e.X + e.W / 2, e.Y + e.H / 2, e.Name);
                }
                else if (Int(p, "x") is int px && Int(p, "y") is int py) (x, y) = (px, py);
                else return CommandAnswer.Fail("point needs an id, or x and y");
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
            case "desktop.click" or "desktop.type" or "desktop.keys":
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

    /** Clicking, typing and keys: switched off by the person (Axis's allowInput), and held to the app's own limits. */
    async Task<CommandAnswer> ActAsync(string name, JsonElement p, CancellationToken ct)
    {
        if (!Toggle("allowInput", true)) return CommandAnswer.Fail("clicking and typing are switched off for this computer");
        ScreenElement? target = null;
        if (Int(p, "id") is int id)
        {
            lock (gate) target = id >= 1 && id <= last.Count ? last[id - 1] : null;
            if (target == null) return CommandAnswer.Fail($"no element {id} in the last look; look again");
        }
        switch (name)
        {
            case "desktop.click":
            {
                int x, y;
                if (target != null) (x, y) = (target.X + target.W / 2, target.Y + target.H / 2);
                else if (Int(p, "x") is int px && Int(p, "y") is int py) (x, y) = (px, py);
                else return CommandAnswer.Fail("click needs an id, or x and y");
                var kind = (Str(p, "button") ?? "left") switch
                {
                    "left" => ClickKind.Left,
                    "right" => ClickKind.Right,
                    "double" => ClickKind.Double,
                    var other => throw new FormatException($"button must be left, right or double, not {other}"),
                };
                var how = await desktop.ClickAsync(target, x, y, kind, ct);
                Did?.Invoke($"{(kind == ClickKind.Left ? "Clicked" : kind == ClickKind.Right ? "Right-clicked" : "Double-clicked")} {(target != null ? Clip(target.Name, 60) : $"{x}, {y}")}");
                var payload = new JsonObject { ["x"] = x, ["y"] = y, ["how"] = how };
                if (target != null) payload["name"] = Clip(target.Name, 200);
                return CommandAnswer.Done(payload);
            }
            case "desktop.type":
            {
                var text = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString()! : "";
                if (text.Length == 0) return CommandAnswer.Fail("type needs text");
                if (text.Length > MaxTyped) return CommandAnswer.Fail($"at most {MaxTyped} characters at a time");
                if (target?.Kind == "password") return CommandAnswer.Fail("the app never types into a password field");
                await desktop.TypeAsync(target, text, ct);
                Did?.Invoke($"Typed {text.Length} characters{(target != null ? $" into {Clip(target.Name, 60)}" : "")}");
                return CommandAnswer.Done(new JsonObject { ["typed"] = text.Length });
            }
            default:
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
        }
    }

    /** Most text one type sends. */
    public const int MaxTyped = 500;

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
            var o = new JsonObject { ["id"] = i + 1, ["kind"] = e.Kind, ["name"] = Clip(e.Name, MaxText), ["x"] = e.X, ["y"] = e.Y, ["w"] = e.W, ["h"] = e.H };
            if (!string.IsNullOrEmpty(e.Value)) o["value"] = Clip(e.Value!, MaxText);
            if (e.Focused) o["focused"] = true;
            if (e.Source != "ui") o["from"] = e.Source;
            list.Add(o);
        }
        var data = new JsonObject
        {
            ["screen"] = new JsonObject { ["x"] = look.ScreenX, ["y"] = look.ScreenY, ["w"] = look.ScreenW, ["h"] = look.ScreenH },
            ["mouse"] = new JsonObject { ["x"] = look.MouseX, ["y"] = look.MouseY },
        };
        if (look.Window is { } w)
            data["window"] = new JsonObject { ["title"] = Clip(w.Title, 200), ["app"] = w.App, ["x"] = w.X, ["y"] = w.Y, ["w"] = w.W, ["h"] = w.H };
        if (look.Monitors is { Count: > 0 } monitors)
            data["monitors"] = new JsonArray(monitors.Select(m => (JsonNode?)new JsonObject { ["x"] = m.X, ["y"] = m.Y, ["w"] = m.W, ["h"] = m.H, ["primary"] = m.Primary }).ToArray());
        if (under is int u) data["underMouse"] = u;
        data["elements"] = list;
        if (look.Elements.Count > elements.Count) data["more"] = look.Elements.Count - elements.Count;
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

    public static ClientIdentity Create(string version) => new(Type, version, ["desktop"], new JsonObject
    {
        ["settings"] = new JsonArray(
            Setting("allowLook", "Let agents read the screen", "toggle", "Desktop", "Off refuses every look. The person at the computer can also pause the app from its window or tray.", "1"),
            Setting("allowInput", "Let agents click and type", "toggle", "Desktop", "Off refuses clicks, typing and key presses; looking and pointing go on. The app never types into a password field or presses lock, sign-out, Task Manager or Alt+F4.", "1"),
            Setting("bubble", "Words beside the pointer", "toggle", "Desktop", "Show what the agent says next to its pointer.", "1"),
            Setting("autoOcr", "Read pixels when a window says little", "toggle", "Desktop", "When a window exposes few controls (games, canvases, some apps), also read its text from the pixels.", "1"),
            new JsonObject { ["key"] = "pointerSize", ["label"] = "Pointer size", ["kind"] = "number", ["group"] = "Desktop", ["default"] = 44, ["min"] = 24, ["max"] = 120, ["unit"] = "px" }),
        ["actions"] = new JsonArray(
            new JsonObject { ["name"] = "desktop.hello", ["label"] = "Show the pointer", ["help"] = "The pointer appears in the middle of the screen for a few seconds." }),
        ["links"] = new JsonArray(),
    });

    static JsonObject Setting(string key, string label, string kind, string group, string help, string def) =>
        new() { ["key"] = key, ["label"] = label, ["kind"] = kind, ["group"] = group, ["help"] = help, ["default"] = def };
}
