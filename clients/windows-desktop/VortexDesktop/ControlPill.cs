using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace Axis.Desktop.App;

/**
 * A small pill at the top of the main screen while an agent is using this computer (looking, clicking,
 * typing): a rose dot that breathes, "VorteX is using this computer" and the last thing it did. It shows
 * from the first desktop command until a few seconds after the last. Click-through, never takes the focus,
 * and steps out of the picture when the screen is captured.
 */
sealed class ControlPill : Window
{
    /** How long after the last command it stays: the agent thinks between calls. Matches Axis's own count. */
    static readonly TimeSpan Linger = TimeSpan.FromSeconds(8);

    readonly Border dot = new() { Width = 10, Height = 10, CornerRadius = new CornerRadius(5), Margin = new Thickness(0, 0, 10, 0), VerticalAlignment = VerticalAlignment.Center, Background = new SolidColorBrush(Color.FromRgb(0xFF, 0x52, 0x9E)) };
    readonly TextBlock doing = new() { Foreground = new SolidColorBrush(Color.FromRgb(0xA8, 0xA8, 0xB4)), FontSize = 12, Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 300 };
    readonly DispatcherTimer away = new() { Interval = Linger };
    bool wanted;
    /** It came or went: what sits under it moves. */
    public event Action? Moved;
    /** The room it takes at the top of the screen, 0 when hidden. */
    public double Room => IsVisible ? ActualHeight + 6 : 0;

    public ControlPill()
    {
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.WidthAndHeight;
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(dot);
        row.Children.Add(new TextBlock { Text = "VorteX is using this computer", Foreground = Brushes.White, FontWeight = FontWeights.SemiBold, FontSize = 12, VerticalAlignment = VerticalAlignment.Center });
        row.Children.Add(doing);
        Content = new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(0xEE, 0x0B, 0x0B, 0x10)),
            BorderBrush = new SolidColorBrush(Color.FromArgb(0x90, 0xFF, 0x52, 0x9E)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(15),
            Padding = new Thickness(14, 7, 16, 7),
            Child = row,
        };
        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            var style = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
            Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, style | Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
        };
        SizeChanged += (_, _) => Place();
        IsVisibleChanged += (_, _) => Moved?.Invoke();
        dot.BeginAnimation(OpacityProperty, new DoubleAnimation(1, 0.35, TimeSpan.FromMilliseconds(700)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever });
        away.Tick += (_, _) =>
        {
            away.Stop();
            wanted = false;
            Hide();
        };
    }

    void Place()
    {
        var area = SystemParameters.WorkArea;
        Left = area.Left + (area.Width - ActualWidth) / 2;
        Top = area.Top + 10;
    }

    /** An agent's command has just come in. */
    public void Touch()
    {
        wanted = true;
        away.Stop();
        away.Start();
        if (!IsVisible) Show();
        Place();
    }

    /** What it just did, in the app's own words. */
    public void Did(string line)
    {
        doing.Text = line;
        doing.Visibility = line.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /** Out of the picture for a capture of the screen; back a moment later if the agent is still at it. */
    public void StepAside()
    {
        if (!IsVisible) return;
        Hide();
        var back = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(600) };
        back.Tick += (_, _) =>
        {
            back.Stop();
            if (wanted) { Show(); Place(); }
        };
        back.Start();
    }
}
