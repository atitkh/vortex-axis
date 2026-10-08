// Bring-up for the Waveshare ESP32-S3-Touch-AMOLED-1.8: start the display,
// report what is on the I2C bus, and show a boot screen. Nothing here talks to
// Axis yet.
#include <Arduino.h>
#include <Wire.h>
#include "HWCDC.h"
#include "Arduino_GFX_Library.h"
#include "axis_client.h"
#include "pins.h"

// This board's serial port is the chip's own USB, not a UART. Output on plain
// `Serial` goes nowhere unless this is used and ARDUINO_USB_CDC_ON_BOOT is set.
HWCDC USBSerial;

static Arduino_DataBus *bus =
    new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
// Newer boards carry a CO5300 panel driver. Older ones (SH8601) need the other class.
static Arduino_CO5300 *gfx =
    new Arduino_CO5300(bus, GFX_NOT_DEFINED, 0, LCD_WIDTH, LCD_HEIGHT, 16, 0, 0, 0);

// The IO expander holds the display and touch in reset. Release them once at
// boot, BEFORE the display starts: doing it afterwards blanks the panel.
static void releasePeripheralReset() {
    Wire.begin(IIC_SDA, IIC_SCL);
    auto write = [](uint8_t reg, uint8_t value) {
        Wire.beginTransmission(ADDR_IO_EXPANDER);
        Wire.write(reg);
        Wire.write(value);
        Wire.endTransmission();
    };
    write(0x03, 0xF8);  // pins 0-2 as outputs
    write(0x01, 0x00);  // hold in reset
    delay(20);
    write(0x01, 0x07);  // release
    delay(50);
}

// fillScreen() fails after its first call on this panel: the driver only sends
// the address for the first 1024 pixels of a write. One row at a time stays under that.
static void fillDisplay(uint16_t color) {
    for (int16_t y = 0; y < LCD_HEIGHT; y++) gfx->drawFastHLine(0, y, LCD_WIDTH, color);
}

static void scanI2C() {
    USBSerial.print("[boot] i2c devices:");
    for (uint8_t address = 0x08; address < 0x78; address++) {
        Wire.beginTransmission(address);
        if (Wire.endTransmission() == 0) USBSerial.printf(" 0x%02X", address);
    }
    USBSerial.println();
}

void setup() {
    USBSerial.begin(115200);
    delay(500);  // do not wait on the port itself: it never reports "connected" on this chip
    USBSerial.printf("\n[boot] VorteX Axis client %s, protocol %d\n", AXIS_FIRMWARE_VERSION, AXIS_PROTOCOL_VERSION);
    USBSerial.printf("[boot] heap %u, psram %u of %u\n", (unsigned)ESP.getFreeHeap(),
                     (unsigned)ESP.getFreePsram(), (unsigned)ESP.getPsramSize());

    releasePeripheralReset();
    scanI2C();

    const bool displayOk = gfx->begin();
    USBSerial.printf("[boot] display %s\n", displayOk ? "started" : "FAILED to start");
    fillDisplay(RGB565_BLACK);
    gfx->setTextColor(RGB565_CYAN);
    gfx->setTextSize(4);
    gfx->setCursor(40, 170);
    gfx->print("VorteX Axis");
    gfx->setTextColor(RGB565_WHITE);
    gfx->setTextSize(2);
    gfx->setCursor(40, 230);
    gfx->printf("client %s", AXIS_FIRMWARE_VERSION);
    gfx->setCursor(40, 260);
    gfx->print("bring-up: not connected");
}

void loop() {
    static uint32_t last = 0;
    if (millis() - last >= 5000) {
        last = millis();
        USBSerial.printf("[run] up %lus, heap %u\n", (unsigned long)(millis() / 1000), (unsigned)ESP.getFreeHeap());
    }
    delay(20);
}
