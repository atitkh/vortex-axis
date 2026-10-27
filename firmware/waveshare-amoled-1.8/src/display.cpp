#include "display.h"

#include <Wire.h>
#include "Arduino_GFX_Library.h"
#include "pins.h"
#include <esp_heap_caps.h>
// Three sets, picked by the textSize setting: 9 and 12 points (small, this board's look before 0.20.0), and the
// round board's two sizes up (medium and large). The fonts folder is shared with the round board.
#include "fonts/FreeSans9pt7b.h"
#include "fonts/FreeSans11pt7b.h"
#include "fonts/FreeSans12pt7b.h"
#include "fonts/FreeSans14pt7b.h"
#include "fonts/FreeSans15pt7b.h"
#include "fonts/FreeSansBold12pt7b.h"
#include "fonts/FreeSansBold14pt7b.h"
#include "fonts/FreeSansBold15pt7b.h"

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

// Diagnostics: a copy of everything sent to the panel, kept only while asked for (`shot` on the console),
// since nothing can be read back from the panel itself.
uint16_t *shadow = nullptr;

void keep(int16_t x, int16_t y, const uint16_t *pixels, int16_t w, int16_t h, uint16_t color) {
    for (int j = 0; j < h; j++) {
        if (y + j < 0 || y + j >= LCD_HEIGHT) continue;
        for (int i = 0; i < w; i++) {
            if (x + i >= 0 && x + i < LCD_WIDTH) shadow[(y + j) * LCD_WIDTH + x + i] = pixels ? pixels[j * w + i] : color;
        }
    }
}

// The library turns each pixel's bytes round for the panel one at a time as it sends, which takes as long as the
// sending; turned here into internal memory the panel's DMA reads from, and sent as they are, a write takes about half
// as long (the round board's measure: 460 by 2, 120 against 242 us).
uint16_t *swapped = nullptr;
const int SWAP_MAX = 1024;  // the driver's own limit for one write

void send(int16_t x, int16_t y, const uint16_t *pixels, int16_t w, int16_t h) {
    if (!swapped) swapped = (uint16_t *)heap_caps_malloc(SWAP_MAX * sizeof(uint16_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    const int n = w * h;
    if (!swapped || n > SWAP_MAX) return gfx->draw16bitRGBBitmap(x, y, const_cast<uint16_t *>(pixels), w, h);
    // Two pixels at a time. The empty asm keeps the compiler from seeing a byte swap in this, which it would hand to a
    // library call per word (twice as slow as doing it by hand).
    uint32_t *to = (uint32_t *)swapped;
    int i = 0;
    if (((uintptr_t)pixels & 3) == 0) {
        const uint32_t *from = (const uint32_t *)pixels;
        for (; i < n / 2; i++) {
            const uint32_t v = from[i];
            uint32_t low = v & 0x00FF00FFu;
            asm volatile("" : "+r"(low));
            to[i] = (low << 8) | ((v >> 8) & 0x00FF00FFu);
        }
        i *= 2;
    }
    for (; i < n; i++) swapped[i] = (uint16_t)((pixels[i] << 8) | (pixels[i] >> 8));
    gfx->draw16bitBeRGBBitmap(x, y, swapped, w, h);
}

// Every write to the panel goes through these, so the copy stays in step.
void bitmap(int16_t x, int16_t y, const uint16_t *pixels, int16_t w, int16_t h) {
    send(x, y, pixels, w, h);
    if (shadow) keep(x, y, pixels, w, h, 0);
}
void hline(int16_t x, int16_t y, int16_t w, uint16_t color) {
    gfx->drawFastHLine(x, y, w, color);
    if (shadow) keep(x, y, nullptr, w, 1, color);
}
void vline(int16_t x, int16_t y, int16_t h, uint16_t color) {
    gfx->drawFastVLine(x, y, h, color);
    if (shadow) keep(x, y, nullptr, 1, h, color);
}

// The tallest band, a row of buttons at the large size; the canvas is made this tall once, whatever the size.
const int BAND_MAX_HEIGHT = 68;

/** Everything about drawing text that changes with the textSize setting. */
struct Size {
    const GFXfont *body, *head, *button;
    // Band heights and where the letters stand in them, from the band's top.
    int bodyHeight, headHeight, bodyBaseline, headBaseline;
    // How tall a button's capitals are, and the space around a pill inside its cell.
    int buttonLetters, pillGap;
    Buttons buttons;
};
// The same three as the round board's; small is this board's look before 0.20.0.
const Size SIZES[] = {
    {&FreeSans9pt7b, &FreeSansBold12pt7b, &FreeSans12pt7b, 22, 30, 16, 22, 17, 4, {44, 56, 40, 24}},
    {&FreeSans11pt7b, &FreeSansBold14pt7b, &FreeSans14pt7b, 26, 36, 19, 25, 20, 5, {50, 64, 46, 28}},
    {&FreeSans12pt7b, &FreeSansBold15pt7b, &FreeSans15pt7b, 28, 38, 20, 27, 21, 5, {54, 68, 48, 30}},
};
int sizeIndex = 1;
const Size &metrics() { return SIZES[sizeIndex]; }
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
        hline(0, i, LCD_WIDTH, color);
        hline(0, LCD_HEIGHT - 1 - i, LCD_WIDTH, color);
        vline(i, 0, LCD_HEIGHT, color);
        vline(LCD_WIDTH - 1 - i, 0, LCD_HEIGHT, color);
    }
    hline(LCD_WIDTH / 2 - 30, LCD_HEIGHT / 2, 60, color);
    vline(LCD_WIDTH / 2, LCD_HEIGHT / 2 - 30, 60, color);
}

int rotationDegrees() { return rotation; }
int width() { return rotation == 0 || rotation == 180 ? LCD_WIDTH : LCD_HEIGHT; }
int height() { return rotation == 0 || rotation == 180 ? LCD_HEIGHT : LCD_WIDTH; }

// Every write below stays within the driver's limit: it only sends the address for the first 1024 pixels of a
// write, so fillScreen() and any larger block fail after their first use.
static uint32_t clearCount = 0;
uint32_t clears() { return clearCount; }
void clear() {
    clearCount++;
    fillPanel(0, 0, LCD_WIDTH, LCD_HEIGHT, RGB565_BLACK);
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
void toPanel(int x, int y, int &px, int &py) {
    // The reverse of toLogical.
    if (rotation == 90) {
        px = y;
        py = width() - 1 - x;
    } else if (rotation == 180) {
        px = LCD_WIDTH - 1 - x;
        py = LCD_HEIGHT - 1 - y;
    } else if (rotation == 270) {
        px = height() - 1 - y;
        py = x;
    } else {
        px = x;
        py = y;
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
    // As many rows per write as stay under the driver's 1024-pixel limit (4 x 240).
    // The face is round, so the same pixels go out whatever the rotation.
    const int rows = max(1, min(ROWS_PER_WRITE, 1024 / size));
    for (int row = 0; row < size; row += rows) bitmap(px, py + row, pixels + row * size, size, min(rows, size - row));
}

void blitPanel(int x, int y, int w, int h, const uint16_t *pixels) {
    if (w <= 0 || h <= 0) return;
    // As many whole rows per write as stay under the driver's 1024 pixels.
    const int rows = max(1, 1024 / w);
    for (int row = 0; row < h; row += rows) bitmap(x, y + row, pixels + row * w, w, min(rows, h - row));
}

void blitFrame(int px, int py, int stride, const uint16_t *pixels, int x0, int y0, int x1, int y1) {
    const int w = x1 - x0;
    if (w <= 0 || y1 <= y0) return;
    if (w == stride) return blitPanel(px + x0, py + y0, w, y1 - y0, pixels + y0 * stride);
    // Narrower than the frame: its rows are gathered into one piece for each write.
    static uint16_t gather[1024];
    const int rows = max(1, 1024 / w);
    for (int y = y0; y < y1; y += rows) {
        const int n = min(rows, y1 - y);
        for (int j = 0; j < n; j++) memcpy(gather + j * w, pixels + (y + j) * stride + x0, w * sizeof(uint16_t));
        bitmap(px + x0, py + y, gather, w, n);
    }
}

void fillPanel(int x, int y, int w, int h, uint16_t color) {
    x = max(0, x), y = max(0, y);
    w = min(w, (int)LCD_WIDTH - x), h = min(h, (int)LCD_HEIGHT - y);
    if (w <= 0 || h <= 0) return;
    static uint16_t *solid = nullptr;  // PSRAM: internal memory is short
    static uint16_t solidColor = 0;
    static bool solidReady = false;
    if (!solid) solid = (uint16_t *)heap_caps_malloc(1024 * sizeof(uint16_t), MALLOC_CAP_SPIRAM);
    if (!solid) {
        for (int j = 0; j < h; j++) hline(x, y + j, w, color);
        return;
    }
    if (!solidReady || solidColor != color) {
        for (int i = 0; i < 1024; i++) solid[i] = color;
        solidColor = color;
        solidReady = true;
    }
    const int rows = max(1, 1024 / w);
    for (int row = 0; row < h; row += rows) bitmap(x, y + row, solid, w, min(rows, h - row));
}

/** Sends `h` rows of `src` (each width() wide) to the panel at logical `y`, turned to the current rotation. */
static void pushRows(const uint16_t *src, int y, int h) {
    const int w = width();
    static uint16_t row[1024];
    if (rotation == 0) {
        // Whole rows as they are, as many to a write as the driver takes.
        for (int j = 0; j < h; j += 1024 / w) bitmap(0, y + j, src + j * w, w, min(1024 / w, h - j));
        return;
    }
    if (rotation == 180) {
        for (int j = 0; j < h; j++) {
            for (int i = 0; i < w; i++) row[i] = src[(h - 1 - j) * w + (w - 1 - i)];
            bitmap(0, LCD_HEIGHT - (y + h) + j, row, w, 1);
        }
        return;
    }
    // Sideways: the band becomes a column `h` wide and `w` tall on the panel, sent a few of its panel rows at a time.
    const int px = rotation == 90 ? y : height() - (y + h);
    const int per = max(1, 1024 / h);
    for (int j0 = 0; j0 < w; j0 += per) {
        const int n = min(per, w - j0);
        for (int k = 0; k < n; k++) {
            const int j = j0 + k;
            uint16_t *out = row + k * h;
            for (int i = 0; i < h; i++) out[i] = rotation == 90 ? src[i * w + (w - 1 - j)] : src[(h - 1 - i) * w + j];
        }
        bitmap(px, j0, row, h, n);
    }
}
/** Sends the top `h` rows of the band to the panel at logical `y`, turned to the current rotation. */
static void pushBand(int y, int h) { pushRows(band->getFramebuffer(), y, h); }

void blitScreen(const uint16_t *pixels) { pushRows(pixels, 0, height()); }

void blitRect(int x, int y, int w, int h, const uint16_t *pixels) {
    static uint16_t row[LCD_HEIGHT];
    if (w <= 0 || h <= 0 || w > LCD_HEIGHT || h > LCD_HEIGHT) return;
    if (rotation == 0) {
        for (int j = 0; j < h; j++) bitmap(x, y + j, pixels + j * w, w, 1);
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

bool setTextSize(int index) {
    index = constrain(index, 0, 2);
    if (index == sizeIndex) return false;
    sizeIndex = index;
    return true;
}
int textSize() { return sizeIndex; }
int lineHeight(uint8_t kind) { return kind >= 3 ? metrics().headHeight : metrics().bodyHeight; }
const Buttons &buttons() { return metrics().buttons; }

static const GFXfont *fontFor(uint8_t kind) { return kind >= 3 ? metrics().head : metrics().body; }
/** Where the letters stand in a band of that kind, measured from its top. */
static int baselineFor(uint8_t kind) { return kind >= 3 ? metrics().headBaseline : metrics().bodyBaseline; }

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
int buttonTextWidth(const String &text) { return widthIn(metrics().button, plain(text)); }

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
    if (barPermille >= 0) {
        // Half the screen wide, under the middle of the text: a dim track and the part that is done.
        const int bw = w / 2, bx = (w - bw) / 2, by = h - 3;
        band->fillRect(bx, by, bw, 3, 0x2104);
        band->fillRect(bx, by, bw * min(barPermille, 1000) / 1000, 3, barColor);
    }

    pushBand(y, h);
}
void pillCells(int count, int cols, int &left, int &cell) {
    cell = width() / max(1, cols);
    // A row that is not full sits in the middle.
    left = (width() - cell * count) / 2;
}

void pillRow(int y, int h, const String *labels, int count, int cols, uint16_t outline, uint16_t textColor) {
    const int w = width();
    h = min(h, BAND_MAX_HEIGHT);
    int left = 0, cell = 0;
    pillCells(count, cols, left, cell);
    const GFXfont *font = metrics().button;
    const int gap = metrics().pillGap;
    band->fillRect(0, 0, w, h, RGB565_BLACK);
    band->setFont(font);
    band->setTextSize(1);
    band->setTextColor(textColor);
    band->setTextWrap(false);
    for (int i = 0; i < count; i++) {
        const int x = left + i * cell + gap, pw = cell - 2 * gap, ph = h - 2 * gap;
        band->drawRoundRect(x, gap, pw, ph, ph / 2, outline);
        band->drawRoundRect(x + 1, gap + 1, pw - 2, ph - 2, ph / 2 - 1, outline);
        String shown = plain(labels[i]);
        const int room = pw - ph / 2;
        if (widthIn(font, shown) > room) {
            while (shown.length() > 1 && widthIn(font, shown + "..") > room) shown.remove(shown.length() - 1);
            shown += "..";
        }
        // The capitals stand on the cursor line, buttonLetters tall.
        band->setCursor(x + (pw - widthIn(font, shown)) / 2, gap + (ph + metrics().buttonLetters) / 2 - 1);
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
bool mirroring() { return shadow != nullptr; }

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
