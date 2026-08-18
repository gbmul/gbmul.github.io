/**
 * www/bot-pieces.js
 *
 * GB Tetris (NRS) — memory addresses, piece orientation table, and shape data.
 * Pure constants and lookup functions; no emulator dependency.
 */

// ── Memory addresses ──────────────────────────────────────────────────────────
export const ADDR_CUR_ORI   = 0xC203; // current piece orientation ID (0x00–0x1B)
export const ADDR_NEXT_ORI  = 0xC213; // C213: NOT reliable as a spawn signal — see note in bot.js
export const ADDR_RNG_PTR    = 0xFFB0; // low byte of the $C300 RNG buffer pointer (HRAM $FFAF:$FFB0).
                                       // NEXT_PIECE_SPAWN advances this by 2 on every spawn, regardless
                                       // of piece type or column → reliable spawn detector for same-type pieces.
export const ADDR_RNG_RESULT = 0xFFAE; // last RNG output; updated by DIV-RNG path at every spawn.
export const ADDR_C204      = 0xC204; // bit 7 = in-game flag

// ── Board geometry ────────────────────────────────────────────────────────────
export const BOARD_ROWS   = 18;
export const BOARD_COLS   = 10;

// 4 active-piece square coords: [Y_pixel_addr, X_pixel_addr]
export const SQ_ADDRS = [
  [0xC010, 0xC011],
  [0xC014, 0xC015],
  [0xC018, 0xC019],
  [0xC01C, 0xC01D],
];

// Board pixel → cell coordinate constants
export const PIX_X_OFF = 24; // pixel offset of column 0 left edge
export const PIX_Y_OFF = 16; // pixel offset of row 0 top edge
export const PIX_CELL  = 8;  // pixels per cell

// ── Piece orientation lookup ──────────────────────────────────────────────────
// Piece type indices: 0=I 1=O 2=T 3=S 4=Z 5=L 6=J
// Each piece owns 4 consecutive orientation IDs starting at spawnOri.
// CW rotation (A button) increments ori by 1, wrapping within the 4-ID block.
const ORI_TABLE = [
  { spawnOri: 0x00, typeIdx: 5 }, // L
  { spawnOri: 0x04, typeIdx: 6 }, // J
  { spawnOri: 0x08, typeIdx: 0 }, // I
  { spawnOri: 0x0C, typeIdx: 1 }, // O
  { spawnOri: 0x10, typeIdx: 4 }, // Z
  { spawnOri: 0x14, typeIdx: 3 }, // S
  { spawnOri: 0x18, typeIdx: 2 }, // T
];

/** Returns { typeIdx, rot } for a raw orientation ID, or null if unknown. */
export function oriInfo(ori) {
  for (const { spawnOri, typeIdx } of ORI_TABLE) {
    if (ori >= spawnOri && ori < spawnOri + 4) {
      return { typeIdx, rot: ori - spawnOri };
    }
  }
  return null;
}

// ── Piece names ──────────────────────────────────────────────────────────────
// PIECE_NAMES[typeIdx] = single-letter name (matches typeIdx order: I O T S Z L J)
export const PIECE_NAMES = ['I', 'O', 'T', 'S', 'Z', 'L', 'J'];

// ── NRS piece shapes ──────────────────────────────────────────────────────────
// SHAPES[typeIdx][rotation] = array of [dr, dc] cell offsets from bounding-box
// top-left (0,0).  minRow=0, minCol=0 for every entry (already normalised).
// I / S / Z are rotationally symmetric at 2 steps; O at 1 step.
export const SHAPES = [
  // 0: I
  [
    [[0,0],[0,1],[0,2],[0,3]],   // R0  ████
    [[0,0],[1,0],[2,0],[3,0]],   // R1  vertical
    [[0,0],[0,1],[0,2],[0,3]],   // R2 = R0
    [[0,0],[1,0],[2,0],[3,0]],   // R3 = R1
  ],
  // 1: O
  [
    [[0,0],[0,1],[1,0],[1,1]],   // R0–R3 all identical
    [[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[1,0],[1,1]],
  ],
  // 2: T
  [
    [[0,1],[1,0],[1,1],[1,2]],   // R0  .█.  / ███
    [[0,0],[1,0],[1,1],[2,0]],   // R1  █.  / ██  / █.
    [[0,0],[0,1],[0,2],[1,1]],   // R2  ███ / .█.
    [[0,1],[1,0],[1,1],[2,1]],   // R3  .█  / ██  / .█
  ],
  // 3: S
  [
    [[0,1],[0,2],[1,0],[1,1]],   // R0  .██ / ██.
    [[0,0],[1,0],[1,1],[2,1]],   // R1  █.  / ██  / .█
    [[0,1],[0,2],[1,0],[1,1]],   // R2 = R0
    [[0,0],[1,0],[1,1],[2,1]],   // R3 = R1
  ],
  // 4: Z
  [
    [[0,0],[0,1],[1,1],[1,2]],   // R0  ██. / .██
    [[0,1],[1,0],[1,1],[2,0]],   // R1  .█  / ██  / █.
    [[0,0],[0,1],[1,1],[1,2]],   // R2 = R0
    [[0,1],[1,0],[1,1],[2,0]],   // R3 = R1
  ],
  // 5: L
  [
    [[0,2],[1,0],[1,1],[1,2]],   // R0  ..█ / ███  (spawn)
    [[0,0],[1,0],[2,0],[2,1]],   // R1  █.  / █.  / ██
    [[0,0],[0,1],[0,2],[1,0]],   // R2  ███ / █..
    [[0,0],[0,1],[1,1],[2,1]],   // R3  ██  / .█  / .█
  ],
  // 6: J
  [
    [[0,0],[1,0],[1,1],[1,2]],   // R0  █.. / ███  (spawn)
    [[0,0],[0,1],[1,0],[2,0]],   // R1  ██  / █.  / █.
    [[0,0],[0,1],[0,2],[1,2]],   // R2  ███ / ..█
    [[0,1],[1,1],[2,0],[2,1]],   // R3  .█  / .█  / ██
  ],
];
