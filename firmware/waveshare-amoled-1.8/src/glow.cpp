#include "glow.h"

#include "display.h"

namespace glow {

namespace {

const int DEPTH = 12;               // pixels in from the edge
// The glow turns the corners on a curve this wide, so it reads as one line around the panel's own rounded
// corners rather than two bands that cross there. Board setting glowCorner, to match the glass.
int RADIUS = 56;
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
};

State drawn = State::None;
uint32_t lastDraw = 0;
float drawnStrength = 0;
float drawnSweep = 1.0f;
const int STRIP = 448 * DEPTH;
uint16_t strip[STRIP];

/** How much glow logical (px, py) gets: full at the edge, gone DEPTH in, following the rounded corners. */
float alphaAt(int px, int py, float strength) {
    const int sw = display::width(), sh = display::height();
    const int cx = constrain(px, RADIUS, sw - 1 - RADIUS), cy = constrain(py, RADIUS, sh - 1 - RADIUS);
    float d;
    if (cx != px && cy != py) d = RADIUS - sqrtf((float)((px - cx) * (px - cx) + (py - cy) * (py - cy)));
    else d = min(min(px, py), min(sw - 1 - px, sh - 1 - py));
    if (d >= DEPTH) return 0.0f;
    // Only the part of the way round still lit, measured clockwise from the top middle.
    if (drawnSweep < 1.0f) {
        if (drawnSweep <= 0.0f) return 0.0f;
        float turn = atan2f((float)(px - sw / 2), (float)(sh / 2 - py)) / (2.0f * PI);
        if (turn < 0) turn += 1.0f;
        if (turn > drawnSweep) return 0.0f;
    }
    const float fall = d <= 0 ? 1.0f : 1.0f - d / DEPTH;
    return strength * fall * fall;
}

uint16_t blend(uint16_t p, const Tint &t, float a) {
    if (a <= 0) return p;
    const float r = ((p >> 11) & 0x1F) / 31.0f, g = ((p >> 5) & 0x3F) / 63.0f, b = (p & 0x1F) / 31.0f;
    const float nr = r + (t.r - r) * a, ng = g + (t.g - g) * a, nb = b + (t.b - b) * a;
    return ((uint16_t)(nr * 31.0f + 0.5f) << 11) | ((uint16_t)(ng * 63.0f + 0.5f) << 5) | (uint16_t)(nb * 31.0f + 0.5f);
}

/** One piece at logical (x, y), w by h: the picture underneath with the glow laid over it. */
void drawStrip(const uint16_t *under, int x, int y, int w, int h, const Tint &t, float strength) {
    const int sw = display::width();
    for (int j = 0; j < h; j++) {
        for (int i = 0; i < w; i++) {
            const int px = x + i, py = y + j;
            strip[j * w + i] = blend(under ? under[py * sw + px] : 0, t, alphaAt(px, py, strength));
        }
    }
    display::blitRect(x, y, w, h, strip);
}

/** Draws the part of a block that lies outside `keep` (cut along x when the block is wider than tall, else along y). */
void drawBand(const uint16_t *under, int x, int y, int w, int h, const Tint &t, float strength, const Rect &keep) {
    if (w <= 0 || h <= 0) return;
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
    // Pieces small enough for the strip buffer.
    const int step = across ? STRIP / h : STRIP / w;
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
    const int w = display::width(), h = display::height(), r = RADIUS;
    // The four straight runs between the corners, then the corners, which are deeper to hold the curve.
    drawBand(under, r, 0, w - 2 * r, DEPTH, t, strength, keep);
    drawBand(under, r, h - DEPTH, w - 2 * r, DEPTH, t, strength, keep);
    drawBand(under, 0, r, DEPTH, h - 2 * r, t, strength, keep);
    drawBand(under, w - DEPTH, r, DEPTH, h - 2 * r, t, strength, keep);
    drawBand(under, 0, 0, r, r, t, strength, keep);
    drawBand(under, w - r, 0, r, r, t, strength, keep);
    drawBand(under, 0, h - r, r, r, t, strength, keep);
    drawBand(under, w - r, h - r, r, r, t, strength, keep);
}

}  // namespace

void update(const uint16_t *under, State state, float level, Rect keepOut, float sweep) {
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
    drawnStrength = strength;
    // Every pixel of the edge is drawn each time, so the part the sweep has left goes back to what is underneath.
    drawnSweep = constrain(sweep, 0.0f, 1.0f);
    drawAll(under, t, strength, keepOut);
}

void tint(uint16_t *pixels, int x, int y, int size) {
    if (drawn == State::None) return;
    const Tint &t = TINTS[(int)drawn];
    const int sw = display::width(), sh = display::height(), reach = max(DEPTH, RADIUS);
    // The face's frame is laid out as the panel sees it, not turned, so each pixel is found on the logical screen.
    int ox, oy;
    display::squareOnPanel(x, y, size, ox, oy);
    for (int j = 0; j < size; j++) {
        for (int i = 0; i < size; i++) {
            int px, py;
            display::toLogical(ox + i, oy + j, px, py);
            if (py >= reach && py < sh - reach && px >= reach && px < sw - reach) continue;
            pixels[j * size + i] = blend(pixels[j * size + i], t, alphaAt(px, py, drawnStrength));
        }
    }
}

void setCorner(int radius) { RADIUS = constrain(radius, DEPTH, 120); }

void reset() { drawn = State::None; }

}  // namespace glow
