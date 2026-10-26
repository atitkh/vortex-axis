#include "touch.h"

#include <Wire.h>
#include "pins.h"

namespace touch {

namespace {

// A tap is short and stays put. A hold stays put for longer; a swipe travels well across the glass, quickly.
const uint32_t TAP_MAX_MS = 700;
const int TAP_MAX_MOVE = 60;  // the 1.8's numbers: this panel has a similar pixel pitch
const uint32_t HOLD_MAX_MS = 4000;
const int SWIPE_MIN_MOVE = 100;
const uint32_t SWIPE_MAX_MS = 1000;
// After this many failed reads the controller is assumed asleep and is only poked now and then.
const uint8_t BACKOFF_AFTER = 5;  // then it is reset every RETRY_MS until it answers
const uint32_t RETRY_MS = 500;

bool present = false;
uint8_t failures = 0;
uint32_t lastRetry = 0, lastTouch = 0, lastReport = 0;
// With no report at all this long while a finger was down, it has lifted.
const uint32_t LIFT_AFTER_MS = 200;

bool down = false;
uint32_t downAt = 0;
int startX = 0, startY = 0, lastX = 0, lastY = 0, farthest = 0;

uint32_t okReads = 0, badReads = 0;
uint16_t chip = 0;

/** Pulses the controller's own reset line and gives it time to leave its boot loader. */
void reset() {
    pinMode(TP_RESET, OUTPUT);
    digitalWrite(TP_RESET, LOW);
    delay(10);
    digitalWrite(TP_RESET, HIGH);
    delay(30);
}

/**
 * Sends a 16-bit register address and reads `count` bytes after a repeated start. This controller needs
 * the repeated start: with a STOP in between it goes on reading from wherever it last stopped.
 */
bool readReg(uint16_t reg, uint8_t *out, uint8_t count) {
    Wire.beginTransmission(ADDR_TOUCH_CST9217);
    Wire.write(reg >> 8);
    Wire.write(reg & 0xFF);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((uint8_t)ADDR_TOUCH_CST9217, count) != count) return false;
    for (uint8_t i = 0; i < count; i++) out[i] = Wire.read();
    return true;
}

bool writeBytes(const uint8_t *data, uint8_t count) {
    Wire.beginTransmission(ADDR_TOUCH_CST9217);
    Wire.write(data, count);
    return Wire.endTransmission(true) == 0;
}

/** Reset, then the chip's type, as Waveshare's own driver starts it. 0 when it does not answer. */
uint16_t start() {
    reset();
    const uint8_t command[] = {0xD1, 0x01};  // into command mode, where the information registers can be read
    writeBytes(command, 2);
    delay(10);
    uint8_t b[4] = {0};
    if (!readReg(0xD204, b, 4)) return 0;
    return (b[3] << 8) | b[2];
}

/**
 * Reads the first finger. Returns false when none is down or the read failed.
 *
 * The CST9217 is read with a 16-bit command (0xD000), then told the report was taken (0xD000 0xAB). Its
 * interrupt line only pulses, so unlike the 1.8's controller it cannot say a finger is down; it is read
 * every frame. Coordinates come mirrored on both axes against the panel (Waveshare's own setup mirrors them).
 */
bool read(int &x, int &y, bool &ok) {
    ok = false;
    if (failures >= BACKOFF_AFTER) {
        // Probably asleep or wedged: reset it now and then rather than flooding the bus.
        if (millis() - lastRetry < RETRY_MS) {
            ok = true;
            return false;
        }
        lastRetry = millis();
        start();
        failures = BACKOFF_AFTER - 1;
    }
    uint8_t d[15];
    if (!readReg(0xD000, d, sizeof d)) {
        failures = min(255, failures + 1);
        badReads++;
        return false;
    }
    const uint8_t taken[] = {0xD0, 0x00, 0xAB};
    writeBytes(taken, 3);
    failures = 0;
    okReads++;
    ok = true;
    // No fresh report: byte 6 is not the controller's acknowledgement. That says nothing about the finger.
    if (d[6] != 0xAB) {
        ok = false;
        return false;
    }
    const uint8_t points = d[5] & 0x7F;
    if (points == 0 || points > 2) return false;
    if ((d[0] & 0x0F) != 0x06) return false;  // 6 is "pressed"; anything else is a lift
    const int rx = (d[1] << 4) | (d[3] >> 4), ry = (d[2] << 4) | (d[3] & 0x0F);
    x = constrain(LCD_WIDTH - rx, 0, LCD_WIDTH - 1);
    y = constrain(LCD_HEIGHT - ry, 0, LCD_HEIGHT - 1);
    return true;
}

}  // namespace

bool begin() {
    pinMode(TP_INT, INPUT_PULLUP);
    chip = start();
    present = chip != 0;
    return present;
}

void counts(uint32_t &good, uint32_t &bad) {
    good = okReads;
    bad = badReads;
}

Gesture poll() {
    if (!present) return Gesture::None;
    int x = 0, y = 0;
    bool ok = false;
    const bool seen = read(x, y, ok);
    const uint32_t now = millis();
    // A failed read or a stale report says nothing about the finger, unless nothing has been heard for a while.
    if (!ok && !(down && now - lastReport > LIFT_AFTER_MS)) return Gesture::None;
    if (ok) lastReport = now;
    const bool touching = ok && seen;
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

void dump(Print &out, int reads) {
    out.printf("[touch] chip %04X\n", chip);
    for (int n = 0; n < reads; n++) {
        uint8_t d[15] = {0};
        const bool ok = readReg(0xD000, d, sizeof d);
        const uint8_t taken[] = {0xD0, 0x00, 0xAB};
        const bool acked = writeBytes(taken, 3);
        out.printf("[touch] %s %s:", ok ? "read" : "FAILED", acked ? "" : "(no ack)");
        for (int i = 0; i < 8; i++) out.printf(" %02X", d[i]);
        out.println();
        delay(40);
    }
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
