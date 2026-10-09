#pragma once

// The default face: a vortex of dots on spiral arms. It spins slowly when
// idle, pulls inward to listen, speeds up to think and pulses to speak.
//
// It is drawn into its own square buffer and never touches the panel; the
// caller sends the buffer to the display.
//
// Specified in docs/face.md, which web/vortex.js also follows. Change all three together.

#include <Arduino.h>

namespace vortex {

/** Side of the square the face is drawn in, in pixels. */
const int SIZE = 240;

enum class Mode : uint8_t { Setup, Offline, Idle, Listening, Thinking, Speaking, Error };

/** Allocates the buffer. False when there is no memory for it. */
bool begin();

void setMode(Mode mode);

/** Loudness of the voice being played, 0 to 1. Negative means "not known": the face pulses on its own. */
void setLevel(float level);

/** Idle looks to leave out: their names separated by commas, as the `idleLooksOff` setting holds them. */
void setIdleOff(const char *names);

/** Advances the animation by `seconds` and draws a frame. */
const uint16_t *render(float seconds);

/** Name of the idle animation currently playing, for logs. */
const char *idleName();

}  // namespace vortex
