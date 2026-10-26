#include "display.h"

#include <Wire.h>
#include "Arduino_GFX_Library.h"
#include "pins.h"
#include <esp_heap_caps.h>
#include "fonts/FreeSans9pt7b.h"
#include "fonts/FreeSans12pt7b.h"
#include "fonts/FreeSansBold12pt7b.h"

namespace display {

namespace {

Arduino_DataBus *bus = new Arduino_ESP32QSPI(LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
// The driver with its column offset left adjustable. The panel's 466 columns sit 6 in from the start of the
// controller's 480 (Waveshare's own setup says so); the setting is kept in case another revision differs.
class Panel : public Arduino_CO5300 {
  public:
    using Arduino_CO5300::Arduino_CO5300;
    void setColumnOffset(uint8_t offset) {
        COL_OFFSET1 = offset;
        _xStart = offset;
    }
};
Panel *gfx = new Panel(bus, LCD_RESET, 0, LCD_WIDTH, LCD_HEIGHT, 6, 0, 0, 0);
int columnOffset = 6;

// Diagnostics: a copy of everything sent to the panel, kept only while asked for (`shot` on the console),
// since nothing can be read back from the panel itself.
uint16_t *shadow = nullptr;

void bitmap(int16_t x, int16_t y, uint16_t *pixels, int16_t w, int16_t h) {
    gfx->draw16bitRGBBitmap(x, y, pixels, w, h);
    if (!shadow) return;
    for (int j = 0; j < h; j++) {
        if (y + j < 0 || y + j >= LCD_HEIGHT) continue;
        for (int i = 0; i < w; i++) {
            if (x + i >= 0 && x + i < LCD_WIDTH) shadow[(y + j) * LCD_WIDTH + x + i] = pixels[j * w + i];
        }
    }
}
void pixel(int16_t x, int16_t y, uint16_t color) {
    gfx->drawPixel(x, y, color);
    if (shadow && x >= 0 && x < LCD_WIDTH && y >= 0 && y < LCD_HEIGHT) shadow[y * LCD_WIDTH + x] = color;
}
void hline(int16_t x, int16_t y, int16_t w, uint16_t color) {
    gfx->drawFastHLine(x, y, w, color);
    for (int i = 0; shadow && i < w; i++) if (x + i >= 0 && x + i < LCD_WIDTH && y >= 0 && y < LCD_HEIGHT) shadow[y * LCD_WIDTH + x + i] = color;
}
void vline(int16_t x, int16_t y, int16_t h, uint16_t color) {
    gfx->drawFastVLine(x, y, h, color);
    for (int j = 0; shadow && j < h; j++) if (x >= 0 && x < LCD_WIDTH && y + j >= 0 && y + j < LCD_HEIGHT) shadow[(y + j) * LCD_WIDTH + x] = color;
}

const int BAND_MAX_HEIGHT = 56;
// Space left around each pill button inside its cell.
const int PILL_GAP = 4;
// Room kept between a row of pills and the round edge, each side.
const int PILL_MARGIN = 14;
const int ROWS_PER_WRITE = 4;
int rotation = 90;
Arduino_Canvas *band = nullptr;
int bandWidth = 0;

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
    // Unlike the 1.8, nothing here sits behind the IO expander: the panel and the touch controller have reset pins of their own.
    Wire.begin(IIC_SDA, IIC_SCL);
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
    // A ring two pixels wide along the round edge of the glass, and a cross in the middle.
    const float c = (LCD_WIDTH - 1) / 2.0f;
    for (int ring = 0; ring < 2; ring++) {
        const float r = RADIUS - 1 - ring;
        const int steps = (int)(2.0f * PI * r * 1.5f);
        for (int i = 0; i < steps; i++) {
            const float a = 2.0f * PI * i / steps;
            pixel((int16_t)lroundf(c + r * cosf(a)), (int16_t)lroundf(c + r * sinf(a)), color);
        }
    }
    hline(LCD_WIDTH / 2 - 30, LCD_HEIGHT / 2, 60, color);
    vline(LCD_WIDTH / 2, LCD_HEIGHT / 2 - 30, 60, color);
}

int roomAt(int y, int h) {
    // The half chord at the row of the band farthest from the middle.
    const float c = (LCD_HEIGHT - 1) / 2.0f;
    const float far = max(fabsf(y - c), fabsf(y + h - 1 - c));
    if (far >= RADIUS) return 0;
    return 2 * (int)sqrtf(RADIUS * RADIUS - far * far);
}

int width() { return rotation == 0 || rotation == 180 ? LCD_WIDTH : LCD_HEIGHT; }
int height() { return rotation == 0 || rotation == 180 ? LCD_HEIGHT : LCD_WIDTH; }

// Every write below goes out one panel row at a time. The driver only sends
// the address for the first 1024 pixels of a write, so fillScreen() and any
// larger block fail after their first use; a row always stays under that.
void clear() {
    for (int16_t y = 0; y < LCD_HEIGHT; y++) hline(0, y, LCD_WIDTH, RGB565_BLACK);
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
        if (rotation == 0) hline(0, at, LCD_WIDTH, RGB565_BLACK);
        else if (rotation == 180) hline(0, LCD_HEIGHT - 1 - at, LCD_WIDTH, RGB565_BLACK);
        else if (rotation == 90) vline(at, 0, LCD_HEIGHT, RGB565_BLACK);
        else vline(LCD_WIDTH - 1 - at, 0, LCD_HEIGHT, RGB565_BLACK);
    }
}

void squareOnPanel(int x, int y, int size, int &px, int &py) {
    px = x;
    py = y;
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
}

void blitSquare(int x, int y, int size, const uint16_t *pixels) {
    int px, py;
    squareOnPanel(x, y, size, px, py);
    // Four rows per write: 4 x 240 = 960 pixels, still under the driver's 1024-pixel limit.
    // The face is round, so the same pixels go out whatever the rotation.
    const int rows = ROWS_PER_WRITE;
    for (int row = 0; row < size; row += rows) {
        bitmap(px, py + row, const_cast<uint16_t *>(pixels + row * size), size, min(rows, size - row));
    }
}

/** Sends `h` rows of `src` (each width() wide) to the panel at logical `y`, turned to the current rotation. */
static void pushRows(const uint16_t *src, int y, int h) {
    const int w = width();
    static uint16_t row[LCD_HEIGHT];
    if (rotation == 0 || rotation == 180) {
        for (int j = 0; j < h; j++) {
            if (rotation == 0) {
                bitmap(0, y + j, const_cast<uint16_t *>(src + j * w), w, 1);
            } else {
                for (int i = 0; i < w; i++) row[i] = src[(h - 1 - j) * w + (w - 1 - i)];
                bitmap(0, LCD_HEIGHT - (y + h) + j, row, w, 1);
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
        bitmap(px, j, row, h, 1);
    }
}
/** Sends the top `h` rows of the band to the panel at logical `y`, turned to the current rotation. */
static void pushBand(int y, int h) { pushRows(band->getFramebuffer(), y, h); }

void blitScreen(const uint16_t *pixels) { pushRows(pixels, 0, height()); }

void blitRect(int x, int y, int w, int h, const uint16_t *pixels) {
    static uint16_t row[LCD_HEIGHT];
    if (w <= 0 || h <= 0 || w > LCD_HEIGHT || h > LCD_HEIGHT) return;
    if (rotation == 0) {
        for (int j = 0; j < h; j++) bitmap(x, y + j, const_cast<uint16_t *>(pixels + j * w), w, 1);
    } else if (rotation == 180) {
        for (int j = 0; j < h; j++) {
            for (int i = 0; i < w; i++) row[i] = pixels[(h - 1 - j) * w + (w - 1 - i)];
            bitmap(LCD_WIDTH - (x + w), LCD_HEIGHT - (y + h) + j, row, w, 1);
        }
    } else if (rotation == 90) {
        // The same turn as pushRows: a logical column becomes a panel row.
        for (int j = 0; j < w; j++) {
            for (int i = 0; i < h; i++) row[i] = pixels[i * w + (w - 1 - j)];
            bitmap(y, width() - (x + w) + j, row, h, 1);
        }
    } else {
        for (int j = 0; j < w; j++) {
            for (int i = 0; i < h; i++) row[i] = pixels[(h - 1 - i) * w + j];
            bitmap(height() - (y + h), x + j, row, h, 1);
        }
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

void textLine(int y, uint8_t size, uint16_t color, const String &text, int barPermille, uint16_t barColor) {
    const int w = width(), h = min(lineHeight(size), BAND_MAX_HEIGHT);
    const GFXfont *font = fontFor(size);
    String shown = plain(text);
    // The glass is round: a band only has the chord across it at its edge farthest from the middle.
    const int room = roomAt(y, h) - 8;
    if (widthIn(font, shown) > room) {
        while (shown.length() > 1 && widthIn(font, shown + "...") > room) shown.remove(shown.length() - 1);
        shown += "...";
    }

    band->fillRect(0, 0, w, h, RGB565_BLACK);
    band->setFont(font);
    band->setTextSize(1);
    band->setTextColor(color);
    band->setTextWrap(false);
    band->setCursor((w - widthIn(font, shown)) / 2, baselineFor(size));
    band->print(shown);
    if (barPermille >= 0) {
        // Half the screen wide, under the middle of the text: a dim track and the part that is done.
        const int bw = min(w / 2, roomAt(y, h) - 16), bx = (w - bw) / 2, by = h - 3;
        band->fillRect(bx, by, bw, 3, 0x2104);
        band->fillRect(bx, by, bw * min(barPermille, 1000) / 1000, 3, barColor);
    }

    pushBand(y, h);
}
void pillCells(int y, int h, int count, int cols, int &left, int &cell) {
    // The row is cut across the chord the round glass leaves it, not the whole width.
    h = min(h, BAND_MAX_HEIGHT);
    // A margin, or a pill's rounded ends meet the edge of the glass.
    cell = max(0, roomAt(y, h) - 2 * PILL_MARGIN) / max(1, cols);
    // A row that is not full sits in the middle.
    left = (width() - cell * count) / 2;
}

void pillRow(int y, int h, const String *labels, int count, int cols, uint16_t outline, uint16_t textColor) {
    const int w = width();
    h = min(h, BAND_MAX_HEIGHT);
    int left = 0, cell = 0;
    pillCells(y, h, count, cols, left, cell);
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
void mirror(bool on) {
    if (on && !shadow) {
        shadow = (uint16_t *)heap_caps_calloc(LCD_WIDTH * LCD_HEIGHT, sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    } else if (!on && shadow) {
        heap_caps_free(shadow);
        shadow = nullptr;
    }
}

void dump(Print &out) {
    if (!shadow) {
        out.println("[shot] nothing kept");
        return;
    }
    // Runs of one colour, as (count, colour) pairs of 16-bit numbers, written in hex a row at a time.
    out.printf("[shot] begin %d %d\n", LCD_WIDTH, LCD_HEIGHT);
    for (int y = 0; y < LCD_HEIGHT; y++) {
        String line = "[shot] " + String(y) + " ";
        uint32_t sum = 0;
        for (int x = 0; x < LCD_WIDTH;) {
            const uint16_t c = shadow[y * LCD_WIDTH + x];
            int n = 1;
            while (x + n < LCD_WIDTH && shadow[y * LCD_WIDTH + x + n] == c) n++;
            char pair[10];
            snprintf(pair, sizeof pair, "%03x%04x", n, c);
            line += pair;
            sum += n + c;
            x += n;
        }
        line += " " + String(sum & 0xFFFF, HEX);
        out.println(line);
        delay(2);
    }
    out.println("[shot] end");
}

}  // namespace display
