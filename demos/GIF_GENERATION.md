# Demo GIF Generation

## Current GIF

The committed `tool-token-budget-demo.gif` is produced via **VHS** (`vhs demos/tape.tape`) or **asciinema + agg** as a fallback.

**Specs:**
- 120 cols × 40 rows
- 1-second idle time limit
- ~47KB file size
- Shows full analyze → savings flow on `tools-bloated.json` fixture

## Regenerating the GIF

### Method 1: asciinema + agg (Used for Current GIF)

```bash
# Install
pip install --user asciinema
# Install agg from https://github.com/asciinema/agg or build from source

# Generate
bash demos/render-gif.sh
```

The `render-gif.sh` script:
1. Records `demos/demo.sh` with asciinema (120×40, 1s idle limit)
2. Renders to GIF with agg
3. Outputs `demos/tool-token-budget-demo.gif`

### Method 2: VHS (Alternative)

VHS is another option for high-quality terminal GIFs.

**Prerequisites:**
- Install VHS: `go install github.com/charmbracelet/vhs@latest`
- Install ttyd: https://github.com/tsl0922/ttyd

**Generate:**
```bash
cd demos
vhs tape.tape
```

### Method 3: Manual Recording

Use any screen recording tool:

1. Open a terminal with a clean prompt
2. Run `cd demos && bash demo.sh`
3. Record the session
4. Export as `tool-token-budget-demo.gif` (1200×700 recommended)
