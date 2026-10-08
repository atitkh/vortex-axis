#include "vortex.h"

#include <esp_heap_caps.h>
#include <esp_random.h>
#include <math.h>

namespace vortex {

namespace {

const int ARMS = 3;
const int DOTS_PER_ARM = 26;
const float MAX_RADIUS = SIZE / 2 - 14;

/** One look of the vortex. The drawn look eases towards a target, so changes never jump. */
struct Look {
    float spin;     // turns of the whole figure, radians per second
    float radius;   // 0 to 1 of the available space
    float twist;    // how far the arms wrap, in turns
    float pulse;    // how much the radius breathes, 0 to about 0.3
    float pulseHz;  // how fast it breathes
    float wander;   // how far the centre drifts, in pixels
    float sparkle;  // chance per dot per frame of a bright flash
    float dot;      // dot size multiplier
    float r, g, b;  // colour, 0 to 1
};

struct IdleLook {
    const char *name;
    Look look;
};

// Idle picks among these at random, so the device does not look like a loop.
const IdleLook IDLE[] = {
    {"calm", {0.50f, 0.85f, 0.90f, 0.03f, 0.25f, 0, 0, 1.0f, 0.10f, 0.78f, 0.95f}},
    {"breathe", {0.35f, 0.80f, 0.80f, 0.20f, 0.18f, 0, 0, 1.1f, 0.15f, 0.60f, 1.00f}},
    {"unwind", {-0.40f, 0.95f, 1.25f, 0.04f, 0.30f, 0, 0, 0.9f, 0.20f, 0.85f, 0.80f}},
    {"open", {0.80f, 1.00f, 0.45f, 0.05f, 0.30f, 0, 0, 1.2f, 0.05f, 0.70f, 1.00f}},
    {"curl", {1.10f, 0.58f, 1.70f, 0.05f, 0.40f, 0, 0, 0.9f, 0.30f, 0.55f, 1.00f}},
    {"drift", {0.45f, 0.75f, 1.00f, 0.04f, 0.25f, 14, 0, 1.0f, 0.10f, 0.85f, 0.85f}},
    {"shimmer", {0.30f, 0.88f, 1.10f, 0.03f, 0.25f, 0, 0.035f, 1.0f, 0.35f, 0.75f, 1.00f}},
};
const int IDLE_COUNT = sizeof IDLE / sizeof IDLE[0];

const Look LOOK_SETUP = {0.30f, 0.70f, 0.90f, 0.10f, 0.30f, 0, 0, 1.0f, 1.00f, 0.65f, 0.10f};
const Look LOOK_OFFLINE = {0.18f, 0.55f, 1.10f, 0.03f, 0.20f, 0, 0, 0.9f, 0.30f, 0.34f, 0.42f};
const Look LOOK_LISTENING = {1.60f, 0.45f, 1.80f, 0.08f, 1.20f, 0, 0, 1.2f, 0.15f, 1.00f, 0.55f};
const Look LOOK_THINKING = {4.60f, 0.78f, 1.30f, 0.05f, 0.90f, 0, 0.02f, 0.9f, 0.62f, 0.40f, 1.00f};
const Look LOOK_SPEAKING = {1.10f, 0.78f, 0.75f, 0.22f, 2.40f, 0, 0, 1.2f, 0.55f, 0.95f, 1.00f};
const Look LOOK_ERROR = {0.15f, 0.62f, 0.70f, 0.12f, 0.50f, 5, 0, 1.0f, 1.00f, 0.18f, 0.12f};

uint16_t *frame = nullptr;
Mode mode = Mode::Offline;
Look now = LOOK_OFFLINE, target = LOOK_OFFLINE;
int idleIndex = 0;
float idleRemaining = 0;
float phase = 0, pulsePhase = 0, wanderPhase = 0;
float level = -1;
float flash[ARMS * DOTS_PER_ARM];

float randomUnit() { return (esp_random() & 0xFFFF) / 65535.0f; }

uint16_t color565(float r, float g, float b) {
    const int ri = constrain((int)(r * 31.0f + 0.5f), 0, 31);
    const int gi = constrain((int)(g * 63.0f + 0.5f), 0, 63);
    const int bi = constrain((int)(b * 31.0f + 0.5f), 0, 31);
    return (uint16_t)((ri << 11) | (gi << 5) | bi);
}

void fillCircle(float cx, float cy, float radius, uint16_t color) {
    const int r = (int)ceilf(radius);
    const int x0 = (int)cx, y0 = (int)cy;
    const float r2 = radius * radius;
    for (int dy = -r; dy <= r; dy++) {
        const int y = y0 + dy;
        if (y < 0 || y >= SIZE) continue;
        const float span = r2 - dy * dy;
        if (span < 0) continue;
        const int half = (int)sqrtf(span);
        const int from = max(0, x0 - half), to = min(SIZE - 1, x0 + half);
        uint16_t *row = frame + y * SIZE;
        for (int x = from; x <= to; x++) row[x] = color;
    }
}

void pickIdle() {
    int next = idleIndex;
    while (next == idleIndex) next = esp_random() % IDLE_COUNT;
    idleIndex = next;
    idleRemaining = 7.0f + randomUnit() * 10.0f;
    target = IDLE[idleIndex].look;
}

}  // namespace

bool begin() {
    frame = (uint16_t *)heap_caps_malloc(SIZE * SIZE * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    return frame != nullptr;
}

void setMode(Mode next) {
    if (next == mode) return;
    mode = next;
    switch (mode) {
        case Mode::Setup: target = LOOK_SETUP; break;
        case Mode::Offline: target = LOOK_OFFLINE; break;
        case Mode::Idle: pickIdle(); break;
        case Mode::Listening: target = LOOK_LISTENING; break;
        case Mode::Thinking: target = LOOK_THINKING; break;
        case Mode::Speaking: target = LOOK_SPEAKING; break;
        case Mode::Error: target = LOOK_ERROR; break;
    }
}

void setLevel(float value) { level = value; }

const char *idleName() { return IDLE[idleIndex].name; }

const uint16_t *render(float dt) {
    if (mode == Mode::Idle) {
        idleRemaining -= dt;
        if (idleRemaining <= 0) pickIdle();
    }

    // Leaving idle should feel immediate; drifting between idle looks should not.
    const float rate = mode == Mode::Idle ? 1.2f : 5.0f;
    const float k = 1.0f - expf(-dt * rate);
    float *a = &now.spin;
    const float *b = &target.spin;
    for (size_t i = 0; i < sizeof(Look) / sizeof(float); i++) a[i] += (b[i] - a[i]) * k;

    phase += now.spin * dt;
    pulsePhase += now.pulseHz * 2.0f * PI * dt;
    wanderPhase += 0.6f * dt;

    // While speaking with a known loudness, the voice drives the size instead of a sine wave.
    const bool voiced = (mode == Mode::Speaking || mode == Mode::Listening) && level >= 0;
    const float cx = SIZE / 2 + now.wander * sinf(wanderPhase);
    const float cy = SIZE / 2 + now.wander * sinf(wanderPhase * 1.7f + 1.0f);

    memset(frame, 0, SIZE * SIZE * sizeof(uint16_t));
    for (int arm = 0; arm < ARMS; arm++) {
        // Outer dots first, so the bright inner ones are drawn on top.
        for (int i = DOTS_PER_ARM - 1; i >= 0; i--) {
            const float t = (i + 1) / (float)DOTS_PER_ARM;
            float &spark = flash[arm * DOTS_PER_ARM + i];
            if (now.sparkle > 0 && randomUnit() < now.sparkle) spark = 1.0f;
            spark *= 0.86f;

            const float swell = voiced ? now.pulse * level : now.pulse * sinf(pulsePhase - t * 3.0f);
            const float radius = MAX_RADIUS * now.radius * (1.0f + swell) * powf(t, 0.85f);
            const float angle = phase + arm * (2.0f * PI / ARMS) - now.twist * 2.0f * PI * t;
            const float glow = min(1.0f, (1.0f - 0.72f * t) + spark);
            fillCircle(cx + radius * cosf(angle), cy + radius * sinf(angle), now.dot * (1.4f + 4.2f * t),
                       color565(now.r * glow + spark * 0.5f, now.g * glow + spark * 0.5f, now.b * glow + spark * 0.5f));
        }
    }
    const float core = 7.0f + 3.0f * (voiced ? level : sinf(pulsePhase));
    fillCircle(cx, cy, core, color565(0.55f + now.r * 0.45f, 0.55f + now.g * 0.45f, 0.55f + now.b * 0.45f));
    return frame;
}

}  // namespace vortex
