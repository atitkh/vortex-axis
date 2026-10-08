/** How a piece ended, which decides the pause after it when spoken. */
export type PieceEnd = "sentence" | "clause" | "paragraph" | "none";

export interface Piece {
  text: string;
  end: PieceEnd;
}

function endOf(raw: string): PieceEnd {
  if (/\n\s*$/.test(raw)) return "paragraph";
  if (/[.!?…]+["')\]]*\s*$/.test(raw)) return "sentence";
  if (/[,;:]\s*$/.test(raw)) return "clause";
  return "none";
}

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
    return this.pushPieces(text).map((p) => p.text);
  }

  /** Like push, with how each piece ended. */
  pushPieces(text: string): Piece[] {
    this.buffer += text;
    const pieces: Piece[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      const raw = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      if (raw.trim()) pieces.push({ text: raw.trim(), end: endOf(raw) });
    }
    return pieces;
  }

  /** Returns whatever is left. Once the reply has ended, the rest is a complete piece. */
  flush(): string | undefined {
    return this.flushPiece()?.text;
  }

  flushPiece(): Piece | undefined {
    const raw = this.buffer;
    this.buffer = "";
    return raw.trim() ? { text: raw.trim(), end: endOf(raw) } : undefined;
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
