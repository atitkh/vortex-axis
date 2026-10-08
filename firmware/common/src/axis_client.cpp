#include "axis_client.h"

#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <stdarg.h>

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
                  "<button>Save</button></form><p><a href='/?rescan=1' style='color:#19b8c9'>Search for networks again</a></p>");
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
            send(hello);
        } else if (type == WStype_DISCONNECTED) {
            if (welcomed) logf("lost the connection to Axis");
            welcomed = false;
        } else if (type == WStype_TEXT) {
            onMessage(payload, length);
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
        if (!welcomed) {
            if (state.link == Link::Online) setLink(Link::Connecting, "Lost Axis, reconnecting");
            else if (state.link != Link::Connecting) setLink(Link::Connecting, "");
            return;
        }
        setLink(Link::Online, state.turn == Turn::Error ? state.note : "");
        if (self.wantInterrupt_) {
            self.wantInterrupt_ = false;
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
        } else {
            logf("commands: status | wifi <name> <password> | setup <axis://...> | text <words> | forget [wifi] | reboot");
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
            delay(5);
        }
    }
};

void Client::begin(const Identity &identity, Stream *console) {
    impl_ = new Impl(*this);
    impl_->identity = identity;
    impl_->console = console;
    xTaskCreatePinnedToCore([](void *arg) { static_cast<Impl *>(arg)->run(); }, "axis", 12288, impl_, 3, nullptr, 0);
}

Snapshot Client::snapshot() {
    xSemaphoreTake(impl_->lock, portMAX_DELAY);
    Snapshot copy = impl_->state;
    xSemaphoreGive(impl_->lock);
    return copy;
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
