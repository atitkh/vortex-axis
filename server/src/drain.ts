/**
 * Reads a response body as fast as it arrives and hands the chunks out at the caller's pace.
 *
 * Node's built-in fetch (undici before 8.6) kills the whole process with an assertion no
 * try/catch can reach when a connection closes while its body is paused for backpressure:
 * https://github.com/nodejs/undici/issues/5360. Axis reads speech at real-time pace, so a
 * body left waiting while the speaker catches up is exactly that case. Reading eagerly into
 * memory means undici never pauses. A reply is a sentence of audio or a stream of text, so
 * holding it costs at most a few hundred kilobytes.
 */
export async function* drain(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  const queue: Uint8Array[] = [];
  let done = false;
  let failed = false;
  let failure: unknown;
  let notify = () => {};
  let ready = new Promise<void>((resolve) => (notify = resolve));

  const pump = (async () => {
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        queue.push(value);
        notify();
      }
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      done = true;
      notify();
    }
  })();

  try {
    for (;;) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (failed) throw failure;
      if (done) return;
      await ready;
      // A new promise before the queue is checked again, so a chunk that lands now is not missed.
      ready = new Promise<void>((resolve) => (notify = resolve));
    }
  } finally {
    // Stopped early (an interruption): stop reading and let the connection go.
    if (!done) await reader.cancel().catch(() => {});
    await pump;
  }
}
