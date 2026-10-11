#pragma once

// The FT3168 touch controller: taps, holds and swipes.

#include <Arduino.h>

namespace touch {

bool begin();

enum class Gesture { None, Tap, Hold, Swipe };

/**
 * What the finger just did, once, when it lifts: a tap (short, stays put), a hold (stays put for longer)
 * or a swipe (travels across the glass quickly). None otherwise. Poll every frame or so; use either this or
 * tapped(), not both.
 */
Gesture poll();

/** True once, when a finger touched down and lifted again without moving far or lingering. Poll every frame or so. */
bool tapped();

/** Where the last swipe started and ended, in the panel's own coordinates. */
void swipeEnds(int &x0, int &y0, int &x1, int &y1);

/** Where the last tap landed, in the panel's own coordinates (368 wide, 448 tall, whatever the rotation). */
void tapPoint(int &x, int &y);
/** Milliseconds since a finger was last on the glass; UINT32_MAX if never. */
uint32_t idleMs();

}  // namespace touch
