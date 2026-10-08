#pragma once

// Decides when somebody has started and stopped talking, from loudness alone.
//
// It runs on the client because Axis must never receive audio before it is
// asked for. Header-only and free of hardware calls, so it can be tried on a
// desktop as well.
//
// Loudness is the mean absolute sample value of a short block. Two ideas keep
// it honest in a real room:
//  - The room's own level is tracked all the time the device is NOT recording,
//    rising slowly and falling fast, so a fan raises the bar instead of
//    sounding like a person. A recording starts from that figure instead of
//    measuring the first words, which would set the bar above the voice.
//  - Starting to speak is easier than carrying on: a recording that has begun
//    is only ended by quiet well below the speech level.

#include <stdint.h>

namespace axis {

class Vad {
  public:
    enum class Event : uint8_t {
        None,
        /** Speech began. Audio from just before this is worth keeping. */
        Onset,
        /** Speech ended: quiet lasted long enough. */
        Silence,
        /** Nobody spoke within the allowed time. */
        NoSpeech,
        /** Speech went on for the longest allowed time. */
        TooLong,
    };

    /** Loudness steps. Tuned for the 16 kHz microphone path of the first board; boards may adjust. */
    struct Tuning {
        /** Speech starts above `floor * onsetFactor + onsetBase`. */
        uint32_t onsetFactor = 3, onsetBase = 120;
        /** Speech carries on above `floor * keepFactor + keepBase`. */
        uint32_t keepFactor = 2, keepBase = 60;
        /** Blocks in a row that must be loud before it counts as speech. A click is one block. */
        uint8_t onsetBlocks = 2;
    };

    void setTuning(const Tuning &t) { tuning_ = t; }

    /** Follows the room while nothing is being recorded. */
    void observeRoom(uint32_t loudness) {
        if (loudness > floor_) floor_ += (loudness - floor_) / 256.0f;  // about 2.5 s at 100 blocks a second
        else floor_ -= (floor_ - loudness) / 16.0f;                     // about 0.15 s
    }

    /** Starts watching for speech. Times are in milliseconds; 0 means no limit. */
    void begin(uint32_t onsetTimeoutMs, uint32_t silenceMs, uint32_t maxMs) {
        onsetTimeout_ = onsetTimeoutMs;
        silence_ = silenceMs;
        max_ = maxMs;
        waited_ = spoken_ = quiet_ = 0;
        loudRun_ = 0;
        speaking_ = false;
        peak_ = 0;
    }

    /** One block of audio, `blockMs` long. */
    Event step(uint32_t loudness, uint32_t blockMs) {
        if (loudness > peak_) peak_ = loudness;
        if (!speaking_) {
            waited_ += blockMs;
            if (loudness > onsetThreshold()) {
                if (++loudRun_ >= tuning_.onsetBlocks) {
                    speaking_ = true;
                    spoken_ = quiet_ = 0;
                    return Event::Onset;
                }
            } else {
                loudRun_ = 0;
                // Keep following the room downwards, so a noise burst at the start does not leave the bar too high.
                if (loudness < floor_) observeRoom(loudness);
            }
            if (onsetTimeout_ && waited_ >= onsetTimeout_) return Event::NoSpeech;
            return Event::None;
        }
        spoken_ += blockMs;
        if (loudness > keepThreshold()) quiet_ = 0;
        else quiet_ += blockMs;
        if (quiet_ >= silence_) return Event::Silence;
        if (max_ && spoken_ >= max_) return Event::TooLong;
        return Event::None;
    }

    bool speaking() const { return speaking_; }
    uint32_t floor() const { return (uint32_t)floor_; }
    /** Loudest block of the current recording. */
    uint32_t peak() const { return peak_; }
    /** Milliseconds of speech so far in the current recording, quiet at the end included. */
    uint32_t spokenMs() const { return spoken_; }
    uint32_t onsetThreshold() const { return (uint32_t)(floor_ * tuning_.onsetFactor) + tuning_.onsetBase; }
    uint32_t keepThreshold() const { return (uint32_t)(floor_ * tuning_.keepFactor) + tuning_.keepBase; }

  private:
    Tuning tuning_;
    float floor_ = 200;  // a guess until the room has been listened to
    uint32_t onsetTimeout_ = 0, silence_ = 900, max_ = 0;
    uint32_t waited_ = 0, spoken_ = 0, quiet_ = 0, peak_ = 0;
    uint8_t loudRun_ = 0;
    bool speaking_ = false;
};

/** Mean absolute value of a block: a cheap loudness that needs no square root. */
inline uint32_t loudnessOf(const int16_t *samples, unsigned count) {
    if (!count) return 0;
    uint32_t sum = 0;
    for (unsigned i = 0; i < count; i++) sum += samples[i] < 0 ? -samples[i] : samples[i];
    return sum / count;
}

}  // namespace axis
