#pragma once

// A soft glow along the edges of the screen that says what the device is doing (listening, thinking,
// speaking) when something else has the whole screen and the face cannot show it: a picture now, and
// anything full screen later. It is drawn over the pixels underneath, which the caller keeps, so taking
// it away puts them back.

#include <Arduino.h>

namespace glow {

enum class State : uint8_t { None, Listening, Thinking, Speaking, Waiting, Done, Timer, Question, Find, Hands, Charging };

/** A part of the panel, in its own coordinates, the glow leaves alone (the face, which draws itself). Empty when w is 0. */
struct Rect {
    int x = 0, y = 0, w = 0, h = 0;
};

/**
 * Call every frame while `under` (the whole screen, display::width() by display::height(), logical, row
 * by row) is on show, or with `under` null over a screen that is black at its edges (the face's). `level`
 * sets the strength, 0 to 1 (a voice, or a flash fading out), or below 0 to breathe at the state's pace.
 * Draws about 20 times a second (10 over the face) while there is a state, and once more to take the glow
 * away. Waiting is amber (something needs the person), Done is green (a task finished), Timer is red,
 * Question is blue (a question waits elsewhere), Find is a quick white pulse (somebody looking for the device)
 * and Hands is rose (an agent is using a computer nearby). Charging is the idle face's cyan (charging has just begun).
 * `sweep` is how much of the way round the screen is lit, 0 to 1, clockwise from the top middle: a
 * timer's last seconds, running out.
 */
void update(const uint16_t *under, State state, float level, Rect keepOut = {}, float sweep = 1.0f);

/**
 * Lays the glow now on show over `pixels`, the face's square frame `size` wide whose first pixel sits at panel (x, y)
 * (unturned, as the panel sees it), but only over its part (fromX, fromY) to (toX, toY): the part that is sent, which
 * `keepOut` left alone, so the glow runs on unbroken across it. Nothing when there is none: false then.
 */
bool tint(uint16_t *pixels, int x, int y, int size, int fromX, int fromY, int toX, int toY);

/** Where the ring crosses panel row `y`: run 0 or 1, panel columns `from` up to `to`. False when there is no such run. */
bool ringRow(int y, int run, int &from, int &to);

/** Blacks out again what tint() laid into that part of the frame, once it has been sent. */
void untint(uint16_t *pixels, int x, int y, int size, int fromX, int fromY, int toX, int toY);

/** How round the glow turns the corners, in pixels (board setting glowCorner). */
void setCorner(int radius);

/** Diagnostics: time spent working out and sending the ring, pixels and pieces sent, since the last call. */
void stats(uint32_t &math, uint32_t &send, uint32_t &pixels, uint32_t &pieces);

/** Forgets what was drawn, for when the screen has been redrawn from scratch. */
void reset();

}  // namespace glow
