using System.Text.Json.Nodes;

namespace Axis.Desktop;

/** What the operating system says about power. A null is unknown and is not sent (client guide, section 11). */
public sealed record PowerState(int? Battery, bool? Charging, bool? OnPower)
{
    public static readonly PowerState Unknown = new(null, null, null);

    /**
     * From Win32 `SYSTEM_POWER_STATUS`: `ACLineStatus` (0 off, 1 on, 255 unknown), `BatteryFlag` (8 charging, 128 no
     * system battery, 255 unknown) and `BatteryLifePercent` (255 unknown). A computer with no battery gives only onPower.
     */
    public static PowerState FromWin32(byte acLine, byte batteryFlag, byte batteryPercent)
    {
        bool? onPower = acLine switch { 0 => false, 1 => true, _ => null };
        if (batteryFlag != 255 && (batteryFlag & 128) != 0) return new(null, null, onPower);
        int? battery = batteryPercent <= 100 ? batteryPercent : null;
        bool? charging = batteryFlag == 255 ? null : (batteryFlag & 8) != 0;
        return new(battery, charging, onPower);
    }
}

/** Turns started on this computer since local midnight. */
public sealed class TurnCount(Func<DateTime>? localNow = null)
{
    readonly Func<DateTime> now = localNow ?? (() => DateTime.Now);
    readonly object gate = new();
    DateOnly day;
    int count;

    public void Add() { lock (gate) { Roll(); count++; } }

    public int Today { get { lock (gate) { Roll(); return count; } } }

    void Roll()
    {
        var d = DateOnly.FromDateTime(now());
        if (d != day) { day = d; count = 0; }
    }
}

/** When to send: at once after connecting, on a change at most every 30 s, otherwise every minute. */
public sealed class ReadingsPace
{
    public const long ChangeMs = 30_000, RegularMs = 60_000;
    (PowerState, int)? last;
    long lastAt;

    public void Connected() => last = null;

    public bool Due(PowerState power, int turnsToday, long nowMs)
    {
        if (last == null) return true;
        var since = nowMs - lastAt;
        return since >= RegularMs || (since >= ChangeMs && last != (power, turnsToday));
    }

    public void Sent(PowerState power, int turnsToday, long nowMs) { last = (power, turnsToday); lastAt = nowMs; }
}

/**
 * Sends `sense` readings about power and use (battery, charging, onPower, turnsToday, uptimeS). The operating system is
 * asked on this class's own loop, never on the UI thread or the talk key's path.
 */
public sealed class Readings : IDisposable
{
    public const int TickMs = 5_000;
    readonly Func<PowerState> readPower;
    readonly Func<long?> uptimeS;
    readonly Func<long> clock;
    readonly ReadingsPace pace = new();
    readonly SemaphoreSlim pokes = new(0);
    readonly CancellationTokenSource stop = new();
    AxisLink? link;
    volatile bool fresh;

    public TurnCount Turns { get; }

    public Readings(Func<PowerState> readPower, TurnCount? turns = null, Func<long?>? uptimeS = null, Func<long>? clock = null)
    {
        this.readPower = readPower;
        Turns = turns ?? new TurnCount();
        this.uptimeS = uptimeS ?? (() => Environment.TickCount64 / 1000);
        this.clock = clock ?? (() => Environment.TickCount64);
    }

    public static JsonObject Message(PowerState power, int turnsToday, long? uptimeS)
    {
        var r = new JsonObject();
        if (power.Battery is int b) r["battery"] = Math.Clamp(b, 0, 100);
        if (power.Charging is bool c) r["charging"] = c ? 1 : 0;
        if (power.OnPower is bool o) r["onPower"] = o ? 1 : 0;
        r["turnsToday"] = turnsToday;
        if (uptimeS is long u) r["uptimeS"] = u;
        return new JsonObject { ["t"] = "sense", ["readings"] = r };
    }

    /** Reports over this link from now on (a new link after pairing again replaces the old one). Starts the loop once. */
    public void Attach(AxisLink next)
    {
        var first = link == null;
        link = next;
        next.TurnStarted += () => { if (link == next) Turns.Add(); };
        next.StateChanged += (state, _) => { if (link == next && state == LinkState.Online) { fresh = true; Poke(); } };
        if (first) _ = Task.Run(LoopAsync);
    }

    /** Something may have changed (power plugged in or out, waking): look now rather than at the next tick. */
    public void Poke() { if (pokes.CurrentCount == 0) pokes.Release(); }

    async Task LoopAsync()
    {
        var ct = stop.Token;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await pokes.WaitAsync(TickMs, ct);
                await CheckAsync();
            }
            catch (OperationCanceledException) { return; }
            catch { /* a failed reading is tried again on the next tick */ }
        }
    }

    async Task CheckAsync()
    {
        var l = link;
        if (l == null || l.State != LinkState.Online) return;
        if (fresh) { fresh = false; pace.Connected(); }
        PowerState power;
        try { power = readPower(); } catch { power = PowerState.Unknown; }
        var turns = Turns.Today;
        var now = clock();
        if (!pace.Due(power, turns, now)) return;
        if (await l.TrySendAsync(Message(power, turns, uptimeS()))) pace.Sent(power, turns, now);
    }

    public void Dispose() => stop.Cancel();
}
