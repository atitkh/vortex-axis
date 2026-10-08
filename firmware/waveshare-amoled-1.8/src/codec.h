#pragma once

// The ES8311 codec and the I2S bus it hangs on. The speaker and the microphone
// share one full-duplex stream at 16 kHz, so this is the one place that starts
// it; each of them only reads or only writes.

#include <ESP_I2S.h>

namespace codec {

/** Starts I2S, configures the codec for playback and capture, and enables the amplifier. False when the codec does not answer. */
bool begin();

/** The shared stream. The speaker writes to it; the microphone reads from it. */
I2SClass &i2s();

/** Sample rate of the stream, fixed. Audio at other rates is converted by whoever uses it. */
const uint32_t RATE = 16000;

}  // namespace codec
