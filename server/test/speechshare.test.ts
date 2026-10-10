import { describe, expect, it } from "vitest";
import { SpeechShare, type TextToSpeech } from "../src/speech.js";

/** A voice that hands out its audio a piece at a time, when told to. */
function slowVoice() {
  const asked: string[] = [];
  const waiting: (() => void)[] = [];
  const tts: TextToSpeech = {
    format: { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
    synthesize: (text) =>
      (async function* () {
        asked.push(text);
        for (let i = 0; i < 3; i++) {
          await new Promise<void>((resolve) => waiting.push(resolve));
          yield Buffer.from([i]);
        }
      })(),
    healthy: async () => true,
  };
  return { tts, asked, next: () => waiting.splice(0).forEach((resolve) => resolve()) };
}

const collect = async (source: AsyncIterable<Buffer>) => {
  const out: number[] = [];
  for await (const chunk of source) out.push(chunk[0]!);
  return out;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("a speech share", () => {
  it("makes each sentence once per voice and plays it to everybody from the start", async () => {
    const voice = slowVoice();
    const shared = new SpeechShare().for(voice.tts);
    const first = collect(shared.synthesize("Hello.", {}));
    await tick();
    voice.next();
    await tick();
    // A latecomer still hears it from the beginning.
    const second = collect(shared.synthesize("Hello.", {}));
    const other = collect(shared.synthesize("Hello.", { voice: "6" }));
    for (let i = 0; i < 6; i++) {
      await tick();
      voice.next();
    }
    expect(await first).toEqual([0, 1, 2]);
    expect(await second).toEqual([0, 1, 2]);
    expect(await other).toEqual([0, 1, 2]);
    expect(voice.asked).toEqual(["Hello.", "Hello."]);
  });

  it("keeps making it for the others when one listener stops", async () => {
    const voice = slowVoice();
    const shared = new SpeechShare().for(voice.tts);
    const stop = new AbortController();
    const quitter = collect(shared.synthesize("Hi.", {}, stop.signal));
    const stayer = collect(shared.synthesize("Hi.", {}));
    await tick();
    voice.next();
    await tick();
    stop.abort();
    for (let i = 0; i < 3; i++) {
      await tick();
      voice.next();
    }
    expect((await quitter).length).toBeLessThan(3);
    expect(await stayer).toEqual([0, 1, 2]);
  });
});
