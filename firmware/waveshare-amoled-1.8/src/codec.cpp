#include "codec.h"

#include <Wire.h>
#include "pins.h"

namespace codec {

namespace {

I2SClass stream;

void write(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(ADDR_ES8311);
    Wire.write(reg);
    Wire.write(value);
    Wire.endTransmission();
}

}  // namespace

I2SClass &i2s() { return stream; }

void quietMic(bool quiet) {
    // Bits 3..0 are the microphone gain in 3 dB steps: 10 is the 30 dB used for a voice across the room.
    write(0x14, quiet ? 0x10 | (10 - MIC_QUIET_DB / 3) : 0x1A);
}

bool begin() {
    // The codec takes its clock from I2S, so I2S must be running before the codec is set up.
    stream.setPins(I2S_BCK_IO, I2S_WS_IO, I2S_DO_IO, I2S_DI_IO, I2S_MCK_IO);
    if (!stream.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) return false;

    Wire.beginTransmission(ADDR_ES8311);
    if (Wire.endTransmission() != 0) return false;
    // ES8311 as I2S slave, 16 kHz, 16-bit, master clock 256 x the sample rate.
    write(0x00, 0x1F);
    delay(20);
    write(0x00, 0x00);
    write(0x00, 0x80);  // reset, then power on
    write(0x01, 0x3F);  // clock from the MCLK pin, all clocks on
    write(0x02, 0x00);
    write(0x03, 0x10);
    write(0x04, 0x10);
    write(0x05, 0x00);
    write(0x06, 0x03);
    write(0x07, 0x00);
    write(0x08, 0xFF);
    write(0x00, 0x80);
    write(0x09, 0x0C);  // I2S in and out, 16-bit
    write(0x0A, 0x0C);
    write(0x0D, 0x01);  // analog, DAC and output driver on
    write(0x0E, 0x02);  // analog PGA and ADC modulator on
    write(0x12, 0x00);
    write(0x13, 0x10);
    write(0x1C, 0x6A);  // ADC equalizer bypass, cancel DC offset
    write(0x37, 0x08);
    write(0x14, 0x1A);  // analog microphone, PGA gain as in Mylo
    write(0x17, 0xC8);  // ADC volume
    write(0x32, 0xD7);  // DAC level; the volume setting is applied in software
    // The right channel of what the codec sends back carries what it is playing (ADC left, DAC right).
    // That is the reference the echo canceller needs, already lined up with the microphone.
    write(0x44, 0x58);

    // Without the amplifier enabled the speaker stays silent whatever else is right.
    pinMode(PA_ENABLE, OUTPUT);
    digitalWrite(PA_ENABLE, HIGH);
    return true;
}

}  // namespace codec
