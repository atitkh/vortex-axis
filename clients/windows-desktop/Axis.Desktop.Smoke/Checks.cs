using System.Text.Json;
using Axis.Desktop;

/** The Core's checks that need no Axis: where clicks land, and ids after a scroll. `smoke check`. */
static class Checks
{
    static int failed, passed;

    static void Is<T>(T actual, T expected, string what)
    {
        if (EqualityComparer<T>.Default.Equals(actual, expected)) passed++;
        else { failed++; Console.WriteLine($"FAIL {what}: got {actual}, wanted {expected}"); }
    }

    static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement;

    public static async Task<int> RunAsync()
    {
        Clipping();
        ChromeBand();
        await AfterScrollAsync();
        Console.WriteLine($"{passed} passed, {failed} failed");
        return failed == 0 ? 0 : 1;
    }

    static void Clipping()
    {
        var window = new Box(0, 0, 1000, 900);
        var page = new Box(0, 100, 1000, 800);  // under 100 px of tabs and address bar
        // A field half under the top of the page: its middle is on the address bar, the part that shows is not.
        var field = new Box(100, 50, 400, 90);
        var shown = Geometry.Visible(field, [page, window]);
        Is(shown, new Box(100, 100, 400, 40), "the part of a half-hidden field that shows");
        Is(field.Centre.Y < page.Y, true, "the whole field's middle is above the page");
        Is(shown!.Value.Centre, (300, 120), "the middle of what shows is in the page");
        Is(Math.Round(Geometry.Fraction(field, shown), 2), 0.44, "4/9 of it shows");
        Is(Geometry.Enough(field, shown), true, "over 40% is enough to click");
        // A thin sliver: scrolled into view first.
        var sliver = new Box(100, 70, 400, 40);
        Is(Geometry.Enough(sliver, Geometry.Visible(sliver, [page])), false, "a quarter of a field is not enough");
        // Wholly above the page: nothing shows.
        Is(Geometry.Visible(new Box(100, 20, 400, 40), [page]), null, "a field scrolled above the page");
        Is(Geometry.Enough(new Box(100, 20, 400, 40), null), false, "nothing showing is not enough");
        Is(Geometry.Fraction(new Box(100, 20, 400, 40), null), 0.0, "nothing showing is 0");
        // A big control with a big piece showing is clicked there, whatever share that is.
        var tall = new Box(0, -1000, 1000, 3000);
        Is(Geometry.Enough(tall, Geometry.Visible(tall, [page])), true, "a big piece of a tall pane is enough");
        // A frame inside the page, itself half scrolled out: cut by both.
        var frame = new Box(200, 50, 400, 300);
        Is(Geometry.Visible(new Box(250, 80, 100, 40), [frame, page, window]), new Box(250, 100, 100, 20), "a control in a frame, cut by the frame and the page");
        // Wholly inside: as it is.
        Is(Geometry.Visible(new Box(10, 500, 50, 20), [page, window]), new Box(10, 500, 50, 20), "a control wholly in the page");
        Is(Geometry.Shown(new ScreenElement("edit", "Search", 100, 60, 400, 80), new Box(100, 100, 400, 40)),
            new ScreenElement("edit", "Search", 100, 100, 400, 40), "an element cut to what shows");
    }

    static void ChromeBand()
    {
        var chrome = new WindowInfo("Shop - Google Chrome", "chrome", 0, 0, 1000, 900);
        var page = new Box(0, 90, 1000, 810);
        Is(Geometry.IsBrowser("chrome"), true, "chrome is a browser");
        Is(Geometry.IsBrowser("MSEdge.exe"), true, "msedge.exe is a browser");
        Is(Geometry.IsBrowser("firefox"), true, "firefox is a browser");
        Is(Geometry.IsBrowser("notepad"), false, "notepad is not");
        Is(Geometry.ChromeRefusal(chrome, 50, true, page) != null, true, "a page control clicked on the address bar is refused");
        Is(Geometry.ChromeRefusal(chrome, 95, true, page), null, "a page control just below the bar, inside the band, is clicked");
        Is(Geometry.ChromeRefusal(chrome, 50, false, null), null, "the address bar itself is clicked");
        Is(Geometry.ChromeRefusal(chrome, 50, false, page), null, "a tab or button is clicked");
        Is(Geometry.ChromeRefusal(chrome, 300, true, page), null, "below the band, anything goes");
        Is(Geometry.ChromeRefusal(chrome with { App = "notepad" }, 50, true, page), null, "not a browser: not refused");
        Is(Geometry.ChromeRefusal(chrome, 50, true, new Box(0, 0, 1000, 900)), null, "a full-screen page is clicked at the top");
        Is(Geometry.ChromeRefusal(chrome, 50, true, new Box(0, -2000, 1000, 5000)) != null, true, "a page box reaching above the window says nothing: refused");
        Is(Geometry.ChromeRefusal(chrome, 50, true, null) != null, true, "in a page with no box: refused");
        Is(Geometry.ChromeRefusal(chrome with { Y = -8 }, -8 + 99, true, null) != null, true, "a maximized window's band starts at its own top");
        Is(Geometry.ChromeRefusal(null, 50, true, page), null, "no window in front: not refused");
    }

    static async Task AfterScrollAsync()
    {
        var ct = CancellationToken.None;
        // Text read from the pixels (no Ref) cannot be read again: after a scroll its id is refused.
        var flat = new DesktopCommands(new FakeDesktop());
        Is((await flat.HandleAsync("desktop.look", Json("{}"), ct)).Ok, true, "look");
        Is((await flat.HandleAsync("desktop.click", Json("""{"id":2}"""), ct)).Ok, true, "click by id before a scroll");
        Is((await flat.HandleAsync("desktop.scroll", Json("""{"go":"down"}"""), ct)).Ok, true, "scroll");
        var stale = await flat.HandleAsync("desktop.click", Json("""{"id":2}"""), ct);
        Is(stale.Ok, false, "click by id after a scroll, nothing to read again");
        Is(stale.Error?.StartsWith("scrolled since the last look"), true, $"says why ({stale.Error})");
        Is((await flat.HandleAsync("desktop.point", Json("""{"id":2}"""), ct)).Ok, false, "point by id after a scroll");
        Is((await flat.HandleAsync("desktop.click", Json("""{"name":"Send"}"""), ct)).Ok, true, "click by name after a scroll (read afresh)");
        Is((await flat.HandleAsync("desktop.click", Json("""{"id":2}"""), ct)).Ok, true, "click by id once looked again");

        // Controls the platform can read again: clicked where they are now.
        var fake = new FakeDesktop { Live = true };
        var live = new DesktopCommands(fake);
        await live.HandleAsync("desktop.look", Json("{}"), ct);
        var before = await live.HandleAsync("desktop.click", Json("""{"id":2}"""), ct);
        Is(before.Payload?["y"]?.GetValue<int>(), -80, "the field's middle before the scroll");
        await live.HandleAsync("desktop.scroll", Json("""{"go":"down"}"""), ct);
        var after = await live.HandleAsync("desktop.click", Json("""{"id":2}"""), ct);
        Is(after.Ok, true, "click by id after a scroll, read again");
        Is(after.Payload?["y"]?.GetValue<int>(), -380, "clicked where it is now");
        await live.HandleAsync("desktop.scroll", Json("""{"go":"down","pages":3}"""), ct);
        var gone = await live.HandleAsync("desktop.click", Json("""{"id":2}"""), ct);
        Is(gone.Ok, false, "scrolled off the screen");
        Is(gone.Error?.Contains("off the screen since the scroll"), true, $"says why ({gone.Error})");
        // In steps, a scroll then a click by id: the same.
        await live.HandleAsync("desktop.look", Json("{}"), ct);
        var steps = await live.HandleAsync("desktop.steps", Json("""{"data":{"steps":[{"action":"scroll","go":"down"},{"action":"click","id":2}]}}"""), ct);
        Is(steps.Ok, false, "steps: scroll, then click by id gone off the screen");
        Is(fake.Scrolled, 1500, "every scroll reached the computer");
    }
}
