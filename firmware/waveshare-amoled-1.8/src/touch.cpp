#include "touch.h"

#include <Wire.h>
#include "pins.h"

namespace touch {

namespace {

// A tap is short and stays put. Anything longer or wider is a hold or a swipe, which nothing uses yet.
const uint32_t TAP_MAX_MS = 700;
const int TAP_MAX_MOVE = 60;
// After this many failed reads the controller is assumed asleep and is only poked now and then.
const uint8_t BACKOFF_AFTER = 5;
const uint32_t RETRY_MS = 500;

bool present = false;
uint8_t failures = 0;
uint32_t lastRetry = 0, lastTouch = 0;

bool down = false;
uint32_t downAt = 0;
int startX = 0, startY = 0, farthest = 0;

void write(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(ADDR_TOUCH_FT3168);
    Wire.write(reg);
    Wire.write(value);
    Wire.endTransmission();
}

/** The controller drops into a low-power mode on its own and then stops answering; both registers keep it awake. */
void keepAwake() {
    write(0x86, 0x00);  // no auto-monitor when idle
    write(0xA5, 0x00);  // active mode
}

/** Reads the first finger. Returns false when none is down or the read failed. */
bool read(int &x, int &y, bool &ok) {
    ok = false;
    // The interrupt line is low while a finger is down, so a touch is never missed even while backed off.
    const bool asserted = digitalRead(TP_INT) == LOW;
    if (failures >= BACKOFF_AFTER && !asserted) {
        if (millis() - lastRetry >= RETRY_MS) {
            lastRetry = millis();
            keepAwake();
        }
        ok = true;  // nothing to read, which is not a failure
        return false;
    }
    if (asserted && failures >= BACKOFF_AFTER) {
        keepAwake();
        failures = 0;
    }
    // A write with a STOP and a separate read; the combined form is unreliable on this Arduino core.
    Wire.beginTransmission(ADDR_TOUCH_FT3168);
    Wire.write(0x01);
    if (Wire.endTransmission(true) != 0) {
        failures = min(255, failures + 1);
        return false;
    }
    uint8_t d[6];
    if (Wire.requestFrom((uint8_t)ADDR_TOUCH_FT3168, (uint8_t)6) != 6) {
        failures = min(255, failures + 1);
        return false;
    }
    for (int i = 0; i < 6; i++) d[i] = Wire.read();
    failures = 0;
    ok = true;
    if ((d[1] & 0x0F) == 0) return false;
    x = ((d[2] & 0x0F) << 8) | d[3];
    y = ((d[4] & 0x0F) << 8) | d[5];
    return true;
}

}  // namespace

bool begin() {
    pinMode(TP_INT, INPUT_PULLUP);
    Wire.beginTransmission(ADDR_TOUCH_FT3168);
    present = Wire.endTransmission() == 0;
    if (present) keepAwake();
    return present;
}

bool tapped() {
    if (!present) return false;
    int x = 0, y = 0;
    bool ok = false;
    const bool touching = read(x, y, ok);
    if (!ok) return false;  // a failed read says nothing about the finger
    const uint32_t now = millis();
    if (touching) {
        lastTouch = now ? now : 1;
        if (!down) {
            down = true;
            downAt = now;
            startX = x;
            startY = y;
            farthest = 0;
        } else {
            farthest = max(farthest, max(abs(x - startX), abs(y - startY)));
        }
        return false;
    }
    if (!down) return false;
    down = false;
    return now - downAt <= TAP_MAX_MS && farthest <= TAP_MAX_MOVE;
}

uint32_t idleMs() { return lastTouch ? millis() - lastTouch : UINT32_MAX; }

}  // namespace touch
