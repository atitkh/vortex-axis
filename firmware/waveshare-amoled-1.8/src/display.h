#pragma once

// The AMOLED panel, plus the little this firmware draws on it besides the face:
// lines of text. Everything here takes LOGICAL coordinates, which follow the
// rotation chosen in settings; the panel itself is always 368 wide by 448 tall.

#include <Arduino.h>

namespace display {

bool begin();

/** 0, 90, 180 or 270. The panel cannot rotate itself, so this is done in software. */
void setRotation(int degrees);
void setBrightness(uint8_t level);
/**
 * Where the panel's first visible column sits in the controller's memory, 0 to
 * 40. Revisions of this board differ. Too large and the picture sits to one
 * side, with its far edge coming back in at the near one. Clears the screen.
 */
void setColumnOffset(int offset);
/** Draws a thin frame along all four sides of the panel and a cross in its middle, to check the offset by eye. */
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
 */
void blitSquare(int x, int y, int size, const uint16_t *pixels);
/** Where blitSquare puts a square at logical (x, y): the panel position of its first pixel. */
void squareOnPanel(int x, int y, int size, int &px, int &py);

/**
 * Draws a whole screen's worth of pixels: `pixels` is width() by height(), row by row, in logical
 * coordinates, and is turned to the current rotation on the way out.
 */
void blitScreen(const uint16_t *pixels);

/** Draws a block of pixels, w by h row by row, at logical (x, y), turned to the current rotation. w and h at most 448. */
void blitRect(int x, int y, int w, int h, const uint16_t *pixels);

/** Blacks out a full-width band of `rows` rows starting at logical `y`. */
void clearBand(int y, int rows);

/**
 * Draws one centred line of text in a full-width band at logical `y`, clearing the band.
 * With `barPermille` 0 to 1000 a thin bar runs along the bottom of the band, filled that far.
 */
void textLine(int y, uint8_t size, uint16_t color, const String &text, int barPermille = -1, uint16_t barColor = 0);

/**
 * Draws one row of rounded buttons in a full-width band `h` tall (56 at most)
 * at logical `y`. The band is cut into `cols` equal cells and `count` of them
 * get a button; a row that is not full is centred.
 */
void pillRow(int y, int h, const String *labels, int count, int cols, uint16_t outline, uint16_t textColor);
/**
 * Text comes in two kinds, named by the numbers the callers have always used:
 * 2 is body text and 3 is a heading. Both are drawn in FreeSans, whose
 * letters have their own widths, so text is measured, not counted.
 */
/** Height in pixels of a text band of that kind. */
inline int lineHeight(uint8_t size) { return size >= 3 ? 30 : 22; }
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
/** Diagnostics: prints that copy, a row at a time, as runs of one colour. */
void dump(Print &out);

}  // namespace display
