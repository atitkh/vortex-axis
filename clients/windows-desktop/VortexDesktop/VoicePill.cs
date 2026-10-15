using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;

namespace Axis.Desktop.App;

/**
 * At the top of the main screen while talking from this computer (under the "using this computer" pill when
 * both show): a dot and a word in the colour of the moment (listening, thinking, speaking; the dot swells
 * with the voice while listening), what was heard in quotes, and the reply. A question waiting here shows
 * with its choices. It fades a few seconds after the answer.
 */
sealed class VoicePill : Pill
{
    readonly TextBlock status = Words(Bright, 12.5, FontWeights.SemiBold);
    readonly TextBlock heard = Words(Dim, 12);
    readonly TextBlock reply = Words(Bright, 13);
    readonly Border rule = new() { Height = 1, Margin = new Thickness(0, 7, 0, 6), Background = Frozen(new SolidColorBrush(Color.FromArgb(0x26, 0xFF, 0xFF, 0xFF))) };
    readonly WrapPanel buttons = new() { Margin = new Thickness(0, 9, 0, 0), Visibility = Visibility.Collapsed };
    readonly DispatcherTimer linger = new() { Interval = TimeSpan.FromSeconds(6) };

    public VoicePill()
    {
        MaxWidth = 480 + Shadow * 2;
        heard.TextWrapping = reply.TextWrapping = TextWrapping.Wrap;
        heard.TextTrimming = reply.TextTrimming = TextTrimming.CharacterEllipsis;
        heard.FontStyle = FontStyles.Italic;
        heard.MaxHeight = 36;
        heard.Margin = new Thickness(0, 3, 0, 0);
        reply.MaxHeight = 96;
        reply.LineHeight = 18;
        var text = new StackPanel { MinWidth = 120 };
        text.Children.Add(status);
        text.Children.Add(heard);
        text.Children.Add(rule);
        text.Children.Add(reply);
        text.Children.Add(buttons);
        var row = new DockPanel();
        DockPanel.SetDock(Dot, Dock.Left);
        row.Children.Add(Dot);
        row.Children.Add(text);
        Frame.Child = row;
        linger.Tick += (_, _) =>
        {
            linger.Stop();
            FadeOut();
        };
    }

    /** Called with the choice a button was pressed for. */
    public Action<string>? Chose { get; set; }

    string choiceKey = "";

    /** The question's choices as buttons the person can press; the pill takes clicks only while they show. */
    void Buttons(System.Collections.Generic.IReadOnlyList<string> choices)
    {
        var key = string.Join("\n", choices);
        if (key == choiceKey) return;
        choiceKey = key;
        buttons.Children.Clear();
        buttons.Visibility = choices.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        foreach (var choice in choices)
        {
            var button = new Button
            {
                Content = choice,
                Margin = new Thickness(0, 0, 8, 0),
                Padding = new Thickness(14, 4, 14, 4),
                Foreground = Bright,
                Background = Frozen(new SolidColorBrush(Color.FromArgb(0x33, 0x4D, 0x94, 0xFF))),
                BorderBrush = Frozen(new SolidColorBrush(Color.FromArgb(0x99, 0x4D, 0x94, 0xFF))),
                Cursor = System.Windows.Input.Cursors.Hand,
                Focusable = false,
            };
            var picked = choice;
            button.Click += (_, _) => Chose?.Invoke(picked);
            buttons.Children.Add(button);
        }
        Clickable(choices.Count > 0);
    }

    /** How far down from the top of the screen: under the "using this computer" pill when that is showing. */
    public Func<double> Below { get; set; } = () => 0;
    protected override double Down => 10 + Below();

    /** Puts it where it belongs again, when the pill above comes or goes. */
    public void Replace()
    {
        if (IsVisible) Place();
    }

    void Lines(string? said, string? answer)
    {
        heard.Text = said ?? "";
        heard.Visibility = heard.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        reply.Text = answer ?? "";
        reply.Visibility = reply.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        // The line between them only when there is something on both sides of it.
        rule.Visibility = reply.Text.Length > 0 && (heard.Text.Length > 0 || status.Text.Length > 0) ? Visibility.Visible : Visibility.Collapsed;
        status.Visibility = status.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /** Shows what the voice part is doing; called on the UI thread. */
    public void Show(Voice voice)
    {
        var (words, colour) = voice.Mode switch
        {
            VoiceMode.Listening => ("Listening", Color.FromRgb(0x26, 0xFF, 0x8C)),
            VoiceMode.Transcribing => ("Hearing you", Color.FromRgb(0x9E, 0x66, 0xFF)),
            VoiceMode.Thinking => ("Thinking", Color.FromRgb(0xB0, 0x82, 0xFF)),
            VoiceMode.Speaking => ("Speaking", Color.FromRgb(0x8C, 0xF2, 0xFF)),
            VoiceMode.Error => ("Something went wrong", Color.FromRgb(0xFF, 0x5C, 0x4A)),
            _ => ("", Color.FromRgb(0x8C, 0xF2, 0xFF)),
        };
        // A question waiting here: said in the pill, with its choices, until answered.
        var asking = voice.Question != null && voice.Mode is VoiceMode.Idle or VoiceMode.Listening;
        if (asking && voice.Mode == VoiceMode.Idle) (words, colour) = ($"Question · {App.TalkKeyLabel} to answer", Color.FromRgb(0x4D, 0x94, 0xFF));
        status.Text = words;
        status.Foreground = new SolidColorBrush(colour);
        Tint(colour);
        var grow = voice.Mode == VoiceMode.Listening ? 1 + voice.Level * 0.9 : 1;
        Dot.RenderTransform = new ScaleTransform(grow, grow, 4.5, 4.5);
        if (asking)
        {
            Lines(voice.Question, "");
            Buttons(voice.Choices);
            heard.FontStyle = FontStyles.Normal;
            linger.Stop();
            FadeIn();
            return;
        }
        Buttons([]);
        heard.FontStyle = FontStyles.Italic;
        Lines(voice.Heard.Length > 0 ? $"“{voice.Heard}”" : "", voice.Reply);
        if (voice.Mode == VoiceMode.Idle)
        {
            // Done: the answer stays a moment to be read, then the pill goes. Nothing said: it goes now.
            if (voice.Reply.Length == 0 && voice.Heard.Length == 0) { linger.Stop(); FadeOut(); }
            else if (Up && !linger.IsEnabled) linger.Start();
            return;
        }
        linger.Stop();
        if (voice.Mode == VoiceMode.Error) linger.Start();
        FadeIn();
    }

    /** Away at once (talking switched off). */
    public void Dismiss()
    {
        linger.Stop();
        Vanish();
    }
}
