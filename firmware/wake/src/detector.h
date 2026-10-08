#pragma once

// The wake word detector: 16 kHz mono audio in, "heard it" out.
//
// Audio goes through the TFLM microfrontend (features.h) to 40 int8 features
// per 10 ms slice. Every third slice the streaming model runs once; the last
// few answers are averaged and compared with a cutoff. The model and its
// tuning come from one generated header (tools/gen_model_header.py), so they
// cannot disagree.

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

namespace wake {

/** Loads the built-in model. False when it does not fit in memory or is not usable. `log` is optional. */
bool begin(Print *log = nullptr);
bool ready();

/**
 * Feeds mono 16 kHz samples. Any count works; the detector slices them into
 * 10 ms steps itself. True when the wake word was just heard. After a hit it
 * stays quiet until the score has clearly dropped, so one phrase fires once.
 * `score` receives the smoothed probability, 0 to 1.
 */
bool feed(const int16_t *samples, size_t count, float *score = nullptr);

/** Cutoff in percent, 50 to 99, or 0 for the model's own. */
void setSensitivity(uint8_t percent);
uint8_t cutoffPercent();

/** Forgets the audio seen so far. Call after a gap in the stream. */
void reset();

const char *modelName();
/** Time the last inference took, in microseconds. */
uint32_t lastInferenceUs();
/** Highest smoothed score since boot, in percent. Shows the model is scoring at all. */
uint8_t peakPercent();
uint32_t arenaSize();
uint32_t arenaUsed();
uint32_t detections();

}  // namespace wake
