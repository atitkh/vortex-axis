using System.Text.Json;

namespace Axis.Desktop;

/** One row of a task's list: a step (done, running, still to come) or another task (waiting for the person or not). */
public sealed record TaskRow(string Kind, string Text);

/**
 * An agent's long task as Axis sends it in `progress.show` (server `progress.ts`): the one reported on last, how far
 * along, its steps and the other tasks. Read the way the web client and the boards read it.
 */
public sealed record TaskLine(string Title, string Note, int Done, int Total, string State, int Count, IReadOnlyList<TaskRow> Steps, IReadOnlyList<TaskRow> Others, bool Chime)
{
    public static TaskLine Read(JsonElement p)
    {
        string S(string key) => p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
        int N(string key) => p.ValueKind == JsonValueKind.Object && p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? (int)Math.Round(v.GetDouble()) : 0;
        static List<string> Lines(string s) => s.Length == 0 ? [] : s.Split('\n').Where(l => l.Length > 0).ToList();
        var steps = Lines(S("steps")).Select(l => new TaskRow(l[0] switch { 'x' => "done", '>' => "running", _ => "pending" }, l[1..].Trim())).ToList();
        // `!` leads another task that waits for the person.
        var others = Lines(S("others")).Select(l => new TaskRow(l[0] == '!' ? "needs" : "task", l[1..].Trim())).ToList();
        var chime = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("chime", out var c) && c.ValueKind == JsonValueKind.True;
        var done = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("done", out var d) && d.ValueKind == JsonValueKind.Number ? (int)Math.Round(d.GetDouble()) : -1;
        return new TaskLine(S("title"), S("note"), done, Math.Max(0, N("total")), S("state") is { Length: > 0 } st ? st : "none", Math.Max(0, N("count")), steps, others, chime);
    }

    /** Anything to show. */
    public bool Shown => Count > 0 && Title.Length > 0;
    public bool Finished => State == "done";
    public bool NeedsYou => State == "blocked";

    /** How far along, 0 to 1, when that is known (a count of steps, or done); null for no bar. */
    public double? Part => Finished ? 1 : Total > 0 ? Math.Clamp(Math.Max(0, Done) / (double)Total, 0, 1) : null;

    /** The pill's word for how it stands. */
    public string Word => Finished ? "Done" : NeedsYou ? "Needs you" : "Working";

    /** What follows the title: "3/7", the note, "waiting for you: why". */
    public string Detail => Finished ? "" : NeedsYou ? (Note.Length > 0 ? Note : "") : Total > 0 ? $"{Math.Max(0, Done)}/{Total}" : Note;

    /** More tasks than the one on the line, as "+2"; empty with one. */
    public string More => Count > 1 ? $"+{Count - 1}" : "";

    /** A list to open: the other tasks, then this one's steps. */
    public bool HasList => Steps.Count + Others.Count > 0;
}

/** The next timer, from `timer.next` (server `timers.ts`): its name, when it rings, how many there are, its id to cancel by. */
public sealed record TimerLine(string Label, long EndsAt, int Count, long? Id)
{
    /** Null when there is no timer. `now` is a millisecond clock (Environment.TickCount64). */
    public static TimerLine? Read(JsonElement p, long now)
    {
        if (p.ValueKind != JsonValueKind.Object) return null;
        var ms = p.TryGetProperty("ms", out var m) && m.ValueKind == JsonValueKind.Number ? m.GetDouble() : 0;
        if (ms <= 0) return null;
        var label = p.TryGetProperty("label", out var l) && l.ValueKind == JsonValueKind.String ? l.GetString() ?? "" : "";
        var count = p.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number ? Math.Max(1, (int)c.GetDouble()) : 1;
        // An older Axis does not say which timer it is; then there is nothing to cancel by.
        long? id = p.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.Number ? (long)i.GetDouble() : null;
        return new TimerLine(label.Length > 0 ? label : "Timer", now + (long)ms, count, id);
    }

    public int SecondsLeft(long now) => (int)Math.Max(0, Math.Ceiling((EndsAt - now) / 1000.0));

    /** "4:32", "1:04:32", as the web client writes it. */
    public string Clock(long now)
    {
        var left = SecondsLeft(now);
        int h = left / 3600, m = left % 3600 / 60, s = left % 60;
        return h > 0 ? $"{h}:{m:00}:{s:00}" : $"{m}:{s:00}";
    }

    /** More timers behind this one, as "+1". */
    public string More => Count > 1 ? $"+{Count - 1}" : "";

    /** The last ten seconds (the boards' red glow). */
    public bool Final(long now) => SecondsLeft(now) <= 10;

    public bool CanCancel => Id != null;
}

/**
 * What the task-and-timer pill shows, from the two commands Axis sends every client with a screen. A finished task leaves
 * 90 s after it finished, as on the boards (Axis also takes it away then; this covers a missed update), or at once when put
 * away (`swipe_down`, as a swipe on a board).
 */
public sealed class Glance
{
    public const long DoneShownMs = 90_000;

    public TaskLine? Task { get; private set; }
    public TimerLine? Timer { get; private set; }
    /** How many questions wait for the person on another device, or on none (`ask.waiting`); 0 for none. */
    public int Elsewhere { get; private set; }

    /** What `ask.waiting` says, as the Mac app says it: empty for none. */
    public static string ElsewhereWords(int n) => n <= 0 ? "" : n == 1 ? "A question waits for you elsewhere" : $"{n} questions wait for you elsewhere";
    long doneSince;

    /** Anything shown changed. */
    public event Action? Changed;
    /** A task has just finished and Axis asked for its chime. */
    public event Action? TaskChime;

    /** The commands this part carries out (the screen's, not the desktop tool's). */
    public static readonly IReadOnlySet<string> Commands = new HashSet<string> { "progress.show", "timer.next", "ask.waiting" };

    /** Carries out `progress.show`, `timer.next` or `ask.waiting`; false for any other command. `now` is a millisecond clock. */
    public bool Handle(string name, JsonElement p, long now)
    {
        switch (name)
        {
            case "progress.show":
            {
                var line = TaskLine.Read(p);
                var was = Task;
                if (!line.Finished) doneSince = 0;
                else if (was == null || !was.Finished || was.Title != line.Title || doneSince == 0) doneSince = now;
                Task = line.Shown ? line : null;
                Changed?.Invoke();
                if (line.Chime) TaskChime?.Invoke();
                return true;
            }
            case "timer.next":
                Timer = TimerLine.Read(p, now);
                Changed?.Invoke();
                return true;
            case "ask.waiting":
                // A question waiting where it is not shown here (server `asklight.ts`): a quiet line, as the boards glow blue.
                Elsewhere = p.ValueKind == JsonValueKind.Object && p.TryGetProperty("elsewhere", out var e) && e.ValueKind == JsonValueKind.Number ? Math.Max(0, (int)e.GetDouble()) : 0;
                Changed?.Invoke();
                return true;
        }
        return false;
    }

    /** The task to show at `now`: none once a finished one has been up for 90 s. */
    public TaskLine? TaskAt(long now) => Task is { Finished: true } && doneSince != 0 && now - doneSince > DoneShownMs ? null : Task;

    /** The timer to show at `now`: none once it has rung (Axis says which is next soon after). */
    public TimerLine? TimerAt(long now) => Timer is { } t && t.EndsAt + 2000 > now ? t : null;

    /** Something to show at `now`. */
    public bool Any(long now) => TaskAt(now) != null || TimerAt(now) != null || Elsewhere > 0;

    /** The link went: what was shown may be out of date by the time it is back; Axis tells it all again on connecting. */
    public void Clear()
    {
        Task = null;
        Timer = null;
        Elsewhere = 0;
        doneSince = 0;
        Changed?.Invoke();
    }
}
