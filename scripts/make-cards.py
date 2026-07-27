#!/usr/bin/env python3
"""Generate the portrait share cards under docs/cards/.

1080x1440 (3:4), the aspect Xiaohongshu and most feed readers crop to. Content
is written out line by line rather than auto-wrapped, so a long word can never
push a line past the margin — the whole point of the deck is that it reads at
thumbnail size.

    python3 scripts/make-cards.py
"""
import html
import os
import base64

W, H = 1080, 1440
M = 84                      # margin
SANS = ("-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',"
        "'DejaVu Sans',sans-serif")
MONO = ("ui-monospace,'JetBrains Mono','SFMono-Regular',Menlo,Consolas,"
        "'DejaVu Sans Mono','Liberation Mono',monospace")

FG = "#f1f5f9"
DIM = "#94a3b8"
FAINT = "#64748b"
LINE = "#1e293b"
CYAN = "#22d3ee"
GREEN = "#34d399"
AMBER = "#fbbf24"
ROSE = "#fb7185"
VIOLET = "#a78bfa"


def esc(s):
    return html.escape(s, quote=False)


class Card:
    def __init__(self, n, total, kicker, accent=CYAN):
        self.o = []
        self.n, self.total, self.kicker, self.accent = n, total, kicker, accent
        self.y = 0

    def head(self):
        a = self.accent
        self.o.append(
            f'<rect x="{M}" y="96" width="7" height="26" rx="3.5" fill="{a}"/>')
        self.o.append(
            f'<text x="{M+22}" y="117" fill="{a}" font-family="{MONO}" '
            f'font-size="17" font-weight="700" letter-spacing="0">'
            f"{esc(self.kicker)}</text>")
        if self.n:
            self.o.append(
                f'<text x="{W-M}" y="117" fill="{FAINT}" font-family="{MONO}" '
                f'font-size="17" text-anchor="end">'
                f"{self.n:02d} / {self.total:02d}</text>")

    def title(self, lines, y=300, size=60, fill=FG):
        for i, ln in enumerate(lines):
            self.o.append(
                f'<text x="{M}" y="{y + i * (size + 14)}" fill="{fill}" '
                f'font-family="{SANS}" font-size="{size}" font-weight="700" '
                f'letter-spacing="0">{ln}</text>')
        self.y = y + len(lines) * (size + 14)
        return self

    def rule(self, gap=52, width=260):
        self.y += gap
        self.o.append(
            f'<rect x="{M}" y="{self.y}" width="{width}" height="3" rx="1.5" '
            f'fill="{self.accent}"/>')
        self.y += 3
        return self

    def para(self, lines, gap=72, size=29, fill=DIM, lh=50):
        self.y += gap
        for ln in lines:
            self.o.append(
                f'<text x="{M}" y="{self.y}" fill="{fill}" '
                f'font-family="{SANS}" font-size="{size}">{ln}</text>')
            self.y += lh
        self.y -= lh
        return self

    def code(self, lines, gap=76, size=25, lh=42, pad=34):
        self.y += gap
        h = pad * 2 + len(lines) * lh - (lh - size)
        self.o.append(
            f'<rect x="{M}" y="{self.y}" width="{W-2*M}" height="{h}" rx="12" '
            f'fill="#0b1220" stroke="{LINE}" stroke-width="1.5"/>')
        ty = self.y + pad + size
        for ln in lines:
            self.o.append(
                f'<text x="{M+26}" y="{ty}" font-family="{MONO}" '
                f'font-size="{size}" xml:space="preserve">{ln}</text>')
            ty += lh
        self.y += h
        return self

    def rows(self, items, gap=76, size=29, lh=84):
        """items: (bullet_colour, bold_lead, rest)"""
        self.y += gap
        for colour, lead, rest in items:
            self.o.append(
                f'<circle cx="{M+7}" cy="{self.y-8}" r="6" fill="{colour}"/>')
            self.o.append(
                f'<text x="{M+30}" y="{self.y}" font-family="{SANS}" '
                f'font-size="{size}"><tspan fill="{FG}" font-weight="700">'
                f'{lead}</tspan><tspan fill="{DIM}">{rest}</tspan></text>')
            self.y += lh
        self.y -= lh
        return self

    def note(self, lines, size=24, fill=FAINT, gap=82, lh=38):
        self.y += gap
        for ln in lines:
            self.o.append(
                f'<text x="{M}" y="{self.y}" fill="{fill}" '
                f'font-family="{SANS}" font-size="{size}">{ln}</text>')
            self.y += lh
        self.y -= lh
        return self

    def foot(self, text="github.com/overkazaf/re-agent"):
        self.o.append(
            f'<line x1="{M}" y1="{H-116}" x2="{W-M}" y2="{H-116}" '
            f'stroke="{LINE}" stroke-width="1.5"/>')
        self.o.append(
            f'<rect x="{M}" y="{H-92}" width="72" height="30" rx="6" '
            f'fill="{CYAN}"/>')
        self.o.append(
            f'<text x="{M+36}" y="{H-70}" fill="#020617" font-family="{MONO}" '
            f'font-size="18" font-weight="700" text-anchor="middle">0xAF</text>')
        self.o.append(
            f'<text x="{M+86}" y="{H-70}" fill="{FG}" font-family="{MONO}" '
            f'font-size="18" font-weight="700" letter-spacing="0">RE</text>')
        self.o.append(
            f'<text x="{W-M}" y="{H-70}" fill="{FAINT}" font-family="{MONO}" '
            f'font-size="19" text-anchor="end">{esc(text)}</text>')
        return self

    def render(self):
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" '
            f'width="{W}" height="{H}">'
            '<defs><pattern id="g" width="48" height="48" '
            'patternUnits="userSpaceOnUse">'
            '<path d="M 48 0 L 0 0 0 48" fill="none" stroke="#0f1a2e" '
            'stroke-width="1"/></pattern></defs>'
            f'<rect width="{W}" height="{H}" fill="#020617"/>'
            f'<rect width="{W}" height="{H}" fill="url(#g)"/>'
            + "".join(self.o) + "</svg>")


def mono(txt, fill=FG, bold=False):
    b = ' font-weight="700"' if bold else ""
    return f'<tspan fill="{fill}"{b}>{esc(txt)}</tspan>'


def png_data_uri(path):
    with open(path, "rb") as fh:
        data = base64.b64encode(fh.read()).decode("ascii")
    return "data:image/png;base64," + data


CARDS = []


def card(*a, **k):
    c = Card(*a, **k)
    CARDS.append(c)
    return c


TOTAL = 10

# ---------------------------------------------------------------- 1 · cover
c = card(0, TOTAL, "REVERSE OPS DECK")
c.head()
c.title(["A reverse", "engineering agent", "that shows its"], y=300, size=68)
c.o.append(f'<text x="{M}" y="{300+3*82}" fill="{CYAN}" font-family="{SANS}" '
           f'font-size="68" font-weight="700" letter-spacing="0">work.</text>')
c.y = 300 + 3 * 82
c.rule(gap=44, width=300)
c.para([
    "A planner model and an executor model over",
    "24 local tools, drawing the turn while it runs —",
    "so you can see where the time went, and stop it",
    "when it goes somewhere useless.",
], size=29, lh=46)
c.code([
    mono("$ ", GREEN, True) + mono("0xaf --workspace ./ctf", "#cbd5e1"),
], size=25)
c.note([
    "One static Go binary · 6.7 MB · ~6.7 ms cold start",
    "One external dependency. No runtime to install.",
])
c.foot()

# ------------------------------------------------------------- 2 · problem
c = card(1, TOTAL, "THE PROBLEM", AMBER)
c.head()
c.title(["An agent you", "cannot see is an", "agent you cannot", "trust."], y=250, size=58)
c.rule(width=280)
c.para([
    "Reverse engineering is a long conversation with",
    "a binary. Two things decide whether an agent is",
    "useful for it, and neither is the model:",
])
c.rows([
    (GREEN, "Local tools  ", "— run against the real artifact,"),
    (CYAN, "Visibility  ", "— enough that you trust the answer"),
])
c.note([
    "Everything else in the design follows from those two.",
    "The rest of this deck is what that forced.",
])
c.foot()

# ------------------------------------------------------- 3 · principle 01
c = card(2, TOTAL, "PRINCIPLE 01", GREEN)
c.head()
c.title(["Two seats,", "one loop."], y=250, size=64)
c.rule(width=260)
c.para([
    "A planner reasons about the target. An executor",
    "drives the tools. They are different jobs —",
    "one wants divergence, the other wants compliance.",
])
c.code([
    mono("/planner  ", CYAN) + mono("codex", "#cbd5e1", True) +
    mono("      --sandbox read-only", FAINT),
    mono("/executor ", CYAN) + mono("claude", "#cbd5e1", True) +
    mono("     tool calls land more reliably", FAINT),
    "",
    mono("/planner  ", CYAN) + mono("grok-cli", "#cbd5e1", True) +
    mono("   swap mid-run, no restart", FAINT),
])
c.note([
    "Neither seat is bound to a vendor: any of 8 providers",
    "takes either one, and they mix — a local CLI planning",
    "while a direct API executes.",
])
c.foot()

# ------------------------------------------------------- 4 · principle 02
c = card(3, TOTAL, "PRINCIPLE 02", VIOLET)
c.head()
c.title(["Context is a", "budget, not", "a bin."], y=250, size=64)
c.rule(width=260)
c.para([
    "One objdump can flood a window. So the disk record",
    "stays whole and only the view sent upstream is cut:",
])
c.rows([
    (AMBER, "Pass 1  ", "— fold old tool bodies to one line"),
    (AMBER, "Pass 2  ", "— drop whole exchanges, oldest first"),
    (ROSE, "Floor  ", "— never delete the turn being answered"),
])
c.note([
    "A tool call is never split from its result. Strip one and",
    "a strict API refuses the history — the session stops",
    "being resumable, which is worse than going over budget.",
])
c.foot()

# ------------------------------------------------------- 5 · principle 03
c = card(4, TOTAL, "PRINCIPLE 03", ROSE)
c.head()
c.title(["A refusal is", "an answer."], y=250, size=64)
c.rule(width=260)
c.para([
    "A blocked command does not throw. It becomes a tool",
    "result the model reads, and the turn keeps going.",
])
c.code([
    mono("REVIEW", ROSE, True) + mono("  run_command", "#cbd5e1", True) +
    mono("   tier=exec", FAINT),
    mono("  curl https://api.example.com/sign", "#cbd5e1"),
    mono("  ! network command · needs --allow-network", ROSE),
    mono("  y once   a always   n skip   d never", FAINT),
])
c.note([
    "Safety patterns outrank a standing allow: permitting",
    "run_command is not permitting rm -rf /. With nobody",
    "attached, the gate denies rather than assumes.",
])
c.foot()

# ------------------------------------------------------- 6 · principle 04
c = card(5, TOTAL, "PRINCIPLE 04", CYAN)
c.head()
c.title(["Decoration", "must never", "fail a run."], y=250, size=62)
c.rule(width=260)
c.para([
    "The live pane redraws every 90 ms. When the terminal",
    "is too narrow it sheds detail in a fixed order rather",
    "than wrap, overflow, or crash the turn:",
])
c.rows([
    (FAINT, "1 ", "— the reasoning tail goes first"),
    (FAINT, "2 ", "— then the plan note"),
    (FAINT, "3 ", "— the task list collapses to N done / N more"),
    (FAINT, "4 ", "— telemetry sheds to a floor of two cells"),
])
c.note([
    "The floor keeps the clock and the phase label. Is it alive,",
    "and what is it doing — that outranks every number.",
])
c.foot()

# ---------------------------------------------------------- 7 · in practice
c = card(6, TOTAL, "IN PRACTICE", GREEN)
c.head()
c.title(["The fast path", "costs zero", "tokens."], y=250, size=62)
c.rule(width=260)
c.para([
    "The tool list was not derived from what an LLM agent",
    "should have. It was copied off a real first pass —",
    "and every one of them is also a slash command.",
])
c.code([
    mono("/scan artifact.txt", CYAN, True),
    mono("  entropy 5.083 · 100% printable", FAINT),
    mono("  base64 candidate · 1 URL", GREEN),
    "",
    mono("/decode base64 ZmxhZ3tk...", CYAN, True),
    mono("/mitigations ./chall", CYAN, True) +
    mono("   PIE NX canary RELRO", FAINT),
])
c.note([
    "No model is involved. Triage a hundred files and the",
    "token bill is still zero — you only pay when you",
    "actually need reasoning.",
])
c.foot()

# --------------------------------------------------------- 8 · in practice
c = card(7, TOTAL, "IN PRACTICE", AMBER)
c.head()
c.title(["When the", "model says no."], y=250, size=62)
c.rule(width=260)
c.para([
    "Vendors differ sharply on reverse-engineering requests,",
    "and the same vendor drifts over time. Refusal is a",
    "normal operating condition here, not an incident.",
])
c.rows([
    (ROSE, "Refused  ", "— stop_reason=refusal, turn wasted"),
    (AMBER, "Softened  ", "— generic advice, dodges the check"),
    (GREEN, "Answered  ", "— what you were hoping for"),
])
c.code([
    mono("/agent grok", CYAN, True) +
    mono("      different policy boundary", FAINT),
], size=23)
c.note([
    "So the architecture leaves an exit: refusal is a first-class",
    "failure cause, providers swap without a restart, and the",
    "triage path never touches a model at all.",
])
c.foot()

# ---------------------------------------------------------- 9 · workflow
c = card(8, TOTAL, "WORKFLOW MODES", VIOLET)
c.head()
c.title(["Cyber seat", "when you", "have it."], y=224, size=62)
c.o.append(f'<text x="{M}" y="{224+3*76}" fill="{AMBER}" font-family="{SANS}" '
           f'font-size="62" font-weight="700" letter-spacing="0">Caveman when you do not.</text>')
c.y = 224 + 3 * 76
c.rule(gap=46, width=330)
c.para([
    "If your route is backed by GPT Cyber or CC CVP,",
    "0xAF-Re can plan and run the RE task directly.",
    "If not, it delegates through a local evidence runner.",
], gap=62, size=28, lh=45)
c.rows([
    (GREEN, "auto  ", "— detect cyber / CVP provider markers"),
    (CYAN, "specialist  ", "— plan, use skills, preserve evidence"),
    (AMBER, "caveman  ", "— planner -> isolated executor packet"),
], gap=62, size=27, lh=78)
c.code([
    mono("/workflow auto", CYAN, True) +
    mono("        route by provider", FAINT),
    mono("/workflow caveman", AMBER, True) +
    mono("     isolated evidence runner", FAINT),
    mono("0xaf --workflow specialist -p \"triage ./app.apk\"", CYAN),
], gap=70, size=23, lh=40)
c.note([
    "Caveman mode is not prompt laundering. The planner keeps",
    "the full authorized task; the executor gets only a bounded",
    "read-only local evidence packet.",
], gap=64)
c.foot()

# ------------------------------------------------------ 10 · live queue
c = card(9, TOTAL, "LIVE QUEUE", GREEN)
c.head()
c.title(["Do not wait", "for the turn", "to finish."], y=240, size=62)
c.rule(width=300)
c.para([
    "While the current reverse task is running, type the",
    "next task and press Enter. It lands in a queue instead",
    "of stealing the active provider call.",
], gap=62, size=28, lh=45)
c.rows([
    (CYAN, "edit  ", "— rewrite queued work before it starts"),
    (ROSE, "cancel  ", "— drop a bad next task without ^C"),
    (AMBER, "fold  ", "— collapse or expand the live task list"),
], gap=62, size=28, lh=78)
c.code([
    mono("type next prompt + Enter", CYAN, True) +
    mono("   queues it", FAINT),
    mono("/queue edit 2 triage ./fixed.apk", GREEN, True),
    mono("/queue cancel 2", ROSE, True) +
    mono("      /tasks expand", AMBER, True),
], gap=70, size=23, lh=40)
c.note([
    "Approval prompts still own stdin. The queue waits, so a",
    "y/n decision never gets swallowed by background capture.",
])
c.foot()

# ----------------------------------------------------- 11 · discussion group
c = card(10, TOTAL, "DISCUSSION", ROSE)
c.head()
c.title(["Scan into", "the XHS", "discussion group."], y=190, size=58)
c.rule(gap=48, width=320)
c.para([
    "Reverse tasks move faster when people can compare",
    "artifacts, traces, and provider behavior.",
], gap=52, size=28, lh=45)
qr = png_data_uri(os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), "docs", "xhs-group-qr-crop.png"))
c.o.append(
    f'<rect x="264" y="600" width="552" height="552" rx="28" '
    f'fill="#f8fafc" stroke="{LINE}" stroke-width="1.5"/>')
c.o.append(
    f'<image href="{qr}" x="286" y="622" '
    'width="508" height="508" preserveAspectRatio="xMidYMid meet"/>')
c.y = 1120
c.note([
    "Scan with Xiaohongshu to join the group.",
    "QR valid through 2026-08-25.",
], gap=56, size=27, fill=FG, lh=44)
c.foot()


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "docs", "cards")
    os.makedirs(out, exist_ok=True)
    names = ["01-cover", "02-problem", "03-two-seats", "04-context-budget",
             "05-refusal", "06-live-pane", "07-fast-path", "08-model-says-no",
             "09-workflow-modes", "10-live-queue", "11-xhs-group"]
    for name, c in zip(names, CARDS):
        path = os.path.join(out, name + ".svg")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(c.render())
        print(f"  {path}")
    print(f"{len(CARDS)} cards, {W}x{H}")


if __name__ == "__main__":
    main()
