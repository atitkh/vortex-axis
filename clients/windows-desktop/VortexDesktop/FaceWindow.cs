using System;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace Axis.Desktop.App;

/**
 * Vortex's face on this computer: the one the boards draw (Core's `Face`), on a dark disc at the bottom
 * centre of the main screen. It fades in for a voice turn and while an agent is using the computer, and
 * out a moment after; or stays, when asked to, and then a click on it talks. It never takes the focus
 * and steps out of the picture when the screen is captured.
 */
sealed class FaceWindow : Window
{
    const double Side = 132;
    readonly Face face = new();
    readonly Canvas canvas;
    readonly DispatcherTimer leave = new() { Interval = TimeSpan.FromSeconds(2.5) };
    IntPtr hwnd;
    bool wanted, keep, shown;
    TimeSpan last;

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

    void Place()
    {
        var area = SystemParameters.WorkArea;
        Left = area.Left + (area.Width - Side) / 2;
        Top = area.Bottom - Side - 18;
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
        face.Level = mode == VoiceMode.Listening ? level : -1;
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
        static readonly Brush Disc = new SolidColorBrush(Color.FromArgb(0xEE, 0x0B, 0x0B, 0x10));

        public Canvas(Face face) => this.face = face;

        protected override void OnRender(DrawingContext g)
        {
            var (dots, core, icon) = face.Frame(Dt);
            Dt = 0;
            var half = ActualWidth / 2;
            // The disc's edge takes the core's colour, as the pills' edges take their state's.
            var edge = core is { } c0 ? Color.FromArgb(0x90, B(c0.R), B(c0.G), B(c0.B)) : Color.FromArgb(0x60, 0xFF, 0xFF, 0xFF);
            g.DrawEllipse(Disc, new Pen(new SolidColorBrush(edge), 1), new Point(half, half), half - 1, half - 1);
            // The figure sits inside the disc with a little room.
            var scale = (ActualWidth - 16) / Face.Size;
            g.PushTransform(new TranslateTransform(8, 8));
            g.PushTransform(new ScaleTransform(scale, scale));
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
