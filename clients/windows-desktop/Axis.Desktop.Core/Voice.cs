using System.Text.Json;
using System.Text.Json.Nodes;

namespace Axis.Desktop;

/** The computer's microphone and speakers, as the voice part needs them. The platform supplies it. */
public interface IVoiceIo
{
    /** Starts the microphone: `frame` gets 16 kHz mono 16-bit samples, about 20 ms at a time. */
    void StartCapture(Action<short[]> frame);
    void StopCapture();
    /** Starts a stretch of speech at `sampleRate` (16-bit mono). */
    void PlayBegin(int sampleRate);
    void PlayWrite(byte[] pcm);
    /** No more audio for this stretch: `finished` fires once the last of it has been heard. */
    void PlayEnd(Action finished);
    /** Stops at once and drops what is left. True when something was playing. */
    bool StopPlayback();
    /** How loud what is coming out of the speakers is just now, 0 to 1, for the face. */
    double PlayLevel { get; }
}

/** What the voice part is doing, for the app to show. */
public enum VoiceMode { Idle, Listening, Transcribing, Thinking, Speaking, Error }

/**
 * Talking to the agent from this computer, the way a board or the web client does: a press starts listening
 * (and stops on a pause, as theirs do), a hold listens until let go, a press while it thinks or speaks stops
 * it. Speech from Axis is played and reported (started, finished, stopped). All protocol and timing is here,
 * so another platform supplies only `IVoiceIo` and the key.
 */
public sealed class Voice
{
    public const int MicRate = 16000;
    /** A pause this long after speech ends the recording; a recording with no speech in this long is dropped. */
    const int QuietMs = 1200, NothingSaidMs = 6000, MaxMs = 30000;
    /** Louder than this (0..1 RMS) counts as speech. */
    const double SpeechLevel = 0.02;

    readonly AxisLink link;
    readonly IVoiceIo io;
    readonly object gate = new();

    string? recording;      // the turn being recorded
    bool holding;
    long startedAt, quietSince;
    bool spoke;
    string? playing;        // the turn being played
    string? turn;           // the turn last heard of from Axis
    string? replyTurn;      // the turn the reply shown belongs to
    int ids;

    public VoiceMode Mode { get; private set; }
    /** What was heard, then the reply as it comes; cleared on the next turn. */
    public string Heard { get; private set; } = "";
    public string Reply { get; private set; } = "";
    /** A question Axis is asking here, and its choices, until it is answered or taken back. */
    public string? Question { get; private set; }
    public IReadOnlyList<string> Choices { get; private set; } = [];
    string? askId;
    /** While thinking: the kind of work the agent has picked up (a tool icon's name) or why it is held up, if Axis said. */
    public string? Doing { get; private set; }
    /** The loudness to show just now, 0 to 1: the person's voice while listening, the agent's while it speaks; -1 otherwise. */
    public double Loudness => Mode == VoiceMode.Listening ? Level : Mode == VoiceMode.Speaking ? io.PlayLevel : -1;
    /** The microphone's level just now, 0 to 1, for a meter. */
    public double Level { get; private set; }
    /** Anything shown changed. */
    public event Action? Changed;

    public Voice(AxisLink link, IVoiceIo io)
    {
        this.link = link;
        this.io = io;
        link.Message += OnMessage;
        link.Audio += pcm => { if (playing != null) io.PlayWrite(pcm); };
    }

    bool Busy => Mode is VoiceMode.Transcribing or VoiceMode.Thinking or VoiceMode.Speaking;

    /**
     * The talk key went down. Starts listening; while the agent thinks or speaks it stops that instead.
     * `held` says whether the key is still down after a moment, which makes it a hold (listen until let go).
     */
    public void Press()
    {
        lock (gate)
        {
            if (recording != null)
            {
                // A second press while listening finishes, as a tap on the board does.
                Finish(spoke ? "silence" : "cancel");
                return;
            }
            if (Busy || playing != null)
            {
                Interrupt();
                return;
            }
            Start(askId != null ? "question" : "tap");
        }
    }

    /** The key has stayed down: listen until it comes up. */
    public void Hold()
    {
        lock (gate) { if (recording != null) holding = true; }
    }

    /** The key came up after a hold: send what was said. */
    public void Release()
    {
        lock (gate)
        {
            if (recording == null || !holding) return;
            holding = false;
            Finish(spoke || Environment.TickCount64 - startedAt > 900 ? "silence" : "cancel");
        }
    }

    void Start(string trigger)
    {
        var id = $"pc-{Environment.TickCount64:x}-{++ids}";
        recording = id;
        holding = false;
        spoke = false;
        quietSince = 0;
        startedAt = Environment.TickCount64;
        Heard = Reply = "";
        Set(VoiceMode.Listening);
        _ = link.TrySendAsync(new JsonObject
        {
            ["t"] = "audio.start",
            ["turnId"] = id,
            ["format"] = new JsonObject { ["encoding"] = "pcm_s16le", ["sampleRate"] = MicRate, ["channels"] = 1 },
            ["trigger"] = trigger,
        });
        try { io.StartCapture(OnFrame); }
        catch (Exception e)
        {
            recording = null;
            _ = link.TrySendAsync(new JsonObject { ["t"] = "audio.end", ["turnId"] = id, ["reason"] = "cancel" });
            Reply = $"The microphone could not start: {e.Message}";
            Set(VoiceMode.Error);
        }
    }

    void OnFrame(short[] samples)
    {
        byte[] bytes;
        lock (gate)
        {
            if (recording == null) return;
            double energy = 0;
            foreach (var x in samples) energy += (double)x * x;
            var level = Math.Sqrt(energy / Math.Max(1, samples.Length)) / 32768.0;
            Level = Math.Min(1, Math.Sqrt(Math.Max(0, (level - 0.004) / 0.08)));
            var now = Environment.TickCount64;
            if (level > SpeechLevel)
            {
                spoke = true;
                quietSince = 0;
            }
            else if (spoke)
            {
                if (quietSince == 0) quietSince = now;
            }
            bytes = new byte[samples.Length * 2];
            Buffer.BlockCopy(samples, 0, bytes, 0, bytes.Length);
            _ = link.TrySendAudioAsync(bytes);
            if (!holding && spoke && quietSince != 0 && now - quietSince > QuietMs) Finish("silence");
            else if (now - startedAt > MaxMs) Finish("max");
            else if (!holding && !spoke && now - startedAt > NothingSaidMs) Finish("cancel");
        }
        Changed?.Invoke();
    }

    /** Ends the recording (under the lock). */
    void Finish(string reason)
    {
        var id = recording;
        if (id == null) return;
        recording = null;
        holding = false;
        Level = 0;
        try { io.StopCapture(); } catch { }
        _ = link.TrySendAsync(new JsonObject { ["t"] = "audio.end", ["turnId"] = id, ["reason"] = reason });
        Set(reason == "cancel" ? VoiceMode.Idle : VoiceMode.Transcribing);
    }

    /** Stops speech and tells Axis the person wants it to stop. */
    public void Interrupt()
    {
        lock (gate)
        {
            if (recording != null) Finish("cancel");
            var was = playing;
            playing = null;
            if (io.StopPlayback() && was != null) _ = link.TrySendAsync(new JsonObject { ["t"] = "playback", ["turnId"] = was, ["state"] = "stopped" });
            _ = link.TrySendAsync(new JsonObject { ["t"] = "interrupt" });
            Set(VoiceMode.Idle);
        }
    }

    void OnMessage(string type, JsonElement m)
    {
        string? S(string key) => m.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        lock (gate)
        {
            switch (type)
            {
                case "turn":
                {
                    turn = S("turnId");
                    var state = S("state");
                    // Listening is ours to show; the rest follow Axis.
                    if (state == "listening" && recording == null) break;
                    var mode = state switch
                    {
                        "transcribing" => VoiceMode.Transcribing,
                        "thinking" => VoiceMode.Thinking,
                        "speaking" => VoiceMode.Speaking,
                        "error" => VoiceMode.Error,
                        "idle" => playing != null ? VoiceMode.Speaking : VoiceMode.Idle,
                        _ => Mode,
                    };
                    if (state == "thinking") { if (S("doing") is { } doing) Doing = doing == "none" ? null : doing; }
                    else Doing = null;
                    if (state == "error" && S("detail") is { Length: > 0 } why) Reply = why;
                    Set(mode);
                    break;
                }
                case "transcript":
                    Heard = S("text") ?? "";
                    Changed?.Invoke();
                    break;
                case "reply.text":
                {
                    var text = S("text") ?? "";
                    var final = m.TryGetProperty("final", out var f) && f.ValueKind == JsonValueKind.True;
                    // Another turn's words (an announcement after an answer) start afresh.
                    if (S("turnId") != replyTurn) Reply = "";
                    replyTurn = S("turnId");
                    Reply = final ? text : Reply + text;
                    Changed?.Invoke();
                    break;
                }
                case "speak.start":
                {
                    var id = S("turnId");
                    if (id == null) break;
                    var rate = m.TryGetProperty("format", out var fmt) && fmt.TryGetProperty("sampleRate", out var r) ? r.GetInt32() : 24000;
                    // Speech that comes while the person is talking to it waits its turn: theirs comes first.
                    if (recording != null) Finish("silence");
                    if (playing != null) io.StopPlayback();
                    playing = id;
                    io.PlayBegin(rate);
                    _ = link.TrySendAsync(new JsonObject { ["t"] = "playback", ["turnId"] = id, ["state"] = "started" });
                    Set(VoiceMode.Speaking);
                    break;
                }
                case "speak.end":
                {
                    var id = S("turnId");
                    if (id == null || id != playing) break;
                    io.PlayEnd(() =>
                    {
                        lock (gate)
                        {
                            if (playing != id) return;
                            playing = null;
                            _ = link.TrySendAsync(new JsonObject { ["t"] = "playback", ["turnId"] = id, ["state"] = "finished" });
                            if (Mode == VoiceMode.Speaking) Set(VoiceMode.Idle);
                        }
                    });
                    break;
                }
                case "ask":
                    askId = S("askId");
                    Question = S("question");
                    Choices = m.TryGetProperty("choices", out var c) && c.ValueKind == JsonValueKind.Array
                        ? c.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList()
                        : [];
                    Changed?.Invoke();
                    break;
                case "ask.end":
                    if (S("askId") != askId) break;
                    askId = null;
                    Question = null;
                    Choices = [];
                    Changed?.Invoke();
                    break;
                case "stop":
                {
                    var was = playing;
                    playing = null;
                    if (io.StopPlayback() && was != null) _ = link.TrySendAsync(new JsonObject { ["t"] = "playback", ["turnId"] = was, ["state"] = "stopped" });
                    if (Mode == VoiceMode.Speaking) Set(VoiceMode.Idle);
                    break;
                }
            }
        }
    }

    void Set(VoiceMode mode)
    {
        Mode = mode;
        Changed?.Invoke();
    }
}
