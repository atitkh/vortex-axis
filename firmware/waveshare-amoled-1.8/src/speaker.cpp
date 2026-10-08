#include "speaker.h"

#include <esp_heap_caps.h>
#include "codec.h"

namespace speaker {

namespace {

// I2S always runs at this rate and incoming speech is resampled to it. The
// microphone shares the clock, so changing the rate for playback would break
// listening while the device speaks.
const uint32_t RATE = codec::RATE;
// Room for four seconds; Axis is told two, which leaves slack for a late start.
const size_t RING_SAMPLES = RATE * 4;
const uint32_t BUFFER_MS = 2000;
// Start once this much is queued, so the first words do not stutter.
const size_t START_SAMPLES = RATE * 150 / 1000;
const size_t CHUNK = 240;
// What the I2S driver still holds after a write returns: 6 buffers of 240 frames.
const size_t DRIVER_TAIL = 1440;
// While the wake word may be being said over the speech, the speech drops to this fraction of its volume.
const float DUCK_GAIN = 0.12f;

// One writer (the Axis client's task) and one reader (the playback task).
int16_t *ring = nullptr;
volatile size_t head = 0, tail = 0;

volatile bool streamOpen = false;   // more audio may still arrive
volatile bool wantStop = false;
volatile bool isStarted = false, isDrained = true, isPlaying = false;
volatile float currentLevel = 0;
volatile int gainQ15 = 0;
volatile uint32_t duckUntil = 0;
volatile bool wantChime = false, wantCue = false;

// Resampler: a windowed-sinc low-pass FIR, evaluated at the exact output time. Anything
// above the output's Nyquist (8 kHz) must be removed BEFORE dropping samples, or it folds
// down into the audible range as a harsh buzz. Linear interpolation does not do that.
const int TAPS = 24, HALF = TAPS / 2, PHASES = 128;
float firTable[PHASES][TAPS];
uint32_t inRate = RATE;
float position = 0;
// The last TAPS input samples twice over, so the newest window is always contiguous.
float history[2 * TAPS];
int historyAt = 0;

/** Builds the filter for `rate`: cutoff just under the lower of the two Nyquist frequencies. */
void buildFilter(uint32_t rate) {
    const float fc = (rate > RATE ? (float)RATE / rate : 1.0f) * 0.88f;
    for (int p = 0; p < PHASES; p++) {
        const float pos = p / (float)PHASES;
        float sum = 0;
        for (int j = 0; j < TAPS; j++) {
            const float d = j - (HALF - 1) - pos;
            const float x = fc * d;
            const float sinc = fabsf(x) < 1e-6f ? 1.0f : sinf(PI * x) / (PI * x);
            const float window = fabsf(d) < HALF ? 0.5f + 0.5f * cosf(PI * d / HALF) : 0.0f;
            firTable[p][j] = fc * sinc * window;
            sum += firTable[p][j];
        }
        for (int j = 0; j < TAPS; j++) firTable[p][j] /= sum;  // unity gain at DC
    }
}

size_t queued() { return (head + RING_SAMPLES - tail) % RING_SAMPLES; }

void push(int16_t sample) {
    const size_t next = (head + 1) % RING_SAMPLES;
    if (next == tail) return;  // full: Axis paces what it sends, so this means something is already wrong
    ring[head] = sample;
    head = next;
}

/** Sends mono samples to the codec, which wants both channels. */
void play(const int16_t *mono, size_t count) {
    static int16_t stereo[CHUNK * 2];
    // Ducked: much quieter, eased in and out over a few chunks so it does not click.
    static float eased = 0;
    const float target = (int32_t)(duckUntil - millis()) > 0 ? gainQ15 * DUCK_GAIN : (float)gainQ15;
    if (eased == 0) eased = target;
    eased += (target - eased) * 0.5f;
    const int gain = (int)eased;
    int peak = 0;
    for (size_t i = 0; i < count; i++) {
        peak = max(peak, abs((int)mono[i]));
        const int16_t out = (int16_t)(((int32_t)mono[i] * gain) >> 15);
        stereo[2 * i] = out;
        stereo[2 * i + 1] = out;
    }
    codec::i2s().write((const uint8_t *)stereo, count * 4);
    // Rise at once, fall slowly, so the face follows syllables without flickering.
    const float now = min(1.0f, peak / 14000.0f);
    currentLevel = now > currentLevel ? now : currentLevel * 0.82f + now * 0.18f;
}

void playSilence(size_t frames) {
    static const int16_t zeros[CHUNK] = {0};
    for (size_t done = 0; done < frames; done += CHUNK) play(zeros, min(CHUNK, frames - done));
}

void playChime() {
    static int16_t tone[CHUNK];
    float phase = 0;
    for (int note = 0; note < 2; note++) {
        const float step = 2.0f * PI * (note ? 880.0f : 660.0f) / RATE;
        const int chunks = RATE * 140 / 1000 / CHUNK;
        for (int c = 0; c < chunks; c++) {
            for (size_t i = 0; i < CHUNK; i++, phase += step) {
                // Fade each note in and out; a note that starts or ends abruptly clicks.
                const int at = c * CHUNK + i, total = chunks * CHUNK;
                const float fade = min(1.0f, min(at, total - at) / 320.0f);
                tone[i] = (int16_t)(9000.0f * fade * sinf(phase));
            }
            play(tone, CHUNK);
        }
    }
    playSilence(DRIVER_TAIL);
}

/** A short, soft rising pair of notes: "go ahead, I'm listening". Lasts CUE_MS including the driver tail. */
void playCue() {
    static int16_t tone[CHUNK];
    float phase = 0;
    for (int note = 0; note < 2; note++) {
        const float step = 2.0f * PI * (note ? 1180.0f : 880.0f) / RATE;
        const int chunks = RATE * 60 / 1000 / CHUNK;
        for (int c = 0; c < chunks; c++) {
            for (size_t i = 0; i < CHUNK; i++, phase += step) {
                const int at = c * CHUNK + i, total = chunks * CHUNK;
                const float fade = min(1.0f, min(at, total - at) / 160.0f);
                tone[i] = (int16_t)(6000.0f * fade * sinf(phase));
            }
            play(tone, CHUNK);
        }
    }
    playSilence(DRIVER_TAIL);
}

void playbackTask(void *) {
    static int16_t chunk[CHUNK];
    bool running = false;
    for (;;) {
        if (wantStop) {
            tail = head;
            wantStop = false;
            running = false;
            isPlaying = false;
            isDrained = true;
            currentLevel = 0;
        }
        if (wantCue) {
            wantCue = false;
            isPlaying = true;
            playCue();
            isPlaying = false;
            currentLevel = 0;
        }
        if (wantChime) {
            wantChime = false;
            isPlaying = true;
            playChime();
            isPlaying = false;
            currentLevel = 0;
        }
        const size_t have = queued();
        if (!running) {
            if (have >= START_SAMPLES || (have > 0 && !streamOpen)) {
                running = true;
                isPlaying = true;
                isStarted = true;
            } else {
                if (have == 0 && !streamOpen) isDrained = true;  // a stream that ended with nothing in it
                vTaskDelay(pdMS_TO_TICKS(5));
                continue;
            }
        }
        if (have == 0) {
            if (streamOpen) {
                // The next sentence is still being synthesized. The driver plays silence meanwhile.
                currentLevel = currentLevel * 0.8f;
                vTaskDelay(pdMS_TO_TICKS(5));
                continue;
            }
            // A write returns when the driver has COPIED the audio, not played it. Pushing
            // this much silence through is what guarantees the last word left the speaker.
            playSilence(DRIVER_TAIL);
            running = false;
            isPlaying = false;
            currentLevel = 0;
            isDrained = true;
            continue;
        }
        const size_t count = min(have, CHUNK);
        for (size_t i = 0; i < count; i++) chunk[i] = ring[(tail + i) % RING_SAMPLES];
        tail = (tail + count) % RING_SAMPLES;
        play(chunk, count);
    }
}

class Sink : public axis::AudioSink {
  public:
    void streamBegin(uint32_t sampleRate) override {
        stop();
        const uint32_t rate = sampleRate >= 8000 ? sampleRate : RATE;
        if (rate != inRate) {
            inRate = rate;
            if (inRate != RATE) buildFilter(inRate);
        }
        position = 0;
        memset(history, 0, sizeof history);
        historyAt = 0;
        isStarted = false;
        isDrained = false;
        streamOpen = true;
    }

    void streamWrite(const uint8_t *data, size_t length) override {
        if (!streamOpen) return;
        const int16_t *samples = (const int16_t *)data;
        if (inRate == RATE) {
            for (size_t i = 0; i < length / 2; i++) push(samples[i]);
            return;
        }
        const float step = (float)inRate / RATE;
        for (size_t i = 0; i < length / 2; i++) {
            history[historyAt] = history[historyAt + TAPS] = samples[i];
            historyAt = (historyAt + 1) % TAPS;
            while (position < 1.0f) {
                const float *h = firTable[(int)(position * PHASES)];
                const float *w = &history[historyAt];  // oldest first, newest last
                float acc = 0;
                for (int j = 0; j < TAPS; j++) acc += w[j] * h[j];
                push((int16_t)constrain((int)lroundf(acc), -32768, 32767));
                position += step;
            }
            position -= 1.0f;
        }
    }

    void streamEnd() override { streamOpen = false; }

    void stop() override {
        streamOpen = false;
        wantStop = true;
        // Wait for the playback task to drop its queue, so a new stream starts clean.
        for (int i = 0; i < 40 && wantStop; i++) delay(5);
    }

    bool started() override { return isStarted; }
    bool drained() override { return isDrained && !streamOpen; }
    uint32_t bufferMs() override { return BUFFER_MS; }
};

Sink theSink;

}  // namespace

bool begin() {
    ring = (int16_t *)heap_caps_malloc(RING_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM);
    if (!ring) return false;

    if (!codec::begin()) return false;

    setVolume(60);
    xTaskCreatePinnedToCore(playbackTask, "speaker", 4096, nullptr, 5, nullptr, 1);
    return true;
}

axis::AudioSink *sink() { return &theSink; }

void setVolume(int volume) {
    // Squared, because loudness is not heard in a straight line: 50 should sound like half.
    const float v = constrain(volume, 0, 100) / 100.0f;
    gainQ15 = (int)(v * v * 32767.0f);
}

bool playing() { return isPlaying; }
float level() { return currentLevel; }
void duck(uint32_t ms) { duckUntil = millis() + ms; }
void chime() { wantChime = true; }
void cue() { wantCue = true; }

}  // namespace speaker
