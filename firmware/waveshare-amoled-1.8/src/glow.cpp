#include "glow.h"

#include "display.h"

namespace glow {

namespace {

const int DEPTH = 12;               // pixels in from the edge
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
};

State drawn = State::None;
uint32_t lastDraw = 0;
uint16_t strip[448 * DEPTH];

/** One edge strip at logical (x, y), w by h: the picture underneath with the glow laid over it. */
void drawStrip(const uint16_t *under, int x, int y, int w, int h, const Tint &t, float strength) {
    const int sw = display::width(), sh = display::height();
    for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
            const int px = x + i, py = y + j;
            const uint16_t p = under ? under[py * sw + px] : 0;
            const int d = min(min(px, py), min(sw - 1 - px, sh - 1 - py));
            const float fall = 1.0f - (float)d / DEPTH;
            const float a = d >= DEPTH ? 0.0f : strength * fall * fall;
            const float r = ((p >> 11) & 0x1F) / 31.0f, g = ((p >> 5) & 0x3F) / 63.0f, b = (p & 0x1F) / 31.0f;
            const float nr = r + (t.r - r) * a, ng = g + (t.g - g) * a, nb = b + (t.b - b) * a;
            strip[j * w + i] = ((uint16_t)(nr * 31.0f + 0.5f) << 11) | ((uint16_t)(ng * 63.0f + 0.5f) << 5) | (uint16_t)(nb * 31.0f + 0.5f);
        }
    }
    display::blitRect(x, y, w, h, strip);
}

/** Draws the part of a band that lies outside `keep` (the band runs along x when `across`, else along y). */
void drawBand(const uint16_t *under, int x, int y, int w, int h, const Tint &t, float strength, const Rect &keep) {
    const bool across = w >= h;
    int from = across ? x : y, to = across ? x + w : y + h;
    int cutFrom = to, cutTo = to;
    if (keep.w > 0) {
        const bool hits = across ? (keep.y < y + h && keep.y + keep.h > y) : (keep.x < x + w && keep.x + keep.w > x);
        if (hits) {
            cutFrom = max(from, across ? keep.x : keep.y);
            cutTo = min(to, across ? keep.x + keep.w : keep.y + keep.h);
        }
    }
    // Pieces small enough for the strip buffer: a full band across, DEPTH rows at a time down the sides.
    const int step = across ? 448 : DEPTH;
    for (int a = from; a < to;) {
        if (a >= cutFrom && a < cutTo) {
            a = cutTo;
            continue;
        }
        const int end = min(min(to, a + step), a < cutFrom ? cutFrom : to);
        if (across) drawStrip(under, a, y, end - a, h, t, strength);
        else drawStrip(under, x, a, w, end - a, t, strength);
        a = end;
    }
}

void drawAll(const uint16_t *under, const Tint &t, float strength, const Rect &keep) {
    const int w = display::width(), h = display::height();
    drawBand(under, 0, 0, w, DEPTH, t, strength, keep);
    drawBand(under, 0, h - DEPTH, w, DEPTH, t, strength, keep);
    drawBand(under, 0, DEPTH, DEPTH, h - 2 * DEPTH, t, strength, keep);
    drawBand(under, w - DEPTH, DEPTH, DEPTH, h - 2 * DEPTH, t, strength, keep);
}

}  // namespace

void update(const uint16_t *under, State state, float level, Rect keepOut) {
    const uint32_t now = millis();
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
    drawAll(under, t, strength, keepOut);
}

void reset() { drawn = State::None; }

}  // namespace glow
