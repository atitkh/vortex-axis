import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hub, Session } from "./hub.js";
import type { Store } from "./store.js";

/** A wake word model Axis holds, with what a device needs to run it. */
export interface WakeWord {
  /** Short name used in settings and addresses, made from the phrase: "hey-vortex". */
  id: string;
  /** The phrase, as a person would write it. */
  name: string;
  /** How sure the model must be before it counts as heard, in percent, 50 to 99. */
  cutoff: number;
  /** How many of the model's answers are averaged, 1 to 12. */
  window: number;
  size: number;
  md5: string;
  uploadedAt: number;
}

/** The value of the `wakeWord` setting that means "the one built into the firmware". */
export const BUILT_IN_WAKE_WORD = "built-in";
export const MAX_WAKE_WORD_BYTES = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function wakeWordId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Wake word models kept in the data folder, one file per phrase, with no
 * history: a model uploaded under a name that exists replaces it. Devices
 * that listen for a wake word are told which one their settings choose, fetch
 * it with their own token, keep it in their own storage and load it at start.
 * The firmware's built-in model is always there to fall back on.
 */
export class WakeWordStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir === ":memory:" ? join(tmpdir(), `vortex-axis-wakewords-${process.pid}`) : dataDir, "wakewords");
  }

  list(): WakeWord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => this.get(file.slice(0, -5)))
      .filter((word): word is WakeWord => Boolean(word))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): WakeWord | undefined {
    if (!ID.test(id)) return undefined;
    try {
      const word = JSON.parse(readFileSync(join(this.dir, `${id}.json`), "utf8")) as WakeWord;
      return statSync(this.path(id)).size === word.size ? word : undefined;
    } catch {
      return undefined;
    }
  }

  path(id: string): string {
    return join(this.dir, `${id}.tflite`);
  }

  /** Keeps a model under the name of its phrase. Throws with a reason when it is not usable. */
  save(input: { name: string; cutoff: number; window: number }, data: Buffer, now = Date.now()): WakeWord {
    const name = input.name.trim().slice(0, 60);
    const id = wakeWordId(name);
    if (!ID.test(id)) throw new Error("give the wake word a name with letters or digits in it");
    if (id === BUILT_IN_WAKE_WORD) throw new Error(`"${name}" is taken: it means the wake word built into the firmware`);
    checkTuning(input.cutoff, input.window);
    if (data.length < 4096) throw new Error("that file is too small to be a wake word model");
    if (data.length > MAX_WAKE_WORD_BYTES) throw new Error("a wake word model can be at most 1 MB");
    // Every TensorFlow Lite model carries this tag. It catches a wrong file, not a model of the wrong kind.
    if (data.subarray(4, 8).toString("latin1") !== "TFL3") throw new Error("that is not a TensorFlow Lite model (.tflite)");
    mkdirSync(this.dir, { recursive: true });
    const word: WakeWord = {
      id,
      name,
      cutoff: input.cutoff,
      window: input.window,
      size: data.length,
      md5: createHash("md5").update(data).digest("hex"),
      uploadedAt: now,
    };
    writeFileSync(this.path(id), data);
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(word));
    return word;
  }

  /** Changes how a stored model is run, without uploading it again. */
  tune(id: string, change: { cutoff?: number | undefined; window?: number | undefined }): WakeWord | undefined {
    const word = this.get(id);
    if (!word) return undefined;
    const next = { ...word, cutoff: change.cutoff ?? word.cutoff, window: change.window ?? word.window };
    checkTuning(next.cutoff, next.window);
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(next));
    return next;
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    rmSync(this.path(id), { force: true });
    rmSync(join(this.dir, `${id}.json`), { force: true });
    return true;
  }
}

function checkTuning(cutoff: number, window: number): void {
  if (!Number.isInteger(cutoff) || cutoff < 50 || cutoff > 99) throw new Error("the cutoff must be a whole number from 50 to 99 (percent)");
  if (!Number.isInteger(window) || window < 1 || window > 12) throw new Error("the window must be a whole number from 1 to 12");
}

/**
 * Keeps devices on the wake word their settings choose. Each client with a
 * microphone is sent the `wake.model` command when it connects and whenever a
 * setting or a stored model changes. A device already on that model does
 * nothing; a client with no wake word of its own answers that it cannot, which
 * is fine.
 */
export class WakeWordSync {
  constructor(
    private readonly words: WakeWordStore,
    private readonly store: Store,
    private readonly hub: Hub,
  ) {
    hub.onConnect((session) => this.tell(session));
    hub.onSettingsPushed(() => this.tellAll());
  }

  /** The stored model a client's settings choose, or undefined for the firmware's own. */
  chosen(session: Session): WakeWord | undefined {
    const value = this.store.resolveSettings(session.client).wakeWord;
    return typeof value === "string" && value !== BUILT_IN_WAKE_WORD ? this.words.get(value) : undefined;
  }

  tellAll(): void {
    for (const session of this.hub.sessions()) this.tell(session);
  }

  private tell(session: Session): void {
    if (!session.client.capabilities.includes("mic")) return;
    const word = this.chosen(session);
    const params = word
      ? {
          id: word.id,
          name: word.name,
          md5: word.md5,
          size: word.size,
          cutoff: word.cutoff,
          window: word.window,
          path: `/v1/wakewords/${word.id}`,
        }
      : { id: "" };
    this.hub.command(session, "wake.model", params, 5000).catch(() => undefined);
  }
}
