#!/usr/bin/env bash
# Sourced by VHS tape (hidden): demos cwd + tool-token-budget alias.
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/demos"
alias tool-token-budget="node ../dist/cli.js"
