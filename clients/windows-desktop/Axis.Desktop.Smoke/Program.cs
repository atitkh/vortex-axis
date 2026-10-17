// Usage: smoke <axis address> <pairing code> [seconds to stay connected]
// Pairs as "Smoke PC", connects, and answers desktop.look / desktop.point from a fake screen,
// printing what it was asked. Exits 0 once it has stayed connected for the given time.
// Or: smoke check. Runs the Core's checks (Checks.cs) with no Axis, and exits 0 when all pass.
using Axis.Desktop;

if (args is ["check"]) return await Checks.RunAsync();
if (args.Length < 2) { Console.Error.WriteLine("usage: smoke <address> <code> [seconds]"); return 2; }
var address = AxisAddress.Parse(args[0]);
var seconds = args.Length > 2 ? int.Parse(args[2]) : 20;
var identity = DesktopIdentity.Create("0.0.0-smoke");
var pairing = await AxisLink.PairAsync(address, args[1], "Smoke PC", identity);
Console.WriteLine($"paired as {pairing.Name} ({pairing.ClientId})");

var commands = new DesktopCommands(new FakeDesktop());
commands.Did += line => Console.WriteLine($"did: {line}");
await using var link = new AxisLink(pairing, identity) { OnCommand = commands.HandleAsync };
link.StateChanged += (state, why) => Console.WriteLine($"link: {state}{(why != null ? $" ({why})" : "")}");
link.SettingsChanged += values => { commands.UseSettings(values); Console.WriteLine($"settings: {values.Count} values"); };
link.Start();
await Task.Delay(TimeSpan.FromSeconds(seconds));
var online = link.State == LinkState.Online;
await link.StopAsync();
return online ? 0 : 1;

sealed class FakeDesktop : IDesktop
{
    /** Its controls carry a Ref, as the Windows app's do, so they can be read again after a scroll. */
    public bool Live { get; init; }
    /** How far the page has moved up, by the scrolls so far. */
    public int Scrolled { get; private set; }
    public (int X, int Y) Centre => (960, 540);
    public Task<LookResult> LookAsync(string scope, OcrMode ocr, CancellationToken ct)
    {
        Console.WriteLine($"asked to look: scope {scope}, ocr {ocr}");
        var elements = new List<ScreenElement>
        {
            new("window", "Chat - Discord", 0, -1080, 1920, 1040),
            new("edit", "Message #general", 300, -100, 1200, 40, Focused: true),
        };
        // A busy window: 400 lines of text far from the mouse, then the button the mouse is on.
        for (var i = 0; i < 400; i++) elements.Add(new("text", $"message {i}", 300, -1000 + i * 2, 900, 20));
        elements.Add(new("button", "Send", 1510, -100, 60, 40));
        elements.Add(new("text", "Send", 1520, -95, 30, 20));  // the button's own label, inside it
        elements.Add(new("edit", "Search", 100, -1060, 300, 30));
        elements.Add(new("hyperlink", "Settings", 10, -900, 80, 20));
        elements.Add(new("button", "Settings", 1800, -1060, 30, 30));
        if (Live) elements = elements.Select(e => e with { Ref = new object() }).ToList();
        return Task.FromResult(new LookResult(new WindowInfo("Chat - Discord", "Discord", 0, -1080, 1920, 1040), 1530, -85, elements, 1920, 2160, false,
            0, -1080, [new Display(0, 0, 1920, 1080, true), new Display(0, -1080, 1920, 1080, false)]));
    }
    public Task PointAsync(int x, int y, string? text, double seconds, CancellationToken ct)
    {
        Console.WriteLine($"pointing at {x},{y} for {seconds}s: {text}");
        return Task.CompletedTask;
    }
    public Task HideAsync() { Console.WriteLine("hidden"); return Task.CompletedTask; }
    public Task<(string How, int X, int Y)> ClickAsync(ScreenElement? target, int x, int y, ClickKind kind, CancellationToken ct)
    {
        Console.WriteLine($"{kind} click at {x},{y} on {target?.Name}");
        return Task.FromResult((target != null ? "invoked" : "mouse", x, y));
    }
    public Task<ScreenElement?> RefreshAsync(ScreenElement e, CancellationToken ct)
    {
        // The page moved up by Scrolled; what went above the window's top is gone.
        var moved = e with { Y = e.Y - Scrolled };
        return Task.FromResult<ScreenElement?>(moved.Y + moved.H <= -1080 ? null : moved);
    }
    public Task<string> DragAsync(ScreenElement? from, int x1, int y1, ScreenElement? to, int x2, int y2, int holdMs, CancellationToken ct)
    {
        Console.WriteLine($"drag from {x1},{y1} ({from?.Name}) to {x2},{y2} ({to?.Name}), hold {holdMs} ms");
        return Task.FromResult("mouse");
    }
    public Task TypeAsync(ScreenElement? target, string text, CancellationToken ct)
    {
        Console.WriteLine($"typing {text.Length} characters into {target?.Name ?? "the focus"}");
        return Task.CompletedTask;
    }
    public Task KeysAsync(KeyCombo combo, CancellationToken ct) { Console.WriteLine($"pressing {combo}"); return Task.CompletedTask; }
    public Task<(string, WindowInfo?)> OpenAsync(string? app, string? url, CancellationToken ct) { Console.WriteLine($"opening {app ?? url}"); return Task.FromResult<(string, WindowInfo?)>((app ?? url!, new WindowInfo(app ?? url!, app ?? "browser", 0, 0, 800, 600))); }
    public Task<WindowInfo> SwitchAsync(string window, CancellationToken ct) { Console.WriteLine($"switching to {window}"); return Task.FromResult(new WindowInfo("Chat - Discord", "Discord", 0, -1080, 1920, 1040)); }
    public Task<WindowInfo> WindowAsync(string op, string? window, int? display, CancellationToken ct) { Console.WriteLine($"window {op} {window} {display}"); return Task.FromResult(new WindowInfo("Chat - Discord", "Discord", 0, 0, 1920, 1040)); }
    public Task<ScreenState> StateAsync(CancellationToken ct) =>
        Task.FromResult(new ScreenState(new WindowInfo("Chat - Discord", "Discord", 0, -1080, 1920, 1040), new ScreenElement("edit", "Message #general", 300, -100, 1200, 40, "hello", true)));
    public Task<Shot> ScreenshotAsync(string scope, ScreenElement? region, int maxSide, CancellationToken ct)
    {
        Console.WriteLine($"picture of {(region?.Name ?? scope)}, at most {maxSide}px");
        return Task.FromResult(new Shot([0xFF, 0xD8, 0xFF, 0xD9], 1024, 576, 0, -1080, 1920, 1080, new WindowInfo("Chat - Discord", "Discord", 0, -1080, 1920, 1040)));
    }
    public Task<string> ScrollAsync(ScreenElement? target, string go, int pages, CancellationToken ct)
    {
        Console.WriteLine($"scroll {go} {pages}");
        Scrolled += go == "down" ? 300 * pages : go == "up" ? -300 * pages : 0;
        return Task.FromResult("wheel");
    }
    public Task<WindowInfo?> FindWindowAsync(string query, CancellationToken ct) => Task.FromResult<WindowInfo?>(query.Contains("Discord") ? new WindowInfo("Chat - Discord", "Discord", 0, 0, 10, 10) : null);
    public Task<(string?, string?)> ReadClipboardAsync(CancellationToken ct) => Task.FromResult<(string?, string?)>(("copied text", null));
    public Task PasteAsync(ScreenElement? target, string text, CancellationToken ct) { Console.WriteLine($"paste {text.Length}"); return Task.CompletedTask; }
    public Task DesktopAsync(bool next, CancellationToken ct) { Console.WriteLine($"desktop {(next ? "next" : "previous")}"); return Task.CompletedTask; }
}
