namespace Axis.Desktop;

/**
 * The microphone, opened and closed away from the caller's thread: opening one can take seconds (a Bluetooth headset
 * switching to its headset profile, a device waking up), and the talk key's handler runs on the UI thread. Every open
 * and close runs in order on one background worker (`Run`). Let go, it stays on for `GraceMs` so a quick second press
 * starts at once, then closes; `Release(now: true)` closes it at once (speech about to play, sleep, the mic switched off).
 */
public sealed class WarmMic
{
    public const int GraceMs = 3000;

    readonly IVoiceIo io;
    readonly Action<short[]> frame;
    readonly object gate = new();
    bool wanted, open;
    int generation;
    Task tail = Task.CompletedTask;

    /** Runs work in order, off the caller's thread. The checks run it inline. */
    public Action<Action> Run { get; set; }
    /** Runs work after so many milliseconds (on `Run`). The checks keep it to fire by hand. */
    public Action<int, Action> After { get; set; }
    /** The microphone is on for a request (`warm`: it already was). On the worker. */
    public event Action<bool>? Opened;
    /** The microphone could not open for a request still wanted. On the worker. */
    public event Action<Exception>? Failed;

    public WarmMic(IVoiceIo io, Action<short[]> frame)
    {
        this.io = io;
        this.frame = frame;
        Run = work =>
        {
            lock (gate) tail = tail.ContinueWith(_ => work(), CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
        };
        After = (ms, work) => Task.Delay(ms).ContinueWith(_ => Run(work), TaskScheduler.Default);
    }

    public bool IsOpen { get { lock (gate) return open; } }

    /** The microphone is needed now: opened (or kept, if still warm). Returns at once. */
    public void Want()
    {
        lock (gate)
        {
            wanted = true;
            generation++;
        }
        Run(Settle);
    }

    /** Not needed any more: closed after the grace, or at once. */
    public void Release(bool now = false)
    {
        int mine;
        lock (gate)
        {
            if (!wanted && !now) return;
            wanted = false;
            mine = ++generation;
        }
        if (now) Run(Settle);
        else After(GraceMs, () =>
        {
            lock (gate) { if (mine != generation) return; }
            Settle();
        });
    }

    /** Brings the device to what is wanted (on the worker). */
    void Settle()
    {
        bool want, isOpen;
        lock (gate) { want = wanted; isOpen = open; }
        if (want && isOpen) { Opened?.Invoke(true); return; }
        if (want)
        {
            try { io.StartCapture(frame); }
            catch (Exception e)
            {
                bool still;
                lock (gate) still = wanted;
                if (still) Failed?.Invoke(e);
                return;
            }
            lock (gate) open = true;
            Opened?.Invoke(false);
            // Let go while it was opening: the grace (or a close at once) is already on its way.
            return;
        }
        if (!isOpen) return;
        lock (gate) open = false;
        try { io.StopCapture(); } catch { }
    }
}

/**
 * How long the talk key took, from the key's event to the handler, the microphone on, its first audio and the
 * listening (or typing) pill on screen; one line per press for the app's Recently list. Milliseconds of `Voice.Clock`.
 */
public sealed class TalkTiming
{
    readonly object gate = new();
    long key = -1, handler, mic = -1, audio = -1, shown = -1;
    bool warm;
    string what = "", failed = "";

    /** A finished measurement, as a line. On whichever thread finished it. */
    public event Action<string>? Measured;

    /** The key went down at `keyAt` (its event) and the handler ran at `handlerAt`. Reports a previous one left open. */
    public void Begin(long keyAt, long handlerAt)
    {
        string? left;
        lock (gate)
        {
            left = key >= 0 ? LineLocked() : null;
            key = keyAt;
            handler = Math.Max(keyAt, handlerAt);
            mic = audio = shown = -1;
            warm = false;
            what = failed = "";
        }
        if (left != null) Measured?.Invoke(left);
    }

    public void Mic(long at, bool wasWarm) => Mark(() => { if (mic < 0) { mic = at; warm = wasWarm; } });
    public void Failed(long at, string why) => Mark(() => { if (mic < 0 && failed == "") { mic = at; failed = why; } });
    public void Audio(long at) => Mark(() => { if (audio < 0) audio = at; });
    /** `listening` or `typing` is on the screen. */
    public void Shown(long at, string kind) => Mark(() => { if (shown < 0) { shown = at; what = kind; } });

    void Mark(Action set)
    {
        string? done = null;
        lock (gate)
        {
            if (key < 0) return;
            set();
            if (shown >= 0 && (audio >= 0 || failed != ""))
            {
                done = LineLocked();
                key = -1;
            }
        }
        if (done != null) Measured?.Invoke(done);
    }

    string LineLocked()
    {
        string At(long t) => t < 0 ? "never" : $"+{t - key} ms";
        var micPart = failed != "" ? $"mic failed {At(mic)} ({failed})" : $"mic {(warm ? "warm" : "open")} {At(mic)}";
        return $"Talk key: handler {At(handler)}, {micPart}, first audio {At(audio)}, {(what == "" ? "pill" : what)} shown {At(shown)}";
    }

    public static bool IsLine(string text) => text.StartsWith("Talk key: handler ", StringComparison.Ordinal);
}
