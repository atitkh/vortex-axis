#include "touch.h"

#include <Wire.h>
#include "pins.h"

namespace touch {

namespace {

// A tap is short and stays put. A hold stays put for longer; a swipe travels well across the glass, quickly.
const uint32_t TAP_MAX_MS = 700;
const int TAP_MAX_MOVE = 60;
const uint32_t HOLD_MAX_MS = 4000;
const int SWIPE_MIN_MOVE = 100;
const uint32_t SWIPE_MAX_MS = 1000;
// After this many failed reads the controller is assumed asleep and is only poked now and then.
const uint8_t BACKOFF_AFTER = 5;
const uint32_t RETRY_MS = 500;

bool present = false;
uint8_t failures = 0;
uint32_t lastRetry = 0, lastTouch = 0;

bool down = false;
uint32_t downAt = 0;
int startX = 0, startY = 0, lastX = 0, lastY = 0, farthest = 0;

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

Gesture poll() {
    if (!present) return Gesture::None;
    int x = 0, y = 0;
    bool ok = false;
    const bool touching = read(x, y, ok);
    if (!ok) return Gesture::None;  // a failed read says nothing about the finger
    const uint32_t now = millis();
    if (touching) {
        lastTouch = now ? now : 1;
        if (!down) {
            down = true;
            downAt = now;
            startX = lastX = x;
            startY = lastY = y;
            farthest = 0;
        } else {
            lastX = x;
            lastY = y;
            farthest = max(farthest, max(abs(x - startX), abs(y - startY)));
        }
        return Gesture::None;
    }
    if (!down) return Gesture::None;
    down = false;
    const uint32_t held = now - downAt;
    if (farthest <= TAP_MAX_MOVE) {
        if (held <= TAP_MAX_MS) return Gesture::Tap;
        // A finger left resting on the glass for ages is not a gesture.
        return held <= HOLD_MAX_MS ? Gesture::Hold : Gesture::None;
    }
    const int travel = max(abs(lastX - startX), abs(lastY - startY));
    return travel >= SWIPE_MIN_MOVE && held <= SWIPE_MAX_MS ? Gesture::Swipe : Gesture::None;
}

bool tapped() { return poll() == Gesture::Tap; }

void swipeEnds(int &x0, int &y0, int &x1, int &y1) {
    x0 = startX;
    y0 = startY;
    x1 = lastX;
    y1 = lastY;
}

void tapPoint(int &x, int &y) {
    x = startX;
    y = startY;
}

uint32_t idleMs() { return lastTouch ? millis() - lastTouch : UINT32_MAX; }

}  // namespace touch
