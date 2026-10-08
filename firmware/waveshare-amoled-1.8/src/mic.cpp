#include "mic.h"

#include "codec.h"
#include "detector.h"
#include "speaker.h"

namespace mic {

namespace {

// 10 ms at 16 kHz. The wake word model slides in exactly this step.
const size_t BLOCK = 160;
// A read that returns nothing this long means the stream stopped.
const uint32_t STALL_MS = 300;
// A wake score at which the speaker ducks to let the rest of the phrase through.
const float DUCK_SCORE = 0.25f;

axis::Client *client = nullptr;
Print *logOut = nullptr;
volatile bool wakeEnabled = true, bargeIn = true;
volatile float currentLevel = 0;
int16_t *capBuf = nullptr;
volatile size_t capWant = 0, capGot = 0;
volatile uint32_t blocks = 0, stalls = 0, ignored = 0;
bool modelLoaded = false;

/** Reads one block and keeps the left channel; the codec sends both. False when the stream stalls. */
bool readBlock(int16_t *mono) {
    static int16_t stereo[BLOCK * 2];
    const size_t need = BLOCK * 4;
    size_t have = 0;
    uint32_t last = millis();
    while (have < need) {
        const size_t got = codec::i2s().readBytes((char *)stereo + have, need - have);
        if (got == 0) {
            if (millis() - last > STALL_MS) return false;
            delay(1);
        } else {
            have += got;
            last = millis();
        }
    }
    for (size_t i = 0; i < BLOCK; i++) mono[i] = stereo[i * 2];
    return true;
}

void task(void *) {
    int16_t block[BLOCK];
    // Loudness around the wake word, used to pick between devices that heard it at once.
    float recent = 0;
    // The room's own loudness, so the face moves with a voice and not with a fan.
    float room = 0;
    uint32_t lastNearMiss = 0, duckedAt = 0;
    for (;;) {
        if (!readBlock(block)) {
            stalls++;
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }
        blocks++;
        if (capBuf && capGot < capWant) {
            const size_t n = min(BLOCK, capWant - capGot);
            memcpy(capBuf + capGot, block, n * sizeof(int16_t));
            capGot += n;
        }
        uint32_t sum = 0;
        for (size_t i = 0; i < BLOCK; i++) sum += abs((int)block[i]);
        const float now = min(1.0f, (sum / (float)BLOCK) / 3000.0f);
        const float average = sum / (float)BLOCK;
        room += average < room ? (average - room) / 16.0f : (average - room) / 1024.0f;
        // Square root: ordinary speech should fill most of the range, not the bottom of it.
        const float voice = sqrtf(constrain((average - room * 1.3f - 20.0f) / 1500.0f, 0.0f, 1.0f));
        // Rise at once, fall over about a tenth of a second, so the face follows syllables.
        currentLevel = voice > currentLevel ? voice : currentLevel * 0.9f + voice * 0.1f;
        recent = recent * 0.95f + now * 0.05f;

        client->feedAudio(block, BLOCK);

        // Always fed, even while recording or speaking: a gap would leave the model's state stale.
        float score = 0;
        const bool heard = modelLoaded && wake::feed(block, BLOCK, &score);
        // A phrase that scored well but fell short is what to look at when it "does not hear me".
        if (!heard && score >= 0.3f && millis() - lastNearMiss > 700) {
            lastNearMiss = millis();
            if (logOut) logOut->printf("[wake] near miss: score %.2f of %u%%, %s\n", score, (unsigned)wake::cutoffPercent(),
                                       client->listening() ? "recording" : speaker::playing() ? "while speaking" : "quiet");
        }
        // Something that scores like the wake word while the device talks is probably somebody saying it
        // over the speech. The speaker drowns the microphone, so go quiet for the rest of the phrase.
        if (!heard && bargeIn && wakeEnabled && score >= DUCK_SCORE && speaker::playing() && !client->listening()) {
            if (millis() > duckedAt + 1000 && logOut) logOut->printf("[wake] score %.2f over speech, ducking the speaker\n", score);
            duckedAt = millis();
            speaker::duck(1500);
        }
        if (!heard || !wakeEnabled) continue;
        if (client->listening()) {
            if (logOut) logOut->printf("[wake] heard it while already recording (score %.2f)\n", score);
            continue;
        }
        if (!bargeIn && client->snapshot().turn == axis::Turn::Speaking) {
            ignored++;
            if (logOut) logOut->printf("[wake] heard it over speech but bargeIn is off (score %.2f)\n", score);
            continue;
        }
        if (logOut) logOut->printf("[wake] heard it (score %.2f, level %.2f)\n", score, recent);
        client->wakeHeard(score, min(1.0f, recent * 4.0f));
    }
}

}  // namespace

bool loadWakeWord(Print *log) {
    modelLoaded = wake::begin(log);
    return modelLoaded;
}

bool begin(axis::Client &c, Print *log) {
    client = &c;
    logOut = log;
    xTaskCreatePinnedToCore(task, "mic", 8192, nullptr, 4, nullptr, 0);
    return true;
}

void capture(int16_t *buffer, size_t samples) {
    capGot = 0;
    capBuf = buffer;
    capWant = samples;
}
bool captureDone() { return capBuf && capGot >= capWant; }

void setWakeEnabled(bool enabled) { wakeEnabled = enabled; }
void setWakeSensitivity(uint8_t percent) { wake::setSensitivity(percent); }
void setBargeIn(bool enabled) { bargeIn = enabled; }
float level() { return currentLevel; }

Stats stats() {
    Stats s;
    s.blocks = blocks;
    s.stalls = stalls;
    s.detections = wake::detections();
    s.ignored = ignored;
    s.inferenceUs = wake::lastInferenceUs();
    s.peakPercent = wake::peakPercent();
    return s;
}

}  // namespace mic
