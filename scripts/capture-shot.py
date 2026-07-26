#!/usr/bin/env python3
"""Capture a terminal session as an SVG, the way docs/shots/*.svg are made.

The screenshots in docs/ are real frames, not mock-ups, so they have to come out
of a real pty running the real binary. A plain tee of stdout is not enough: the
live pane redraws in place with cursor movement, so the bytes on the wire are
not the picture on the screen. This runs the command against a proper VT
emulator (pyte) at a fixed size and serialises the resulting screen.

    scripts/capture-shot.py --cols 120 --rows 40 \
        --out docs/shots/boot.svg -- ./bin/0xaf --welcome

Geometry matches the existing captures: 13.5px monospace, 8.4px advance,
19px line height, 16px padding, #0b0f14 background with a 10px radius.
"""
import argparse
import os
import pty
import select
import signal
import subprocess
import sys
import xml.sax.saxutils as sx

import pyte

ADVANCE = 8.4
LINE_H = 19.0
PAD_X = 16.0
FIRST_BASELINE = 60.4
FONT_SIZE = 13.5
FONT = ('ui-monospace,SFMono-Regular,Menlo,Consolas,'
        '"DejaVu Sans Mono","Liberation Mono",monospace')
BG = "#0b0f14"

# pyte reports the 16 ANSI names; anything else already arrives as raw hex.
NAMED = {
    "black": "#0b0f14", "red": "#e05561", "green": "#8cc265",
    "brown": "#d18f52", "yellow": "#d18f52", "blue": "#4aa5f0",
    "magenta": "#c162de", "cyan": "#42b3c2", "white": "#c3c8d1",
    "brightblack": "#5c6370", "brightred": "#ff616e",
    "brightgreen": "#a5e075", "brightyellow": "#f0a45d",
    "brightblue": "#4dc4ff", "brightmagenta": "#de73ff",
    "brightcyan": "#4cd1e0", "brightwhite": "#e6e6e6",
}
DEFAULT_FG = "#c3c8d1"


def resolve(color, default):
    if not color or color == "default":
        return default
    if color in NAMED:
        return NAMED[color]
    if len(color) == 6 and all(c in "0123456789abcdefABCDEF" for c in color):
        return "#" + color.lower()
    return default


def run_in_pty(argv, cols, rows, feed=b"", timeout=25.0, settle=0.0,
               between=0.0):
    """Run argv on a pty of the given size and return everything it wrote.

    `settle` waits for the program to finish drawing before the first
    keystroke, otherwise the shell echoes the input above the boot screen and
    the capture opens with the commands instead of the program. `between`
    paces the remaining lines so each one is answered before the next arrives.
    """
    master, slave = pty.openpty()
    env = dict(os.environ, TERM="xterm-256color", COLUMNS=str(cols),
               LINES=str(rows), COLORTERM="truecolor")
    import fcntl
    import struct
    import termios
    fcntl.ioctl(slave, termios.TIOCSWINSZ,
                struct.pack("HHHH", rows, cols, 0, 0))

    proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave,
                            env=env, close_fds=True, start_new_session=True)
    os.close(slave)

    import threading
    import time as _t

    def send():
        if not feed:
            return
        _t.sleep(settle)
        for line in feed.splitlines(keepends=True):
            try:
                os.write(master, line)
            except OSError:
                return
            _t.sleep(between)

    if feed:
        threading.Thread(target=send, daemon=True).start()

    chunks = []
    deadline = timeout
    import time
    start = time.monotonic()
    while True:
        if time.monotonic() - start > deadline:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            break
        ready, _, _ = select.select([master], [], [], 0.4)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            chunks.append(data)
        elif proc.poll() is not None:
            break
    os.close(master)
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    return b"".join(chunks)


def to_svg(screen, cols):
    width = PAD_X * 2 + cols * ADVANCE
    # screen.buffer is a defaultdict: read it by index, never iterate it, or
    # touching a cell grows the mapping mid-loop.
    rows_with_text = [r for r in range(screen.lines)
                      if any(screen.buffer[r][c].data.strip()
                             for c in range(cols))]
    last = (max(rows_with_text) if rows_with_text else 0) + 1
    height = FIRST_BASELINE + (last - 1) * LINE_H + 22

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" '
        f'height="{height:.0f}" viewBox="0 0 {width:.0f} {height:.0f}" '
        f"font-family='{FONT}' font-size=\"{FONT_SIZE}\">",
        f'<rect width="100%" height="100%" rx="10" fill="{BG}"/>',
    ]

    for row in range(last):
        line = screen.buffer[row]
        # group horizontally adjacent cells that share styling
        runs, cur = [], None
        for col in range(cols):
            ch = line[col]
            text = ch.data or " "
            fg = resolve(ch.fg, DEFAULT_FG)
            if ch.reverse:
                fg = BG
            key = (fg, bool(ch.bold))
            if cur and cur[0] == key and cur[2] + len(cur[3]) == col:
                cur[3] += text
            else:
                cur = [key, col, col, text]
                runs.append(cur)
        pieces = []
        for (fg, bold), col, _, text in runs:
            if not text.strip():
                continue
            x = PAD_X + col * ADVANCE
            n = sum(2 if ord(c) > 0x2E80 else 1 for c in text)
            extra = ' font-weight="600"' if bold else ""
            pieces.append(
                f'<tspan x="{x:.1f}" textLength="{n * ADVANCE:.1f}" '
                f'lengthAdjust="spacingAndGlyphs" fill="{fg}"{extra}>'
                f"{sx.escape(text)}</tspan>")
        if pieces:
            y = FIRST_BASELINE + row * LINE_H
            out.append(f'<text y="{y:.1f}" xml:space="preserve">'
                       + "".join(pieces) + "</text>")

    out.append("</svg>")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=40)
    ap.add_argument("--out", required=True)
    ap.add_argument("--feed", default="",
                    help="keystrokes to send once the program is up")
    ap.add_argument("--timeout", type=float, default=25.0)
    ap.add_argument("--settle", type=float, default=1.5,
                    help="seconds to let the program draw before typing, so "
                         "the input is not echoed above the boot screen")
    ap.add_argument("--between", type=float, default=1.0,
                    help="seconds between fed lines")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()

    argv = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not argv:
        ap.error("give a command after --")

    raw = run_in_pty(argv, args.cols, args.rows,
                     feed=args.feed.encode().decode("unicode_escape").encode(),
                     timeout=args.timeout, settle=args.settle,
                     between=args.between)

    screen = pyte.Screen(args.cols, args.rows)
    stream = pyte.ByteStream(screen)
    stream.feed(raw)

    svg = to_svg(screen, args.cols)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(svg)
    print(f"{args.out}: {args.cols}x{args.rows}, {len(svg)} B")


if __name__ == "__main__":
    main()
