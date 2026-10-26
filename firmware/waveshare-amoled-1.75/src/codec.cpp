#include "codec.h"

#include <Wire.h>
#include "pins.h"

namespace codec {

namespace {

I2SClass stream;

// Gain of the microphones' amplifiers, in 3 dB steps: 10 is the 30 dB the 1.8 also uses for a voice across the room.
const uint8_t MIC_GAIN = 10;
// The reference (MIC3) is the speaker's own drive, not a microphone: little gain, or it clips.
const uint8_t REF_GAIN = 0;

void write(uint8_t address, uint8_t reg, uint8_t value) {
    Wire.beginTransmission(address);
    Wire.write(reg);
    Wire.write(value);
    Wire.endTransmission();
}

uint8_t read(uint8_t address, uint8_t reg) {
    Wire.beginTransmission(address);
    Wire.write(reg);
    if (Wire.endTransmission(true) != 0) return 0;
    if (Wire.requestFrom(address, (uint8_t)1) != 1) return 0;
    return Wire.read();
}

/** Whether a chip answers, given a few tries: just after a reset the bus can miss one. */
bool present(uint8_t address) {
    for (int i = 0; i < 5; i++) {
        Wire.beginTransmission(address);
        if (Wire.endTransmission() == 0) return true;
        delay(20);
    }
    return false;
}

const char *problem = "";

void es8311(uint8_t reg, uint8_t value) { write(ADDR_ES8311, reg, value); }
void es7210(uint8_t reg, uint8_t value) { write(ADDR_ES7210, reg, value); }

/** ES8311 as I2S slave, 16 kHz, master clock 256 x the sample rate; playback only on this board. */
void startPlayback() {
    es8311(0x00, 0x1F);
    delay(20);
    es8311(0x00, 0x00);
    es8311(0x00, 0x80);  // reset, then power on
    es8311(0x01, 0x3F);  // clock from the MCLK pin, all clocks on
    es8311(0x02, 0x00);
    es8311(0x03, 0x10);
    es8311(0x04, 0x10);
    es8311(0x05, 0x00);
    // The bit clock is 64 x the sample rate here (32-bit slots); the codec follows LRCK and takes the first 16 bits.
    es8311(0x06, 0x03);
    es8311(0x07, 0x00);
    es8311(0x08, 0xFF);
    es8311(0x00, 0x80);
    es8311(0x09, 0x0C);  // I2S in, 16-bit
    es8311(0x0A, 0x0C);
    es8311(0x0D, 0x01);  // analog, DAC and output driver on
    es8311(0x0E, 0x02);
    es8311(0x12, 0x00);
    es8311(0x13, 0x10);
    es8311(0x1C, 0x6A);
    es8311(0x37, 0x08);
    es8311(0x32, 0xD7);  // DAC level; the volume setting is applied in software
}

/**
 * ES7210 as I2S slave with its inputs on, 16-bit, in the mode that packs four inputs into the two
 * channels. The order of writes follows Espressif's esp_codec_dev driver (open, set_fs, enable).
 */
void startCapture() {
    es7210(0x00, 0xFF);
    es7210(0x00, 0x41);
    es7210(0x01, 0x3F);
    es7210(0x09, 0x30);  // chip and power-up state cycles
    es7210(0x0A, 0x30);
    es7210(0x23, 0x2A);  // high-pass filters: take the DC away
    es7210(0x22, 0x0A);
    es7210(0x20, 0x0A);
    es7210(0x21, 0x2A);
    es7210(0x08, read(ADDR_ES7210, 0x08) & ~0x01);  // slave
    es7210(0x40, 0x43);  // analog on, 3.3 V
    es7210(0x41, 0x70);  // microphone bias 2.87 V
    es7210(0x42, 0x70);
    es7210(0x07, 0x20);  // oversampling
    es7210(0x02, 0xC1);  // clock divider for 4.096 MHz at 16 kHz
    es7210(0x11, 0x60);  // 16-bit, standard I2S
    es7210(0x12, 0x02);  // four inputs packed into the two channels
    es7210(0x06, 0x00);  // power on
    es7210(0x47, 0x08);  // each input's power
    es7210(0x48, 0x08);
    es7210(0x49, 0x08);
    es7210(0x4A, 0x08);
    es7210(0x4B, 0x00);  // MIC1/2 bias, ADC and PGA on
    es7210(0x4C, 0x00);  // MIC3/4 the same
    es7210(0x43, 0x10 | MIC_GAIN);
    es7210(0x44, 0x10 | MIC_GAIN);
    es7210(0x45, 0x10 | REF_GAIN);
    es7210(0x46, 0x00);
    es7210(0x01, 0x00);  // all clocks on
    es7210(0x40, 0x43);
    es7210(0x00, 0x71);
    es7210(0x00, 0x41);
}

}  // namespace

I2SClass &i2s() { return stream; }
const char *failure() { return problem; }

void quietMic(bool quiet) {
    const uint8_t gain = quiet ? MIC_GAIN - MIC_QUIET_DB / 3 : MIC_GAIN;
    es7210(0x43, 0x10 | gain);
    es7210(0x44, 0x10 | gain);
}

bool begin() {
    // Both chips take their clocks from I2S, so I2S must be running before they are set up.
    stream.setPins(I2S_BCK_IO, I2S_WS_IO, I2S_DO_IO, I2S_DI_IO, I2S_MCK_IO);
    if (!stream.begin(I2S_MODE_STD, RATE, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) {
        problem = "I2S did not start";
        return false;
    }
    if (!present(ADDR_ES8311)) {
        problem = "the ES8311 (speaker) does not answer";
        return false;
    }
    if (!present(ADDR_ES7210)) {
        problem = "the ES7210 (microphones) does not answer";
        return false;
    }
    startPlayback();
    startCapture();
    // Without the amplifier enabled the speaker stays silent whatever else is right. It is switched on
    // once, here, and left on: Waveshare warn against toggling it behind the codec's back.
    pinMode(PA_ENABLE, OUTPUT);
    digitalWrite(PA_ENABLE, HIGH);
    return true;
}

}  // namespace codec
