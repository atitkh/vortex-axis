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
// A pickup: the pull on the board strays from its resting value (about 1 g) by more than PICKUP_G after it lay still (within
// STILL_G) for PICKUP_REST_MS. So handling that goes on counts once, and a new pickup needs a rest first.
// A hard knock on the table counts too; the sensor cannot tell the two apart from one jolt.
const float PICKUP_G = 0.15f;
const float STILL_G = 0.05f;
const uint32_t PICKUP_REST_MS = 5000;

bool present = false;
float gx = 0, gy = 0, gz = 0;
int settled = -1, candidate = -1;
uint32_t candidateSince = 0, lastSample = 0;
uint32_t lastMoved = 0, pickupCount = 0;
float restPull = 1.0f;

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

/**
 * The rotation that suits the way the board is standing, or -1 when no edge
 * is clearly down. An axis reads positive when it points UP.
 *
 * The sensor's Y axis runs along the panel's short side and its X axis along
 * the long side, pointing at the panel's top. So gravity along Y means the
 * board is standing on a long edge (landscape), and along X on a short edge
 * (portrait). Measured on the real board: lying nearly flat and tipped toward
 * the reader at rotation 90, it read y = -0.26. The first version had this a
 * quarter turn out.
 */
int rotationFor(float x, float y) {
    if (y < -DOWN_G) return 90;
    if (y > DOWN_G) return 270;
    if (x > DOWN_G) return 0;
    if (x < -DOWN_G) return 180;
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
    const float ax = (int16_t)((d[1] << 8) | d[0]) / LSB_PER_G, ay = (int16_t)((d[3] << 8) | d[2]) / LSB_PER_G,
                az = (int16_t)((d[5] << 8) | d[4]) / LSB_PER_G;
    // Against the pull it settles at rather than exactly 1 g: a sensor reads a few hundredths off at rest.
    const float pull = sqrtf(ax * ax + ay * ay + az * az);
    const float strays = fabsf(pull - restPull);
    restPull += (pull - restPull) * 0.02f;
    if (strays > PICKUP_G && now - lastMoved >= PICKUP_REST_MS) pickupCount++;
    if (strays > STILL_G) lastMoved = now;
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

uint32_t pickups() { return pickupCount; }

void read(int &x, int &y, int &z) {
    x = (int)lroundf(gx * 1000);
    y = (int)lroundf(gy * 1000);
    z = (int)lroundf(gz * 1000);
}

}  // namespace imu
