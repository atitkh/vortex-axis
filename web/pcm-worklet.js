// Runs on the audio thread: collects microphone samples and hands them to the page about
// every 20 ms. Posting each 128-sample block on its own (375 times a second) kept the page's
// main thread so busy that the face's animation stuttered.
const BATCH = 1024;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BATCH);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || !channel.length) return true;
    let at = 0;
    while (at < channel.length) {
      const take = Math.min(channel.length - at, BATCH - this.filled);
      this.buffer.set(channel.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (this.filled === BATCH) {
        // Handed over, not copied; a fresh buffer takes its place.
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(BATCH);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
