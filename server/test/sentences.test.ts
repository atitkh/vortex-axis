import { describe, expect, it } from "vitest";
import { SentenceSplitter } from "../src/sentences.js";

function split(pieces: string[], splitter = new SentenceSplitter()): string[] {
  const out: string[] = [];
  for (const piece of pieces) out.push(...splitter.push(piece));
  const rest = splitter.flush();
  if (rest) out.push(rest);
  return out;
}

describe("SentenceSplitter", () => {
  it("yields a sentence once it is complete", () => {
    const splitter = new SentenceSplitter();
    expect(splitter.push("The lights are ")).toEqual([]);
    expect(splitter.push("off now. And the")).toEqual(["The lights are off now."]);
    expect(splitter.push(" door is locked.")).toEqual([]);
    expect(splitter.flush()).toBe("And the door is locked.");
  });

  it("gives the same pieces however the text arrives", () => {
    const text = "It is eight o'clock. Time for a break! Shall I set a timer? Okay.";
    const whole = split([text]);
    const byChar = split(text.split(""));
    expect(byChar).toEqual(whole);
    expect(whole).toEqual(["It is eight o'clock.", "Time for a break!", "Shall I set a timer?", "Okay."]);
  });

  it("does not cut inside a number", () => {
    expect(split(["It is 3.5 degrees outside today. Cold."])).toEqual(["It is 3.5 degrees outside today.", "Cold."]);
  });

  it("joins a very short sentence to the next one", () => {
    expect(split(["Sure. I will turn the lights off now. Done."])).toEqual([
      "Sure. I will turn the lights off now.",
      "Done.",
    ]);
  });

  it("flushes a short reply with no punctuation", () => {
    expect(split(["42"])).toEqual(["42"]);
    expect(split(["Sure"])).toEqual(["Sure"]);
  });

  it("cuts long text at a pause", () => {
    const long = `${"word ".repeat(30)}and then, ${"more ".repeat(30)}`;
    const pieces = split([long]);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= 220)).toBe(true);
    expect(pieces.join(" ").replace(/\s+/g, " ")).toBe(long.trim().replace(/\s+/g, " "));
  });

  it("treats a line break as a sentence end", () => {
    expect(split(["First line of the list\nSecond line of the list"])).toEqual([
      "First line of the list",
      "Second line of the list",
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(split([""])).toEqual([]);
    expect(split(["   "])).toEqual([]);
  });
});
