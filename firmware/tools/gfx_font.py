#!/usr/bin/env python3
"""Writes a GFX font header (the format of the Adafruit GFX Library's Fonts/, which Arduino_GFX reads too)
from a TrueType font, the way the library's own fontconvert does: FreeType at 141 dpi, glyphs rendered
one bit deep, ASCII 0x20 to 0x7E.

    python3 gfx_font.py /usr/share/fonts/truetype/freefont/FreeSansBold.ttf 15 FreeSansBold15pt7b > FreeSansBold15pt7b.h

Needs freetype-py (`pip install freetype-py`). Run on FreeSans.ttf at 12 it gives the library's
FreeSans12pt7b.h bitmaps and metrics, which is how it was checked.
"""

import sys

import freetype

DPI = 141
FIRST, LAST = 0x20, 0x7E


def convert(path, points, name):
    face = freetype.Face(path)
    face.set_char_size(points << 6, 0, DPI, 0)
    bits, glyphs = bytearray(), []
    for code in range(FIRST, LAST + 1):
        face.load_char(chr(code), freetype.FT_LOAD_TARGET_MONO | freetype.FT_LOAD_RENDER)
        slot = face.glyph
        bitmap = slot.bitmap
        if code == 0x20:
            # Newer FreeType gives the space a blank 1 by 1 bitmap; the library's fonts have none.
            glyphs.append((len(bits), 0, 0, slot.advance.x >> 6, 0, 1))
            continue
        glyphs.append((len(bits), bitmap.width, bitmap.rows, slot.advance.x >> 6, slot.bitmap_left, 1 - slot.bitmap_top))
        # Bits run on from row to row with no padding; a glyph starts on a fresh byte.
        acc, count = 0, 0
        for y in range(bitmap.rows):
            for x in range(bitmap.width):
                on = bitmap.buffer[y * bitmap.pitch + (x >> 3)] & (0x80 >> (x & 7))
                acc = (acc << 1) | (1 if on else 0)
                count += 1
                if count == 8:
                    bits.append(acc)
                    acc, count = 0, 0
        if count:
            bits.append(acc << (8 - count))
    out = []
    out.append(f"const uint8_t {name}Bitmaps[] PROGMEM = {{")
    for i in range(0, len(bits), 12):
        out.append("    " + ", ".join(f"0x{b:02X}" for b in bits[i:i + 12]) + ",")
    out.append("};")
    out.append("")
    out.append(f"const GFXglyph {name}Glyphs[] PROGMEM = {{")
    for code, (offset, w, h, adv, xo, yo) in zip(range(FIRST, LAST + 1), glyphs):
        out.append(f"    {{{offset}, {w}, {h}, {adv}, {xo}, {yo}}},  // 0x{code:02X} '{chr(code)}'")
    out.append("};")
    out.append("")
    out.append(f"const GFXfont {name} PROGMEM = {{(uint8_t *){name}Bitmaps, (GFXglyph *){name}Glyphs, 0x{FIRST:02X}, 0x{LAST:02X}, {face.size.height >> 6}}};")
    out.append("")
    out.append(f"// Approx. {len(bits) + 7 * len(glyphs) + 7} bytes")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    sys.stdout.write(convert(sys.argv[1], int(sys.argv[2]), sys.argv[3]))
