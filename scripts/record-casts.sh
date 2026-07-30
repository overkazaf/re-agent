#!/usr/bin/env bash
# Re-record the animated captures in docs/casts/, the way docs/shots/*.svg are
# re-made with capture-shot.py. Every cast below runs the real binary against a
# demo workspace with the offline `mock` provider, so this needs no API key, no
# network and no CLI login — what you see is what the tool actually prints.
#
#     make build && scripts/record-casts.sh
#
# The commit line in the boot panel is read at runtime, so record from a clean
# tree unless you want a `-dirty` marker in the picture.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -x ./bin/0xaf ] || { echo "build first: make build" >&2; exit 1; }

cap() { python3 scripts/capture-cast.py --cols 120 --rows 40 "$@"; }

rc="$(mktemp)"
trap 'rm -f "$rc"' EXIT
printf 'PS1="\\[\\033[38;2;74;165;240m\\]\\$\\[\\033[0m\\] "\nunset PROMPT_COMMAND\nHISTFILE=/dev/null\n' > "$rc"

# 1. The two commands from the quick start, in a plain shell: the offline wiring
#    check, then the boot panel for a real workspace.
cap --out docs/casts/quickstart.svg \
    --feed './bin/0xaf --smoke\n./bin/0xaf --workspace ./demos/reverse-lab\n' \
    --settle 1.2 --between 3.4 --timeout 11.5 --hold 2.2 \
    -- bash --noprofile --rcfile "$rc" -i

# 2. Direct tool triage with no model in the loop, across two demo artifacts.
cap --out docs/casts/scan.svg \
    --feed '/scan carrier.bin\n/scan artifact.txt\n' \
    --settle 1.8 --between 2.6 --timeout 10.5 --hold 2.2 \
    -- ./bin/0xaf --provider mock --workspace ./demos/reverse-lab

# 3. The command deck: the palette filtering as it is typed, then a palette
#    switch repainting the next output.
cap --out docs/casts/deck.svg \
    --feed '/theme\n/theme matrix\n/policy\n' \
    --settle 1.6 --between 2.4 --typing 0.10 --timeout 13 --hold 2.2 \
    -- ./bin/0xaf --provider mock --workspace ./demos/reverse-lab
