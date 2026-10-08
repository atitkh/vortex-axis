#include "display.h"

#include <Wire.h>
#include "Arduino_GFX_Library.h"
#include "pins.h"

namespace display {

namespace {

Arduino_DataBus *bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
// Newer boards carry a CO5300 panel driver. Older ones (SH8601) need the other class.
Arduino_CO5300 *gfx = new Arduino_CO5300(bus, GFX_NOT_DEFINED, 0, LCD_WIDTH, LCD_HEIGHT, 16, 0, 0, 0);

const int BAND_MAX_HEIGHT = 36;
const int ROWS_PER_WRITE = 4;
int rotation = 90;
Arduino_Canvas *band = nullptr;
int bandWidth = 0;

// The IO expander holds the display and touch in reset. Release them once at
// boot, BEFORE the display starts: doing it afterwards blanks the panel.
void releasePeripheralReset() {
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

/** (Re)creates the off-screen band text is drawn into, as wide as the logical screen. */
void makeBand() {
    if (band && bandWidth == width()) return;
    delete band;
    bandWidth = width();
    band = new Arduino_Canvas(bandWidth, BAND_MAX_HEIGHT, nullptr);
    band->begin(GFX_SKIP_OUTPUT_BEGIN);
}

}  // namespace

bool begin() {
    releasePeripheralReset();
    const bool ok = gfx->begin();
    clear();
    makeBand();
    return ok;
}

void setRotation(int degrees) {
    if (degrees != 0 && degrees != 90 && degrees != 180 && degrees != 270) degrees = 90;
    if (degrees == rotation) return;
    rotation = degrees;
    makeBand();
    clear();
}

void setBrightness(uint8_t level) { gfx->setBrightness(level); }

int width() { return rotation == 0 || rotation == 180 ? LCD_WIDTH : LCD_HEIGHT; }
int height() { return rotation == 0 || rotation == 180 ? LCD_HEIGHT : LCD_WIDTH; }

// Every write below goes out one panel row at a time. The driver only sends
// the address for the first 1024 pixels of a write, so fillScreen() and any
// larger block fail after their first use; a row always stays under that.
void clear() {
    for (int16_t y = 0; y < LCD_HEIGHT; y++) gfx->drawFastHLine(0, y, LCD_WIDTH, RGB565_BLACK);
}

void toLogical(int px, int py, int &x, int &y) {
    // The reverse of how blitSquare and textLine place things.
    if (rotation == 90) {
        x = width() - 1 - py;
        y = px;
    } else if (rotation == 180) {
        x = LCD_WIDTH - 1 - px;
        y = LCD_HEIGHT - 1 - py;
    } else if (rotation == 270) {
        x = py;
        y = height() - 1 - px;
    } else {
        x = px;
        y = py;
    }
}
void clearBand(int y, int rows) {
    // Lines run along the band, so this takes one write per row whatever the rotation.
    for (int i = 0; i < rows; i++) {
        const int at = y + i;
        if (at < 0 || at >= height()) continue;
        if (rotation == 0) gfx->drawFastHLine(0, at, LCD_WIDTH, RGB565_BLACK);
        else if (rotation == 180) gfx->drawFastHLine(0, LCD_HEIGHT - 1 - at, LCD_WIDTH, RGB565_BLACK);
        else if (rotation == 90) gfx->drawFastVLine(at, 0, LCD_HEIGHT, RGB565_BLACK);
        else gfx->drawFastVLine(LCD_WIDTH - 1 - at, 0, LCD_HEIGHT, RGB565_BLACK);
    }
}

void blitSquare(int x, int y, int size, const uint16_t *pixels) {
    int px = x, py = y;
    if (rotation == 90) {
        px = y;
        py = width() - (x + size);
    } else if (rotation == 180) {
        px = LCD_WIDTH - (x + size);
        py = LCD_HEIGHT - (y + size);
    } else if (rotation == 270) {
        px = height() - (y + size);
        py = x;
    }
    // Four rows per write: 4 x 240 = 960 pixels, still under the driver's 1024-pixel limit.
    // The face is round, so the same pixels go out whatever the rotation.
    const int rows = ROWS_PER_WRITE;
    for (int row = 0; row < size; row += rows) {
        gfx->draw16bitRGBBitmap(px, py + row, const_cast<uint16_t *>(pixels + row * size), size, min(rows, size - row));
    }
}

void textLine(int y, uint8_t size, uint16_t color, const String &text) {
    const int w = width(), h = min(lineHeight(size), BAND_MAX_HEIGHT);
    String shown = text;
    const int fits = lineChars(size);
    if ((int)shown.length() > fits) shown = shown.substring(0, fits - 3) + "...";

    band->fillRect(0, 0, w, h, RGB565_BLACK);
    band->setTextSize(size);
    band->setTextColor(color);
    band->setTextWrap(false);
    band->setCursor((w - (int)shown.length() * 6 * size) / 2, 2);
    band->print(shown);

    const uint16_t *src = band->getFramebuffer();
    static uint16_t row[LCD_HEIGHT];
    if (rotation == 0 || rotation == 180) {
        for (int j = 0; j < h; j++) {
            if (rotation == 0) {
                gfx->draw16bitRGBBitmap(0, y + j, const_cast<uint16_t *>(src + j * w), w, 1);
            } else {
                for (int i = 0; i < w; i++) row[i] = src[(h - 1 - j) * w + (w - 1 - i)];
                gfx->draw16bitRGBBitmap(0, LCD_HEIGHT - (y + h) + j, row, w, 1);
            }
        }
        return;
    }
    // Sideways: the band becomes a column `h` wide and `w` tall on the panel.
    const int px = rotation == 90 ? y : height() - (y + h);
    for (int j = 0; j < w; j++) {
        for (int i = 0; i < h; i++) {
            row[i] = rotation == 90 ? src[i * w + (w - 1 - j)] : src[(h - 1 - i) * w + j];
        }
        gfx->draw16bitRGBBitmap(px, j, row, h, 1);
    }
}

}  // namespace display
