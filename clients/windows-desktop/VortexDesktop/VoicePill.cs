using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace Axis.Desktop.App;

/**
 * A small pill at the top of the main screen (the look of the "using this computer" pill, and under it when both show) while talking from this computer: a dot in the face's colour
 * for listening, thinking or speaking (it swells with the voice while listening), what was heard and the reply.
 * Click-through, never takes the focus, and fades a few seconds after the answer.
 */
sealed class VoicePill : Window
{
    readonly Border dot = new() { Width = 10, Height = 10, CornerRadius = new CornerRadius(5), VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 4, 10, 0) };
    readonly TextBlock status = new() { Foreground = Brushes.White, FontWeight = FontWeights.SemiBold, FontSize = 12 };
    readonly TextBlock heard = new() { Foreground = new SolidColorBrush(Color.FromRgb(0xA8, 0xA8, 0xB4)), FontSize = 12, TextWrapping = TextWrapping.Wrap, MaxHeight = 36, TextTrimming = TextTrimming.CharacterEllipsis };
    readonly TextBlock reply = new() { Foreground = Brushes.White, FontSize = 12, TextWrapping = TextWrapping.Wrap, MaxHeight = 86, TextTrimming = TextTrimming.CharacterEllipsis };
    Border frame = null!;
    readonly DispatcherTimer linger = new() { Interval = TimeSpan.FromSeconds(6) };

    public VoicePill()
    {
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.WidthAndHeight;
        MaxWidth = 460;
        MinWidth = 150;
        var text = new StackPanel();
        text.Children.Add(status);
        text.Children.Add(heard);
        text.Children.Add(reply);
        var row = new DockPanel();
        DockPanel.SetDock(dot, Dock.Left);
        row.Children.Add(dot);
        row.Children.Add(text);
        // The same look as the "using this computer" pill: near-black, a thin edge in the state's colour.
        frame = new Border
        {
            Background = new SolidColorBrush(Color.FromArgb(0xEE, 0x0B, 0x0B, 0x10)),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(15),
            Padding = new Thickness(14, 7, 16, 8),
            Child = row,
        };
        Content = frame;
        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            var style = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
            Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, style | Native.WS_EX_TRANSPARENT | Native.WS_EX_LAYERED | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE);
        };
        SizeChanged += (_, _) => Place();
        linger.Tick += (_, _) =>
        {
            linger.Stop();
            Hide();
        };
    }

    /** How far down from the top of the screen: under the "using this computer" pill when that is showing. */
    public Func<double> Below { get; set; } = () => 0;

    void Place()
    {
        var area = SystemParameters.WorkArea;
        Left = area.Left + (area.Width - ActualWidth) / 2;
        Top = area.Top + 10 + Below();
    }

    /** Puts it where it belongs again, when the pill above comes or goes. */
    public void Replace()
    {
        if (IsVisible) Place();
    }

    /** Shows what the voice part is doing; called on the UI thread. */
    public void Show(Voice voice)
    {
        var (words, colour) = voice.Mode switch
        {
            VoiceMode.Listening => ("Listening", Color.FromRgb(0x26, 0xFF, 0x8C)),
            VoiceMode.Transcribing => ("Hearing you", Color.FromRgb(0x9E, 0x66, 0xFF)),
            VoiceMode.Thinking => ("Thinking", Color.FromRgb(0x9E, 0x66, 0xFF)),
            VoiceMode.Speaking => ("Speaking", Color.FromRgb(0x8C, 0xF2, 0xFF)),
            VoiceMode.Error => ("Something went wrong", Color.FromRgb(0xFF, 0x52, 0x40)),
            _ => ("", Color.FromRgb(0x8C, 0xF2, 0xFF)),
        };
        status.Text = words;
        dot.Background = new SolidColorBrush(colour);
        frame.BorderBrush = new SolidColorBrush(Color.FromArgb(0x90, colour.R, colour.G, colour.B));
        var grow = voice.Mode == VoiceMode.Listening ? 1 + voice.Level * 0.8 : 1;
        dot.RenderTransform = new ScaleTransform(grow, grow, 6, 6);
        heard.Text = voice.Heard;
        heard.Visibility = voice.Heard.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        reply.Text = voice.Reply;
        reply.Visibility = voice.Reply.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        // A question waiting here: said in the pill, with its choices, until answered.
        if (voice.Question != null && voice.Mode is VoiceMode.Idle or VoiceMode.Listening)
        {
            if (voice.Mode == VoiceMode.Idle)
            {
                status.Text = "Question: press Ctrl+Alt+Space to answer";
                dot.Background = new SolidColorBrush(Color.FromRgb(0x33, 0x80, 0xFF));
                frame.BorderBrush = new SolidColorBrush(Color.FromArgb(0x90, 0x33, 0x80, 0xFF));
            }
            heard.Text = voice.Question;
            heard.Visibility = Visibility.Visible;
            reply.Text = voice.Choices.Count > 0 ? string.Join("  ·  ", voice.Choices) : "";
            reply.Visibility = voice.Choices.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            linger.Stop();
            if (!IsVisible) base.Show();
            Place();
            return;
        }
        if (voice.Mode == VoiceMode.Idle)
        {
            // Done: the answer stays a moment to be read, then the pill goes. Nothing said: it goes now.
            status.Text = "";
            if (voice.Reply.Length == 0 && voice.Heard.Length == 0) { linger.Stop(); Hide(); }
            else if (IsVisible && !linger.IsEnabled) linger.Start();
            return;
        }
        linger.Stop();
        if (voice.Mode == VoiceMode.Error) linger.Start();
        if (!IsVisible) base.Show();
        Place();
    }
}
