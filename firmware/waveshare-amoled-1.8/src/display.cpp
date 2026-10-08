#include "display.h"

#include <Wire.h>
#include "Arduino_GFX_Library.h"
#include "pins.h"
#include "fonts/FreeSans9pt7b.h"
#include "fonts/FreeSans12pt7b.h"
#include "fonts/FreeSansBold12pt7b.h"

namespace display {

namespace {

Arduino_DataBus *bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
// Newer boards carry a CO5300 panel driver. Older ones (SH8601) need the other class.
// The driver with its column offset left adjustable. The offset is where the
// panel's first visible column sits in the controller's memory. It differs
// between revisions of this board: with it too large the whole picture sits to
// one side and whatever is drawn at the far edge comes back in at the near one.
class Panel : public Arduino_CO5300 {
  public:
    using Arduino_CO5300::Arduino_CO5300;
    void setColumnOffset(uint8_t offset) {
        COL_OFFSET1 = offset;
        _xStart = offset;
    }
};
Panel *gfx = new Panel(bus, GFX_NOT_DEFINED, 0, LCD_WIDTH, LCD_HEIGHT, 16, 0, 0, 0);
int columnOffset = 16;

const int BAND_MAX_HEIGHT = 56;
// Space left around each pill button inside its cell.
const int PILL_GAP = 4;
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
void setColumnOffset(int offset) {
    offset = constrain(offset, 0, 40);
    if (offset == columnOffset) return;
    // Black out under the old offset first, so nothing drawn there is left behind.
    clear();
    columnOffset = offset;
    gfx->setColumnOffset((uint8_t)offset);
    clear();
}
void edges(uint16_t color) {
    // Two pixels along each side of the panel, and a cross in the middle.
    for (int i = 0; i < 2; i++) {
        gfx->drawFastHLine(0, i, LCD_WIDTH, color);
        gfx->drawFastHLine(0, LCD_HEIGHT - 1 - i, LCD_WIDTH, color);
        gfx->drawFastVLine(i, 0, LCD_HEIGHT, color);
        gfx->drawFastVLine(LCD_WIDTH - 1 - i, 0, LCD_HEIGHT, color);
    }
    gfx->drawFastHLine(LCD_WIDTH / 2 - 30, LCD_HEIGHT / 2, 60, color);
    gfx->drawFastVLine(LCD_WIDTH / 2, LCD_HEIGHT / 2 - 30, 60, color);
}

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

/** Sends the top `h` rows of the band to the panel at logical `y`, turned to the current rotation. */
static void pushBand(int y, int h) {
    const int w = width();
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
static const GFXfont *fontFor(uint8_t size) { return size >= 3 ? &FreeSansBold12pt7b : &FreeSans9pt7b; }
/** Where the letters stand in a band of that kind, measured from its top. */
static int baselineFor(uint8_t size) { return size >= 3 ? 22 : 16; }

static int widthIn(const GFXfont *font, const String &text) {
    int width = 0;
    for (size_t i = 0; i < text.length(); i++) {
        uint8_t c = (uint8_t)text[i];
        if (c < font->first || c > font->last) c = '?';
        width += font->glyph[c - font->first].xAdvance;
    }
    return width;
}

int textWidth(uint8_t size, const String &text) { return widthIn(fontFor(size), text); }
int buttonTextWidth(const String &text) { return widthIn(&FreeSans12pt7b, plain(text)); }

String plain(const String &text) {
    // Latin-1 letters from U+00C0 to U+00FF, as the unaccented letter each is built on.
    static const char LATIN[] = "AAAAAAACEEEEIIIIDNOOOOOxOUUUUYTsaaaaaaaceeeeiiiidnooooo/ouuuuyty";
    String out;
    out.reserve(text.length());
    const size_t n = text.length();
    for (size_t i = 0; i < n;) {
        const uint8_t c = (uint8_t)text[i];
        if (c < 0x80) {
            out += (char)c;
            i++;
            continue;
        }
        // Decode one UTF-8 character.
        const int extra = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : c >= 0xC0 ? 1 : 0;
        uint32_t code = extra == 3 ? c & 0x07 : extra == 2 ? c & 0x0F : extra == 1 ? c & 0x1F : 0xFFFD;
        size_t j = i + 1;
        for (int k = 0; k < extra && j < n && ((uint8_t)text[j] & 0xC0) == 0x80; k++, j++) code = (code << 6) | ((uint8_t)text[j] & 0x3F);
        i = j;
        if (code >= 0xC0 && code <= 0xFF) out += LATIN[code - 0xC0];
        else if (code == 0x2018 || code == 0x2019 || code == 0x2032 || code == 0x02BC) out += '\'';
        else if (code == 0x201C || code == 0x201D || code == 0x2033) out += '"';
        else if (code == 0x2010 || code == 0x2011 || code == 0x2012 || code == 0x2013 || code == 0x2014 || code == 0x2212) out += '-';
        else if (code == 0x2026) out += "...";
        else if (code == 0x00A0 || code == 0x2009 || code == 0x202F) out += ' ';
        else if (code == 0x2022 || code == 0x00B7) out += '*';
        else if (code == 0x00B0) out += " deg";
        // Anything else (emoji, other scripts) has no plain form in this font and is left out.
    }
    return out;
}

void textLine(int y, uint8_t size, uint16_t color, const String &text) {
    const int w = width(), h = min(lineHeight(size), BAND_MAX_HEIGHT);
    const GFXfont *font = fontFor(size);
    String shown = plain(text);
    if (widthIn(font, shown) > w - 8) {
        while (shown.length() > 1 && widthIn(font, shown + "...") > w - 8) shown.remove(shown.length() - 1);
        shown += "...";
    }

    band->fillRect(0, 0, w, h, RGB565_BLACK);
    band->setFont(font);
    band->setTextSize(1);
    band->setTextColor(color);
    band->setTextWrap(false);
    band->setCursor((w - widthIn(font, shown)) / 2, baselineFor(size));
    band->print(shown);

    pushBand(y, h);
}
void pillRow(int y, int h, const String *labels, int count, int cols, uint16_t outline, uint16_t textColor) {
    const int w = width();
    h = min(h, BAND_MAX_HEIGHT);
    const int cell = w / max(1, cols);
    // A row that is not full sits in the middle.
    const int left = (w - cell * count) / 2;
    const GFXfont *font = &FreeSans12pt7b;
    band->fillRect(0, 0, w, h, RGB565_BLACK);
    band->setFont(font);
    band->setTextSize(1);
    band->setTextColor(textColor);
    band->setTextWrap(false);
    for (int i = 0; i < count; i++) {
        const int x = left + i * cell + PILL_GAP, pw = cell - 2 * PILL_GAP, ph = h - 2 * PILL_GAP;
        band->drawRoundRect(x, PILL_GAP, pw, ph, ph / 2, outline);
        band->drawRoundRect(x + 1, PILL_GAP + 1, pw - 2, ph - 2, ph / 2 - 1, outline);
        String shown = plain(labels[i]);
        const int room = pw - ph / 2;
        if (widthIn(font, shown) > room) {
            while (shown.length() > 1 && widthIn(font, shown + "..") > room) shown.remove(shown.length() - 1);
            shown += "..";
        }
        // The letters are 17 pixels tall and stand on the cursor line.
        band->setCursor(x + (pw - widthIn(font, shown)) / 2, PILL_GAP + (ph + 17) / 2 - 1);
        band->print(shown);
    }
    pushBand(y, h);
}
}  // namespace display
