#!/usr/bin/env bash
set -euo pipefail

# Build WASM from the sibling gbmul-core repo for local development.
# Usage:  ./build-wasm.sh
# Prereq: gbmul-core is cloned next to this repo at ../gbmul-core

WASM_DIR="../gbmul-core/gbmul-wasm"
OUT_DIR="pkg"

if [ ! -d "$WASM_DIR" ]; then
  echo "Error: $WASM_DIR not found."
  echo "Clone gbmul-core next to this repo:"
  echo "  git clone git@github.com:gbmul/gbmul-core.git ../gbmul-core"
  exit 1
fi

wasm-pack build "$WASM_DIR" --out-dir "$(pwd)/$OUT_DIR" --target web
echo "Done — WASM built into $OUT_DIR/"