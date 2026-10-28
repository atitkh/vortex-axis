#pragma once

// How loud the wake word was over the device's own room noise, for Axis to
// pick the nearest device when several heard it.
//
// Header-only and free of hardware calls, so it can be tried on a desktop.
//
// Both figures are the mean absolute sample value of a block, so their ratio
// does not depend on the microphone's gain: raising the gain 6 dB raises the
// speech and the room alike. The level is that ratio in decibels over
// LEVEL_RANGE_DB, 0 to 1:
//
//   level = clamp(20 * log10(speech / room) / LEVEL_RANGE_DB, 0, 1)
//
// - speech: the loudest of a ~100 ms running average over the last ~1.3 s,
//   which spans the wake word itself.
// - room: the lowest of the board's room level over the last ~2.6 s. The room
//   level creeps up while somebody talks, so the lowest recent figure is the
//   room as it was before the wake word began.
//
// A device twice as far away hears the speech about 6 dB quieter (in the
// open; less in a reverberant room), which is 0.15 lower here, whatever its
// gain. Two devices in rooms of different noise are compared on how far the
// voice stood out where each of them is, which is also what decides how well
// each will hear what follows.

#include <math.h>
#include <stdint.h>

namespace axis {

class WakeLevel {
  public:
    /** Decibels over the room that make a level of 1. */
    static constexpr float LEVEL_RANGE_DB = 40.0f;
    /** Blocks per slot of history: 16 blocks of 10 ms. */
    static constexpr uint16_t SLOT_BLOCKS = 16;
    /** Slots of speech history (~1.3 s) and of room history (~2.6 s). */
    static constexpr uint8_t SPEECH_SLOTS = 8, ROOM_SLOTS = 16;

    /** The level for a speech and room figure, as above. */
    static float levelOf(float speech, float room) {
        if (!(speech > 0.0f)) return 0.0f;
        // A digitally silent room would make any sound infinitely loud.
        const float floor = room > 1.0f ? room : 1.0f;
        const float level = 20.0f * log10f(speech / floor) / LEVEL_RANGE_DB;
        return level < 0.0f ? 0.0f : level > 1.0f ? 1.0f : level;
    }

    /** One block: its mean absolute sample value and the board's room level after it. */
    void feed(float average, float roomLevel) {
        smooth_ += (average - smooth_) * 0.1f;
        if (blocks_ == 0) {
            speech_[slot_ % SPEECH_SLOTS] = 0.0f;
            room_[slot_ % ROOM_SLOTS] = roomLevel;
            if (filled_ < ROOM_SLOTS) filled_++;
        }
        float &speech = speech_[slot_ % SPEECH_SLOTS];
        if (smooth_ > speech) speech = smooth_;
        float &room = room_[slot_ % ROOM_SLOTS];
        if (roomLevel < room) room = roomLevel;
        if (++blocks_ >= SLOT_BLOCKS) {
            blocks_ = 0;
            slot_++;
        }
    }

    /** The wake word's loudness: the loudest recent running average. */
    float speech() const {
        float most = 0.0f;
        const uint8_t n = filled_ < SPEECH_SLOTS ? filled_ : SPEECH_SLOTS;
        for (uint8_t i = 0; i < n; i++) most = speech_[i] > most ? speech_[i] : most;
        return most;
    }

    /** The room before the wake word: the lowest recent room level. */
    float room() const {
        if (filled_ == 0) return 0.0f;
        float least = room_[0];
        for (uint8_t i = 1; i < filled_; i++) least = room_[i] < least ? room_[i] : least;
        return least;
    }

    /** How far the speech stood out, in decibels. */
    float decibels() const {
        const float r = room() > 1.0f ? room() : 1.0f;
        return speech() > 0.0f ? 20.0f * log10f(speech() / r) : 0.0f;
    }

    float level() const { return levelOf(speech(), room()); }

  private:
    float smooth_ = 0.0f;
    float speech_[SPEECH_SLOTS] = {};
    float room_[ROOM_SLOTS] = {};
    uint8_t filled_ = 0;
    uint16_t blocks_ = 0;
    uint32_t slot_ = 0;
};

}  // namespace axis
