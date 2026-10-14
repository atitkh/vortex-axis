using System;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace Axis.Desktop.App;

/**
 * The app's own pointer: a click-through window that never takes focus, drawn over everything, with
 * the tip at the middle. It glides from where it was to the new spot, breathes while it waits, and
 * shows the agent's words beside it, on whichever side has room. The person's own mouse is never moved.
 */
public partial class Overlay : Window
{
    const double TipX = 410, TipY = 210;
    /** How long the pointer takes to glide to a new spot (0.9.0: 320 ms; the app waits for it before acting). */
    public const double GlideMs = 220;

    IntPtr hwnd;
    readonly DispatcherTimer glide = new() { Interval = TimeSpan.FromMilliseconds(15) };
    readonly DispatcherTimer linger = new();
    (double X, double Y) from, to, now;
    DateTime glideStart;
    bool placed;

    public Overlay()
    {
        InitializeComponent();
        SourceInitialized += (_, _) =>
        {
            hwnd = new WindowInteropHelper(this).Handle;
            var style = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
            Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, style | Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
        };
        glide.Tick += (_, _) => Step();
        linger.Tick += (_, _) => _ = HideAsync();
        Breathe();
    }

    double Scale => hwnd == IntPtr.Zero ? 1 : Native.GetDpiForWindow(hwnd) / 96.0;

    /** Shows the pointer with its tip at physical screen pixel (x, y). True when it glides there, false when it appears on the spot. */
    public bool PointAt(int x, int y, string? words, double seconds, double size)
    {
        ArrowScale.ScaleX = ArrowScale.ScaleY = Math.Clamp(size, 24, 120) / 30.0;
        Words.Text = words ?? "";
        Bubble.Visibility = string.IsNullOrWhiteSpace(words) ? Visibility.Collapsed : Visibility.Visible;
        to = (x, y);
        var glides = IsVisible && placed;
        if (!glides)
        {
            // From nowhere: appear on the spot.
            from = now = to;
            Show();
            placed = true;
            Move(to);
        }
        else
        {
            from = now;
            glideStart = DateTime.UtcNow;
            glide.Start();
        }
        PlaceBubble(x, y);
        Opacity = 0;
        BeginAnimation(OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(160)));
        linger.Stop();
        linger.Interval = TimeSpan.FromSeconds(seconds);
        linger.Start();
        return glides;
    }

    public Task HideAsync()
    {
        linger.Stop();
        glide.Stop();
        if (!IsVisible) return Task.CompletedTask;
        var done = new TaskCompletionSource();
        var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(180));
        fade.Completed += (_, _) =>
        {
            Hide();
            placed = false;
            done.TrySetResult();
        };
        BeginAnimation(OpacityProperty, fade);
        return done.Task;
    }

    /** Hidden at once, with no fade: for a screen capture. */
    public void HideNow()
    {
        linger.Stop();
        glide.Stop();
        BeginAnimation(OpacityProperty, null);
        Hide();
        placed = false;
    }

    void Step()
    {
        var t = Math.Min(1, (DateTime.UtcNow - glideStart).TotalMilliseconds / GlideMs);
        var ease = 1 - Math.Pow(1 - t, 3);
        now = (from.X + (to.X - from.X) * ease, from.Y + (to.Y - from.Y) * ease);
        Move(now);
        if (t >= 1) glide.Stop();
    }

    void Move((double X, double Y) tip)
    {
        now = tip;
        var s = Scale;
        Native.SetWindowPos(hwnd, Native.HWND_TOPMOST, (int)Math.Round(tip.X - TipX * s), (int)Math.Round(tip.Y - TipY * s), 0, 0,
            Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_SHOWWINDOW);
    }

    /** Words to the right and below, unless the screen ends there. */
    void PlaceBubble(int x, int y)
    {
        if (Bubble.Visibility != Visibility.Visible) return;
        Bubble.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        var size = Bubble.DesiredSize;
        var s = Scale;
        var screen = System.Windows.Forms.Screen.FromPoint(new System.Drawing.Point(x, y)).WorkingArea;
        var room = ArrowScale.ScaleX * 30;
        var right = x + (room + 8 + size.Width) * s < screen.Right;
        var below = y + (room + 8 + size.Height) * s < screen.Bottom;
        Canvas.SetLeft(Bubble, right ? TipX + room * 0.6 + 8 : TipX - 14 - size.Width);
        Canvas.SetTop(Bubble, below ? TipY + room * 0.9 : TipY - 14 - size.Height);
    }

    void Breathe()
    {
        var pulse = new DoubleAnimation(0.25, 0.8, TimeSpan.FromMilliseconds(900)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = new SineEase() };
        Ring.BeginAnimation(OpacityProperty, pulse);
        var grow = new ScaleTransform(1, 1, 20, 20);
        Ring.RenderTransform = grow;
        var size = new DoubleAnimation(0.85, 1.25, TimeSpan.FromMilliseconds(900)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = new SineEase() };
        grow.BeginAnimation(ScaleTransform.ScaleXProperty, size);
        grow.BeginAnimation(ScaleTransform.ScaleYProperty, size);
    }
}
