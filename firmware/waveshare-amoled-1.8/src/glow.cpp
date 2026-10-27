#include "glow.h"

#include "display.h"
#include "pins.h"

#include <esp_heap_caps.h>

namespace glow {

namespace {

const int DEPTH = 12;               // pixels in from the edge
// The glow turns the corners on a curve this wide, so it reads as one line around the panel's own rounded
// corners rather than two bands that cross there. Board setting glowCorner, to match the glass.
int RADIUS = 56;
// The ring is drawn in bands of this many panel rows (pieces down the sides are joined into taller ones).
const int BAND = 12;
const uint32_t FRAME_MS = 50;
// The face's own colours for each state (vortex.cpp's looks), and how fast it breathes in each.
struct Tint {
    float r, g, b, hz;
};
const Tint TINTS[] = {
    {0, 0, 0, 0},              // None
    {0.15f, 1.00f, 0.55f, 1.2f},  // Listening: mint
    {0.62f, 0.40f, 1.00f, 0.9f},  // Thinking: violet
    {0.55f, 0.95f, 1.00f, 2.4f},  // Speaking: cyan
    {1.00f, 0.60f, 0.08f, 0.5f},  // Waiting: amber, slow
    {0.34f, 1.00f, 0.40f, 0.0f},  // Done: green
    {1.00f, 0.16f, 0.10f, 0.0f},  // Timer: red, beating once a second (the caller's level)
    {0.20f, 0.50f, 1.00f, 0.8f},  // Question: blue, a little quicker than waiting
    {1.00f, 1.00f, 1.00f, 2.5f},  // Find: white, quick
    {1.00f, 0.32f, 0.62f, 1.4f},  // Hands: rose, an agent at a computer nearby
};

State drawn = State::None;
const uint16_t *drawnUnder = nullptr;
uint32_t lastDraw = 0;
float drawnStrength = 0;
float drawnSweep = 1.0f;
// One write's worth (the driver's limit), in internal memory: pieces are cut to fit.
const int STRIP = 1024;
uint16_t strip[STRIP];

// How much glow each pixel near the edge gets depends only on where it is (and the corner curve), so that is worked out
// once (PSRAM), in the panel's own coordinates: the rounded rectangle is the panel's own whatever the rotation. The
// ring crosses each panel row in one run (along the top and bottom) or two (down the sides). For each pixel of a run:
// the fall-off squared, 0 to 65535 (full at the edge, nothing DEPTH in), and how far round the screen it is, clockwise
// from the panel's top middle, 0 to 65535 for a whole turn (for a timer's sweep).
const int PW = LCD_WIDTH, PH = LCD_HEIGHT;
struct Run {
    int16_t from, to;  // panel columns, to not included; from == to when there is none
    int32_t at;        // where its pixels start in fall[] and turn[]
};
Run *runs = nullptr;  // PH rows of two
uint16_t *fall = nullptr, *turn = nullptr;
int tableRadius = -1;
uint16_t *over = nullptr;  // 1024, see prepareOver
uint32_t statMath = 0, statSend = 0, statPixels = 0, statPieces = 0;

/** How far panel (x, y) is in from the edge of the rounded rectangle: the same sums as before the table. */
float inset(int x, int y) {
    const int cx = constrain(x, RADIUS, PW - 1 - RADIUS), cy = constrain(y, RADIUS, PH - 1 - RADIUS);
    if (cx != x && cy != y) return RADIUS - sqrtf((float)((x - cx) * (x - cx) + (y - cy) * (y - cy)));
    return min(min(x, y), min(PW - 1 - x, PH - 1 - y));
}

bool makeTable() {
    if (runs && tableRadius == RADIUS) return true;
    if (!over) over = (uint16_t *)heap_caps_malloc(1024 * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    if (!runs) runs = (Run *)heap_caps_calloc(PH * 2, sizeof(Run), MALLOC_CAP_SPIRAM);
    if (!over || !runs) return false;
    // First where the runs are. Away from the top and bottom only the sides, out to the corner curve, can be lit.
    const int reach = max(RADIUS, DEPTH) + 1;
    int count = 0;
    for (int y = 0; y < PH; y++) {
        const bool across = y < DEPTH || y >= PH - DEPTH;
        int n = 0;
        bool in = false;
        runs[y * 2] = runs[y * 2 + 1] = {0, 0, 0};
        for (int x = 0; x <= PW; x++) {
            if (!across && !in && x >= reach && x < PW - reach) x = PW - reach;
            const bool ring = x < PW && inset(x, y) < DEPTH;
            if (ring && !in && n < 2) {
                runs[y * 2 + n] = {(int16_t)x, (int16_t)x, count};
                in = true;
            }
            if (in && !ring) {
                runs[y * 2 + n].to = (int16_t)x;
                count += x - runs[y * 2 + n].from;
                n++;
                in = false;
            }
        }
    }
    heap_caps_free(fall);
    heap_caps_free(turn);
    fall = (uint16_t *)heap_caps_malloc(count * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    turn = (uint16_t *)heap_caps_malloc(count * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    if (!fall || !turn) {
        heap_caps_free(fall);
        heap_caps_free(turn);
        fall = turn = nullptr;
        tableRadius = -1;
        return false;
    }
    // Then each pixel's fall-off and place round the screen, measured from the middle as before (PW / 2, PH / 2).
    for (int y = 0; y < PH; y++) {
        for (int r = 0; r < 2; r++) {
            const Run &run = runs[y * 2 + r];
            for (int x = run.from; x < run.to; x++) {
                const float d = inset(x, y);
                const float f = d <= 0 ? 1.0f : 1.0f - d / DEPTH;
                const int k = run.at + x - run.from;
                fall[k] = (uint16_t)(f * f * 65535.0f + 0.5f);
                float t = atan2f((float)(x - PW / 2), (float)(PH / 2 - y)) / (2.0f * PI);
                if (t < 0) t += 1.0f;
                turn[k] = (uint16_t)min(65535.0f, t * 65536.0f);
            }
        }
    }
    tableRadius = RADIUS;
    return true;
}

uint16_t blend(uint16_t p, const Tint &t, float a) {
    if (a <= 0) return p;
    // Over black, which is most of it (the face's frame, the screen round the face): the same sums with nothing to mix.
    if (!p) return ((uint16_t)(t.r * a * 31.0f + 0.5f) << 11) | ((uint16_t)(t.g * a * 63.0f + 0.5f) << 5) | (uint16_t)(t.b * a * 31.0f + 0.5f);
    const float r = ((p >> 11) & 0x1F) * (1.0f / 31.0f), g = ((p >> 5) & 0x3F) * (1.0f / 63.0f), b = (p & 0x1F) * (1.0f / 31.0f);
    const float nr = r + (t.r - r) * a, ng = g + (t.g - g) * a, nb = b + (t.b - b) * a;
    return ((uint16_t)(nr * 31.0f + 0.5f) << 11) | ((uint16_t)(ng * 63.0f + 0.5f) << 5) | (uint16_t)(nb * 31.0f + 0.5f);
}

// The colour over black for each of 1024 steps of the fall-off, made again when the strength or the colour changes:
// most of the ring lies over black, and this saves the sums for every pixel of it.
float overScale = -1.0f;
const Tint *overTint = nullptr;

void prepareOver(const Tint &t, float scale) {
    if (scale == overScale && &t == overTint) return;
    overScale = scale;
    overTint = &t;
    for (int i = 0; i < 1024; i++) over[i] = blend(0, t, (i * 64 + 32) * scale);
}

/** Pixel `k` of the table with the glow on: `p` (what is there) with it laid over, or as it is where a sweep has passed. */
inline uint16_t glowPixel(uint16_t p, int k, const Tint &t, float scale, uint32_t sweepTurn, uint32_t turnOffset) {
    if (drawnSweep < 1.0f) {
        if (drawnSweep <= 0.0f) return p;
        // The sweep is measured on the screen as it is turned: a quarter turn on for each 90 degrees.
        if (((turn[k] + turnOffset) & 0xFFFF) > sweepTurn) return p;
    }
    return p ? blend(p, t, fall[k] * scale) : over[fall[k] >> 6];
}

uint32_t sweepTurn() { return (uint32_t)(constrain(drawnSweep, 0.0f, 1.0f) * 65536.0f); }
uint32_t turnOffset() { return (uint32_t)(display::rotationDegrees() / 90) * 16384u; }

/** One piece at panel (x, y), w by h: the picture underneath (logical, turned to find it) with the glow laid over it. */
void drawStrip(const uint16_t *under, int x, int y, int w, int h, const Tint &t, float strength) {
    const uint32_t t0 = micros();
    const int sw = display::width();
    const uint32_t sweep = sweepTurn(), offset = turnOffset();
    const float scale = strength / 65535.0f;
    prepareOver(t, scale);
    for (int j = 0; j < h; j++) {
        uint16_t *out = strip + j * w;
        const int py = y + j;
        if (!under) {
            memset(out, 0, w * sizeof(uint16_t));
        } else {
            for (int i = 0; i < w; i++) {
                int lx, ly;
                display::toLogical(x + i, py, lx, ly);
                out[i] = under[ly * sw + lx];
            }
        }
        for (int r = 0; r < 2; r++) {
            const Run &run = runs[py * 2 + r];
            const int from = max((int)run.from, x), to = min((int)run.to, x + w);
            for (int px = from; px < to; px++) {
                const int k = run.at + px - run.from;
                out[px - x] = glowPixel(out[px - x], k, t, scale, sweep, offset);
            }
        }
    }
    const uint32_t t1 = micros();
    display::blitPanel(x, y, w, h, strip);
    statMath += t1 - t0;
    statSend += micros() - t1;
    statPixels += w * h;
    statPieces++;
}

/** Draws a block of the panel in pieces small enough for the strip buffer. */
void drawRect(const uint16_t *under, int x, int y, int w, int h, const Tint &t, float strength) {
    if (w <= 0 || h <= 0) return;
    if (w * h <= STRIP) return drawStrip(under, x, y, w, h, t, strength);
    // Wider than tall: cut across; taller than wide: cut down, so each piece is one write.
    if (w >= h) {
        const int step = max(1, STRIP / h);
        for (int a = x; a < x + w; a += step) drawStrip(under, a, y, min(step, x + w - a), h, t, strength);
    } else {
        const int step = max(1, STRIP / w);
        for (int a = y; a < y + h; a += step) drawStrip(under, x, a, w, min(step, y + h - a), t, strength);
    }
}

/** Draws the part of a block that lies outside `keep`: up to four blocks round it. */
void drawBand(const uint16_t *under, int x, int y, int w, int h, const Tint &t, float strength, const Rect &keep) {
    if (w <= 0 || h <= 0) return;
    const int kx0 = max(x, keep.x), ky0 = max(y, keep.y), kx1 = min(x + w, keep.x + keep.w), ky1 = min(y + h, keep.y + keep.h);
    if (keep.w <= 0 || kx0 >= kx1 || ky0 >= ky1) return drawRect(under, x, y, w, h, t, strength);
    drawRect(under, x, y, w, ky0 - y, t, strength);
    drawRect(under, x, ky1, w, y + h - ky1, t, strength);
    drawRect(under, x, ky0, kx0 - x, ky1 - ky0, t, strength);
    drawRect(under, kx1, ky0, x + w - kx1, ky1 - ky0, t, strength);
}

void drawAll(const uint16_t *under, const Tint &t, float strength, const Rect &keep) {
    if (!makeTable()) return;
    // Bands BAND rows tall in the panel's own coordinates, so each piece goes out in a few writes whatever the rotation:
    // across the top and bottom one piece, down the sides one each, joined with the bands below while they are the same.
    struct Span {
        int y, h, left, leftEnd, rightFrom, right;
        bool whole;
    };
    Span open = {0, 0, 0, 0, 0, 0, false};
    auto flush = [&]() {
        if (open.h <= 0) return;
        if (open.whole) {
            drawBand(under, open.left, open.y, open.right - open.left, open.h, t, strength, keep);
        } else {
            drawBand(under, open.left, open.y, open.leftEnd - open.left, open.h, t, strength, keep);
            drawBand(under, open.rightFrom, open.y, open.right - open.rightFrom, open.h, t, strength, keep);
        }
        open.h = 0;
    };
    for (int y = 0; y < PH; y += BAND) {
        const int h = min(BAND, PH - y);
        int left = PW, leftEnd = 0, rightFrom = PW, right = 0;
        bool whole = false;
        for (int j = y; j < y + h; j++) {
            const Run &a = runs[j * 2], &b = runs[j * 2 + 1];
            if (a.to <= a.from) continue;
            left = min(left, (int)a.from);
            if (b.to <= b.from) {
                whole = true;
                right = max(right, (int)a.to);
                continue;
            }
            leftEnd = max(leftEnd, (int)a.to);
            rightFrom = min(rightFrom, (int)b.from);
            right = max(right, (int)b.to);
        }
        if (right <= left) {
            flush();
            continue;
        }
        whole = whole || leftEnd >= rightFrom;
        // The same sides as the band above, and still one write each: one piece.
        const bool same = open.h > 0 && !whole && !open.whole && left == open.left && leftEnd == open.leftEnd &&
                          rightFrom == open.rightFrom && right == open.right &&
                          max(leftEnd - left, right - rightFrom) * (open.h + h) <= STRIP;
        if (same) {
            open.h += h;
            continue;
        }
        flush();
        open = {y, h, left, leftEnd, rightFrom, right, whole};
    }
    flush();
}

}  // namespace

void update(const uint16_t *under, State state, float level, Rect keepOut, float sweep) {
    const uint32_t now = millis();
    drawnUnder = under;
    if (state == State::None) {
        if (drawn != State::None) drawAll(under, TINTS[0], 0.0f, keepOut);  // puts back what was underneath
        drawn = State::None;
        return;
    }
    // Over the face the glow shares the panel with it, so it is drawn less often.
    const uint32_t every = under ? FRAME_MS : FRAME_MS * 2;
    if (state == drawn && now - lastDraw < every) return;
    lastDraw = now;
    drawn = state;
    const Tint &t = TINTS[(int)state];
    // A voice or a fading flash sets the strength; otherwise it breathes.
    const float breath = 0.5f + 0.5f * sinf(2.0f * PI * t.hz * now / 1000.0f);
    float strength = level >= 0 ? 0.35f + 0.6f * constrain(level, 0.0f, 1.0f) : 0.3f + 0.45f * breath;
    if (state == State::Done) strength = 0.9f * constrain(level, 0.0f, 1.0f);  // a flash fades right out
    drawnStrength = strength;
    // Every pixel of the edge is drawn each time, so the part the sweep has left goes back to what is underneath.
    drawnSweep = constrain(sweep, 0.0f, 1.0f);
    drawAll(under, t, strength, keepOut);
}

bool tint(uint16_t *pixels, int x, int y, int size, int fromX, int fromY, int toX, int toY) {
    if (drawn == State::None || !makeTable()) return false;
    const Tint &t = TINTS[(int)drawn];
    const uint32_t sweep = sweepTurn(), offset = turnOffset();
    const float scale = drawnStrength / 65535.0f;
    prepareOver(t, scale);
    // The frame is laid out as the panel sees it, so the table is read straight across its rows; the middle of the face,
    // well inside the ring, is not in it at all.
    for (int j = max(0, fromY); j < min(size, toY); j++) {
        const int py = y + j;
        if (py < 0 || py >= PH) continue;
        for (int r = 0; r < 2; r++) {
            const Run &run = runs[py * 2 + r];
            const int from = max((int)run.from, x + max(0, fromX)), to = min((int)run.to, x + min(size, toX));
            uint16_t *row = pixels + j * size - x;
            for (int px = from; px < to; px++) row[px] = glowPixel(row[px], run.at + px - run.from, t, scale, sweep, offset);
        }
    }
    return true;
}

void untint(uint16_t *pixels, int x, int y, int size, int fromX, int fromY, int toX, int toY) {
    if (!runs || tableRadius < 0) return;
    for (int j = max(0, fromY); j < min(size, toY); j++) {
        const int py = y + j;
        if (py < 0 || py >= PH) continue;
        for (int r = 0; r < 2; r++) {
            const Run &run = runs[py * 2 + r];
            const int from = max((int)run.from, x + max(0, fromX)), to = min((int)run.to, x + min(size, toX));
            if (to > from) memset(pixels + j * size + from - x, 0, (to - from) * sizeof(uint16_t));
        }
    }
}

bool ringRow(int y, int run, int &from, int &to) {
    if (!makeTable() || y < 0 || y >= PH || run < 0 || run > 1) return false;
    const Run &r = runs[y * 2 + run];
    from = r.from;
    to = r.to;
    return to > from;
}

void setCorner(int radius) {
    radius = constrain(radius, DEPTH, 120);
    if (radius == RADIUS) return;
    // A glow on show is taken off along the old curve first, or its corners would stay lit outside the new one.
    if (drawn != State::None && makeTable()) drawAll(drawnUnder, TINTS[0], 0.0f, Rect());
    RADIUS = radius;
}

void stats(uint32_t &math, uint32_t &send, uint32_t &pixels, uint32_t &pieces) {
    math = statMath, send = statSend, pixels = statPixels, pieces = statPieces;
    statMath = statSend = statPixels = statPieces = 0;
}

void reset() { drawn = State::None; }

}  // namespace glow
