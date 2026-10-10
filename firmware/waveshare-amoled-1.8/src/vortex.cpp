#include "vortex.h"
#include "icons.h"

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
    float wave;     // how far the arms sway from side to side, radians at the tip
    float tilt;     // how far the figure is tipped away, 0 flat on to about 0.6
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
    // The looks below also use `wave` and `tilt`; the ones above leave both at 0.
    {"galaxy", {0.60f, 0.95f, 1.15f, 0.03f, 0.25f, 0, 0.012f, 0.95f, 0.40f, 0.65f, 1.00f, 0, 0.55f}},
    {"tendril", {0.25f, 0.90f, 0.70f, 0.04f, 0.30f, 0, 0, 1.00f, 0.10f, 0.90f, 0.75f, 0.45f, 0}},
    {"bloom", {0.20f, 0.70f, 0.35f, 0.14f, 0.22f, 0, 0, 1.60f, 0.25f, 0.70f, 1.00f, 0, 0}},
    {"pinwheel", {1.40f, 0.92f, 0.18f, 0.03f, 0.30f, 0, 0, 0.80f, 0.10f, 0.80f, 1.00f, 0, 0}},
    {"deep", {0.28f, 0.66f, 1.40f, 0.10f, 0.15f, 8, 0, 1.15f, 0.10f, 0.40f, 1.00f, 0.20f, 0.25f}},
    {"orbit", {0.90f, 1.00f, 0.50f, 0.03f, 0.30f, 0, 0, 1.10f, 0.15f, 0.75f, 0.95f, 0, 0.45f}},
    {"sway", {0.10f, 0.85f, 0.95f, 0.05f, 0.20f, 0, 0, 1.00f, 0.20f, 0.85f, 0.90f, 0.70f, 0}},
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
float phase = 0, pulsePhase = 0, wanderPhase = 0, wavePhase = 0, tiltPhase = 0;
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

// One bit per idle look: set means the look may be picked. Never left empty.
uint32_t idleOn = 0xFFFFFFFFu;

bool idleAllowed(int index) { return (idleOn >> index) & 1u; }

void pickIdle() {
    int allowed = 0, only = 0;
    for (int i = 0; i < IDLE_COUNT; i++) {
        if (idleAllowed(i)) {
            allowed++;
            only = i;
        }
    }
    int next = idleIndex;
    // Never the same look twice in a row, unless it is the only one left on.
    if (allowed <= 1) next = only;
    else while (next == idleIndex || !idleAllowed(next)) next = esp_random() % IDLE_COUNT;
    idleIndex = next;
    idleRemaining = 7.0f + randomUnit() * 10.0f;
    target = IDLE[idleIndex].look;
}

// What the agent is doing while it thinks: the icon wanted (-1 for none), the one being drawn, and how far it has faded in.
int icon = -1, iconDrawn = -1;
float iconShown = 0;
// The style asked for, and the one being drawn, which stays while an icon fades out.
IconStyle iconStyle = IconStyle::Dots, iconDrawnStyle = IconStyle::Dots;
float flowPhase = 0;
// The frame goes to the panel unturned, so what has a top is turned here: a step right and a step down
// on the upright icon are (rightX, rightY) and (downX, downY) in the frame.
float rightX = 1, rightY = 0, downX = 0, downY = 1;

/** Draws the icon over the core's place with a round pen, `eye` bright. */
void drawIcon(float cx, float cy, float eye, float r, float g, float b) {
    if (iconDrawn < 0) return;
    const float unit = icons::SIZE * (1.0f + 0.04f * sinf(pulsePhase)) / 240.0f;  // POINTS are tenths of a 24 grid
    const uint16_t color = color565(r * eye, g * eye, b * eye);
    const uint8_t *at = icons::POINTS + icons::ICONS[iconDrawn].start;
    for (int stroke = 0; stroke < icons::ICONS[iconDrawn].strokes; stroke++) {
        const int count = *at++;
        for (int i = 0; i + 1 < count; i++) {
            const float ax = (at[i * 2] - 120) * unit, ay = (at[i * 2 + 1] - 120) * unit;
            const float bx = (at[i * 2 + 2] - 120) * unit, by = (at[i * 2 + 3] - 120) * unit;
            const float x0 = cx + ax * rightX + ay * downX, y0 = cy + ax * rightY + ay * downY;
            const float x1 = cx + bx * rightX + by * downX, y1 = cy + bx * rightY + by * downY;
            // A round pen is a dot set down every pixel or so along the line.
            const int steps = max(1, (int)(hypotf(x1 - x0, y1 - y0) / 1.2f));
            for (int k = 0; k <= steps; k++) {
                fillCircle(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps, icons::PEN / 2, color);
            }
        }
        at += count * 2;
    }
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

void setRotation(int degrees) {
    // How display.cpp turns a logical point onto the panel, for each rotation.
    switch (((degrees % 360) + 360) % 360) {
        case 90: rightX = 0, rightY = -1, downX = 1, downY = 0; break;
        case 180: rightX = -1, rightY = 0, downX = 0, downY = -1; break;
        case 270: rightX = 0, rightY = 1, downX = -1, downY = 0; break;
        default: rightX = 1, rightY = 0, downX = 0, downY = 1; break;
    }
}

void setIconStyle(const char *name) {
    iconStyle = name && !strcmp(name, "off") ? IconStyle::Off : name && !strcmp(name, "line") ? IconStyle::Line : IconStyle::Dots;
}

void setIcon(const char *name) {
    int found = -1;
    for (int i = 0; name && *name && i < icons::COUNT && found < 0; i++) {
        if (!strcmp(name, icons::ICONS[i].name)) found = i;
    }
    // The one on show stays drawn while it fades, so only a new one replaces it.
    if (found >= 0) iconDrawn = found;
    icon = found;
}

void setIdleOff(const char *names) {
    uint32_t on = 0;
    for (int i = 0; i < IDLE_COUNT; i++) {
        // A look is off when its whole name appears between commas, spaces aside.
        bool off = false;
        const size_t length = strlen(IDLE[i].name);
        for (const char *at = names ? names : ""; *at && !off;) {
            while (*at == ' ' || *at == ',') at++;
            const char *end = at;
            while (*end && *end != ',') end++;
            const char *last = end;
            while (last > at && last[-1] == ' ') last--;
            off = (size_t)(last - at) == length && !strncasecmp(at, IDLE[i].name, length);
            at = end;
        }
        if (!off) on |= 1u << i;
    }
    // With every look named there would be nothing to show: keep the first.
    idleOn = on ? on : 1u;
    if (mode == Mode::Idle && !idleAllowed(idleIndex)) pickIdle();
}

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

    // The icon is only ever there while thinking, and comes and goes quickly.
    const float wantIcon = mode == Mode::Thinking && icon >= 0 && iconStyle != IconStyle::Off ? 1.0f : 0.0f;
    iconShown += (wantIcon - iconShown) * (1.0f - expf(-dt * 6.0f));
    // Easing never quite arrives; close enough is there, or a speck of the core would stay for good.
    const float eye = iconShown < 0.01f ? 0.0f : iconShown > 0.985f ? 1.0f : iconShown;
    if (wantIcon > 0) iconDrawnStyle = iconStyle;
    const bool asDots = iconDrawnStyle == IconStyle::Dots && iconDrawn >= 0;
    // Drawn with a pen, the arms stand back from the centre to leave it room. Made of dots, the arms are the icon.
    const float hole = asDots ? 0.0f : icons::HOLE * eye;
    flowPhase += 5.0f * dt;
    // A dot shape breathes with the figure and sways a little, so it never sits still.
    const float shapeUnit = icons::SHAPE_SIZE / 240.0f * (1.0f + 0.05f * sinf(pulsePhase));  // SHAPES are tenths of a 24 grid
    const float sway = 0.07f * sinf(wavePhase), swayCos = cosf(sway), swaySin = sinf(sway);
    const uint8_t *shape = asDots ? icons::SHAPES[iconDrawn] : nullptr;
    const uint8_t *tint = asDots ? icons::TINTS[iconDrawn] : nullptr;
    const float shapeR = asDots ? (0.55f + now.r * 0.45f) * 0.6f + tint[0] / 255.0f * 0.4f : 0;
    const float shapeG = asDots ? (0.55f + now.g * 0.45f) * 0.6f + tint[1] / 255.0f * 0.4f : 0;
    const float shapeB = asDots ? (0.55f + now.b * 0.45f) * 0.6f + tint[2] / 255.0f * 0.4f : 0;

    phase += now.spin * dt;
    pulsePhase += now.pulseHz * 2.0f * PI * dt;
    wanderPhase += 0.6f * dt;
    wavePhase += 1.3f * dt;
    tiltPhase += 0.15f * dt;

    // While speaking with a known loudness, the voice drives the size instead of a sine wave.
    const bool voiced = (mode == Mode::Speaking || mode == Mode::Listening) && level >= 0;
    // Speech is already a big swing; the listening look pulses gently on its own, so it needs a bigger one to follow a voice.
    const float voiceSwell = mode == Mode::Listening ? 0.40f : now.pulse;
    const float cx = SIZE / 2 + now.wander * sinf(wanderPhase);
    const float cy = SIZE / 2 + now.wander * sinf(wanderPhase * 1.7f + 1.0f);

    // A tipped figure is squashed along one axis, and that axis turns slowly.
    const float axisCos = cosf(tiltPhase), axisSin = sinf(tiltPhase), squash = 1.0f - now.tilt;

    memset(frame, 0, SIZE * SIZE * sizeof(uint16_t));
    for (int arm = 0; arm < ARMS; arm++) {
        // Outer dots first, so the bright inner ones are drawn on top.
        for (int i = DOTS_PER_ARM - 1; i >= 0; i--) {
            const float t = (i + 1) / (float)DOTS_PER_ARM;
            float &spark = flash[arm * DOTS_PER_ARM + i];
            if (now.sparkle > 0 && randomUnit() < now.sparkle) spark = 1.0f;
            spark *= 0.86f;

            const float swell = voiced ? voiceSwell * level : now.pulse * sinf(pulsePhase - t * 3.0f);
            const float reach = MAX_RADIUS * now.radius * (1.0f + swell);
            const float radius = hole + max(0.0f, reach - hole) * powf(t, 0.85f);
            // The sway runs out along the arm like a wave, and is widest at the tip.
            const float angle = phase + arm * (2.0f * PI / ARMS) - now.twist * 2.0f * PI * t + now.wave * t * sinf(wavePhase - t * 7.0f);
            const float glow = min(1.0f, (1.0f - 0.72f * t) + spark);
            const float x = radius * cosf(angle), y = radius * sinf(angle);
            const float along = x * axisCos + y * axisSin, across = (y * axisCos - x * axisSin) * squash;
            float px = cx + along * axisCos - across * axisSin, py = cy + along * axisSin + across * axisCos;
            float size = now.dot * (1.4f + 4.2f * t);
            float red = now.r * glow + spark * 0.5f, green = now.g * glow + spark * 0.5f, blue = now.b * glow + spark * 0.5f;
            if (asDots && eye > 0) {
                // Each dot has a place on the icon: the arms take turns along its strokes. It goes there
                // by the straight way, and a wave of light runs along the strokes once it has arrived.
                const int n = i * ARMS + arm;
                const float ux = (shape[n * 2] - 120) * shapeUnit, uy = (shape[n * 2 + 1] - 120) * shapeUnit;
                const float ix = ux * swayCos - uy * swaySin, iy = ux * swaySin + uy * swayCos;
                // The frame goes to the panel unturned; the icon has a top.
                px += (SIZE / 2 + ix * rightX + iy * downX - px) * eye;
                py += (SIZE / 2 + ix * rightY + iy * downY - py) * eye;
                size += (icons::SHAPE_DOT - size) * eye;
                const float lit = 0.62f + 0.38f * sinf(flowPhase - n * 0.33f) + spark * 0.5f;
                red += (shapeR * lit - red) * eye;
                green += (shapeG * lit - green) * eye;
                blue += (shapeB * lit - blue) * eye;
            }
            fillCircle(px, py, size, color565(red, green, blue));
        }
    }
    const float core = 7.0f + (mode == Mode::Listening ? 6.0f : 3.0f) * (voiced ? level : sinf(pulsePhase));
    const float coreR = 0.55f + now.r * 0.45f, coreG = 0.55f + now.g * 0.45f, coreB = 0.55f + now.b * 0.45f;
    if (eye < 1.0f) fillCircle(cx, cy, core * (1.0f - eye), color565(coreR, coreG, coreB));
    // The icon takes the core's place and its colour.
    if (eye > 0.0f && !asDots) drawIcon(cx, cy, eye, coreR, coreG, coreB);
    return frame;
}

}  // namespace vortex
