#!/usr/bin/env python3
"""Render captured ANSI terminal text to a PNG (README screenshots).

Reads text from a file (or stdin), parses SGR color codes (incl. 256/truecolor),
and draws a monospace terminal window with a dark theme using PIL. Glyphs are
drawn per cell so CJK double-width characters stay aligned.

Usage:
  term2png.py in.txt out.png [--width-cols 100] [--height-rows 40] [--scale 2]
"""
import argparse
import re
import sys
import unicodedata
from PIL import Image, ImageDraw, ImageFont

SGR_RE = re.compile(r"\x1b\[([0-9;]*)m")
CLEAR_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
ESC_RE = re.compile(r"\x1b")

BG = (11, 15, 20)      # #0b0f14 terminal background
FG_DEFAULT = (229, 231, 235)
RULE = (51, 65, 85)

FONT_CANDIDATES = [
    ("/System/Library/Fonts/Menlo.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Menlo.ttc", 0),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 0),
]


def basic_rgb(code):
    table = [
        (0, 0, 0), (205, 49, 49), (13, 188, 121), (229, 229, 16),
        (36, 114, 200), (188, 63, 188), (17, 168, 205), (229, 229, 229),
        (102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67),
        (59, 142, 234), (214, 112, 214), (41, 184, 219), (255, 255, 255),
    ]
    return table[code]


def xterm256(code):
    if code < 16:
        return basic_rgb(code)
    if code < 232:
        code -= 16
        r = code // 36
        g = (code % 36) // 6
        b = code % 6
        step = [0, 95, 135, 175, 215, 255]
        return (step[r], step[g], step[b])
    v = 8 + (code - 232) * 10
    return (v, v, v)


def parse_color(params, kind):
    """kind: 'fg' or 'bg'. params is the list of SGR ints."""
    for i, p in enumerate(params):
        if p == 38 or p == 48:
            kind_now = "fg" if p == 38 else "bg"
            if i + 1 < len(params) and params[i + 1] == 5 and i + 2 < len(params):
                rgb = xterm256(params[i + 2])
                if kind_now == kind:
                    return rgb
            elif i + 1 < len(params) and params[i + 1] == 2 and i + 4 < len(params):
                rgb = (params[i + 2], params[i + 3], params[i + 4])
                if kind_now == kind:
                    return rgb
        elif 30 <= p <= 37:
            if kind == "fg":
                return basic_rgb(p - 30)
        elif 90 <= p <= 97:
            if kind == "fg":
                return basic_rgb(p - 90 + 8)
        elif 40 <= p <= 47:
            if kind == "bg":
                return basic_rgb(p - 40)
        elif 100 <= p <= 107:
            if kind == "bg":
                return basic_rgb(p - 100 + 8)
    return None


def is_wide(ch):
    return unicodedata.east_asian_width(ch) in ("W", "F")


def parse(text):
    """Return list of rows; each row is a list of (char, fg, bold)."""
    text = CLEAR_RE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    rows = []
    fg = FG_DEFAULT
    bold = False
    for raw in text.split("\n"):
        row = []
        buf = ""
        i = 0
        # split on SGR codes
        parts = SGR_RE.split(raw)
        # parts[0] is text before first code; then alternating code, text
        for idx, part in enumerate(parts):
            if idx % 2 == 1:
                params = [int(x) for x in part.split(";") if x != ""]
                for p in params:
                    if p == 0:
                        fg = FG_DEFAULT
                        bold = False
                    elif p == 1:
                        bold = True
                    elif p == 22:
                        bold = False
                    else:
                        c = parse_color(params, "fg")
                        if c is not None:
                            fg = c
                continue
            for ch in part:
                row.append((ch, fg, bold))
        rows.append(row)
    return rows


def load_font(size):
    for path, index in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size, index=index)
        except Exception:
            continue
    return ImageFont.load_default()


def render(rows, cols, rows_hint, scale):
    size = 20 * scale
    font = load_font(size)
    ascent, descent = font.getmetrics()
    line_h = ascent + descent + 2 * scale
    # measure advance of "M" and digits; Menlo is monospace
    adv = font.getlength("M")
    char_w = int(round(adv))
    width = max(640, char_w * cols + 2 * 12 * scale)
    height = max(200, line_h * len(rows) + 2 * 12 * scale + 28 * scale)
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    # window frame: title bar
    bar_h = 28 * scale
    draw.rectangle([0, 0, width, bar_h], fill=(24, 30, 38))
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (40, 201, 100)]):
        draw.ellipse([(12 + i * 18) * scale, 9 * scale, (12 + i * 18) * scale + 10 * scale, 19 * scale], fill=color)
    draw.text((width / 2 - 20 * scale, 6 * scale), "0xAF-Re", fill=(148, 163, 184), font=load_font(13 * scale))
    top = bar_h + 12 * scale
    for r, row in enumerate(rows):
        x = 12 * scale
        y = top + r * line_h
        for ch, color, bold in row:
            if ch == "\t":
                ch = " "
            if is_wide(ch):
                draw.text((x, y), ch, fill=color, font=font)
                x += char_w * 2
            else:
                draw.text((x, y), ch, fill=color, font=font)
                x += char_w
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--scale", type=int, default=2)
    args = ap.parse_args()
    text = open(args.input, encoding="utf-8").read()
    rows = parse(text)
    img = render(rows, 100, 40, args.scale)
    img.save(args.output)
    print(f"wrote {args.output} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
