using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Windows.Controls;
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
        FillSettings();
        Render();
        ShowView(settings: false);
    }

    bool filling;

    /** Puts the saved choices into the settings view. */
    void FillSettings()
    {
        filling = true;
        var saved = AppNow.Saved;
        VoiceSwitch.IsChecked = saved.Voice;
        Fill(KeyBox, App.TalkKeys.Select(k => (k.Id, k.Label)), saved.TalkKey);
        Fill(MicBox, VoiceIo.Inputs().Select(d => (d.Id.ToString(), d.Name)), saved.MicDevice.ToString());
        Fill(SpeakerBox, VoiceIo.Outputs().Select(d => (d.Id.ToString(), d.Name)), saved.SpeakerDevice.ToString());
        FaceSwitch.IsChecked = saved.ShowFace;
        KeepSwitch.IsChecked = saved.KeepFace;
        Fill(SizeBox, FaceWindow.Sizes.Select(z => (z.Id, z.Label)), saved.FaceSize);
        Fill(PlaceBox, FaceWindow.Places.Select(z => (z.Id, z.Label)), saved.FacePlace);
        ControlSwitch.IsChecked = saved.ShowControl;
        filling = false;
    }

    static void Fill(ComboBox box, IEnumerable<(string Id, string Label)> items, string chosen)
    {
        box.Items.Clear();
        foreach (var (id, label) in items) box.Items.Add(new ComboBoxItem { Content = label, Tag = id });
        box.SelectedItem = box.Items.Cast<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == chosen) ?? box.Items.Cast<ComboBoxItem>().FirstOrDefault();
    }

    static string Chosen(ComboBox box) => (box.SelectedItem as ComboBoxItem)?.Tag as string ?? "";

    /** Opens the window on its settings (the tray's "Settings"). */
    public void ShowSettings()
    {
        FillSettings();
        ShowView(settings: true);
    }

    void ShowView(bool settings)
    {
        RecentView.Visibility = settings ? Visibility.Collapsed : Visibility.Visible;
        SettingsView.Visibility = settings ? Visibility.Visible : Visibility.Collapsed;
        NothingYet.Visibility = !settings && AppNow.Recently.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        RecentTab.Foreground = (Brush)FindResource(settings ? "Dim" : "Text");
        SettingsTab.Foreground = (Brush)FindResource(settings ? "Text" : "Dim");
    }

    void OnRecentTab(object sender, RoutedEventArgs e) => ShowView(settings: false);
    void OnSettingsTab(object sender, RoutedEventArgs e) => ShowSettings();

    async void OnVoice(object sender, RoutedEventArgs e)
    {
        if (!filling) await AppNow.SetVoiceAsync(VoiceSwitch.IsChecked == true);
    }

    void OnKey(object sender, SelectionChangedEventArgs e)
    {
        if (!filling) AppNow.SetTalkKey(Chosen(KeyBox));
    }

    void OnDevices(object sender, SelectionChangedEventArgs e)
    {
        if (!filling && int.TryParse(Chosen(MicBox), out var mic) && int.TryParse(Chosen(SpeakerBox), out var speaker)) AppNow.SetDevices(mic, speaker);
    }

    void OnFace(object sender, RoutedEventArgs e)
    {
        if (!filling) AppNow.SetFace(FaceSwitch.IsChecked == true, KeepSwitch.IsChecked == true, Chosen(SizeBox), Chosen(PlaceBox));
    }

    void OnFaceLook(object sender, SelectionChangedEventArgs e) => OnFace(sender, e);

    void OnControl(object sender, RoutedEventArgs e)
    {
        if (!filling) AppNow.SetShowControl(ControlSwitch.IsChecked == true);
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
        NothingYet.Visibility = RecentView.Visibility == Visibility.Visible && AppNow.Recently.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
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
