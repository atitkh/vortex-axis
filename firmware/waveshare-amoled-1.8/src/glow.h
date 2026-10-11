#pragma once

// A soft glow along the edges of the screen that says what the device is doing (listening, thinking,
// speaking) when something else has the whole screen and the face cannot show it: a picture now, and
// anything full screen later. It is drawn over the pixels underneath, which the caller keeps, so taking
// it away puts them back.

#include <Arduino.h>

namespace glow {

enum class State : uint8_t { None, Listening, Thinking, Speaking, Waiting, Done };

/** A part of the screen the glow leaves alone (the face, which draws itself). Empty when w is 0. */
struct Rect {
    int x = 0, y = 0, w = 0, h = 0;
};

/**
 * Call every frame while `under` (the whole screen, display::width() by display::height(), logical, row
 * by row) is on show, or with `under` null over a screen that is black at its edges (the face's). `level`
 * sets the strength, 0 to 1 (a voice, or a flash fading out), or below 0 to breathe at the state's pace.
 * Draws about 20 times a second (10 over the face) while there is a state, and once more to take the glow
 * away. Waiting is amber (something needs the person), Done is green (a task finished).
 */
void update(const uint16_t *under, State state, float level, Rect keepOut = {});

/**
 * Lays the glow now on show over `pixels`, a w by h block at logical (x, y) that something draws itself
 * (the face) and `keepOut` left alone, so the glow runs on unbroken across it. Nothing when there is none.
 */
void tint(uint16_t *pixels, int x, int y, int w, int h);

/** Forgets what was drawn, for when the screen has been redrawn from scratch. */
void reset();

}  // namespace glow
