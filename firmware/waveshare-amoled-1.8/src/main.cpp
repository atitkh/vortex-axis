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
#include "mic.h"
#include "speaker.h"
#include "imu.h"
#include "touch.h"
#include "vortex.h"
#include <JPEGDEC.h>
#include "glow.h"
#include <esp_heap_caps.h>

// This board's serial port is the chip's own USB, not a UART. Output on plain
// `Serial` goes nowhere unless this is used and ARDUINO_USB_CDC_ON_BOOT is set.
HWCDC USBSerial;
// Everything printed here also goes into a memory buffer the device serves at /logs.
static axis::LogBuffer logOut(USBSerial);

static const char *const CAPABILITIES[] = {"screen", "speaker", "mic", "image-frames"};
// What the Axis admin page offers for this board. Keep in step with applySettings() and the
// client core's vadLimits(): a key listed here that nothing reads does nothing.
static const axis::SettingDef SETTINGS[] = {
    {"autoRotate", "Turn with the device", "toggle", "Screen", "The picture follows whichever way up the device is standing. Lying flat, it stays as it was.", "1", 0, 0, nullptr, nullptr},
    {"rotation", "Screen rotation", "choice", "Screen", "Used when turning with the device is off, and until the device knows which way up it is.", "90", 0, 0, "degrees", "0,90,180,270"},
    {"brightness", "Brightness", "number", "Screen", nullptr, "200", 10, 255, nullptr, nullptr},
    {"textSize", "Text size", "choice", "Screen", "Size of the words and buttons; the face stays the same size.", "medium", 0, 0, nullptr, "small,medium,large"},
    {"maxFps", "Frame rate limit", "choice", "Screen", "The most frames a second the screen draws. Higher is smoother but keeps the processor and the panel bus busier; the face and the glow cannot go faster than the board manages anyway.", "30", 0, 0, nullptr, "20,30,45,60"},
    {"idleFace", "Idle face size", "choice", "Screen", "How big the face is with the screen to itself. With words, a question or a timer to show it shrinks to its normal size at the top.", "large", 0, 0, nullptr, "normal,large,max"},
    {"screenOffset", "Picture offset", "number", "Screen", "Slides the picture sideways across the panel. Boards of different revisions need different values. Use the \"Show screen edges\" action: all four sides of the frame should be visible, with the cross in the middle.", "16", 0, 40, "pixels", nullptr},
    {"volume", "Volume", "number", "Sound", "The microphone clips on the board's own voice above about 50.", "60", 0, 100, "%", nullptr},
    {"listenCue", "Listening cue", "toggle", "Sound", "A short rising tone when it starts listening after a wake word or a tap.", "1", 0, 0, nullptr, nullptr},
    {"taskChime", "Task chime", "toggle", "Sound", "Two soft notes when an agent's long task finishes. Never in quiet hours.", "1", 0, 0, nullptr, nullptr},
    {"wakeListen", "Wake word", "toggle", "Listening", "Off leaves tap-to-talk as the only way in.", "1", 0, 0, nullptr, nullptr},
    {"wakeSense", "Wake word cutoff", "number", "Listening", "Lower wakes more easily but also by mistake. 0 uses the model's own (87).", "0", 0, 99, "%", nullptr},
    {"bargeIn", "Wake word interrupts speech", "toggle", "Listening", "Experimental, off by default. With echo cancelling the device takes about 20 dB of its own voice out at moderate volume and about 10 dB when loud, which is not enough to stop it waking on its own speech. Tap to interrupt.", "0", 0, 0, nullptr, nullptr},
    {"echoCancel", "Echo cancelling", "toggle", "Listening", "Only used when the wake word may interrupt speech: takes the device's own voice out of what the microphone hears while it talks, and turns the microphone down so the speaker does not overload it.", "1", 0, 0, nullptr, nullptr},
    {"followUpMs", "Follow-up listening", "number", "Listening", "After a spoken answer, keep listening this long without the wake word. 0 turns it off.", "6000", 0, 30000, "ms", nullptr},
    {"onsetMs", "Wait for the first word", "number", "Listening", "How long to wait for you to start talking after a wake or a tap.", "6000", 1000, 20000, "ms", nullptr},
    {"silenceMs", "Quiet that ends a sentence", "number", "Listening", nullptr, "900", 300, 5000, "ms", nullptr},
    {"maxSpeechMs", "Longest sentence", "number", "Listening", nullptr, "20000", 3000, 60000, "ms", nullptr},
    {"glowCorner", "Glow corner curve", "number", "Screen", "How round the edge glow turns the corners. Raise it until the corners show as a smooth curve.", "56", 12, 120, "pixels", nullptr},
    {"timerGlow", "Timer countdown glow", "toggle", "Screen", "In a timer's last ten seconds, a red glow runs round the screen's edges and shrinks as the time runs out, beating once a second.", "1", 0, 0, nullptr, nullptr},
    {"handsGlow", "Computer in use glow", "toggle", "Screen", "A rose glow along the edges while an agent is using a computer near this device (looking, clicking, typing).", "1", 0, 0, nullptr, nullptr},
    {"notifyGlow", "Notification light", "toggle", "Screen", "While the device is idle: an amber glow along the edges while a task waits for you, a blue one while a question waits for you on another device, and a green flash when a task finishes.", "1", 0, 0, nullptr, nullptr},
    {"roomSound", "Room sound to Axis", "toggle", "Home Assistant", "How loud the room is, every few seconds, and whether there is sound in it, for Home Assistant. Levels only, never audio; the device's own speech is left out.", "1", 0, 0, nullptr, nullptr},
    {"gestures", "Gestures to Axis", "toggle", "Home Assistant", "A hold or a swipe on the screen goes to Axis, which hands it to Home Assistant as an event to automate. A tap still talks.", "1", 0, 0, nullptr, nullptr},
};
static const axis::ActionDef ACTIONS[] = {
    {"cue", "Play listening cue", "The tone it plays when it starts listening.", false},
    {"chime", "Play chime", "The two-note boot chime.", false},
    {"talk", "Start listening", "Same as tapping the screen while idle.", false},
    {"mic", "Microphone levels", "Room level, speech threshold and wake word statistics.", false},
    {"find", "Find this device", "Chimes three times and flashes the screen's edges white for eight seconds, to tell which device is which.", false},
    {"edges", "Show screen edges", "Draws a frame along the edges of the screen for ten seconds, to set the picture offset by.", false},
    {"motion", "Which way up", "Gravity along the board's axes in thousandths of g, and the rotation it calls for.", false},
};
static const axis::Identity IDENTITY = {"waveshare-amoled-1.8", CAPABILITIES, 4, SETTINGS, sizeof SETTINGS / sizeof SETTINGS[0],
                                        ACTIONS, sizeof ACTIONS / sizeof ACTIONS[0]};

static const uint16_t COLOR_HEAD = 0xFFFF;
static const uint16_t COLOR_BODY = 0xA554;  // light grey
static const uint16_t COLOR_WARN = 0xFD20;  // amber
static const uint16_t COLOR_LISTEN = 0x4FEA;  // soft green, as the listening face
// The longest the screen loop waits between frames: the `maxFps` setting (30 by default; 60 is the ceiling, and a frame that takes longer than this still sets the pace).
static uint32_t FRAME_MS = 33;
// How long a finished exchange stays on screen before the face has it to itself again.
static const uint32_t KEEP_TEXT_MS = 15000;
// A brief gap while connecting is normal at boot; only call it a problem after this.
static const uint32_t UNREACHABLE_AFTER_MS = 5000;
static const int MAX_BODY_LINES = 8;


// ---- diagnostics: `probe HZ RATE [pause]` ------------------------------------------------
static volatile bool facePaused = false;

static float goertzelDb(const float *x, size_t n, float hz) {
    const float w = 2.0f * PI * hz / 16000.0f, c = 2.0f * cosf(w);
    float s1 = 0, s2 = 0;
    for (size_t i = 0; i < n; i++) {
        const float s = x[i] + c * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    const float power = s1 * s1 + s2 * s2 - c * s1 * s2;
    return 10.0f * log10f(power + 1e-9f);
}

/**
 * Plays a tone through the same path speech takes (so the resampler is included) and listens
 * to it with the microphone, then prints what the microphone heard: the strongest frequencies
 * and, around the tone, the sidebands a display or power-supply buzz would leave.
 */
static void probe(int hz, int rate, bool pauseFace) {
    const size_t total = 32000, from = 6400, n = 16000;  // record 2 s, analyse the middle second
    int16_t *rec = (int16_t *)heap_caps_malloc(total * sizeof(int16_t), MALLOC_CAP_SPIRAM);
    float *x = (float *)heap_caps_malloc(n * sizeof(float), MALLOC_CAP_SPIRAM);
    if (!rec || !x) {
        logOut.println("[probe] no memory");
        return;
    }
    facePaused = pauseFace;
    mic::capture(rec, total);
    if (hz > 0) {
        axis::AudioSink *sink = speaker::sink();
        sink->streamBegin(rate);
        static int16_t chunk[2400];
        float phase = 0;
        const float step = 2.0f * PI * hz / rate;
        for (int done = 0; done < rate * 16 / 10; done += 2400) {
            for (int i = 0; i < 2400; i++, phase += step) chunk[i] = (int16_t)(12000.0f * sinf(phase));
            sink->streamWrite((const uint8_t *)chunk, sizeof chunk);
        }
        sink->streamEnd();
    }
    const uint32_t until = millis() + 4000;
    while (!mic::captureDone() && millis() < until) delay(10);
    delay(300);
    facePaused = false;
    for (size_t i = 0; i < n; i++) {
        const float w = 0.5f - 0.5f * cosf(2.0f * PI * i / (n - 1));
        x[i] = rec[from + i] * w;
    }
    double sq = 0;
    for (size_t i = 0; i < n; i++) sq += (double)rec[from + i] * rec[from + i];
    logOut.printf("[probe] %d Hz at %d Hz rate, face %s: heard rms %.0f\n", hz, rate, pauseFace ? "paused" : "running", sqrt(sq / n));
    // Coarse spectrum, 100 Hz steps, strongest few.
    float db[80];
    float best = -1e9f;
    for (int k = 1; k < 80; k++) {
        db[k] = goertzelDb(x, n, k * 100.0f);
        best = max(best, db[k]);
    }
    float floorDb = 1e9f;
    for (int k = 1; k < 80; k++) floorDb = min(floorDb, db[k]);
    String top;
    for (int pick = 0; pick < 6; pick++) {
        int at = 1;
        for (int k = 1; k < 80; k++) if (db[k] > db[at]) at = k;
        top += String(at * 100) + "Hz:" + String(db[at] - best, 0) + " ";
        db[at] = -1e9f;
    }
    logOut.printf("[probe] strongest (dB vs peak): %s| quietest bin %.0f dB\n", top.c_str(), floorDb - best);
    if (hz > 0) {
        const float peak = goertzelDb(x, n, hz);
        String side;
        const int offsets[] = {-120, -100, -60, -50, -33, -30, -20, 20, 30, 33, 50, 60, 100, 120};
        for (int o : offsets) side += String(o) + ":" + String(goertzelDb(x, n, hz + o) - peak, 0) + " ";
        const float h2 = goertzelDb(x, n, hz * 2.0f) - peak, h3 = goertzelDb(x, n, hz * 3.0f) - peak;
        logOut.printf("[probe] around %d Hz (dB vs tone, offsets in Hz): %s| 2nd harmonic %.0f, 3rd %.0f\n", hz, side.c_str(), h2, h3);
    }
    heap_caps_free(rec);
    heap_caps_free(x);
}

static axis::Client client;
static axis::Snapshot state;
static uint32_t seenRevision = 0, seenSettings = UINT32_MAX;
static uint32_t idleSince = 0, connectingSince = 0;

// What should be on the panel, and what is there now, so only lines that changed are sent again.
static String wantHead, wantBody;
static uint16_t wantHeadColor = 0;
static String shownHead, shownBody[MAX_BODY_LINES];
static uint16_t shownHeadColor = 0;
static bool redrawAll = true;
// A thin bar under the head, in thousandths; -1 for none.
static int wantBar = -1, shownBar = -1;
static uint16_t wantBarColor = 0, shownBarColor = 0;
// Lines that take the place of the body text, each in its own colour: the steps of an agent's task.
static String wantList[MAX_BODY_LINES];
static uint16_t wantListColor[MAX_BODY_LINES];
static int wantListCount = 0;
// While this is in the future the steps of the agent's task are listed under its line.
static uint32_t stepsOpenUntil = 0;
static const uint32_t STEPS_OPEN_MS = 20000;
static uint8_t seenChimes = 0;
static const uint16_t COLOR_DIM = 0x528A;   // steps already behind
static const uint16_t COLOR_OTHER = 0x7BEF; // the other tasks in the list
static const uint16_t COLOR_BAR = 0x6EBD;   // the idle face's cyan
static const uint16_t COLOR_DONE = 0x57EA;  // green
// The face's place and size. With the screen to itself it sits in the middle at the idleFace setting's size; with text,
// a question or a timer it is TEXT_FACE (vortex::SIZE) at the top. Between the two it slides and grows or shrinks at
// once, over MOVE_MS. faceY is -1 until it has been placed, which puts it where it should be at once.
static const int TEXT_FACE = vortex::SIZE;
// normal, large and max: at its widest (the "open" look) the figure stays 54 pixels from the nearest edge of the glass at
// 264 and 42 at 288, against 66 at 240 (`fps` on the console says how close it came).
static const int IDLE_FACES[] = {TEXT_FACE, 264, vortex::MAX_SIZE};
static int idleFace = IDLE_FACES[1];
static int faceY = -1, faceSide = TEXT_FACE;
static int fromY = 0, fromSide = TEXT_FACE, toY = -1, toSide = TEXT_FACE;
static uint32_t moveStarted = 0;
// Where the face was last sent (or would have been, when it is not drawn). Text goes on screen only once the face has
// been sent at its place: that frame blacks out what the one before it left, which would otherwise wipe new text.
static int sentFaceY = -1, sentFaceSide = 0;
static const uint32_t MOVE_MS = 300;
// The console's `still`: the face is drawn and sent as usual but does not move, so `shot held` shows what the panel holds without tearing.
static volatile bool faceStill = false;
// Time the face has been held still for, which the face's moves (moveFace) leave out, so a move can be caught half done.
static uint32_t stillMs = 0;
// The notification light: when the last task finish was seen, the flash's end, and whether a glow is up.
static uint8_t seenTaskState = 0;
static uint32_t doneFlashUntil = 0;
static bool noticeShown = false;
static const uint32_t DONE_FLASH_MS = 1500;
// "Find this device": until when the edges flash white, and how many of its chimes are still to come.
static uint32_t findUntil = 0;
static uint8_t findChimes = 0;
static const uint32_t FIND_MS = 8000, FIND_CHIME_EVERY_MS = 2600;
// One kind of glow shown for a few seconds from the admin page's preview, with the corner curve being tried there.
static glow::State previewKind = glow::State::None;
static uint32_t previewFrom = 0, previewMs = 0;
// Commands arrive on the client's task, on the other core, at any point in a frame. They only leave a
// request here; the screen loop starts it on its own clock, so a start time is never later than the
// frame's (that wrapped the elapsed time round and cancelled the glow before it was drawn).
struct GlowRequest {
    glow::State kind;
    uint32_t ms;
    int corner;
};
static portMUX_TYPE requestLock = portMUX_INITIALIZER_UNLOCKED;
static GlowRequest glowRequest;
static uint32_t glowRequests = 0, findRequests = 0;  // counted up under requestLock
/** How long before a timer is due its countdown glow starts. */
static const int32_t TIMER_GLOW_MS = 10000;
static bool hasSpeaker = false, hasMic = false;

// A question with choices: the face stays, the question goes under it and the choices are buttons below.
static bool askShown = false;
// What an admin switched off on the Axis admin page (the capabilitiesOff setting): usually nothing.
static bool screenOff = false, speakerOff = false, micOff = false;
// The panel has been blanked for screenOff; drawing starts again from nothing once it is back.
static bool screenBlanked = false;
// The console's `set textSize <size>`, `set idleFace <size>` and `set maxFps <n>`: stand in for those settings on the bench. Empty: the setting.
static char textSizeTest[16] = "";
static char idleFaceTest[16] = "";
static char maxFpsTest[8] = "";
// The console's `set rotation <degrees>`: the screen turned that way whatever the device says, for trying each way up on
// the bench. -1: as the settings and the motion sensor say.
static volatile int rotationTest = -1;
// The console's `set idleLook <name>`: only that idle look, for measuring one look at a time. Empty: the idleLooksOff setting.
static char idleLookTest[16] = "";
static volatile uint32_t textSizeRequests = 0;

/** True when `name` is one of the names, separated by commas, in `list`. */
static bool listed(const String &list, const char *name) {
    int from = 0;
    while (from < (int)list.length()) {
        int comma = list.indexOf(',', from);
        if (comma < 0) comma = list.length();
        String item = list.substring(from, comma);
        item.trim();
        if (item == name) return true;
        from = comma + 1;
    }
    return false;
}
static String askDrawn;
static bool askDrawnListening = false;
static const uint16_t COLOR_PILL = 0x1CCA;  // the listening face's mint, dimmed
static String timerLine(uint32_t now);
static String taskLine();
static void listSteps();

/** Where the face sits while there is text under it. */
static int faceTop() { return display::height() > display::width() ? 20 : 0; }
/** Where a face `side` wide sits when it has the screen to itself. Even, as is its left edge, like the round board's. */
static int faceMiddle(int side) { return ((display::height() - side) / 2) & ~1; }
static int faceLeft(int side = faceSide) { return ((display::width() - side) / 2) & ~1; }
static int headTop() { return faceTop() + TEXT_FACE + 4; }

/**
 * Takes the face towards top `y` at size `side`: at once when it has not been placed, otherwise both together over
 * MOVE_MS, eased in and out. A new target on the way starts from where it is. True once it is there.
 */
static bool moveFace(int y, int side) {
    const uint32_t now = millis() - stillMs;
    if (faceY < 0) {
        // Placed at once: everything round it was just cleared.
        faceY = toY = sentFaceY = y;
        faceSide = toSide = sentFaceSide = side;
        return true;
    }
    if (y != toY || side != toSide) {
        fromY = faceY;
        fromSide = faceSide;
        toY = y;
        toSide = side;
        moveStarted = now;
    }
    if (faceY == toY && faceSide == toSide) return sentFaceY == toY && sentFaceSide == toSide;
    const float t = min(1.0f, (now - moveStarted) / (float)MOVE_MS);
    const float k = t * t * (3.0f - 2.0f * t);
    // Even, as on the round board.
    faceY = t >= 1.0f ? toY : (fromY + (int)lroundf((toY - fromY) * k)) & ~1;
    faceSide = t >= 1.0f ? toSide : (fromSide + (int)lroundf((toSide - fromSide) * k)) & ~1;
    return false;
}
static int bodyTop() { return headTop() + display::lineHeight(3); }
static int bodyLines() { return min(MAX_BODY_LINES, (display::height() - bodyTop()) / display::lineHeight(2)); }

/** The rotation in force: the way the device is standing when it turns with it and knows, the setting otherwise. */
static int wantedRotation() {
    if (rotationTest >= 0) return rotationTest;
    const int standing = client.settingInt("autoRotate", 1) != 0 ? imu::orientation() : -1;
    return standing >= 0 ? standing : (int)client.settingInt("rotation", 90);
}

// While this is in the future the screen shows only a frame along its edges.
static uint32_t edgesUntil = 0;
static bool edgesDrawn = false;
// Console `shot` requests, counted up on the client's task and taken on the screen loop.
static volatile uint32_t shotRequests = 0;
// The console's `fps`: the frame rate since the last time it was asked, printed by the screen loop.
static volatile uint32_t fpsRequests = 0;
static uint32_t fpsFrames = 0, fpsDrawMicros = 0, fpsFaceMicros = 0, fpsGlowMicros = 0;

// ---- pictures from agent replies ---------------------------------------------------------
// One has the screen to itself, centred on black, until 30 s after the device stops speaking. A tap
// closes it (and only closes it); so does the person actually saying something (a new turn), a question,
// or the edge frame. Listening for a follow-up, thinking and speaking show as a glow along the edges.
static const uint32_t PICTURE_MS = 30000;
static uint32_t pictureUntil = 0;
static uint16_t *pictureFrame = nullptr;
static int pictureW = 0, pictureH = 0, pictureX = 0, pictureY = 0, jpegW = 0, jpegH = 0;

static int pictureBlock(JPEGDRAW *d) {
    // Blocks at the right and bottom edges can be wider than the picture; only the picture is copied.
    const int cols = min(d->iWidth, min(jpegW - d->x, pictureW - (pictureX + d->x)));
    for (int row = 0; row < d->iHeight && cols > 0; row++) {
        const int y = pictureY + d->y + row;
        if (d->y + row >= jpegH || y >= pictureH) break;
        memcpy(pictureFrame + y * pictureW + pictureX + d->x, d->pPixels + row * d->iWidth, cols * sizeof(uint16_t));
    }
    return 1;
}

/** Decodes a JPEG and puts it on the screen. False when it could not be read. */
static bool showPicture(const uint8_t *data, size_t size) {
    static JPEGDEC jpeg;
    pictureW = display::width();
    pictureH = display::height();
    if (!pictureFrame) pictureFrame = (uint16_t *)heap_caps_malloc(pictureW * pictureH * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    if (!pictureFrame) return false;
    if (!jpeg.openRAM((uint8_t *)data, (int)size, pictureBlock)) return false;
    jpegW = jpeg.getWidth();
    jpegH = jpeg.getHeight();
    pictureX = max(0, (pictureW - jpegW) / 2);
    pictureY = max(0, (pictureH - jpegH) / 2);
    memset(pictureFrame, 0, pictureW * pictureH * sizeof(uint16_t));
    jpeg.setPixelType(RGB565_LITTLE_ENDIAN);
    const bool ok = jpeg.decode(0, 0, 0);
    jpeg.close();
    if (!ok) return false;
    display::blitScreen(pictureFrame);
    glow::reset();
    pictureUntil = millis() + PICTURE_MS;
    if (!pictureUntil) pictureUntil = 1;
    return true;
}

static void applySettings() {
    const String off = client.setting("capabilitiesOff");
    screenOff = listed(off, "screen");
    speakerOff = listed(off, "speaker");
    micOff = listed(off, "mic");
    client.setOff(micOff, speakerOff);
    // A recording under way when the microphone is switched off goes nowhere.
    if (micOff && client.listening()) client.stopListening(true);
    display::setColumnOffset((int)client.settingInt("screenOffset", 16));
    edgesDrawn = false;
    display::setRotation(wantedRotation());
    vortex::setRotation(wantedRotation());
    display::setBrightness(screenBlanked ? 0 : (uint8_t)constrain(client.settingInt("brightness", 200), 10, 255));
    // A new text size moves every line and button, so the screen is cleared and laid out again.
    const String size = textSizeTest[0] ? String(textSizeTest) : client.setting("textSize", "medium");
    if (display::setTextSize(size == "small" ? 0 : size == "large" ? 2 : 1)) {
        display::clear();
        askDrawn = "";
    }
    const long fps = constrain(maxFpsTest[0] ? atol(maxFpsTest) : client.settingInt("maxFps", 30), 15, 60);
    FRAME_MS = (uint32_t)(1000 / fps);
    // The idle face's size; the face goes there by itself (layout) when it has the screen to itself.
    const String face = idleFaceTest[0] ? String(idleFaceTest) : client.setting("idleFace", "large");
    idleFace = IDLE_FACES[face == "normal" ? 0 : face == "max" ? 2 : 1];
    glow::setCorner((int)client.settingInt("glowCorner", 56));
    speaker::setVolume(speakerOff ? 0 : (int)client.settingInt("volume", 60));
    if (idleLookTest[0]) {
        // Every other look off (vortex.cpp's IDLE names).
        static const char *const LOOKS[] = {"calm", "breathe", "unwind", "open", "curl", "drift", "shimmer", "galaxy", "tendril", "bloom", "pinwheel", "deep", "orbit", "sway"};
        String off;
        for (const char *look : LOOKS) if (strcmp(look, idleLookTest)) off += String(look) + ",";
        vortex::setIdleOff(off.c_str());
    } else {
        vortex::setIdleOff(client.setting("idleLooksOff").c_str());
    }
    vortex::setIconStyle(client.setting("toolIcons").c_str());
    vortex::setIconTuning((int)client.settingInt("toolIconMs", 700), (int)client.settingInt("toolIconDots", 78));
    mic::setWakeEnabled(!micOff && client.settingInt("wakeListen", 1) != 0);
    mic::setWakeSensitivity((uint8_t)constrain(client.settingInt("wakeSense", 0), 0, 99));
    mic::setBargeIn(client.settingInt("bargeIn", 0) != 0);
    mic::setEchoCancel(client.settingInt("echoCancel", 1) != 0);
    redrawAll = true;
}

/** Breaks text into lines that fit the screen, at spaces. When there are too many, the END is kept, so a growing reply stays readable. */
static int wrap(const String &text, String *lines, int maxLines) {
    const int room = display::width() - 12;
    String all[32];
    int count = 0;
    String line;
    const int length = text.length();
    int at = 0;
    auto push = [&]() {
        if (count == 32) {
            // Full: drop the oldest line, since it is the end that matters.
            for (int i = 1; i < 32; i++) all[i - 1] = all[i];
            count = 31;
        }
        all[count++] = line;
        line = "";
    };
    while (at < length) {
        if (text[at] == '\n') {
            if (!line.isEmpty()) push();
            at++;
            continue;
        }
        if (text[at] == ' ') {
            at++;
            continue;
        }
        int end = at;
        while (end < length && text[end] != ' ' && text[end] != '\n') end++;
        String word = text.substring(at, end);
        at = end;
        // A word wider than the screen is cut where it stops fitting.
        while (display::textWidth(2, word) > room && word.length() > 1) {
            int fit = word.length() - 1;
            while (fit > 1 && display::textWidth(2, word.substring(0, fit)) > room) fit--;
            if (!line.isEmpty()) push();
            line = word.substring(0, fit);
            push();
            word = word.substring(fit);
        }
        const String joined = line.isEmpty() ? word : line + " " + word;
        if (display::textWidth(2, joined) <= room) {
            line = joined;
        } else {
            push();
            line = word;
        }
    }
    if (!line.isEmpty()) push();
    const int skip = max(0, count - maxLines);
    for (int i = skip; i < count; i++) lines[i - skip] = all[i];
    return count - skip;
}

static void show(const String &head, uint16_t headColor, const String &body) {
    wantHead = display::plain(head);
    wantHeadColor = headColor;
    wantBody = display::plain(body);
    wantBar = -1;
    wantListCount = 0;
}

/**
 * Places the face and draws the text. With nothing to say the face sits in the
 * middle of the screen; when text is needed it slides up first and the text
 * appears once it is out of the way.
 */
static void layout() {
    const bool text = !wantHead.isEmpty() || !wantBody.isEmpty() || wantListCount > 0;
    // What the face leaves on its way is blacked out as it is sent (sendFace).
    const bool there = text ? moveFace(faceTop(), TEXT_FACE) : moveFace(faceMiddle(idleFace), idleFace);
    // The text area is under the face until the face has reached the top at its small size.
    if (text && !there) return;

    const String head = text ? wantHead : String("");
    const int bar = text ? wantBar : -1;
    if (redrawAll || head != shownHead || wantHeadColor != shownHeadColor || bar != shownBar || wantBarColor != shownBarColor) {
        if (text || !shownHead.isEmpty() || redrawAll) display::textLine(headTop(), 3, wantHeadColor, head, bar, wantBarColor);
        shownHead = head;
        shownHeadColor = wantHeadColor;
        shownBar = bar;
        shownBarColor = wantBarColor;
    }
    String lines[MAX_BODY_LINES];
    uint16_t colors[MAX_BODY_LINES];
    const int rows = bodyLines();
    if (wantListCount > 0) {
        for (int i = 0; i < rows; i++) {
            lines[i] = i < wantListCount ? wantList[i] : String("");
            colors[i] = i < wantListCount ? wantListColor[i] : COLOR_BODY;
        }
    } else {
        wrap(wantBody, lines, rows);
        for (int i = 0; i < rows; i++) colors[i] = COLOR_BODY;
    }
    for (int i = 0; i < rows; i++) {
        // What is on a row is its words and its colour, so a step that changes colour is drawn again.
        const String key = colors[i] == COLOR_BODY ? lines[i] : String(colors[i], HEX) + ":" + lines[i];
        if (!redrawAll && key == shownBody[i]) continue;
        display::textLine(bodyTop() + i * display::lineHeight(2), 2, colors[i], lines[i]);
        shownBody[i] = key;
    }
    redrawAll = false;
}

// Whether the panel holds what the last face frame drew, and where (panel coordinates: the box x0 y0 to x1 y1, and in
// each panel row the columns sentFrom up to sentTo): only that and what this frame draws need to go out, since
// everything else in the square is black on the panel already. A clear of the screen (counted by display::clears) or
// anything drawn where the face was makes that unknown again.
static bool faceSent = false;
static int sentX0 = 0, sentY0 = 0, sentX1 = 0, sentY1 = 0;
static int16_t sentFrom[448], sentTo[448];  // panel rows
static uint32_t faceClears = 0;
// What the face sent last, which the edge glow leaves to it (and the face lays the glow into).
static glow::Rect faceKeep;

/**
 * Sends what a face frame (`n` wide, logical top left at x, y) drew and what the last one drew, row by row, and blacks
 * out what the last one drew outside the square (when the face has moved or shrunk). Where the edge glow's ring runs
 * through the part sent, the glow is laid into the frame and sent with it.
 */
static void sendFace(uint16_t *frame, int x, int y, int n) {
    if (display::clears() != faceClears) {
        faceClears = display::clears();
        faceSent = false;
    }
    // Where the frame lands on the panel, which also changes with the rotation. Even, as are n and every span below
    // (the round board's panel needs that; this one does not mind, and the sums are the same).
    int px, py;
    display::squareOnPanel(x, y, n, px, py);
    const bool last = faceSent && sentX1 > sentX0 && sentY1 > sentY0;
    if (last) {
        // Last time's drawing outside the square now, left behind as the face moved or shrank, is blacked out, or it
        // would smear. Inside the square it goes out again below (black where nothing is drawn now).
        const int top = min(sentY1, py), bottom = max(sentY0, py + n);
        if (top > sentY0) display::fillPanel(sentX0, sentY0, sentX1 - sentX0, top - sentY0, 0);
        if (sentY1 > bottom) display::fillPanel(sentX0, bottom, sentX1 - sentX0, sentY1 - bottom, 0);
        const int midTop = max(sentY0, py), midBottom = min(sentY1, py + n);
        if (midBottom > midTop) {
            if (px > sentX0) display::fillPanel(sentX0, midTop, min(sentX1, px) - sentX0, midBottom - midTop, 0);
            if (sentX1 > px + n) display::fillPanel(max(sentX0, px + n), midTop, sentX1 - max(sentX0, px + n), midBottom - midTop, 0);
        }
    }
    // Each row of the frame: what is drawn now and what was there last time, in whole pairs of columns (frame coordinates).
    static int16_t from[vortex::MAX_SIZE], to[vortex::MAX_SIZE];
    int bx0 = n, by0 = n, bx1 = 0, by1 = 0;
    for (int j = 0; j < n; j++) {
        int a = n, b = 0, x0, x1;
        if (vortex::drawnRow(j, x0, x1)) a = x0, b = x1;
        const int row = py + j;
        if (last && row >= sentY0 && row < sentY1 && sentTo[row] > sentFrom[row]) {
            a = min(a, max(0, sentFrom[row] - px));
            b = max(b, min(n, sentTo[row] - px));
        }
        if (b > a) {
            a &= ~1;
            b = min(n, (b + 1) & ~1);
            bx0 = min(bx0, a), bx1 = max(bx1, b), by0 = min(by0, j), by1 = max(by1, j + 1);
        }
        from[j] = a;
        to[j] = b;
    }
    by0 &= ~1;
    by1 = min(n, (by1 + 1) & ~1);
    // What this frame drew, for next time (panel coordinates).
    for (int row = sentY0; row < sentY1; row++) sentFrom[row] = sentTo[row] = 0;
    sentX0 = sentY0 = sentX1 = sentY1 = 0;
    {
        int x0 = 0, x1 = 0, first = -1, end = -1;
        for (int j = 0; j < n; j++) {
            if (!vortex::drawnRow(j, x0, x1)) continue;
            const int row = py + j;
            sentFrom[row] = (px + x0) & ~1;
            sentTo[row] = min(px + n, (px + x1 + 1) & ~1);
            if (first < 0) first = j, sentX0 = sentFrom[row], sentX1 = sentTo[row];
            sentX0 = min(sentX0, (int)sentFrom[row]);
            sentX1 = max(sentX1, (int)sentTo[row]);
            end = j + 1;
        }
        if (first >= 0) sentY0 = py + (first & ~1), sentY1 = py + min(n, (end + 1) & ~1);
    }
    faceSent = true;
    if (bx1 <= bx0 || by1 <= by0) {
        faceKeep = {};
        return;
    }
    // The notification light runs on across the face where they meet (the face at the top, sideways, or big). The
    // ring leaves the face's box alone, so where it runs through the box it goes out with the face: those rows are
    // sent out to the ring's ends inside the box.
    // The frame after the glow has gone sends those rows once more, untinted, as the ring leaves them to the face.
    static bool tintedLast = false;
    const bool tinted = glow::tint(frame, px, py, n, bx0, by0, bx1, by1);
    const bool ringRows = tinted || tintedLast;
    tintedLast = tinted;
    if (ringRows) {
        for (int j = by0; j < by1; j++) {
            for (int r = 0; r < 2; r++) {
                int a, b;
                if (!glow::ringRow(py + j, r, a, b)) continue;
                a = max(bx0, (a - px) & ~1), b = min(bx1, (b - px + 1) & ~1);
                if (b <= a) continue;
                from[j] = min((int)from[j], a);
                to[j] = max((int)to[j], b);
            }
        }
    }
    // Pairs of rows, gathered into one write while the widest span among them times their rows stays within the
    // driver's 1024 pixels and they are about as wide.
    for (int j = by0; j < by1;) {
        int a = min(from[j], from[j + 1]), b = max(to[j], to[j + 1]);
        int rows = 2;
        if (b <= a) {
            j += 2;
            continue;
        }
        while (j + rows + 1 < by1) {
            const int na = min(a, (int)min(from[j + rows], from[j + rows + 1])), nb = max(b, (int)max(to[j + rows], to[j + rows + 1]));
            if (to[j + rows] <= from[j + rows] && to[j + rows + 1] <= from[j + rows + 1]) break;
            if ((nb - na) * (rows + 2) > 1024 || (nb - na) > (b - a) + 16) break;
            a = na, b = nb, rows += 2;
        }
        display::blitFrame(px, py, n, frame, a, j, b, j + rows);
        j += rows;
    }
    if (tinted) glow::untint(frame, px, py, n, bx0, by0, bx1, by1);
    faceKeep = {px + bx0, py + by0, bx1 - bx0, by1 - by0};
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

    // A recording starts before Axis has said so (a wake takes a moment to be answered), so show it from this side.
    // An update takes over: nothing else can happen until the device restarts into the new firmware.
    if (state.updatePercent >= 0) {
        idleSince = 0;
        vortex::setMode(Mode::Thinking);
        return show("Updating", COLOR_HEAD, String((int)state.updatePercent) + "%\nDo not unplug");
    }

    // An open question stays on the screen while the device waits for it to be answered.
    if (client.listening() && state.turn == Turn::Idle) {
        idleSince = 0;
        vortex::setMode(Mode::Listening);
        return show("Listening", COLOR_HEAD, state.question);
    }

    if (state.turn != Turn::Idle) idleSince = 0;
    switch (state.turn) {
        case Turn::Listening:
            vortex::setMode(Mode::Listening);
            return show("Listening", COLOR_HEAD, state.question);
        case Turn::Transcribing:
        case Turn::Thinking:
            vortex::setMode(Mode::Thinking);
            vortex::setDoing(state.doing.c_str());
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

    // The turn can be over for Axis while the last words are still coming out of the speaker.
    if (speaker::playing()) {
        idleSince = 0;
        vortex::setMode(Mode::Speaking);
        return show("", COLOR_HEAD, state.reply);
    }
    vortex::setMode(Mode::Idle);
    if (!idleSince) idleSince = now;
    // Say which service is down, so a failed request is not a mystery.
    const char *down = !state.openclawUp ? "The agent is down" : !state.sttUp ? "Hearing is down" : !state.ttsUp ? "Voice is down" : nullptr;
    const bool keep = now - idleSince < KEEP_TEXT_MS && !state.reply.isEmpty();
    // A running timer counts down above the words; a service that is down matters more.
    // An agent's task shares the line with a timer, turn and turn about, so neither hides the other.
    const String timer = timerLine(now), task = taskLine();
    // A tap on the task's line lists its steps for a while; the line then stays put.
    if (task.isEmpty() || (state.taskSteps.isEmpty() && state.taskOthers.isEmpty())) stepsOpenUntil = 0;
    const bool open = !down && stepsOpenUntil && (int32_t)(stepsOpenUntil - now) > 0;
    if (!open) stepsOpenUntil = 0;
    const bool showTask = !task.isEmpty() && (open || timer.isEmpty() || (now / 4000) % 2 == 1);
    const String head = down ? String(down) : showTask ? task : timer;
    // With steps counted in the line, the words on what is happening now go under it.
    const String doing = showTask && !down && state.taskState == 0 && state.taskTotal ? state.taskNote : String("");
    show(head, down || (showTask && state.taskState == 1) ? COLOR_WARN : COLOR_HEAD, keep && !open ? state.reply : doing);
    if (!showTask || down) return;
    if (state.taskTotal || state.taskState == 2) {
        wantBar = state.taskState == 2 ? 1000 : (int)(1000L * max((int)state.taskDone, 0) / max((int)state.taskTotal, 1));
        wantBarColor = state.taskState == 2 ? COLOR_DONE : state.taskState == 1 ? COLOR_WARN : COLOR_BAR;
    }
    if (open) listSteps();
}

/**
 * Fills the list: the other tasks first, a line each, then this task's steps, as many as fit,
 * keeping the step in hand in view.
 */
static void listSteps() {
    const int room = bodyLines();
    wantListCount = 0;
    const String &others = state.taskOthers;
    // The other tasks may take half the room when there are steps to show as well.
    const int otherRoom = state.taskSteps.isEmpty() ? room : max(1, room / 2);
    for (int at = 0; at < (int)others.length() && wantListCount < otherRoom;) {
        int end = others.indexOf('\n', at);
        if (end < 0) end = others.length();
        if (end > at) {
            wantList[wantListCount] = display::plain(others.substring(at + 1, end));
            wantListColor[wantListCount] = others[at] == '!' ? COLOR_WARN : COLOR_OTHER;
            wantListCount++;
        }
        at = end + 1;
    }
    const int taken = wantListCount;
    const String &all = state.taskSteps;
    int count = 0, current = -1, firstPending = -1;
    for (int at = 0; at < (int)all.length(); count++) {
        if (current < 0 && all[at] == '>') current = count;
        if (firstPending < 0 && all[at] == '-') firstPending = count;
        const int end = all.indexOf('\n', at);
        at = end < 0 ? all.length() : end + 1;
    }
    if (current < 0) current = firstPending >= 0 ? firstPending : count - 1;
    const int rows = room - taken;
    const int first = constrain(current - 1, 0, max(0, count - rows));
    int index = 0;
    for (int at = 0; at < (int)all.length() && wantListCount < room; index++) {
        int end = all.indexOf('\n', at);
        if (end < 0) end = all.length();
        if (index >= first && end > at) {
            const char mark = all[at];
            wantList[wantListCount] = display::plain((mark == '>' ? "> " : "") + all.substring(at + 1, end));
            wantListColor[wantListCount] = mark == 'x' ? COLOR_DIM : mark == '>' ? COLOR_HEAD : COLOR_BODY;
            wantListCount++;
        }
        at = end + 1;
    }
}

/** "Backup 3/5", "Backup: waiting for you", "Backup done". Empty with no task. */
static String taskLine() {
    if (!state.taskCount || state.taskTitle.isEmpty()) return "";
    if (state.taskState == 2) return state.taskTitle + " done";
    if (state.taskState == 1) return state.taskTitle + ": needs you";
    String line = state.taskTitle;
    if (state.taskTotal) line += " " + String(max((int)state.taskDone, 0)) + "/" + String(state.taskTotal);
    else if (!state.taskNote.isEmpty()) line += ": " + state.taskNote;
    // More tasks than the one on the line.
    if (state.taskCount > 1) line += " +" + String(state.taskCount - 1);
    return line;
}

/** "pasta 4:32", or "pasta 1:04:32 (+1)" with more timers behind it. Empty with no timer. */
static String timerLine(uint32_t now) {
    if (!state.timerCount) return "";
    const int32_t leftMs = (int32_t)(state.timerEndsAt - now);
    const uint32_t left = leftMs > 0 ? (uint32_t)(leftMs + 999) / 1000 : 0;
    char clock[20];
    if (left >= 3600) snprintf(clock, sizeof clock, "%lu:%02lu:%02lu", (unsigned long)(left / 3600), (unsigned long)(left % 3600 / 60), (unsigned long)(left % 60));
    else snprintf(clock, sizeof clock, "%lu:%02lu", (unsigned long)(left / 60), (unsigned long)(left % 60));
    String line = state.timerLabel + " " + clock;
    if (state.timerCount > 1) line += " (+" + String(state.timerCount - 1) + ")";
    return line;
}

/** Where a question's parts go on the screen. Worked out from the choices, so drawing and taps agree. */
struct AskLayout {
    /** False when the choices need the whole screen and the face has to make way. */
    bool face;
    int questionTop, questionLines;
    int top, rows, cols, rowHeight;
};

/** How many lines a question may take: two under the face, three when it has the screen. */
static int questionMax(const AskLayout &l) { return l.face ? 2 : 3; }

static AskLayout askLayout() {
    const int n = max(1, (int)state.choiceCount);
    int longest = 1;
    for (int i = 0; i < state.choiceCount; i++) longest = max(longest, display::buttonTextWidth(state.choices[i]));
    // A button is as wide as its cell; this is the least a cell can be for the longest choice to fit. Rows of buttons
    // are sized by the text size (display::buttons()).
    const display::Buttons &b = display::buttons();
    const int need = min(display::width(), longest + b.padding);
    const int maxCols = max(1, min(n, display::width() / need));
    const int lineH = display::lineHeight(2);

    AskLayout l;
    // First choice: everything under the face, where replies go.
    l.face = true;
    l.questionTop = faceTop() + TEXT_FACE + 2;
    l.cols = maxCols;
    for (;;) {
        String lines[3];
        l.questionLines = max(1, wrap(display::plain(state.question), lines, questionMax(l)));
        const int top = l.questionTop + l.questionLines * lineH + 4;
        const int room = display::height() - top;
        l.rows = (n + l.cols - 1) / l.cols;
        l.rowHeight = min(b.rowMax, room / l.rows);
        if (l.rowHeight >= b.rowMin) {
            l.top = top + (room - l.rows * l.rowHeight) / 2;
            return l;
        }
        if (!l.face) break;
        // Too many or too long for that: the question and the buttons take the screen.
        l.face = false;
        l.questionTop = 8;
        l.cols = min(maxCols, n <= 3 ? 1 : 2);
    }
    l.top = l.questionTop + l.questionLines * lineH + 4;
    l.rowHeight = max(b.rowFloor, l.rowHeight);
    return l;
}

/** Draws the question and its choices. Only what changed is sent again. */
static void drawAsk(const AskLayout &l) {
    const bool listening = client.listening();
    if (redrawAll || askDrawn != state.askId || listening != askDrawnListening) {
        // The question turns green while the microphone is open for a spoken answer.
        String lines[3];
        const int count = wrap(display::plain(state.question), lines, questionMax(l));
        for (int i = 0; i < l.questionLines; i++) {
            display::textLine(l.questionTop + i * display::lineHeight(2), 2, listening ? COLOR_LISTEN : COLOR_BODY, i < count ? lines[i] : String(""));
        }
        askDrawnListening = listening;
    }
    if (redrawAll || askDrawn != state.askId) {
        for (int row = 0; row < l.rows; row++) {
            const int first = row * l.cols;
            display::pillRow(l.top + row * l.rowHeight, l.rowHeight, state.choices + first, min(l.cols, state.choiceCount - first), l.cols, COLOR_PILL, COLOR_HEAD);
        }
        askDrawn = state.askId;
    }
    redrawAll = false;
}

/** A hold or a swipe, which the board has no use for itself, goes to Axis (and from there to Home Assistant). */
static void onGesture(touch::Gesture g) {
    const char *name = "hold";
    if (g == touch::Gesture::Swipe) {
        int x0, y0, x1, y1, a, b, c, d;
        touch::swipeEnds(x0, y0, x1, y1);
        // Directions as the screen shows them, whichever way up the device stands.
        display::toLogical(x0, y0, a, b);
        display::toLogical(x1, y1, c, d);
        const int dx = c - a, dy = d - b;
        name = abs(dx) >= abs(dy) ? (dx < 0 ? "swipe_left" : "swipe_right") : (dy < 0 ? "swipe_up" : "swipe_down");
    }
    // A swipe down puts a finished task away (Axis takes it off every screen), so that one is always sent.
    const bool dismiss = !strcmp(name, "swipe_down") && state.taskCount && state.taskState == 2;
    const bool on = dismiss || client.settingInt("gestures", 1) != 0;
    logOut.printf("[touch] %s%s\n", name, on ? "" : " (not sent: gestures are off)");
    if (on) client.gesture(name);
}

/** A tap on a button answers the question. A tap anywhere else does nothing. */
static void onAskTap(const AskLayout &l) {
    int px = 0, py = 0, x = 0, y = 0;
    touch::tapPoint(px, py);
    display::toLogical(px, py, x, y);
    int index = -1;
    const int row = y < l.top ? -1 : (y - l.top) / l.rowHeight;
    if (row >= 0 && row < l.rows) {
        const int inRow = min(l.cols, state.choiceCount - row * l.cols);
        int left = 0, cell = 1;
        display::pillCells(inRow, l.cols, left, cell);
        const int col = x < left ? -1 : (x - left) / cell;
        if (col >= 0 && col < inRow) index = row * l.cols + col;
    }
    logOut.printf("[ask] tap at %d,%d (panel %d,%d): choice %d\n", x, y, px, py, index);
    if (index >= 0) client.answer((uint8_t)index);
}

/**
 * One tap does the obvious thing for the moment: finish a recording, stop an
 * answer, or start listening. Anything Axis is still working on is cancelled,
 * the same as interrupting speech.
 */
static void onTap() {
    // A task with named steps: a tap anywhere under the face lists them, and another puts the list away.
    // The line alone was too small to hit. A tap on the face still starts listening.
    const bool quiet = state.turn == axis::Turn::Idle && !client.listening() && !speaker::playing();
    if (!screenOff && quiet && state.link == axis::Link::Online && state.taskCount && !(state.taskSteps.isEmpty() && state.taskOthers.isEmpty())) {
        int px, py, x, y;
        touch::tapPoint(px, py);
        display::toLogical(px, py, x, y);
        if (stepsOpenUntil && y >= headTop() - 12) {
            stepsOpenUntil = 0;
            return;
        }
        if (!stepsOpenUntil && y >= headTop() - 12) {
            stepsOpenUntil = millis() + STEPS_OPEN_MS;
            if (!stepsOpenUntil) stepsOpenUntil = 1;
            return;
        }
    }
    if (!hasMic) return;
    if (client.listening()) {
        client.stopListening();
        return;
    }
    const bool busy = state.turn == axis::Turn::Speaking || state.turn == axis::Turn::Thinking ||
                      state.turn == axis::Turn::Transcribing || speaker::playing();
    if (busy) {
        client.interrupt();
        return;
    }
    if (micOff) return;
    if (state.link == axis::Link::Online) client.startListening();
}

// ---- diagnostics: `preview NAME` puts a made-up state on the screen for a minute ----------------
// For checking the layout without Axis: what Axis would send is laid over the snapshot.
static const char *const PREVIEWS[] = {"ask", "ask4", "ask6", "reply", "speak", "thinking", "listening", "timer", "task", "steps", "error", "setup", "idle"};
static const int PREVIEW_COUNT = sizeof PREVIEWS / sizeof PREVIEWS[0];
static volatile int previewWanted = -1;
static volatile uint32_t previewRequests = 0;
static int previewShown = -1;
static uint32_t previewUntil = 0, previewStarted = 0;

static void applyPreview(axis::Snapshot &s, uint32_t now) {
    const char *name = PREVIEWS[previewShown];
    s.link = axis::Link::Online;
    s.openclawUp = s.sttUp = s.ttsUp = true;
    s.turn = axis::Turn::Idle;
    if (!strcmp(name, "idle")) {
        // Nothing to say, whatever Axis has on: the face with the screen to itself.
        s.reply = s.transcript = s.note = s.question = "";
        s.choiceCount = 0;
        s.taskCount = 0;
        s.timerCount = 0;
        s.updatePercent = -1;
    } else if (!strncmp(name, "ask", 3)) {
        static const char *const SHORT[] = {"Tea", "Coffee"};
        static const char *const FOUR[] = {"Kitchen", "Living room", "Bedroom", "Office"};
        static const char *const SIX[] = {"Turn them all off", "Only the kitchen", "Leave the hall on", "Dim to half", "Ask me later", "Never mind"};
        const char *const *list = !strcmp(name, "ask") ? SHORT : !strcmp(name, "ask4") ? FOUR : SIX;
        s.choiceCount = !strcmp(name, "ask") ? 2 : !strcmp(name, "ask4") ? 4 : 6;
        for (int i = 0; i < s.choiceCount; i++) s.choices[i] = list[i];
        s.askId = name;
        s.question = s.choiceCount == 2 ? "Tea or coffee?" : s.choiceCount == 4 ? "Which room should I turn the lights on in?" : "The lights are still on downstairs. What should I do with them?";
    } else if (!strcmp(name, "reply") || !strcmp(name, "speak")) {
        s.reply = "Tomorrow looks dry and mild: about 14 degrees in the afternoon, a light wind from the west, and some cloud "
                  "coming in after dark. You will not need an umbrella, but a jacket would be good for the evening walk.";
        if (!strcmp(name, "speak")) s.turn = axis::Turn::Speaking;
    } else if (!strcmp(name, "thinking")) {
        s.turn = axis::Turn::Thinking;
        s.transcript = "what is the weather like tomorrow";
        s.doing = "search";
    } else if (!strcmp(name, "listening")) {
        s.turn = axis::Turn::Listening;
    } else if (!strcmp(name, "timer")) {
        s.timerLabel = "pasta";
        s.timerCount = 2;
        s.timerEndsAt = previewStarted + 75000;
    } else if (!strcmp(name, "task") || !strcmp(name, "steps")) {
        s.taskCount = 3;
        s.taskTitle = "Backup";
        s.taskTotal = 5;
        s.taskDone = 2;
        s.taskNote = "copying the photos";
        s.taskSteps = "xFind the files\nxPack them\n>Copy the photos\n-Check the copy\n-Tidy up";
        s.taskOthers = " Monthly report\n!Invoice: needs you";
    } else if (!strcmp(name, "error")) {
        s.turn = axis::Turn::Error;
        s.note = "Hearing is down: the speech service did not answer";
    } else if (!strcmp(name, "setup")) {
        s.link = axis::Link::Setup;
        s.setupNetwork = "VorteX-Axis-4F2A";
        s.address = "192.168.4.1";
        s.note = "";
    }
}

/** Leaves a request for the screen loop to show one kind of glow for `ms`. False for a kind it does not know. */
static bool requestGlow(const char *kind, uint32_t ms, int corner) {
    static const char *const KINDS[] = {"waiting", "question", "done", "timer", "find", "listening", "thinking", "speaking", "hands"};
    static const glow::State STATES[] = {glow::State::Waiting, glow::State::Question, glow::State::Done, glow::State::Timer,
                                         glow::State::Find, glow::State::Listening, glow::State::Thinking, glow::State::Speaking,
                                         glow::State::Hands};
    GlowRequest request = {glow::State::None, ms, corner};
    for (int i = 0; i < 9; i++) if (!strcmp(kind, KINDS[i])) request.kind = STATES[i];
    if (request.kind == glow::State::None) return false;
    portENTER_CRITICAL(&requestLock);
    glowRequest = request;
    glowRequests++;
    portEXIT_CRITICAL(&requestLock);
    return true;
}

void setup() {
    USBSerial.begin(115200);
    logOut.begin();
    delay(500);  // do not wait on the port itself: it never reports "connected" on this chip
    logOut.printf("\n[boot] VorteX Axis client %s, protocol %d\n", AXIS_FIRMWARE_VERSION, AXIS_PROTOCOL_VERSION);

    const bool displayOk = display::begin();
    const bool faceOk = vortex::begin();
    // sendFace blacks out what the glow laid into the frame (glow::untint), so a frame only blacks out what was drawn.
    vortex::setLazyClear(true);
    logOut.printf("[boot] display %s, face buffer %s, heap %u, psram %u\n", displayOk ? "started" : "FAILED",
                     faceOk ? "ok" : "FAILED", (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
    if (!faceOk) {
        display::textLine(100, 2, COLOR_WARN, "No memory for the face");
        for (;;) delay(1000);
    }

    hasSpeaker = speaker::begin();
    logOut.printf("[boot] speaker %s\n", hasSpeaker ? "started" : "FAILED");
    if (hasSpeaker) {
        client.setAudioSink(speaker::sink());
        client.onListenStart([] { speaker::cue(); }, speaker::CUE_MS + 60);
        speaker::chime();
    }
    // The wake word model takes a slab of internal memory in one piece, so it goes first, before Wi-Fi fragments the heap.
    const bool wakeOk = mic::loadWakeWord(&logOut);
    client.setLogSource(&logOut);
    client.begin(IDENTITY, &logOut);
    hasMic = hasSpeaker && mic::begin(client, &logOut);
    logOut.printf("[boot] microphone %s, wake word %s, touch %s, heap %u\n", hasMic ? "started" : "FAILED",
                     wakeOk ? "loaded" : "NOT loaded", touch::begin() ? "found" : "NOT FOUND", (unsigned)ESP.getFreeHeap());
    logOut.printf("[boot] motion sensor %s\n", imu::begin() ? "found" : "NOT FOUND");
    // Actions the admin page can send.
    client.onCommand([](const char *name, JsonObjectConst params, JsonObject payload) {
        if (!strcmp(name, "cue")) {
            speaker::cue();
            return true;
        }
        if (!strcmp(name, "chime")) {
            speaker::chime();
            return true;
        }
        if (!strcmp(name, "talk")) {
            payload["started"] = client.startListening();
            return true;
        }
        if (!strcmp(name, "glow.show")) {
            return requestGlow(params["kind"] | "", (uint32_t)constrain((int)(params["ms"] | 5000), 1000, 15000),
                               (int)(params["corner"] | (int)client.settingInt("glowCorner", 56)));
        }
        if (!strcmp(name, "find")) {
            portENTER_CRITICAL(&requestLock);
            findRequests++;
            portEXIT_CRITICAL(&requestLock);
            return true;
        }
        if (!strcmp(name, "edges")) {
            edgesUntil = millis() + 10000;
            edgesDrawn = false;
            payload["offset"] = client.settingInt("screenOffset", 16);
            return true;
        }
        if (!strcmp(name, "motion")) {
            int x = 0, y = 0, z = 0;
            imu::read(x, y, z);
            payload["x"] = x;
            payload["y"] = y;
            payload["z"] = z;
            payload["standing"] = imu::orientation();
            payload["rotation"] = wantedRotation();
            return true;
        }
        if (!strcmp(name, "mic")) {
            const axis::Client::MicStats room = client.micStats();
            const mic::Stats m = mic::stats();
            payload["room"] = room.floor;
            payload["speechAbove"] = room.onset;
            payload["level"] = room.level;  // the loudest since the last reading: the admin page's level bars
            payload["wakeHeard"] = m.detections;
            payload["wakeBestPercent"] = m.peakPercent;
            payload["stalls"] = m.stalls;
            return true;
        }
        return false;
    });
    // Serial-only helpers for testing without anybody in the room.
    client.onConsole([](const String &word, const String &rest) {
        if (word == "chime") {
            speaker::chime();
            return true;
        }
        if (word == "probe") {
            // probe HZ RATE [pause]
            int hz = 1000, rate = 16000;
            char flag[16] = "";
            sscanf(rest.c_str(), "%d %d %15s", &hz, &rate, flag);
            probe(hz, rate, !strcmp(flag, "pause"));
            return true;
        }
        if (word == "cue") {
            speaker::cue();
            return true;
        }
        if (word == "glow") {
            // `glow timer 60`: for that many seconds (15 when not given).
            const int space = rest.indexOf(' ');
            const int seconds = space > 0 ? rest.substring(space + 1).toInt() : 15;
            const String kind = space > 0 ? rest.substring(0, space) : rest;
            if (!requestGlow(kind.c_str(), (uint32_t)constrain(seconds, 1, 600) * 1000, (int)client.settingInt("glowCorner", 56))) {
                logOut.println("[glow] one of: waiting question done timer find listening thinking speaking hands, then seconds");
            }
            return true;
        }
        if (word == "set") {
            // `set textSize large` acts as if Axis had sent that setting; `set textSize` alone goes back to it. The same for idleFace.
            String key = rest, value;
            const int space = rest.indexOf(' ');
            if (space >= 0) {
                key = rest.substring(0, space);
                value = rest.substring(space + 1);
                value.trim();
            }
            if (key != "textSize" && key != "idleFace" && key != "idleLook" && key != "maxFps" && key != "rotation") {
                logOut.println("[set] only textSize (small, medium, large), idleFace (normal, large, max), maxFps (20, 30, 45, 60), rotation (0, 90, 180, 270) and idleLook (one look's name)");
                return true;
            }
            if (key == "textSize") snprintf(textSizeTest, sizeof(textSizeTest), "%s", value.c_str());
            else if (key == "idleFace") snprintf(idleFaceTest, sizeof(idleFaceTest), "%s", value.c_str());
            else if (key == "maxFps") snprintf(maxFpsTest, sizeof(maxFpsTest), "%s", value.c_str());
            else if (key == "rotation") rotationTest = value.isEmpty() ? -1 : (int)value.toInt();
            else snprintf(idleLookTest, sizeof(idleLookTest), "%s", value.c_str());
            textSizeRequests++;
            return true;
        }
        if (word == "preview") {
            int found = -1;
            for (int i = 0; i < PREVIEW_COUNT; i++) if (rest == PREVIEWS[i]) found = i;
            if (found < 0 && rest != "off") {
                String names;
                for (int i = 0; i < PREVIEW_COUNT; i++) names += String(" ") + PREVIEWS[i];
                logOut.printf("[preview] one of:%s off\n", names.c_str());
                return true;
            }
            previewWanted = found;
            previewRequests++;
            return true;
        }
        if (word == "still") {
            faceStill = rest != "off";
            logOut.printf("[still] the face %s\n", faceStill ? "holds still" : "moves");
            return true;
        }
        if (word == "fps") {
            fpsRequests++;
            return true;
        }
        if (word == "edges") {
            edgesUntil = millis() + 10000;
            edgesDrawn = false;
            return true;
        }
        if (word == "shot" && rest.startsWith("keep")) {
            // Unlike the round board this one keeps no copy of the panel unless asked: `shot keep` starts one (everything is
            // drawn again into it) and `shot held` then prints it as it stands; `shot keep off` stops.
            const bool on = rest != "keep off";
            display::mirror(on);
            if (on) shotRequests++;
            logOut.printf("[shot] %s\n", on ? "keeping a copy of the panel" : "no copy kept");
            return true;
        }
        if (word == "shot" && rest == "held") {
            // What the panel holds right now, as it is: for checking that nothing was left behind.
            display::dump(logOut);
            return true;
        }
        if (word == "shot") {
            // A picture of the screen: everything is drawn again into a kept copy, which is then printed.
            const bool kept = display::mirroring();
            display::mirror(true);
            shotRequests++;
            delay(1500);
            display::dump(logOut);
            if (!kept) display::mirror(false);
            return true;
        }
        if (word == "wake") {
            client.wakeHeard(0.99f, 0.5f);  // as if the wake word had just been heard
            return true;
        }
        return false;
    });
    applySettings();
}

void loop() {
    // The admin page draws this device at its real shape, the way up it is standing now.
    client.setReading("screenW", display::width());
    client.setReading("screenH", display::height());
    client.setReading("gestures", 1);  // says it can send them, so Axis gives it a Gesture entity
    static uint32_t lastFrame = 0, lastText = 0, lastReport = 0, frames = 0, drawMicros = 0, renderMicros = 0;
    const uint32_t started = millis();
    if (started - lastFrame < FRAME_MS) return delay(1);
    const float seconds = lastFrame ? (started - lastFrame) / 1000.0f : 1.0f / 30.0f;
    if (faceStill && lastFrame) stillMs += started - lastFrame;
    lastFrame = started;

    // `shot` on the console: everything drawn again, so the kept copy holds the whole screen.
    static uint32_t seenShot = 0;
    if (shotRequests != seenShot) {
        seenShot = shotRequests;
        display::clear();
        glow::reset();
        redrawAll = true;
        askDrawn = "";
        edgesDrawn = false;
        if (pictureUntil) display::blitScreen(pictureFrame);
    }

    const bool changed = client.revision() != seenRevision;
    if (changed) {
        state = client.snapshot();
        seenRevision = state.revision;
        // Axis marks a task that has just finished; the sound is this device's to make or not.
        // A task that has just finished flashes the edges green (silent, so quiet hours do not matter).
        if (state.taskCount && state.taskState == 2 && seenTaskState != 2) {
            doneFlashUntil = millis() + DONE_FLASH_MS;
            if (!doneFlashUntil) doneFlashUntil = 1;
        }
        seenTaskState = state.taskCount ? state.taskState : 0;
        if (state.taskChimes != seenChimes) {
            seenChimes = state.taskChimes;
            if (hasSpeaker && client.settingInt("taskChime", 1) != 0 && !speaker::playing() && !client.listening()) speaker::chime();
        }
        if (state.settingsRevision != seenSettings) {
            seenSettings = state.settingsRevision;
            applySettings();
        }
    }
    {
        static uint32_t seenTextSize = 0;
        if (textSizeRequests != seenTextSize) {
            seenTextSize = textSizeRequests;
            applySettings();
            logOut.printf("[set] textSize %d (0 small, 1 medium, 2 large), idleFace %d pixels, %u ms a frame at least\n", display::textSize(), idleFace, (unsigned)FRAME_MS);
        }
    }
    // A made-up state from the console (`preview`), laid over what Axis said, for a minute.
    {
        static uint32_t seenPreview = 0;
        const bool wasShown = previewShown >= 0;
        if (previewRequests != seenPreview) {
            seenPreview = previewRequests;
            previewShown = previewWanted;
            previewStarted = started;
            previewUntil = started + 60000;
            stepsOpenUntil = previewShown >= 0 && !strcmp(PREVIEWS[previewShown], "steps") ? previewUntil : 0;
        }
        if (previewShown >= 0 && (int32_t)(started - previewUntil) >= 0) previewShown = -1;
        if (previewShown >= 0 || wasShown) {
            state = client.snapshot();
            if (previewShown >= 0) applyPreview(state, started);
        }
    }
    // A picture from an agent's reply. A newer one replaces it.
    {
        uint8_t *jpg = nullptr;
        size_t size = 0;
        String turnId;
        if (client.takePicture(jpg, size, turnId)) {
            const bool shown = !edgesUntil && !screenOff && showPicture(jpg, size);
            heap_caps_free(jpg);
            logOut.printf("[picture] %u bytes, %s\n", (unsigned)size, shown ? "shown" : "could not be shown");
        }
    }
    // The screen switched off on the admin page: the panel is blank and nothing is drawn, the connection stays and
    // a tap still talks. Only while paired, so Wi-Fi setup and pairing always show. Back on, everything is drawn
    // again from nothing.
    if (screenOff && (state.link == axis::Link::Online || state.link == axis::Link::Connecting)) {
        if (!screenBlanked || pictureUntil || edgesUntil) {
            screenBlanked = true;
            pictureUntil = 0;
            edgesUntil = 0;
            glow::reset();
            display::clear();
            display::setBrightness(0);
        }
        const touch::Gesture g = touch::poll();
        if (g == touch::Gesture::Tap) onTap();
        else if (g != touch::Gesture::None) onGesture(g);
        return;
    }
    if (screenBlanked) {
        screenBlanked = false;
        applySettings();  // the brightness back, and everything drawn again
        display::clear();
        redrawAll = true;
        askShown = false;
        askDrawn = "";
        faceY = -1;
    }
    if (pictureUntil) {
        const touch::Gesture g = touch::poll();
        if (g != touch::Gesture::None && g != touch::Gesture::Tap) onGesture(g);
        const bool speaking = speaker::playing() || state.turn == axis::Turn::Speaking;
        // The time on show runs from the end of the speech, so a long answer does not use it up.
        if (speaking) pictureUntil = max(pictureUntil, millis() + PICTURE_MS);
        // A follow-up keeps the picture: listening, working out the words and thinking all show as the glow
        // around it (before 0.17.3 the picture closed once the words were being worked out). A newer picture
        // replaces it; a tap, a question with choices or the time running out closes it.
        const bool asked = state.link == axis::Link::Online && state.choiceCount > 0;
        if ((int32_t)(millis() - pictureUntil) < 0 && g != touch::Gesture::Tap && !asked && !edgesUntil) {
            const bool working = state.turn == axis::Turn::Transcribing || state.turn == axis::Turn::Thinking;
            const glow::State doing = client.listening() ? glow::State::Listening
                                      : speaking ? glow::State::Speaking
                                      : working ? glow::State::Thinking
                                      : glow::State::None;
            const float level = doing == glow::State::Listening ? mic::level() : doing == glow::State::Speaking ? speaker::level() : -1.0f;
            glow::update(pictureFrame, doing, level);
            return;
        }
        pictureUntil = 0;
        glow::reset();
        display::clear();
        redrawAll = true;
        askDrawn = "";
        faceY = -1;
    }

    // The edge frame for setting the picture offset has the screen to itself while it shows.
    if (edgesUntil) {
        if ((int32_t)(millis() - edgesUntil) < 0) {
            if (!edgesDrawn) {
                display::clear();
                display::edges(COLOR_HEAD);
                edgesDrawn = true;
            }
            return;
        }
        edgesUntil = 0;
        display::clear();
        redrawAll = true;
        askDrawn = "";
        faceY = -1;
    }

    // Turning the device over turns the picture, once it has stayed that way for a moment.
    imu::tick();
    static int shownRotation = -1;
    if (wantedRotation() != shownRotation) {
        if (shownRotation >= 0) logOut.printf("[screen] rotation %d\n", wantedRotation());
        shownRotation = wantedRotation();
        applySettings();
        askDrawn = "";
        faceY = -1;
    }

    // A question with choices has its own layout until it is answered or gives up.
    const bool wantAsk = state.link == axis::Link::Online && state.choiceCount > 0;
    if (wantAsk != askShown || (wantAsk && askDrawn != state.askId && !askDrawn.isEmpty())) {
        askShown = wantAsk;
        askDrawn = "";
        display::clear();
        redrawAll = true;
        // The face stays where it was and goes from there: up and smaller for a question, back for the idle screen.
    }
    bool drawFace = !facePaused;
    if (askShown) {
        const AskLayout l = askLayout();
        // The question and its buttons wait for the face to reach the top at its small size, as text does.
        const bool there = moveFace(faceTop(), TEXT_FACE);
        if (there || !l.face) drawAsk(l);
        if (touch::poll() == touch::Gesture::Tap && (there || !l.face)) onAskTap(l);
        drawFace = drawFace && l.face;
        vortex::setMode(client.listening() ? vortex::Mode::Listening : vortex::Mode::Idle);
    } else {
        // Text also depends on time (messages that expire), so it is rechecked a few times a second.
        if (changed || started - lastText > 250) {
            lastText = started;
            present();
        }
        layout();
        const touch::Gesture g = touch::poll();
        if (g == touch::Gesture::Tap) onTap();
        else if (g != touch::Gesture::None) onGesture(g);
    }
    vortex::setLevel(speaker::playing() ? speaker::level() : client.listening() ? mic::level() : -1.0f);

    if (drawFace) {
        if (faceY < 0) moveFace(faceTop(), TEXT_FACE);
        vortex::setSize(faceSide);
        const uint32_t t0 = micros();
        uint16_t *frame = const_cast<uint16_t *>(vortex::render(faceStill ? 0.0f : min(seconds, 0.1f)));
        const uint32_t t1 = micros();
        renderMicros += t1 - t0;
        sendFace(frame, faceLeft(), faceY, faceSide);
        sentFaceY = faceY;
        sentFaceSide = faceSide;
        drawMicros += micros() - t0;
        frames++;
        fpsFrames++;
        fpsDrawMicros += micros() - t0;
        fpsFaceMicros += t1 - t0;
    } else {
        faceSent = false;
        faceKeep = {};
        sentFaceY = faceY;
        sentFaceSide = faceSide;
    }

    // The notification light, only while nothing else is going on: amber while a task waits for the person,
    // a green flash when one finishes. It stays off the face, which draws itself.
    {
        const bool calm = !askShown && state.link == axis::Link::Online && state.turn == axis::Turn::Idle &&
                          !client.listening() && !speaker::playing();
        glow::State notice = glow::State::None;
        float level = -1.0f, sweep = 1.0f;
        // A timer's last seconds come first: a red edge that shrinks clockwise as they run out, beating each second.
        const int32_t timerLeft = state.timerCount ? (int32_t)(state.timerEndsAt - started) : -1;
        // Somebody looking for this device comes before everything but a conversation.
        // Requests from the admin page, started here on this frame's clock.
        {
            static uint32_t seenGlow = 0, seenFind = 0;
            portENTER_CRITICAL(&requestLock);
            const GlowRequest request = glowRequest;
            const uint32_t glows = glowRequests, finds = findRequests;
            portEXIT_CRITICAL(&requestLock);
            if (glows != seenGlow) {
                seenGlow = glows;
                previewKind = request.kind;
                previewMs = request.ms;
                previewFrom = started;
                glow::setCorner(request.corner);
            }
            if (finds != seenFind) {
                seenFind = finds;
                findUntil = started + FIND_MS;
                if (!findUntil) findUntil = 1;
                findChimes = 3;
            }
        }
        const int32_t findLeft = findUntil ? (int32_t)(findUntil - started) : 0;
        if (findLeft > 0) {
            if (findChimes && (int32_t)(FIND_MS - findLeft) >= (int32_t)((3 - findChimes) * FIND_CHIME_EVERY_MS)) {
                findChimes--;
                if (hasSpeaker && !speaker::playing() && !client.listening()) speaker::chime();
            }
        } else {
            findUntil = 0;
            findChimes = 0;
        }
        // A glow being tried from the admin page: that kind, for a few seconds, ahead of all but a conversation.
        const uint32_t previewAt = previewKind != glow::State::None ? started - previewFrom : 0;
        if (previewKind != glow::State::None && previewAt >= previewMs) {
            previewKind = glow::State::None;
            glow::setCorner((int)client.settingInt("glowCorner", 56));
        }
        const bool talking = client.listening() || speaker::playing() || state.turn != axis::Turn::Idle;
        if (previewKind != glow::State::None && !talking) {
            notice = previewKind;
            const float t = previewAt / 1000.0f;
            if (previewKind == glow::State::Done) {
                // A flash fading right out, every two and a half seconds.
                const uint32_t into = previewAt % 2500;
                level = into < DONE_FLASH_MS ? 1.0f - into / (float)DONE_FLASH_MS : 0.0f;
            } else if (previewKind == glow::State::Timer) {
                const int32_t left = (int32_t)previewMs - (int32_t)previewAt;
                sweep = left / (float)previewMs;
                const float beat = (left % 1000) / 1000.0f;
                level = beat * beat;
            } else if (previewKind == glow::State::Listening || previewKind == glow::State::Speaking) {
                // Something like a voice, as there is none.
                level = constrain(sinf(t * 7.0f) * 0.5f + sinf(t * 13.3f) * 0.3f + 0.3f, 0.0f, 1.0f);
            }
        } else if (findLeft > 0 && !talking) {
            notice = glow::State::Find;
        } else if (calm && timerLeft > 0 && timerLeft <= TIMER_GLOW_MS && client.settingInt("timerGlow", 1) != 0) {
            notice = glow::State::Timer;
            sweep = timerLeft / (float)TIMER_GLOW_MS;
            const float beat = (timerLeft % 1000) / 1000.0f;  // 1 on each whole second, fading to 0
            level = beat * beat;
        } else if (calm && state.desktopBusy && client.settingInt("handsGlow", 1) != 0) {
            // An agent at a computer nearby: rose, only while the face is idle. Over the thinking face it cost
            // frames (the glow redraws the edges 10 times a second); the computer icon says it there instead.
            notice = glow::State::Hands;
        } else if (calm && client.settingInt("notifyGlow", 1) != 0) {
            if (doneFlashUntil && (int32_t)(started - doneFlashUntil) < 0) {
                notice = glow::State::Done;
                level = (doneFlashUntil - started) / (float)DONE_FLASH_MS;
            } else if (state.asksElsewhere) {
                // A question waiting somewhere else, or on no screen any more: blue, ahead of a task's amber.
                notice = glow::State::Question;
            } else if (state.taskCount && state.taskState == 1) {
                notice = glow::State::Waiting;
            }
        }
        if (doneFlashUntil && (int32_t)(started - doneFlashUntil) >= 0) doneFlashUntil = 0;
        const uint32_t g0 = micros();
        glow::update(nullptr, notice, level, faceKeep, sweep);
        fpsGlowMicros += micros() - g0;
        // Text the glow lay over is drawn again once it is gone.
        if (notice == glow::State::None && noticeShown) redrawAll = true;
        noticeShown = notice != glow::State::None;
    }

    {
        // `fps` on the console: face frames and the time spent on them since it was last asked.
        static uint32_t seenFps = 0, fpsFrom = 0;
        if (fpsRequests != seenFps) {
            seenFps = fpsRequests;
            logOut.printf("[fps] %.1f fps over %.1f s, %.1f ms a face frame (%.1f rendering it), edge glow %.1f ms a second, heap %u (low %u)\n",
                          fpsFrames * 1000.0f / max(1u, (unsigned)(started - fpsFrom)), (started - fpsFrom) / 1000.0f,
                          fpsDrawMicros / 1000.0f / max(1u, (unsigned)fpsFrames), fpsFaceMicros / 1000.0f / max(1u, (unsigned)fpsFrames),
                          fpsGlowMicros / max(1.0f, (float)(started - fpsFrom)), (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap());
            // How close the figure came to the nearest edge of the screen, for the face's size and place now.
            const float cx = faceLeft() + faceSide / 2.0f, cy = faceY + faceSide / 2.0f;
            const float edge = min(min(cx, display::width() - cx), min(cy, display::height() - cy));
            logOut.printf("[fps] face %d at %d; the figure came within %.1f pixels of the edge\n", faceSide, faceY, edge - vortex::farthest());
            uint32_t gm, gs, gp, gn;
            glow::stats(gm, gs, gp, gn);
            logOut.printf("[fps] edge glow: %.1f ms working out, %.1f ms sending, %u pixels in %u pieces\n", gm / 1000.0f, gs / 1000.0f, (unsigned)gp, (unsigned)gn);
            fpsFrom = started;
            fpsFrames = fpsDrawMicros = fpsFaceMicros = fpsGlowMicros = 0;
        }
    }
    if (started - lastReport >= 60000) {
        logOut.printf("[run] up %lus, %.1f fps, %.1f ms per frame (%.1f drawing it), idle look \"%s\", heap %u (low %u, largest piece %u)\n",
                         (unsigned long)(started / 1000), frames * 1000.0f / (started - lastReport),
                         drawMicros / 1000.0f / max(1u, (unsigned)frames), renderMicros / 1000.0f / max(1u, (unsigned)frames),
                         vortex::idleName(), (unsigned)ESP.getFreeHeap(),
                         (unsigned)ESP.getMinFreeHeap(), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
        if (hasMic) {
            const mic::Stats m = mic::stats();
            const axis::Client::MicStats room = client.micStats();
            logOut.printf("[mic] %lu blocks, %lu stalls; room %u (speech above %u); wake: %lu heard, %lu ignored, best %u%%, %.1f ms a run\n",
                             (unsigned long)m.blocks, (unsigned long)m.stalls, (unsigned)room.floor, (unsigned)room.onset,
                             (unsigned long)m.detections, (unsigned long)m.ignored, (unsigned)m.peakPercent, m.inferenceUs / 1000.0f);
        }
        lastReport = started;
        frames = 0;
        drawMicros = 0;
        renderMicros = 0;
    }
}
