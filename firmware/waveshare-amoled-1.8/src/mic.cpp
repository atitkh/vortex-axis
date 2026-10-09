#include "mic.h"

#include <esp_aec.h>
#include <esp_heap_caps.h>

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
volatile bool wakeEnabled = true, bargeIn = false;
volatile float currentLevel = 0;
int16_t *capBuf = nullptr;
volatile size_t capWant = 0, capGot = 0;
volatile uint32_t blocks = 0, stalls = 0, ignored = 0;
bool modelLoaded = false;

// --- echo cancelling ---------------------------------------------------------------------
// The speaker sits next to the microphone, so without this the device mostly hears itself
// while it talks. The codec returns what it is playing on the right channel; Espressif's
// canceller takes that out of the microphone signal, a 32 ms frame at a time.
aec_handle_t *aec = nullptr;
// The microphone is turned down by codec::MIC_QUIET_DB while the device talks; this puts it back afterwards (24 dB is 16 times).
const int32_t MAKE_UP = 16;
size_t aecChunk = 512;
int16_t *aecIn = nullptr, *aecRef = nullptr, *aecOut = nullptr;
size_t aecFill = 0;
volatile bool echoCancel = true;
volatile uint32_t aecUs = 0;
// Cleaned samples waiting to be handled a block at a time (a frame is not a whole number of blocks).
int16_t fifo[1024];
size_t fifoLen = 0;
// Loudness of the microphone before and after cancelling over one stretch of speech, for the log.
double rawEnergy = 0, cleanEnergy = 0, playedEnergy = 0;
uint32_t echoFrames = 0, clipped = 0;
int rawPeak = 0, playedPeak = 0;
int16_t *capClean = nullptr;
volatile size_t capCleanWant = 0, capCleanGot = 0;

/** Reads one block: the microphone on the left channel, what the speaker is playing on the right. False when the stream stalls. */
bool readBlock(int16_t *mono, int16_t *played) {
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
    for (size_t i = 0; i < BLOCK; i++) {
        mono[i] = stereo[i * 2];
        played[i] = stereo[i * 2 + 1];
    }
    return true;
}

void push(const int16_t *samples, size_t count) {
    count = min(count, sizeof fifo / sizeof fifo[0] - fifoLen);
    memcpy(fifo + fifoLen, samples, count * sizeof(int16_t));
    fifoLen += count;
}

/** Says how much of its own voice the device took out over the speech that just ended. */
void reportEcho() {
    if (echoFrames >= 10 && logOut) {
        const float down = 10.0f * log10f((float)((rawEnergy + 1) / (cleanEnergy + 1)));
        const float samples = (float)echoFrames * aecChunk;
        logOut->printf("[aec] over %.1f s of speech: own voice down %.0f dB, %.1f ms a frame; microphone rms %.0f peak %d, %.1f%% at the limit; played rms %.0f peak %d\n",
                       samples / 16000.0f, down, aecUs / 1000.0f, sqrt(rawEnergy / samples), rawPeak, 100.0f * clipped / samples,
                       sqrt(playedEnergy / samples), playedPeak);
    }
    rawEnergy = cleanEnergy = playedEnergy = 0;
    echoFrames = clipped = 0;
    rawPeak = playedPeak = 0;
}

/** Takes a raw block and queues it for handling, with the device's own voice removed while it is talking. */
void clean(const int16_t *raw, const int16_t *played) {
    static uint32_t lastPlaying = 0;
    static bool wasActive = false;
    if (speaker::playing()) lastPlaying = millis();
    // Kept on a little after the speech ends: the room is still ringing and the codec still has samples to play.
    // Only worth its time when the wake word may interrupt speech; otherwise nothing listens while the device talks.
    const bool active = aec && echoCancel && bargeIn && lastPlaying && millis() - lastPlaying < 600;
    if (!active) {
        if (wasActive) {
            push(aecIn, aecFill);  // the part of a frame that was still filling
            aecFill = 0;
            reportEcho();
        }
        if (wasActive) codec::quietMic(false);
        wasActive = false;
        push(raw, BLOCK);
        return;
    }
    if (!wasActive) codec::quietMic(true);
    wasActive = true;
    size_t at = 0;
    while (at < BLOCK) {
        const size_t n = min(BLOCK - at, aecChunk - aecFill);
        memcpy(aecIn + aecFill, raw + at, n * sizeof(int16_t));
        memcpy(aecRef + aecFill, played + at, n * sizeof(int16_t));
        aecFill += n;
        at += n;
        if (aecFill < aecChunk) break;
        const uint32_t started = micros();
        aec_process(aec, aecIn, aecRef, aecOut);
        aecUs = micros() - started;
        for (size_t i = 0; i < aecChunk; i++) {
            rawEnergy += (double)aecIn[i] * aecIn[i];
            cleanEnergy += (double)aecOut[i] * aecOut[i];
            playedEnergy += (double)aecRef[i] * aecRef[i];
            rawPeak = max(rawPeak, abs((int)aecIn[i]));
            playedPeak = max(playedPeak, abs((int)aecRef[i]));
            if (abs((int)aecIn[i]) >= 32700) clipped++;
        }
        echoFrames++;
        // Back up to the level the rest of the firmware expects from the microphone at full gain.
        for (size_t i = 0; i < aecChunk; i++) aecOut[i] = (int16_t)constrain((int32_t)aecOut[i] * MAKE_UP, -32768, 32767);
        push(aecOut, aecChunk);
        aecFill = 0;
    }
}

// Loudness around the wake word, used to pick between devices that heard it at once.
float recent = 0;
// The room's own loudness, so the face moves with a voice and not with a fan.
float room = 0;
uint32_t lastNearMiss = 0, duckedAt = 0;

/** Everything that listens to the microphone: the level for the face, the Axis client, the wake word. */
void handle(const int16_t *block) {
    if (capClean && capCleanGot < capCleanWant) {
        const size_t n = min(BLOCK, capCleanWant - capCleanGot);
        memcpy(capClean + capCleanGot, block, n * sizeof(int16_t));
        capCleanGot += n;
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
    // over the speech. Going quiet for the rest of the phrase helps what is left of the echo.
    if (!heard && bargeIn && wakeEnabled && score >= DUCK_SCORE && speaker::playing() && !client->listening()) {
        if (millis() > duckedAt + 1000 && logOut) logOut->printf("[wake] score %.2f over speech, ducking the speaker\n", score);
        duckedAt = millis();
        speaker::duck(1500);
    }
    if (!heard || !wakeEnabled) return;
    if (client->listening()) {
        if (logOut) logOut->printf("[wake] heard it while already recording (score %.2f)\n", score);
        return;
    }
    if (!bargeIn && client->snapshot().turn == axis::Turn::Speaking) {
        ignored++;
        if (logOut) logOut->printf("[wake] heard it over speech but bargeIn is off (score %.2f)\n", score);
        return;
    }
    if (logOut) logOut->printf("[wake] heard it (score %.2f, level %.2f%s)\n", score, recent, speaker::playing() ? ", over speech" : "");
    client->wakeHeard(score, min(1.0f, recent * 4.0f));
}

void task(void *) {
    int16_t raw[BLOCK], played[BLOCK];
    for (;;) {
        if (!readBlock(raw, played)) {
            stalls++;
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }
        blocks++;
        if (capBuf && capGot < capWant) {
            const size_t n = min(BLOCK, capWant - capGot);
            memcpy(capBuf + capGot, raw, n * sizeof(int16_t));
            capGot += n;
        }
        clean(raw, played);
        while (fifoLen >= BLOCK) {
            handle(fifo);
            fifoLen -= BLOCK;
            memmove(fifo, fifo + BLOCK, fifoLen * sizeof(int16_t));
        }
    }
}

}  // namespace

bool loadWakeWord(Print *log) {
    // A wake word Axis sent, kept on the device, is tried first; the one built into the firmware is the fallback.
    static axis::StoredWakeModel stored;
    static wake::Model other;
    const bool have = axis::loadStoredWakeModel(stored, log);
    if (have) {
        other.data = stored.data;
        other.length = stored.length;
        other.name = stored.name.c_str();
        other.cutoffPercent = stored.cutoffPercent;
        other.window = stored.window;
    }
    modelLoaded = wake::begin(log, have ? &other : nullptr);
    axis::reportWakeModel(have && wake::usingCustom());
    if (have && !wake::usingCustom()) heap_caps_free(stored.data);
    return modelLoaded;
}

bool beginEchoCancel(Print *log) {
    const uint32_t internal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL), spi = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    aec_handle_t *made = aec_create(16000, 4, 1, AEC_MODE_SR_HIGH_PERF);
    if (made) {
        aecChunk = aec_get_chunksize(made);
        const size_t bytes = aecChunk * sizeof(int16_t);
        aecIn = (int16_t *)heap_caps_aligned_alloc(16, bytes, MALLOC_CAP_SPIRAM);
        aecRef = (int16_t *)heap_caps_aligned_alloc(16, bytes, MALLOC_CAP_SPIRAM);
        aecOut = (int16_t *)heap_caps_aligned_alloc(16, bytes, MALLOC_CAP_SPIRAM);
        if (!aecIn || !aecRef || !aecOut || aecChunk + BLOCK * 2 > sizeof fifo / sizeof fifo[0]) {
            aec_destroy(made);
            made = nullptr;
        }
    }
    // Set last: the microphone task starts using it the moment it is not null.
    aec = made;
    if (log) {
        if (aec) log->printf("[aec] echo canceller ready: %u samples a frame, took %u bytes of internal memory and %u of the large memory\n",
                             (unsigned)aecChunk, (unsigned)(internal - heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
                             (unsigned)(spi - heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));
        else log->println("[aec] echo canceller did not start; the microphone is used as it is");
    }
    return aec != nullptr;
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
// The canceller takes memory, so it is only started once both settings ask for it, and then it stays.
static void wantEchoCancel() {
    static bool tried = false;
    if (bargeIn && echoCancel && !aec && !tried) {
        tried = true;
        beginEchoCancel(logOut);
    }
}
void setBargeIn(bool enabled) {
    bargeIn = enabled;
    wantEchoCancel();
}
void setEchoCancel(bool enabled) {
    echoCancel = enabled;
    wantEchoCancel();
}
void captureClean(int16_t *buffer, size_t samples) {
    capCleanGot = 0;
    capClean = buffer;
    capCleanWant = samples;
}
float level() { return currentLevel; }

Stats stats() {
    Stats s;
    s.blocks = blocks;
    s.stalls = stalls;
    s.detections = wake::detections();
    s.ignored = ignored;
    s.inferenceUs = wake::lastInferenceUs();
    s.aecUs = aecUs;
    s.peakPercent = wake::peakPercent();
    return s;
}

}  // namespace mic
