namespace Axis.Desktop;

/** A box in screen pixels. */
public readonly record struct Box(int X, int Y, int W, int H)
{
    public int Right => X + W;
    public int Bottom => Y + H;
    public long Area => W <= 0 || H <= 0 ? 0 : (long)W * H;
    public (int X, int Y) Centre => (X + W / 2, Y + H / 2);

    public static Box Of(ScreenElement e) => new(e.X, e.Y, e.W, e.H);

    /** The part of this box inside `other`, or null when they do not overlap. */
    public Box? Within(Box other)
    {
        int l = Math.Max(X, other.X), t = Math.Max(Y, other.Y), r = Math.Min(Right, other.Right), b = Math.Min(Bottom, other.Bottom);
        return r > l && b > t ? new Box(l, t, r - l, b - t) : null;
    }

    public bool Inside(Box other) => X >= other.X && Y >= other.Y && Right <= other.Right && Bottom <= other.Bottom;
}

/**
 * Where on a control a click lands, and when it would hit a browser's own bar instead. A control half
 * scrolled under the top of a page keeps a box reaching up into the address bar; its middle can be there.
 * Kept free of Windows so it is checked on any OS (`Axis.Desktop.Smoke check`).
 */
public static class Geometry
{
    /** Under this share of a control showing (and not a big piece of it), it is scrolled into view before a click. */
    public const double MinVisible = 0.4;
    /** A piece at least this wide and tall is enough to click, whatever share of a big control it is. */
    public const int MinSide = 40;
    /** The top of a browser window, where its tabs, address bar and buttons are. */
    public const int ChromeBand = 100;

    /** The part of `box` inside every one of `areas` (the pages it is in, its window), or null when none of it shows. */
    public static Box? Visible(Box box, IEnumerable<Box> areas)
    {
        Box? shown = box;
        foreach (var a in areas)
        {
            shown = shown.Value.Within(a);
            if (shown == null) return null;
        }
        return shown;
    }

    /** How much of `box` shows, 0 to 1. */
    public static double Fraction(Box box, Box? visible) =>
        visible is { } v && box.Area > 0 ? Math.Min(1.0, (double)v.Area / box.Area) : 0;

    /** Enough of a control shows to click it where it shows. */
    public static bool Enough(Box box, Box? visible) =>
        visible is { } v && (Fraction(box, v) >= MinVisible || v.W >= MinSide && v.H >= MinSide);

    /** The element with its box cut to what shows. */
    public static ScreenElement Shown(ScreenElement e, Box visible) =>
        e with { X = visible.X, Y = visible.Y, W = visible.W, H = visible.H };

    static readonly HashSet<string> Browsers =
        ["chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "arc", "chromium", "iexplore", "waterfox", "librewolf", "thorium", "zen", "floorp"];

    /** The app (its process name) is a web browser. */
    public static bool IsBrowser(string? app) => app != null && Browsers.Contains(app.ToLowerInvariant().Replace(".exe", ""));

    /**
     * Why a mouse click at `y` on a control in a web page would land on the browser's own bar instead, or null to
     * go on. Only for a control inside a page (`inPage`): the address bar, tabs and buttons are clicked as ever, and
     * so is a bare x,y. `page` is the page's own box: a page that starts at the top of the window (full screen) may
     * be clicked there; one that reaches above the window says nothing, and the top band is refused.
     */
    public static string? ChromeRefusal(WindowInfo? window, int y, bool inPage, Box? page)
    {
        if (window == null || !inPage || !IsBrowser(window.App) || y < window.Y || y >= window.Y + ChromeBand) return null;
        if (page is { } p && p.Y >= window.Y - 2 && y >= p.Y) return null;
        return "that spot is on the browser's own bar at the top of the window, not the page; scroll up a little so it comes down into the page, look again, and click it there";
    }
}
