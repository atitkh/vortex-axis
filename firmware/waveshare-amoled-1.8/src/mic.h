#pragma once

// The microphone: ES8311 over the same I2S stream the speaker uses. A task of
// its own reads 10 ms blocks, hands every one to the Axis client (which follows
// the room and records when asked) and runs the wake word detector.

#include <Arduino.h>
#include "axis_client.h"

namespace mic {

/** Loads the wake word model. Do this early, before Wi-Fi has taken its share of internal memory. */
bool loadWakeWord(Print *log);

/** Starts the echo canceller. Do this early too: it wants memory in one piece. False leaves the microphone as it is. */
bool beginEchoCancel(Print *log);

/** Starts the microphone task. The client must already be running. */
bool begin(axis::Client &client, Print *log);

/** The `wakeListen` setting: false leaves the microphone to tap-to-talk only. */
void setWakeEnabled(bool enabled);
/** Wake word cutoff in percent, or 0 for the model's own. */
void setWakeSensitivity(uint8_t percent);
/** Whether the wake word may interrupt speech. When false it is ignored while the speaker is playing. */
void setBargeIn(bool enabled);

/** The `echoCancel` setting: false hands the microphone on untouched while the device talks. */
void setEchoCancel(bool enabled);
/** Diagnostics: as `capture`, but after echo cancelling. */
void captureClean(int16_t *buffer, size_t samples);

/** Diagnostics: records the next `samples` raw mic samples into `buffer`. `captureDone()` turns true when full. */
void capture(int16_t *buffer, size_t samples);
bool captureDone();

/** How loud the room is right now, 0 to 1, smoothed. */
float level();

struct Stats {
    uint32_t blocks = 0, stalls = 0, detections = 0, ignored = 0;
    uint32_t inferenceUs = 0;
    /** Time the echo canceller took over its last frame, in microseconds. */
    uint32_t aecUs = 0;
    uint8_t peakPercent = 0;
};
Stats stats();

}  // namespace mic
