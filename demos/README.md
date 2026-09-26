# Tool Token Budget Demo

This directory contains a demo script showing `tool-token-budget` in action.

## Running the Demo

```bash
cd demos
bash demo.sh
```

The demo:
1. Analyzes a bloated fixture with 5 tools (~3550 tokens estimate)
2. Emits proposals keeping only 2 cheapest tools hot
3. Shows savings: ~99% token reduction (3550 → 31 tokens estimate)
4. Lists which tools should be deferred

## Creating a GIF/Recording

To create a visual demo for the README:

**Option 1: VHS (recommended)**
```bash
npm run build
vhs demos/tape.tape
```

**Option 2: Using asciinema (if available)**
```bash
bash demos/render-gif.sh
```

The demo output is saved in `demo-output.txt` for reference.
