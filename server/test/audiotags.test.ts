import { describe, expect, it } from "vitest";
import type { AudioFormat } from "@vortex-axis/protocol";
import type { Agent } from "../src/agent.js";
import { DEFAULT_AUDIO_TAGS_NOTE, DEFAULT_GATEWAY_NOTE, DEFAULT_SYSTEM_PROMPT } from "../src/agent.js";
import { AUDIO_TAG_MODEL_PREFIXES, effectiveAudioTags, isTagsOnly, stripAudioTags, supportsAudioTags } from "../src/audiotags.js";
import { FallbackTextToSpeech, type RankedEntry } from "../src/fallback.js";
import { SentenceSplitter } from "../src/sentences.js";
import type { TextToSpeech } from "../src/speech.js";
import { Store } from "../src/store.js";
import type { Services } from "../src/turns.js";
import { applyRuntimeConfig, audioTagsActive, gatewayNoteFor, loadRuntimeConfig, publicRuntimeConfig, saveRuntimeConfig, systemPromptFor, type TtsEntry } from "../src/upstream.js";
import * as se from "../../web/speech-entries.js";
import { config } from "./harness.js";

const el = (model: string, extra: Partial<TtsEntry> = {}) => ({ kind: "elevenlabs", model, voice: "v", apiKey: "k", url: "", ...extra });
const local = (extra = {}) => ({ kind: "openai", url: "http://127.0.0.1:9/tts", model: "tts-1", ...extra });

describe("audio tag support", () => {
  it("is for ElevenLabs v3/v4 models, unless the entry says off", () => {
    expect(supportsAudioTags({ kind: "elevenlabs", model: "eleven_v4_turbo" })).toBe(true);
    expect(supportsAudioTags({ kind: "elevenlabs", model: "eleven_v4" })).toBe(true);
    expect(supportsAudioTags({ kind: "elevenlabs", model: "eleven_v3" })).toBe(true);
    expect(supportsAudioTags({ kind: "elevenlabs", model: "eleven_v3_conversational" })).toBe(true);
    expect(supportsAudioTags({ kind: "elevenlabs", model: "eleven_flash_v2_5" })).toBe(false);
    expect(supportsAudioTags({ kind: "elevenlabs", model: "eleven_multilingual_v2" })).toBe(false);
    expect(supportsAudioTags({ kind: "elevenlabs", model: "" })).toBe(false);
    expect(supportsAudioTags({ kind: "openai", model: "eleven_v4_turbo" })).toBe(false);
    expect(effectiveAudioTags({ kind: "elevenlabs", model: "eleven_v4_turbo" })).toBe(true);
    expect(effectiveAudioTags({ kind: "elevenlabs", model: "eleven_v4_turbo", audioTags: "auto" })).toBe(true);
    expect(effectiveAudioTags({ kind: "elevenlabs", model: "eleven_v4_turbo", audioTags: "off" })).toBe(false);
    expect(effectiveAudioTags({ kind: "openai", model: "tts-1", audioTags: "auto" })).toBe(false);
  });

  it("agrees between the server and the admin page", () => {
    expect([...se.AUDIO_TAG_MODEL_PREFIXES]).toEqual([...AUDIO_TAG_MODEL_PREFIXES]);
    for (const model of ["eleven_v4_turbo", "eleven_v3", "eleven_flash_v2_5", "eleven_multilingual_v2", "tts-1", ""]) {
      for (const kind of ["elevenlabs", "openai"]) expect(se.modelSupportsAudioTags(kind, model)).toBe(supportsAudioTags({ kind, model }));
    }
  });
});

describe("stripAudioTags", () => {
  it("takes tags out and collapses the space left", () => {
    expect(stripAudioTags("[whispers] Come closer.")).toBe("Come closer.");
    expect(stripAudioTags("Fine. [sighs] I will do it.")).toBe("Fine. I will do it.");
    expect(stripAudioTags("[strong French accent] Bonjour.")).toBe("[strong French accent] Bonjour.".replace("[strong French accent] ", ""));
    expect(stripAudioTags("Oh [laughs harder] that's good [laughs]")).toBe("Oh that's good ");
    expect(stripAudioTags("It's [don't-stop] fine")).toBe("It's fine");
  });

  it("takes layered tags (a comma inside one pair of brackets) out", () => {
    expect(stripAudioTags("[whispering, playful] Guess what.")).toBe("Guess what.");
    expect(stripAudioTags("Fine. [nervous, trying to sound confident] Here goes.")).toBe("Fine. Here goes.");
  });

  it("takes out every tag the built-in note offers, and nothing else of it", () => {
    const tags = DEFAULT_AUDIO_TAGS_NOTE.match(/\[[^\]]+\]/g) ?? [];
    expect(tags.length).toBeGreaterThan(40);
    for (const t of tags) expect(stripAudioTags(`${t} Hello.`), t).toBe("Hello.");
  });

  it("leaves ordinary text alone", () => {
    for (const t of ["see [1]", "see [link](http://x)", "done [x]", "todo [ ] item", "[X] ok", "a [b: c] d", "note[1]: text", "[[whispers]]", "[a]", "[two\nlines]", "[]", "plain text", "[abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz]", "[é]x"]) {
      expect(stripAudioTags(t), t).toBe(t);
    }
  });

  it("is idempotent", () => {
    for (const t of ["[whispers] hi [sighs] there [x]", "a[laughs]b", "[laughs] [sighs] ", "plain"]) {
      const once = stripAudioTags(t);
      expect(stripAudioTags(once)).toBe(once);
    }
  });

  it("knows a fragment of only tags", () => {
    expect(isTagsOnly("[laughs]")).toBe(true);
    expect(isTagsOnly("[laughs] [sighs]\n")).toBe(true);
    expect(isTagsOnly("[laughs] ha")).toBe(false);
    expect(isTagsOnly("[1]")).toBe(false);
    expect(isTagsOnly("")).toBe(false);
  });
});

function pieces(chunks: string[], tags: boolean): string[] {
  const s = new SentenceSplitter(12, 220, tags);
  const out: string[] = [];
  for (const c of chunks) out.push(...s.pushPieces(c).map((p) => p.text));
  const rest = s.flushPiece();
  if (rest) out.push(rest.text);
  return out;
}

describe("the sentence splitter with audio tags", () => {
  it("gives the same pieces for text without tags", () => {
    const texts = [
      ["The lights are on. It is 3.5 degrees out", "side, and the sun is [1] up.\n\nAnything else? Yes! Done."],
      ["Hello", " there. How are you doing today? ", "Fine"],
      ["a ".repeat(150), "end. ok see [link](x) now. Bye."],
    ];
    for (const t of texts) expect(pieces(t, true)).toEqual(pieces(t, false));
  });

  it("keeps a leading tag with its sentence", () => {
    expect(pieces(["Okay then, that is fine. [whispers] Come a bit closer to me. Now go."], true)).toEqual(["Okay then, that is fine.", "[whispers] Come a bit closer to me.", "Now go."]);
  });

  it("never sends a tag-only fragment alone", () => {
    expect(pieces(["That is fine with me. [laughs harder]\nThat was funny, truly. Bye now."], true)).toEqual(["That is fine with me.", "[laughs harder]\nThat was funny, truly.", "Bye now."]);
    expect(pieces(["Hello there my friend. [sighs]"], true)).toEqual(["Hello there my friend."]);
    expect(pieces(["[sighs]"], true)).toEqual([]);
  });
});

describe("the note to the agent", () => {
  const base = { systemPrompt: "", gatewayNote: "", audioTagsNote: "" };
  it("is untouched when tags are not in use", () => {
    expect(gatewayNoteFor(base)).toBe(DEFAULT_GATEWAY_NOTE);
    expect(gatewayNoteFor(base, false)).toBe(DEFAULT_GATEWAY_NOTE);
    expect(gatewayNoteFor({ gatewayNote: "mine", audioTagsNote: "tags" })).toBe("mine");
    expect(systemPromptFor(base)).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(systemPromptFor({ systemPrompt: "own" }, false)).toBe("own");
  });
  it("gets the audio tags paragraph after it when in use; custom replaces it; - removes it", () => {
    expect(gatewayNoteFor(base, true)).toBe(`${DEFAULT_GATEWAY_NOTE}\n\n${DEFAULT_AUDIO_TAGS_NOTE}`);
    expect(gatewayNoteFor({ ...base, audioTagsNote: "Use [sighs]." }, true)).toBe(`${DEFAULT_GATEWAY_NOTE}\n\nUse [sighs].`);
    expect(gatewayNoteFor({ ...base, audioTagsNote: "-" }, true)).toBe(DEFAULT_GATEWAY_NOTE);
    expect(gatewayNoteFor({ ...base, gatewayNote: "-" }, true)).toBe(DEFAULT_AUDIO_TAGS_NOTE);
    expect(systemPromptFor(base, true)).toBe(`${DEFAULT_SYSTEM_PROMPT}\n\n${DEFAULT_AUDIO_TAGS_NOTE}`);
    expect(systemPromptFor({ ...base, audioTagsNote: "-" }, true)).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});

describe("tags in use in a running config", () => {
  const fresh = () => ({ store: new Store(":memory:"), cfg: config() });
  const agent = () => {
    const notes: string[] = [];
    const a = { reply: async function* () {}, healthy: async () => true, setNote: (n: string) => notes.push(n) } as unknown as Agent;
    return { a, notes };
  };
  const apply = (store: Store, cfg: ReturnType<typeof config>, a: Agent, services: Services = {}) => {
    applyRuntimeConfig(services, loadRuntimeConfig(store, cfg), a, "main");
    return services;
  };

  it("follows the top-ranked entry", () => {
    const entries = (list: object[]) => audioTagsActive(saveRuntimeConfig(new Store(":memory:"), config(), { tts: { entries: list } }).tts.entries);
    expect(entries([el("eleven_v4_turbo")])).toBe(true);
    expect(entries([local(), el("eleven_v4_turbo")])).toBe(false);
    expect(entries([el("eleven_flash_v2_5"), el("eleven_v4_turbo")])).toBe(false);
    expect(entries([el("eleven_v4_turbo", { audioTags: "off" })])).toBe(false);
    expect(entries([el("eleven_v4_turbo", { enabled: false }), el("eleven_v3")])).toBe(true);
    expect(entries([])).toBe(false);
  });

  it("adds the note to the gateway agent, live, and not otherwise", () => {
    const { store, cfg } = fresh();
    const { a, notes } = agent();
    saveRuntimeConfig(store, cfg, { tts: { entries: [local()] } });
    let services = apply(store, cfg, a);
    expect(services.audioTags).toBe(false);
    expect(notes.at(-1)).toBe(DEFAULT_GATEWAY_NOTE);
    saveRuntimeConfig(store, cfg, { tts: { entries: [el("eleven_v4_turbo")] } });
    services = apply(store, cfg, a, services);
    expect(services.audioTags).toBe(true);
    expect(notes.at(-1)).toBe(`${DEFAULT_GATEWAY_NOTE}\n\n${DEFAULT_AUDIO_TAGS_NOTE}`);
    saveRuntimeConfig(store, cfg, { agent: { audioTagsNote: "-" } });
    apply(store, cfg, a, services);
    expect(notes.at(-1)).toBe(DEFAULT_GATEWAY_NOTE);
    saveRuntimeConfig(store, cfg, { agent: { audioTagsNote: "custom" }, tts: { entries: [local(), el("eleven_v4_turbo")] } });
    services = apply(store, cfg, a, services);
    expect(services.audioTags).toBe(false);
    expect(notes.at(-1)).toBe(DEFAULT_GATEWAY_NOTE);
  });

  it("validates, migrates and publishes the settings without exposing secrets", () => {
    const { store, cfg } = fresh();
    expect(() => saveRuntimeConfig(store, cfg, { tts: { entries: [el("eleven_v4", { audioTags: "loud" as never })] } })).toThrow(/audioTags/);
    expect(() => saveRuntimeConfig(store, cfg, { agent: { audioTagsNote: "x".repeat(4001) } })).toThrow(/audioTagsNote/);
    // A config saved before the setting existed.
    store.setMeta("upstream_config", JSON.stringify({ tts: { entries: [{ id: "a", kind: "elevenlabs", model: "eleven_v4_turbo", apiKey: "sekret" }] }, agent: { gatewayNote: "n" } }));
    const rc = loadRuntimeConfig(store, cfg);
    expect(rc.tts.entries[0]!.audioTags).toBe("auto");
    expect(rc.agent.audioTagsNote).toBe("");
    const pub = publicRuntimeConfig(rc);
    expect(pub.agent.defaultAudioTagsNote).toBe(DEFAULT_AUDIO_TAGS_NOTE);
    expect(pub.tts.entries[0]!.audioTags).toBe("auto");
    expect(JSON.stringify(pub)).not.toContain("sekret");
    const saved = saveRuntimeConfig(store, cfg, { tts: { entries: [{ id: "a", audioTags: "off" }] } });
    expect(saved.tts.entries[0]!.audioTags).toBe("off");
    expect(saved.tts.entries[0]!.model).toBe("eleven_v4_turbo");
  });
});

describe("per-entry tags in the ranked synthesis wrapper", () => {
  const fmt: AudioFormat = { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 };
  const spy = (fail: boolean) => {
    const seen: string[] = [];
    const service: TextToSpeech = {
      format: fmt,
      async *synthesize(text) {
        seen.push(text);
        if (fail) throw new Error("down");
        yield Buffer.alloc(480, 1);
      },
      healthy: async () => true,
    };
    return { service, seen };
  };
  const run = async (tts: FallbackTextToSpeech, text: string) => {
    for await (const _ of tts.synthesize(text, {})) void _;
  };
  const text = "[whispers] Note [1] here. [sighs] Ok.";

  it("keeps tags for an entry that supports them and strips them for the rest", async () => {
    const top = spy(true);
    const second = spy(false);
    const entries: RankedEntry<TextToSpeech>[] = [
      { id: "a", label: "a", rank: 1, service: top.service, audioTags: true },
      { id: "b", label: "b", rank: 2, service: second.service, audioTags: false },
    ];
    await run(new FallbackTextToSpeech(entries, { cooldownSeconds: 60, audioTags: true }), text);
    expect(top.seen).toEqual([text]);
    expect(second.seen).toEqual(["Note [1] here. Ok."]);
  });

  it("passes the text through untouched when tags are not in use", async () => {
    const only = spy(false);
    await run(new FallbackTextToSpeech([{ id: "a", label: "a", rank: 1, service: only.service, audioTags: false }], { cooldownSeconds: 60 }), text);
    expect(only.seen).toEqual([text]);
  });
});
