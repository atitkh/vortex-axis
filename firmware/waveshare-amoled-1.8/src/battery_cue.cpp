#include "battery_cue.h"

#include <esp_heap_caps.h>

#include "display.h"

// Pixels left under the mark: the 1.75 sets more, to keep it inside the round glass and clear of the edge glow.
#ifndef BATTERY_GLYPH_BOTTOM
#define BATTERY_GLYPH_BOTTOM 14
#endif

namespace batterycue {
namespace {

const uint32_t FRESH_MS = 90000;   // three of the power chip's readings
const uint32_t CUE_MS = 3000;      // the charging cue
const uint32_t PREVIEW_MS = 60000;
const uint32_t REDRAW_MS = 250;    // drawn again this often anyway, over whatever text or face strayed onto it
const int HYSTERESIS = 3;          // low battery clears above the threshold plus this
const int PULSE_BELOW = 5;         // below this the mark pulses slowly

// The mark: a 5 by 7 grid per sign, drawn 3 pixels to a cell, in a block W by H.
const int CELL = 3;
const int W = 140, H = 22;
const uint8_t DIGITS[11][7] = {
    {0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E}, {0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E},
    {0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F}, {0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E},
    {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02}, {0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E},
    {0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E}, {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08},
    {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E}, {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C},
    {0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03},  // %
};
const uint8_t BOLT[7] = {0x03, 0x06, 0x0C, 0x1F, 0x06, 0x0C, 0x18};

// What the readings say, worked out on the screen loop.
bool fresh = false, charging = false, low = false;
int percent = -1;
bool wasCharging = false, haveCharging = false;
uint32_t cueFrom = 0;
bool cueOn = false;

// The console's preview, handed over from its task.
volatile uint8_t previewWanted = 0;
volatile int previewPercent = 0;
volatile uint32_t previewRequests = 0;
uint32_t previewSeen = 0, previewUntil = 0;
Preview previewShown = Preview::Off;

// What is on the panel. The block is in PSRAM (made on first use): internal memory is short on these boards.
uint16_t *block = nullptr;
const size_t BLOCK_BYTES = W * H * sizeof(uint16_t);
bool markDrawn = false;
uint32_t drawnKey = 0, drawnAt = 0, drawnClears = 0;
int drawnX = 0, drawnY = 0;

uint16_t rgb(float r, float g, float b, float k) {
    const int ri = constrain((int)(r * k * 31.0f + 0.5f), 0, 31);
    const int gi = constrain((int)(g * k * 63.0f + 0.5f), 0, 63);
    const int bi = constrain((int)(b * k * 31.0f + 0.5f), 0, 31);
    return (uint16_t)((ri << 11) | (gi << 5) | bi);
}

void cells(int x, int y, int w, int h, uint16_t color) {
    for (int j = y * CELL; j < (y + h) * CELL; j++) {
        if (j < 0 || j >= H) continue;
        for (int i = x * CELL; i < (x + w) * CELL; i++) {
            if (i >= 0 && i < W) block[j * W + i] = color;
        }
    }
}

void sign(int x, const uint8_t rows[7], uint16_t color) {
    for (int r = 0; r < 7; r++) {
        for (int c = 0; c < 5; c++) {
            if (rows[r] & (0x10 >> c)) cells(x + c, r, 1, 1, color);
        }
    }
}

void startCue(uint32_t now) {
    cueFrom = now;
    cueOn = true;
}

}  // namespace

void preview(Preview kind, int value) {
    previewPercent = value;
    previewWanted = (uint8_t)kind;
    previewRequests++;
}

void update(const power::Reading &reading, uint32_t readAt, uint32_t now, int lowBelow) {
    if (lowBelow > 0) lowBelow = constrain(lowBelow, 5, 30);
    if (previewRequests != previewSeen) {
        previewSeen = previewRequests;
        previewShown = (Preview)previewWanted;
        previewUntil = now + PREVIEW_MS;
        low = false;
        cueOn = false;
        if (previewShown == Preview::Charging) startCue(now);
    }
    if (previewShown != Preview::Off && (int32_t)(now - previewUntil) >= 0) {
        previewShown = Preview::Off;
        low = cueOn = false;
        haveCharging = false;  // the real state, whatever it is, is taken as it stands, without a cue
    }
    if (previewShown != Preview::Off) {
        fresh = true;
        charging = previewShown == Preview::Charging;
        percent = previewShown == Preview::LowBattery ? 12 : previewShown == Preview::Charging ? 64 : constrain((int)previewPercent, 0, 100);
        if (previewShown == Preview::LowBattery) {
            low = true;
        } else if (charging || lowBelow <= 0) {
            low = false;
        } else {
            low = low ? percent <= lowBelow + HYSTERESIS : percent <= lowBelow;
        }
    } else {
        fresh = reading.taken && reading.battery && reading.percent >= 0 && now - readAt < FRESH_MS;
        charging = fresh && reading.charging;
        percent = fresh ? reading.percent : -1;
        if (!fresh || charging || lowBelow <= 0) {
            low = false;
        } else {
            low = low ? percent <= lowBelow + HYSTERESIS : percent <= lowBelow;
        }
        // The cue only for charging that begins while it is running, not for a board started on the charger.
        if (fresh) {
            if (haveCharging && charging && !wasCharging) startCue(now);
            wasCharging = charging;
            haveCharging = true;
        } else {
            haveCharging = false;
        }
    }
    if (cueOn && (!charging || now - cueFrom >= CUE_MS)) cueOn = false;
}

bool sleepy() { return low; }

float chargeCue(uint32_t now) {
    if (!cueOn) return -1.0f;
    const float t = (now - cueFrom) / (float)CUE_MS;
    return t >= 1.0f ? -1.0f : sinf(PI * t);
}

void draw(uint32_t now, bool markOn) {
    const bool cue = chargeCue(now) >= 0;
    if (!block) block = (uint16_t *)heap_caps_malloc(BLOCK_BYTES, MALLOC_CAP_SPIRAM);
    if (!block) return;
    const bool show = fresh && percent >= 0 && (cue || (markOn && (low || charging)));
    const int x = ((display::width() - W) / 2) & ~1, y = (display::height() - H - BATTERY_GLYPH_BOTTOM) & ~1;
    const bool wiped = display::clears() != drawnClears;
    drawnClears = display::clears();
    if (!show) {
        if (markDrawn && !wiped) {
            memset(block, 0, BLOCK_BYTES);
            display::blitRect(drawnX, drawnY, W, H, block);
        }
        markDrawn = false;
        return;
    }
    // How bright: a slow pulse below 5 %, and the bolt swelling with the glow during the cue.
    float k = 1.0f;
    if (low && percent < PULSE_BELOW) k = 0.35f + 0.65f * (0.5f + 0.5f * cosf(2.0f * PI * (now % 2500) / 2500.0f));
    const float boltK = cue ? 0.45f + 0.55f * chargeCue(now) : 0.8f;
    const bool moving = cue || (low && percent < PULSE_BELOW);
    const uint32_t key = (uint32_t)percent | (low ? 0x100u : 0) | (charging ? 0x200u : 0) | (markOn ? 0x400u : 0) |
                         ((uint32_t)(k * 15) << 12) | ((uint32_t)(boltK * 15) << 16) | ((uint32_t)x << 20);
    const bool due = wiped || !markDrawn || key != drawnKey || x != drawnX || y != drawnY ||
                     now - drawnAt >= (moving ? 80u : REDRAW_MS);
    if (!due) return;
    if (markDrawn && !wiped && (x != drawnX || y != drawnY)) {
        memset(block, 0, BLOCK_BYTES);
        display::blitRect(drawnX, drawnY, W, H, block);
    }
    memset(block, 0, BLOCK_BYTES);
    // Laid out in cells: [bolt] battery percent, centred in the block.
    const bool bolt = charging;
    const bool full = markOn || !cue;  // the cue alone, with the mark off, is just the bolt
    char text[5];
    snprintf(text, sizeof text, "%d", percent);
    const int digits = strlen(text);
    const int width = (bolt ? 7 : 0) + (full ? 13 + 2 + digits * 6 + 5 : -2);
    int at = ((W / CELL) - width) / 2;
    const uint16_t ink = rgb(0.80f, 0.82f, 0.85f, k * 0.85f);
    if (bolt) {
        sign(at, BOLT, rgb(0.10f, 0.78f, 0.95f, boltK));
        at += 7;
    }
    if (full) {
        // The battery: an outline 12 by 7 with its tip, filled as far as it is charged.
        cells(at, 0, 12, 1, ink);
        cells(at, 6, 12, 1, ink);
        cells(at, 0, 1, 7, ink);
        cells(at + 11, 0, 1, 7, ink);
        cells(at + 12, 2, 1, 3, ink);
        const int fill = percent <= 0 ? 0 : max(1, (percent * 10 + 50) / 100);
        const uint16_t level = charging ? rgb(0.34f, 1.00f, 0.40f, 0.8f)
                               : percent < PULSE_BELOW ? rgb(1.00f, 0.16f, 0.10f, k)
                               : low ? rgb(1.00f, 0.60f, 0.08f, k)
                               : ink;
        cells(at + 1, 1, fill, 5, level);
        at += 15;
        for (int i = 0; i < digits; i++, at += 6) sign(at, DIGITS[text[i] - '0'], ink);
        sign(at, DIGITS[10], ink);
    }
    display::blitRect(x, y, W, H, block);
    markDrawn = true;
    drawnKey = key;
    drawnAt = now;
    drawnX = x;
    drawnY = y;
}

void print(Print &out) {
    out.printf("[power] face: %s%s%s\n", !fresh ? "no fresh battery reading" : low ? "low battery" : charging ? "charging" : "nothing to show",
               cueOn ? ", charging cue" : "", previewShown != Preview::Off ? " (preview)" : "");
}

}  // namespace batterycue
