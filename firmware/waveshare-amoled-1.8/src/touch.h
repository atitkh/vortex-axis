#pragma once

// The FT3168 touch controller. This firmware only needs to know about taps.

#include <Arduino.h>

namespace touch {

bool begin();

/** True once, when a finger touched down and lifted again without moving far or lingering. Poll every frame or so. */
bool tapped();

/** Where the last tap landed, in the panel's own coordinates (368 wide, 448 tall, whatever the rotation). */
void tapPoint(int &x, int &y);
/** Milliseconds since a finger was last on the glass; UINT32_MAX if never. */
uint32_t idleMs();

}  // namespace touch
