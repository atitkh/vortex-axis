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
            const uint16_t p = under[py * sw + px];
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

void drawAll(const uint16_t *under, const Tint &t, float strength) {
    const int w = display::width(), h = display::height();
    drawStrip(under, 0, 0, w, DEPTH, t, strength);
    drawStrip(under, 0, h - DEPTH, w, DEPTH, t, strength);
    // The sides are drawn a band at a time, so the strip buffer is enough.
    for (int y = DEPTH; y < h - DEPTH; y += DEPTH) {
        const int rows = min(DEPTH, h - DEPTH - y);
        drawStrip(under, 0, y, DEPTH, rows, t, strength);
        drawStrip(under, w - DEPTH, y, DEPTH, rows, t, strength);
    }
}

}  // namespace

void update(const uint16_t *under, State state, float level) {
    if (!under) return;
    const uint32_t now = millis();
    if (state == State::None) {
        if (drawn != State::None) drawAll(under, TINTS[0], 0.0f);  // puts the picture back
        drawn = State::None;
        return;
    }
    if (state == drawn && now - lastDraw < FRAME_MS) return;
    lastDraw = now;
    drawn = state;
    const Tint &t = TINTS[(int)state];
    // A voice to follow sets the strength; otherwise it breathes.
    const float breath = 0.5f + 0.5f * sinf(2.0f * PI * t.hz * now / 1000.0f);
    const float strength = level >= 0 ? 0.35f + 0.6f * constrain(level, 0.0f, 1.0f) : 0.3f + 0.45f * breath;
    drawAll(under, t, strength);
}

void reset() { drawn = State::None; }

}  // namespace glow
