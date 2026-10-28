#pragma once
// The QMI8658 motion sensor: which way up the board is, and how often it was picked up.
// Polled from the main loop, the same place the touch controller is read, so
// the I2C bus is never used from two tasks at once.
#include <Arduino.h>

namespace imu {

bool begin();
/** Reads the sensor when a reading is due. Call every frame. */
void tick();
/**
 * Which rotation setting puts the picture upright for the way the board is
 * standing now: 0, 90, 180 or 270. It only changes after the board has stayed
 * the new way up for about a second. -1 while it is unknown: lying flat, or
 * before the first steady reading.
 */
int orientation();
/** Times the board was picked up since it started (see PICKUP_G in imu.cpp). */
uint32_t pickups();
/** Gravity along the board's three axes, in thousandths of g, for tuning. */
void read(int &x, int &y, int &z);

}  // namespace imu
