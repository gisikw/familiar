#!/usr/bin/env fontforge
"""Fill ProggyClean Nerd Font's missing Unicode symbols from DejaVu Sans."""

import fontforge
import psMat
import sys

BASE, DONOR, OUTPUT = sys.argv[1:4]
RANGES = (
    (0x0100, 0x024F),  # Latin Extended A/B
    (0x0370, 0x03FF),  # Greek
    (0x0400, 0x04FF),  # Cyrillic
    (0x2000, 0x206F),  # General Punctuation
    (0x2190, 0x21FF),  # Arrows
    (0x2200, 0x22FF),  # Mathematical Operators
    (0x2300, 0x23FF),  # Miscellaneous Technical
    (0x2500, 0x25FF),  # Box Drawing, Block Elements, Geometric Shapes
    (0x2600, 0x26FF),  # Miscellaneous Symbols
    (0x2700, 0x27BF),  # Dingbats
    (0x27F0, 0x27FF),  # Supplemental Arrows-A
    (0x2900, 0x297F),  # Supplemental Arrows-B (arrow portion)
    (0x2B00, 0x2BFF),  # Miscellaneous Symbols and Arrows
)

base = fontforge.open(BASE)
donor = fontforge.open(DONOR)
cell = base[0x20].width
# Changing em scales donor outlines and makes clipboard transfer use the base's
# coordinate system while retaining the donor's vertical proportions.
donor.em = base.em
added = 0

for first, last in RANGES:
    for codepoint in range(first, last + 1):
        if codepoint in base or codepoint not in donor:
            continue
        donor.selection.select(("unicode",), codepoint)
        donor.copy()
        glyph = base.createChar(codepoint)
        base.selection.select(("unicode",), codepoint)
        base.paste()

        # Preserve the terminal grid: shrink wide donor outlines to leave a
        # small side bearing, center them, and force every advance to one cell.
        xmin, _ymin, xmax, _ymax = glyph.boundingBox()
        outline_width = xmax - xmin
        max_width = cell * 0.90
        if outline_width > max_width and outline_width > 0:
            scale = max_width / outline_width
            glyph.transform(psMat.scale(scale, scale))
            xmin, _ymin, xmax, _ymax = glyph.boundingBox()
        glyph.transform(psMat.translate((cell - (xmax - xmin)) / 2 - xmin, 0))
        glyph.width = cell
        added += 1

base.familyname = "ProggyClean Nerd Font Mono Symbols"
base.fullname = "ProggyClean Nerd Font Mono Symbols Regular"
base.fontname = "ProggyCleanNerdFontMono-Symbols-Regular"
base.version = (base.version or "") + "+familiar-symbols1"
base.comment = (base.comment or "") + "\nFamiliar: missing BMP symbols merged from DejaVu Sans; mono metrics preserved."
base.generate(OUTPUT)
print("added %d glyphs; mono advance %d; em %d" % (added, cell, base.em))
base.close()
donor.close()
