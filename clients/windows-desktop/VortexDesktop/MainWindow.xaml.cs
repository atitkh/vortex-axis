using System;
using System.ComponentModel;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace Axis.Desktop.App;

/** The app's one window: pair, then see how it stands, pause it, and what it did lately. Closing it leaves the app in the tray. */
public partial class MainWindow : Window
{
    public bool Quitting { get; set; }
    static App AppNow => App.Current;

    public MainWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => Native.DarkChrome(new WindowInteropHelper(this).Handle);
        NameBox.Text = Environment.MachineName;
        AddressBox.Text = AppNow.Saved.Address ?? "";
        RecentList.ItemsSource = AppNow.Recently;
        Footer.Text = $"Version {App.Version} · close this window and it keeps running in the tray";
        AppNow.Changed += Render;
        Render();
    }

    public void EnsureHandle() => new WindowInteropHelper(this).EnsureHandle();

    protected override void OnClosing(CancelEventArgs e)
    {
        // To the tray, not gone.
        if (!Quitting)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }

    void Render()
    {
        var pairing = AppNow.Saved.Pairing;
        PairPanel.Visibility = pairing == null ? Visibility.Visible : Visibility.Collapsed;
        PairedPanel.Visibility = pairing == null ? Visibility.Collapsed : Visibility.Visible;
        NothingYet.Visibility = AppNow.Recently.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        AllowSwitch.IsChecked = !AppNow.Paused;
        StartSwitch.IsChecked = Saved.StartWithWindows;
        if (pairing != null) WhereText.Text = $"{pairing.Name} on {pairing.Address}";

        var (text, brush) = pairing == null ? ("Not paired", "Faint")
            : AppNow.Paused ? ("Paused", "Warn")
            : AppNow.State switch
            {
                LinkState.Online => ("Connected", "Listen"),
                LinkState.Connecting => ("Connecting", "Accent"),
                LinkState.Refused => ("Pair again", "Bad"),
                _ => ("Offline", "Bad"),
            };
        PillText.Text = text;
        PillDot.Fill = (Brush)FindResource(brush);
        StatusDetail.Text = pairing != null && AppNow.State is LinkState.Offline or LinkState.Refused ? AppNow.StateWhy ?? "" : "";
        StatusDetail.Visibility = StatusDetail.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    async void OnPair(object sender, RoutedEventArgs e)
    {
        PairError.Text = "";
        PairButton.IsEnabled = false;
        PairButton.Content = "Pairing…";
        try
        {
            await AppNow.PairAsync(AddressBox.Text, CodeBox.Text, NameBox.Text);
            CodeBox.Text = "";
        }
        catch (Exception error)
        {
            PairError.Text = error.Message;
        }
        finally
        {
            PairButton.IsEnabled = true;
            PairButton.Content = "Pair";
            Render();
        }
    }

    void OnAllow(object sender, RoutedEventArgs e) => AppNow.SetPaused(AllowSwitch.IsChecked != true);

    void OnStartWithWindows(object sender, RoutedEventArgs e)
    {
        try { Saved.StartWithWindows = StartSwitch.IsChecked == true; }
        catch (Exception error) { MessageBox.Show(this, error.Message, "VorteX Axis"); }
        Render();
    }

    void OnShowPointer(object sender, RoutedEventArgs e) => AppNow.ShowPointer();

    async void OnForget(object sender, RoutedEventArgs e)
    {
        if (MessageBox.Show(this, "Forget this pairing? Agents lose this computer until it is paired again.", "VorteX Axis", MessageBoxButton.OKCancel) != MessageBoxResult.OK) return;
        await AppNow.ForgetAsync();
    }
}
