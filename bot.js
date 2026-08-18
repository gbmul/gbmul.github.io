console.log('[bot.js] version 202608142050A loaded');

/**
 * www/bot.js
 *
 * Tetris bot for GB Tetris (NRS) — 1-ply placement search.
 * Core bot classes: TetrisBot, HybridBot, IntermediateBot.
 * MeatfighterBot lives in bot-meatfighter.js.
 *
 * Public API:
 *   import { TetrisBot } from './bot.js';
 *   const bot = new TetrisBot();
 *   bot.tick(emu, gameState);  // call every frame; gameState from detectGameState()
 *   bot.reset(emu);            // call when bot is toggled off
 *   bot.status                 // read-only string describing current activity
 */

import {
  ADDR_CUR_ORI, ADDR_NEXT_ORI, ADDR_RNG_PTR, ADDR_RNG_RESULT, ADDR_C204,
  BOARD_ROWS, BOARD_COLS,
  SQ_ADDRS, PIX_X_OFF, PIX_Y_OFF, PIX_CELL,
  oriInfo, SHAPES,
} from './bot-pieces.js';

import { popcount, readBitboard, columnHeights, BOARD_BASE, BOARD_STRIDE } from './bot-board.js';

// ── Evaluation weights ───────────────────────────────────────────────────────
const W = {
  clears:     10,   // (clears²) × this
  holes:     -35,
  wells:      -8,
  rowTrans:   -5,
  colTrans:  -12,
  quadWell:   20,
  landing:    -2,   // penalty for high placement: (BOARD_ROWS - landRow) × this
                    // mirrors reference: (lengthY − lowest) × w.lowest
};

// ── Board evaluator ───────────────────────────────────────────────────────────
/**
 * Score a board state.  Higher = better.
 *
 * Core board evaluator.
 *
 * Metrics:
 *   clears²  — reward line clears quadratically
 *   holes    — contiguous empty-cell groups below a filled cell per column
 *   wells    — sum of quadratic well depths (2^depth − 1 per well column)
 *   rowTrans — horizontal filled↔empty transitions per row
 *   colTrans — vertical filled↔empty transitions per column
 *   quadWell — consecutive near-full rows above the lowest column (Tetris setup)
 */
function evaluate(bb, heights, clears) {
  let rowTrans = 0, colTrans = 0, holes = 0, wells = 0, quadWell = 0;

  // ── Row transitions ────────────────────────────────────────────────────
  // `(bb[r]>>1)^bb[r]` produces a 1-bit at every col-to-col transition.
  // Bit 9 captures the right-wall transition (col 9 vs imaginary empty wall),
  // matching the reference countBits((a>>1)^a) which includes it implicitly.
  // The left wall is not counted (no bit -1), matching the reference.
  for (let r = 0; r < BOARD_ROWS; r++) {
    if (bb[r]) rowTrans += popcount((bb[r] >> 1) ^ bb[r]);
  }

  // ── Column transitions and holes ─────────────────────────────────────────
  for (let col = 0; col < BOARD_COLS; col++) {
    let prev = false;
    const topRow = BOARD_ROWS - heights[col]; // first filled row (or BOARD_ROWS)
    for (let row = topRow; row < BOARD_ROWS; row++) {
      const filled = !!(bb[row] & (1 << col));
      if (filled !== prev) { colTrans++; if (!filled) holes++; }
      prev = filled;
    }
  }

  // ── Wells ─────────────────────────────────────────────────────────────────
  // For each column lower than both neighbours, accumulate depth score 2^d−1.
  // Left and right borders act as infinitely tall walls (height = BOARD_ROWS).
  let lowestH = Infinity, lowestX = 0;
  for (let col = 0; col < BOARD_COLS; col++) {
    const h = heights[col];
    if (h < lowestH) { lowestH = h; lowestX = col; }

    const lh = col === 0            ? BOARD_ROWS : heights[col - 1];
    const rh = col === BOARD_COLS-1 ? BOARD_ROWS : heights[col + 1];
    let n = h, count = 0;
    while (n < lh && n < rh) { count = count + count + 1; n++; }
    wells += count;
  }

  // ── Quad-well: consecutive ≥9-filled rows above lowest column ────────────
  let qRow = BOARD_ROWS - lowestH - 1;
  while (qRow >= 0 && popcount(bb[qRow]) >= BOARD_COLS - 1) { quadWell++; qRow--; }

  return clears * clears * W.clears
       + holes           * W.holes
       + wells           * W.wells
       + rowTrans        * W.rowTrans
       + colTrans        * W.colTrans
       + quadWell        * W.quadWell;
}

// ── Evaluator wrappers (used as callbacks by findBestMove) ──────────────────

/**
 * Default evaluator: standard heuristic + landing-height penalty.
 * @param {Uint16Array} bb
 * @param {number[]} heights
 * @param {number} clears
 * @param {number} landRow
 */
function defaultEvaluate(bb, heights, clears, landRow) {
  return evaluate(bb, heights, clears) + (BOARD_ROWS - landRow) * W.landing;
}

// ── HybridBot evaluators ─────────────────────────────────────────────────────
// Ported from references/src/main.rs :: IntermediateBot + AttackerBot

/**
 * IntermediateBot evaluator (cleanup / downstack mode).
 * Applied on the post-clear board; ignores landRow.
 *
 * score = lines²×13 + maxH×3 + holes×−18 + bumpiness×−4.5 + wellDepth×4
 */
function intermediateEvaluate(bb, heights, clears, _landRow) {
  const maxH = Math.max(...heights);

  let holes = 0;
  for (let col = 0; col < BOARD_COLS; col++) {
    let foundFilled = false;
    for (let row = 0; row < BOARD_ROWS; row++) {
      const filled = !!(bb[row] & (1 << col));
      if (filled) { foundFilled = true; }
      else if (foundFilled) { holes++; }
    }
  }

  let bumpiness = 0;
  for (let i = 0; i < BOARD_COLS - 1; i++) {
    bumpiness += Math.abs(heights[i] - heights[i + 1]);
  }

  // Well depth: per-column depth if lower than both neighbours, capped at 4.
  // Borders are treated as height 0 (edge columns are never wells).
  let wellDepth = 0;
  for (let col = 0; col < BOARD_COLS; col++) {
    const lh = col > 0            ? heights[col - 1] : 0;
    const rh = col < BOARD_COLS-1 ? heights[col + 1] : 0;
    const h  = heights[col];
    if (lh > h && rh > h) wellDepth += Math.min(Math.min(lh, rh) - h, 4);
  }

  return clears * clears * 13
       + maxH             * 3
       + holes            * -18
       + bumpiness        * -4.5
       + wellDepth        * 4;
}

// Well column for AttackerBot (0 = left, 9 = right).
// Right well (col 9) matches the default in the Rust reference.
const HYBRID_WELL_COL = 9;

// HybridBot mode-switch thresholds (matching Rust reference defaults)
const HYBRID_HEIGHT_THRESHOLD    = 16; // use Intermediate if maxH > this
const HYBRID_HOLES_THRESHOLD     = 3;  // use Intermediate if holes > this
const HYBRID_BUMPINESS_THRESHOLD = 20; // use Intermediate if bumpiness > this
const HYBRID_TERE_THRESHOLD      = 95; // fire I-piece into well if TeRe >= this

/**
 * Calculate TeRe (Tetris Readiness): percentage of the best 4-row window
 * that is filled (excluding the shaft column).
 *
 * Returns a value in [0, 100].  100 = perfect Tetris setup (36/36 cells filled
 * in the 9×4 area beside an empty shaft column).
 */
function calculateTere(bb) {
  let maxFilled = 0;
  for (let startRow = 0; startRow < BOARD_ROWS - 3; startRow++) {
    for (let shaftCol = 0; shaftCol < BOARD_COLS; shaftCol++) {
      // Shaft column must be completely empty in all 4 rows
      let shaftEmpty = true;
      for (let r = startRow; r < startRow + 4; r++) {
        if (bb[r] & (1 << shaftCol)) { shaftEmpty = false; break; }
      }
      if (!shaftEmpty) continue;

      // Count filled cells in those 4 rows, excluding the shaft column
      let filled = 0;
      for (let r = startRow; r < startRow + 4; r++) {
        for (let c = 0; c < BOARD_COLS; c++) {
          if (c !== shaftCol && (bb[r] & (1 << c))) filled++;
        }
      }
      if (filled > maxFilled) maxFilled = filled;
    }
  }
  return (maxFilled / 36) * 100; // 9 cols × 4 rows = 36
}

/**
 * Count holes restricted to the 9 non-well columns.
 * A hole is an empty cell with ≥1 filled cell above it in the same column.
 */
function countHoles9Col(bb, heights, wellCol) {
  let holes = 0;
  for (let col = 0; col < BOARD_COLS; col++) {
    if (col === wellCol) continue;
    let foundFilled = false;
    for (let row = 0; row < BOARD_ROWS; row++) {
      const filled = !!(bb[row] & (1 << col));
      if (filled) { foundFilled = true; }
      else if (foundFilled) { holes++; }
    }
  }
  return holes;
}

/**
 * Count holes across all 10 columns (used for the mode-switch check).
 */
function countHolesAll(bb) {
  let holes = 0;
  for (let col = 0; col < BOARD_COLS; col++) {
    let foundFilled = false;
    for (let row = 0; row < BOARD_ROWS; row++) {
      const filled = !!(bb[row] & (1 << col));
      if (filled) { foundFilled = true; }
      else if (foundFilled) { holes++; }
    }
  }
  return holes;
}

/**
 * AttackerBot evaluator (9-column stacking + Tetris strategy).
 *
 * Priority hierarchy (magnitude):
 *   well_penalty −10000 >> holes −5000 >> tetris_bonus +20000 >> ...
 * Meaning: never fill the well, never create holes, DO clear Tetrises.
 */
function attackerEvaluate(bb, heights, clears, _landRow) {
  const wellCol = HYBRID_WELL_COL;

  // Tetris bonus
  const tetrisBonus = (clears === 4) ? 20000 : 0;

  // Holes in the 9 non-well columns
  const holes9 = countHoles9Col(bb, heights, wellCol);

  // Bumpiness across only the non-well columns
  // (from first to last filled non-well column, matching Rust reference)
  const h9 = heights.filter((_, c) => c !== wellCol);
  let bumpiness9 = 0;
  for (let i = 0; i < h9.length - 1; i++) {
    bumpiness9 += Math.abs(h9[i] - h9[i + 1]);
  }

  // Premature line clear penalty (non-Tetris clears waste the setup)
  const lineClearPenalty = (clears > 0 && clears < 4) ? clears : 0;

  // Well penalty: any block in the well column at all
  const wellPenalty = (heights[wellCol] > 0) ? 1 : 0;

  // Vertical column hole penalty: max contiguous empty run inside any column
  // (detects when a capped-off shaft has formed)
  let verticalColHoles = 0;
  for (let col = 0; col < BOARD_COLS; col++) {
    const colH = heights[col];
    if (colH === 0) continue;
    let maxHoleDepth = 0, holeDepth = 0;
    for (let row = BOARD_ROWS - colH; row < BOARD_ROWS; row++) {
      if (!(bb[row] & (1 << col))) {
        holeDepth++;
      } else {
        if (holeDepth > 0) maxHoleDepth = Math.max(maxHoleDepth, holeDepth);
        holeDepth = 0;
      }
    }
    verticalColHoles = Math.max(verticalColHoles, maxHoleDepth);
  }

  // TeRe score
  const tere = calculateTere(bb);

  return tetrisBonus
       + holes9          * -5000
       + bumpiness9      * -50
       + lineClearPenalty * -50
       + wellPenalty      * -10000
       + verticalColHoles * -2000
       + tere             * 150;
}

/**
 * Decide whether HybridBot should use AttackerBot or IntermediateBot mode
 * for the current board state.
 *
 * @param {Uint16Array} bb - current board bitboard
 * @param {number[]}  heights - column heights
 * @returns {boolean} true → use Attacker mode
 */
function hybridShouldUseAttacker(bb, heights) {
  const maxH  = Math.max(...heights);
  if (maxH > HYBRID_HEIGHT_THRESHOLD) return false; // emergency downstack

  const holes  = countHolesAll(bb);
  let bumpiness = 0;
  for (let i = 0; i < BOARD_COLS - 1; i++) {
    bumpiness += Math.abs(heights[i] - heights[i + 1]);
  }

  return maxH   <= HYBRID_HEIGHT_THRESHOLD - 2  // ≤ 14
      && holes   <= HYBRID_HOLES_THRESHOLD       // ≤ 3
      && bumpiness <= HYBRID_BUMPINESS_THRESHOLD; // ≤ 20
}

// ── Move finder ───────────────────────────────────────────────────────────────

/**
 * Check whether a piece with the given shape can slide horizontally from
 * spawnCol to targetCol without being blocked by the existing board.
 *
 * The piece slides at its spawn row (row 0 = top of board).  For each column
 * along the path we verify that every cell the shape occupies is free.
 * This is a conservative check — it correctly rejects placements blocked at
 * the top of the stack.
 */
export function isReachable(bb, shape, spawnCol, targetCol) {
  const step = targetCol > spawnCol ? 1 : -1;
  for (let col = spawnCol; col !== targetCol; col += step) {
    for (const [dr, dc] of shape) {
      const r = dr; // slide at row 0
      const c = col + step + dc;
      if (c < 0 || c >= BOARD_COLS) return false;
      if (r >= 0 && r < BOARD_ROWS && (bb[r] & (1 << c))) return false;
    }
  }
  return true;
}

/**
 * Find best (rot, leftCol) placement for the current piece.
 *
 * @param {object} emu
 * @param {number} [fromCol]   – if provided, only consider columns reachable
 *   from this position (used when re-planning after being blocked mid-path).
 *   Pass undefined (or omit) for the initial full-board search.
 * @param {number} [forceRot]  – if >= 0, only evaluate this rotation index.
 *   Used when rotation failed and we need the best column for the piece as-is.
 */
/**
 * @param {function} [evaluateFn] — optional evaluator: (bb, heights, clears, landRow) => number.
 *   Defaults to the standard heuristic (defaultEvaluate).
 */
function findBestMove(emu, fromCol, forceRot = -1, evaluateFn = defaultEvaluate) {
  const bb  = readBitboard(emu);
  const ori = emu.read_mem(ADDR_CUR_ORI);
  const info = oriInfo(ori);
  if (!info) return null;

  const FULL_ROW = (1 << BOARD_COLS) - 1; // 0x3FF

  // Piece spawns with its left edge at roughly col 3 (centre of 10-col board).
  // Use actual current left col if provided (re-plan), else assume spawn = 3.
  const spawnCol = fromCol !== undefined ? fromCol : 3;

  let bestScore = -Infinity, bestMove = null;

  for (let rot = 0; rot < 4; rot++) {
    if (forceRot >= 0 && rot !== forceRot) continue;
    const shape = SHAPES[info.typeIdx][rot];
    const maxDC = Math.max(...shape.map(([, c]) => c));
    const maxDR = Math.max(...shape.map(([r]) => r));
    const leftColMax = BOARD_COLS - 1 - maxDC;

    const colMin = 0;
    const colMax = leftColMax;

    for (let leftCol = colMin; leftCol <= colMax; leftCol++) {
      // ── Reachability: skip placements the piece can't slide to ─────────
      if (!isReachable(bb, shape, spawnCol, leftCol)) continue;

      // ── Find landing row (gravity simulation) ──────────────────────────
      let landRow = -1;
      findLand: for (let startRow = 0; startRow <= BOARD_ROWS - 1 - maxDR; startRow++) {
        for (const [dr, dc] of shape) {
          if (bb[startRow + dr] & (1 << (leftCol + dc))) {
            landRow = startRow - 1; // collision: land one row above
            break findLand;
          }
        }
        landRow = startRow; // no collision yet, keep going
      }
      if (landRow < 0) continue; // blocked at spawn row – skip

      // ── Simulate piece placement ────────────────────────────────────────
      const test = new Uint16Array(bb);
      for (const [dr, dc] of shape) {
        const r = landRow + dr;
        if (r >= 0 && r < BOARD_ROWS) test[r] |= (1 << (leftCol + dc));
      }

      // ── Clear full lines ─────────────────────────────────────────────────
      let clears = 0;
      const kept = [];
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (test[r] === FULL_ROW) clears++;
        else kept.push(test[r]);
      }
      if (clears > 0) {
        const cleared = new Uint16Array(BOARD_ROWS);
        for (let i = 0; i < kept.length; i++) {
          cleared[BOARD_ROWS - kept.length + i] = kept[i];
        }
        test.set(cleared);
      }

      // ── Evaluate and record if best ─────────────────────────────────────
      const testHeights = columnHeights(test);
      const score = evaluateFn(test, testHeights, clears, landRow);
      if (score > bestScore) {
        bestScore = score;
        bestMove  = { rot, leftCol };
      }
    }
  }

  return bestMove;
}

// ── Bot state machine ─────────────────────────────────────────────────────────
export const S = {
  IDLE:        'idle',
  ROTATING:    'rotating',
  TRANSLATING: 'translating',
  DROPPING:    'dropping',
};

const MAX_ROT_ATTEMPTS   = 8;  // safety cap on rotation presses
const MAX_TRANS_ATTEMPTS = 16; // safety cap on translation presses
const FRAME_DELAY        = 1;  // frames between input taps (1 = key_down this frame, key_up next frame)
const POST_LOCK_DELAY    = 4;  // frames to wait after hard-drop before entering _handleDropping.
                               // Short: the ARE / line-clear timing is handled by the
                               // ori-change detection in _handleDropping itself.
const DROPPING_TIMEOUT   = 50; // extra frames to wait when same-ori consecutive pieces / line-clear animation
const NAV_START_INTERVAL = 40; // frames between Start presses while in menus / game-over

// ── Bot classes ──────────────────────────────────────────────────────────────

export class TetrisBot {
  constructor() {
    this._state          = S.IDLE;
    this._frameDelay     = 0;
    this._pendingRelease = -1;  // button to release at start of next tick
    this._lastOri        = -1;  // last seen C203 value that was acted on
    this._prevOri        = -1;  // C203 value from the previous tick (stability guard)
    this._targetRot      = 0;
    this._targetLeft     = 0;
    this._rotAttempts    = 0;
    this._transAttempts  = 0;
    this._replanAttempts = 0;   // how many times we've re-planned for this piece
    this._droppingWait   = 0;   // frames waited in DROPPING (for DROPPING_TIMEOUT fallback only)
    this._preDropNextOri   = undefined; // ADDR_NEXT_ORI snapshot (kept for diagnostics)
    this._preDropRngPtr    = undefined; // ADDR_RNG_PTR snapshot at _beginDrop time
    this._preDropRngResult = undefined; // ADDR_RNG_RESULT ($FFAE) snapshot at _beginDrop time
    this._preDropBoard     = null;      // bitboard snapshot at _beginDrop time
    this._preDropRawBoard  = null;      // raw board bytes snapshot at _beginDrop time (diagnostic)
    this._statusMsg      = 'idle';
    // Random initial delay simulates human variation at the title screen.
    // This shifts the rDIV phase so GetRandom (reading rDIV at piece spawn) produces
    // a different piece sequence each game without touching the ROM RNG algorithm.
    this._navTimer       = Math.floor(Math.random() * 256);
    this._autoMenuNav    = false;
    this._totalDrops     = 0;   // pieces dropped
    this._misdropCount   = 0;   // pieces that landed at wrong col or rot
    this._pauseRequested = false; // set true when a misdrop is detected
    this._ppsLimit       = Infinity; // pieces per second cap (Infinity = uncapped)
    this._lastDropMs     = 0;   // performance.now() timestamp of last completed drop
    this._softDropMode   = false; // true = use Down hold instead of Up tap (original ROM)
    this._holdingDown    = false; // true while soft-dropping (Down held across frames)
    // Input delay (frames between key_down and the emulator sampling it).
    // 0 for local play; WGL_INPUT_DELAY (2) for WebGBLink lockstep.
    // Not reset on reset() — it's a mode-level setting.
    this._inputDelay     = 0;
  }

  /** Set input-sampling delay in frames (0 = local, 2 = WebGBLink lockstep). */
  setInputDelay(delay) { this._inputDelay = delay; }

  /**
   * Low-level move-finder used by all internal state handlers.
   * Subclasses can override this to plug in a different heuristic.
   */
  _findBestMove(emu, fromCol, forceRot = -1) {
    return findBestMove(emu, fromCol, forceRot);
  }

  /**
   * Set the pieces-per-second speed cap.  Pass Infinity (or 0 for blocked).
   * @param {number} pps
   */
  setPps(pps) {
    this._ppsLimit = (isFinite(pps) && pps >= 0) ? pps : Infinity;
  }

  /** Enable/disable soft-drop mode (Down-hold instead of Up-tap for dropping). */
  setSoftDropMode(enabled) { this._softDropMode = !!enabled; }

  /**
   * Returns true (and clears the flag) if a misdrop was detected since the
   * last call.  index.js checks this after tick() to auto-pause the emulator.
   */
  consumePauseRequest() {
    const v = this._pauseRequested;
    this._pauseRequested = false;
    return v;
  }

  /** Human-readable state string for the UI. */
  get status() {
    if (this._totalDrops === 0) return this._statusMsg;
    return `${this._statusMsg} | misdrops: ${this._misdropCount}/${this._totalDrops}`;
  }

  /** Bot mode/strategy label, or null if not applicable. */
  get mode() { return null; }

  /** Current action label. */
  get action() { return this._statusMsg; }

  /** Misdrop stats: { count, total }. */
  get misdropStats() { return { count: this._misdropCount, total: this._totalDrops }; }

  /**
   * Advance the bot by one game frame.
   * @param {object} emu        - the GbEmu WASM instance
   * @param {string} gameState  - current state from detectGameState()
   *   'splash' | 'title' | 'submenu-gametype' | 'submenu-level' |
   *   'in-game' | 'paused' | 'game-over'
   */
  tick(emu, gameState) {
    // Release any button that was tapped last tick (held for exactly one frame).
    if (this._pendingRelease >= 0) {
      emu.key_up(this._pendingRelease);
      this._pendingRelease = -1;
    }
    // Keep Down held across frames during soft drop (re-pressed after any release).
    if (this._holdingDown) emu.key_down(5);

    // ── Menu / non-playing states: press Start to advance ──────────────────
    if (gameState === 'paused' || gameState === 'win') {
      this._statusMsg = gameState === 'win' ? 'type-b win (idle)' : 'paused';
      return;
    }
    if (gameState !== 'in-game') {
      this._handleNav(emu, gameState);
      return;
    }

    // ── In-game: run piece-placement logic ─────────────────────────────────
    if ((emu.read_mem(ADDR_C204) & 0x80) === 0) return;

    if (this._frameDelay > 0) {
      this._frameDelay--; return;
    }

    const ori = emu.read_mem(ADDR_CUR_ORI);

    switch (this._state) {
      case S.IDLE:        this._handleIdle(emu, ori);        break;
      case S.ROTATING:    this._handleRotating(emu, ori);    break;
      case S.TRANSLATING: this._handleTranslating(emu, ori); break;
      case S.DROPPING:    this._handleDropping(emu, ori);    break;
    }
  }

  /**
   * Release all held inputs and return to IDLE.
   * Call when the game ends, is reset, or the bot is toggled off.
   */
  reset(emu) {
    if (this._pendingRelease >= 0 && emu) { emu.key_up(this._pendingRelease); }
    if (this._holdingDown && emu) { emu.key_up(5); }
    this._holdingDown    = false;
    this._state          = S.IDLE;
    this._frameDelay     = 0;
    this._pendingRelease = -1;
    this._lastOri        = -1;
    this._prevOri        = -1;
    this._rotAttempts    = 0;
    this._transAttempts  = 0;
    this._replanAttempts = 0;
    this._droppingWait   = 0;
    this._statusMsg      = 'idle';
    this._navTimer       = Math.floor(Math.random() * 256);
    this._pauseRequested = false;
    // Do NOT reset _totalDrops, _misdropCount, or _lastLockMs here.
    // These are running counters used for logging and the status display.
    // Spurious reset() calls during gameplay (transient game-state flaps)
    // would otherwise reset the drop counter mid-game and produce many
    // (first) entries in the lock timing log.
  }

  /**
   * Reset per-game statistics (drop count, misdrop count, lock timestamp).
   * Call this when a new game definitively begins (transition to in-game).
   */
  resetStats() {
    this._totalDrops  = 0;
    this._misdropCount = 0;
    this._lastDropMs  = 0;
  }

  // ── Navigation handler ──────────────────────────────────────────────────────

  /**
   * Handle all non-playing states by tapping Start every NAV_START_INTERVAL frames.
   * This drives: splash → title → game-type menu → level select → in-game,
   * and auto-restarts after game-over.
   */
  setAutoMenuNav(enabled) {
    this._autoMenuNav = !!enabled;
  }

  _handleNav(emu, gameState) {
    if (!this._autoMenuNav) {
      const label = {
        splash: 'splash (manual)',
        title: 'title (manual)',
        'submenu-gametype': 'game type (manual)',
        'submenu-level': 'level select (manual)',
        'game-over': 'game over (manual)',
      }[gameState] ?? 'menu (manual)';
      this._statusMsg = label;
      this._state = S.IDLE;
      this._lastOri = -1;
      return;
    }

    if (gameState === 'splash') {
      this._statusMsg = 'navigating (splash)';
      // Reset piece state so we start fresh when in-game begins
      this._state   = S.IDLE;
      this._lastOri = -1;
      if (--this._navTimer > 0) return;
      this._navTimer = NAV_START_INTERVAL;
      this._tap(emu, 3); // Start skips the splash screen
      return;
    }

    // Reset piece-placement state whenever we leave in-game
    this._state       = S.IDLE;
    this._lastOri     = -1;
    this._frameDelay  = 0;

    const label = {
      'title':            'navigating (title)',
      'submenu-gametype': 'navigating (game type)',
      'submenu-level':    'navigating (level select)',
      'game-over':        'restarting (game over)',
      'paused':           'paused',
    }[gameState] ?? 'navigating';
    this._statusMsg = label;

    if (--this._navTimer > 0) return;
    this._navTimer = NAV_START_INTERVAL;

    // Tap Start to advance past current screen
    this._tap(emu, 3); // Start = button index 3
  }

  // ── State handlers ──────────────────────────────────────────────────────────

  _handleIdle(emu, ori) {
    this._statusMsg = 'idle';
    if (ori !== this._lastOri) {
      // Stability guard: require the same ori on two consecutive ticks before
      // acting.  In 2P mode the address can flicker mid-ARE; one extra frame
      // of confirmation prevents a rapid replan/gravity-lock loop.
      if (ori !== this._prevOri) {
        this._prevOri = ori;
        return; // wait one more frame to confirm
      }
      this._prevOri = ori;
      // ── PPS throttle ──────────────────────────────────────────────────
      if (this._ppsLimit === 0) {
        this._statusMsg = 'idle (paused)';

        return;
      }
      if (isFinite(this._ppsLimit) && this._lastDropMs > 0) {
        const elapsed = performance.now() - this._lastDropMs;
        const needed  = 1000 / this._ppsLimit;
        if (elapsed < needed) {
          this._statusMsg = 'idle';
          return;
        }
      }
      // ── First-piece diagnostic (once per game, visible in console) ────
      if (this._totalDrops === 0) {
        const c204 = emu.read_mem(ADDR_C204);
        const pxX  = SQ_ADDRS.map(([, xa]) => emu.read_mem(xa).toString(16).padStart(2, '0')).join(' ');
        console.log(`[bot] first piece: ori=0x${ori.toString(16).padStart(2,'0')} C204=0x${c204.toString(16).padStart(2,'0')} pixX=[${pxX}]`);
      }
      // ─────────────────────────────────────────────────────────────────
      this._lastOri        = ori;
      this._replanAttempts = 0; // fresh piece — reset replan budget
      this._plan(emu, ori);
    } else {
      this._prevOri = ori;
    }
  }

  /**
   * Read the 4 active-piece squares from WRAM and compare to SHAPES.
   * Logs a warning if the actual piece layout doesn't match our definition.
   * This fires once per new piece at spawn.
   */
  _verifyShape(emu, ori) {
    const info = oriInfo(ori);
    if (!info) { console.warn(`[bot] _verifyShape: no oriInfo for ori=0x${ori.toString(16)}`); return; }

    // Read pixel Y/X for each of the 4 squares
    const squares = SQ_ADDRS.map(([yAddr, xAddr]) => {
      const py = emu.read_mem(yAddr);
      const px = emu.read_mem(xAddr);
      const row = Math.round((py - PIX_Y_OFF) / PIX_CELL);
      const col = Math.round((px - PIX_X_OFF) / PIX_CELL);
      return [row, col];
    });

    // Sanity check: if the game is mid line-clear or ARE, the pixel registers
    // are repurposed and return garbage (e.g. all at row 0, duplicate coords).
    // Skip verification in that case.
    const uniqueCoords = new Set(squares.map(([r, c]) => `${r},${c}`)).size;
    const allAtTopRow  = squares.every(([r]) => r <= 0);
    if (uniqueCoords < 4 || allAtTopRow) return;

    // Normalise to min-row=0, min-col=0 (same as SHAPES format)
    const minRow = Math.min(...squares.map(([r]) => r));
    const minCol = Math.min(...squares.map(([, c]) => c));
    const actual = squares
      .map(([r, c]) => [r - minRow, c - minCol])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const expected = [...SHAPES[info.typeIdx][info.rot]]
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    const match = actual.length === expected.length &&
      actual.every(([r, c], i) => expected[i][0] === r && expected[i][1] === c);

    const pieceName = ['I','O','T','S','Z','L','J'][info.typeIdx] ?? '?';
    if (!match) {
      console.warn(
        `[bot] SHAPE MISMATCH ori=0x${ori.toString(16)} type=${pieceName} rot=${info.rot}` +
        `\n  expected: ${JSON.stringify(expected)}` +
        `\n  actual:   ${JSON.stringify(actual)}`
      );
    }
  }

  /** Compute the best move and begin executing it. */
  _plan(emu, ori) {
    const curLeft = this._pieceLeftCol(emu);

    // Emergency: replanned twice already — last-resort: find best column for
    // the rotation the piece currently has (no further rotation attempts).
    if (this._replanAttempts >= 2) {
      const info = oriInfo(ori);
      const currentRot = info ? info.rot : 0;
      const lastResort = this._findBestMove(emu, undefined, currentRot);
      this._replanAttempts = 0;
      if (lastResort) {
        this._targetRot     = currentRot;
        this._targetLeft    = lastResort.leftCol;
        this._transAttempts = 0;
        this._state         = S.TRANSLATING;
        this._statusMsg     = 'translating (last-resort)';
      } else {
        // Sync targets to actual position so misdrop detector doesn't fire on stale values.
        const infoE = oriInfo(ori);
        this._targetRot  = infoE ? infoE.rot : this._targetRot;
        this._targetLeft = curLeft;
        this._beginDrop(emu); // board full, nothing to do
      }
      return;
    }

    const move = this._findBestMove(emu, curLeft);
    if (!move) {
      // Sync targets to actual position so misdrop detector doesn't fire on stale values.
      const infoE = oriInfo(ori);
      this._targetRot  = infoE ? infoE.rot : this._targetRot;
      this._targetLeft = curLeft;
      this._beginDrop(emu);
      return;
    }

    this._replanAttempts++; // reset to 0 in IDLE after a successful drop

    const info = oriInfo(ori);
    const currentRot   = info ? info.rot : 0;
    this._targetRot    = move.rot;
    this._targetLeft   = move.leftCol;
    this._rotAttempts  = 0;
    this._transAttempts = 0;

    const rotNeeded = (this._targetRot - currentRot + 4) % 4;
    const pieceName = ['I','O','T','S','Z','L','J'][info?.typeIdx ?? -1] ?? '?';

    if (rotNeeded > 0) {
      this._state     = S.ROTATING;
      this._statusMsg = 'rotating';
    } else {
      this._state     = S.TRANSLATING;
      this._statusMsg = 'translating';
    }
  }

  _handleRotating(emu, ori) {
    this._statusMsg = 'rotating';
    const info = oriInfo(ori);
    // Guard: piece changed mid-rotation = natural lock happened before hard drop.
    if (!info || info.typeIdx !== oriInfo(this._lastOri)?.typeIdx) {
      console.warn(`[bot] GRAVITY LOCK during ROTATING — ori=0x${ori.toString(16)} lastOri=0x${this._lastOri.toString(16)} target rot=${this._targetRot}`);
      this._lastOri = -1;
      this._prevOri = -1; // force re-confirmation before next plan
      this._state   = S.IDLE;
      return;
    }

    if (info.rot === this._targetRot) {
      // Rotation complete — move to translation
      this._state     = S.TRANSLATING;
      this._statusMsg = 'translating';
      return;
    }

    if (this._rotAttempts >= MAX_ROT_ATTEMPTS) {
      // Piece can't rotate (NRS, no wall kicks).
      // Re-evaluate the best column for the rotation we actually have —
      // the original _targetLeft was computed for a different rotation shape.
      const bestForCurrentRot = this._findBestMove(emu, undefined, info.rot);
      this._targetRot     = info.rot;
      this._targetLeft    = bestForCurrentRot ? bestForCurrentRot.leftCol : this._pieceLeftCol(emu);
      this._transAttempts = 0;
      this._state         = S.TRANSLATING;
      this._statusMsg     = 'translating';
      return;
    }

    // Tap A (CW rotate) — release happens at the start of next tick.
    this._tap(emu, 0);
    this._rotAttempts++;
  }

  _handleTranslating(emu, ori) {
    this._statusMsg = 'translating';
    // Guard: if a new piece appeared while translating, restart.
    // Two cases:
    //   1. Different type → typeIdx mismatch (easy case)
    //   2. Same type but piece gravity-locked and new same-type piece spawned at
    //      rot=0 while we expected _targetRot → rot mismatch catches this.
    const info = oriInfo(ori);
    const rotMismatch = info && info.rot !== this._targetRot;
    if (!info || info.typeIdx !== oriInfo(this._lastOri)?.typeIdx || rotMismatch) {
      console.warn(`[bot] GRAVITY LOCK during TRANSLATING — ori=0x${ori.toString(16)} lastOri=0x${this._lastOri.toString(16)} target col=${this._targetLeft} rot=${this._targetRot}` + (rotMismatch ? ` (rot mismatch: got ${info.rot})` : ''));
      this._lastOri = -1;
      this._prevOri = -1; // force re-confirmation before next plan
      this._state   = S.IDLE;
      return;
    }
    const curLeft = this._pieceLeftCol(emu);
    const dx = this._targetLeft - curLeft;

    if (dx === 0) {
      // Reached target column — drop.
      this._beginDrop(emu);
      return;
    }

    if (this._transAttempts >= MAX_TRANS_ATTEMPTS) {
      // Piece is stuck (blocked by stack). Re-plan from current position,
      // but KEEP the current rotation — no time for more rotations on a tall board.
      const info2   = oriInfo(ori);
      const curRot  = info2 ? info2.rot : this._targetRot;
      const rescue  = this._findBestMove(emu, curLeft, curRot);
      if (!rescue || this._replanAttempts >= 2) {
        this._replanAttempts = 0;
        // Sync targets to actual position so misdrop detector doesn't fire on stale values.
        this._targetRot  = curRot;
        this._targetLeft = curLeft;
        this._beginDrop(emu);
      } else {
        this._replanAttempts++;
        this._targetLeft    = rescue.leftCol;
        this._transAttempts = 0;
        // _targetRot stays the same (curRot), no new rotation needed
      }
      return;
    }

    // Tap left/right — release happens at the start of next tick.
    this._tap(emu, dx < 0 ? 6 : 7);
    this._transAttempts++;
  }

  _beginDrop(emu) {
    // Hard drop: tap Up (button 4).
    // Then wait POST_LOCK_DELAY frames so the lock + any line-clear
    // animation fully settle in WRAM before we plan the next piece.

    // ── Shape verification (fires here: pixels are stable by drop time) ────
    const ori  = emu.read_mem(ADDR_CUR_ORI);
    this._verifyShape(emu, ori);

    // ── Misdrop detection ────────────────────────────────────────────────
    // Check actual piece position against the planned target RIGHT NOW,
    // while the piece is still live (before it locks).
    const actualLeft = this._pieceLeftCol(emu);
    const info       = oriInfo(ori);
    const actualRot  = info ? info.rot : -1;
    this._totalDrops++;
    if (actualLeft !== this._targetLeft || actualRot !== this._targetRot) {
      this._misdropCount++;
      const board = readBitboard(emu);
      const heights = columnHeights(board);
      const criticalBoard = heights.some(h => h >= BOARD_ROWS - 1);
      const pieceName2 = ['I','O','T','S','Z','L','J'][info?.typeIdx ?? -1] ?? '?';

      // Read all 4 square pixel positions for diagnostics
      const squares = SQ_ADDRS.map(([yAddr, xAddr]) => ({
        py: emu.read_mem(yAddr), px: emu.read_mem(xAddr),
        row: Math.floor((emu.read_mem(yAddr) - PIX_Y_OFF) / PIX_CELL),
        col: Math.floor((emu.read_mem(xAddr) - PIX_X_OFF) / PIX_CELL),
      }));

      const snap = {
        misdropNum:    this._misdropCount,
        totalDrops:    this._totalDrops,
        wantedCol:     this._targetLeft,
        wantedRot:     this._targetRot,
        actualCol:     actualLeft,
        actualRot,
        piece:         pieceName2,
        ori:           `0x${ori.toString(16)}`,
        criticalBoard,
        heights:       Array.from(heights),
        squares,
        boardBits:     Array.from(board),
        rotAttempts:   this._rotAttempts,
        transAttempts: this._transAttempts,
        replanAttempts:this._replanAttempts,
        botState:      this._state,
        timestamp:     new Date().toISOString(),
      };

      // Store in global for inspection after pause
      if (typeof window !== 'undefined') {
        window.__lastMisdrop = snap;
        if (!window.__allMisdrops) window.__allMisdrops = [];
        window.__allMisdrops.push(snap);
      }

      console.warn(
        `[bot] MISDROP #${this._misdropCount}/${this._totalDrops}` +
        ` — wanted col=${this._targetLeft} rot=${this._targetRot}` +
        ` — got col=${actualLeft} rot=${actualRot}` +
        ` type=${pieceName2}` +
        `\n  col heights: [${heights.join(',')}]` +
        `\n  squares: ${squares.map(s => `(r${s.row},c${s.col})`).join(' ')}` +
        `\n  rotAttempts=${this._rotAttempts} transAttempts=${this._transAttempts} replanAttempts=${this._replanAttempts} state=${this._state}` +
        (criticalBoard ? '  [CRITICAL BOARD]' : '')
      );
      // Always pause so we can inspect the board state.
      this._pauseRequested = true;
    }
    // ─────────────────────────────────────────────────────────────────────

    if (this._softDropMode) {
      // Soft drop: hold Down until the piece locks and the next piece spawns.
      emu.key_down(5);
      this._holdingDown = true;
      // No POST_LOCK_DELAY: _handleDropping must run every frame to keep Down held
      // and detect the new piece as soon as it appears.
      this._frameDelay = 0;
    } else {
      // Hard drop: tap Up (button 4) — piece teleports instantly.
      this._tap(emu, 4);
      this._frameDelay = POST_LOCK_DELAY; // overrides _tap's FRAME_DELAY
    }
    // Update _lastOri to the ACTUAL dropped ori (after any rotations).
    // _handleDropping compares against this to know when the new piece has
    // appeared in C203. Without this, a rotated piece (e.g. L at rot=2 = 0x02)
    // would cause _handleDropping to exit during ARE because 0x02 !== spawn ori 0x00.
    this._lastOri = ori;
    // Snapshot raw SQ_ADDRS bytes at drop time for ARE false-positive detection.
    this._preDropSqSnapshot = SQ_ADDRS.map(([y, x]) => (emu.read_mem(y) << 8) | emu.read_mem(x));
    // C213 snapshot (for diagnostics — NOT reliable as spawn signal: same-value collisions common).
    this._preDropNextOri = emu.read_mem(ADDR_NEXT_ORI);
    // RNG pointer snapshot: NEXT_PIECE_SPAWN always increments $FFB0 by 2, so any change
    // means a new piece has spawned — regardless of type or column.
    this._preDropRngPtr    = emu.read_mem(ADDR_RNG_PTR);
    // $FFAE: last DIV-RNG output, updated at every spawn in DIV-RNG mode ($FFE4=0).
    this._preDropRngResult = emu.read_mem(ADDR_RNG_RESULT);
    // Board snapshot: if the board changes between _beginDrop and detection →
    // piece A locked → used as extra spawn signal for same-type same-column cases.
    this._preDropBoard     = readBitboard(emu);
    this._preDropRawBoard  = emu.read_mem_range(BOARD_BASE, BOARD_ROWS * BOARD_STRIDE);

    this._state     = S.DROPPING;
    this._statusMsg = 'dropping';
  }

  _handleDropping(emu, ori) {
    // New-piece detection. Two modes depending on drop style:
    //
    // ── SOFT DROP mode (original ROM: Down-hold) ─────────────────────────────
    //  sqChanged is NOT usable: the piece moves frame by frame, so SQ_ADDRS
    //  differs from the pre-drop snapshot within 1-2 frames → false positive.
    //  Only use:
    //   A) oriChanged && atTop   — new piece type or rotation at spawn row
    //   D) spawnDetected && shapeMatch — RNG ptr changed → new piece (handles same-type)
    //   F) hard timeout fallback
    //
    // ── HARD DROP mode (hacked ROM: Up-tap) ──────────────────────────────────
    //  A) oriChanged && atTop
    //  B) sqChanged && shapeMatch — handles same-ori consecutive pieces
    //  D) spawnDetected && shapeMatch
    //  E) sameTypeAtSpawn — same ori/sq/shape at top on wait=0
    //  F) hard timeout fallback
    const oriChanged    = (ori !== this._lastOri);
    const atTop         = (this._pieceMinRow(emu) <= 2);
    const spawnDetected = (this._preDropRngPtr !== undefined)
                        && (emu.read_mem(ADDR_RNG_PTR) !== this._preDropRngPtr);
    const shapeMatch    = this._atTopShapeMatchesOri(emu, ori);

    let newPiece;
    if (this._softDropMode) {
      newPiece = (oriChanged && atTop) || (spawnDetected && shapeMatch);
    } else {
      const sqChanged = this._preDropSqSnapshot
                      ? SQ_ADDRS.some(([y,x],i) => ((emu.read_mem(y)<<8)|emu.read_mem(x)) !== this._preDropSqSnapshot[i])
                      : true;
      const sameTypeAtSpawn = !oriChanged && !sqChanged && shapeMatch && atTop
                            && this._droppingWait === 0;
      newPiece = (oriChanged && atTop)
               || ((spawnDetected || sqChanged) && shapeMatch)
               || sameTypeAtSpawn;
    }

    if (!newPiece && this._droppingWait < DROPPING_TIMEOUT) {
      this._droppingWait++;
      return;
    }
    // New piece detected (or timeout) — release soft drop if held.
    if (this._holdingDown) {
      emu.key_up(5);
      this._holdingDown = false;
    }
    this._droppingWait = 0;
    this._lastOri    = -1;
    this._lastDropMs = performance.now();
    this._state      = S.IDLE;
  }

  // ── Input helper ───────────────────────────────────────────────────────────

  /**
   * Press a button for exactly one frame.
   * key_down is called now; key_up is deferred to the start of the next tick()
   * (after run_frame() has had a chance to sample the pressed state).
   */
  _tap(emu, btn) {
    emu.key_down(btn);
    this._pendingRelease = btn;
    this._frameDelay     = FRAME_DELAY + this._inputDelay;
  }

  // ── Piece-coordinate helpers ────────────────────────────────────────────────

  /**
   * Returns true when all 4 active-piece pixel registers show a freshly-spawned
   * piece: 4 distinct positions with minRow ≤ 2.
   *
   * The `minRow > 2` guard rejects pieces still sitting at the bottom
   * (mid-ARE or not yet locked).
   *
   * `unique === 4` rejects ARE garbage: zeroed registers all map to the same
   * coordinate (row -2, col -3), so uniqueCoords = 1 → false.
   *
   * Note: minRow may be -1 for pieces that spawn partially above the visible
   * board (e.g. vertical I-piece whose top cell is at pixY=8 → row=-1).
   * We deliberately allow negative minRow as long as unique === 4.
   */
  _pieceIsValidAtTop(emu) {
    const squares = SQ_ADDRS.map(([yAddr, xAddr]) => {
      const row = Math.floor((emu.read_mem(yAddr) - PIX_Y_OFF) / PIX_CELL);
      const col = Math.floor((emu.read_mem(xAddr) - PIX_X_OFF) / PIX_CELL);
      return [row, col];
    });
    const minRow = Math.min(...squares.map(([r]) => r));
    if (minRow > 2) return false; // piece not at top (still locked position or mid-fall)
    const unique = new Set(squares.map(([r, c]) => `${r},${c}`)).size;
    return unique === 4; // 4 distinct cells = real spawned piece
                         // ARE garbage: zeroed regs → all at same coord → unique=1 → false ✓
  }

  /**
   * Returns true when _pieceIsValidAtTop() passes AND the detected cell layout
   * matches the shape expected for `ori`.
   *
   * The caller must additionally gate on sqChanged (SQ_ADDRS differing from the
   * _preDropSqSnapshot) to avoid a false positive during ARE: the Game Boy retains
   * piece A's spawn coords in SQ_ADDRS throughout ARE, which are identical to piece B's
   * spawn coords for same-type consecutive pieces (O→O, I→I, etc.).
   */
  _atTopShapeMatchesOri(emu, ori) {
    if (!this._pieceIsValidAtTop(emu)) return false;
    const info = oriInfo(ori);
    if (!info) return false;
    const squares = SQ_ADDRS.map(([yAddr, xAddr]) => [
      Math.floor((emu.read_mem(yAddr) - PIX_Y_OFF) / PIX_CELL),
      Math.floor((emu.read_mem(xAddr) - PIX_X_OFF) / PIX_CELL),
    ]);
    const minRow = Math.min(...squares.map(([r]) => r));
    const minCol = Math.min(...squares.map(([, c]) => c));
    const actual = squares
      .map(([r, c]) => [r - minRow, c - minCol])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const expected = [...SHAPES[info.typeIdx][info.rot]]
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return actual.length === expected.length &&
      actual.every(([r, c], i) => expected[i][0] === r && expected[i][1] === c);
  }

  /** Minimum board row among the 4 active-piece squares. */
  _pieceMinRow(emu) {
    let min = Infinity;
    for (const [yAddr] of SQ_ADDRS) {
      const row = Math.floor((emu.read_mem(yAddr) - PIX_Y_OFF) / PIX_CELL);
      if (row < min) min = row;
    }
    return min === Infinity ? 0 : min;
  }

  /** Leftmost board column among the 4 active-piece squares. */
  _pieceLeftCol(emu) {
    let min = Infinity;
    for (const [, xAddr] of SQ_ADDRS) {
      const col = Math.floor((emu.read_mem(xAddr) - PIX_X_OFF) / PIX_CELL);
      if (col >= 0 && col < BOARD_COLS && col < min) min = col;
    }
    return min === Infinity ? 0 : min;
  }
}

/**
 * HybridBot — two-phase strategy bot.
 *
 * Switches between:
 *   - AttackerBot mode (clean board): 9-column stacking + Tetris focus
 *     Protects well_col, actively builds TeRe, fires I-piece when ready.
 *   - IntermediateBot mode (messy board): cleanup / downstack
 *     Standard holes/bumpiness heuristic, no well protection.
 *
 * Switch conditions (checked every piece, from references/src/main.rs):
 *   Always Intermediate if maxH > 16 (emergency).
 *   Use Attacker only if: maxH ≤ 14 AND holes ≤ 3 AND bumpiness ≤ 20.
 */
export class HybridBot extends TetrisBot {
  constructor() {
    super();
    this._hybridMode = 'intermediate'; // 'attacker' | 'intermediate'
  }

  reset(emu) {
    super.reset(emu);
    this._hybridMode = 'intermediate';
  }

  _findBestMove(emu, fromCol, forceRot = -1) {
    const bb      = readBitboard(emu);
    const heights = columnHeights(bb);
    const useAttacker = hybridShouldUseAttacker(bb, heights);
    this._hybridMode = useAttacker ? 'attacker' : 'intermediate';

    // ── I-piece fast path (Attacker mode only) ──────────────────────────
    // When TeRe ≥ threshold, immediately fire the I-piece into the well
    // without running the full search — mirrors AttackerBot.decide_move().
    if (useAttacker && forceRot < 0) {
      const ori  = emu.read_mem(ADDR_CUR_ORI);
      const info = oriInfo(ori);
      // typeIdx 0 = I-piece
      if (info && info.typeIdx === 0) {
        const tere = calculateTere(bb);
        if (tere >= HYBRID_TERE_THRESHOLD) {
          // Right well (col 9): I-piece drops vertically (rot=1), leftCol=6
          // so the piece occupies cols 6–9? No: vertical I rot=1 shape is
          // [[0,0],[1,0],[2,0],[3,0]] — 1 col wide, leftCol = well_col.
          // Left well (col 0): rot=1, leftCol=0.
          const wellCol = HYBRID_WELL_COL;
          const iRot    = 1; // vertical orientation
          const iLeft   = wellCol; // 1-wide, placed exactly in the well

          // Verify the wall adjacent to the well is tall enough
          const wallCols = wellCol === 9
            ? [5,6,7,8]  // check cols to the left of a right well
            : [1,2,3,4]; // check cols to the right of a left well
          const wallH   = Math.min(...wallCols.map(c => heights[c]));
          const wellH   = heights[wellCol];
          if (wallH > wellH && wallH >= wellH + 4) {
            // Confirm the well column is clear above the landing point
            // by checking that no cell in the well column is set above wellH
            let wellClear = true;
            for (let r = 0; r < BOARD_ROWS - wellH; r++) {
              if (bb[r] & (1 << wellCol)) { wellClear = false; break; }
            }
            if (wellClear) {
              console.info(`[hybrid/attacker] I-piece fast path — TeRe=${tere.toFixed(1)}%`);
              return { rot: iRot, leftCol: iLeft };
            }
          }
        }
      }
    }

    const evaluateFn = useAttacker ? attackerEvaluate : intermediateEvaluate;
    return findBestMove(emu, fromCol, forceRot, evaluateFn);
  }

  get status() {
    const base = super.status;
    return `[${this._hybridMode}] ${base}`;
  }

  get mode() { return this._hybridMode; }
}

/**
 * IntermediateBot — always uses the IntermediateBot heuristic.
 * Simple cleanup strategy: minimise max height, holes, bumpiness.
 */
export class IntermediateBot extends TetrisBot {
  _findBestMove(emu, fromCol, forceRot = -1) {
    return findBestMove(emu, fromCol, forceRot, intermediateEvaluate);
  }

  get mode() { return 'intermediate'; }
}

