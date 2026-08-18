/**
 * www/bot-board.js
 *
 * GB Tetris (NRS) — board reading and bitboard utilities.
 * Reads WRAM into a compact Uint16Array(18) bitboard and derives column heights.
 */

import { BOARD_ROWS, BOARD_COLS } from './bot-pieces.js';

// ── Board WRAM layout ─────────────────────────────────────────────────────────
export const BOARD_BASE   = 0xC800;
export const BOARD_STRIDE = 32; // bytes per board row in WRAM

// ── Bitwise helpers ───────────────────────────────────────────────────────────
export function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

// ── Board helpers ─────────────────────────────────────────────────────────────

/** Returns true for a locked-piece tile (0x80–0x8F, excluding wall 0x8E) or garbage tile (0x28). */
function isOccupied(v) {
  return ((v & 0xF0) === 0x80 && v !== 0x8E) || v === 0x28;
}

/**
 * Read the playfield into a Uint16Array(18).
 * Bit j of row i = 1 when column j is occupied by a locked piece.
 */
export function readBitboard(emu) {
  const raw = emu.read_mem_range(BOARD_BASE, BOARD_ROWS * BOARD_STRIDE);
  const bb  = new Uint16Array(BOARD_ROWS);
  for (let row = 0; row < BOARD_ROWS; row++) {
    const base = row * BOARD_STRIDE + 2; // skip left-wall byte + 1
    let bits = 0;
    for (let col = 0; col < BOARD_COLS; col++) {
      if (isOccupied(raw[base + col])) bits |= (1 << col);
    }
    bb[row] = bits;
  }
  return bb;
}

/**
 * Compute column heights from a bitboard.
 * height[col] = number of filled cells measured from the bottom
 *             = 0 if the column is empty.
 */
export function columnHeights(bb) {
  const h = new Array(BOARD_COLS).fill(0);
  for (let col = 0; col < BOARD_COLS; col++) {
    for (let row = 0; row < BOARD_ROWS; row++) {
      if (bb[row] & (1 << col)) { h[col] = BOARD_ROWS - row; break; }
    }
  }
  return h;
}
