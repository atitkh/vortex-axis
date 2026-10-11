#pragma once

// A soft glow along the edges of the screen that says what the device is doing (listening, thinking,
// speaking) when something else has the whole screen and the face cannot show it: a picture now, and
// anything full screen later. It is drawn over the pixels underneath, which the caller keeps, so taking
// it away puts them back.

#include <Arduino.h>

namespace glow {

enum class State : uint8_t { None, Listening, Thinking, Speaking };

/**
 * Call every frame while `under` (the whole screen, display::width() by display::height(), logical, row
 * by row) is on show. `level` is how loud the voice is, 0 to 1, or below 0 when there is none to follow.
 * Draws about 20 times a second while there is a state, and once more to take the glow away.
 */
void update(const uint16_t *under, State state, float level);

/** Forgets what was drawn, for when the screen has been redrawn from scratch. */
void reset();

}  // namespace glow
