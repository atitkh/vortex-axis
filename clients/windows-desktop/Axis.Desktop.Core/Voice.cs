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
    /** A short sound of the app's own (a chime, the listening cue), beside any speech, to the same speaker. */
    void PlaySound(short[] pcm, int sampleRate) { }
    /**
     * How loud this app's own speech and sounds play, 0 to 1 (the `volume` setting): a gain on what it plays, never
     * the computer's own volume. `PlayLevel` is measured before it, so the face moves the same at any volume.
     */
    double Volume { get => 1; set { } }
}

/**
 * How long to listen, from Axis's shared Listening settings (`onsetMs`, `silenceMs`, `maxSpeechMs`, `followUpMs`),
 * which Axis sends every client. The fallbacks, the boards' own numbers, only matter with an
 * Axis older than 0.51.0, which did not send them.
 */
public sealed record Listening(int OnsetMs, int SilenceMs, int MaxMs, int FollowUpMs)
{
    public static readonly Listening Default = new(6000, 900, 20000, 6000);

    public static Listening Read(IReadOnlyDictionary<string, JsonElement> values) => new(
        Number(values, "onsetMs", Default.OnsetMs, 1000, 20000),
        Number(values, "silenceMs", Default.SilenceMs, 300, 5000),
        Number(values, "maxSpeechMs", Default.MaxMs, 3000, 60000),
        Number(values, "followUpMs", Default.FollowUpMs, 0, 30000));

    /** `volume` (0 to 100, 100 when not set: as loud as the computer is set) as a gain, 0 to 1. */
    public static double Volume(IReadOnlyDictionary<string, JsonElement> values) => Number(values, "volume", 100, 0, 100) / 100.0;

    static int Number(IReadOnlyDictionary<string, JsonElement> values, string key, int fallback, int min, int max) =>
        values.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.Number ? (int)Math.Clamp(Math.Round(v.GetDouble()), min, max) : fallback;
}

/** A typed turn (`text`, protocol `Text`): what the web client sends from its text box. */
public static class TypedText
{
    public const int MaxLength = 4000;

    /** The text as it is sent: trimmed; null when there is nothing, or more than Axis takes. */
    public static string? Clean(string? text)
    {
        var t = (text ?? "").Trim();
        return t.Length is > 0 and <= MaxLength ? t : null;
    }

    public static JsonObject Message(string turnId, string text) => new() { ["t"] = "text", ["turnId"] = turnId, ["text"] = text };
}

/**
 * The talk key, when a tap on it types: the microphone opens at once (so the first syllable of a hold is kept), and
 * the key coming up before TapMs makes it a tap (what was recorded is dropped) where staying down makes it a hold.
 */
public static class TalkPress
{
    public const int TapMs = 220;
    /** At most this much is kept from before a hold is known to be one (frames of about 20 ms). */
    public const int PreRollFrames = 50;

    public static bool IsTap(long downAt, long upAt) => upAt - downAt < TapMs;
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
    /** Louder than this (0..1 RMS) counts as speech. */
    const double SpeechLevel = 0.02;

    readonly AxisLink link;
    readonly IVoiceIo io;
    readonly object gate = new();

    string? recording;      // the turn being recorded
    bool holding;
    long startedAt, quietSince;
    int waitMs;             // how long this recording waits for the first word
    string? voiceTurn;      // the last turn recorded here: a spoken answer to it is followed by a short listen
    bool spoke;
    string? playing;        // the turn being played
    string? turn;           // the turn last heard of from Axis
    string? replyTurn;      // the turn the reply shown belongs to
    int ids;
    // The talk key is down and it is not yet known whether it is a tap or a hold: the microphone is on, nothing sent.
    bool armed;
    readonly List<short[]> preRoll = [];

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
    /** A picture that came with the reply (`reply.image`), as a full address; cleared with the reply. */
    public Uri? Picture { get; private set; }
    string? pictureTurn;
    /** When the app's sounds may play, from Axis's settings. */
    public Sounds Sounds { get; } = new();
    /** What an admin switched off for this computer (`DesktopCommands.CapabilitiesOff`): `mic`, `speaker`, `screen`. Usually empty. */
    public IReadOnlySet<string> Off { get; private set; } = new HashSet<string>();
    /** How long to listen, from Axis's settings. */
    public Listening Limits { get; private set; } = Listening.Default;
    /** The milliseconds clock (the checks give their own). */
    public Func<long> Clock { get; set; } = () => Environment.TickCount64;
    bool MicOff => Off.Contains("mic");
    bool SpeakerOff => Off.Contains("speaker");
    /** Every message this part sends Axis, as it goes (for the checks and the log). */
    public event Action<JsonObject>? Sent;
    /** Every frame of microphone audio sent, as it goes. */
    public event Action<byte[]>? SentAudio;
    /** Anything shown changed. */
    public event Action? Changed;

    public Voice(AxisLink link, IVoiceIo io)
    {
        this.link = link;
        this.io = io;
        link.Message += Receive;
        link.Audio += pcm => { if (playing != null) io.PlayWrite(pcm); };
        link.StateChanged += (state, _) => { if (state != LinkState.Online) Dropped(); };
    }

    /** The link to Axis went away: a turn that was waiting on it will never finish, so let go of it. */
    void Dropped()
    {
        lock (gate)
        {
            var was = Mode;
            if (playing != null) { io.StopPlayback(); playing = null; }
            if (askId != null) { askId = null; Question = null; Choices = []; }
            if (armed) Disarm();
            if (was is VoiceMode.Transcribing or VoiceMode.Thinking or VoiceMode.Speaking) { Doing = null; Set(VoiceMode.Idle); }
            else Changed?.Invoke();
        }
    }

    Task<bool> Send(JsonObject message)
    {
        Sent?.Invoke(message);
        return link.TrySendAsync(message);
    }

    Task<bool> SendAudio(byte[] pcm)
    {
        SentAudio?.Invoke(pcm);
        return link.TrySendAudioAsync(pcm);
    }

    /**
     * An admin switched something off for this computer, or on again. The microphone off: no listening (what is being
     * recorded is dropped); the speaker off: nothing plays (what is playing stops, and Axis is told it was blocked).
     */
    public void UseCapabilitiesOff(IReadOnlySet<string> off)
    {
        lock (gate)
        {
            if (Off.Count == 0 && off.Count == 0) return;
            Off = off;
            if (MicOff)
            {
                if (armed) Disarm();
                if (recording != null) Finish("cancel");
            }
            if (SpeakerOff && playing != null)
            {
                var was = playing;
                playing = null;
                if (io.StopPlayback()) _ = Send(new JsonObject { ["t"] = "playback", ["turnId"] = was, ["state"] = "stopped" });
                if (Mode == VoiceMode.Speaking) Mode = VoiceMode.Idle;
            }
        }
        Changed?.Invoke();
    }

    /**
     * The settings Axis sent: how long to listen, and how loud this app plays its speech and sounds (Axis lowers
     * `volume` in quiet hours). Announcements and timers play through the same speech, so they follow it too.
     */
    public void UseSettings(IReadOnlyDictionary<string, JsonElement> values)
    {
        lock (gate) Limits = Listening.Read(values);
        io.Volume = Listening.Volume(values);
    }

    /** Plays one of the app's sounds if the settings and the hour allow it, and nothing is being said. True when it played. */
    public bool Play(SoundKind kind)
    {
        if (SpeakerOff) return false;
        if (!Sounds.May(kind, DateTime.Now)) return false;
        // A finished task's notes never over the agent's voice or the person's.
        if (kind == SoundKind.TaskDone && (playing != null || recording != null)) return false;
        try { io.PlaySound(Sounds.Pcm(kind), Sounds.Rate); }
        catch (Exception e) { Failed?.Invoke($"sound: {e.Message}"); return false; }
        return true;
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
            if (MicOff) return;
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

    /** A choice picked on screen (a button in the pill): sent as the answer, as a tap on a board does. */
    public void Answer(string choice)
    {
        string? id;
        lock (gate)
        {
            id = askId;
            if (id == null || !Choices.Contains(choice)) return;
            askId = null;
            Question = null;
            Choices = [];
        }
        _ = Send(new JsonObject { ["t"] = "answer", ["askId"] = id, ["choice"] = choice });
        Changed?.Invoke();
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
            Finish(spoke || Clock() - startedAt > 900 ? "silence" : "cancel");
        }
    }

    string NewId() => $"pc-{Clock():x}-{++ids}";

    /**
     * The talk key went down where a tap types (no separate typing key). As Press while listening, thinking or speaking
     * (and false); otherwise the microphone opens with nothing sent yet, and true: then Commit (a hold) or Disarm (a tap).
     */
    public bool Arm()
    {
        lock (gate)
        {
            if (MicOff) return false;
            if (recording != null || Busy || playing != null || armed)
            {
                if (!armed) Press();
                return false;
            }
            preRoll.Clear();
            armed = true;
            try { io.StartCapture(OnFrame); }
            catch (Exception e)
            {
                armed = false;
                Reply = $"The microphone could not start: {e.Message}";
                Set(VoiceMode.Error);
                return false;
            }
            return true;
        }
    }

    /** The key is still down after TapMs: a hold. Listening starts with what was recorded since the key went down. */
    public void Commit()
    {
        lock (gate)
        {
            if (!armed) return;
            armed = false;
            Start(askId != null ? "question" : "hold", capturing: true);
            holding = true;
            var kept = preRoll.ToList();
            preRoll.Clear();
            foreach (var frame in kept)
            {
                var bytes = new byte[frame.Length * 2];
                Buffer.BlockCopy(frame, 0, bytes, 0, bytes.Length);
                _ = SendAudio(bytes);
            }
            // Speech in the pre-roll counts as speech.
            if (kept.Any(f => Rms(f) > SpeechLevel)) spoke = true;
        }
    }

    /** The key came up before TapMs: a tap. What was recorded is dropped and nothing was sent. True when it was armed. */
    public bool Disarm()
    {
        lock (gate)
        {
            if (!armed) return false;
            armed = false;
            preRoll.Clear();
            try { io.StopCapture(); } catch { }
            return true;
        }
    }

    static double Rms(short[] samples)
    {
        double energy = 0;
        foreach (var x in samples) energy += (double)x * x;
        return Math.Sqrt(energy / Math.Max(1, samples.Length)) / 32768.0;
    }

    /**
     * A typed turn, as the web client sends it (web/client.js 1126-1139): whatever is being said or recorded stops,
     * then `text` goes with a new turn id. Typed while a question is open, Axis takes it as the answer. False when
     * there is nothing to send (empty, or over 4000 characters).
     */
    public bool Type(string text)
    {
        var clean = TypedText.Clean(text);
        if (clean == null) return false;
        lock (gate)
        {
            if (armed) Disarm();
            Interrupt();
            // Axis answers the question with it and ends it; the choices go now.
            if (askId != null) { askId = null; Question = null; Choices = []; }
            var id = NewId();
            Heard = clean;
            Reply = "";
            Picture = null;
            replyTurn = id;
            _ = Send(TypedText.Message(id, clean));
            Doing = null;
            Set(VoiceMode.Thinking);
        }
        return true;
    }

    void Start(string trigger, bool capturing = false, int? wait = null)
    {
        var id = NewId();
        recording = id;
        voiceTurn = id;
        holding = false;
        spoke = false;
        quietSince = 0;
        startedAt = Clock();
        waitMs = wait ?? Limits.OnsetMs;
        Heard = Reply = "";
        Picture = null;
        Set(VoiceMode.Listening);
        _ = Send(new JsonObject
        {
            ["t"] = "audio.start",
            ["turnId"] = id,
            ["format"] = new JsonObject { ["encoding"] = "pcm_s16le", ["sampleRate"] = MicRate, ["channels"] = 1 },
            ["trigger"] = trigger,
        });
        // A follow-up has no cue: the pill turning green is enough when the computer was just talking (as on the boards).
        if (trigger != "follow_up") Play(SoundKind.Listen);
        if (capturing) return;
        try { io.StartCapture(OnFrame); }
        catch (Exception e)
        {
            recording = null;
            _ = Send(new JsonObject { ["t"] = "audio.end", ["turnId"] = id, ["reason"] = "cancel" });
            // A follow-up nobody asked for fails quietly.
            if (trigger == "follow_up") { Set(VoiceMode.Idle); return; }
            Reply = $"The microphone could not start: {e.Message}";
            Set(VoiceMode.Error);
        }
    }

    /**
     * After a spoken answer to what the person said here, listen `followUpMs` more without the key, so a conversation
     * goes on as it does with a board (docs/client-guide.md section 3). Silence ends it quietly. Never after speech
     * nobody here asked for (an announcement, a timer), nor when the answer was cut off (under the lock).
     */
    void FollowUp(string answered)
    {
        if (answered != voiceTurn || Limits.FollowUpMs <= 0 || MicOff || recording != null || armed) return;
        Start("follow_up", wait: Math.Max(1000, Limits.FollowUpMs));
    }

    void OnFrame(short[] samples)
    {
        byte[] bytes;
        lock (gate)
        {
            if (armed)
            {
                // Not yet known to be a hold: kept, and sent if it becomes one.
                if (preRoll.Count >= TalkPress.PreRollFrames) preRoll.RemoveAt(0);
                preRoll.Add(samples);
                return;
            }
            if (recording == null) return;
            double energy = 0;
            foreach (var x in samples) energy += (double)x * x;
            var level = Math.Sqrt(energy / Math.Max(1, samples.Length)) / 32768.0;
            Level = Math.Min(1, Math.Sqrt(Math.Max(0, (level - 0.004) / 0.08)));
            var now = Clock();
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
            _ = SendAudio(bytes);
            if (!holding && spoke && quietSince != 0 && now - quietSince > Limits.SilenceMs) Finish("silence");
            else if (now - startedAt > Limits.MaxMs) Finish("max");
            else if (!holding && !spoke && now - startedAt > waitMs) Finish("cancel");
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
        _ = Send(new JsonObject { ["t"] = "audio.end", ["turnId"] = id, ["reason"] = reason });
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
            if (io.StopPlayback() && was != null) _ = Send(new JsonObject { ["t"] = "playback", ["turnId"] = was, ["state"] = "stopped" });
            _ = Send(new JsonObject { ["t"] = "interrupt" });
            Set(VoiceMode.Idle);
        }
    }

    /** A message from Axis (the link's, or a check's). */
    public void Receive(string type, JsonElement m)
    {
        // A failure while handling one message must not take the connection with it.
        try { Handle(type, m); }
        catch (Exception e) { Failed?.Invoke(e.Message); }
    }

    /** Something went wrong handling a message from Axis (for the log). */
    public event Action<string>? Failed;

    void Handle(string type, JsonElement m)
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
                    if (S("turnId") != pictureTurn) Picture = null;
                    replyTurn = S("turnId");
                    Reply = final ? text : Reply + text;
                    Changed?.Invoke();
                    break;
                }
                case "reply.image":
                {
                    var url = S("url");
                    if (url == null || !Uri.TryCreate(link.Address.Http, url, out var full) || full.Scheme is not ("http" or "https")) break;
                    Picture = full;
                    pictureTurn = S("turnId");
                    Changed?.Invoke();
                    break;
                }
                case "speak.start":
                {
                    var id = S("turnId");
                    if (id == null) break;
                    var rate = m.TryGetProperty("format", out var fmt) && fmt.TryGetProperty("sampleRate", out var r) ? r.GetInt32() : 24000;
                    // The speaker switched off: nothing plays, and Axis hears so at once.
                    if (SpeakerOff)
                    {
                        _ = Send(new JsonObject { ["t"] = "playback", ["turnId"] = id, ["state"] = "blocked" });
                        break;
                    }
                    // Speech that comes while the person is talking to it waits its turn: theirs comes first.
                    if (recording != null) Finish("silence");
                    if (playing != null) io.StopPlayback();
                    playing = id;
                    io.PlayBegin(rate);
                    _ = Send(new JsonObject { ["t"] = "playback", ["turnId"] = id, ["state"] = "started" });
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
                            _ = Send(new JsonObject { ["t"] = "playback", ["turnId"] = id, ["state"] = "finished" });
                            if (Mode == VoiceMode.Speaking) Set(VoiceMode.Idle);
                            FollowUp(id);
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
                    if (io.StopPlayback() && was != null) _ = Send(new JsonObject { ["t"] = "playback", ["turnId"] = was, ["state"] = "stopped" });
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
