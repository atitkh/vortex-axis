#pragma once
// What the face shows of the battery: a sleepy idle face and a small battery mark at low battery, and a short cue
// when charging begins, then a bolt beside the mark while it charges. No sound, ever. Only from a fresh reading
// with a battery: with none connected (or USB alone) nothing shows. Shared by both boards (the 1.75 links to it).
//
// The mark is drawn on its own into a small block at the bottom middle of the screen, inside the round glass on the
// 1.75 and clear of the edge glow; a face frame never reaches that far down.
#include <Arduino.h>

#include "axis_power.h"

namespace batterycue {

/**
 * Takes a reading in (from the screen loop, on each frame): `readAt` is when it was read (millis), `lowBelow` the
 * `lowBatteryBelow` setting (0 off, otherwise 5 to 30 %).
 */
void update(const power::Reading &reading, uint32_t readAt, uint32_t now, int lowBelow);
/** The idle face should look sleepy (low battery, not charging). */
bool sleepy();
/** The edge glow's strength for the charging cue, 0 to 1, for about 3 s after charging began; below 0 when there is none. */
float chargeCue(uint32_t now);
/**
 * Draws the mark (battery, percent, bolt while charging) when it changed or is due again, or blacks it out once when
 * it goes. `markOn` is the `batteryGlyph` setting; the bolt of the charging cue shows whatever it says.
 */
void draw(uint32_t now, bool markOn);

/**
 * The console's `preview lowbattery`, `preview charging`, `preview battery N`: a made-up reading for a minute, from the
 * screen loop's next frame. Safe from the console's task. `percent` only for battery.
 */
enum class Preview : uint8_t { Off, LowBattery, Charging, Battery };
void preview(Preview kind, int percent = 0);

/** One line of what it shows and why, for the console's `power`. */
void print(Print &out);

}  // namespace batterycue
