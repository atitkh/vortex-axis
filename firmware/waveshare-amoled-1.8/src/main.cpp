// VorteX Axis client for the Waveshare ESP32-S3-Touch-AMOLED-1.8.
//
// The shared core (firmware/common) owns Wi-Fi, pairing and the socket and runs
// in its own task. This file only decides what to show: it turns the core's
// state into a face and a few lines of text, so the face keeps moving whatever
// the network is doing.
#include <Arduino.h>
#include "HWCDC.h"
#include "axis_client.h"
#include "display.h"
#include "vortex.h"

// This board's serial port is the chip's own USB, not a UART. Output on plain
// `Serial` goes nowhere unless this is used and ARDUINO_USB_CDC_ON_BOOT is set.
HWCDC USBSerial;

static const char *const CAPABILITIES[] = {"screen"};
static const axis::Identity IDENTITY = {"waveshare-amoled-1.8", CAPABILITIES, 1};

static const uint16_t COLOR_HEAD = 0xFFFF;
static const uint16_t COLOR_BODY = 0xA554;  // light grey
static const uint16_t COLOR_WARN = 0xFD20;  // amber
static const uint32_t FRAME_MS = 33;
// How long a finished exchange stays on screen before the face has it to itself again.
static const uint32_t KEEP_TEXT_MS = 15000;
// A brief gap while connecting is normal at boot; only call it a problem after this.
static const uint32_t UNREACHABLE_AFTER_MS = 5000;
static const int MAX_BODY_LINES = 8;

static axis::Client client;
static axis::Snapshot state;
static uint32_t seenRevision = 0, seenSettings = UINT32_MAX;
static uint32_t idleSince = 0, connectingSince = 0;

// What is on the panel now, so only lines that changed are sent again.
static String shownHead, shownBody[MAX_BODY_LINES];
static uint16_t shownHeadColor = 0;
static bool redrawAll = true;

static int faceTop() { return display::height() > display::width() ? 20 : 0; }
static int headTop() { return faceTop() + vortex::SIZE + 4; }
static int bodyTop() { return headTop() + display::lineHeight(3); }
static int bodyLines() { return min(MAX_BODY_LINES, (display::height() - bodyTop()) / display::lineHeight(2)); }

static void applySettings() {
    display::setRotation((int)client.settingInt("rotation", 90));
    display::setBrightness((uint8_t)constrain(client.settingInt("brightness", 200), 10, 255));
    redrawAll = true;
}

/** Breaks text into lines at spaces. When it does not fit, the END is kept, so a growing reply stays readable. */
static int wrap(const String &text, String *lines, int maxLines) {
    const int width = display::lineChars(2);
    String all[32];
    int count = 0;
    int start = 0;
    const int length = text.length();
    while (start < length && count < 32) {
        while (start < length && (text[start] == ' ' || text[start] == '\n')) start++;
        if (start >= length) break;
        int end = min(length, start + width);
        const int newline = text.indexOf('\n', start);
        if (newline >= 0 && newline < end) {
            end = newline;
        } else if (end < length) {
            const int space = text.lastIndexOf(' ', end);
            if (space > start) end = space;
        }
        all[count++] = text.substring(start, end);
        start = end;
    }
    const int skip = max(0, count - maxLines);
    for (int i = skip; i < count; i++) lines[i - skip] = all[i];
    return count - skip;
}

static void show(const String &head, uint16_t headColor, const String &body) {
    if (redrawAll || head != shownHead || headColor != shownHeadColor) {
        display::textLine(headTop(), 3, headColor, head);
        shownHead = head;
        shownHeadColor = headColor;
    }
    String lines[MAX_BODY_LINES];
    const int rows = bodyLines();
    wrap(body, lines, rows);
    for (int i = 0; i < rows; i++) {
        if (!redrawAll && lines[i] == shownBody[i]) continue;
        display::textLine(bodyTop() + i * display::lineHeight(2), 2, COLOR_BODY, lines[i]);
        shownBody[i] = lines[i];
    }
    redrawAll = false;
}

/** Turns the core's state into a face mode and the text under it. */
static void present() {
    using axis::Link;
    using axis::Turn;
    using vortex::Mode;
    const uint32_t now = millis();
    if (state.link != Link::Connecting) connectingSince = 0;

    switch (state.link) {
        case Link::Starting:
            vortex::setMode(Mode::Offline);
            return show("Starting", COLOR_HEAD, "");
        case Link::Setup:
            vortex::setMode(Mode::Setup);
            return show("Set me up", COLOR_WARN,
                        "Join the Wi-Fi network " + state.setupNetwork + "\nthen open http://" + state.address +
                            (state.note.isEmpty() ? "" : "\n" + state.note));
        case Link::WifiConnecting:
            vortex::setMode(Mode::Offline);
            return show("Joining Wi-Fi", COLOR_HEAD, state.note);
        case Link::Unpaired:
            vortex::setMode(Mode::Setup);
            return show("Not paired", COLOR_WARN,
                        (state.note.isEmpty() ? String("") : state.note + "\n") + "Open http://" + state.address +
                            "\nand paste a setup string from the Axis admin page");
        case Link::Pairing:
            vortex::setMode(Mode::Offline);
            return show("Pairing", COLOR_HEAD, state.note);
        case Link::Connecting:
            vortex::setMode(Mode::Offline);
            if (!connectingSince) connectingSince = now;
            if (now - connectingSince < UNREACHABLE_AFTER_MS) return show("Connecting", COLOR_HEAD, "");
            return show("Can't reach Axis", COLOR_WARN, "Trying again every few seconds");
        case Link::Online:
            break;
    }

    if (state.turn != Turn::Idle) idleSince = 0;
    switch (state.turn) {
        case Turn::Listening:
            vortex::setMode(Mode::Listening);
            return show("Listening", COLOR_HEAD, "");
        case Turn::Transcribing:
        case Turn::Thinking:
            vortex::setMode(Mode::Thinking);
            return show("Thinking", COLOR_HEAD, state.transcript);
        case Turn::Speaking:
            vortex::setMode(Mode::Speaking);
            return show("", COLOR_HEAD, state.reply);
        case Turn::Error:
            vortex::setMode(Mode::Error);
            return show("Problem", COLOR_WARN, state.note);
        case Turn::Idle:
            break;
    }

    vortex::setMode(Mode::Idle);
    if (!idleSince) idleSince = now;
    // Say which service is down, so a failed request is not a mystery.
    const char *down = !state.openclawUp ? "The agent is down" : !state.sttUp ? "Hearing is down" : !state.ttsUp ? "Voice is down" : nullptr;
    const bool keep = now - idleSince < KEEP_TEXT_MS && !state.reply.isEmpty();
    show(down ? down : "", COLOR_WARN, keep ? state.reply : String(""));
}

void setup() {
    USBSerial.begin(115200);
    delay(500);  // do not wait on the port itself: it never reports "connected" on this chip
    USBSerial.printf("\n[boot] VorteX Axis client %s, protocol %d\n", AXIS_FIRMWARE_VERSION, AXIS_PROTOCOL_VERSION);

    const bool displayOk = display::begin();
    const bool faceOk = vortex::begin();
    USBSerial.printf("[boot] display %s, face buffer %s, heap %u, psram %u\n", displayOk ? "started" : "FAILED",
                     faceOk ? "ok" : "FAILED", (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
    if (!faceOk) {
        display::textLine(100, 2, COLOR_WARN, "No memory for the face");
        for (;;) delay(1000);
    }

    client.begin(IDENTITY, &USBSerial);
    applySettings();
}

void loop() {
    static uint32_t lastFrame = 0, lastText = 0, lastReport = 0, frames = 0, drawMicros = 0, renderMicros = 0;
    const uint32_t started = millis();
    if (started - lastFrame < FRAME_MS) return delay(1);
    const float seconds = lastFrame ? (started - lastFrame) / 1000.0f : 0.033f;
    lastFrame = started;

    const bool changed = client.revision() != seenRevision;
    if (changed) {
        state = client.snapshot();
        seenRevision = state.revision;
        if (state.settingsRevision != seenSettings) {
            seenSettings = state.settingsRevision;
            applySettings();
        }
    }
    // Text also depends on time (messages that expire), so it is rechecked a few times a second.
    if (changed || started - lastText > 250) {
        lastText = started;
        present();
    }

    const uint32_t t0 = micros();
    const uint16_t *frame = vortex::render(min(seconds, 0.1f));
    renderMicros += micros() - t0;
    display::blitSquare((display::width() - vortex::SIZE) / 2, faceTop(), vortex::SIZE, frame);
    drawMicros += micros() - t0;
    frames++;

    if (started - lastReport >= 15000) {
        USBSerial.printf("[run] up %lus, %.1f fps, %.1f ms per frame (%.1f drawing it), idle look \"%s\", heap %u (low %u)\n",
                         (unsigned long)(started / 1000), frames * 1000.0f / (started - lastReport),
                         drawMicros / 1000.0f / max(1u, (unsigned)frames), renderMicros / 1000.0f / max(1u, (unsigned)frames),
                         vortex::idleName(), (unsigned)ESP.getFreeHeap(),
                         (unsigned)ESP.getMinFreeHeap());
        lastReport = started;
        frames = 0;
        drawMicros = 0;
        renderMicros = 0;
    }
}
