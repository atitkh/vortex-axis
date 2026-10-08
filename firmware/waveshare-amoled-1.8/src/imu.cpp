#include "imu.h"

#include <Wire.h>

namespace imu {
namespace {

const uint8_t ADDR = 0x6B;
const uint8_t REG_WHO_AM_I = 0x00;  // reads 0x05
const uint8_t REG_CTRL1 = 0x02;
const uint8_t REG_CTRL2 = 0x03;  // accelerometer range and rate
const uint8_t REG_CTRL7 = 0x08;  // bit 0 turns the accelerometer on
const uint8_t REG_AX_L = 0x35;   // X, Y, Z, low byte first
const float LSB_PER_G = 8192.0f;  // at the 4 g range

const uint32_t SAMPLE_MS = 50;
// An axis has to carry this much of gravity to count as "down". Between the two
// ways up there is a dead zone where the last answer stands, and lying flat
// (gravity mostly through the screen) changes nothing.
const float DOWN_G = 0.55f;
// The board must stay the new way up this long, or carrying it would spin the picture.
const uint32_t DWELL_MS = 900;

bool present = false;
float gx = 0, gy = 0, gz = 0;
int settled = -1, candidate = -1;
uint32_t candidateSince = 0, lastSample = 0;

// A write with a STOP and a separate read; the combined form is unreliable on this Arduino core.
bool readRegs(uint8_t reg, uint8_t *out, uint8_t count) {
    Wire.beginTransmission(ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(true) != 0) return false;
    if (Wire.requestFrom(ADDR, count) != count) return false;
    for (uint8_t i = 0; i < count; i++) out[i] = Wire.read();
    return true;
}

bool writeReg(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(ADDR);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission(true) == 0;
}

/** The rotation that suits gravity pulling this way, or -1 when no edge is clearly down. */
int rotationFor(float x, float y) {
    // Measured on the real board: see the table in firmware/README.md.
    if (y < -DOWN_G) return 0;
    if (y > DOWN_G) return 180;
    if (x > DOWN_G) return 90;
    if (x < -DOWN_G) return 270;
    return -1;
}

}  // namespace

bool begin() {
    uint8_t who = 0;
    present = readRegs(REG_WHO_AM_I, &who, 1) && who == 0x05;
    if (!present) return false;
    writeReg(REG_CTRL1, 0x40);  // registers advance by themselves, so one read fetches all six bytes
    writeReg(REG_CTRL2, 0x10 | 0x06);  // 4 g, 125 Hz
    writeReg(REG_CTRL7, 0x01);  // accelerometer only
    return true;
}

void tick() {
    if (!present) return;
    const uint32_t now = millis();
    if (now - lastSample < SAMPLE_MS) return;
    lastSample = now;
    uint8_t d[6];
    if (!readRegs(REG_AX_L, d, 6)) return;
    // Smoothed a little, so a knock on the desk does not read as a turn.
    gx += ((int16_t)((d[1] << 8) | d[0]) / LSB_PER_G - gx) * 0.3f;
    gy += ((int16_t)((d[3] << 8) | d[2]) / LSB_PER_G - gy) * 0.3f;
    gz += ((int16_t)((d[5] << 8) | d[4]) / LSB_PER_G - gz) * 0.3f;

    const int seen = rotationFor(gx, gy);
    if (seen < 0) {
        candidate = -1;
        return;
    }
    if (seen != candidate) {
        candidate = seen;
        candidateSince = now;
    }
    if (candidate != settled && now - candidateSince >= DWELL_MS) settled = candidate;
}

int orientation() { return settled; }

void read(int &x, int &y, int &z) {
    x = (int)lroundf(gx * 1000);
    y = (int)lroundf(gy * 1000);
    z = (int)lroundf(gz * 1000);
}

}  // namespace imu
