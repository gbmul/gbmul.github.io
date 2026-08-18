# GBmul

Game Boy emulator in the browser — play Tetris with keyboard, touch, or an AI bot.

Built with [gbmul-core](https://github.com/gbmul/gbmul-core) (Rust → WASM).

## Quick start

```sh
# Clone both repos
git clone https://github.com/gbmul/gbmul-core.git
git clone https://github.com/gbmul/gbmul.github.io.git

# Build WASM from the core repo
cd gbmul.github.io
./build-wasm.sh

# Serve locally (WASM requires HTTP)
python3 -m http.server 8080
```

Then open `http://localhost:8080`, load a Tetris ROM, and play.

## Features

- Game Boy emulation via Rust → WASM
- Keyboard and touch controls
- Save / load states
- Colour palettes and display shaders
- Dark / light / auto theme
- PWA — installable on mobile
- **HybridBot** — AI bot that plays GB Tetris autonomously
- **2-Player** — local link cable mode vs the bot
- **WebGBLink** — play online via peer-to-peer link cable

## Controls

| Key | Action |
|-----|--------|
| Arrow keys | D-pad |
| Z / X | B / A |
| Enter | Start |
| Shift | Select |

## Related

- [gbmul-core](https://github.com/gbmul/gbmul-core) — Rust emulator engine