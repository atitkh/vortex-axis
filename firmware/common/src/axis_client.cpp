#include "axis_client.h"

#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_heap_caps.h>
#include <stdarg.h>

#include "vad.h"

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
    float wakeScore = 0, wakeLevel = 0;
    uint32_t wakeSentAt = 0, recordingCount = 0, droppedSamples = 0;
    size_t settleLeft = 0;
    /** The last turn this device recorded. A spoken reply to it is followed by a short listen. */
    String lastVoiceTurn;

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

        if (baseUrl.startsWith("https://")) {
            setLink(Link::Pairing, "This firmware cannot use an encrypted Axis address yet");
            return;
        }
        WiFiClient transport;
        HTTPClient http;
        http.setConnectTimeout(4000);
        http.setTimeout(6000);
        if (!http.begin(transport, baseUrl + "/v1/pair")) {
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

    void startSocket() {
        String rest = baseUrl.substring(baseUrl.indexOf("://") + 3);
        uint16_t port = 80;
        const int colon = rest.lastIndexOf(':');
        if (colon > 0) {
            port = (uint16_t)rest.substring(colon + 1).toInt();
            rest = rest.substring(0, colon);
        }
        socket.onEvent([this](WStype_t type, uint8_t *payload, size_t length) { onSocket(type, payload, length); });
        socket.setReconnectInterval(3000);
        // Without this a silently dead link (Axis host gone, Wi-Fi roam) looks connected forever.
        socket.enableHeartbeat(15000, 5000, 2);
        socket.begin(rest.c_str(), port, "/v1/client");
        socketStarted = true;
        logf("connecting to Axis at %s:%u", rest.c_str(), port);
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

    void onMessage(uint8_t *payload, size_t length) {
        JsonDocument doc;
        if (deserializeJson(doc, payload, length)) return;
        const char *t = doc["t"] | "";

        if (!strcmp(t, "welcome")) {
            welcomed = true;
            lastSense = millis() - SENSE_INTERVAL_MS + 5000;
            logf("connected to Axis");
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
            logf("turn %s %s", doc["state"] | "", detail.c_str());
            update([&](Snapshot &s) {
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
        } else if (!strcmp(t, "speak.start")) {
            if (!self.sink_) return;
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
            handled = true;
        } else if (!strcmp(name, "reboot")) {
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
        if (!socketStarted) startSocket();
        socket.loop();
        if (!socketStarted) return;  // a message handler dropped the pairing
        self.online_ = welcomed;
        self.speaking_ = !speakTurn.isEmpty();
        if (!welcomed) {
            if (state.link == Link::Online) setLink(Link::Connecting, "Lost Axis, reconnecting");
            else if (state.link != Link::Connecting) setLink(Link::Connecting, "");
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
        if (millis() - lastSense > SENSE_INTERVAL_MS) {
            lastSense = millis();
            JsonDocument doc;
            doc["t"] = "sense";
            doc["readings"]["rssi"] = WiFi.RSSI();
            doc["readings"]["heap"] = ESP.getFreeHeap();
            doc["readings"]["uptimeS"] = millis() / 1000;
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
        if (waitMs <= 0 || !outRing || !self.online_) return;
        const VadLimits limits = vadLimits();
        const size_t cue = cueSamples();
        bool started = false;
        xSemaphoreTake(audioLock, portMAX_DELAY);
        if (!self.recording_) {
            dropRecordingLocked();
            vad.begin((uint32_t)constrain(waitMs, 1000, 30000), limits.silenceMs, limits.maxMs);
            wakeId = "";
            turnId = newTurnId();
            quietWanted = false;
            preFill = 0;
            // The speaker's own tail and the cue must not count as the person answering.
            settleLeft = TAIL_SETTLE_SAMPLES + cue;
            self.recording_ = true;
            started = true;
        }
        xSemaphoreGive(audioLock);
        if (started) {
            logf("listening for a follow-up for %ld ms", waitMs);
            playCue();
        }
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
            send(doc);
            logf("recording %s", tid.c_str());
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
        } else if (word == "reboot") {
            ESP.restart();
        } else if (self.consoleHandler_ && self.consoleHandler_(word, rest)) {
            // the board handled it
        } else {
            logf("commands: status | wifi <name> <password> | setup <axis://...> | text <words> | talk | mic | stop | forget [wifi] | reboot");
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

void Client::begin(const Identity &identity, Stream *console) {
    impl_ = new Impl(*this);
    impl_->identity = identity;
    impl_->console = console;
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
    if (!m.outRing || recording_ || !online_) return false;
    const Impl::VadLimits limits = m.vadLimits();
    const size_t cue = m.cueSamples();
    bool started = false;
    xSemaphoreTake(m.audioLock, portMAX_DELAY);
    if (!recording_) {
        m.dropRecordingLocked();
        m.vad.begin(limits.onsetMs, limits.silenceMs, limits.maxMs);
        m.wakeId = "";
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
