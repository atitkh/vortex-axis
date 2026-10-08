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

int width();
int height();

/** Blacks out the whole panel. */
void clear();

/**
 * Sends a block of pixels whose content does not care about rotation (the
 * face is round). `pixels` is w*h, row by row; (x, y) is its logical top left.
 */
void blitSquare(int x, int y, int size, const uint16_t *pixels);

/** Blacks out a full-width band of `rows` rows starting at logical `y`. */
void clearBand(int y, int rows);

/** Draws one centred line of text in a full-width band at logical `y`, clearing the band. */
void textLine(int y, uint8_t size, uint16_t color, const String &text);

/** Height in pixels of a text band at the given size. */
inline int lineHeight(uint8_t size) { return 8 * size + 4; }
/** Characters that fit across the screen at the given size. */
inline int lineChars(uint8_t size) { return width() / (6 * size); }

}  // namespace display
