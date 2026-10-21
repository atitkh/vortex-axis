using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Threading;
using NAudio.Wave;

namespace Axis.Desktop.App;

/** The default microphone and speakers, through NAudio (Windows' wave API). */
sealed class VoiceIo : IVoiceIo
{
    readonly object gate = new();
    WaveInEvent? mic;
    WaveOutEvent? output;
    BufferedWaveProvider? buffer;
    DispatcherTimer? draining;

    /** Which microphone and speaker, by Windows' number; -1 is Windows' default. Used from the next recording or answer. */
    public int InputDevice { get; set; } = -1;
    public int OutputDevice { get; set; } = -1;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WaveOutCaps
    {
        public ushort Mid, Pid;
        public uint DriverVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        public uint Formats;
        public ushort Channels, Reserved;
        public uint Support;
    }
    [DllImport("winmm.dll")] static extern int waveOutGetNumDevs();
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern int waveOutGetDevCapsW(IntPtr device, out WaveOutCaps caps, int size);

    /** The microphones there are, Windows' default first. */
    public static List<(int Id, string Name)> Inputs()
    {
        var list = new List<(int, string)> { (-1, "Windows default") };
        try { for (var i = 0; i < WaveInEvent.DeviceCount; i++) list.Add((i, WaveInEvent.GetCapabilities(i).ProductName)); } catch { }
        return list;
    }

    /** The speakers there are, Windows' default first. */
    public static List<(int Id, string Name)> Outputs()
    {
        var list = new List<(int, string)> { (-1, "Windows default") };
        try
        {
            var count = waveOutGetNumDevs();
            for (var i = 0; i < count; i++)
                if (waveOutGetDevCapsW((IntPtr)i, out var caps, Marshal.SizeOf<WaveOutCaps>()) == 0) list.Add((i, caps.Name));
        }
        catch { }
        return list;
    }

    public void StartCapture(Action<short[]> frame)
    {
        lock (gate)
        {
            StopCapture();
            var m = new WaveInEvent { DeviceNumber = InputDevice, WaveFormat = new WaveFormat(Voice.MicRate, 16, 1), BufferMilliseconds = 20, NumberOfBuffers = 4 };
            m.DataAvailable += (_, e) =>
            {
                var samples = new short[e.BytesRecorded / 2];
                Buffer.BlockCopy(e.Buffer, 0, samples, 0, samples.Length * 2);
                frame(samples);
            };
            m.StartRecording();
            mic = m;
        }
    }

    public void StopCapture()
    {
        lock (gate)
        {
            var m = mic;
            mic = null;
            if (m == null) return;
            // Stopping from inside its own callback is allowed; disposing there is not, so that waits a moment.
            try { m.StopRecording(); } catch { }
            System.Threading.Tasks.Task.Delay(200).ContinueWith(_ => m.Dispose());
        }
    }

    public void PlayBegin(int sampleRate)
    {
        lock (gate)
        {
            StopPlaybackLocked();
            buffer = new BufferedWaveProvider(new WaveFormat(sampleRate, 16, 1))
            {
                BufferDuration = TimeSpan.FromSeconds(60),
                DiscardOnBufferOverflow = true,
            };
            // The chosen speaker may be gone (unplugged, or numbered differently since): then the default one.
            // A throw here would end the link's receive loop, so nothing leaves this method.
            foreach (var device in OutputDevice == -1 ? new[] { -1 } : new[] { OutputDevice, -1 })
            {
                try
                {
                    var wave = new WaveOutEvent { DeviceNumber = device, DesiredLatency = 150 };
                    try
                    {
                        wave.Init(new Meter(buffer, this));
                        wave.Play();
                    }
                    catch
                    {
                        wave.Dispose();
                        throw;
                    }
                    output = wave;
                    break;
                }
                catch (Exception e)
                {
                    Diag.Log($"speaker {device} did not start: {e.Message}");
                }
            }
            // No speaker at all: nothing to play to; the reply is still shown and the turn still ends.
            if (output == null) buffer = null;
        }
    }

    /** How loud what is being played is just now, 0 to 1 (it reaches the ear a little later: the device's own buffer). */
    public double PlayLevel { get; private set; }

    /** Passes the speech through to the device and measures it on the way, a buffer at a time. */
    sealed class Meter(IWaveProvider source, VoiceIo owner) : IWaveProvider
    {
        public WaveFormat WaveFormat => source.WaveFormat;

        public int Read(byte[] buffer, int offset, int count)
        {
            var read = source.Read(buffer, offset, count);
            double energy = 0;
            var samples = read / 2;
            for (var i = 0; i < samples; i++)
            {
                var x = BitConverter.ToInt16(buffer, offset + i * 2) / 32768.0;
                energy += x * x;
            }
            var rms = samples > 0 ? Math.Sqrt(energy / samples) : 0;
            // Square root: ordinary speech fills most of the range. It rises at once and falls a little slower.
            var level = Math.Min(1, Math.Sqrt(rms / 0.22));
            owner.PlayLevel = level > owner.PlayLevel ? level : owner.PlayLevel * 0.6 + level * 0.4;
            return read;
        }
    }

    public void PlayWrite(byte[] pcm)
    {
        lock (gate) buffer?.AddSamples(pcm, 0, pcm.Length);
    }

    public void PlayEnd(Action finished)
    {
        // Heard once the buffer has run dry and the device has played out what it held.
        BufferedWaveProvider? mine;
        lock (gate) mine = buffer;
        if (mine == null) { finished(); return; }
        System.Windows.Application.Current.Dispatcher.BeginInvoke(() =>
        {
            draining?.Stop();
            var started = DateTime.UtcNow;
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(50) };
            draining = timer;
            var dryAt = DateTime.MinValue;
            timer.Tick += (_, _) =>
            {
                lock (gate)
                {
                    // Stopped, or a newer stretch began: that one reports for itself.
                    if (buffer != mine) { timer.Stop(); return; }
                    if (buffer.BufferedBytes > 0) { dryAt = DateTime.MinValue; return; }
                    if (dryAt == DateTime.MinValue) dryAt = DateTime.UtcNow;
                    if (DateTime.UtcNow - dryAt < TimeSpan.FromMilliseconds(250) && DateTime.UtcNow - started < TimeSpan.FromMinutes(5)) return;
                    StopPlaybackLocked();
                }
                timer.Stop();
                finished();
            };
            timer.Start();
        });
    }

    /** A short sound beside the speech, to the same speaker, on a player of its own so speech is not disturbed. */
    public void PlaySound(short[] pcm, int sampleRate)
    {
        var bytes = new byte[pcm.Length * 2];
        Buffer.BlockCopy(pcm, 0, bytes, 0, bytes.Length);
        foreach (var device in OutputDevice == -1 ? new[] { -1 } : new[] { OutputDevice, -1 })
        {
            var source = new RawSourceWaveStream(new System.IO.MemoryStream(bytes), new WaveFormat(sampleRate, 16, 1));
            var wave = new WaveOutEvent { DeviceNumber = device, DesiredLatency = 100 };
            try
            {
                wave.Init(source);
                // Disposing from inside its own stopped event is not allowed, so that waits a moment.
                wave.PlaybackStopped += (_, _) => System.Threading.Tasks.Task.Delay(200).ContinueWith(_ => { wave.Dispose(); source.Dispose(); });
                wave.Play();
                return;
            }
            catch (Exception e)
            {
                wave.Dispose();
                source.Dispose();
                Diag.Log($"speaker {device} did not play a sound: {e.Message}");
            }
        }
    }

    public bool StopPlayback()
    {
        lock (gate) return StopPlaybackLocked();
    }

    bool StopPlaybackLocked()
    {
        var was = output != null;
        PlayLevel = 0;
        try { output?.Stop(); } catch { }
        output?.Dispose();
        output = null;
        buffer = null;
        return was;
    }
}
