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

/** Version of the client protocol this core speaks. See protocol/src/version.ts. */
#define AXIS_PROTOCOL_VERSION 1

/** Firmware version, without a leading "v". Reported to Axis on connect. */
#define AXIS_FIRMWARE_VERSION "0.3.0"

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

struct Identity {
    /** Client type, the name Axis groups settings under. */
    const char *type;
    /** Capabilities from protocol/src/common.ts, for example {"screen", "speaker"}. */
    const char *const *capabilities;
    size_t capabilityCount;
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

    /** Asks Axis to stop the current reply. Safe to call from any task. */
    void interrupt() { wantInterrupt_ = true; }

  private:
    struct Impl;
    Impl *impl_ = nullptr;
    volatile uint32_t revision_ = 0;
    volatile bool wantInterrupt_ = false;
    CommandHandler commandHandler_;
    AudioSink *sink_ = nullptr;
    friend struct Impl;
};

/** Splits "axis://host:port/CODE" into a base URL and a pairing code. */
bool parseSetupString(const String &input, String &baseUrl, String &code);

}  // namespace axis
