/**
 * Cuts a reply into pieces that can be synthesized one at a time while the
 * rest is still being written. Feed it text as it arrives; it returns each
 * piece as soon as it is complete.
 */
export class SentenceSplitter {
  private buffer = "";

  constructor(
    /** A piece shorter than this is held back and joined to the next one. */
    private readonly minLength = 12,
    /** Text with no sentence end is cut at a pause once it grows past this. */
    private readonly maxLength = 220,
  ) {}

  /** Adds text and returns any pieces that are now complete. */
  push(text: string): string[] {
    this.buffer += text;
    const pieces: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const piece = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (piece) pieces.push(piece);
    }
    return pieces;
  }

  /** Returns whatever is left. Once the reply has ended, the rest is a complete piece. */
  flush(): string | undefined {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || undefined;
  }

  private findCut(): number {
    // A sentence end counts only when followed by whitespace, so "3.5" and
    // a reply still being written mid-word are left alone.
    const ends = /[.!?…]+["')\]]*\s+|\n+/g;
    let match: RegExpExecArray | null;
    while ((match = ends.exec(this.buffer)) !== null) {
      const cut = match.index + match[0].length;
      if (this.buffer.slice(0, cut).trim().length >= this.minLength) return cut;
    }
    if (this.buffer.length > this.maxLength) {
      const window = this.buffer.slice(0, this.maxLength);
      const pause = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
      if (pause > this.minLength) return pause + 2;
      const space = window.lastIndexOf(" ");
      return space > this.minLength ? space + 1 : this.maxLength;
    }
    return -1;
  }
}
