using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;

namespace Axis.Desktop.App;

/**
 * Typing to the agent, in the voice pill's place: "Typing" and a field that grows from one line to three, then
 * scrolls. Enter sends, Shift+Enter starts a new line, Esc cancels, Up in an empty field brings back the last thing
 * sent. A question waiting here shows above the field with its choices. The one pill that takes the keyboard: it
 * comes to the front when opened and the app gives the front back to the window that had it when it closes.
 */
sealed class TypingPill : Pill
{
    static readonly Color Amber = Color.FromRgb(0xFF, 0xC8, 0x57);

    readonly TextBlock status = Words(new SolidColorBrush(Amber), 12.5, FontWeights.SemiBold).With("Typing");
    readonly TextBlock question = Words(Bright, 12);
    readonly TextBox field = new()
    {
        Width = 420,
        MinLines = 1,
        MaxLines = 3,
        MaxLength = TypedText.MaxLength,
        TextWrapping = TextWrapping.Wrap,
        AcceptsReturn = false,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        Background = Brushes.Transparent,
        BorderThickness = new Thickness(0),
        Padding = new Thickness(0),
        Margin = new Thickness(0, 5, 0, 0),
        FontSize = 13.5,
    };
    readonly TextBlock hint = Words(Dim, 11).With("Enter to send · Shift+Enter for a new line · Esc to cancel");
    readonly WrapPanel buttons = new() { Margin = new Thickness(0, 7, 0, 2), Visibility = Visibility.Collapsed };
    string last = "";
    bool open;

    /** Enter with something in the field. */
    public event Action<string>? Send;
    /** Esc (true: give the front back), or the person clicked away (false: they chose where to go). */
    public event Action<bool>? Cancel;
    /** A choice button pressed. */
    public event Action<string>? Chose;

    public bool IsOpen => open;
    public IntPtr Handle => new WindowInteropHelper(this).Handle;

    public Func<double> Below { get; set; } = () => 0;
    protected override double Down => 10 + Below();

    public TypingPill()
    {
        ShowActivated = true;
        Focusable = true;
        field.Foreground = field.CaretBrush = Bright;
        field.SelectionBrush = Frozen(new SolidColorBrush(Color.FromRgb(0x4D, 0x94, 0xFF)));
        question.TextWrapping = TextWrapping.Wrap;
        question.TextTrimming = TextTrimming.CharacterEllipsis;
        question.MaxHeight = 36;
        question.MaxWidth = 420;
        question.Margin = new Thickness(0, 3, 0, 0);
        hint.Margin = new Thickness(0, 5, 0, 0);
        var text = new StackPanel();
        text.Children.Add(status);
        text.Children.Add(question);
        text.Children.Add(buttons);
        text.Children.Add(field);
        text.Children.Add(hint);
        var row = new DockPanel();
        DockPanel.SetDock(Dot, Dock.Left);
        row.Children.Add(Dot);
        row.Children.Add(text);
        Frame.Child = row;
        Tint(Amber);
        // Unlike the others: it takes clicks and the keyboard (the base made it click-through and never active).
        SourceInitialized += (_, _) =>
        {
            var hwnd = Handle;
            var style = Native.GetWindowLong(hwnd, Native.GWL_EXSTYLE);
            Native.SetWindowLong(hwnd, Native.GWL_EXSTYLE, style & ~Native.WS_EX_TRANSPARENT & ~Native.WS_EX_NOACTIVATE);
        };
        field.PreviewKeyDown += OnKey;
        Deactivated += (_, _) =>
        {
            if (open) Cancel?.Invoke(false);
        };
    }

    /** Puts it where it belongs again, when a pill above comes or goes. */
    public void Replace()
    {
        if (IsVisible) Place();
    }

    void OnKey(object sender, KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.Enter when (Keyboard.Modifiers & ModifierKeys.Shift) != 0:
            {
                // A new line where the caret is, in place of any selection.
                var at = field.SelectionStart;
                field.SelectedText = "\n";
                field.SelectionLength = 0;
                field.CaretIndex = at + 1;
                e.Handled = true;
                break;
            }
            case Key.Enter:
                e.Handled = true;
                if (TypedText.Clean(field.Text) is { } words)
                {
                    last = words;
                    Send?.Invoke(words);
                }
                break;
            case Key.Escape:
                e.Handled = true;
                Cancel?.Invoke(true);
                break;
            case Key.Up when field.Text.Length == 0 && last.Length > 0:
                e.Handled = true;
                field.Text = last;
                field.CaretIndex = field.Text.Length;
                break;
        }
    }

    /** Opens it, empty, with the question waiting here if there is one, and takes the keyboard. */
    public void Open(string? asked, IReadOnlyList<string> choices)
    {
        open = true;
        field.Text = "";
        question.Text = asked ?? "";
        question.Visibility = question.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        status.Text = asked != null ? "Typing your answer" : "Typing";
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
                Cursor = Cursors.Hand,
                Focusable = false,
            };
            var picked = choice;
            button.Click += (_, _) => Chose?.Invoke(picked);
            buttons.Children.Add(button);
        }
        FadeIn();
        Native.ForceFront(Handle);
        Activate();
        field.Focus();
        Keyboard.Focus(field);
    }

    /**
     * Closes it at once (the voice pill takes the place back). `giveBack` runs while it is still on screen, so the
     * window it brings to the front is the one that comes next, not whatever Windows would pick once this one hides.
     */
    public void Shut(Action? giveBack)
    {
        open = false;
        giveBack?.Invoke();
        Vanish();
    }
}
