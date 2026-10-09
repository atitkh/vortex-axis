#pragma once

// Shared client core for VorteX Axis devices: Wi-Fi with a setup network,
// pairing, the socket to Axis, settings sync and a serial console. It runs in
// its own task so a slow or missing network never stalls the board's display.
//
// A board describes itself with an `axis::Identity`, starts the client once and
// then polls `snapshot()` to decide what to show.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <functional>
#include "log_buffer.h"

/** Version of the client protocol this core speaks. See protocol/src/version.ts. */
#define AXIS_PROTOCOL_VERSION 1

/** Firmware version, without a leading "v". Reported to Axis on connect. */
#define AXIS_FIRMWARE_VERSION "0.11.1"

namespace axis {

/** How far the device has got towards a working connection. */
enum class Link : uint8_t {
    Starting,
    /** No usable Wi-Fi: the device is running its own setup network. */
    Setup,
    WifiConnecting,
    /** On Wi-Fi, but it has no pairing and no code to pair with. */
    Unpaired,
    Pairing,
    /** Paired, trying to reach Axis. */
    Connecting,
    Online,
};

enum class Turn : uint8_t { Idle, Listening, Transcribing, Thinking, Speaking, Error };

/**
 * A setting the board reads, described so the Axis admin page can draw an
 * editor for it. All text must stay valid for the life of the program, so use
 * string literals. Toggles are 1 and 0.
 */
struct SettingDef {
    const char *key;
    const char *label;
    /** "number", "text", "toggle" or "choice". */
    const char *kind;
    /** Heading the editor files it under. */
    const char *group;
    const char *help;
    /** What the board uses when nothing is set, as text. Sent as a number unless `kind` is "text". */
    const char *fallback;
    /** Range of a number. Both 0 means no limit. */
    int32_t min, max;
    const char *unit;
    /** The values of a choice, comma separated. */
    const char *options;
};

/** Something a person can ask the board to do from the admin page. Handled in `onCommand`. */
struct ActionDef {
    const char *name;
    const char *label;
    const char *help;
    /** The admin page asks before sending it. */
    bool confirm;
};

struct Identity {
    /** Client type, the name Axis groups settings under. */
    const char *type;
    /** Capabilities from protocol/src/common.ts, for example {"screen", "speaker"}. */
    const char *const *capabilities;
    size_t capabilityCount;
    /** What the admin page offers for this board. Optional. `diag` and `reboot` are always added. */
    const SettingDef *settings = nullptr;
    size_t settingCount = 0;
    const ActionDef *actions = nullptr;
    size_t actionCount = 0;
};

/** Everything a board needs to draw its state. Copied out under a lock. */
struct Snapshot {
    /** Changes whenever anything below does. */
    uint32_t revision = 0;
    Link link = Link::Starting;
    Turn turn = Turn::Idle;
    /** Counts up whenever Axis sends new settings. */
    uint32_t settingsRevision = 0;
    /** Upstream health as Axis reports it; true also while unknown. */
    bool openclawUp = true, sttUp = true, ttsUp = true;
    /** Name Axis gave this device. Empty before pairing. */
    String name;
    /** Name of the setup network while `link` is Setup. */
    String setupNetwork;
    /** Address of the device's own setup page. */
    String address;
    /** One line explaining the current state, mainly problems. */
    String note;
    String transcript;
    String reply;
    /** A question Axis is waiting for an answer to. `askId` is empty when there is none. */
    String askId, question;
    /** The answers offered. None means the question is open and is answered by voice. */
    String choices[6];
    uint8_t choiceCount = 0;
    /** How far a firmware update has got, 0 to 100. Negative when none is running. */
    int8_t updatePercent = -1;
    /** The timer due soonest, as Axis last told it. `timerEndsAt` is in `millis()`; `timerCount` 0 means none. */
    String timerLabel;
    uint32_t timerEndsAt = 0;
    uint8_t timerCount = 0;
};

/**
 * Where speech from Axis goes. A board with a speaker implements this and hands
 * it to the client. Every call comes from the client's task and must return
 * quickly; the board plays the audio from a task of its own.
 */
class AudioSink {
  public:
    /** A new stream of 16-bit mono PCM at `sampleRate` follows. Drops anything still queued. */
    virtual void streamBegin(uint32_t sampleRate) = 0;
    virtual void streamWrite(const uint8_t *data, size_t length) = 0;
    /** No more audio is coming for this stream. What is queued still plays. */
    virtual void streamEnd() = 0;
    /** Go quiet now and drop what is queued. */
    virtual void stop() = 0;
    /** True once sound from the current stream has actually started. */
    virtual bool started() = 0;
    /** True when an ended stream has finished playing, to the last sample. */
    virtual bool drained() = 0;
    /** How much audio the board can queue, in milliseconds. Axis never sends further ahead than this. */
    virtual uint32_t bufferMs() = 0;
};

/**
 * A command from Axis. Fill `payload` with flat values and return true, or
 * return false for a command the board does not implement.
 */
using CommandHandler = std::function<bool(const char *name, JsonObjectConst params, JsonObject payload)>;

class Client {
  public:
    /** Starts the client task. `console` is optional; it gets logs and takes commands. */
    void begin(const Identity &identity, Stream *console = nullptr);

    /** Gives the client somewhere to play speech. Call before `begin`. */
    void setAudioSink(AudioSink *sink) { sink_ = sink; }

    Snapshot snapshot();
    /** Cheap check for whether `snapshot()` would return anything new. */
    uint32_t revision() const { return revision_; }

    /** A synced setting, or the fallback when Axis has not set it. */
    String setting(const char *key, const char *fallback = "");
    long settingInt(const char *key, long fallback);

    void onCommand(CommandHandler handler) { commandHandler_ = handler; }

    /** A board's own serial commands. Called with the first word and the rest of a line the core did not recognise; return true if handled. */
    using ConsoleHandler = std::function<bool(const String &word, const String &rest)>;
    void onConsole(ConsoleHandler handler) { consoleHandler_ = handler; }

    /** Serves this log at `/logs` on the device's web page. Call before `begin`. */
    void setLogSource(LogBuffer *log) { logBuffer_ = log; }

    /**
     * Called when the device starts listening for a turn: a wake word Axis
     * accepted, a tap, or a follow-up after a spoken reply. A board uses it to
     * play a cue. The microphone is kept deaf for `cueMs` afterwards so the
     * cue is not taken for speech. Called from the client's task or the
     * caller's of `startListening`; it must return quickly.
     */
    void onListenStart(std::function<void()> cue, uint32_t cueMs) {
        listenCue_ = cue;
        cueMs_ = cueMs;
    }

    /** Asks Axis to stop the current reply. Safe to call from any task. */
    void interrupt() { wantInterrupt_ = true; }
    /** Answers the open question with the choice at `index`, as picked on the screen. Safe to call from any task. */
    void answer(uint8_t index) { wantAnswer_ = (int8_t)index; }

    // --- microphone ------------------------------------------------------
    // For boards with the `mic` capability. These may be called from the
    // board's microphone task; the client task does the sending.

    /**
     * Mono 16 kHz samples from the microphone, in blocks of about 10 ms. Call
     * it for EVERY block, recording or not: between recordings it follows how
     * loud the room is, which is what tells speech from a fan.
     */
    void feedAudio(const int16_t *samples, size_t count);

    /** The wake word was just heard. Axis decides which device answers; audio is kept meanwhile. */
    void wakeHeard(float score, float level);

    /** Starts a recording without a wake word (a tap). False when not connected to Axis or already recording. */
    bool startListening();

    /** Ends the recording now and sends what was said, or with `discard` throws it away. */
    void stopListening(bool discard = false);

    /** True from a wake or a tap until the recording has gone to Axis. */
    bool listening() const { return recording_; }

    /** Numbers for tuning. All are mean absolute sample values. */
    struct MicStats {
        uint32_t floor = 0, onset = 0, peak = 0, dropped = 0;
    };
    MicStats micStats();

  private:
    struct Impl;
    Impl *impl_ = nullptr;
    volatile uint32_t revision_ = 0;
    volatile bool wantInterrupt_ = false;
    volatile int8_t wantAnswer_ = -1;
    volatile bool recording_ = false;
    volatile bool online_ = false;
    /** True while the device is playing Axis's voice; its own sound must not pass for the room. */
    volatile bool speaking_ = false;
    CommandHandler commandHandler_;
    ConsoleHandler consoleHandler_;
    std::function<void()> listenCue_;
    uint32_t cueMs_ = 0;
    LogBuffer *logBuffer_ = nullptr;
    AudioSink *sink_ = nullptr;
    friend struct Impl;
};

/**
 * A wake word model the device was sent by Axis and keeps in its own storage,
 * read into memory. A board with a wake word asks for it at start, before
 * `Client::begin`, and hands it to its detector.
 */
struct StoredWakeModel {
    /** In PSRAM, aligned for the model reader. Stays allocated; free it only if the detector refuses it. */
    uint8_t *data = nullptr;
    size_t length = 0;
    String id, name;
    uint8_t cutoffPercent = 90, window = 5;
};

/**
 * Reads the stored wake word, if there is one worth trying. False with
 * nothing stored, with a file that does not match what Axis sent, or when the
 * device has started with it twice without reaching Axis (it is then left
 * alone until Axis sends another). Calling this is also what tells the client
 * core that this board takes wake words from Axis at all.
 */
bool loadStoredWakeModel(StoredWakeModel &out, Print *log = nullptr);
/** Tell the core how that went: true when the stored model is the one running, false when the detector fell back to its own. */
void reportWakeModel(bool storedIsRunning);

/** Splits "axis://host:port/CODE" into a base URL and a pairing code. */
bool parseSetupString(const String &input, String &baseUrl, String &code);

}  // namespace axis
