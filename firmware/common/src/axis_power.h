#pragma once
// The board's power: an X-Powers AXP2101 power chip on the shared I2C bus (both Waveshare AMOLED
// boards, at 0x34). Read every 30 seconds from the screen loop, the same task that reads the touch
// controller and the motion sensor, so the bus is never used from two tasks at once.
//
// With no battery connected there are no battery readings at all (unknown is not 0 %), only the
// chip's temperature. Registers as XPowersLib reads them (src/REG/AXP2101Constants.h there).
//
// The charge limit (setting `chargeLimit`, 50 to 100, 100 = none) holds charging off at or above the
// limit and lets it go on again 5 % below it (charge_hold.h), with a 4.1 V charge target as a backstop
// while a limit is set. Charging is switched on at the start, whenever USB goes away and whenever the
// limit is lifted; the target is never set above 4.2 V; a failed read or write changes nothing.
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
    int usbMv = 0;             // USB input millivolts; 0 without USB or when it could not be read
    bool held = false;         // charging held off by the charge limit
    int limit = 100;           // the charge limit in force, 100 = none
    float chipTempC = NAN;     // the power chip's own temperature; NAN when its reading made no sense
};

/** Looks for the chip on the bus (already started), switches its measurements on and charging on at 4.2 V
 *  (any hold from before a restart is undone until the limit is looked at again). False when it is not there. */
bool begin(uint8_t address = 0x34);
/** Reads the chip when a reading is due, every 30 seconds (the first about 2 seconds after begin). True when it read. */
bool tick();
/** The last reading. Safe from any task: it is a copy. */
Reading last();
/** The charge limit in percent (below 50 counts as 50, 100 and above as none). Only remembered here: a new
 *  value makes the next tick() read at once and apply it, so call it from the task that calls tick(). */
void setChargeLimit(int percent);
/** Hands the last reading to Axis as `chipTempC`, and with a battery `battery`, `charging`, `batteryMv`,
 *  `chargerState`, `chargeHeld` and, with USB, `usbMv`. */
void report(axis::Client &client);
/** The last reading in one line, for the console's `power`. */
void print(Print &out);

// Bench only: prints the chip's registers as read (nothing is written).
void dumpRegs(Print &out);

// Charging on or off (the chip keeps running the board from USB either way). Returns false when the write fails.
bool setCharging(bool on);
// Charge target in mV: 4000, 4100 or 4200 only (never higher; a lower target is the only direction offered).
bool setTargetMv(uint16_t mv);

}  // namespace power
