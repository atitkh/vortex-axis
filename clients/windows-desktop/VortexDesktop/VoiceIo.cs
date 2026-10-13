using System;
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

    public void StartCapture(Action<short[]> frame)
    {
        lock (gate)
        {
            StopCapture();
            var m = new WaveInEvent { WaveFormat = new WaveFormat(Voice.MicRate, 16, 1), BufferMilliseconds = 20, NumberOfBuffers = 4 };
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
            output = new WaveOutEvent { DesiredLatency = 150 };
            output.Init(new Meter(buffer, this));
            output.Play();
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
