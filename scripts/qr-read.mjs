// Reads a QR code back from its modules, for checking the admin page's setup-string QR code without a camera or a
// library: the matrix (rows of "0"/"1", no quiet zone) is unmasked, read in the standard zigzag, de-interleaved and
// parsed as byte-mode data. Error correction level M, versions 1 to 10 (a setup string needs version 3 or 4).
// Error correction codewords are not used: a code drawn by the page has no damage to repair.
// The mask is not taken from the format bits: each of the eight is tried and the one that parses as a byte-mode
// segment that fills its stated length wins, which is as good a check here (a wrong mask reads as noise).

/** [error correction codewords per block, [blocks, data codewords each], …] for level M. */
const BLOCKS_M = {
  1: [10, [1, 16]], 2: [16, [1, 28]], 3: [26, [1, 44]], 4: [18, [2, 32]], 5: [24, [2, 43]],
  6: [16, [4, 27]], 7: [18, [4, 31]], 8: [22, [2, 38], [2, 39]], 9: [22, [3, 36], [2, 37]], 10: [26, [4, 43], [1, 44]],
};
const ALIGN = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

/** Which modules are not data: finders, separators, format and version areas, timing, alignment, the dark module. */
function reserved(n, version) {
  const r = Array.from({ length: n }, () => new Uint8Array(n));
  const box = (top, left, h, w) => {
    for (let i = top; i < top + h; i++) for (let j = left; j < left + w; j++) if (i >= 0 && j >= 0 && i < n && j < n) r[i][j] = 1;
  };
  box(0, 0, 9, 9);
  box(0, n - 8, 9, 8);
  box(n - 8, 0, 8, 9);
  for (let k = 0; k < n; k++) r[6][k] = r[k][6] = 1;
  const at = ALIGN[version] ?? [];
  for (const i of at) for (const j of at) if (!r[i][j]) box(i - 2, j - 2, 5, 5);
  if (version >= 7) {
    box(0, n - 11, 6, 3);
    box(n - 11, 0, 3, 6);
  }
  return r;
}

/** The text a QR code holds, or undefined when it cannot be read. `rows`: strings of "0" and "1". */
export function readQr(rows) {
  const n = rows.length;
  const version = (n - 17) / 4;
  const table = BLOCKS_M[version];
  if (!table || rows.some((row) => row.length !== n)) return undefined;
  const skip = reserved(n, version);
  for (const mask of MASKS) {
    const bits = [];
    let upward = true;
    for (let right = n - 1; right > 0; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < n; step++) {
        const i = upward ? n - 1 - step : step;
        for (const j of [right, right - 1]) {
          if (skip[i][j]) continue;
          bits.push(Number(rows[i][j] === "1") ^ Number(mask(i, j)));
        }
      }
      upward = !upward;
    }
    const codewords = [];
    for (let k = 0; k + 8 <= bits.length; k += 8) codewords.push(bits.slice(k, k + 8).reduce((v, b) => (v << 1) | b, 0));
    // The blocks' data codewords are interleaved: the first of each block, then the second of each, …
    const blocks = table.slice(1).flatMap(([count, size]) => Array.from({ length: count }, () => ({ size, data: [] })));
    let at = 0;
    for (let k = 0; k < Math.max(...blocks.map((b) => b.size)); k++) for (const b of blocks) if (k < b.size) b.data.push(codewords[at++]);
    const data = blocks.flatMap((b) => b.data);
    const stream = data.flatMap((c) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (c >> s) & 1));
    const take = (count, from) => stream.slice(from, from + count).reduce((v, b) => (v << 1) | b, 0);
    if (take(4, 0) !== 0b0100) continue;
    const lengthBits = version < 10 ? 8 : 16;
    const length = take(lengthBits, 4);
    if (4 + lengthBits + length * 8 > stream.length) continue;
    const bytes = Array.from({ length }, (_, k) => take(8, 4 + lengthBits + k * 8));
    // After the data: a terminator of zeros (or the end).
    const end = 4 + lengthBits + length * 8;
    if (stream.length - end >= 4 && take(4, end) !== 0) continue;
    return new TextDecoder().decode(Uint8Array.from(bytes));
  }
  return undefined;
}
