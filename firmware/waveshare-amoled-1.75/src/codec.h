#pragma once

// The ES8311 (playback) and ES7210 (microphones) and the one I2S stream they share. The speaker and the
// microphones use one full-duplex stream at 16 kHz, so this is the one place that starts it; each of them
// only reads or only writes.
//
// The stream runs 32-bit stereo frames. Going out, each 32-bit slot carries a 16-bit sample in its top half
// (the ES8311 takes the first 16 bits). Coming in, the ES7210 with four inputs on puts two 16-bit samples in
// each slot: MIC1 then MIC3 on the left, MIC2 then MIC4 on the right. MIC1 and MIC2 are the two microphones;
// MIC3 is wired to the ES8311's output, which is what the echo canceller needs, already lined up with them.
// MIC4 is not connected. (Waveshare's own code reads the same thing as four TDM slots at 24 kHz.)

#include <ESP_I2S.h>

namespace codec {

/** Starts I2S, configures both chips, and enables the amplifier. False when either chip does not answer. */
bool begin();

/**
 * Turns the microphones' analog gain down by `MIC_QUIET_DB` while the device itself talks, and back up after.
 * At full gain the speaker next to them drives them into their limit, and nothing can be taken out of that.
 */
void quietMic(bool quiet);
const int MIC_QUIET_DB = 24;

/** The shared stream. The speaker writes to it; the microphone reads from it. */
I2SClass &i2s();

/** Sample rate of the stream, fixed. Audio at other rates is converted by whoever uses it. */
const uint32_t RATE = 16000;

}  // namespace codec
