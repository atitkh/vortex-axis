// Usage: smoke <axis address> <pairing code> [seconds to stay connected]
// Pairs as "Smoke PC", connects, and answers desktop.look / desktop.point from a fake screen,
// printing what it was asked. Exits 0 once it has stayed connected for the given time.
using Axis.Desktop;

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
        return Task.FromResult(new LookResult(new WindowInfo("Chat - Discord", "Discord", 0, -1080, 1920, 1040), 1530, -85, elements, 1920, 2160, false,
            0, -1080, [new Display(0, 0, 1920, 1080, true), new Display(0, -1080, 1920, 1080, false)]));
    }
    public Task PointAsync(int x, int y, string? text, double seconds, CancellationToken ct)
    {
        Console.WriteLine($"pointing at {x},{y} for {seconds}s: {text}");
        return Task.CompletedTask;
    }
    public Task HideAsync() { Console.WriteLine("hidden"); return Task.CompletedTask; }
}
