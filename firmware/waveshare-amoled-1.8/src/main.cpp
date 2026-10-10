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

// This board's serial port is the chip's own USB, not a UART. Output on plain
// `Serial` goes nowhere unless this is used and ARDUINO_USB_CDC_ON_BOOT is set.
HWCDC USBSerial;
// Everything printed here also goes into a memory buffer the device serves at /logs.
static axis::LogBuffer logOut(USBSerial);

static const char *const CAPABILITIES[] = {"screen", "speaker", "mic"};
// What the Axis admin page offers for this board. Keep in step with applySettings() and the
// client core's vadLimits(): a key listed here that nothing reads does nothing.
static const axis::SettingDef SETTINGS[] = {
    {"autoRotate", "Turn with the device", "toggle", "Screen", "The picture follows whichever way up the device is standing. Lying flat, it stays as it was.", "1", 0, 0, nullptr, nullptr},
    {"rotation", "Screen rotation", "choice", "Screen", "Used when turning with the device is off, and until the device knows which way up it is.", "90", 0, 0, "degrees", "0,90,180,270"},
    {"brightness", "Brightness", "number", "Screen", nullptr, "200", 10, 255, nullptr, nullptr},
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
};
static const axis::ActionDef ACTIONS[] = {
    {"cue", "Play listening cue", "The tone it plays when it starts listening.", false},
    {"chime", "Play chime", "The two-note boot chime.", false},
    {"talk", "Start listening", "Same as tapping the screen while idle.", false},
    {"mic", "Microphone levels", "Room level, speech threshold and wake word statistics.", false},
    {"edges", "Show screen edges", "Draws a frame along the edges of the screen for ten seconds, to set the picture offset by.", false},
    {"motion", "Which way up", "Gravity along the board's axes in thousandths of g, and the rotation it calls for.", false},
};
static const axis::Identity IDENTITY = {"waveshare-amoled-1.8", CAPABILITIES, 3, SETTINGS, sizeof SETTINGS / sizeof SETTINGS[0],
                                        ACTIONS, sizeof ACTIONS / sizeof ACTIONS[0]};

static const uint16_t COLOR_HEAD = 0xFFFF;
static const uint16_t COLOR_BODY = 0xA554;  // light grey
static const uint16_t COLOR_WARN = 0xFD20;  // amber
static const uint16_t COLOR_LISTEN = 0x4FEA;  // soft green, as the listening face
static const uint32_t FRAME_MS = 33;
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
// Where the top of the face is now. -1 until it has been placed once.
static int faceY = -1;
static bool hasSpeaker = false, hasMic = false;

// A question with choices: the face stays, the question goes under it and the choices are buttons below.
static bool askShown = false;
static String askDrawn;
static bool askDrawnListening = false;
static const uint16_t COLOR_PILL = 0x1CCA;  // the listening face's mint, dimmed
static String timerLine(uint32_t now);
static String taskLine();
static void listSteps();

/** Where the face sits while there is text under it. */
static int faceTop() { return display::height() > display::width() ? 20 : 0; }
/** Where the face sits when it has the screen to itself. */
static int faceMiddle() { return (display::height() - vortex::SIZE) / 2; }
static int headTop() { return faceTop() + vortex::SIZE + 4; }
static int bodyTop() { return headTop() + display::lineHeight(3); }
static int bodyLines() { return min(MAX_BODY_LINES, (display::height() - bodyTop()) / display::lineHeight(2)); }

/** The rotation in force: the way the device is standing when it turns with it and knows, the setting otherwise. */
static int wantedRotation() {
    const int standing = client.settingInt("autoRotate", 1) != 0 ? imu::orientation() : -1;
    return standing >= 0 ? standing : (int)client.settingInt("rotation", 90);
}

// While this is in the future the screen shows only a frame along its edges.
static uint32_t edgesUntil = 0;
static bool edgesDrawn = false;

static void applySettings() {
    display::setColumnOffset((int)client.settingInt("screenOffset", 16));
    edgesDrawn = false;
    display::setRotation(wantedRotation());
    vortex::setRotation(wantedRotation());
    display::setBrightness((uint8_t)constrain(client.settingInt("brightness", 200), 10, 255));
    speaker::setVolume((int)client.settingInt("volume", 60));
    vortex::setIdleOff(client.setting("idleLooksOff").c_str());
    mic::setWakeEnabled(client.settingInt("wakeListen", 1) != 0);
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
    const int target = text ? faceTop() : faceMiddle();
    if (faceY < 0) faceY = target;
    if (faceY != target) {
        const int distance = target - faceY;
        const int step = constrain(distance / 5, -24, 24);
        const int next = faceY + (step != 0 ? step : (distance > 0 ? 1 : -1));
        // Black out the rows the face is leaving, or it would smear.
        if (next < faceY) display::clearBand(next + vortex::SIZE, faceY - next);
        else display::clearBand(faceY, next - faceY);
        faceY = next;
    }
    // The text area is under the face until the face has reached the top.
    if (text && faceY != faceTop()) return;

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
            vortex::setIcon(state.doing.c_str());
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

static AskLayout askLayout() {
    const int n = max(1, (int)state.choiceCount);
    int longest = 1;
    for (int i = 0; i < state.choiceCount; i++) longest = max(longest, display::buttonTextWidth(state.choices[i]));
    // A button is as wide as its cell; this is the least a cell can be for the longest choice to fit.
    const int need = min(display::width(), longest + 44);
    const int maxCols = max(1, min(n, display::width() / need));
    String lines[2];
    const int questionLines = max(1, wrap(display::plain(state.question), lines, 2));
    const int lineH = display::lineHeight(2);

    AskLayout l;
    l.questionLines = questionLines;
    // First choice: everything under the face, where replies go.
    l.face = true;
    l.questionTop = faceTop() + vortex::SIZE + 2;
    l.cols = maxCols;
    for (;;) {
        const int top = l.questionTop + questionLines * lineH + 4;
        const int room = display::height() - top;
        l.rows = (n + l.cols - 1) / l.cols;
        l.rowHeight = min(56, room / l.rows);
        if (l.rowHeight >= 40) {
            l.top = top + (room - l.rows * l.rowHeight) / 2;
            return l;
        }
        if (!l.face) break;
        // Too many or too long for that: the question and the buttons take the screen.
        l.face = false;
        l.questionTop = 8;
        l.cols = min(maxCols, n <= 3 ? 1 : 2);
    }
    l.top = l.questionTop + questionLines * lineH + 4;
    l.rowHeight = max(24, l.rowHeight);
    return l;
}

/** Draws the question and its choices. Only what changed is sent again. */
static void drawAsk(const AskLayout &l) {
    const bool listening = client.listening();
    if (redrawAll || askDrawn != state.askId || listening != askDrawnListening) {
        // The question turns green while the microphone is open for a spoken answer.
        String lines[2];
        const int count = wrap(display::plain(state.question), lines, 2);
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

/** A tap on a button answers the question. A tap anywhere else does nothing. */
static void onAskTap(const AskLayout &l) {
    int px = 0, py = 0, x = 0, y = 0;
    touch::tapPoint(px, py);
    display::toLogical(px, py, x, y);
    int index = -1;
    const int row = y < l.top ? -1 : (y - l.top) / l.rowHeight;
    if (row >= 0 && row < l.rows) {
        const int inRow = min(l.cols, state.choiceCount - row * l.cols);
        const int cell = display::width() / l.cols;
        const int left = (display::width() - cell * inRow) / 2;
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
    if (quiet && state.link == axis::Link::Online && state.taskCount && !(state.taskSteps.isEmpty() && state.taskOthers.isEmpty())) {
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
    if (state.link == axis::Link::Online) client.startListening();
}

void setup() {
    USBSerial.begin(115200);
    logOut.begin();
    delay(500);  // do not wait on the port itself: it never reports "connected" on this chip
    logOut.printf("\n[boot] VorteX Axis client %s, protocol %d\n", AXIS_FIRMWARE_VERSION, AXIS_PROTOCOL_VERSION);

    const bool displayOk = display::begin();
    const bool faceOk = vortex::begin();
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
    client.onCommand([](const char *name, JsonObjectConst, JsonObject payload) {
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
    static uint32_t lastFrame = 0, lastText = 0, lastReport = 0, frames = 0, drawMicros = 0, renderMicros = 0;
    const uint32_t started = millis();
    if (started - lastFrame < FRAME_MS) return delay(1);
    const float seconds = lastFrame ? (started - lastFrame) / 1000.0f : 0.033f;
    lastFrame = started;

    const bool changed = client.revision() != seenRevision;
    if (changed) {
        state = client.snapshot();
        seenRevision = state.revision;
        // Axis marks a task that has just finished; the sound is this device's to make or not.
        if (state.taskChimes != seenChimes) {
            seenChimes = state.taskChimes;
            if (hasSpeaker && client.settingInt("taskChime", 1) != 0 && !speaker::playing() && !client.listening()) speaker::chime();
        }
        if (state.settingsRevision != seenSettings) {
            seenSettings = state.settingsRevision;
            applySettings();
        }
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
        faceY = -1;
    }
    bool drawFace = !facePaused;
    if (askShown) {
        const AskLayout l = askLayout();
        drawAsk(l);
        if (touch::tapped()) onAskTap(l);
        drawFace = drawFace && l.face;
        faceY = faceTop();
        vortex::setMode(client.listening() ? vortex::Mode::Listening : vortex::Mode::Idle);
    } else {
        // Text also depends on time (messages that expire), so it is rechecked a few times a second.
        if (changed || started - lastText > 250) {
            lastText = started;
            present();
        }
        layout();
        if (touch::tapped()) onTap();
    }
    vortex::setLevel(speaker::playing() ? speaker::level() : client.listening() ? mic::level() : -1.0f);

    if (drawFace) {
        const uint32_t t0 = micros();
        const uint16_t *frame = vortex::render(min(seconds, 0.1f));
        renderMicros += micros() - t0;
        display::blitSquare((display::width() - vortex::SIZE) / 2, faceY, vortex::SIZE, frame);
        drawMicros += micros() - t0;
        frames++;
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
