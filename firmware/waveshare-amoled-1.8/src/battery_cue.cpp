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

// The mark: [bolt] battery percent, centred in a block W by H. The percent is body text, drawn by the display like
// every other line; the battery and the bolt are shapes in pixels with soft edges, worked out once (see masks()).
const int W = 140, H = 24;
const int BAT_W = 34, BAT_H = 16;    // the battery with its tip
const float BODY_W = 30, RADIUS = 4, STROKE = 2;
const float FILL_IN = 3.5f;          // from the outside of the body to the fill
const int BOLT_W = 11, BOLT_H = 18;
const float BOLT[][2] = {{6.5f, 0}, {0.5f, 10}, {5, 10}, {3.5f, 18}, {10.5f, 7.5f}, {6, 7.5f}, {8.5f, 0}};
const int GAP = 6;
const int SAMPLES = 4;               // 4 by 4 samples a pixel for the soft edges

// What the readings say, worked out on the screen loop.
bool fresh = false, charging = false, low = false;
int percent = -1;
bool wasCharging = false, haveCharging = false;
uint32_t cueFrom = 0;
bool cueOn = false;

// The console's preview, handed over from its task.
volatile uint8_t previewWanted = 0;
volatile int previewPercent = 0;
volatile uint32_t previewMs = PREVIEW_MS;
volatile uint32_t previewRequests = 0;
uint32_t previewSeen = 0, previewUntil = 0;
Preview previewShown = Preview::Off;

// What is on the panel. The block and the shapes are in PSRAM (made on first use): internal memory is short on these boards.
uint16_t *block = nullptr;
const size_t BLOCK_BYTES = W * H * sizeof(uint16_t);
uint8_t *outline = nullptr, *bolt = nullptr;  // how much of each pixel the shape covers, 0 to 255
bool markDrawn = false;
uint32_t drawnKey = 0, drawnAt = 0, drawnClears = 0;
int drawnX = 0, drawnY = 0, drawnSize = -1;

struct Ink {
    float r, g, b, k;
};

uint16_t rgb(float r, float g, float b, float k) {
    const int ri = constrain((int)(r * k * 31.0f + 0.5f), 0, 31);
    const int gi = constrain((int)(g * k * 63.0f + 0.5f), 0, 63);
    const int bi = constrain((int)(b * k * 31.0f + 0.5f), 0, 31);
    return (uint16_t)((ri << 11) | (gi << 5) | bi);
}
uint16_t rgb(const Ink &ink, float k = 1.0f) { return rgb(ink.r, ink.g, ink.b, ink.k * k); }

bool inRounded(float x, float y, float x0, float y0, float x1, float y1, float r) {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const float dx = max(0.0f, max(x0 + r - x, x - (x1 - r))), dy = max(0.0f, max(y0 + r - y, y - (y1 - r)));
    return dx * dx + dy * dy <= r * r;
}

bool inBolt(float x, float y) {
    const int n = sizeof BOLT / sizeof BOLT[0];
    bool in = false;
    for (int i = 0, j = n - 1; i < n; j = i++) {
        if ((BOLT[i][1] > y) != (BOLT[j][1] > y) &&
            x < (BOLT[j][0] - BOLT[i][0]) * (y - BOLT[i][1]) / (BOLT[j][1] - BOLT[i][1]) + BOLT[i][0])
            in = !in;
    }
    return in;
}

// The battery's outline and tip, in a box BAT_W by BAT_H.
bool inOutline(float x, float y) {
    const float mid = BAT_H / 2.0f;
    if (inRounded(x, y, BODY_W - 1, mid - 3.5f, BAT_W, mid + 3.5f, 1.5f)) return true;
    return inRounded(x, y, 0, 0, BODY_W, BAT_H, RADIUS) &&
           !inRounded(x, y, STROKE, STROKE, BODY_W - STROKE, BAT_H - STROKE, RADIUS - STROKE);
}

// The fill, as far as `upTo` across the inside.
bool inFill(float x, float y, float upTo) {
    return x <= upTo && inRounded(x, y, FILL_IN, FILL_IN, BODY_W - FILL_IN, BAT_H - FILL_IN, 1.5f);
}

template <typename Inside>
uint8_t cover(int i, int j, Inside inside) {
    int n = 0;
    for (int sy = 0; sy < SAMPLES; sy++) {
        for (int sx = 0; sx < SAMPLES; sx++) n += inside(i + (sx + 0.5f) / SAMPLES, j + (sy + 0.5f) / SAMPLES);
    }
    return (uint8_t)(n * 255 / (SAMPLES * SAMPLES));
}

// The two shapes that never change, worked out once.
bool masks() {
    if (outline) return true;
    uint8_t *m = (uint8_t *)heap_caps_malloc(BAT_W * BAT_H + BOLT_W * BOLT_H, MALLOC_CAP_SPIRAM);
    if (!m) return false;
    for (int j = 0; j < BAT_H; j++) {
        for (int i = 0; i < BAT_W; i++) m[j * BAT_W + i] = cover(i, j, inOutline);
    }
    bolt = m + BAT_W * BAT_H;
    for (int j = 0; j < BOLT_H; j++) {
        for (int i = 0; i < BOLT_W; i++) bolt[j * BOLT_W + i] = cover(i, j, inBolt);
    }
    outline = m;
    return true;
}

// Lays a shape on the block at (x, y), its colour scaled by how much of each pixel it covers.
void stamp(const uint8_t *mask, int w, int h, int x, int y, const Ink &ink, float k) {
    for (int j = 0; j < h; j++) {
        if (y + j < 0 || y + j >= H) continue;
        for (int i = 0; i < w; i++) {
            const uint8_t a = mask[j * w + i];
            if (a && x + i >= 0 && x + i < W) block[(y + j) * W + x + i] = rgb(ink, k * a / 255.0f);
        }
    }
}

void startCue(uint32_t now) {
    cueFrom = now;
    cueOn = true;
}

}  // namespace

void preview(Preview kind, int value) {
    previewPercent = kind == Preview::LowBattery ? 12 : kind == Preview::Charging ? 64 : value;
    previewMs = PREVIEW_MS;
    previewWanted = (uint8_t)kind;
    previewRequests++;
}

void show(int value, bool charging, uint32_t ms) {
    previewPercent = constrain(value, 0, 100);
    previewMs = ms;
    previewWanted = (uint8_t)(charging ? Preview::Charging : Preview::Battery);
    previewRequests++;
}

void update(const power::Reading &reading, uint32_t readAt, uint32_t now, int lowBelow) {
    if (lowBelow > 0) lowBelow = constrain(lowBelow, 5, 30);
    if (previewRequests != previewSeen) {
        previewSeen = previewRequests;
        previewShown = (Preview)previewWanted;
        previewUntil = now + previewMs;
        low = false;
        cueOn = false;
        haveCharging = false;  // after it, the real state is taken as it stands, without a cue
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
        percent = constrain((int)previewPercent, 0, 100);
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
    if (!block || !masks()) return;
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
    const bool due = wiped || !markDrawn || key != drawnKey || x != drawnX || y != drawnY || display::textSize() != drawnSize ||
                     now - drawnAt >= (moving ? 80u : REDRAW_MS);
    if (!due) return;
    if (markDrawn && !wiped && (x != drawnX || y != drawnY)) {
        memset(block, 0, BLOCK_BYTES);
        display::blitRect(drawnX, drawnY, W, H, block);
    }
    memset(block, 0, BLOCK_BYTES);
    // [bolt] battery percent, centred in the block.
    const bool withBolt = charging;
    const bool full = markOn || !cue;  // the cue alone, with the mark off, is just the bolt
    char text[6];
    snprintf(text, sizeof text, "%d%%", percent);
    const int textW = full ? display::textWidth(2, text) : 0;
    const int width = (withBolt ? BOLT_W : 0) + (withBolt && full ? GAP : 0) + (full ? BAT_W + GAP + textW : 0);
    int at = (W - width) / 2;
    const Ink grey = {0.80f, 0.82f, 0.85f, 0.85f};
    const Ink level = charging ? Ink{0.34f, 1.00f, 0.40f, 0.8f}
                      : percent < PULSE_BELOW ? Ink{1.00f, 0.16f, 0.10f, 1.0f}
                      : low ? Ink{1.00f, 0.60f, 0.08f, 1.0f}
                      : grey;
    const float levelK = charging ? 1.0f : k;
    if (withBolt) {
        stamp(bolt, BOLT_W, BOLT_H, at, (H - BOLT_H) / 2, Ink{0.10f, 0.78f, 0.95f, 1.0f}, boltK);
        at += BOLT_W + (full ? GAP : 0);
    }
    if (full) {
        // The battery: its outline and tip, and the inside filled as far as it is charged.
        const int top = (H - BAT_H) / 2;
        stamp(outline, BAT_W, BAT_H, at, top, grey, k);
        if (percent > 0) {
            const float upTo = FILL_IN + max(1.5f, (BODY_W - 2 * FILL_IN) * percent / 100.0f);
            for (int j = (int)FILL_IN; j < BAT_H - (int)FILL_IN; j++) {
                for (int i = (int)FILL_IN; i < (int)(upTo + 1); i++) {
                    const uint8_t a = cover(i, j, [upTo](float px, float py) { return inFill(px, py, upTo); });
                    if (a) block[(top + j) * W + at + i] = rgb(level, levelK * a / 255.0f);
                }
            }
        }
        at += BAT_W + GAP;
        display::textInto(block, W, H, at, 2, rgb(level, levelK), text);
    }
    display::blitRect(x, y, W, H, block);
    markDrawn = true;
    drawnKey = key;
    drawnAt = now;
    drawnX = x;
    drawnY = y;
    drawnSize = display::textSize();
}

void print(Print &out) {
    out.printf("[power] face: %s%s%s\n", !fresh ? "no fresh battery reading" : low ? "low battery" : charging ? "charging" : "nothing to show",
               cueOn ? ", charging cue" : "", previewShown != Preview::Off ? " (preview)" : "");
}

}  // namespace batterycue
