#include "axis_power.h"

#include <Wire.h>

#include "charge_hold.h"
#include "charge_taper.h"

namespace power {
namespace {

const uint8_t REG_STATUS1 = 0x00;   // bit 5 USB power good, bit 3 battery connected
const uint8_t REG_STATUS2 = 0x01;   // bits 6..5: 01 charging, 10 discharging; bits 2..0 the charger's state
const uint8_t REG_CHIP_ID = 0x03;   // reads 0x4A on an AXP2101
const uint8_t REG_ADC_ON = 0x30;    // bit 0 battery voltage, bit 2 USB voltage, bit 4 the chip's temperature
const uint8_t REG_VBAT_H = 0x34;    // 0x34..0x35: battery millivolts, 13 bits
const uint8_t REG_VBUS_H = 0x38;    // 0x38..0x39: USB input millivolts, 14 bits
const uint8_t REG_TEMP_H = 0x3C;    // 0x3C..0x3D: temperature, 14 bits
const uint8_t REG_CHARGER_CTRL = 0x18;  // bit 1: the battery charger on
const uint8_t REG_CHARGE_CURRENT = 0x62;  // bits 4..0: constant-current charge, charge_taper.h's codes
const uint8_t REG_TARGET_V = 0x64;      // bits 2..0: charge target, 1 = 4.0 V, 2 = 4.1 V, 3 = 4.2 V
const uint8_t REG_PERCENT = 0xA4;   // the fuel gauge, in %
const uint8_t CHIP_ID = 0x4A;
const uint32_t READ_EVERY_MS = 30000;
const uint32_t FIRST_READ_MS = 2000;  // the measurements just switched on need a moment

uint8_t addr = 0x34;
bool present = false;
uint32_t lastRead = 0;
Reading kept;
volatile int limitWanted = CHARGE_LIMIT_OFF;  // from setChargeLimit, any task
int limitSeen = CHARGE_LIMIT_OFF;     // the value the last read was made for (a new one reads at once)
int limitApplied = CHARGE_LIMIT_OFF;  // the value the charger was last set for
bool held = false;
volatile int currentWanted = CHARGE_CURRENT_MAX_MA;  // from setChargeCurrent, any task
int currentSeen = CHARGE_CURRENT_MAX_MA;
Taper taper;
int startMa = -1;  // the charge current the chip held at the start, -1 when it could not be read
portMUX_TYPE keptLock = portMUX_INITIALIZER_UNLOCKED;

bool readRegs(uint8_t reg, uint8_t *out, uint8_t count) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(true) != 0) return false;
    if (Wire.requestFrom(addr, count) != count) return false;
    for (uint8_t i = 0; i < count; i++) out[i] = Wire.read();
    return true;
}

bool writeReg(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission(true) == 0;
}

}  // namespace

bool begin(uint8_t address) {
    addr = address;
    uint8_t id = 0, adc = 0;
    present = readRegs(REG_CHIP_ID, &id, 1) && id == CHIP_ID;
    if (!present) return false;
    // Only measurements are switched on here; nothing about the chip's outputs or charging is changed.
    if (readRegs(REG_ADC_ON, &adc, 1) && (adc & 0x15) != 0x15) writeReg(REG_ADC_ON, adc | 0x15);
    // Whatever a charge limit left before a restart: charging on, full target, until the limit is applied again.
    setCharging(true);
    setTargetMv(4200);
    held = false;
    // The charge current is left as it is until the first reading with a battery on USB; only read here.
    uint8_t cc = 0;
    startMa = readRegs(REG_CHARGE_CURRENT, &cc, 1) ? chargeCurrentMaOf(cc & 0x1F) : -1;
    taper = Taper();
    lastRead = millis() - READ_EVERY_MS + FIRST_READ_MS;
    return true;
}

bool tick() {
    if (!present) return false;
    const uint32_t now = millis();
    const int limit = limitWanted;
    const int maxMa = currentWanted;
    if (now - lastRead < READ_EVERY_MS && limit == limitSeen && maxMa == currentSeen) return false;
    lastRead = now;
    limitSeen = limit;
    currentSeen = maxMa;
    uint8_t st[2], v[2], t[2], u[2], pct = 0;
    if (!readRegs(REG_STATUS1, st, 2)) return false;
    bool good = true;  // every reading the hold rule needs came back
    Reading r;
    r.taken = true;
    r.vbus = st[0] & 0x20;
    r.battery = st[0] & 0x08;
    r.chargerState = st[1] & 0x07;
    if (r.battery) {
        r.charging = ((st[1] >> 5) & 0x03) == 0x01;
        if (readRegs(REG_VBAT_H, v, 2)) r.batteryMv = ((v[0] & 0x1F) << 8) | v[1];
        if (readRegs(REG_PERCENT, &pct, 1) && pct <= 100) r.percent = pct;
        else good = false;
    }
    if (r.vbus && readRegs(REG_VBUS_H, u, 2)) r.usbMv = ((u[0] & 0x3F) << 8) | u[1];
    if (readRegs(REG_TEMP_H, t, 2)) {
        const uint16_t raw = ((t[0] & 0x3F) << 8) | t[1];
        const float c = 22.0f + (7274 - (int)raw) / 20.0f;  // the conversion XPowersLib uses
        if (c > -30 && c < 130) r.chipTempC = c;
    }
    // The charge limit. A failed read leaves the charger as it is (and the limit to be applied next time).
    if (good) {
        const bool limited = r.battery && r.vbus && limit < CHARGE_LIMIT_OFF;
        const bool next = chargeHeld(r.battery, r.vbus, r.percent, limit, held);
        // The target first: 4.1 V as a backstop while a limit is set, back to 4.2 V when it is lifted.
        if (setTargetMv(limited ? 4100 : 4200) && setCharging(!next)) {
            if (next != held) {
                held = next;
                // The charger's own state after the change (it settles within a read or two).
                if (readRegs(REG_STATUS2, &st[1], 1)) {
                    r.chargerState = st[1] & 0x07;
                    if (r.battery) r.charging = ((st[1] >> 5) & 0x03) == 0x01;
                }
            }
            limitApplied = limit;
        }
        // The charge current's taper, written only with a battery on USB while not held (nothing otherwise).
        taperUpdate(taper, r.battery, r.vbus, r.percent, limit, r.charging, r.chipTempC);
        if (r.battery && r.vbus && !held) setChargeCurrentMa(taperMa(taper, maxMa));
    }
    uint8_t cc = 0;
    if (readRegs(REG_CHARGE_CURRENT, &cc, 1)) r.chargeCurrentMa = chargeCurrentMaOf(cc & 0x1F);
    r.held = held;
    r.limit = limitApplied;
    portENTER_CRITICAL(&keptLock);
    kept = r;
    portEXIT_CRITICAL(&keptLock);
    return true;
}

Reading last() {
    portENTER_CRITICAL(&keptLock);
    const Reading r = kept;
    portEXIT_CRITICAL(&keptLock);
    return r;
}

void setChargeLimit(int percent) {
    limitWanted = percent >= CHARGE_LIMIT_OFF ? CHARGE_LIMIT_OFF : percent < CHARGE_LIMIT_MIN ? CHARGE_LIMIT_MIN : percent;
}

void setChargeCurrent(int ma) {
    currentWanted = ma > CHARGE_CURRENT_MAX_MA ? CHARGE_CURRENT_MAX_MA : ma < CHARGE_CURRENT_MIN_MA ? CHARGE_CURRENT_MIN_MA : ma;
}

void report(axis::Client &client) {
    const Reading r = last();
    if (!r.taken) return;
    // A temperature drifts by a degree now and then: it goes with the regular readings, not on its own.
    if (!isnan(r.chipTempC)) client.setReading("chipTempC", lroundf(r.chipTempC), false);
    else client.clearReading("chipTempC");
    if (r.battery && r.percent >= 0) client.setReading("battery", r.percent);
    else client.clearReading("battery");
    if (r.battery) {
        client.setReading("charging", r.charging ? 1 : 0);
        if (r.batteryMv > 0) client.setReading("batteryMv", r.batteryMv, false);
        else client.clearReading("batteryMv");
        client.setReading("chargerState", r.chargerState);
        client.setReading("chargeHeld", r.held ? 1 : 0);
        if (r.chargeCurrentMa >= 0) client.setReading("chargeCurrentMa", r.chargeCurrentMa);
        else client.clearReading("chargeCurrentMa");
        // Millivolts wander: with the regular readings, like batteryMv.
        if (r.vbus && r.usbMv > 0) client.setReading("usbMv", r.usbMv, false);
        else client.clearReading("usbMv");
    } else {
        client.clearReading("charging");
        client.clearReading("batteryMv");
        client.clearReading("chargerState");
        client.clearReading("chargeHeld");
        client.clearReading("chargeCurrentMa");
        client.clearReading("usbMv");
    }
}

void print(Print &out) {
    if (!present) {
        out.printf("[power] no power chip found; processor %.1f C\n", temperatureRead());
        return;
    }
    const Reading r = last();
    if (!r.taken) {
        out.println("[power] not read yet");
        return;
    }
    out.printf("[power] USB %s", r.vbus ? "yes" : "no");
    if (r.vbus) out.printf(" %d mV", r.usbMv);
    out.printf(", battery %s", r.battery ? "yes" : "none");
    if (r.battery) out.printf(" %d%% %d mV, %s (charger state %u)", r.percent, r.batteryMv, r.charging ? "charging" : "not charging", (unsigned)r.chargerState);
    if (r.limit < CHARGE_LIMIT_OFF) out.printf(", limit %d%%, %s", r.limit, r.held ? "held" : "not held");
    else out.print(", no limit");
    if (r.chargeCurrentMa >= 0) out.printf(", charge current %d mA (of %d, step %d, heat %d; %d mA at the start)", r.chargeCurrentMa, (int)currentWanted, taper.step, taper.hot, startMa);
    out.printf("; power chip %.1f C, processor %.1f C, read %lus ago\n", r.chipTempC, temperatureRead(), (unsigned long)((millis() - lastRead) / 1000));
}

void dumpRegs(Print &out) {
    if (!present) {
        out.println("[power] no power chip found");
        return;
    }
    const uint8_t starts[] = {0x00, 0x10, 0x20, 0x30, 0x60};
    for (uint8_t s : starts) {
        uint8_t b[16];
        out.printf("[power] %02X:", s);
        for (uint8_t i = 0; i < 16; i++) {
            if (readRegs(s + i, &b[i], 1)) out.printf(" %02X", b[i]);
            else out.print(" --");
        }
        out.println();
    }
}

bool setCharging(bool on) {
    if (!present) return false;
    uint8_t v = 0;
    if (!readRegs(REG_CHARGER_CTRL, &v, 1)) return false;
    const uint8_t want = on ? (v | 0x02) : (v & ~0x02);
    if (want == v) return true;
    if (!writeReg(REG_CHARGER_CTRL, want)) return false;
    return readRegs(REG_CHARGER_CTRL, &v, 1) && v == want;
}

bool setChargeCurrentMa(int ma) {
    if (!present) return false;
    uint8_t v = 0;
    if (!readRegs(REG_CHARGE_CURRENT, &v, 1)) return false;
    const uint8_t want = (v & 0xE0) | (uint8_t)chargeCurrentCode(ma);
    if (want == v) return true;
    if (!writeReg(REG_CHARGE_CURRENT, want)) return false;
    return readRegs(REG_CHARGE_CURRENT, &v, 1) && v == want;
}

bool setTargetMv(uint16_t mv) {
    if (!present) return false;
    const uint8_t code = mv <= 4000 ? 1 : mv <= 4100 ? 2 : 3;
    uint8_t v = 0;
    if (!readRegs(REG_TARGET_V, &v, 1)) return false;
    const uint8_t want = (v & ~0x07) | code;
    if (want == v) return true;
    if (!writeReg(REG_TARGET_V, want)) return false;
    return readRegs(REG_TARGET_V, &v, 1) && v == want;
}

}  // namespace power
