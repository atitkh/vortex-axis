#include "axis_power.h"

#include <Wire.h>

namespace power {
namespace {

const uint8_t REG_STATUS1 = 0x00;   // bit 5 USB power good, bit 3 battery connected
const uint8_t REG_STATUS2 = 0x01;   // bits 6..5: 01 charging, 10 discharging; bits 2..0 the charger's state
const uint8_t REG_CHIP_ID = 0x03;   // reads 0x4A on an AXP2101
const uint8_t REG_ADC_ON = 0x30;    // bit 0 battery voltage, bit 2 USB voltage, bit 4 the chip's temperature
const uint8_t REG_VBAT_H = 0x34;    // 0x34..0x35: battery millivolts, 13 bits
const uint8_t REG_TEMP_H = 0x3C;    // 0x3C..0x3D: temperature, 14 bits
const uint8_t REG_PERCENT = 0xA4;   // the fuel gauge, in %
const uint8_t CHIP_ID = 0x4A;
const uint32_t READ_EVERY_MS = 30000;
const uint32_t FIRST_READ_MS = 2000;  // the measurements just switched on need a moment

uint8_t addr = 0x34;
bool present = false;
uint32_t lastRead = 0;
Reading kept;
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
    lastRead = millis() - READ_EVERY_MS + FIRST_READ_MS;
    return true;
}

bool tick() {
    if (!present) return false;
    const uint32_t now = millis();
    if (now - lastRead < READ_EVERY_MS) return false;
    lastRead = now;
    uint8_t st[2], v[2], t[2], pct = 0;
    if (!readRegs(REG_STATUS1, st, 2)) return false;
    Reading r;
    r.taken = true;
    r.vbus = st[0] & 0x20;
    r.battery = st[0] & 0x08;
    r.chargerState = st[1] & 0x07;
    if (r.battery) {
        r.charging = ((st[1] >> 5) & 0x03) == 0x01;
        if (readRegs(REG_VBAT_H, v, 2)) r.batteryMv = ((v[0] & 0x1F) << 8) | v[1];
        if (readRegs(REG_PERCENT, &pct, 1) && pct <= 100) r.percent = pct;
    }
    if (readRegs(REG_TEMP_H, t, 2)) {
        const uint16_t raw = ((t[0] & 0x3F) << 8) | t[1];
        const float c = 22.0f + (7274 - (int)raw) / 20.0f;  // the conversion XPowersLib uses
        if (c > -30 && c < 130) r.chipTempC = c;
    }
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
    } else {
        client.clearReading("charging");
        client.clearReading("batteryMv");
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
    out.printf("[power] USB %s, battery %s", r.vbus ? "yes" : "no", r.battery ? "yes" : "none");
    if (r.battery) out.printf(" %d%% %d mV, %s (charger state %u)", r.percent, r.batteryMv, r.charging ? "charging" : "not charging", (unsigned)r.chargerState);
    out.printf("; power chip %.1f C, processor %.1f C, read %lus ago\n", r.chipTempC, temperatureRead(), (unsigned long)((millis() - lastRead) / 1000));
}

}  // namespace power
