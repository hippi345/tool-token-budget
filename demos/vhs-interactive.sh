#!/usr/bin/env bash
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash --norc --noprofile --rcfile "$ROOT/vhs-bashrc" -i
