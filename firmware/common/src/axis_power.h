#pragma once
// The board's power: an X-Powers AXP2101 power chip on the shared I2C bus (both Waveshare AMOLED
// boards, at 0x34). Read every 30 seconds from the screen loop, the same task that reads the touch
// controller and the motion sensor, so the bus is never used from two tasks at once.
//
// With no battery connected there are no battery readings at all (unknown is not 0 %), only the
// chip's temperature. Registers as XPowersLib reads them (src/REG/AXP2101Constants.h there).
#include <Arduino.h>

#include "axis_client.h"

namespace power {

struct Reading {
    bool taken = false;    // at least one reading since the start
    bool battery = false;  // a battery is connected
    int percent = -1;      // the chip's fuel gauge, 0 to 100; -1 without a battery
    bool charging = false;
    uint8_t chargerState = 0;  // 0 trickle, 1 pre-charge, 2 constant current, 3 constant voltage, 4 done, 5 stopped
    int batteryMv = 0;         // 0 without a battery
    bool vbus = false;         // USB power is there
    float chipTempC = NAN;     // the power chip's own temperature; NAN when its reading made no sense
};

/** Looks for the chip on the bus (already started) and switches its measurements on. False when it is not there. */
bool begin(uint8_t address = 0x34);
/** Reads the chip when a reading is due, every 30 seconds (the first about 2 seconds after begin). True when it read. */
bool tick();
/** The last reading. Safe from any task: it is a copy. */
Reading last();
/** Hands the last reading to Axis as `chipTempC`, and with a battery `battery`, `charging` and `batteryMv`. */
void report(axis::Client &client);
/** The last reading in one line, for the console's `power`. */
void print(Print &out);

}  // namespace power
