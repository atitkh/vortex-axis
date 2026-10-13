using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace Axis.Desktop.App;

/**
 * At the top of the main screen while an agent is using this computer (looking, clicking, typing): a rose
 * dot that breathes, "VorteX is using this computer" and the last thing it did. It shows from the first
 * desktop command until a few seconds after the last, and steps out of the picture when the screen is captured.
 */
sealed class ControlPill : Pill
{
    /** How long after the last command it stays: the agent thinks between calls. Matches Axis's own count. */
    static readonly TimeSpan Linger = TimeSpan.FromSeconds(8);
    static readonly Color Rose = Color.FromRgb(0xFF, 0x52, 0x9E);

    readonly TextBlock doing = Words(Dim, 12);
    readonly Border rule = new() { Width = 1, Height = 13, Margin = new Thickness(11, 0, 11, 0), Background = Frozen(new SolidColorBrush(Color.FromArgb(0x40, 0xFF, 0xFF, 0xFF))), VerticalAlignment = VerticalAlignment.Center };
    readonly DispatcherTimer away = new() { Interval = Linger };
    bool wanted;

    /** It came or went: what sits under it moves. */
    public event Action? Moved;
    /** An agent is at this computer just now (also while the pill has stepped aside for a capture). */
    public bool Active => wanted;
    /** The room it takes at the top of the screen, 0 when hidden. */
    public double Room => Up ? PillHeight + 8 : 0;

    public ControlPill()
    {
        Tint(Rose);
        Dot.VerticalAlignment = VerticalAlignment.Center;
        Dot.Margin = new Thickness(0, 0, 11, 0);
        doing.MaxWidth = 300;
        doing.TextTrimming = TextTrimming.CharacterEllipsis;
        rule.Visibility = doing.Visibility = Visibility.Collapsed;
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(Dot);
        row.Children.Add(Words(Bright, 12.5, FontWeights.SemiBold).With("VorteX is using this computer"));
        row.Children.Add(rule);
        row.Children.Add(doing);
        Frame.Child = row;
        Dot.BeginAnimation(OpacityProperty, new DoubleAnimation(1, 0.4, TimeSpan.FromMilliseconds(750)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever, EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut } });
        away.Tick += (_, _) =>
        {
            away.Stop();
            wanted = false;
            FadeOut();
            Moved?.Invoke();
        };
    }

    protected override void Came() => Moved?.Invoke();
    protected override void Went() => Moved?.Invoke();

    /** An agent's command has just come in. */
    public void Touch()
    {
        var was = wanted;
        wanted = true;
        away.Stop();
        away.Start();
        FadeIn();
        if (!was) Moved?.Invoke();
    }

    /** What it just did, in the app's own words. */
    public void Did(string line)
    {
        doing.Text = line;
        rule.Visibility = doing.Visibility = line.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /** Out of the picture for a capture of the screen; back a moment later if the agent is still at it. */
    public void StepAside()
    {
        if (!IsVisible) return;
        Vanish();
        var back = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(600) };
        back.Tick += (_, _) =>
        {
            back.Stop();
            if (wanted) FadeIn();
        };
        back.Start();
    }
}

static class TextBlockWith
{
    public static TextBlock With(this TextBlock block, string text)
    {
        block.Text = text;
        return block;
    }
}
