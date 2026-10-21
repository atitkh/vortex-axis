using System.Text.Json;

namespace Axis.Desktop;

/** The app's own sounds: no files, each made in code from a few sine tones. */
public enum SoundKind
{
    /** Axis's `chime` action: a small bell before a timer is announced. */
    Chime,
    /** Two soft notes when an agent's long task finishes (`taskChime`). */
    TaskDone,
    /** A short rising tone when it starts listening (`listenCue`). */
    Listen,
}

/**
 * When a sound may play, from the settings Axis sends (the boards' `listenCue` and `taskChime`, and the quiet hours
 * `quietFrom`/`quietTo`), and the sounds themselves as 16-bit mono samples. Never anything in quiet hours.
 */
public sealed class Sounds
{
    public const int Rate = 24000;

    bool listenCue = true, taskChime = true;
    string? quietFrom, quietTo;

    public void UseSettings(IReadOnlyDictionary<string, JsonElement> values)
    {
        listenCue = Toggle(values, "listenCue", true);
        taskChime = Toggle(values, "taskChime", true);
        quietFrom = Text(values, "quietFrom");
        quietTo = Text(values, "quietTo");
    }

    static bool Toggle(IReadOnlyDictionary<string, JsonElement> values, string key, bool fallback) =>
        !values.TryGetValue(key, out var v) ? fallback : v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number => v.GetDouble() != 0,
            JsonValueKind.String => v.GetString() is not ("0" or "false" or "off" or ""),
            _ => fallback,
        };

    static string? Text(IReadOnlyDictionary<string, JsonElement> values, string key) =>
        values.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /** Whether `kind` may sound at `now` (this computer's clock; Axis's quiet hours are in the hub's time zone, normally the same). */
    public bool May(SoundKind kind, DateTime now)
    {
        if (Quiet(quietFrom, quietTo, now.Hour * 60 + now.Minute)) return false;
        return kind switch
        {
            SoundKind.Listen => listenCue,
            SoundKind.TaskDone => taskChime,
            _ => true,
        };
    }

    /** Minutes since midnight for "HH:MM", or null; as server `quiet.ts` `minutesOf`. */
    public static int? MinutesOf(string? value)
    {
        var m = System.Text.RegularExpressions.Regex.Match(value ?? "", @"^\s*(\d{1,2}):(\d{2})\s*$");
        if (!m.Success) return null;
        int h = int.Parse(m.Groups[1].Value), min = int.Parse(m.Groups[2].Value);
        return h < 24 && min < 60 ? h * 60 + min : null;
    }

    /** In the quiet hours at minute `now` of the day; a stretch may run over midnight. Both empty or equal: none. As `quiet.ts` `isQuiet`. */
    public static bool Quiet(string? from, string? to, int now)
    {
        if (MinutesOf(from) is not int f || MinutesOf(to) is not int t || f == t) return false;
        return f < t ? now >= f && now < t : now >= f || now < t;
    }

    /**
     * How loud a struck tone is `t` seconds after it starts, 0 to 1: up in `attack` seconds, then down exponentially to a
     * thousandth at `length` (as the web client's `linearRamp` then `exponentialRamp`), and nothing after.
     */
    public static double Envelope(double t, double attack, double length)
    {
        if (t <= 0 || t >= length) return 0;
        if (t < attack) return t / attack;
        return Math.Pow(0.001, (t - attack) / (length - attack));
    }

    /** The samples for `kind`. */
    public static short[] Pcm(SoundKind kind, int rate = Rate)
    {
        // (start s, Hz, peak, length s, partials as (multiple, share)).
        (double At, double Hz, double Peak, double Length, (double Mul, double Share)[] Partials)[] notes = kind switch
        {
            // Two soft notes, E5 then A5, as web/client.js `chime`.
            SoundKind.TaskDone => [(0, 659.25, 0.22, 0.5, [(1, 1)]), (0.16, 880, 0.22, 0.5, [(1, 1)])],
            // A small bell, two strikes, with the overtones that make it ring.
            SoundKind.Chime => [(0, 987.77, 0.26, 0.7, [(1, 0.7), (2, 0.2), (3, 0.1)]), (0.2, 783.99, 0.26, 0.75, [(1, 0.7), (2, 0.2), (3, 0.1)])],
            _ => [],
        };
        if (kind == SoundKind.Listen) return Sweep(rate, 520, 780, 0.14, 0.16);
        var total = notes.Max(n => n.At + n.Length);
        var samples = new double[(int)Math.Ceiling(total * rate)];
        foreach (var (at, hz, peak, length, partials) in notes)
        {
            var from = (int)(at * rate);
            for (var i = 0; i < (int)(length * rate) && from + i < samples.Length; i++)
            {
                var t = i / (double)rate;
                var level = peak * Envelope(t, 0.02, length);
                double s = 0;
                foreach (var (mul, share) in partials) s += share * Math.Sin(2 * Math.PI * hz * mul * t);
                samples[from + i] += level * s;
            }
        }
        return samples.Select(Short).ToArray();
    }

    /** A tone that glides from `fromHz` to `toHz`, with a short fade at each end so it does not click. */
    static short[] Sweep(int rate, double fromHz, double toHz, double length, double peak)
    {
        var n = (int)(length * rate);
        var output = new short[n];
        double phase = 0;
        for (var i = 0; i < n; i++)
        {
            var t = i / (double)rate;
            phase += 2 * Math.PI * (fromHz + (toHz - fromHz) * t / length) / rate;
            var fade = Math.Min(1, Math.Min(t / 0.01, (length - t) / 0.03));
            output[i] = Short(peak * Math.Max(0, fade) * Math.Sin(phase));
        }
        return output;
    }

    static short Short(double x) => (short)Math.Round(Math.Clamp(x, -1, 1) * 32767);
}
