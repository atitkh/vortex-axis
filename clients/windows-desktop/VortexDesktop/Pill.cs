using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;

namespace Axis.Desktop.App;

/**
 * The look the app's notices at the top of the screen share: a dark rounded pill with a soft shadow, a thin
 * edge and a glowing dot in the colour of what is going on, fading in and out. Click-through, and it never
 * takes the focus. What goes inside is the notice's own.
 */
abstract class Pill : Window
{
    /** Room round the pill inside its window, for the shadow. */
    protected const double Shadow = 16;

    protected readonly Border Frame;
    protected readonly Border Dot = new() { Width = 9, Height = 9, CornerRadius = new CornerRadius(4.5), VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 4.5, 11, 0) };
    bool up;

    protected static readonly FontFamily Face = new("Segoe UI Variable Text, Segoe UI");
    protected static readonly Brush Dim = Frozen(new SolidColorBrush(Color.FromRgb(0x9A, 0x9C, 0xAA)));
    protected static readonly Brush Bright = Frozen(new SolidColorBrush(Color.FromRgb(0xF2, 0xF3, 0xF7)));

    protected static T Frozen<T>(T b) where T : Freezable { b.Freeze(); return b; }

    protected Pill()
    {
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.WidthAndHeight;
        FontFamily = Face;
        Opacity = 0;
        TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
        Frame = new Border
        {
            Margin = new Thickness(Shadow),
            // A little lighter at the top than at the bottom, like a surface lit from above.
            Background = Frozen(new LinearGradientBrush(Color.FromArgb(0xF4, 0x1A, 0x1B, 0x24), Color.FromArgb(0xF4, 0x0D, 0x0D, 0x13), 90)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(16),
            Padding = new Thickness(15, 9, 17, 10),
            Effect = Frozen(new DropShadowEffect { Color = Colors.Black, BlurRadius = 18, ShadowDepth = 3, Direction = 270, Opacity = 0.5 }),
        };
        Content = Frame;
        Tint(Color.FromRgb(0x8C, 0xF2, 0xFF));
        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            var style = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
            Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, style | Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
        };
        SizeChanged += (_, _) => Place();
    }

    /** Lets clicks land on the pill (a question with buttons); off again, it is click-through as before. */
    protected void Clickable(bool on)
    {
        var hwnd = new WindowInteropHelper(this).EnsureHandle();
        var style = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
        Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, on ? style & ~Native.WS_EX_TRANSPARENT : style | Native.WS_EX_TRANSPARENT);
    }

    /** The colour of what is going on: the dot and its glow, and a hint of it on the edge. */
    protected void Tint(Color c)
    {
        Dot.Background = new SolidColorBrush(c);
        Dot.Effect = new DropShadowEffect { Color = c, BlurRadius = 9, ShadowDepth = 0, Opacity = 0.9 };
        Frame.BorderBrush = new LinearGradientBrush(Color.FromArgb(0x99, c.R, c.G, c.B), Color.FromArgb(0x33, c.R, c.G, c.B), 90);
    }

    /** How far below the top of the work area the pill itself (not its window) sits. */
    protected virtual double Down => 10;

    protected void Place()
    {
        var area = SystemParameters.WorkArea;
        Left = area.Left + (area.Width - ActualWidth) / 2;
        Top = area.Top + Down - Shadow;
    }

    /** Whether it is on screen or on its way in. */
    public bool Up => up;
    /** The height of the pill itself. */
    public double PillHeight => Frame.ActualHeight;

    protected void FadeIn()
    {
        if (!IsVisible) Show();
        Place();
        if (up) return;
        up = true;
        BeginAnimation(OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(180)));
        Came();
    }

    protected void FadeOut()
    {
        if (!up) return;
        up = false;
        var fade = new DoubleAnimation(0, TimeSpan.FromMilliseconds(320));
        fade.Completed += (_, _) => { if (!up) Hide(); };
        BeginAnimation(OpacityProperty, fade);
        Went();
    }

    /** Gone at once, for a capture of the screen. */
    protected void Vanish()
    {
        up = false;
        BeginAnimation(OpacityProperty, null);
        Opacity = 0;
        Hide();
    }

    protected virtual void Came() { }
    protected virtual void Went() { }

    protected static TextBlock Words(Brush colour, double size, FontWeight? weight = null) =>
        new() { Foreground = colour, FontSize = size, FontWeight = weight ?? FontWeights.Normal, VerticalAlignment = VerticalAlignment.Center };
}
