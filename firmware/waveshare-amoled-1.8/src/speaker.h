#pragma once

// The speaker: ES8311 codec over I2S. Speech from Axis is queued here and
// played by a task of its own, so neither the network nor the display can make
// it stutter.

#include <Arduino.h>
#include "axis_client.h"

namespace speaker {

/** Starts the codec and the playback task. False when the codec does not answer. */
bool begin();

/** The sink to hand to the Axis client. */
axis::AudioSink *sink();

/** 0 to 100, as the `volume` setting. */
void setVolume(int volume);

/** True while sound is coming out. */
bool playing();

/** Loudness of what is playing right now, 0 to 1, before the volume setting. */
float level();

/** How long the listening cue takes to leave the speaker, in milliseconds. The microphone must ignore this long. */
const uint32_t CUE_MS = 240;

/** A soft rising cue that says the device is now listening. */
void cue();

/** A short two-note chime, to prove the speaker works without Axis. */
void chime();

}  // namespace speaker
