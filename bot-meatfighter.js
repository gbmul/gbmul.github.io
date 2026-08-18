/**
 * www/bot-meatfighter.js
 *
 * MeatfighterBot — 2-ply BFS lookahead with tuck & spin support.
 * Inspired by https://meatfighter.com/nintendotetrisai/
 *
 * Public API:
 *   export class MeatfighterBot extends TetrisBot
 */

import {
  ADDR_CUR_ORI, ADDR_NEXT_ORI, ADDR_C204,
  BOARD_ROWS, BOARD_COLS,
  SHAPES, oriInfo, PIECE_NAMES,
} from './bot-pieces.js';

import { readBitboard, columnHeights } from './bot-board.js';

import { TetrisBot, S, isReachable } from './bot.js';

// ── BFS move generator ────────────────────────────────────────────────────────

/**
 * Returns true if the piece (typeIdx, rot) placed at (row, col) overlaps any
 * occupied cell, or is out of bounds.  Row may be negative (piece above board).
 */
function pieceCollides(bb, typeIdx, rot, row, col) {
  for (const [dr, dc] of SHAPES[typeIdx][rot]) {
    const r = row + dr;
    const c = col + dc;
    if (c < 0 || c >= BOARD_COLS) return true;
    if (r >= BOARD_ROWS) return true;
    if (r >= 0 && (bb[r] & (1 << c))) return true;
  }
  return false;
}

/**
 * BFS over the (row, col, rot) state space for one piece on one board.
 *
 * Returns a Map keyed by "row,col,rot" → { row, col, rot, path: string[] }
 * for every reachable locked state (= state where moving down would collide).
 *
 * Moves considered: L, R, D (soft-drop one row), CW (A), CCW (B).
 * A state is locked when D causes a collision from the current position.
 *
 * @param {Uint16Array} bb        - board bitboard
 * @param {number}      typeIdx   - piece type (0–6)
 * @param {number}      spawnRow  - row where the piece spawns (typically 0)
 * @param {number}      spawnCol  - leftmost col at spawn (typically 3)
 * @param {number}      spawnRot  - rotation at spawn (typically 0)
 * @returns {Map<string, {row:number, col:number, rot:number, path:string[]}>}
 */
// Real GB Tetris has NO real lock delay: a piece locks the instant the game's own
// periodic gravity tick finds it unable to move down — that tick fires on its own
// clock regardless of what the bot is doing. The BFS below explores the (row, col,
// rot) state space as if lock delay were infinite (see meatfighterBot.md), which
// lets it find "spins"/"tucks" that require moving the piece *after* it is already
// grounded. Those are only really executable if the bot can finish the remaining
// taps before the next gravity tick fires — and each tap costs the bot ~2 emulator
// frames (see FRAME_DELAY in bot.js). Long chains of actions performed while the
// piece is (repeatedly) grounded are exactly the moves that come back as
// "impossible" in-game: the BFS finds them in its infinite-time model, but real
// hardware locks the piece out from under the bot before it finishes the sequence.
//
// MAX_GROUNDED_RUN caps how many consecutive actions may be chained while the
// piece is grounded (i.e. while a straight drop is unavailable) before BFS stops
// exploring further from that branch. This still allows the common, fast case —
// a single rotate/slide performed right as the piece lands (classic spin/tuck) —
// while pruning long multi-step maneuvers that are very unlikely to complete
// before the real engine locks the piece out from under the bot.
const MAX_GROUNDED_RUN = 2;

export function bfsMoves(bb, typeIdx, spawnRow, spawnCol, spawnRot) {
  // visited[row][col][rot] = true once enqueued
  // pred[row][col][rot]    = { action, row, col, rot } of parent state, or null for spawn
  const visited = Array.from({length: BOARD_ROWS}, () =>
    Array.from({length: BOARD_COLS}, () => new Uint8Array(4))
  );
  const pred = Array.from({length: BOARD_ROWS}, () =>
    Array.from({length: BOARD_COLS}, () => new Array(4).fill(null))
  );
  // groundedRun[row][col][rot] = number of consecutive moves (ending at this
  // state) made while the piece could not move straight down. 0 once the
  // piece is able to fall further again.
  const groundedRun = Array.from({length: BOARD_ROWS}, () =>
    Array.from({length: BOARD_COLS}, () => new Uint8Array(4))
  );

  const locked = new Map();

  // Verify spawn is valid
  if (pieceCollides(bb, typeIdx, spawnRot, spawnRow, spawnCol)) return locked;

  const queue = [];
  visited[spawnRow][spawnCol][spawnRot] = 1;
  queue.push([spawnRow, spawnCol, spawnRot]);

  let head = 0;
  while (head < queue.length) {
    const [r, c, rot] = queue[head++];
    const run = groundedRun[r][c][rot];

    // Check if this state is locked (D causes collision)
    const canDown = !pieceCollides(bb, typeIdx, rot, r + 1, c);

    if (!canDown) {
      // Reconstruct path
      const path = [];
      let pr = r, pc = c, prot = rot;
      while (pred[pr][pc][prot] !== null) {
        const p = pred[pr][pc][prot];
        path.push(p.action);
        [pr, pc, prot] = [p.fromRow, p.fromCol, p.fromRot];
      }
      path.reverse();
      locked.set(`${r},${c},${rot}`, { row: r, col: c, rot, path });
      // Still expand this state for slides/spins, but only up to
      // MAX_GROUNDED_RUN consecutive grounded actions — see comment above.
      if (run >= MAX_GROUNDED_RUN) continue;
    }

    // Generate successors
    const moves = [
      ['D',   r + 1, c,     rot          ],
      ['L',   r,     c - 1, rot          ],
      ['R',   r,     c + 1, rot          ],
      ['CW',  r,     c,     (rot + 1) % 4],
      ['CCW', r,     c,     (rot + 3) % 4],
    ];

    for (const [action, nr, nc, nrot] of moves) {
      if (nr < 0 || nr >= BOARD_ROWS || nc < 0 || nc >= BOARD_COLS) continue;

      // Rotations (CW/CCW):
      //
      // Non-grounded source: allow only when the successor is also non-grounded.
      // When the successor would be grounded, the NRS rotation anchor shifts the
      // piece vertically by an amount the BFS doesn't model — postRotSync would
      // need to correct it, but there is no time/room left to do so.
      //
      // Grounded source ("final spin"): allow ONE rotation using the T-piece's
      // real GB Tetris center-pivot, which shifts the destination by (dr, dc)
      // relative to the source bounding-box position.  The shifted destination
      // is checked for validity directly; if valid it is added as a locked state
      // with groundedRun = MAX so no further exploration happens from there.
      // postRotSync detects that the path is already complete after the rotation
      // and skips the usual col/row compensation.
      //
      // NOTE: visited/collision checks are skipped here for the grounded case
      // because the center-pivot may move the piece to a DIFFERENT (row, col)
      // than (nr, nc) — the standard position check would use the wrong location.
      // Translations (L/R) from any state are always fine.
      if (action === 'CW' || action === 'CCW') {
        if (!canDown) {
          // ── Final spin from grounded state ─────────────────────────────
          if (run >= MAX_GROUNDED_RUN) continue;

          // Center-pivot offsets [deltaRow, deltaCol] for the T-piece (typeIdx 2).
          // Derived from keeping the T's center cell fixed during rotation.
          // CW:  rot 0→1: (0,+1)  1→2: (+1,−1)  2→3: (−1, 0)  3→0: (0, 0)
          // CCW: rot 0→3: (0, 0)  1→0: (0,−1)   2→1: (−1,+1)  3→2: (+1, 0)
          const T_CW_OFFSET  = [[0,1],[1,-1],[-1,0],[0, 0]]; // indexed by fromRot
          const T_CCW_OFFSET = [[0,0],[0,-1],[-1,1],[1, 0]];

          let destRow = r, destCol = c; // default: same bounding-box position
          if (typeIdx === 2) {          // T-piece: use center-pivot
            const off = action === 'CW' ? T_CW_OFFSET[rot] : T_CCW_OFFSET[rot];
            destRow = r + off[0];
            destCol = c + off[1];
          }

          if (destRow < 0 || destRow >= BOARD_ROWS) continue;
          if (destCol < 0 || destCol >= BOARD_COLS) continue;
          if (visited[destRow][destCol][nrot]) continue;
          if (pieceCollides(bb, typeIdx, nrot, destRow, destCol)) continue;

          visited[destRow][destCol][nrot] = 1;
          pred[destRow][destCol][nrot] = { action, fromRow: r, fromCol: c, fromRot: rot };
          groundedRun[destRow][destCol][nrot] = MAX_GROUNDED_RUN; // no further exploration
          queue.push([destRow, destCol, nrot]);
          continue; // handled — skip normal processing below
        }
        // ── Non-grounded source: only allow if successor is also non-grounded ──
        if (visited[nr][nc][nrot]) continue;
        if (pieceCollides(bb, typeIdx, nrot, nr, nc)) continue;
        const successorIsGrounded = pieceCollides(bb, typeIdx, nrot, nr + 1, nc);
        if (successorIsGrounded) continue;
      } else {
        // D / L / R: standard visited + collision checks
        if (visited[nr][nc][nrot]) continue;
        if (pieceCollides(bb, typeIdx, nrot, nr, nc)) continue;
      }

      visited[nr][nc][nrot] = 1;
      pred[nr][nc][nrot] = { action, fromRow: r, fromCol: c, fromRot: rot };
      // canDown = true  → current state is NOT grounded → successor starts fresh (run 0)
      // canDown = false → current state IS grounded    → successor continues the chain
      groundedRun[nr][nc][nrot] = canDown ? 0 : run + 1;
      queue.push([nr, nc, nrot]);
    }
  }

  return locked;
}

// ── MeatfighterBot ────────────────────────────────────────────────────────────
// Inspired by https://meatfighter.com/nintendotetrisai/
//
// Evaluation function: lower raw score = better.  Weighted sum of:
//   Lines cleared       ×  1.000  (adverse — conservative survival play)
//   Total lock height   × 12.885  (keep pieces low)
//   Total well cells    × 15.843  (avoid open-topped sealed columns)
//   Total column holes  × 26.894  (avoid empty cells under solid cells)
//   Column transitions  × 27.617  (prefer densely packed columns)
//   Row transitions     × 30.185  (prefer densely packed rows)
//
// Weights from PSO-tuned Java version (Islam El-Ashi / meatfighter.com).
//
// Search: 2-ply lookahead — evaluates all placements of piece 1 × all
// placements of piece 2 (next piece read from ADDR_NEXT_ORI).  The board
// is evaluated once after BOTH pieces are placed; totals for clears and
// lock height accumulate across the two drops.  Falls back to 1-ply when
// the next-piece register is unreadable.

/**
 * Meatfighter evaluation function.
 * @param {Uint16Array} bb            — post-placement board bitboard
 * @param {number[]}    heights       — column heights
 * @param {number}      totalClears   — total lines cleared (may span 2 pieces)
 * @param {number}      totalLockH    — sum of lock heights of placed pieces
 * @returns {number} higher = better (negated raw score)
 */
function meatfighterEvaluate(bb, heights, totalClears, totalLockH) {
  let wellCells = 0, colHoles = 0, colTrans = 0, rowTrans = 0;

  // ── Row transitions (walls treated as solid) ─────────────────────────────
  for (let r = 0; r < BOARD_ROWS; r++) {
    if (bb[r] === 0) continue; // completely empty rows are skipped
    let prev = 1; // left wall = solid
    for (let c = 0; c < BOARD_COLS; c++) {
      const cur = (bb[r] >> c) & 1;
      if (cur !== prev) rowTrans++;
      prev = cur;
    }
    if (prev === 0) rowTrans++; // right wall transition
  }

  // ── Per-column metrics ────────────────────────────────────────────────────
  for (let c = 0; c < BOARD_COLS; c++) {
    const h = heights[c];
    if (h === 0) continue;
    const topRow = BOARD_ROWS - h; // index of the highest filled cell

    // Column transitions: count filled↔empty changes from topRow down.
    // The surface transition (empty above → first solid) is suppressed by
    // starting prevFilled=true; the floor comparison is never made.
    let prevFilled = true;
    for (let r = topRow; r < BOARD_ROWS; r++) {
      const filled = !!((bb[r] >> c) & 1);
      if (filled !== prevFilled) colTrans++;
      prevFilled = filled;
    }

    // Column holes: empty cells with at least one solid cell above them.
    let foundFilled = false;
    for (let r = topRow; r < BOARD_ROWS; r++) {
      const filled = !!((bb[r] >> c) & 1);
      if (filled) { foundFilled = true; }
      else if (foundFilled) { colHoles++; }
    }

    // Well cells: empty cells above the column surface whose left AND right
    // neighbours (or playfield walls) are solid at the same row.
    for (let r = 0; r < topRow; r++) {
      const leftSolid  = c === 0            ? true : !!((bb[r] >> (c - 1)) & 1);
      const rightSolid = c === BOARD_COLS-1 ? true : !!((bb[r] >> (c + 1)) & 1);
      if (leftSolid && rightSolid) wellCells++;
    }
  }

  const rawScore = totalClears  * 1.000000000000000
                 + totalLockH   * 12.885008263218383
                 + wellCells    * 15.842707182438396
                 + colHoles     * 26.894496507795950
                 + colTrans     * 27.616914062397015
                 + rowTrans     * 30.185110719279040;

  return -rawScore; // negate: lower raw = better = higher return value
}

/** 1-ply wrapper matching the (bb, heights, clears, landRow) evaluateFn signature. */
function meatfighterEvaluate1ply(bb, heights, clears, landRow) {
  // Approximate lock height as distance from landRow to the floor.
  // Slightly overestimates (ignores piece height) but is consistent.
  return meatfighterEvaluate(bb, heights, clears, BOARD_ROWS - 1 - landRow);
}

/**
 * 2-ply move search: try all placements of the current piece, then all
 * placements of the next piece, evaluate the combined board once.
 *
 * @param {object} emu          — emulator proxy
 * @param {number} nextTypeIdx  — piece type index of the next piece (0–6)
 * @returns {{ rot, leftCol } | null}
 */
function findBestMove2ply(emu, nextTypeIdx) {
  const bb = readBitboard(emu);
  const ori = emu.read_mem(ADDR_CUR_ORI);
  const info = oriInfo(ori);
  if (!info) return null;

  const FULL_ROW  = (1 << BOARD_COLS) - 1;
  const SPAWN_COL = 3;

  let bestScore = -Infinity, bestMove = null;

  // ── Outer loop: all placements of the current piece ───────────────────────
  for (let rot1 = 0; rot1 < 4; rot1++) {
    const shape1  = SHAPES[info.typeIdx][rot1];
    const maxDC1  = Math.max(...shape1.map(([, c]) => c));
    const maxDR1  = Math.max(...shape1.map(([r])   => r));
    const maxCol1 = BOARD_COLS - 1 - maxDC1;

    for (let col1 = 0; col1 <= maxCol1; col1++) {
      if (!isReachable(bb, shape1, SPAWN_COL, col1)) continue;

      // Gravity: find landing row for piece 1
      let land1 = -1;
      land1Loop: for (let sr = 0; sr <= BOARD_ROWS - 1 - maxDR1; sr++) {
        for (const [dr, dc] of shape1) {
          if (bb[sr + dr] & (1 << (col1 + dc))) { land1 = sr - 1; break land1Loop; }
        }
        land1 = sr;
      }
      if (land1 < 0) continue;

      // Build board after piece 1 + clear lines
      const bb1 = new Uint16Array(bb);
      for (const [dr, dc] of shape1) {
        const r = land1 + dr;
        if (r >= 0 && r < BOARD_ROWS) bb1[r] |= (1 << (col1 + dc));
      }
      let clears1 = 0;
      const kept1 = [];
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (bb1[r] === FULL_ROW) clears1++;
        else kept1.push(bb1[r]);
      }
      if (clears1 > 0) {
        const cleared = new Uint16Array(BOARD_ROWS);
        for (let i = 0; i < kept1.length; i++) cleared[BOARD_ROWS - kept1.length + i] = kept1[i];
        bb1.set(cleared);
      }

      const lockH1 = BOARD_ROWS - 1 - (land1 + maxDR1);
      let bestInner = -Infinity;

      // ── Inner loop: all placements of the next piece ──────────────────────
      for (let rot2 = 0; rot2 < 4; rot2++) {
        const shape2  = SHAPES[nextTypeIdx][rot2];
        const maxDC2  = Math.max(...shape2.map(([, c]) => c));
        const maxDR2  = Math.max(...shape2.map(([r])   => r));
        const maxCol2 = BOARD_COLS - 1 - maxDC2;

        for (let col2 = 0; col2 <= maxCol2; col2++) {
          if (!isReachable(bb1, shape2, SPAWN_COL, col2)) continue;

          let land2 = -1;
          land2Loop: for (let sr = 0; sr <= BOARD_ROWS - 1 - maxDR2; sr++) {
            for (const [dr, dc] of shape2) {
              if (bb1[sr + dr] & (1 << (col2 + dc))) { land2 = sr - 1; break land2Loop; }
            }
            land2 = sr;
          }
          if (land2 < 0) continue;

          // Build board after piece 2 + clear lines
          const bb2 = new Uint16Array(bb1);
          for (const [dr, dc] of shape2) {
            const r = land2 + dr;
            if (r >= 0 && r < BOARD_ROWS) bb2[r] |= (1 << (col2 + dc));
          }
          let clears2 = 0;
          const kept2 = [];
          for (let r = 0; r < BOARD_ROWS; r++) {
            if (bb2[r] === FULL_ROW) clears2++;
            else kept2.push(bb2[r]);
          }
          if (clears2 > 0) {
            const cleared2 = new Uint16Array(BOARD_ROWS);
            for (let i = 0; i < kept2.length; i++) cleared2[BOARD_ROWS - kept2.length + i] = kept2[i];
            bb2.set(cleared2);
          }

          const lockH2 = BOARD_ROWS - 1 - (land2 + maxDR2);
          const h2     = columnHeights(bb2);
          const score  = meatfighterEvaluate(bb2, h2, clears1 + clears2, lockH1 + lockH2);
          if (score > bestInner) bestInner = score;
        }
      }

      if (bestInner > bestScore) {
        bestScore = bestInner;
        bestMove  = { rot: rot1, leftCol: col1 };
      }
    }
  }

  return bestMove;
}

/**
 * 2-ply move search using BFS to find all reachable locked states, including
 * tucks and spins.
 *
 * For each locked state of piece 1, runs BFS on the resulting board to find
 * all locked states of piece 2, then evaluates the combined board.
 *
 * Returns { rot, leftCol, path } for the best piece-1 placement.
 * `path` is an array of actions (['L','R','D','CW','CCW']) to execute.
 *
 * @param {object} emu          — emulator proxy
 * @param {number} nextTypeIdx  — piece type index of the next piece (0–6)
 * @param {number} spawnCol     — actual leftmost column of the piece from WRAM
 * @param {number} [spawnRow=0] — BFS spawn row (clamped ≥ 0; caller prepends extra D moves for negative spawn)
 * @returns {{ rot, leftCol, path: string[] } | null}
 */
function findBestMoveWithBFS(emu, nextTypeIdx, spawnCol, spawnRow = 0) {
  const bb   = readBitboard(emu);
  const ori  = emu.read_mem(ADDR_CUR_ORI);
  const info = oriInfo(ori);
  if (!info) return null;

  const FULL_ROW  = (1 << BOARD_COLS) - 1;
  const SPAWN_ROW = spawnRow;

  // BFS for all locked states of piece 1
  const moves1 = bfsMoves(bb, info.typeIdx, SPAWN_ROW, spawnCol, info.rot);

  let bestScore = -Infinity, bestMove = null;

  for (const { row: row1, col: col1, rot: rot1, path: path1 } of moves1.values()) {
    const shape1 = SHAPES[info.typeIdx][rot1];

    // Build board after piece 1
    const bb1 = new Uint16Array(bb);
    for (const [dr, dc] of shape1) {
      const r = row1 + dr;
      if (r >= 0 && r < BOARD_ROWS) bb1[r] |= (1 << (col1 + dc));
    }

    // Clear full lines
    let clears1 = 0;
    const kept1 = [];
    for (let r = 0; r < BOARD_ROWS; r++) {
      if (bb1[r] === FULL_ROW) clears1++;
      else kept1.push(bb1[r]);
    }
    if (clears1 > 0) {
      const cleared = new Uint16Array(BOARD_ROWS);
      for (let i = 0; i < kept1.length; i++) cleared[BOARD_ROWS - kept1.length + i] = kept1[i];
      bb1.set(cleared);
    }

    // Lock height for piece 1: distance from lowest cell to floor
    const maxDR1  = Math.max(...shape1.map(([r]) => r));
    const lockH1  = BOARD_ROWS - 1 - (row1 + maxDR1);

    // BFS for all locked states of piece 2 (always spawns at centre col 3)
    const moves2 = bfsMoves(bb1, nextTypeIdx, SPAWN_ROW, 3, 0);

    let bestInner = -Infinity;
    for (const { row: row2, col: col2, rot: rot2 } of moves2.values()) {
      const shape2 = SHAPES[nextTypeIdx][rot2];

      const bb2 = new Uint16Array(bb1);
      for (const [dr, dc] of shape2) {
        const r = row2 + dr;
        if (r >= 0 && r < BOARD_ROWS) bb2[r] |= (1 << (col2 + dc));
      }

      let clears2 = 0;
      const kept2 = [];
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (bb2[r] === FULL_ROW) clears2++;
        else kept2.push(bb2[r]);
      }
      if (clears2 > 0) {
        const cleared2 = new Uint16Array(BOARD_ROWS);
        for (let i = 0; i < kept2.length; i++) cleared2[BOARD_ROWS - kept2.length + i] = kept2[i];
        bb2.set(cleared2);
      }

      const maxDR2 = Math.max(...shape2.map(([r]) => r));
      const lockH2 = BOARD_ROWS - 1 - (row2 + maxDR2);
      const h2     = columnHeights(bb2);
      const score  = meatfighterEvaluate(bb2, h2, clears1 + clears2, lockH1 + lockH2);
      if (score > bestInner) bestInner = score;
    }

    if (bestInner > -Infinity) {
      // ── T-spin bonus (testing) ───────────────────────────────────────────
      // A T-spin: T-piece (typeIdx 2), lines cleared, last BFS action is a rotation.
      const lastAction1 = path1.length > 0 ? path1[path1.length - 1] : '';
      const isTspin = info.typeIdx === 2
                   && clears1 > 0
                   && (lastAction1 === 'CW' || lastAction1 === 'CCW');
      if (isTspin) {
        bestInner += 50000;
        console.info(`[meatfighter] T-spin! col=${col1} rot=${rot1} clears=${clears1} path=[${path1.join(',')}]`);
      }
    }

    if (bestInner > bestScore) {
      bestScore = bestInner;
      bestMove  = { rot: rot1, leftCol: col1, row: row1, path: path1, moveType: classifyMove(bb, info.typeIdx, row1, col1, rot1, path1, clears1) };
    }
  }

  return bestMove;
}

/**
 * 1-ply BFS move search.  Used for replans (piece mid-travel) in MeatfighterBot.
 * Returns { rot, leftCol, path }.
 *
 * @param {object} emu
 * @param {number} [fromRow=0]  — BFS spawn row (must be ≥ 0; caller handles negative spawn offset)
 * @param {number} [fromCol=3]  — current piece leftmost col
 * @param {number} [fromRot]    — current piece rotation (default from ADDR_CUR_ORI)
 */
function findBestMoveWithBFS1ply(emu, fromRow, fromCol, fromRot) {
  const bb   = readBitboard(emu);
  const ori  = emu.read_mem(ADDR_CUR_ORI);
  const info = oriInfo(ori);
  if (!info) return null;

  const FULL_ROW = (1 << BOARD_COLS) - 1;
  const spawnRow = (fromRow !== undefined && fromRow >= 0) ? fromRow : 0;
  const spawnCol = fromCol !== undefined ? fromCol : 3;
  const spawnRot = fromRot !== undefined ? fromRot : info.rot;

  const moves = bfsMoves(bb, info.typeIdx, spawnRow, spawnCol, spawnRot);

  let bestScore = -Infinity, bestMove = null;
  for (const { row, col, rot, path } of moves.values()) {
    const shape = SHAPES[info.typeIdx][rot];
    const bb2   = new Uint16Array(bb);
    for (const [dr, dc] of shape) {
      const r = row + dr;
      if (r >= 0 && r < BOARD_ROWS) bb2[r] |= (1 << (col + dc));
    }
    let clears = 0;
    const kept = [];
    for (let r = 0; r < BOARD_ROWS; r++) {
      if (bb2[r] === FULL_ROW) clears++;
      else kept.push(bb2[r]);
    }
    if (clears > 0) {
      const cleared = new Uint16Array(BOARD_ROWS);
      for (let i = 0; i < kept.length; i++) cleared[BOARD_ROWS - kept.length + i] = kept[i];
      bb2.set(cleared);
    }
    const maxDR  = Math.max(...shape.map(([r]) => r));
    const lockH  = BOARD_ROWS - 1 - (row + maxDR);
    const h2     = columnHeights(bb2);
    const score  = meatfighterEvaluate(bb2, h2, clears, lockH);
    if (score > bestScore) {
      bestScore = score;
      bestMove  = { rot, leftCol: col, row, path, moveType: classifyMove(bb, info.typeIdx, row, col, rot, path, clears) };
    }
  }
  return bestMove;
}

/**
 * Classify a placement as 'tspin', 'spin', 'tuck', or 'normal'.
 *
 * - spin/tspin : last BFS action was a rotation AND the position one row above
 *                is blocked (piece was rotated into a slot it can't fall into).
 * - tuck       : gravity-drop of (rot, col) from the top would NOT land at row
 *                (an overhang blocks the straight path down).
 * - normal     : everything else.
 *
 * @param {Uint16Array} bb       - board bitboard (before placement)
 * @param {number}      typeIdx  - piece type index (2 = T)
 * @param {number}      row      - BFS locked row
 * @param {number}      col      - BFS locked leftmost col
 * @param {number}      rot      - BFS locked rotation
 * @param {string[]}    path     - BFS action array
 * @param {number}      [clears] - lines cleared (used to distinguish tspin)
 */
function classifyMove(bb, typeIdx, row, col, rot, path, clears = 0) {
  const lastAction = path.length > 0 ? path[path.length - 1] : '';
  const isRotEnd   = lastAction === 'CW' || lastAction === 'CCW';

  // Spin: rotated into a position that can't be entered from above
  if (isRotEnd && pieceCollides(bb, typeIdx, rot, row - 1, col)) {
    return (typeIdx === 2 && clears > 0) ? 'tspin' : 'spin';
  }

  // Tuck: pure gravity drop at (col, rot) would land somewhere other than row
  let gravRow = 0;
  while (!pieceCollides(bb, typeIdx, rot, gravRow + 1, col)) gravRow++;
  if (gravRow !== row) return 'tuck';

  return 'normal';
}

/**
 * MeatfighterBot — 2-ply BFS lookahead with tuck & spin support.
 *
 * Uses a full BFS over the (row, col, rot) state space to find all reachable
 * locked positions, including tucks (slide under overhangs) and spins
 * (rotate into tight spaces).  Pieces are executed step-by-step via a path
 * returned by the BFS rather than the base-class rotate+translate fast path.
 *
 * Strategy: 2-ply BFS with PSO-tuned meatfighter evaluation.
 * Falls back to 1-ply BFS when the next piece is unknown.
 * Replans with 1-ply BFS from the current (row, col, rot) if the piece
 * deviates from the planned path mid-execution.
 */
export class MeatfighterBot extends TetrisBot {
  constructor() {
    super();
    window._bot = this;
    this._meatMode        = '2ply-bfs';
    this._movePath        = [];   // BFS action sequence: ['L','R','D','CW','CCW',…]
    this._pathStep        = 0;    // index of the next action to execute
    this._pathExpectedRow = 0;    // piece minRow we expect before pathStep
    this._pathExpectedCol = 3;    // piece leftCol we expect before pathStep
    this._pathExpectedRot = 0;    // piece rot we expect before pathStep
    this._planPending     = false; // true: new piece detected, wait 1 frame for pixel stability
    this._planPendingOri  = -1;   // ori of the pending piece
    this._intendedLock    = null; // { row, col, rot } from the last plan
    this._planIntendedRow = 0;   // BFS target row frozen at plan time (≠ _pathExpectedRow which SRS kicks overwrite)
    this._pieceCount      = 0;    // pieces placed this game (1-based)
    this._lastLockTime    = null; // performance.now() at last lock
    this._rowWaitCount    = 0;    // consecutive frames spent waiting for piece to reach expected row
    this._colDriftCount   = 0;    // consecutive path-complete col-drift compensation attempts
  }

  reset(emu) {
    super.reset(emu);
    this._meatMode        = '2ply-bfs';
    this._movePath        = [];
    this._pathStep        = 0;
    this._pathExpectedRow = 0;
    this._pathExpectedCol = 3;
    this._pathExpectedRot = 0;
    this._postRotSync     = false;
    this._planPending     = false;
    this._planPendingOri  = -1;
    this._intendedLock    = null;
    this._planIntendedRow = 0;
    this._pieceCount      = 0;
    this._lastLockTime    = null;
    this._rowWaitCount    = 0;
    this._colDriftCount   = 0;
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  /**
   * Override tick() to insert the 'path' state before the base-class switch.
   */
  tick(emu, gameState) {
    if (this._pendingRelease >= 0) {
      emu.key_up(this._pendingRelease);
      this._pendingRelease = -1;
    }

    if (gameState === 'paused' || gameState === 'win') {
      this._statusMsg = gameState === 'win' ? 'type-b win (idle)' : 'paused';
      return;
    }
    if (gameState !== 'in-game') {
      // Clear any stale path state when leaving the game (ROM reload, game-over, etc.)
      this._state       = S.IDLE;
      this._movePath    = [];
      this._pathStep    = 0;
      this._postRotSync = false;
      this._handleNav(emu, gameState);
      return;
    }
    if ((emu.read_mem(ADDR_C204) & 0x80) === 0) return;
    if (this._frameDelay > 0) { this._frameDelay--; return; }

    const ori = emu.read_mem(ADDR_CUR_ORI);

    if (this._state === 'path') {
      this._handlePath(emu, ori);
    } else {
      switch (this._state) {
        case S.IDLE:        this._handleIdle(emu, ori);     break;
        case S.DROPPING:    this._handleDropping(emu, ori); break;
        // Safety fall-through: these shouldn't occur in MeatfighterBot
        // but handle gracefully in case of stale state after a reset.
        case S.ROTATING:    this._handleRotating(emu, ori);    break;
        case S.TRANSLATING: this._handleTranslating(emu, ori); break;
      }
    }
  }

  /**
   * Override _handleIdle to delay _plan by 1 frame so pixel registers stabilise.
   * On the first tick after a new ori is seen, set _planPending and return.
   * On the second tick, call _plan with the now-stable pixel data.
   */
  _handleIdle(emu, ori) {
    this._statusMsg = 'idle';
    if (ori !== this._lastOri) {
      // PPS throttle (copied from base class)
      if (this._ppsLimit === 0) { this._statusMsg = 'idle (paused)'; return; }
      if (isFinite(this._ppsLimit) && this._lastDropMs > 0) {
        const elapsed = performance.now() - this._lastDropMs;
        const needed  = 1000 / this._ppsLimit;
        if (elapsed < needed) { this._statusMsg = 'idle'; return; }
      }
      this._lastOri        = ori;
      this._replanAttempts = 0;
      // Delay plan by 1 frame — pixel regs aren't stable yet on this tick.
      this._planPending    = true;
      this._planPendingOri = ori;
    } else if (this._planPending) {
      // Second tick after spawn: pixels are now stable.
      this._planPending = false;
      this._plan(emu, this._planPendingOri);
    }
  }

  /**
   * Override _plan() to run BFS and set up path execution.
   * Called by _handleIdle() when a new piece is detected (after 1-frame delay).
   */
  _plan(emu, ori) {
    const info = oriInfo(ori);
    if (!info) { this._beginDrop(emu); return; }

    const actualSpawnCol = this._pieceLeftCol(emu);
    // Actual spawn row from pixel registers (may be negative for tall pieces that
    // spawn partially above the visible board).  BFS can only operate on rows ≥ 0,
    // so we clamp and prepend extra D moves for the above-board portion.
    const actualSpawnRow = this._pieceMinRow(emu);  // may be -1, -2, …
    const bfsSpawnRow    = Math.max(0, actualSpawnRow);
    const extraD         = bfsSpawnRow - actualSpawnRow; // ≥ 0

    const nextOri  = emu.read_mem(ADDR_NEXT_ORI);
    const nextInfo = oriInfo(nextOri);

    let move;
    if (nextInfo) {
      this._meatMode = '2ply-bfs';
      move = findBestMoveWithBFS(emu, nextInfo.typeIdx, actualSpawnCol, bfsSpawnRow);
    } else {
      this._meatMode = '1ply-bfs';
      move = findBestMoveWithBFS1ply(emu, bfsSpawnRow, actualSpawnCol, info.rot);
    }

    if (!move) {
      this._targetRot  = info.rot;
      this._targetLeft = actualSpawnCol;
      this._beginDrop(emu);
      return;
    }

    this._targetRot  = move.rot;
    this._targetLeft = move.leftCol;
    this._intendedLock    = { row: move.row, col: move.leftCol, rot: move.rot, moveType: move.moveType };
    // For T-piece spins, the center-pivot may shift the piece DOWN by 1 row during
    // the final rotation (e.g. CCW from rot=3 → rot=2: offset=[+1,0]).
    // _planIntendedRow is the row the piece must reach BEFORE firing the final spin,
    // so subtract the pivot dr to get the pre-spin row.
    this._planIntendedRow = move.row;
    if ((move.moveType === 'tspin' || move.moveType === 'spin') && move.path.length > 0 && info.typeIdx === 2) {
      const lastAct = move.path[move.path.length - 1];
      if (lastAct === 'CW' || lastAct === 'CCW') {
        const T_CW_OFF  = [[0,1],[1,-1],[-1,0],[0,0]];
        const T_CCW_OFF = [[0,0],[0,-1],[-1,1],[1,0]];
        const fromRot = lastAct === 'CW' ? (move.rot + 3) % 4 : (move.rot + 1) % 4;
        const off = lastAct === 'CW' ? T_CW_OFF[fromRot] : T_CCW_OFF[fromRot];
        this._planIntendedRow -= off[0]; // subtract pivot-dr to get pre-spin row
      }
    }

    if (move.moveType === 'normal') {
      // Normal placement: rotate → translate laterally → hard drop.
      // Never soft-drop — the BFS path would interleave D-steps with laterals
      // (BFS explores D first), causing visible downward taps before hard drop.
      const rotNeeded = (this._targetRot - info.rot + 4) % 4;
      this._rotAttempts   = 0;
      this._transAttempts = 0;
      if (rotNeeded > 0) {
        this._state     = S.ROTATING;
        this._statusMsg = 'rotating';
      } else {
        this._state     = S.TRANSLATING;
        this._statusMsg = 'translating';
      }
    } else {
      // Tuck/spin: BFS path must be followed step-by-step (D-steps are load-bearing).
      console.log(`[meatfighter] Piece #${this._pieceCount + 1} ${PIECE_NAMES[info.typeIdx]} [${move.moveType}]: row=${move.row} col=${move.leftCol} rot=${move.rot} path=[${move.path.join(',')}]`);
      // Prepend extra D moves for the above-board spawn portion
      const fullPath = extraD > 0
        ? Array(extraD).fill('D').concat(move.path)
        : move.path;
      this._movePath        = fullPath;
      this._pathStep        = 0;
      this._pathExpectedRow = actualSpawnRow;
      this._pathExpectedCol = actualSpawnCol;
      this._pathExpectedRot = info.rot;
      this._postRotSync     = false;
      this._state           = 'path';
      this._statusMsg       = `path(${move.path.length} steps)`;
    }
  }

  // ── Path executor ─────────────────────────────────────────────────────────

  _handlePath(emu, ori) {
    const info = oriInfo(ori);

    // Guard: piece type changed = gravity lock happened before we were done
    if (!info || info.typeIdx !== oriInfo(this._lastOri)?.typeIdx) {
      // _lastOri === -1 means stale path state from a previous game (e.g. ROM
      // reloaded before a non-in-game frame could clear it).  Reset silently.
      if (this._lastOri === -1) {
        this._movePath = [];
        this._state    = S.IDLE;
        return;
      }
      // Real gravity lock: piece locked before we finished the path.
      this._totalDrops++;
      this._misdropCount++;
      const il = this._intendedLock;
      console.warn(
        `[bot] GRAVITY LOCK misdrop #${this._misdropCount}/${this._totalDrops}` +
        ` — wanted col=${this._targetLeft} rot=${this._targetRot}` +
        ` — piece locked early (path step ${this._pathStep}/${this._movePath.length})`
      );
      console.log(`[meatfighter] intended lock: row=${il?.row} col=${il?.col} rot=${il?.rot} | effective lock: row=${this._pathExpectedRow} col=${this._pathExpectedCol} rot=${this._pathExpectedRot} (gravity lock, estimated)`);
      this._state   = S.IDLE;
      this._lastOri = -1;
      return;
    }

    const actualRow = this._pieceMinRow(emu);
    const actualCol = this._pieceLeftCol(emu);
    const actualRot = info.rot;

    // OAM garbage check: during ARE (after piece locks), sprite Y registers go
    // to 0xFF → _pieceMinRow returns floor((0xFF-16)/8) = 29, which is beyond
    // the board. Treat this as a same-type gravity lock and abort the path.
    if (actualRow >= BOARD_ROWS) {
      this._totalDrops++;
      this._misdropCount++;
      const il = this._intendedLock;
      console.warn(
        `[meatfighter] ARE lock detected (actualRow=${actualRow}) — aborting path` +
        ` step ${this._pathStep}/${this._movePath.length}` +
        ` intended row=${il?.row} col=${il?.col} rot=${il?.rot}`
      );
      this._state   = S.IDLE;
      this._lastOri = -1;
      return;
    }

    // ── Post-rotation col+row re-sync ─────────────────────────────────────
    // SRS kicks shift the piece ±1 col and/or ±1 row when a rotation
    // expands the bounding box (e.g. floor kick moves the piece up).
    // The BFS assumes rotations happen in-place, so we absorb the real
    // offsets by re-reading actual col and row after every CW/CCW action.
    if (this._postRotSync) {
      this._postRotSync = false;
      const kickDeltaCol = actualCol - this._pathExpectedCol;
      const kickDeltaRow = actualRow - this._pathExpectedRow; // negative = kicked up

      // ── Final-spin shortcut ────────────────────────────────────────────────
      // If the rotation was the LAST action in the path (e.g. a grounded T-spin),
      // accept the SRS-kicked row unconditionally (gravity will drop to landing row).
      // For col kicks: insert L/R compensation so the piece reaches the intended col
      // before locking.  Without this, a +1 SRS col kick causes a systematic 1-col
      // misdrop on every final-rotation placement.
      if (this._pathStep >= this._movePath.length) {
        this._pathExpectedRow = actualRow;
        if (kickDeltaCol !== 0 || kickDeltaRow !== 0)
          console.log(`[meatfighter] final-spin sync: rowΔ=${kickDeltaRow} colΔ=${kickDeltaCol}`);
        if (kickDeltaCol !== 0) {
          const act = kickDeltaCol > 0 ? 'L' : 'R';
          const n   = Math.abs(kickDeltaCol);
          this._movePath.splice(this._pathStep, 0, ...Array(n).fill(act));
          this._pathExpectedCol = actualCol;
          console.log(`[meatfighter] final-spin col compensation: ${n}×${act}`);
        } else {
          this._pathExpectedCol = actualCol;
        }
        return; // always return — compensation (if any) executes next tick
      }

      if (kickDeltaCol !== 0) {
        // Insert compensation L/R moves to bring piece back to BFS-planned column.
        const compensationAction = kickDeltaCol > 0 ? 'L' : 'R';
        const compensation = Array(Math.abs(kickDeltaCol)).fill(compensationAction);
        this._movePath.splice(this._pathStep, 0, ...compensation);
        this._pathExpectedCol = actualCol;
        if (kickDeltaCol !== 0) console.log(`[meatfighter] SRS col kick: delta=${kickDeltaCol}, inserted ${compensation.length}×${compensationAction}`);
      }

      if (kickDeltaRow !== 0) {
        // Re-anchor _pathExpectedRow to the actual position; don't touch D-steps.
        // The D-step count in the BFS path cannot be adjusted here reliably because
        // _pathExpectedRow advances ~2× faster than actualRow (soft-drop moves 1 row
        // every 2 frames, not every frame). The spin-row-wait guard below will ensure
        // the final rotation only fires once actualRow reaches _planIntendedRow.
        this._pathExpectedRow = actualRow;
        console.log(`[meatfighter] SRS row kick: delta=${kickDeltaRow} (row-sync only)`);
      }
    }

    // ── Gravity compensation ───────────────────────────────────────────────
    // If gravity advanced the piece further down than the path expected,
    // consume pending 'D' steps for free (they already happened).
    while (
      this._pathStep < this._movePath.length &&
      this._movePath[this._pathStep] === 'D' &&
      actualRow > this._pathExpectedRow
    ) {
      this._pathExpectedRow++;
      this._pathStep++;
    }

    // ── Deviation check ────────────────────────────────────────────────────
    // If col or rot don't match our expectation (ignoring row / gravity),
    // something went wrong.
    // - Col drift only (rot ok): insert L/R compensation moves in-place
    //   (same as SRS kick compensation). Avoids back-and-forth from replanning.
    // - Rot mismatch: full replan required.
    if (actualCol !== this._pathExpectedCol || actualRot !== this._pathExpectedRot) {
      if (actualRot === this._pathExpectedRot) {
        // Safety net for tucks: if path is complete with col drift and we're still
        // above planIntendedRow, a terminal lateral was blocked by the overhang.
        // The terminal-lateral-wait guard below should prevent reaching this point,
        // but if we do, inserting compensation would create an infinite loop — wait.
        const pathDone = this._pathStep >= this._movePath.length;
        if (pathDone && this._intendedLock?.moveType === 'tuck' && actualRow < this._planIntendedRow) {
          this._rowWaitCount++;
          if (this._rowWaitCount === 1) {
            console.warn(`[meatfighter] tuck safety-wait: slide blocked at row=${actualRow} < planRow=${this._planIntendedRow} (path complete with drift)`);
          }
          if (this._rowWaitCount > 180) {
            console.warn(`[meatfighter] tuck safety-wait timeout — replanning`);
            this._rowWaitCount = 0;
            this._state = S.IDLE;
            this._lastOri = -1;
          }
          return;
        }
        // Col-only drift: compensate in-place.
        // Safety: if path is already complete and compensation keeps failing (piece grounded
        // and can't slide), avoid infinite insertion loop — just drop after a few attempts.
        if (pathDone) {
          this._colDriftCount++;
          if (this._colDriftCount === 1) {
            console.warn(`[meatfighter] col drift at path-complete: col=${actualCol} expCol=${this._pathExpectedCol} row=${actualRow} moveType=${this._intendedLock?.moveType}`);
          }
          if (this._colDriftCount > 8) {
            console.warn(`[meatfighter] col drift timeout (${this._colDriftCount} attempts) — dropping`);
            this._colDriftCount = 0;
            this._state = S.IDLE;
            this._beginDrop(emu);
            return;
          }
        } else {
          this._colDriftCount = 0;
        }
        const delta = actualCol - this._pathExpectedCol;
        const compensationAction = delta > 0 ? 'L' : 'R';
        const compensation = Array(Math.abs(delta)).fill(compensationAction);
        this._movePath.splice(this._pathStep, 0, ...compensation);
        this._pathExpectedCol = actualCol;
        console.log(`[meatfighter] col drift ${delta > 0 ? '+' : ''}${delta} at step ${this._pathStep}/${this._movePath.length - compensation.length}: inserted ${compensation.length}×${compensationAction} actualRow=${actualRow} expRow=${this._pathExpectedRow} moveType=${this._intendedLock?.moveType}`);
        return;
      } else {
        // Rot mismatch: full replan
        console.warn(
          `[meatfighter] rot deviation at step ${this._pathStep}/${this._movePath.length}: ` +
          `expected (col=${this._pathExpectedCol},rot=${this._pathExpectedRot}), ` +
          `got (col=${actualCol},rot=${actualRot}). Replanning.`
        );
        const replan = findBestMoveWithBFS1ply(emu, actualRow, actualCol, actualRot);
        if (replan) {
          this._movePath        = replan.path;
          this._pathStep        = 0;
          this._pathExpectedRow = actualRow;
          this._pathExpectedCol = actualCol;
          this._pathExpectedRot = actualRot;
          this._postRotSync     = false;
          this._targetRot       = replan.rot;
          this._targetLeft      = replan.leftCol;
          this._statusMsg       = `path(replan,${replan.path.length} steps)`;
          // Execute first step immediately on this tick (fall through below)
        } else {
          this._targetRot  = actualRot;
          this._targetLeft = actualCol;
          this._state      = S.IDLE;
          this._beginDrop(emu);
          return;
        }
      } // end rot-mismatch replan
    }
    // ── Path complete → hard drop ──────────────────────────────────────────
    if (this._pathStep >= this._movePath.length) {
      const il = this._intendedLock;

      // Sanity check: if actualRow is far above the originally-planned lock row,
      // the piece already locked and a same-type new piece has spawned (type guard
      // passed because typeIdx matched). Use _planIntendedRow (frozen at plan time)
      // rather than _pathExpectedRow, which SRS row-kick compensation overwrites to
      // the current position and can no longer detect the discrepancy.
      if (actualRow < this._planIntendedRow - 2) {
        console.log(`[meatfighter] same-type piece spawned before path-complete detected (actualRow=${actualRow} planIntendedRow=${this._planIntendedRow}) — resetting to IDLE`);
        this._movePath = [];
        this._pathStep = 0;
        this._state    = S.IDLE;
        this._lastOri  = -1;
        return;
      }

      // Timing / piece counter
      this._pieceCount++;
      const now = performance.now();
      const deltaMs = this._lastLockTime !== null ? now - this._lastLockTime : null;
      this._lastLockTime = now;
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      const timeStr  = `${hh}:${mm}:${ss}.${ms}`;
      const deltaStr = deltaMs !== null ? `+${deltaMs.toFixed(3)}ms` : '+0.000ms';
      const pieceStr = `Piece #${this._pieceCount} ${PIECE_NAMES[info.typeIdx]}`;

      // Col/rot match is already guaranteed by deviation detection above.
      // Effective lock row:
      // - tuck: the piece must already BE at il.row when path completes (it
      //   slid to the lock col at the lock row). actualRow is the truth.
      //   Gravity sim is wrong (straight drop from this col is blocked).
      // - normal/spin: gravity sim from current position is correct.
      const bb = readBitboard(emu);
      let effRow;
      if (il?.moveType === 'tuck') {
        effRow = actualRow;
      } else {
        effRow = actualRow;
        while (!pieceCollides(bb, info.typeIdx, actualRot, effRow + 1, actualCol)) effRow++;
      }

      const colRotMatch = actualCol === il?.col && actualRot === il?.rot;
      const rowMatch    = effRow === il?.row;
      const match       = colRotMatch && rowMatch;
      const typeTag     = il?.moveType && il.moveType !== 'normal' ? ` [${il.moveType}]` : '';
      console.log(`[meatfighter] ${pieceStr} @${timeStr} ${deltaStr}${typeTag} | intended row=${il?.row} col=${il?.col} rot=${il?.rot} | effective row=${effRow} col=${actualCol} rot=${actualRot}${match ? ' ✓' : ' ✗'}`);

      if (il && !match) {
        this._misdropCount++;
        this._totalDrops++;
        console.warn(
          `[meatfighter] MISDROP #${this._misdropCount}/${this._totalDrops}${typeTag}` +
          ` — intended row=${il.row} col=${il.col} rot=${il.rot}` +
          ` but effective row=${effRow} col=${actualCol} rot=${actualRot}`
        );
        // No auto-pause — misdrop is logged and counted, game continues.
      }
      this._state = S.IDLE; // cleared by _beginDrop internals
      this._beginDrop(emu);
      return;
    }

    // ── Execute next action ────────────────────────────────────────────────
    // Tuck terminal-lateral guard:
    // The BFS path for a tuck ends with lateral moves (L/R) after all D-taps.
    // These terminal laterals should only execute once the piece has physically
    // reached planIntendedRow — the row where the overhang gap exists.
    // Executing them earlier (while the piece is still above planIntendedRow)
    // would be blocked by the overhang, causing col drift and compensation loops.
    //
    // "Terminal" = no D-taps remain after the current consecutive lateral group.
    // Intermediate laterals (D-taps still follow) execute immediately —
    // the BFS correctly placed them at that earlier row.
    //
    // While waiting: D-taps earlier in the path still execute normally (soft-drop).
    // Gravity also advances the piece for free, reducing the wait.
    {
      const nextAction = this._movePath[this._pathStep];
      const il = this._intendedLock;
      const isFinalRot = (nextAction === 'CW' || nextAction === 'CCW') &&
          (il?.moveType === 'spin' || il?.moveType === 'tspin') &&
          this._movePath.slice(this._pathStep + 1).every(a => a === 'L' || a === 'R');
      if (isFinalRot && actualRow < this._planIntendedRow) {
        // Spin-row-wait: the final rotation must happen at planIntendedRow, not earlier.
        // _pathExpectedRow tracks BFS accounting and runs ahead of actualRow (soft-drop
        // moves 1 row per 2 frames). Soft-drop until the piece physically reaches the row.
        this._rowWaitCount++;
        if (this._rowWaitCount === 1) {
          console.log(`[meatfighter] spin-row-wait: ${nextAction} at step ${this._pathStep}/${this._movePath.length} — actualRow=${actualRow} planRow=${this._planIntendedRow}, soft-dropping`);
        }
        if (this._rowWaitCount > 120) {
          console.warn(`[meatfighter] spin-row-wait timeout (${this._rowWaitCount} ticks) — forcing rotation`);
          this._rowWaitCount = 0;
          // fall through and execute the rotation
        } else {
          this._tap(emu, 5); // soft-drop
          return; // don't advance _pathExpectedRow; gravity accounting handled by actualRow
        }
      } else if ((nextAction === 'L' || nextAction === 'R') &&
          il?.moveType === 'tuck' &&
          actualRow < this._planIntendedRow) {
        // Tuck terminal-lateral guard: wait for planIntendedRow before terminal slide.
        const rest = this._movePath.slice(this._pathStep);
        const firstNonLateral = rest.findIndex(a => a !== 'L' && a !== 'R');
        const isTerminal = firstNonLateral === -1 || !rest.slice(firstNonLateral).some(a => a === 'D');
        if (isTerminal) {
          this._rowWaitCount++;
          if (this._rowWaitCount === 1) {
            console.log(`[meatfighter] tuck-lateral-wait: ${nextAction} at step ${this._pathStep}/${this._movePath.length} — actualRow=${actualRow} planRow=${this._planIntendedRow}, soft-dropping`);
          }
          if (this._rowWaitCount > 60) {
            console.warn(`[meatfighter] tuck-lateral-wait timeout (${this._rowWaitCount} ticks) — forcing lateral`);
            this._rowWaitCount = 0;
            // fall through and execute the lateral
          } else {
            this._tap(emu, 5); // D
            this._pathExpectedRow++;
            return;
          }
        }
      } else if (this._rowWaitCount > 0) {
        console.log(`[meatfighter] row-wait resolved after ${this._rowWaitCount} frames — actualRow=${actualRow} planRow=${this._planIntendedRow}`);
        this._rowWaitCount = 0;
      }
    }

    const action = this._movePath[this._pathStep++];
    const il = this._intendedLock;
    if (il?.moveType === 'tuck') {
      console.log(`[tuck-trace] step=${this._pathStep-1}/${this._movePath.length} action=${action} actualRow=${actualRow} actualCol=${actualCol} expRow=${this._pathExpectedRow} expCol=${this._pathExpectedCol} remaining=[${this._movePath.slice(this._pathStep).join(',')}]`);
    }
    switch (action) {
      case 'L':   this._tap(emu, 6); this._pathExpectedCol--;                        break;
      case 'R':   this._tap(emu, 7); this._pathExpectedCol++;                        break;
      case 'D':   this._tap(emu, 5); this._pathExpectedRow++;                        break;
      case 'CW':  this._tap(emu, 0); this._pathExpectedRot = (this._pathExpectedRot + 1) % 4; this._postRotSync = true; break;
      case 'CCW': this._tap(emu, 1); this._pathExpectedRot = (this._pathExpectedRot + 3) % 4; this._postRotSync = true; break;
      default:    console.warn(`[meatfighter] unknown path action: ${action}`);      break;
    }
    this._statusMsg = `path(${this._pathStep}/${this._movePath.length})`;
  }

  get mode() { return `meatfighter (${this._meatMode})`; }
}
