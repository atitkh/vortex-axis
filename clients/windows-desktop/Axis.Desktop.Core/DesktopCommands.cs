using System.Text.Json;
using System.Text.Json.Nodes;

namespace Axis.Desktop;

/** Something readable on the screen: a control the window exposes, or text read from its pixels. */
public sealed record ScreenElement(string Kind, string Name, int X, int Y, int W, int H, string? Value = null, bool Focused = false, string Source = "ui");

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
