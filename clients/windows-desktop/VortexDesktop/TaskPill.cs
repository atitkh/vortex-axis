using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;

namespace Axis.Desktop.App;

/**
 * At the top of the main screen while talking from this computer, under the "using this computer" pill: the next timer
 * counting down, and an agent's long task (its title, how far along with a thin bar, "+N" for more tasks), as the boards
 * show them under the face. A click on the task opens its steps and the other tasks; × cancels the timer, or puts a
 * finished task away (a swipe down on a board). The full history stays on the admin Live page; this only glances.
 */
sealed class TaskPill : Pill
{
    static readonly Color Amber = Color.FromRgb(0xFF, 0xB4, 0x47);
    static readonly Color Red = Color.FromRgb(0xFF, 0x5C, 0x4A);
    static readonly Color Violet = Color.FromRgb(0xB0, 0x82, 0xFF);
    static readonly Color Green = Color.FromRgb(0x57, 0xE3, 0x8C);
    /** The most rows the opened list shows; more are counted. */
    const int MaxRows = 8;

    readonly DockPanel timerRow = new() { Visibility = Visibility.Collapsed };
    readonly Border timerDot = RowDot();
    readonly TextBlock timerLabel = Words(Bright, 12.5, FontWeights.SemiBold);
    readonly TextBlock timerClock = Words(Dim, 12.5);
    readonly Button timerCancel = Cross("Cancel the timer");

    readonly StackPanel taskBlock = new() { Visibility = Visibility.Collapsed };
    readonly Border taskDot = RowDot();
    readonly TextBlock taskTitle = Words(Bright, 12.5, FontWeights.SemiBold);
    readonly TextBlock taskDetail = Words(Dim, 12);
    readonly TextBlock taskMore = Words(Dim, 12);
    readonly Button taskDismiss = Cross("Put the finished task away");
    readonly Border bar = new() { Height = 3, CornerRadius = new CornerRadius(1.5), Margin = new Thickness(20, 6, 0, 1), Background = Frozen(new SolidColorBrush(Color.FromArgb(0x30, 0xFF, 0xFF, 0xFF))) };
    readonly Border fill = new() { Height = 3, CornerRadius = new CornerRadius(1.5) };
    // The bar's two parts, done and to do, as shares of its width.
    readonly ColumnDefinition doneShare = new(), leftShare = new();
    readonly StackPanel list = new() { Margin = new Thickness(20, 6, 0, 0), Visibility = Visibility.Collapsed };
    readonly DispatcherTimer tick = new() { Interval = TimeSpan.FromSeconds(1) };
    Glance? glance;
    bool open;
    string listKey = "";

    /** × on the timer: cancel it, by its id. */
    public Action<long>? CancelTimer { get; set; }
    /** × on a finished task: put the finished tasks away. */
    public Action? PutAway { get; set; }
    /** It came, went or changed height: what sits under it moves. */
    public event Action? Moved;

    /** The room it takes at the top of the screen, 0 when hidden. */
    public double Room => Up ? PillHeight + 8 : 0;

    public Func<double> Below { get; set; } = () => 0;
    protected override double Down => 10 + Below();

    public TaskPill()
    {
        Frame.Padding = new Thickness(14, 8, 10, 9);
        timerLabel.Margin = taskTitle.Margin = new Thickness(0, 0, 8, 0);
        timerLabel.MaxWidth = 220;
        taskTitle.MaxWidth = 260;
        taskDetail.MaxWidth = 200;
        timerLabel.TextTrimming = taskTitle.TextTrimming = taskDetail.TextTrimming = TextTrimming.CharacterEllipsis;
        taskMore.Margin = new Thickness(8, 0, 0, 0);
        timerClock.FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI");
        System.Windows.Documents.Typography.SetNumeralAlignment(timerClock, FontNumeralAlignment.Tabular);

        DockPanel.SetDock(timerDot, Dock.Left);
        DockPanel.SetDock(timerCancel, Dock.Right);
        timerRow.Children.Add(timerDot);
        timerRow.Children.Add(timerCancel);
        timerRow.Children.Add(Line(timerLabel, timerClock));
        timerCancel.Click += (_, _) =>
        {
            if (glance?.Timer?.Id is long id) CancelTimer?.Invoke(id);
        };

        var taskRow = new DockPanel { Cursor = Cursors.Hand, Background = Brushes.Transparent };
        DockPanel.SetDock(taskDot, Dock.Left);
        DockPanel.SetDock(taskDismiss, Dock.Right);
        taskRow.Children.Add(taskDot);
        taskRow.Children.Add(taskDismiss);
        taskRow.Children.Add(Line(taskTitle, taskDetail, taskMore));
        taskRow.MouseLeftButtonUp += (_, _) => Toggle();
        taskDismiss.Click += (_, _) => PutAway?.Invoke();
        var shares = new Grid();
        shares.ColumnDefinitions.Add(doneShare);
        shares.ColumnDefinitions.Add(leftShare);
        shares.Children.Add(fill);
        bar.Child = shares;
        taskBlock.Children.Add(taskRow);
        taskBlock.Children.Add(bar);
        taskBlock.Children.Add(list);

        var rows = new StackPanel { MinWidth = 180, MaxWidth = 440 };
        rows.Children.Add(timerRow);
        rows.Children.Add(taskBlock);
        Frame.Child = rows;
        tick.Tick += (_, _) => Render();
        SizeChanged += (_, _) => Moved?.Invoke();
        // Its buttons and the task's list take clicks; it still never takes the focus.
        SourceInitialized += (_, _) => Clickable(true);
    }

    /** Puts it where it belongs again, when a pill above comes or goes. */
    public void Replace()
    {
        if (IsVisible) Place();
    }

    protected override void Came() => Moved?.Invoke();
    protected override void Went() => Moved?.Invoke();

    static Border RowDot() => new() { Width = 8, Height = 8, CornerRadius = new CornerRadius(4), VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 10, 0) };

    static void Colour(Border dot, Color c)
    {
        dot.Background = new SolidColorBrush(c);
        dot.Effect = new DropShadowEffect { Color = c, BlurRadius = 8, ShadowDepth = 0, Opacity = 0.9 };
    }

    static StackPanel Line(params TextBlock[] parts)
    {
        var line = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        foreach (var part in parts) line.Children.Add(part);
        return line;
    }

    static Button Cross(string tip) => new()
    {
        Content = "×",
        ToolTip = tip,
        FontSize = 14,
        Padding = new Thickness(7, -2, 7, 0),
        Margin = new Thickness(10, 0, 0, 0),
        Foreground = Dim,
        Background = Brushes.Transparent,
        BorderThickness = new Thickness(0),
        Cursor = Cursors.Hand,
        Focusable = false,
        VerticalAlignment = VerticalAlignment.Center,
    };

    void Toggle()
    {
        if (glance?.TaskAt(Environment.TickCount64) is not { HasList: true }) return;
        open = !open;
        Render();
    }

    /** Shows what Axis last said about tasks and timers; called on the UI thread whenever it changes. */
    public void Show(Glance g)
    {
        glance = g;
        Render();
    }

    /** Away at once (talking switched off). */
    public void Dismiss()
    {
        tick.Stop();
        open = false;
        Vanish();
    }

    void Render()
    {
        var now = Environment.TickCount64;
        var timer = glance?.TimerAt(now);
        var task = glance?.TaskAt(now);
        if (timer == null && task == null)
        {
            tick.Stop();
            open = false;
            FadeOut();
            return;
        }
        if (!tick.IsEnabled) tick.Start();

        timerRow.Visibility = timer != null ? Visibility.Visible : Visibility.Collapsed;
        if (timer != null)
        {
            // The last ten seconds in red, as the boards' edge glow.
            Colour(timerDot, timer.Final(now) ? Red : Amber);
            timerLabel.Text = timer.Label;
            timerClock.Text = timer.More.Length > 0 ? $"{timer.Clock(now)}  {timer.More}" : timer.Clock(now);
            timerCancel.Visibility = timer.CanCancel ? Visibility.Visible : Visibility.Collapsed;
        }

        taskBlock.Visibility = task != null ? Visibility.Visible : Visibility.Collapsed;
        if (task != null)
        {
            taskBlock.Margin = new Thickness(0, timer != null ? 7 : 0, 0, 0);
            var colour = task.Finished ? Green : task.NeedsYou ? Amber : Violet;
            Colour(taskDot, colour);
            taskTitle.Text = task.Title;
            taskDetail.Text = task.Finished ? "done" : task.NeedsYou ? (task.Detail.Length > 0 ? $"needs you: {task.Detail}" : "needs you") : task.Detail;
            taskDetail.Foreground = task.NeedsYou ? new SolidColorBrush(Amber) : Dim;
            taskDetail.Visibility = taskDetail.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            taskMore.Text = task.More;
            taskMore.Visibility = task.More.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            taskDismiss.Visibility = task.Finished ? Visibility.Visible : Visibility.Collapsed;
            bar.Visibility = task.Part != null ? Visibility.Visible : Visibility.Collapsed;
            fill.Background = new SolidColorBrush(colour);
            var part = Math.Max(0.02, task.Part ?? 0);
            doneShare.Width = new GridLength(part, GridUnitType.Star);
            leftShare.Width = new GridLength(1 - part, GridUnitType.Star);
            if (!task.HasList) open = false;
            List(task);
        }
        else open = false;
        list.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        Tint(timer != null && timer.Final(now) ? Red : task == null ? Amber : task.Finished ? Green : task.NeedsYou ? Amber : Violet);
        FadeIn();
    }

    /** The other tasks (marked when one waits for the person), then this task's steps; one clipped line each. */
    void List(TaskLine task)
    {
        var rows = task.Others.Concat(task.Steps).ToList();
        var key = string.Join("\n", rows.Select(r => r.Kind + r.Text));
        if (key == listKey) return;
        listKey = key;
        list.Children.Clear();
        foreach (var (row, i) in rows.Take(MaxRows).Select((r, i) => (r, i)))
        {
            var (mark, brush) = row.Kind switch
            {
                "done" => ("✓", Dim),
                "running" => ("▸", Bright),
                "needs" => ("!", (Brush)new SolidColorBrush(Amber)),
                "task" => ("•", Bright),
                _ => ("·", Dim),
            };
            var line = Words(brush, 12).With($"{mark}  {row.Text}");
            line.TextTrimming = TextTrimming.CharacterEllipsis;
            line.MaxWidth = 400;
            // A little room between the other tasks and this one's steps.
            if (i == task.Others.Count && i > 0) line.Margin = new Thickness(0, 5, 0, 0);
            list.Children.Add(line);
        }
        if (rows.Count > MaxRows) list.Children.Add(Words(Dim, 11.5).With($"and {rows.Count - MaxRows} more on the admin Live page"));
    }
}
