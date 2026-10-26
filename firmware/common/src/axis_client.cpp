#include "axis_client.h"

#include <DNSServer.h>
#include <HTTPClient.h>
#include <mbedtls/base64.h>
#include <esp_heap_caps.h>
#include <LittleFS.h>
#include <MD5Builder.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <NetworkClientSecure.h>
#include <esp_wifi.h>
#include <esp_heap_caps.h>
#include <esp_ota_ops.h>
#include <stdarg.h>
#include <mbedtls/platform.h>

#include "vad.h"

// The Arduino core accepts a newly installed firmware the moment it starts.
// Returning true here leaves that to the client, which accepts it only once
// it has reached Axis, so a firmware that cannot connect is rolled back.
extern "C" bool verifyRollbackLater() { return true; }

namespace axis {

namespace {

// Wrong credentials must not be a dead end: after this many failed joins, or
// this long without ever getting an address, the setup network comes back.
const uint8_t JOIN_FAILURES_BEFORE_SETUP = 3;
const uint32_t JOIN_TIMEOUT_MS = 45000;
// A router outage must not strand the device in setup mode either: with saved
// credentials and nobody on the setup network, it goes back to trying them.
const uint32_t SETUP_IDLE_RETRY_MS = 5 * 60 * 1000;
const uint32_t PAIR_RETRY_MS = 5000;
const uint32_t SENSE_INTERVAL_MS = 60000;
// The largest picture accepted over the socket; Axis sends screen-sized JPEGs of a few tens of KB.
const size_t MAX_PICTURE_BYTES = 300000;

// Microphone audio is 16 kHz, 16-bit mono, the one format version 1 allows upstream.
const uint32_t MIC_RATE = 16000;
// What a recording can hold while the network catches up: six seconds.
const size_t OUT_RING_SAMPLES = MIC_RATE * 6;
// The last second of audio, kept so the start of a sentence is not lost to the time it takes to notice it.
const size_t PRE_RING_SAMPLES = MIC_RATE;
const size_t PRE_ROLL_SAMPLES = MIC_RATE / 5;
// After the wake word, its own last syllable is still in the air. Skipping it keeps it from being taken for the start of the command.
const size_t WAKE_SETTLE_SAMPLES = MIC_RATE / 10;
// Cutting speech short leaves its tail in the speaker's buffers and in the room for a moment.
const size_t TAIL_SETTLE_SAMPLES = MIC_RATE / 4;
/** How long a newly installed firmware has to reach Axis before the device goes back to the old one. */
const uint32_t UNPROVEN_MS = 180000;
/** How long a device tries a new address for Axis before returning to the old one. */
const uint32_t ADDRESS_TRIAL_MS = 90000;
// Axis answers a wake within about 200 ms. Longer than this and the recording is dropped.
const uint32_t WAKE_ANSWER_MS = 3000;
const size_t SEND_BLOCK_SAMPLES = 1024;

const char *disconnectReason(uint8_t reason) {
    switch (reason) {
        case 2:
        case 15:
        case 202:
            return "wrong password?";
        case 201:
            return "network not found";
        case 8:
            return "left the network";
        default:
            return "";
    }
}

String htmlEscape(const String &in) {
    String out;
    out.reserve(in.length() + 8);
    for (char c : in) {
        if (c == '&') out += "&amp;";
        else if (c == '<') out += "&lt;";
        else if (c == '>') out += "&gt;";
        else if (c == '"') out += "&quot;";
        else out += c;
    }
    return out;
}

Turn turnFromName(const char *name) {
    if (!name) return Turn::Idle;
    if (!strcmp(name, "listening")) return Turn::Listening;
    if (!strcmp(name, "transcribing")) return Turn::Transcribing;
    if (!strcmp(name, "thinking")) return Turn::Thinking;
    if (!strcmp(name, "speaking")) return Turn::Speaking;
    if (!strcmp(name, "error")) return Turn::Error;
    return Turn::Idle;
}

}  // namespace

// The certificate authorities the ESP32 core ships with, the same set a browser trusts.
// An encrypted Axis address must present a certificate one of them signed.
extern const uint8_t caBundleStart[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t caBundleEnd[] asm("_binary_x509_crt_bundle_end");

// --- wake words kept on the device -----------------------------------------
//
// The model file lives in the flash partition the build sets aside for files,
// and what Axis said about it (which one, its checksum, how to run it) in its
// own corner of the preferences. "try" counts starts with this model that have
// not yet reached Axis: a model that crashes the device is given up on after two.

const char *const WAKE_FILE = "/wake.tflite";
const char *const WAKE_PREFS = "axiswk";
bool wakeModelsTaken = false, storedWakeRunning = false;

bool mountFiles() {
    static bool mounted = false;
    if (!mounted) mounted = LittleFS.begin(true, "/files", 5, "spiffs");
    return mounted;
}

String md5Of(const uint8_t *data, size_t length) {
    MD5Builder md5;
    md5.begin();
    md5.add(data, length);
    md5.calculate();
    return md5.toString();
}

bool loadStoredWakeModel(StoredWakeModel &out, Print *log) {
    wakeModelsTaken = true;
    Preferences prefs;
    prefs.begin(WAKE_PREFS, false);
    const String id = prefs.getString("id", "");
    if (id.isEmpty()) return false;
    const uint8_t tries = prefs.getUChar("try", 0);
    if (tries >= 2) {
        if (log) log->printf("[wake] the stored wake word \"%s\" is set aside: it did not work\n", id.c_str());
        return false;
    }
    if (!mountFiles() || !LittleFS.exists(WAKE_FILE)) {
        if (log) log->println("[wake] a wake word is recorded but its file is missing");
        return false;
    }
    File file = LittleFS.open(WAKE_FILE, "r");
    const size_t length = file.size();
    uint8_t *data = length ? (uint8_t *)heap_caps_aligned_alloc(16, length, MALLOC_CAP_SPIRAM) : nullptr;
    const bool read = data && file.read(data, length) == length;
    file.close();
    if (!read || md5Of(data, length) != prefs.getString("md5", "")) {
        if (log) log->println("[wake] the stored wake word file is damaged, using the built-in one");
        if (data) heap_caps_free(data);
        return false;
    }
    prefs.putUChar("try", tries + 1);
    out.data = data;
    out.length = length;
    out.id = id;
    out.name = prefs.getString("name", id);
    out.cutoffPercent = prefs.getUChar("cut", 90);
    out.window = prefs.getUChar("win", 5);
    return true;
}

void reportWakeModel(bool storedIsRunning) {
    storedWakeRunning = storedIsRunning;
    if (storedIsRunning) return;
    // The detector refused it. Do not try it again at every start.
    Preferences prefs;
    prefs.begin(WAKE_PREFS, false);
    if (!prefs.getString("id", "").isEmpty()) prefs.putUChar("try", 2);
}

/** Why the chip last started, in a word. A crash or a watchdog here is the first thing to look for when a device restarts by itself. */
const char *resetReason() {
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON: return "power";
        case ESP_RST_SW: return "software";
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_INT_WDT:
        case ESP_RST_TASK_WDT:
        case ESP_RST_WDT: return "watchdog";
        case ESP_RST_BROWNOUT: return "brownout";
        case ESP_RST_USB: return "usb";
        case ESP_RST_DEEPSLEEP: return "sleep";
        default: return "other";
    }
}

bool parseSetupString(const String &input, String &baseUrl, String &code) {
    String s = input;
    s.trim();
    const char *scheme;
    if (s.startsWith("axis+tls://")) {
        scheme = "https://";
        s = s.substring(11);
    } else if (s.startsWith("axis://")) {
        scheme = "http://";
        s = s.substring(7);
    } else {
        return false;
    }
    const int slash = s.indexOf('/');
    if (slash <= 0 || slash == (int)s.length() - 1) return false;
    baseUrl = String(scheme) + s.substring(0, slash);
    code = s.substring(slash + 1);
    return true;
}

struct Client::Impl {
    Client &self;
    Identity identity{};
    Stream *console = nullptr;
    SemaphoreHandle_t lock = xSemaphoreCreateMutex();

    Snapshot state;
    JsonDocument settings;
    uint32_t settingsVersion = 0;

    Preferences prefs;
    String baseUrl, pairingCode, clientId, token;
    // A picture arriving in image.data frames, and the last one complete, waiting for the board to take it.
    uint8_t *picBuf = nullptr;
    size_t picSize = 0, picGot = 0;
    String picId, picTurn;
    uint8_t *readyPic = nullptr;
    size_t readyPicSize = 0;
    String readyPicTurn;

    WebServer web{80};
    DNSServer dns;
    WebSocketsClient socket;

    bool setupMode = false;
    bool everJoined = false;
    uint8_t joinFailures = 0;
    uint32_t joinStartedAt = 0;
    uint32_t setupStartedAt = 0;
    String networkOptions;

    bool socketStarted = false;
    bool welcomed = false;
    uint32_t lastPairAttempt = 0;
    uint32_t lastSense = 0;
    // Readings the board adds to the regular ones, such as its screen size.
    static const int MAX_BOARD_READINGS = 8;
    const char *boardReadingKey[MAX_BOARD_READINGS] = {};
    long boardReadingValue[MAX_BOARD_READINGS] = {};
    int boardReadings = 0;
    String currentTurn;
    String consoleLine;

    // The speech stream being received or played, if any.
    String speakTurn;
    bool speakEnded = false, speakStartReported = false;

    // --- recording ---
    // Written by whichever task feeds the microphone, drained by the client task.
    SemaphoreHandle_t audioLock = xSemaphoreCreateMutex();
    Vad vad;
    int16_t *outRing = nullptr, *preRing = nullptr;
    size_t outHead = 0, outTail = 0, preHead = 0, preFill = 0;
    bool wakePending = false, wakeToSend = false, startSent = false, onset = false, endWanted = false, quietWanted = false;
    const char *endReason = "silence";
    String wakeId, turnId;
    /** What made this recording start, told to Axis with `audio.start`: wake, tap, follow_up or question. */
    const char *trigger = "tap";
    float wakeScore = 0, wakeLevel = 0;
    uint32_t wakeSentAt = 0, recordingCount = 0, droppedSamples = 0;
    size_t settleLeft = 0;
    /** The last turn this device recorded. A spoken reply to it is followed by a short listen. */
    String lastVoiceTurn;
    /** When the device gives up on an open question by itself, in `millis()`. 0 with no question. */
    uint32_t askDeadline = 0;

    // --- updates over Wi-Fi ---
    /** Set by the `update` command; the download starts on the next tick, once the answer has gone out. */
    bool updateWanted = false;
    String updatePath, updateMd5, updateVersion;
    uint32_t updateSize = 0;
    /** True while this firmware has just been installed and has not yet proved it can reach Axis. */
    bool unproven = false;

    // --- wake word from Axis ---
    /** Set by the `wake.model` command when another model has to be fetched. */
    bool wakeFetchWanted = false;
    String modelPath, modelId, modelName, modelMd5;
    uint32_t modelSize = 0;
    uint8_t modelCutoff = 90, modelWindow = 5;
    /** The detector loads its model once, at start, so a change of wake word ends in a restart, taken when nothing is going on. */
    bool restartWanted = false;

    /** Set by the `reset` command: 1 forgets Axis and the settings, 2 forgets the Wi-Fi as well. Done once the answer has gone out. */
    uint8_t resetWanted = 0;

    // --- moving to another address for Axis ---
    /** Set by the `address` command. Tried on the next tick, after the answer has gone out. */
    String addressWanted;
    /** While this is set the device is on a new address it has not yet connected through; at this time it gives up and goes back. */
    uint32_t addressTrialUntil = 0;

    explicit Impl(Client &client) : self(client) {}

    // --- shared state ------------------------------------------------------

    void logf(const char *format, ...) {
        if (!console) return;
        char line[256];
        va_list args;
        va_start(args, format);
        vsnprintf(line, sizeof line, format, args);
        va_end(args);
        console->printf("[axis] %s\n", line);
    }

    /** Changes the snapshot under the lock and marks it as new. */
    template <typename F> void update(F change) {
        xSemaphoreTake(lock, portMAX_DELAY);
        change(state);
        state.revision = ++self.revision_;
        xSemaphoreGive(lock);
    }

    void setLink(Link link, const String &note) {
        if (state.link == link && state.note == note) return;
        update([&](Snapshot &s) {
            s.link = link;
            s.note = note;
            if (link != Link::Online) s.turn = Turn::Idle;
        });
    }

    // --- stored values -----------------------------------------------------

    void load() {
        prefs.begin("axis", false);
        baseUrl = stored("url");
        pairingCode = stored("code");
        clientId = stored("cid");
        token = stored("tok");
        settingsVersion = prefs.getUInt("setv", 0);
        // Restarted while trying a new address for Axis: the trial carries on, and can still be taken back.
        if (!stored("urlPrev").isEmpty()) addressTrialUntil = millis() + ADDRESS_TRIAL_MS;
        const String saved = stored("sets", "{}");
        if (deserializeJson(settings, saved)) {
            settings.clear();
            settingsVersion = 0;
        }
        state.name = stored("name");
    }

    /** Reads a stored string. Asking for a key that was never written logs an error, so check first. */
    String stored(const char *key, const char *fallback = "") {
        return prefs.isKey(key) ? prefs.getString(key, fallback) : String(fallback);
    }

    void storePairing(const String &id, const String &secret, const String &name) {
        clientId = id;
        token = secret;
        pairingCode = "";
        prefs.putString("cid", id);
        prefs.putString("tok", secret);
        prefs.putString("name", name);
        if (prefs.isKey("code")) prefs.remove("code");
        update([&](Snapshot &s) { s.name = name; });
    }

    void forgetPairing() {
        storePairing("", "", "");
        settingsVersion = 0;
        prefs.putUInt("setv", 0);
        stopSocket();
    }

    bool applySetupString(const String &input) {
        String url, code;
        if (!parseSetupString(input, url, code)) return false;
        stopSocket();
        // A new setup string replaces any earlier pairing, including one with another Axis.
        storePairing("", "", "");
        baseUrl = url;
        pairingCode = code;
        prefs.putString("url", url);
        prefs.putString("code", code);
        lastPairAttempt = 0;
        logf("setup string accepted, Axis at %s", url.c_str());
        return true;
    }

    // --- Wi-Fi -------------------------------------------------------------

    String savedNetwork() {
        wifi_config_t config;
        if (esp_wifi_get_config(WIFI_IF_STA, &config) != ESP_OK) return "";
        return String((const char *)config.sta.ssid);
    }

    String setupNetworkName() {
        uint8_t mac[6];
        esp_wifi_get_mac(WIFI_IF_STA, mac);
        char name[32];
        snprintf(name, sizeof name, "VorteX-Axis-%02X%02X", mac[4], mac[5]);
        return name;
    }

    void join(const char *ssid = nullptr, const char *password = nullptr) {
        if (setupMode) {
            dns.stop();
            WiFi.softAPdisconnect(true);
            setupMode = false;
        }
        WiFi.mode(WIFI_STA);
        if (ssid) WiFi.begin(ssid, password);
        else WiFi.begin();
        joinFailures = 0;
        joinStartedAt = millis();
        logf("joining Wi-Fi \"%s\"", ssid ? ssid : savedNetwork().c_str());
        setLink(Link::WifiConnecting, "");
    }

    void scanNetworks() {
        networkOptions = "";
        const int found = WiFi.scanNetworks();
        for (int i = 0; i < found && i < 20; i++) {
            const String name = htmlEscape(WiFi.SSID(i));
            if (name.isEmpty() || networkOptions.indexOf("\"" + name + "\"") >= 0) continue;
            networkOptions += "<option value=\"" + name + "\">" + name + "</option>";
        }
        WiFi.scanDelete();
    }

    void startSetup(const String &why) {
        stopSocket();
        const String name = setupNetworkName();
        WiFi.mode(WIFI_AP_STA);
        WiFi.disconnect(false, false);
        WiFi.softAP(name.c_str());
        delay(100);
        dns.start(53, "*", WiFi.softAPIP());
        setupMode = true;
        setupStartedAt = millis();
        logf("setup network \"%s\" started%s%s", name.c_str(), why.isEmpty() ? "" : ": ", why.c_str());
        update([&](Snapshot &s) {
            s.link = Link::Setup;
            s.note = why;
            s.setupNetwork = name;
            s.address = WiFi.softAPIP().toString();
        });
        scanNetworks();
    }

    void wifiTick() {
        if (setupMode) {
            if (WiFi.softAPgetStationNum() > 0) setupStartedAt = millis();
            if (!savedNetwork().isEmpty() && millis() - setupStartedAt > SETUP_IDLE_RETRY_MS) join();
            return;
        }
        if (WiFi.status() == WL_CONNECTED) {
            if (!everJoined || state.address != WiFi.localIP().toString()) {
                everJoined = true;
                logf("Wi-Fi up, address %s", WiFi.localIP().toString().c_str());
                update([&](Snapshot &s) { s.address = WiFi.localIP().toString(); });
            }
            return;
        }
        if (!everJoined && (joinFailures >= JOIN_FAILURES_BEFORE_SETUP || millis() - joinStartedAt > JOIN_TIMEOUT_MS)) {
            startSetup("Could not join \"" + savedNetwork() + "\"");
        }
    }

    // --- the device's own setup page ---------------------------------------

    String page(const String &message) {
        String html = F(
            "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
            "<title>VorteX Axis device</title><style>body{font:16px system-ui;margin:1.2em;max-width:30em;background:#0b1016;color:#dfe8ee}"
            "input,select,button{font:inherit;width:100%;box-sizing:border-box;padding:.55em;margin:.25em 0 .9em;border-radius:6px;border:1px solid #33414d;background:#131b24;color:inherit}"
            "button{background:#19b8c9;color:#031014;border:0;font-weight:600}small{color:#8ea0ad}.msg{padding:.6em;background:#16303a;border-radius:6px}</style>"
            "<h2>VorteX Axis device</h2>");
        if (!message.isEmpty()) html += "<p class=msg>" + htmlEscape(message) + "</p>";
        html += "<p><small>" + String(identity.type) + " " AXIS_FIRMWARE_VERSION;
        html += clientId.isEmpty() ? " &middot; not paired" : " &middot; paired as " + htmlEscape(state.name);
        if (!baseUrl.isEmpty()) html += " &middot; Axis at " + htmlEscape(baseUrl);
        html += "</small></p><form method=post action=/save>";
        html += "<label>Wi-Fi network</label><select name=ssid><option value=''>";
        html += savedNetwork().isEmpty() ? "choose" : "keep \"" + htmlEscape(savedNetwork()) + "\"";
        html += "</option>" + networkOptions + "</select>";
        html += F("<label>or type its name</label><input name=ssid2 autocapitalize=off autocorrect=off>"
                  "<label>Wi-Fi password</label><input name=pass type=password>"
                  "<label>Setup string from the Axis admin page</label><input name=setup autocapitalize=off autocorrect=off placeholder='axis://address:port/code'>"
                  "<small>Leave a field empty to keep what the device already has.</small>"
                  "<button>Save</button></form><p><a href='/?rescan=1' style='color:#19b8c9'>Search for networks again</a> &middot; <a href='/logs' style='color:#19b8c9'>Device log</a></p>");
        return html;
    }

    void startWeb() {
        web.on("/", HTTP_GET, [this] {
            if (web.hasArg("rescan") || networkOptions.isEmpty()) scanNetworks();
            web.send(200, "text/html", page(""));
        });
        web.on("/save", HTTP_POST, [this] {
            String ssid = web.arg("ssid2");
            ssid.trim();
            if (ssid.isEmpty()) ssid = web.arg("ssid");
            const String pass = web.arg("pass");
            String setup = web.arg("setup");
            setup.trim();
            String message;
            if (!setup.isEmpty()) {
                if (!applySetupString(setup)) {
                    web.send(200, "text/html", page("That setup string was not understood. It starts with axis://"));
                    return;
                }
                message = "Setup string saved. ";
            }
            if (!ssid.isEmpty()) message += "Joining \"" + ssid + "\". This page stops working when the device leaves its setup network; watch its screen.";
            else if (message.isEmpty()) message = "Nothing to change.";
            web.send(200, "text/html", page(message));
            if (!ssid.isEmpty()) {
                delay(300);  // let the reply leave before the setup network goes away
                everJoined = false;
                join(ssid.c_str(), pass.c_str());
            }
        });
        // The last stretch of the device's log, as plain text. `?tail=N` limits it to the last N bytes.
        web.on("/logs", HTTP_GET, [this] {
            if (!self.logBuffer_) return web.send(404, "text/plain", "no log kept on this device");
            LogBuffer &log = *self.logBuffer_;
            const long tail = web.hasArg("tail") ? web.arg("tail").toInt() : 0;
            uint64_t from = log.tailStart(tail > 0 ? (size_t)tail : 1u << 30);
            web.setContentLength(CONTENT_LENGTH_UNKNOWN);
            web.send(200, "text/plain; charset=utf-8", "");
            char chunk[1024];
            // Stops at what was written when the request came in, so a busy log cannot keep it open.
            const uint64_t end = log.total();
            while (from < end) {
                const size_t n = log.readFrom(from, chunk, sizeof chunk);
                if (!n) break;
                web.sendContent(chunk, n);
            }
            web.sendContent("");
        });
        // Phones probe odd addresses to detect a setup network. Send them all to the form.
        web.onNotFound([this] {
            web.sendHeader("Location", "http://" + web.client().localIP().toString() + "/");
            web.send(302, "text/plain", "");
        });
        web.begin();
    }

    // --- pairing -----------------------------------------------------------

    void pair() {
        lastPairAttempt = millis();
        JsonDocument body;
        body["code"] = pairingCode;
        body["type"] = identity.type;
        body["version"] = AXIS_FIRMWARE_VERSION;
        JsonArray capabilities = body["capabilities"].to<JsonArray>();
        for (size_t i = 0; i < identity.capabilityCount; i++) capabilities.add(identity.capabilities[i]);
        body["name"] = setupNetworkName();
        String payload;
        serializeJson(body, payload);

        WiFiClient plain;
        NetworkClientSecure tls;
        HTTPClient http;
        http.setConnectTimeout(encrypted() ? 8000 : 4000);
        http.setTimeout(6000);
        if (!beginHttp(http, plain, tls, baseUrl + "/v1/pair")) {
            setLink(Link::Pairing, "Bad Axis address " + baseUrl);
            return;
        }
        http.addHeader("Content-Type", "application/json");
        const int status = http.POST(payload);
        const String reply = http.getString();
        http.end();

        if (status == 200) {
            JsonDocument doc;
            if (!deserializeJson(doc, reply) && doc["clientId"].is<const char *>() && doc["token"].is<const char *>()) {
                storePairing(doc["clientId"].as<String>(), doc["token"].as<String>(), doc["name"] | "");
                logf("paired as \"%s\" (%s)", state.name.c_str(), clientId.c_str());
                return;
            }
            setLink(Link::Pairing, "Axis sent a pairing reply this firmware cannot read");
        } else if (status == 403 || status == 400) {
            // The code is spent or wrong. Retrying it would only trip the rate limit.
            pairingCode = "";
            if (prefs.isKey("code")) prefs.remove("code");
            logf("pairing refused (%d): %s", status, reply.c_str());
            setLink(Link::Unpaired, "Pairing code was refused. Get a new setup string.");
        } else {
            logf("pairing attempt failed (%d)", status);
            setLink(Link::Pairing, status < 0 ? "Cannot reach Axis at " + baseUrl : "Axis answered " + String(status));
        }
    }

    // --- socket ------------------------------------------------------------

    void send(JsonDocument &doc) {
        String text;
        serializeJson(doc, text);
        socket.sendTXT(text);
    }

    /** True when Axis is reached over TLS (a setup string that began with `axis+tls://`). */
    bool encrypted() const { return baseUrl.startsWith("https://"); }

    /** Opens an HTTP request to Axis over whichever transport its address calls for. */
    bool beginHttp(HTTPClient &http, WiFiClient &plain, NetworkClientSecure &tls, const String &url) {
        if (!encrypted()) return http.begin(plain, url);
        tls.setCACertBundle(caBundleStart, caBundleEnd - caBundleStart);
        return http.begin(tls, url);
    }

    void startSocket() {
        String rest = baseUrl.substring(baseUrl.indexOf("://") + 3);
        uint16_t port = encrypted() ? 443 : 80;
        const int colon = rest.lastIndexOf(':');
        if (colon > 0) {
            port = (uint16_t)rest.substring(colon + 1).toInt();
            rest = rest.substring(0, colon);
        }
        socket.onEvent([this](WStype_t type, uint8_t *payload, size_t length) { onSocket(type, payload, length); });
        socket.setReconnectInterval(3000);
        // Without this a silently dead link (Axis host gone, Wi-Fi roam) looks connected forever.
        socket.enableHeartbeat(15000, 5000, 2);
        if (encrypted()) socket.beginSslWithBundle(rest.c_str(), port, "/v1/client", caBundleStart, (size_t)(caBundleEnd - caBundleStart), "arduino");
        else socket.begin(rest.c_str(), port, "/v1/client");
        socketStarted = true;
        logf("connecting to Axis at %s:%u%s", rest.c_str(), port, encrypted() ? ", encrypted" : "");
    }

    void stopSocket() {
        if (!socketStarted) return;
        socket.disconnect();
        socketStarted = false;
        welcomed = false;
    }

    void onSocket(WStype_t type, uint8_t *payload, size_t length) {
        if (type == WStype_CONNECTED) {
            JsonDocument hello;
            hello["t"] = "hello";
            hello["protocol"] = AXIS_PROTOCOL_VERSION;
            hello["clientId"] = clientId;
            hello["token"] = token;
            hello["type"] = identity.type;
            hello["version"] = AXIS_FIRMWARE_VERSION;
            JsonArray capabilities = hello["capabilities"].to<JsonArray>();
            for (size_t i = 0; i < identity.capabilityCount; i++) capabilities.add(identity.capabilities[i]);
            hello["settingsVersion"] = settingsVersion;
            if (self.sink_) {
                hello["maxFrameBytes"] = 4096;
                hello["audioBufferMs"] = self.sink_->bufferMs();
            }
            send(hello);
        } else if (type == WStype_DISCONNECTED) {
            if (welcomed) logf("lost the connection to Axis");
            welcomed = false;
            cancelRecording();
            // A question cannot be answered now, and Axis sends the timers again on the next connect.
            endAsk();
            update([](Snapshot &s) { s.timerCount = 0; s.taskCount = 0; s.taskSteps = ""; s.taskOthers = ""; s.asksElsewhere = 0; });
            // Whatever is already queued may finish, but nothing more is coming.
            if (!speakTurn.isEmpty() && self.sink_) self.sink_->streamEnd();
            speakTurn = "";
        } else if (type == WStype_TEXT) {
            onMessage(payload, length);
        } else if (type == WStype_BIN) {
            if (!speakTurn.isEmpty() && !speakEnded && self.sink_) self.sink_->streamWrite(payload, length);
        }
    }

    /** A message about a different turn than the last one starts a clean screen. */
    void enterTurn(const char *turnId) {
        if (!turnId || currentTurn == turnId) return;
        currentTurn = turnId;
        update([](Snapshot &s) {
            s.transcript = "";
            s.reply = "";
        });
    }

    /** Forgets a picture still arriving. */
    void dropPicture() {
        if (picBuf) heap_caps_free(picBuf);
        picBuf = nullptr;
        picSize = picGot = 0;
        picId = "";
    }

    void onMessage(uint8_t *payload, size_t length) {
        JsonDocument doc;
        if (deserializeJson(doc, payload, length)) return;
        const char *t = doc["t"] | "";

        if (!strcmp(t, "welcome")) {
            welcomed = true;
            lastSense = millis() - SENSE_INTERVAL_MS + 5000;
            logf("connected to Axis");
            if (addressTrialUntil || !stored("urlPrev").isEmpty()) {
                // Connected through the new address with the old pairing: it is the address now.
                addressTrialUntil = 0;
                prefs.remove("urlPrev");
                logf("the new address works and is kept");
            }
            if (storedWakeRunning) {
                // A stored wake word that let the device get this far is safe to start with again.
                Preferences wk;
                wk.begin(WAKE_PREFS, false);
                if (wk.getUChar("try", 0) != 0) wk.putUChar("try", 0);
            }
            if (unproven) {
                // A freshly installed firmware that got this far is good enough to keep.
                unproven = false;
                esp_ota_mark_app_valid_cancel_rollback();
                logf("this firmware is now the one to keep");
            }
            sendDescribe();
        } else if (!strcmp(t, "settings")) {
            xSemaphoreTake(lock, portMAX_DELAY);
            settings.clear();
            settings.set(doc["values"]);
            settingsVersion = doc["version"] | 0;
            state.settingsRevision++;
            state.revision = ++self.revision_;
            xSemaphoreGive(lock);
            String saved;
            serializeJson(settings, saved);
            prefs.putString("sets", saved);
            prefs.putUInt("setv", settingsVersion);
            logf("settings version %u stored", (unsigned)settingsVersion);
        } else if (!strcmp(t, "status")) {
            // "unknown" is not reported as down: nobody has tried the service yet.
            const bool openclaw = strcmp(doc["upstream"]["openclaw"] | "", "down") != 0;
            const bool stt = strcmp(doc["upstream"]["stt"] | "", "down") != 0;
            const bool tts = strcmp(doc["upstream"]["tts"] | "", "down") != 0;
            update([&](Snapshot &s) {
                s.openclawUp = openclaw;
                s.sttUp = stt;
                s.ttsUp = tts;
            });
        } else if (!strcmp(t, "turn")) {
            enterTurn(doc["turnId"]);
            const Turn turn = turnFromName(doc["state"]);
            const String detail = doc["detail"] | "";
            const String doing = doc["doing"] | "";
            logf("turn %s %s%s", doc["state"] | "", detail.c_str(), doing.c_str());
            update([&](Snapshot &s) {
                // What the agent is doing holds until it says something else or stops thinking.
                if (turn != Turn::Thinking) s.doing = "";
                else if (!doing.isEmpty()) s.doing = doing;
                s.turn = turn;
                if (turn == Turn::Error) s.note = detail.isEmpty() ? String("Something went wrong") : detail;
                else if (turn != Turn::Idle) s.note = "";
            });
        } else if (!strcmp(t, "transcript")) {
            enterTurn(doc["turnId"]);
            const String text = doc["text"] | "";
            logf("heard: %s", text.c_str());
            update([&](Snapshot &s) { s.transcript = text; });
        } else if (!strcmp(t, "reply.text")) {
            enterTurn(doc["turnId"]);
            const String text = doc["text"] | "";
            const bool final = doc["final"] | false;
            if (final) logf("reply: %s", text.c_str());
            update([&](Snapshot &s) {
                if (final) s.reply = text;
                else s.reply += text;
            });
        } else if (!strcmp(t, "image.start")) {
            dropPicture();
            const size_t size = doc["size"] | 0;
            if (size == 0 || size > MAX_PICTURE_BYTES) {
                logf("picture of %u bytes refused", (unsigned)size);
                return;
            }
            picBuf = (uint8_t *)heap_caps_malloc(size, MALLOC_CAP_SPIRAM);
            if (!picBuf) {
                logf("no memory for a picture of %u bytes", (unsigned)size);
                return;
            }
            picSize = size;
            picGot = 0;
            picId = doc["imageId"] | "";
            picTurn = doc["turnId"] | "";
        } else if (!strcmp(t, "image.data")) {
            if (!picBuf || picId != (doc["imageId"] | "")) return;
            const char *data = doc["data"] | "";
            size_t out = 0;
            if (mbedtls_base64_decode(picBuf + picGot, picSize - picGot, &out, (const unsigned char *)data, strlen(data)) != 0) {
                logf("a picture arrived damaged, dropped");
                dropPicture();
                return;
            }
            picGot += out;
        } else if (!strcmp(t, "image.end")) {
            if (!picBuf || picId != (doc["imageId"] | "")) return;
            if (picGot != picSize) {
                logf("a picture arrived incomplete (%u of %u bytes), dropped", (unsigned)picGot, (unsigned)picSize);
                dropPicture();
                return;
            }
            logf("picture of %u bytes", (unsigned)picSize);
            xSemaphoreTake(lock, portMAX_DELAY);
            if (readyPic) heap_caps_free(readyPic);
            readyPic = picBuf;
            readyPicSize = picSize;
            readyPicTurn = picTurn;
            xSemaphoreGive(lock);
            picBuf = nullptr;
            picSize = picGot = 0;
        } else if (!strcmp(t, "speak.start")) {
            if (!self.sink_) return;
            if (self.speakerOff_) {
                // The speaker switched off on the admin page: nothing plays, and Axis hears so at once.
                speakTurn = doc["turnId"] | "";
                reportPlayback("blocked");
                speakTurn = "";
                return;
            }
            enterTurn(doc["turnId"]);
            speakTurn = doc["turnId"] | "";
            speakEnded = false;
            speakStartReported = false;
            self.sink_->streamBegin(doc["format"]["sampleRate"] | 16000);
        } else if (!strcmp(t, "speak.end")) {
            if (!self.sink_ || speakTurn != (doc["turnId"] | "")) return;
            speakEnded = true;
            self.sink_->streamEnd();
        } else if (!strcmp(t, "wake.result")) {
            onWakeResult(doc["wakeId"] | "", doc["granted"] | false);
        } else if (!strcmp(t, "ask")) {
            onAsk(doc);
        } else if (!strcmp(t, "ask.end")) {
            if (state.askId == (doc["askId"] | "")) endAsk();
        } else if (!strcmp(t, "stop")) {
            quiet();
        } else if (!strcmp(t, "command")) {
            onCommand(doc);
        } else if (!strcmp(t, "error")) {
            const char *code = doc["code"] | "";
            logf("Axis reported %s: %s", code, doc["message"] | "");
            if (!strcmp(code, "unauthorized")) {
                // Only this means the pairing is gone. Any other error leaves it alone.
                forgetPairing();
                setLink(Link::Unpaired, "Axis no longer knows this device. Pair it again.");
            }
        }
    }

    /**
     * Returns the device to how it was before it was set up: no pairing, no
     * address for Axis, no synced settings, no stored wake word. With
     * `wifiToo` the Wi-Fi details go as well and it comes back up as its own
     * setup network; without, it stays on the Wi-Fi and waits for a setup
     * string. The firmware itself is not touched.
     */
    void factoryReset(bool wifiToo) {
        logf("reset from Axis: forgetting pairing and settings%s", wifiToo ? " and Wi-Fi" : "");
        socket.disconnect();
        prefs.clear();
        Preferences wk;
        wk.begin(WAKE_PREFS, false);
        wk.clear();
        if (mountFiles()) LittleFS.remove(WAKE_FILE);
        if (wifiToo) WiFi.disconnect(true, true);
        delay(300);
        ESP.restart();
    }

    /**
     * Moves to another address for Axis without pairing again. The new address
     * must answer as Axis before anything is changed; over https its
     * certificate is checked as always. Then the device connects through it
     * with the pairing it has. The old address is kept until that has worked,
     * and taken back if it has not within a minute and a half, so a wrong
     * address cannot strand a device.
     */
    void tryAddress(const String &url) {
        if (url == baseUrl) return;
        logf("asked to reach Axis at %s", url.c_str());
        const String old = baseUrl;
        const bool wasEncrypted = encrypted();
        if (url.startsWith("https://") && wasEncrypted) stopSocket();  // no room for two encrypted connections
        bool answers = false;
        {
            baseUrl = url;  // so the request goes over the transport the new address calls for
            WiFiClient plain;
            NetworkClientSecure tls;
            HTTPClient http;
            http.setConnectTimeout(8000);
            http.setTimeout(8000);
            if (beginHttp(http, plain, tls, url + "/healthz")) {
                const int status = http.GET();
                answers = status == 200 && http.getString().indexOf("\"ok\"") >= 0;
                if (!answers) logf("%s did not answer as Axis (%d)", url.c_str(), status);
                http.end();
            }
            baseUrl = old;
        }
        if (!answers) {
            update([&](Snapshot &s) { s.note = "Could not reach Axis at the new address"; });
            return;
        }
        prefs.putString("urlPrev", old);
        prefs.putString("url", url);
        baseUrl = url;
        stopSocket();
        addressTrialUntil = millis() + ADDRESS_TRIAL_MS;
        if (!addressTrialUntil) addressTrialUntil = 1;
        logf("trying the new address");
    }

    /** The new address did not let the device back in: return to the one before. */
    void revertAddress() {
        const String old = stored("urlPrev");
        addressTrialUntil = 0;
        prefs.remove("urlPrev");
        if (old.isEmpty()) return;
        logf("could not connect through %s, going back to %s", baseUrl.c_str(), old.c_str());
        prefs.putString("url", old);
        baseUrl = old;
        stopSocket();
    }

    /**
     * Axis says which wake word this device should be listening with. Nothing
     * happens when it already is. Otherwise the model is fetched (or the stored
     * one dropped, for the built-in) and the device restarts into it.
     */
    void onWakeModel(JsonVariantConst params, JsonObject payload) {
        const String id = params["id"] | "";
        Preferences wk;
        wk.begin(WAKE_PREFS, false);
        const String have = wk.getString("id", "");
        const uint8_t cutoff = (uint8_t)constrain((int)(params["cutoff"] | 90), 50, 99);
        const uint8_t window = (uint8_t)constrain((int)(params["window"] | 5), 1, 12);
        if (id.isEmpty()) {
            payload["using"] = "built-in";
            if (!have.isEmpty()) {
                wk.clear();
                if (mountFiles()) LittleFS.remove(WAKE_FILE);
                // Only a device actually running the stored one needs to restart to leave it.
                restartWanted = storedWakeRunning;
                payload["changing"] = restartWanted;
            }
            return;
        }
        if (id == have && wk.getString("md5", "") == (params["md5"] | "")) {
            // The same model. Its tuning may have changed, which also takes a restart.
            if (wk.getUChar("cut", 90) != cutoff || wk.getUChar("win", 5) != window) {
                wk.putUChar("cut", cutoff);
                wk.putUChar("win", window);
                restartWanted = storedWakeRunning;
                payload["changing"] = restartWanted;
            }
            payload["using"] = storedWakeRunning ? id : String("built-in");
            if (!storedWakeRunning) payload["problem"] = "the stored model did not load on this device";
            return;
        }
        modelPath = params["path"] | "";
        modelId = id;
        modelName = params["name"] | "";
        modelMd5 = params["md5"] | "";
        modelSize = params["size"] | 0;
        modelCutoff = cutoff;
        modelWindow = window;
        wakeFetchWanted = modelPath.startsWith("/") && modelSize > 0 && modelSize <= 1024 * 1024;
        payload["fetching"] = wakeFetchWanted;
    }

    /** Fetches the wake word Axis named, checks it and keeps it. The device restarts into it when it is next idle. */
    void fetchWakeModel() {
        logf("fetching the wake word \"%s\" (%u bytes)", modelName.c_str(), (unsigned)modelSize);
        String problem;
        uint8_t *data = (uint8_t *)heap_caps_malloc(modelSize, MALLOC_CAP_SPIRAM);
        const bool wasEncrypted = encrypted();
        if (wasEncrypted) stopSocket();  // no room for two encrypted connections
        if (!data) {
            problem = "no memory";
        } else {
            WiFiClient plain;
            NetworkClientSecure tls;
            HTTPClient http;
            http.setConnectTimeout(8000);
            http.setTimeout(10000);
            if (!beginHttp(http, plain, tls, baseUrl + modelPath)) {
                problem = "bad address";
            } else {
                http.addHeader("Authorization", "Bearer " + token);
                http.addHeader("X-Axis-Client", clientId);
                const int status = http.GET();
                if (status != 200) problem = "Axis answered " + String(status);
                else if ((uint32_t)http.getSize() != modelSize) problem = "the file is not the size Axis said";
                else {
                    WiFiClient *stream = http.getStreamPtr();
                    uint32_t done = 0, lastData = millis();
                    while (done < modelSize) {
                        const int got = stream->read(data + done, modelSize - done);
                        if (got > 0) {
                            done += got;
                            lastData = millis();
                        } else if (!stream->connected() || millis() - lastData > 10000) {
                            problem = "the download stopped";
                            break;
                        } else {
                            delay(5);
                        }
                    }
                    if (problem.isEmpty() && md5Of(data, modelSize) != modelMd5) problem = "the file did not check out";
                }
                http.end();
            }
        }
        if (problem.isEmpty()) {
            File file = mountFiles() ? LittleFS.open(WAKE_FILE, "w") : File();
            if (!file || file.write(data, modelSize) != modelSize) problem = "it could not be saved";
            if (file) file.close();
        }
        if (data) heap_caps_free(data);
        if (!problem.isEmpty()) {
            logf("wake word not changed: %s", problem.c_str());
            return;
        }
        Preferences wk;
        wk.begin(WAKE_PREFS, false);
        wk.putString("id", modelId);
        wk.putString("name", modelName);
        wk.putString("md5", modelMd5);
        wk.putUChar("cut", modelCutoff);
        wk.putUChar("win", modelWindow);
        wk.putUChar("try", 0);
        logf("wake word \"%s\" saved; restarting into it when idle", modelName.c_str());
        restartWanted = true;
    }

    /**
     * Downloads the firmware Axis holds for this type and installs it in the
     * other app slot, then restarts into it. The file is checked against the
     * MD5 Axis gave before the slot is made the one to boot. A failure leaves
     * the running firmware as it was.
     */
    void runUpdate() {
        logf("updating to %s (%u bytes), free memory %u", updateVersion.c_str(), (unsigned)updateSize, (unsigned)ESP.getFreeHeap());
        cancelRecording();
        quiet();
        endAsk();
        update([](Snapshot &s) { s.updatePercent = 0; });
        // An encrypted connection takes about 45 KB of memory, and there is not room for two:
        // the socket is closed for the download and opens again afterwards if the update fails.
        if (encrypted()) {
            stopSocket();
            delay(300);  // give the closed connection's memory back before the next one is opened
            logf("socket closed for the download, free memory %u", (unsigned)ESP.getFreeHeap());
        }
        String problem;
        {
            WiFiClient plain;
            NetworkClientSecure tls;
            HTTPClient http;
            http.setConnectTimeout(8000);
            http.setTimeout(10000);
            if (!beginHttp(http, plain, tls, baseUrl + updatePath)) {
                problem = "bad address";
            } else {
                http.addHeader("Authorization", "Bearer " + token);
                http.addHeader("X-Axis-Client", clientId);
                const int status = http.GET();
                if (status != 200) problem = "Axis answered " + String(status);
                else if ((uint32_t)http.getSize() != updateSize) problem = "the file is not the size Axis said";
                else if (!Update.begin(updateSize)) problem = String("no room: ") + Update.errorString();
                else {
                    Update.setMD5(updateMd5.c_str());
                    WiFiClient *stream = http.getStreamPtr();
                    static uint8_t block[4096];
                    uint32_t done = 0, lastData = millis();
                    int8_t shown = 0;
                    while (done < updateSize) {
                        const int got = stream->read(block, min((uint32_t)sizeof block, updateSize - done));
                        if (got > 0) {
                            if (Update.write(block, got) != (size_t)got) {
                                problem = String("writing failed: ") + Update.errorString();
                                break;
                            }
                            done += got;
                            lastData = millis();
                            const int8_t percent = (int8_t)(done * 100ULL / updateSize);
                            if (percent >= shown + 2) {
                                shown = percent;
                                update([&](Snapshot &s) { s.updatePercent = percent; });
                            }
                        } else if (!stream->connected() || millis() - lastData > 15000) {
                            problem = "the download stopped";
                            break;
                        } else {
                            delay(5);
                        }
                    }
                    if (problem.isEmpty() && !Update.end(true)) problem = String("the file did not check out: ") + Update.errorString();
                    if (!problem.isEmpty()) Update.abort();
                }
                http.end();
            }
        }
        if (problem.isEmpty()) {
            logf("update installed, restarting");
            update([](Snapshot &s) { s.updatePercent = 100; });
            socket.disconnect();
            delay(400);
            ESP.restart();
        }
        logf("update failed: %s", problem.c_str());
        update([&](Snapshot &s) {
            s.updatePercent = -1;
            s.note = "Update failed: " + problem;
        });
        // Axis hears about it too, as a reading the admin page shows.
        if (socketStarted) {
            JsonDocument doc;
            doc["t"] = "sense";
            doc["readings"]["updateFailed"] = problem.substring(0, 120);
            send(doc);
        }
    }

    /** A number when the whole text is one, so "90" is sent as 90 and "Hey" stays text. */
    static void addNumberOrText(JsonArray array, const char *text) {
        char *end = nullptr;
        const double number = strtod(text, &end);
        if (end != text && *end == '\0') array.add(number);
        else array.add(text);
    }

    /** Tells Axis what this board offers the admin page: settings, actions and its own web pages. */
    void sendDescribe() {
        JsonDocument doc;
        doc["t"] = "describe";
        JsonArray settingList = doc["settings"].to<JsonArray>();
        for (size_t i = 0; i < identity.settingCount; i++) {
            const SettingDef &d = identity.settings[i];
            JsonObject o = settingList.add<JsonObject>();
            o["key"] = d.key;
            o["label"] = d.label;
            o["kind"] = d.kind;
            if (d.group) o["group"] = d.group;
            if (d.help) o["help"] = d.help;
            if (d.fallback) {
                if (!strcmp(d.kind, "text")) o["default"] = d.fallback;
                else o["default"] = atof(d.fallback);
            }
            if (!strcmp(d.kind, "number") && (d.min || d.max)) {
                o["min"] = d.min;
                o["max"] = d.max;
            }
            if (d.unit) o["unit"] = d.unit;
            if (d.options) {
                JsonArray options = o["options"].to<JsonArray>();
                String all = d.options;
                for (int from = 0; from <= (int)all.length();) {
                    int comma = all.indexOf(',', from);
                    if (comma < 0) comma = all.length();
                    String one = all.substring(from, comma);
                    one.trim();
                    if (!one.isEmpty()) addNumberOrText(options, one.c_str());
                    from = comma + 1;
                }
            }
        }
        JsonArray actionList = doc["actions"].to<JsonArray>();
        for (size_t i = 0; i < identity.actionCount; i++) {
            const ActionDef &a = identity.actions[i];
            JsonObject o = actionList.add<JsonObject>();
            o["name"] = a.name;
            o["label"] = a.label;
            if (a.help) o["help"] = a.help;
            if (a.confirm) o["confirm"] = true;
        }
        JsonObject diag = actionList.add<JsonObject>();
        diag["name"] = "diag";
        diag["label"] = "Diagnostics";
        diag["help"] = "Firmware version, uptime, free memory and signal strength.";
        JsonObject reboot = actionList.add<JsonObject>();
        reboot["name"] = "reboot";
        reboot["label"] = "Reboot";
        reboot["help"] = "Restarts the device. It reconnects by itself.";
        reboot["confirm"] = true;
        JsonArray links = doc["links"].to<JsonArray>();
        if (self.logBuffer_) {
            JsonObject log = links.add<JsonObject>();
            log["label"] = "Device log";
            log["path"] = "/logs";
        }
        JsonObject page = links.add<JsonObject>();
        page["label"] = "Device page";
        page["path"] = "/";
        doc["address"] = WiFi.localIP().toString();
        send(doc);
    }

    void reportPlayback(const char *what) {
        JsonDocument doc;
        doc["t"] = "playback";
        doc["turnId"] = speakTurn;
        doc["state"] = what;
        send(doc);
    }

    /** Stops speech at once and tells Axis, which is waiting to hear how playback went. */
    void quiet() {
        if (!self.sink_ || speakTurn.isEmpty()) return;
        self.sink_->stop();
        reportPlayback("stopped");
        speakTurn = "";
    }

    /** Tells Axis when sound really starts and really ends, not when the bytes arrived. */
    void speechTick() {
        if (!self.sink_ || speakTurn.isEmpty()) return;
        // Switched off on the admin page while speaking: it stops there.
        if (self.speakerOff_) return quiet();
        if (!speakStartReported && self.sink_->started()) {
            speakStartReported = true;
            reportPlayback("started");
        }
        if (speakEnded && self.sink_->drained()) {
            reportPlayback("finished");
            logf("finished speaking");
            const bool answeredUs = speakTurn == lastVoiceTurn;
            speakTurn = "";
            // Only an answer that was spoken to the end leads to a follow-up. Silence from the agent
            // (NO_REPLY) never starts speech, and a cut-off answer means the person took over.
            if (answeredUs) startFollowUp();
        }
    }

    void onCommand(JsonDocument &doc) {
        const char *name = doc["name"] | "";
        JsonDocument result;
        result["t"] = "command.result";
        result["id"] = doc["id"];
        JsonObject payload = result["payload"].to<JsonObject>();
        bool handled = false;
        if (!strcmp(name, "diag")) {
            payload["version"] = AXIS_FIRMWARE_VERSION;
            payload["uptimeS"] = millis() / 1000;
            payload["heap"] = ESP.getFreeHeap();
            payload["heapLow"] = ESP.getMinFreeHeap();
            payload["rssi"] = WiFi.RSSI();
            // Why the device last started: "power", "software" (asked to), "panic" (it crashed), "watchdog", "brownout".
            payload["lastStart"] = resetReason();
            handled = true;
        } else if (!strcmp(name, "reboot")) {
            handled = true;
        } else if (!strcmp(name, "update")) {
            // Answer first, download after: the download keeps this task busy for half a minute.
            updatePath = doc["params"]["path"] | "";
            updateMd5 = doc["params"]["md5"] | "";
            updateVersion = doc["params"]["version"] | "";
            updateSize = doc["params"]["size"] | 0;
            updateWanted = updatePath.startsWith("/") && updateSize > 0;
            if (updateWanted) payload["updating"] = updateVersion;
            handled = updateWanted;
        } else if (!strcmp(name, "reset")) {
            // The admin page returning this device to how it was before it was set up.
            resetWanted = (doc["params"]["wifi"] | 0) ? 2 : 1;
            payload["forgetting"] = resetWanted == 2 ? "pairing, settings and Wi-Fi" : "pairing and settings";
            handled = true;
        } else if (!strcmp(name, "address")) {
            // The admin page moving this device to another address for the same Axis. The pairing stays.
            const String url = doc["params"]["url"] | "";
            handled = url.startsWith("http://") || url.startsWith("https://");
            if (handled) {
                addressWanted = url;
                payload["trying"] = url;
            }
        } else if (!strcmp(name, "wake.model") && wakeModelsTaken) {
            handled = true;
            onWakeModel(doc["params"], payload);
        } else if (!strcmp(name, "timer.next")) {
            // Axis keeps the timers and announces them. This is only for a countdown on a screen.
            const uint32_t ms = doc["params"]["ms"] | 0;
            const String label = doc["params"]["label"] | "";
            const uint8_t count = ms ? (uint8_t)constrain((int)(doc["params"]["count"] | 1), 1, 255) : 0;
            update([&](Snapshot &s) {
                s.timerLabel = label;
                s.timerEndsAt = millis() + ms;
                s.timerCount = count;
            });
            handled = true;
        }
        else if (!strcmp(name, "progress.show")) {
            // Axis keeps the tasks agents report on. This is only for a line on a screen.
            const uint8_t count = (uint8_t)constrain((int)(doc["params"]["count"] | 0), 0, 255);
            const String title = doc["params"]["title"] | "";
            const String noteText = doc["params"]["note"] | "";
            const String stateName = doc["params"]["state"] | "running";
            const int done = doc["params"]["done"] | -1;
            const int total = doc["params"]["total"] | 0;
            const String steps = doc["params"]["steps"] | "";
            const String others = doc["params"]["others"] | "";
            const bool chime = doc["params"]["chime"] | false;
            update([&](Snapshot &s) {
                s.taskSteps = steps;
                s.taskOthers = others;
                if (chime) s.taskChimes++;
                s.taskCount = count;
                s.taskTitle = title;
                s.taskNote = noteText;
                s.taskDone = (int16_t)constrain(done, -1, 999);
                s.taskTotal = (uint16_t)constrain(total, 0, 999);
                s.taskState = stateName == "blocked" ? 1 : stateName == "done" ? 2 : 0;
            });
            handled = true;
        }
        else if (!strcmp(name, "desktop.busy")) {
            const bool on = (int)(doc["params"]["on"] | 0) != 0;
            update([&](Snapshot &s) { s.desktopBusy = on; });
            handled = true;
        }
        else if (!strcmp(name, "ask.waiting")) {
            // Axis keeps the questions. This is only so a screen can say one is waiting somewhere.
            const uint8_t elsewhere = (uint8_t)constrain((int)(doc["params"]["elsewhere"] | 0), 0, 255);
            update([&](Snapshot &s) { s.asksElsewhere = elsewhere; });
            handled = true;
        }
        if (self.commandHandler_ && self.commandHandler_(name, doc["params"], payload)) handled = true;
        result["ok"] = handled;
        if (!handled) {
            result.remove("payload");
            result["error"] = "not implemented on this device";
        }
        send(result);
        if (!strcmp(name, "reboot")) {
            socket.loop();
            delay(300);
            ESP.restart();
        }
    }

    void axisTick() {
        if (setupMode) return;
        if (WiFi.status() != WL_CONNECTED) {
            stopSocket();
            setLink(Link::WifiConnecting, everJoined ? "Wi-Fi dropped, reconnecting" : "");
            return;
        }
        if (token.isEmpty()) {
            if (pairingCode.isEmpty() || baseUrl.isEmpty()) {
                if (state.link != Link::Unpaired) setLink(Link::Unpaired, "");
            } else {
                if (state.link != Link::Pairing) setLink(Link::Pairing, "");
                if (lastPairAttempt == 0 || millis() - lastPairAttempt > PAIR_RETRY_MS) pair();
            }
            return;
        }
        // A new address that has not let the device back in goes back to the old one.
        if (addressTrialUntil && !welcomed && (int32_t)(millis() - addressTrialUntil) > 0) revertAddress();
        // A new firmware that cannot reach Axis in three minutes goes back to the one before.
        if (unproven && !welcomed && millis() > UNPROVEN_MS) {
            logf("the new firmware never reached Axis, going back to the old one");
            delay(200);
            esp_ota_mark_app_invalid_rollback_and_reboot();
            unproven = false;  // only reached when there is nothing to go back to
        }
        if (!socketStarted) startSocket();
        socket.loop();
        if (!socketStarted) return;  // a message handler dropped the pairing
        self.online_ = welcomed;
        self.speaking_ = !speakTurn.isEmpty();
        if (!welcomed) {
            if (state.link == Link::Online) setLink(Link::Connecting, "Lost Axis, reconnecting");
            else if (state.link != Link::Connecting) setLink(Link::Connecting, "");
            self.wantGesture_ = nullptr;  // a swipe made while offline means nothing later
            return;
        }
        setLink(Link::Online, state.turn == Turn::Error ? state.note : "");
        speechTick();
        recordingTick();
        if (self.wantInterrupt_) {
            self.wantInterrupt_ = false;
            quiet();
            JsonDocument doc;
            doc["t"] = "interrupt";
            send(doc);
        }
        if (self.wantAnswer_ >= 0) {
            const int8_t index = self.wantAnswer_;
            self.wantAnswer_ = -1;
            if (!state.askId.isEmpty() && index < state.choiceCount) {
                JsonDocument doc;
                doc["t"] = "answer";
                doc["askId"] = state.askId;
                doc["choice"] = state.choices[index];
                send(doc);
                logf("answered: %s", state.choices[index].c_str());
                endAsk();
            }
        }
        if (self.wantGesture_) {
            const char *name = self.wantGesture_;
            self.wantGesture_ = nullptr;
            JsonDocument doc;
            doc["t"] = "gesture";
            doc["gesture"] = name;
            send(doc);
            logf("gesture: %s", name);
        }
        if (askDeadline && (int32_t)(millis() - askDeadline) > 0) endAsk();
        if (resetWanted) {
            socket.loop();  // let the answer out first
            delay(200);
            factoryReset(resetWanted == 2);
        }
        if (!addressWanted.isEmpty()) {
            const String url = addressWanted;
            addressWanted = "";
            socket.loop();  // let the answer out on the old address first
            tryAddress(url);
            return;
        }
        if (wakeFetchWanted) {
            wakeFetchWanted = false;
            socket.loop();
            fetchWakeModel();
        }
        // A restart for a new wake word waits until nobody is talking to the device.
        if (restartWanted && state.turn == Turn::Idle && !self.recording_ && speakTurn.isEmpty() && state.askId.isEmpty()) {
            logf("restarting to change the wake word");
            socket.disconnect();
            delay(300);
            ESP.restart();
        }
        if (updateWanted) {
            updateWanted = false;
            socket.loop();  // let the answer to the command out first
            runUpdate();
        }
        if (millis() - lastSense > SENSE_INTERVAL_MS) {
            lastSense = millis();
            JsonDocument doc;
            doc["t"] = "sense";
            doc["readings"]["rssi"] = WiFi.RSSI();
            doc["readings"]["heap"] = ESP.getFreeHeap();
            doc["readings"]["uptimeS"] = millis() / 1000;
            doc["readings"]["axis"] = baseUrl;
            doc["readings"]["lastStart"] = resetReason();
            xSemaphoreTake(lock, portMAX_DELAY);
            for (int i = 0; i < boardReadings; i++) doc["readings"][boardReadingKey[i]] = boardReadingValue[i];
            xSemaphoreGive(lock);
            if (wakeModelsTaken) {
                Preferences wk;
                wk.begin(WAKE_PREFS, true);
                doc["readings"]["wakeWord"] = storedWakeRunning ? wk.getString("id", "built-in") : String("built-in");
            }
            send(doc);
        }
    }

    // --- recording ---------------------------------------------------------

    size_t ringCount(size_t head, size_t tail, size_t size) const { return (head + size - tail) % size; }

    void outWrite(const int16_t *samples, size_t count) {
        for (size_t i = 0; i < count; i++) {
            const size_t next = (outHead + 1) % OUT_RING_SAMPLES;
            if (next == outTail) {
                droppedSamples += count - i;  // the network is behind; the end of the sentence is lost, not the start
                return;
            }
            outRing[outHead] = samples[i];
            outHead = next;
        }
    }

    void preWrite(const int16_t *samples, size_t count) {
        for (size_t i = 0; i < count; i++) {
            preRing[preHead] = samples[i];
            preHead = (preHead + 1) % PRE_RING_SAMPLES;
        }
        preFill = min(PRE_RING_SAMPLES, preFill + count);
    }

    /** Copies the newest `count` samples of the pre-roll ring to the outgoing ring. */
    void flushPreRoll(size_t count) {
        count = min(count, preFill);
        for (size_t i = 0; i < count; i++) {
            const size_t at = (preHead + PRE_RING_SAMPLES - count + i) % PRE_RING_SAMPLES;
            outWrite(&preRing[at], 1);
        }
    }

    /** Forgets the recording in progress. Caller holds `audioLock`, or no recording can be running. */
    void dropRecordingLocked() {
        outHead = outTail = 0;
        wakePending = wakeToSend = startSent = onset = endWanted = quietWanted = false;
        self.recording_ = false;
    }

    void cancelRecording() {
        if (!outRing) return;
        xSemaphoreTake(audioLock, portMAX_DELAY);
        dropRecordingLocked();
        xSemaphoreGive(audioLock);
    }

    struct VadLimits {
        uint32_t onsetMs, silenceMs, maxMs;
    };

    /** Settings are read BEFORE `audioLock`, so the two locks are never held together. */
    VadLimits vadLimits() {
        return {(uint32_t)constrain(self.settingInt("onsetMs", 6000), 1000, 20000),
                (uint32_t)constrain(self.settingInt("silenceMs", 900), 300, 5000),
                (uint32_t)constrain(self.settingInt("maxSpeechMs", 20000), 3000, 60000)};
    }

    String newTurnId() { return "m" + String(millis()) + "-" + String(++recordingCount); }

    /** Whether a cue should play when listening starts, and how long the microphone is deaf for it. */
    size_t cueSamples() {
        if (!self.listenCue_ || self.settingInt("listenCue", 1) == 0) return 0;
        return (size_t)self.cueMs_ * MIC_RATE / 1000;
    }

    void playCue() {
        if (self.listenCue_ && self.settingInt("listenCue", 1) != 0) self.listenCue_();
    }

    void onWakeResult(const char *id, bool granted) {
        if (!outRing) return;
        const size_t cue = cueSamples();
        bool cueNow = false;
        xSemaphoreTake(audioLock, portMAX_DELAY);
        if (self.recording_ && wakePending && wakeId == id) {
            if (granted) {
                wakePending = false;
                settleLeft = max(settleLeft, cue);
                cueNow = cue > 0;
                logf("wake granted");
            } else {
                dropRecordingLocked();
                logf("another device took the wake");
            }
        }
        xSemaphoreGive(audioLock);
        if (cueNow) playCue();
    }

    /**
     * After a spoken answer the device listens briefly, so a conversation does
     * not need the wake word every time. Silence just ends it. Client task only.
     */
    void startFollowUp() {
        const long waitMs = self.settingInt("followUpMs", 6000);
        if (waitMs > 0) listenUnasked(waitMs, false, "follow_up");
    }

    /**
     * Axis has spoken a question and now wants the answer. The choices go to
     * the board to show; the microphone opens for a spoken answer, which Axis
     * matches to a choice itself.
     */
    void onAsk(JsonDocument &doc) {
        const uint32_t timeoutMs = doc["timeoutMs"] | 30000;
        JsonArrayConst list = doc["choices"];
        update([&](Snapshot &s) {
            s.askId = doc["askId"] | "";
            s.question = doc["question"] | "";
            s.choiceCount = 0;
            for (JsonVariantConst choice : list) {
                if (s.choiceCount >= 6) break;
                s.choices[s.choiceCount++] = choice.as<String>();
            }
        });
        askDeadline = millis() + timeoutMs;
        if (!askDeadline) askDeadline = 1;
        logf("asked: %s (%u choices)", state.question.c_str(), (unsigned)state.choiceCount);
        listenUnasked((long)min(timeoutMs, (uint32_t)20000), true, "question");
    }

    /** The question is over. A recording nobody has spoken into goes with it. */
    void endAsk() {
        if (state.askId.isEmpty()) return;
        askDeadline = 0;
        update([](Snapshot &s) {
            s.askId = "";
            s.question = "";
            s.choiceCount = 0;
        });
        if (!outRing) return;
        xSemaphoreTake(audioLock, portMAX_DELAY);
        const bool spoken = onset;
        xSemaphoreGive(audioLock);
        if (!spoken) self.stopListening(true);
    }

    /** Opens the microphone without a wake word or a tap, for `waitMs` of silence at most. Client task only. */
    void listenUnasked(long waitMs, bool withCue, const char *why) {
        if (!outRing || !self.online_ || self.micOff_) return;
        const VadLimits limits = vadLimits();
        const size_t cue = withCue ? cueSamples() : 0;
        bool started = false;
        xSemaphoreTake(audioLock, portMAX_DELAY);
        if (!self.recording_) {
            dropRecordingLocked();
            vad.begin((uint32_t)constrain(waitMs, 1000, 30000), limits.silenceMs, limits.maxMs);
            wakeId = "";
            trigger = why;
            turnId = newTurnId();
            quietWanted = false;
            preFill = 0;
            // The speaker's own tail must not count as the person answering. A follow-up has no
            // cue: the face turning green is enough when the device was just talking.
            settleLeft = max((size_t)TAIL_SETTLE_SAMPLES, cue);
            self.recording_ = true;
            started = true;
        }
        xSemaphoreGive(audioLock);
        if (started && cue > 0) playCue();
        if (started) logf("listening unasked for %ld ms", waitMs);
    }

    /** Moves the recording along over the network: wake, start, audio, end. Client task only. */
    void recordingTick() {
        if (!outRing) return;
        static int16_t block[SEND_BLOCK_SAMPLES];
        bool sendWake = false, sendStart = false, sendEnd = false, quietNow = false;
        size_t count = 0;
        String wid, tid;
        float score = 0, level = 0;
        const char *reason = "silence";
        uint32_t spokenMs = 0, peak = 0, room = 0;

        xSemaphoreTake(audioLock, portMAX_DELAY);
        if (self.recording_) {
            quietNow = quietWanted;
            quietWanted = false;
            if (wakeToSend) {
                wakeToSend = false;
                wakeSentAt = millis();
                sendWake = true;
                wid = wakeId;
                score = wakeScore;
                level = wakeLevel;
            } else if (wakePending && millis() - wakeSentAt > WAKE_ANSWER_MS) {
                dropRecordingLocked();
                logf("no answer to the wake, dropped");
            }
            if (self.recording_ && !wakePending && !startSent) {
                startSent = true;
                sendStart = true;
                tid = turnId;
                wid = wakeId;
            }
            if (self.recording_ && startSent) {
                while (count < SEND_BLOCK_SAMPLES && outTail != outHead) {
                    block[count++] = outRing[outTail];
                    outTail = (outTail + 1) % OUT_RING_SAMPLES;
                }
                if (endWanted && outTail == outHead) {
                    sendEnd = true;
                    reason = endReason;
                    tid = turnId;
                    spokenMs = vad.spokenMs();
                    peak = vad.peak();
                    room = vad.floor();
                    dropRecordingLocked();
                }
            }
        }
        xSemaphoreGive(audioLock);

        if (quietNow) {
            const bool wasSpeaking = !speakTurn.isEmpty();
            quiet();
            if (wasSpeaking) {
                xSemaphoreTake(audioLock, portMAX_DELAY);
                settleLeft = max(settleLeft, TAIL_SETTLE_SAMPLES);
                xSemaphoreGive(audioLock);
            }
        }
        if (sendWake) {
            JsonDocument doc;
            doc["t"] = "wake";
            doc["wakeId"] = wid;
            doc["score"] = score;
            doc["level"] = level;
            send(doc);
            logf("wake sent (score %.2f)", score);
        }
        if (sendStart) {
            JsonDocument doc;
            doc["t"] = "audio.start";
            doc["turnId"] = tid;
            lastVoiceTurn = tid;
            doc["format"]["encoding"] = "pcm_s16le";
            doc["format"]["sampleRate"] = MIC_RATE;
            doc["format"]["channels"] = 1;
            if (!wid.isEmpty()) doc["wakeId"] = wid;
            doc["trigger"] = trigger;
            send(doc);
            logf("recording %s (%s)", tid.c_str(), trigger);
        }
        if (count) socket.sendBIN((uint8_t *)block, count * sizeof(int16_t));
        if (sendEnd) {
            JsonDocument doc;
            doc["t"] = "audio.end";
            doc["turnId"] = tid;
            doc["reason"] = reason;
            send(doc);
            logf("recording done (%s): %u ms of speech, loudest %u, room %u", reason, (unsigned)spokenMs, (unsigned)peak, (unsigned)room);
        }
    }

    // --- serial console ----------------------------------------------------

    void consoleTick() {
        while (console && console->available()) {
            const char c = (char)console->read();
            if (c == '\n' || c == '\r') {
                consoleLine.trim();
                if (!consoleLine.isEmpty()) onConsole(consoleLine);
                consoleLine = "";
            } else if (consoleLine.length() < 300) {
                consoleLine += c;
            }
        }
    }

    void onConsole(const String &line) {
        const int space = line.indexOf(' ');
        const String word = space < 0 ? line : line.substring(0, space);
        String rest = space < 0 ? "" : line.substring(space + 1);
        rest.trim();
        if (word == "status") {
            static const char *const links[] = {"starting", "setup", "wifi-connecting", "unpaired", "pairing", "connecting", "online"};
            logf("link=%s wifi=\"%s\" ip=%s rssi=%d axis=%s name=\"%s\" settings=v%u heap=%u low=%u note=\"%s\"",
                 links[(int)state.link], savedNetwork().c_str(), WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(),
                 baseUrl.c_str(), state.name.c_str(), (unsigned)settingsVersion, (unsigned)ESP.getFreeHeap(),
                 (unsigned)ESP.getMinFreeHeap(), state.note.c_str());
        } else if (word == "wifi" && !rest.isEmpty()) {
            // The password is everything after the last space, so names with spaces work.
            const int split = rest.lastIndexOf(' ');
            everJoined = false;
            if (split < 0) join(rest.c_str(), "");
            else join(rest.substring(0, split).c_str(), rest.substring(split + 1).c_str());
        } else if (word == "setup" && !rest.isEmpty()) {
            if (!applySetupString(rest)) logf("not a setup string; expected axis://address:port/code");
        } else if (word == "text" && !rest.isEmpty()) {
            if (!welcomed) return logf("not connected to Axis");
            JsonDocument doc;
            doc["t"] = "text";
            doc["turnId"] = "t" + String(millis());
            doc["text"] = rest;
            send(doc);
        } else if (word == "stop") {
            self.wantInterrupt_ = true;
        } else if (word == "talk") {
            if (!self.startListening()) logf("cannot listen now (not connected, no microphone, or already listening)");
        } else if (word == "mic") {
            const MicStats m = self.micStats();
            logf("mic: room level %u, speech starts above %u, loudest this recording %u, dropped %u samples", (unsigned)m.floor,
                 (unsigned)m.onset, (unsigned)m.peak, (unsigned)m.dropped);
        } else if (word == "forget") {
            if (rest == "wifi") {
                WiFi.disconnect(false, true);
                everJoined = false;
                startSetup("");
            } else {
                forgetPairing();
                logf("pairing forgotten");
            }
        } else if (word == "tlscheck") {
            // Can this device reach an https address and trust its certificate? Run before moving a device to one.
            NetworkClientSecure tls;
            tls.setCACertBundle(caBundleStart, caBundleEnd - caBundleStart);
            HTTPClient http;
            http.setConnectTimeout(8000);
            http.setTimeout(8000);
            const uint32_t began = millis();
            const int status = http.begin(tls, rest) ? http.GET() : -1000;
            logf("tlscheck %s: %s (%d) in %lu ms, heap %u", rest.c_str(), status > 0 ? "reached and trusted" : HTTPClient::errorToString(status).c_str(),
                 status, (unsigned long)(millis() - began), (unsigned)ESP.getFreeHeap());
            http.end();
        } else if (word == "reboot") {
            ESP.restart();
        } else if (self.consoleHandler_ && self.consoleHandler_(word, rest)) {
            // the board handled it
        } else {
            logf("commands: status | wifi <name> <password> | setup <axis://...> | text <words> | talk | mic | stop | forget [wifi] | tlscheck <https://...> | reboot");
        }
    }

    // --- task --------------------------------------------------------------

    void run() {
        load();
        WiFi.persistent(true);
        WiFi.setAutoReconnect(true);
        WiFi.mode(WIFI_STA);
        WiFi.setHostname(setupNetworkName().c_str());
        WiFi.onEvent([this](arduino_event_id_t, arduino_event_info_t info) {
            const uint8_t reason = info.wifi_sta_disconnected.reason;
            if (!everJoined) joinFailures++;
            logf("Wi-Fi disconnected, reason %u %s", reason, disconnectReason(reason));
        }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

        startWeb();
        if (savedNetwork().isEmpty()) startSetup("");
        else join();

        for (;;) {
            if (setupMode) dns.processNextRequest();
            web.handleClient();
            wifiTick();
            axisTick();
            consoleTick();
            // Short enough that speech frames are picked up as fast as Axis sends them.
            delay(2);
        }
    }
};

// An encrypted connection needs about 45 KB for its buffers and handshake, and the framework is built to
// take all of it from the small internal memory, which the Wi-Fi stack, the task stacks and the wake word
// already share. On a board with the large (PSRAM) memory that is where it goes instead; without one, or
// if that is full, it falls back to internal memory as before.
static void *tlsCalloc(size_t count, size_t size) {
    return heap_caps_calloc_prefer(count, size, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

void Client::begin(const Identity &identity, Stream *console) {
    mbedtls_platform_set_calloc_free(tlsCalloc, free);
    impl_ = new Impl(*this);
    impl_->identity = identity;
    impl_->console = console;
    esp_ota_img_states_t slot = ESP_OTA_IMG_UNDEFINED;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &slot) == ESP_OK && slot == ESP_OTA_IMG_PENDING_VERIFY) {
        impl_->unproven = true;
        if (console) console->println("[axis] first start of a new firmware; it is kept once it reaches Axis");
    }
    for (size_t i = 0; i < identity.capabilityCount; i++) {
        if (strcmp(identity.capabilities[i], "mic") != 0) continue;
        impl_->outRing = (int16_t *)heap_caps_malloc(OUT_RING_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM);
        impl_->preRing = (int16_t *)heap_caps_malloc(PRE_RING_SAMPLES * sizeof(int16_t), MALLOC_CAP_SPIRAM);
        if (!impl_->outRing || !impl_->preRing) {
            // Better to report no microphone than to claim one that cannot record.
            if (console) console->println("[axis] no memory for the recording buffers; microphone disabled");
            if (impl_->outRing) heap_caps_free(impl_->outRing);
            if (impl_->preRing) heap_caps_free(impl_->preRing);
            impl_->outRing = impl_->preRing = nullptr;
        }
    }
    xTaskCreatePinnedToCore([](void *arg) { static_cast<Impl *>(arg)->run(); }, "axis", 12288, impl_, 3, nullptr, 0);
}

Snapshot Client::snapshot() {
    xSemaphoreTake(impl_->lock, portMAX_DELAY);
    Snapshot copy = impl_->state;
    xSemaphoreGive(impl_->lock);
    return copy;
}

void Client::feedAudio(const int16_t *samples, size_t count) {
    Impl &m = *impl_;
    if (!m.outRing || !count) return;
    const uint32_t loud = loudnessOf(samples, count);
    const uint32_t blockMs = count * 1000 / MIC_RATE;

    xSemaphoreTake(m.audioLock, portMAX_DELAY);
    if (!recording_) {
        // Our own voice is not the room: counting it would raise the bar for the next sentence.
        if (!speaking_) m.vad.observeRoom(loud);
        m.preWrite(samples, count);
    } else if (m.settleLeft > 0) {
        m.settleLeft -= min(m.settleLeft, count);
    } else if (m.endWanted) {
        // Already finished; whatever follows belongs to the next recording.
    } else if (!m.onset) {
        m.preWrite(samples, count);
        switch (m.vad.step(loud, blockMs)) {
            case Vad::Event::Onset:
                m.onset = true;
                m.flushPreRoll(PRE_ROLL_SAMPLES);
                break;
            case Vad::Event::NoSpeech:
                m.endWanted = true;
                m.endReason = "cancel";
                break;
            default:
                break;
        }
    } else {
        m.outWrite(samples, count);
        const Vad::Event event = m.vad.step(loud, blockMs);
        if (event == Vad::Event::Silence || event == Vad::Event::TooLong) {
            m.endWanted = true;
            m.endReason = event == Vad::Event::Silence ? "silence" : "max";
        }
    }
    xSemaphoreGive(m.audioLock);
}

void Client::wakeHeard(float score, float level) {
    Impl &m = *impl_;
    if (!m.outRing || recording_ || !online_) return;
    const Impl::VadLimits limits = m.vadLimits();
    xSemaphoreTake(m.audioLock, portMAX_DELAY);
    if (!recording_) {
        m.dropRecordingLocked();
        m.vad.begin(limits.onsetMs, limits.silenceMs, limits.maxMs);
        m.wakeId = "w" + String(millis()) + "-" + String(++m.recordingCount);
        m.trigger = "wake";
        m.turnId = m.newTurnId();
        m.wakeScore = constrain(score, 0.0f, 1.0f);
        m.wakeLevel = constrain(level, 0.0f, 1.0f);
        m.wakePending = m.wakeToSend = true;
        m.quietWanted = true;
        m.preFill = 0;
        m.settleLeft = WAKE_SETTLE_SAMPLES;
        recording_ = true;
    }
    xSemaphoreGive(m.audioLock);
}

bool Client::startListening() {
    Impl &m = *impl_;
    if (!m.outRing || recording_ || !online_ || micOff_) return false;
    const Impl::VadLimits limits = m.vadLimits();
    const size_t cue = m.cueSamples();
    bool started = false;
    xSemaphoreTake(m.audioLock, portMAX_DELAY);
    if (!recording_) {
        m.dropRecordingLocked();
        m.vad.begin(limits.onsetMs, limits.silenceMs, limits.maxMs);
        m.wakeId = "";
        m.trigger = "tap";
        m.turnId = m.newTurnId();
        m.quietWanted = true;
        m.settleLeft = cue;
        recording_ = true;
        started = true;
    }
    xSemaphoreGive(m.audioLock);
    if (started && cue > 0) m.playCue();
    return started;
}

void Client::stopListening(bool discard) {
    Impl &m = *impl_;
    if (!m.outRing || !recording_) return;
    xSemaphoreTake(m.audioLock, portMAX_DELAY);
    if (recording_) {
        if (discard || !m.onset || m.wakePending) {
            // Nothing worth sending yet, or the caller does not want it. If Axis already heard `audio.start`, it is told.
            if (m.startSent) {
                m.endWanted = true;
                m.endReason = "cancel";
                m.outTail = m.outHead;
            } else {
                m.dropRecordingLocked();
            }
        } else {
            m.endWanted = true;
            m.endReason = "silence";
        }
    }
    xSemaphoreGive(m.audioLock);
}

Client::MicStats Client::micStats() {
    MicStats stats;
    if (!impl_->outRing) return stats;
    xSemaphoreTake(impl_->audioLock, portMAX_DELAY);
    stats.floor = impl_->vad.floor();
    stats.onset = impl_->vad.onsetThreshold();
    stats.peak = impl_->vad.peak();
    stats.dropped = impl_->droppedSamples;
    xSemaphoreGive(impl_->audioLock);
    return stats;
}

String Client::setting(const char *key, const char *fallback) {
    xSemaphoreTake(impl_->lock, portMAX_DELAY);
    JsonVariantConst value = impl_->settings[key];
    String out = value.isNull() ? String(fallback) : value.as<String>();
    xSemaphoreGive(impl_->lock);
    return out;
}

bool Client::takePicture(uint8_t *&data, size_t &size, String &turnId) {
    xSemaphoreTake(impl_->lock, portMAX_DELAY);
    const bool have = impl_->readyPic != nullptr;
    if (have) {
        data = impl_->readyPic;
        size = impl_->readyPicSize;
        turnId = impl_->readyPicTurn;
        impl_->readyPic = nullptr;
        impl_->readyPicSize = 0;
    }
    xSemaphoreGive(impl_->lock);
    return have;
}

void Client::setReading(const char *key, long value) {
    xSemaphoreTake(impl_->lock, portMAX_DELAY);
    int at = 0;
    while (at < impl_->boardReadings && strcmp(impl_->boardReadingKey[at], key)) at++;
    if (at < Impl::MAX_BOARD_READINGS) {
        if (at == impl_->boardReadings) {
            impl_->boardReadingKey[at] = key;
            impl_->boardReadings++;
            impl_->boardReadingValue[at] = value - 1;  // so the first value counts as a change
        }
        if (impl_->boardReadingValue[at] != value) {
            impl_->boardReadingValue[at] = value;
            // Send the readings on the next pass. Not 0: in the first minute after a start that would wait it out.
            impl_->lastSense = millis() - SENSE_INTERVAL_MS - 1;
        }
    }
    xSemaphoreGive(impl_->lock);
}

long Client::settingInt(const char *key, long fallback) {
    xSemaphoreTake(impl_->lock, portMAX_DELAY);
    JsonVariantConst value = impl_->settings[key];
    // Settings typed into the admin page arrive as text, so accept "90" as well as 90.
    long out = fallback;
    if (value.is<long>()) out = value.as<long>();
    else if (value.is<const char *>() && *value.as<const char *>()) out = atol(value.as<const char *>());
    xSemaphoreGive(impl_->lock);
    return out;
}

}  // namespace axis
