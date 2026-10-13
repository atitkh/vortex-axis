using System;
using System.Threading;
using System.Threading.Tasks;

namespace Axis.Desktop.App;

/**
 * Runs UI Automation work off the thread pool. A UI Automation call into a window that does not answer
 * blocks its thread with no timeout of its own; on pool threads, a handful of those starved the whole app
 * (0.4.0: looks went unanswered). Here each call gets its own background thread and a deadline: past it,
 * the caller gets a TimeoutException and the stuck thread is left to finish, or not, on its own.
 */
static class Uia
{
    /** Threads still stuck in a call past its deadline. Past MaxStuck, new calls fail at once instead of piling up. */
    static int stuck;
    const int MaxStuck = 8;

    public static int Stuck => Volatile.Read(ref stuck);

    public static Task<T> Run<T>(Func<T> work, int ms, string what, CancellationToken ct, ApartmentState apartment = ApartmentState.MTA)
    {
        if (Stuck >= MaxStuck)
            return Task.FromException<T>(new TimeoutException($"Windows' screen reading is stuck ({Stuck} reads never came back; a window is not answering). Close or restart the frozen app, or restart VorteX Axis"));
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var late = 0;  // 1 once the deadline has passed and the thread is counted as stuck
        var thread = new Thread(() =>
        {
            try { done.TrySetResult(work()); }
            catch (Exception e) { done.TrySetException(e); }
            finally { if (Interlocked.Exchange(ref late, 2) == 1) Interlocked.Decrement(ref stuck); }
        }) { IsBackground = true, Name = $"uia {what}" };
        // The clipboard wants a single-threaded apartment; UI Automation is happiest in a multi-threaded one.
        thread.SetApartmentState(apartment);
        thread.Start();
        _ = Deadline();
        return done.Task;

        async Task Deadline()
        {
            try { await Task.WhenAny(done.Task, Task.Delay(ms, ct)); } catch { }
            if (done.Task.IsCompleted) return;
            if (Interlocked.CompareExchange(ref late, 1, 0) == 0) Interlocked.Increment(ref stuck);
            if (ct.IsCancellationRequested) done.TrySetCanceled(ct);
            else done.TrySetException(new TimeoutException($"{what} took longer than {ms / 1000.0:0.#} s; a window is not answering"));
        }
    }

    public static Task Run(Action work, int ms, string what, CancellationToken ct, ApartmentState apartment = ApartmentState.MTA) =>
        Run(() => { work(); return true; }, ms, what, ct, apartment);
}
