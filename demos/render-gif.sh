#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
GIF="$ROOT/demos/tool-token-budget-demo.gif"

cd "$ROOT"
npm run build

if command -v vhs >/dev/null 2>&1; then
  vhs demos/tape.tape
  ls -lh "$GIF"
  exit 0
fi

# Fallback: asciinema + agg (see demos/GIF_GENERATION.md)
CAST="$ROOT/demos/tool-token-budget-demo.cast"
if command -v asciinema >/dev/null 2>&1; then
  RECORDER="$(command -v asciinema)"
else
  RECORDER="$HOME/.local/bin/asciinema"
fi
if command -v agg >/dev/null 2>&1; then
  RENDERER="$(command -v agg)"
else
  RENDERER="$HOME/go/bin/agg"
fi
[[ -x "$RECORDER" ]] || { echo "missing vhs and asciinema; install vhs from charmbracelet/vhs" >&2; exit 2; }
[[ -x "$RENDERER" ]] || { echo "missing agg renderer" >&2; exit 2; }

rm -f "$CAST" "$GIF"
"$RECORDER" rec --overwrite --cols 120 --rows 40 --idle-time-limit 1 -c "bash $ROOT/demos/demo.sh" "$CAST"
"$RENDERER" "$CAST" "$GIF"
ls -lh "$GIF"
