#!/usr/bin/env python3
"""Capture a terminal session as an *animated* SVG, in the docs/shots house style.

This is the moving sibling of capture-shot.py. Same premise — a real pty running
the real binary, replayed through a real VT emulator — but the screen is sampled
over time instead of once at the end, and the frames are emitted as one SVG that
animates with CSS. No JavaScript, no external player, no upload: it renders
inline in a GitHub README the same way the static shots do.

    scripts/capture-cast.py --cols 100 --rows 30 \
        --out docs/casts/scan.svg \
        --feed '/scan carrier.bin\n/exit\n' \
        -- ./bin/0xaf --provider mock --workspace ./demos/reverse-lab

Geometry, palette and background are imported from capture-shot.py so the two
never drift apart. Keystrokes are typed one character at a time (--typing) so
the capture shows the command being entered rather than appearing whole.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import os
import pathlib
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import xml.sax.saxutils as sx

import pyte

# Share one source of truth for geometry and colour with the static capture.
# The filename is not a valid module name, so load it by path — without leaving
# a __pycache__ behind in scripts/, which is not in .gitignore.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location(
    "capture_shot", pathlib.Path(__file__).with_name("capture-shot.py"))
shot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shot)


def record_pty(argv, cols, rows, feed=b"", timeout=40.0, settle=1.5,
               between=1.0, typing=0.045):
    """Run argv on a pty and return (chunks, started) with per-chunk timestamps.

    Identical in spirit to capture-shot.run_in_pty, except every read is stamped
    so the session can be replayed with its original pacing, and fed lines are
    written a character at a time so the program echoes them like typing.
    """
    master, slave = pty.openpty()
    env = dict(os.environ, TERM="xterm-256color", COLUMNS=str(cols),
               LINES=str(rows), COLORTERM="truecolor")
    fcntl.ioctl(slave, termios.TIOCSWINSZ,
                struct.pack("HHHH", rows, cols, 0, 0))

    proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave,
                            env=env, close_fds=True, start_new_session=True)
    os.close(slave)

    def send():
        if not feed:
            return
        time.sleep(settle)
        for line in feed.splitlines(keepends=True):
            body, nl = line.rstrip(b"\r\n"), line[len(line.rstrip(b"\r\n")):]
            for i in range(len(body)):
                try:
                    os.write(master, body[i:i + 1])
                except OSError:
                    return
                time.sleep(typing)
            if nl:
                try:
                    os.write(master, nl)
                except OSError:
                    return
            time.sleep(between)

    if feed:
        threading.Thread(target=send, daemon=True).start()

    chunks, start = [], time.monotonic()
    while True:
        if time.monotonic() - start > timeout:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            break
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            chunks.append((time.monotonic() - start, data))
        elif proc.poll() is not None:
            break
    os.close(master)
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    return chunks


def sample(chunks, cols, rows, fps, max_frames):
    """Replay the stamped chunks into pyte, snapshotting on a fixed time grid.

    Returns (frames, duration) where each frame is (t, screen_lines). Runs of
    identical screens collapse to a single frame, which is what keeps the SVG
    small: terminal output is bursty, so most sample points repeat.
    """
    if not chunks:
        return [], 0.0
    duration = chunks[-1][0]
    step = 1.0 / fps
    if duration / step > max_frames:
        step = duration / max_frames

    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)

    frames, seen, t, i = [], None, 0.0, 0
    while t <= duration + 1e-9:
        while i < len(chunks) and chunks[i][0] <= t:
            stream.feed(chunks[i][1])
            i += 1
        lines = snapshot(screen, cols, rows)
        key = hashlib.blake2b(
            repr(lines).encode(), digest_size=16).hexdigest()
        if key != seen:
            frames.append((t, lines))
            seen = key
        t += step

    # Open on the first drawn frame, not on the blank screen the program leaves
    # behind while it starts up, and rebase the clock so the loop starts there.
    first = next((n for n, (_, lines) in enumerate(frames) if lines), 0)
    offset = frames[first][0] if frames else 0.0
    frames = [(t - offset, lines) for t, lines in frames[first:]]
    return frames, duration - offset


def snapshot(screen, cols, rows):
    """Freeze the current screen as [(row, [(fg, bold, col, text), ...]), ...]."""
    out = []
    for row in range(rows):
        line = screen.buffer[row]
        runs, cur = [], None
        for col in range(cols):
            ch = line[col]
            text = ch.data or " "
            fg = shot.resolve(ch.fg, shot.DEFAULT_FG)
            if ch.reverse:
                fg = shot.BG
            key = (fg, bool(ch.bold))
            if cur and cur[0] == key and cur[2] + len(cur[3]) == col:
                cur[3] += text
            else:
                cur = [key, col, col, text]
                runs.append(cur)
        kept = [(fg, bold, col, text)
                for (fg, bold), col, _, text in runs if text.strip()]
        if kept:
            out.append((row, kept))
    return out


def frame_svg(lines):
    parts = []
    for row, runs in lines:
        pieces = []
        for fg, bold, col, text in runs:
            x = shot.PAD_X + col * shot.ADVANCE
            n = sum(2 if ord(c) > 0x2E80 else 1 for c in text)
            extra = ' font-weight="600"' if bold else ""
            pieces.append(
                f'<tspan x="{x:.1f}" textLength="{n * shot.ADVANCE:.1f}" '
                f'lengthAdjust="spacingAndGlyphs" fill="{fg}"{extra}>'
                f"{sx.escape(text)}</tspan>")
        y = shot.FIRST_BASELINE + row * shot.LINE_H
        parts.append(f'<text y="{y:.1f}" xml:space="preserve">'
                     + "".join(pieces) + "</text>")
    return "".join(parts)


def to_svg(frames, duration, cols, hold):
    """One <g> per frame, shown in turn by a stepped CSS keyframe animation."""
    used = [row for _, lines in frames for row, _ in lines]
    last = (max(used) if used else 0) + 1
    width = shot.PAD_X * 2 + cols * shot.ADVANCE
    height = shot.FIRST_BASELINE + (last - 1) * shot.LINE_H + 22
    total = duration + hold

    # A renderer that ignores CSS animation would otherwise show nothing at all,
    # since every frame starts hidden. `.fb` leaves the fullest frame visible as
    # a still — not the last one, which is often a screen the program has just
    # scrolled or cleared. The animation overrides it wherever it does run,
    # because animated values win over normal declarations.
    fallback = max(range(len(frames)),
                   key=lambda n: sum(len(t) for _, runs in frames[n][1]
                                     for *_, t in runs))
    css = [f".f{{opacity:0;animation-duration:{total:.2f}s;"
           "animation-iteration-count:infinite;"
           "animation-timing-function:steps(1,end)}",
           ".fb{opacity:1}"]
    body = []
    for i, (t, lines) in enumerate(frames):
        end = frames[i + 1][0] if i + 1 < len(frames) else total
        a, b = 100.0 * t / total, 100.0 * end / total
        css.append(f"#f{i}{{animation-name:k{i}}}")
        css.append(
            f"@keyframes k{i}{{0%,{b:.3f}%{{opacity:0}}"
            f"{a:.3f}%{{opacity:1}}100%{{opacity:0}}}}"
            if i else
            f"@keyframes k{i}{{0%{{opacity:1}}{b:.3f}%{{opacity:0}}"
            "100%{opacity:0}}")
        cls = "f fb" if i == fallback else "f"
        body.append(f'<g class="{cls}" id="f{i}">{frame_svg(lines)}</g>')

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" '
        f'height="{height:.0f}" viewBox="0 0 {width:.0f} {height:.0f}" '
        f"font-family='{shot.FONT}' font-size=\"{shot.FONT_SIZE}\">"
        f'<rect width="100%" height="100%" rx="10" fill="{shot.BG}"/>'
        f"<style>{''.join(css)}</style>"
        + "".join(body) + "</svg>\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=100)
    ap.add_argument("--rows", type=int, default=30)
    ap.add_argument("--out", required=True)
    ap.add_argument("--feed", default="",
                    help="keystrokes to type once the program is up")
    ap.add_argument("--timeout", type=float, default=40.0)
    ap.add_argument("--settle", type=float, default=1.5,
                    help="seconds to let the program draw before typing")
    ap.add_argument("--between", type=float, default=1.6,
                    help="seconds to wait after each fed line")
    ap.add_argument("--typing", type=float, default=0.045,
                    help="seconds per typed character")
    ap.add_argument("--fps", type=float, default=12.0,
                    help="screen samples per second before de-duplication")
    ap.add_argument("--max-frames", type=int, default=90,
                    help="cap on emitted frames; sampling widens to fit")
    ap.add_argument("--hold", type=float, default=2.5,
                    help="seconds to hold the last frame before looping")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    args = ap.parse_args()

    argv = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not argv:
        ap.error("give a command after --")

    chunks = record_pty(
        argv, args.cols, args.rows,
        feed=args.feed.encode().decode("unicode_escape").encode(),
        timeout=args.timeout, settle=args.settle, between=args.between,
        typing=args.typing)
    frames, duration = sample(chunks, args.cols, args.rows,
                              args.fps, args.max_frames)
    if not frames:
        raise SystemExit("captured nothing — did the command start?")

    svg = to_svg(frames, duration, args.cols, args.hold)
    pathlib.Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(svg)
    print(f"{args.out}: {args.cols}x{args.rows}, {len(frames)} frames, "
          f"{duration + args.hold:.1f}s, {len(svg) // 1024} KiB")


if __name__ == "__main__":
    main()
