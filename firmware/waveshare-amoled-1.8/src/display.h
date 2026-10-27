#pragma once

// The AMOLED panel, plus the little this firmware draws on it besides the face:
// lines of text. Everything here takes LOGICAL coordinates, which follow the
// rotation chosen in settings; the panel itself is always 368 wide by 448 tall.
// The calls named "Panel" take the panel's own coordinates, unturned.

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
/** The rotation in force: 0, 90, 180 or 270. */
int rotationDegrees();

/** Turns a point in the panel's own coordinates, as the touch controller reports it, into logical ones. */
void toLogical(int px, int py, int &x, int &y);
/** Turns a logical point into the panel's own coordinates: the reverse of toLogical. */
void toPanel(int x, int y, int &px, int &py);
/** Blacks out the whole panel. */
void clear();
/** How many times clear() has run, so a caller keeping track of what is on the panel knows when it was wiped. */
uint32_t clears();

/**
 * Sends a block of pixels whose content does not care about rotation (the
 * face is round). `pixels` is w*h, row by row; (x, y) is its logical top left.
 */
void blitSquare(int x, int y, int size, const uint16_t *pixels);
/** Where blitSquare puts a square at logical (x, y): the panel position of its first pixel. */
void squareOnPanel(int x, int y, int size, int &px, int &py);

/** In the panel's own coordinates, unturned: `pixels` is w by h, row by row, sent as it is at (x, y). */
void blitPanel(int x, int y, int w, int h, const uint16_t *pixels);
/**
 * Sends the part (x0, y0) to (x1, y1) of a square frame `stride` pixels wide whose first pixel sits at panel (px, py),
 * unturned (the face's frame, as squareOnPanel places it).
 */
void blitFrame(int px, int py, int stride, const uint16_t *pixels, int x0, int y0, int x1, int y1);
/** Fills a block of the panel, in its own coordinates, with one colour. */
void fillPanel(int x, int y, int w, int h, uint16_t color);

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

/** Where pillRow puts its cells: the first one's left edge and the width of each. Taps are matched with this. */
void pillCells(int count, int cols, int &left, int &cell);
/**
 * Draws one row of rounded buttons in a full-width band `h` tall (68 at most; buttons().rowMax keeps to less)
 * at logical `y`. The band is cut into `cols` equal cells and `count` of them
 * get a button; a row that is not full is centred.
 */
void pillRow(int y, int h, const String *labels, int count, int cols, uint16_t outline, uint16_t textColor);
/**
 * Text comes in two kinds, named by the numbers the callers have always used:
 * 2 is body text and 3 is a heading. Both are drawn in FreeSans (at the textSize setting's points), whose
 * letters have their own widths, so text is measured, not counted.
 */
/**
 * The textSize setting: 0 small (body 9 points, headings Bold 12, buttons 12: this board's before 0.20.0), 1 medium
 * (11, 14, 14), 2 large (12, 15, 15), as on the round board. True when it changed: everything laid out by these
 * measures has to be placed and drawn again.
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
/** Whether that copy is being kept. */
bool mirroring();
/** Diagnostics: prints that copy, a row at a time, as runs of one colour. */
void dump(Print &out);

}  // namespace display
