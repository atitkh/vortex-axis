#pragma once

// The round AMOLED panel, plus the little this firmware draws on it besides the
// face: lines of text and buttons. Everything here takes LOGICAL coordinates,
// which follow the rotation chosen in settings; the panel is 466 by 466 and only
// the circle inside that square is glass, so text is fitted to the chord at its row.

#include <Arduino.h>

namespace display {

bool begin();

/** Radius of the round glass in pixels; its middle is the middle of the square. */
const int RADIUS = 233;
/** Width of the glass across a full-width band `h` tall at logical `y`: the chord at its edge farthest from the middle. 0 outside the circle. */
int roomAt(int y, int h);

/** 0, 90, 180 or 270. The panel cannot rotate itself, so this is done in software. */
void setRotation(int degrees);
void setBrightness(uint8_t level);
/**
 * Where the panel's first visible column sits in the controller's memory, 0 to
 * 40. Revisions of this board differ. Too large and the picture sits to one
 * side, with its far edge coming back in at the near one. Clears the screen.
 */
void setColumnOffset(int offset);
/** Draws a thin ring along the round edge of the glass and a cross in its middle, to check the offset by eye. */
void edges(uint16_t color);

int width();
int height();

/** Turns a point in the panel's own coordinates, as the touch controller reports it, into logical ones. */
void toLogical(int px, int py, int &x, int &y);
/** Blacks out the whole panel. */
void clear();

/**
 * Sends a block of pixels whose content does not care about rotation (the
 * face is round). `pixels` is w*h, row by row; (x, y) is its logical top left.
 * Only its rows from `first` up to `end` are sent (rounded out to whole pairs); the panel keeps the rest.
 */
void blitSquare(int x, int y, int size, const uint16_t *pixels, int first = 0, int end = -1);
/** Where blitSquare puts a square at logical (x, y): the panel position of its first pixel. */
void squareOnPanel(int x, int y, int size, int &px, int &py);

/**
 * Draws a whole screen's worth of pixels: `pixels` is width() by height(), row by row, in logical
 * coordinates, and is turned to the current rotation on the way out.
 */
void blitScreen(const uint16_t *pixels);

/** Draws a block of pixels, w by h row by row, at logical (x, y), turned to the current rotation. w and h at most 466. */
void blitRect(int x, int y, int w, int h, const uint16_t *pixels);

/** Blacks out a full-width band of `rows` rows starting at logical `y`. */
void clearBand(int y, int rows);

/**
 * Draws one centred line of text in a full-width band at logical `y`, clearing the band.
 * Text wider than the glass at that height is cut and ends in "...". With `barPermille` 0 to 1000 a thin bar runs along the bottom of the band, filled that far.
 */
void textLine(int y, uint8_t size, uint16_t color, const String &text, int barPermille = -1, uint16_t barColor = 0);

/**
 * Draws one row of rounded buttons in a full-width band `h` tall (68 at most; buttons().rowMax keeps to less)
 * at logical `y`. The chord the glass leaves the band is cut into `cols` equal
 * cells and `count` of them get a button; a row that is not full is centred.
 */
/** Where pillRow puts its cells: the first one's left edge and the width of each. Taps are matched with this. */
void pillCells(int y, int h, int count, int cols, int &left, int &cell);
void pillRow(int y, int h, const String *labels, int count, int cols, uint16_t outline, uint16_t textColor);
/**
 * Text comes in two kinds, named by the numbers the callers have always used:
 * 2 is body text and 3 is a heading. Both are drawn in FreeSans (at the textSize setting's points), whose
 * letters have their own widths, so text is measured, not counted.
 */
/**
 * The textSize setting: 0 small (body 9 points, headings Bold 12, buttons 12: the 1.8's), 1 medium (11, 14, 14),
 * 2 large (12, 15, 15). True when it changed: everything laid out by these measures has to be placed and drawn again.
 */
bool setTextSize(int index);
int textSize();
/** Height in pixels of a text band of that kind, at the current size. */
int lineHeight(uint8_t size);
/** How rows of buttons are sized at the current size. */
struct Buttons {
    /** Added to the widest label for the least width a button's cell can have. */
    int padding;
    /** The tallest a row may be, the least that keeps the face on screen, and the least ever. */
    int rowMax, rowMin, rowFloor;
};
const Buttons &buttons();
/** Room pillCells keeps between a row of buttons and the round edge, each side. */
int pillMargin();
/** Width in pixels of text of that kind. */
int textWidth(uint8_t size, const String &text);
/** Width in pixels of text on a button. */
int buttonTextWidth(const String &text);
/**
 * The fonts hold plain ASCII and replies arrive as UTF-8. This turns curly
 * quotes, dashes, ellipses and accented letters into their plain forms and
 * drops what has none (emoji), so nothing is drawn as stray marks.
 */
String plain(const String &text);

/** Diagnostics: keeps a copy of everything sent to the panel from now on (or stops and frees it). */
void mirror(bool on);
/**
 * Diagnostics: prints that copy, a row at a time, as runs of one colour. With `asHeld`, prints instead the copy of
 * what the panel holds that is always kept, as it is, with nothing drawn again: leftovers on the glass show there.
 */
void dump(Print &out, bool asHeld = false);

}  // namespace display
