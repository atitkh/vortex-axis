using System;
using System.Linq;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace Axis.Desktop.App;

/**
 * Vortex's face on this computer: the one the boards draw (Core's `Face`), on a soft dark pool with faded edges at the bottom
 * centre of the main screen. It fades in for a voice turn and while an agent is using the computer, and
 * out a moment after; or stays, when asked to, and then a click on it talks. It never takes the focus
 * and steps out of the picture when the screen is captured.
 */
sealed class FaceWindow : Window
{
    /** Sizes to choose from: the window's side; the figure fills the middle 60 %, the rest is the shadow fading out. */
    public static readonly (string Id, string Label, double Side)[] Sizes = [("small", "Small", 150), ("medium", "Medium", 200), ("large", "Large", 270)];
    /** Where along the bottom of the main screen it sits. */
    public static readonly (string Id, string Label)[] Places = [("center", "Bottom centre"), ("left", "Bottom left"), ("right", "Bottom right")];
    double Side = 200;
    string place = "center";
    readonly Face face = new();
    readonly Canvas canvas;
    readonly DispatcherTimer leave = new() { Interval = TimeSpan.FromSeconds(2.5) };
    IntPtr hwnd;
    bool wanted, keep, shown;
    TimeSpan last;

    /** The loudness to follow each frame (the person's voice or the agent's), or below 0 for none. */
    public Func<double>? Loudness { get; set; }
    bool voiced;

    /** A click on the face, when it is kept on screen. */
    public event Action? Clicked;

    public FaceWindow()
    {
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        ResizeMode = ResizeMode.NoResize;
        Width = Height = Side;
        Opacity = 0;
        Content = canvas = new Canvas(face) { Width = Side, Height = Side };
        SourceInitialized += (_, _) =>
        {
            hwnd = new WindowInteropHelper(this).Handle;
            ApplyStyle();
        };
        MouseLeftButtonDown += (_, _) => Clicked?.Invoke();
        leave.Tick += (_, _) =>
        {
            leave.Stop();
            if (!wanted && !keep) FadeTo(0);
        };
        CompositionTarget.Rendering += (_, e) =>
        {
            if (!IsVisible) return;
            var at = ((RenderingEventArgs)e).RenderingTime;
            if (at == last) return;
            canvas.Dt = last == TimeSpan.Zero ? 0 : (at - last).TotalSeconds;
            last = at;
            // Every frame, not only when the voice part reports: the agent's voice changes faster than its state.
            face.Level = voiced ? Loudness?.Invoke() ?? -1 : -1;
            canvas.InvalidateVisual();
        };
    }

    /** Click-through unless it is kept on screen, when a click on it talks. Never takes the focus either way. */
    void ApplyStyle()
    {
        if (hwnd == IntPtr.Zero) return;
        var style = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE) | Native.WS_EX_LAYERED | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
        style = keep ? style & ~Native.WS_EX_TRANSPARENT : style | Native.WS_EX_TRANSPARENT;
        Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, style);
    }

    /** Size and place, from the settings. */
    public void Look(string size, string where)
    {
        Side = Sizes.FirstOrDefault(z => z.Id == size).Side is > 0 and var side ? side : 200;
        place = where;
        Width = Height = canvas.Width = canvas.Height = Side;
        if (IsVisible) Place();
    }

    void Place()
    {
        var area = SystemParameters.WorkArea;
        Left = place == "left" ? area.Left - Side * 0.12 : place == "right" ? area.Right - Side * 0.88 : area.Left + (area.Width - Side) / 2;
        Top = area.Bottom - Side + 6;
    }

    void FadeTo(double to)
    {
        if (to > 0 && !IsVisible)
        {
            last = TimeSpan.Zero;
            Show();
            Place();
        }
        shown = to > 0;
        var fade = new DoubleAnimation(to, TimeSpan.FromMilliseconds(to > 0 ? 220 : 450));
        if (to == 0) fade.Completed += (_, _) => { if (!shown) Hide(); };
        BeginAnimation(OpacityProperty, fade);
    }

    /** Whether it stays on screen between turns (idle, drifting through its looks). */
    public void Keep(bool on)
    {
        keep = on;
        ApplyStyle();
        Update();
    }

    /**
     * What to show: the voice part's mode and loudness, what the agent is doing, and whether an agent is
     * using this computer (shown as thinking with the computer icon when nothing else is going on).
     */
    public void Set(VoiceMode mode, double level, string? doing, bool agentHere)
    {
        var name = mode switch
        {
            VoiceMode.Listening => "listening",
            VoiceMode.Transcribing or VoiceMode.Thinking => "thinking",
            VoiceMode.Speaking => "speaking",
            VoiceMode.Error => "error",
            _ => agentHere ? "thinking" : "idle",
        };
        face.SetMode(name);
        voiced = mode is VoiceMode.Listening or VoiceMode.Speaking;
        face.SetDoing(name == "thinking" ? (agentHere ? "computer" : doing) : null);
        wanted = name != "idle";
        Update();
    }

    void Update()
    {
        if (wanted || keep)
        {
            leave.Stop();
            if (!shown) FadeTo(1);
        }
        else if (shown && !leave.IsEnabled) leave.Start();
    }

    /** Out of the picture for a capture of the screen; back a moment later if it is still wanted. */
    public void StepAside()
    {
        if (!IsVisible) return;
        BeginAnimation(OpacityProperty, null);
        Opacity = 0;
        Hide();
        shown = false;
        var back = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(600) };
        back.Tick += (_, _) =>
        {
            back.Stop();
            if (wanted || keep) FadeTo(1);
        };
        back.Start();
    }

    /** Paints the face: a dark disc, then the dots, the core and the pen icon, scaled from the face's 240 square. */
    sealed class Canvas : FrameworkElement
    {
        readonly Face face;
        public double Dt;
        /** A soft dark pool behind the figure that fades to nothing at its edge: no outline, so it sits on any wallpaper or window. */
        static readonly Brush Shade = Frozen(new RadialGradientBrush(new GradientStopCollection
        {
            new(Color.FromArgb(0xE6, 0x06, 0x06, 0x0A), 0.0),
            new(Color.FromArgb(0xD0, 0x06, 0x06, 0x0A), 0.45),
            new(Color.FromArgb(0x70, 0x06, 0x06, 0x0A), 0.72),
            new(Color.FromArgb(0x00, 0x06, 0x06, 0x0A), 1.0),
        }));

        static Brush Frozen(Brush b) { b.Freeze(); return b; }

        public Canvas(Face face) => this.face = face;

        protected override void OnRender(DrawingContext g)
        {
            var (dots, core, icon) = face.Frame(Dt);
            Dt = 0;
            var half = ActualWidth / 2;
            g.DrawEllipse(Shade, null, new Point(half, half), half, half);
            // The figure in the middle of the pool, with room round it for the fade.
            var inset = ActualWidth * 0.2;
            var scale = (ActualWidth - inset * 2) / Face.Size;
            g.PushTransform(new TranslateTransform(inset, inset));
            g.PushTransform(new ScaleTransform(scale, scale));
            // Each dot gives off a little light of its own colour, as on the boards' panels, where overlapping dots add up.
            foreach (var d in dots)
                g.DrawEllipse(new SolidColorBrush(Color.FromArgb(0x26, B(d.R), B(d.G), B(d.B))), null, new Point(d.X, d.Y), d.Radius * 2.4, d.Radius * 2.4);
            if (core is { } glow)
                g.DrawEllipse(new SolidColorBrush(Color.FromArgb(0x30, B(glow.R), B(glow.G), B(glow.B))), null, new Point(glow.X, glow.Y), glow.Radius * 2.6, glow.Radius * 2.6);
            foreach (var d in dots)
                g.DrawEllipse(new SolidColorBrush(Color.FromRgb(B(d.R), B(d.G), B(d.B))), null, new Point(d.X, d.Y), d.Radius, d.Radius);
            if (core is { } c)
                g.DrawEllipse(new SolidColorBrush(Color.FromRgb(B(c.R), B(c.G), B(c.B))), null, new Point(c.X, c.Y), c.Radius, c.Radius);
            if (icon != null)
            {
                var pen = new Pen(new SolidColorBrush(Color.FromArgb(B(icon.Alpha), B(icon.R), B(icon.G), B(icon.B))), icon.Width)
                    { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round, LineJoin = PenLineJoin.Round };
                foreach (var stroke in icon.Strokes)
                    for (var i = 2; i < stroke.Length; i += 2)
                        g.DrawLine(pen, new Point(stroke[i - 2], stroke[i - 1]), new Point(stroke[i], stroke[i + 1]));
            }
            g.Pop();
            g.Pop();
        }

        static byte B(double v) => (byte)Math.Clamp(v * 255, 0, 255);
    }
}
