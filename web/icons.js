// The icons the face shows while an agent works: what kind of thing it has picked up. Each is a few
// strokes on a 24 by 24 grid, drawn with a round pen, the way docs/face.md section 8 says. This file
// is the one definition: scripts/gen-icons.mjs writes the board's copy (firmware/.../icons.h) from it.

/** A closed ring of straight pieces, near enough a circle or an ellipse at this size. */
const ring = (cx, cy, rx, ry = rx, from = 0, to = 2 * Math.PI, pieces = 16) => {
  const points = [];
  const count = Math.max(2, Math.round((pieces * Math.abs(to - from)) / (2 * Math.PI)));
  for (let i = 0; i <= count; i++) {
    const angle = from + ((to - from) * i) / count;
    points.push(Math.round((cx + rx * Math.cos(angle)) * 10) / 10, Math.round((cy + ry * Math.sin(angle)) * 10) / 10);
  }
  return points;
};
const dot = (x, y) => [x, y, x + 0.1, y];

/** Name to strokes; a stroke is x, y, x, y, ... along one line. */
export const ICONS = {
  // A lens and its handle.
  search: [ring(10.5, 10.5, 6), [15, 15, 20, 20]],
  // A globe: the outline, one meridian and the equator.
  web: [ring(12, 12, 8), ring(12, 12, 3.4, 8), [4, 12, 20, 12]],
  // A house: the roof and the walls.
  home: [[3.5, 11.5, 12, 4, 20.5, 11.5], [6, 10, 6, 20, 18, 20, 18, 10]],
  // A calendar leaf with its two rings.
  calendar: [[4, 6, 20, 6, 20, 20, 4, 20, 4, 6], [4, 10.5, 20, 10.5], [8, 3.5, 8, 7], [16, 3.5, 16, 7]],
  // Three lines, each with its mark.
  list: [dot(5, 7), [9, 7, 20, 7], dot(5, 12), [9, 12, 20, 12], dot(5, 17), [9, 17, 20, 17]],
  // A sheet with a folded corner.
  files: [[7, 3, 14, 3, 19, 8, 19, 21, 7, 21, 7, 3], [14, 3, 14, 8, 19, 8]],
  // Angle brackets.
  code: [[9, 7, 4, 12, 9, 17], [15, 7, 20, 12, 15, 17]],
  // A stopwatch: the button, the case and the hand.
  timer: [[10, 3, 14, 3], ring(12, 13.5, 7.5), [12, 13.5, 12, 9], [12, 13.5, 15, 15.5]],
  // A speech bubble.
  message: [[4, 5, 20, 5, 20, 16, 11, 16, 7, 20, 7, 16, 4, 16, 4, 5]],
  // A store of things kept: a drum with a band round it.
  memory: [ring(12, 6.5, 7, 3), [5, 6.5, 5, 17.5], [19, 6.5, 19, 17.5], ring(12, 17.5, 7, 3, 0, Math.PI), ring(12, 12, 7, 3, 0, Math.PI)],
  // A picture: the frame, a hill line and the sun.
  image: [[3.5, 5, 20.5, 5, 20.5, 19, 3.5, 19, 3.5, 5], [3.5, 16, 9, 11, 13, 15, 16, 12.5, 20.5, 16.5], ring(15.5, 9, 1.3, 1.3, 0, 2 * Math.PI, 8)],
  // Any other tool: a hub with rays, like a small cog.
  tool: [ring(12, 12, 3.5), ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const a = (i * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
    return [Math.round((12 + 6 * c) * 10) / 10, Math.round((12 + 6 * s) * 10) / 10, Math.round((12 + 8.5 * c) * 10) / 10, Math.round((12 + 8.5 * s) * 10) / 10];
  })],
};

/** Side of the square an icon is drawn in, in the face's 240 grid, and the width of the pen. */
export const ICON_SIZE = 52;
export const ICON_PEN = 3.4;
/** How far the arms stand back from the centre to make room for an icon, in the 240 grid. */
export const ICON_HOLE = 36;
