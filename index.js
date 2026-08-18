/**
 * GBmul Web – main JavaScript glue.
 *
 * Build with:  wasm-pack build --target web --out-dir www/pkg
 * Then serve:  python3 -m http.server --directory www
 */
// Immediate load marker (visible even if the rest of the module fails).
console.log("[gbmul] index.js loading — expect ui 372 / 202608151600A");
import init, { GbEmu, GbEmuPair, RustBot } from "./pkg/gbmul_wasm.js?v=173";
// Commented out JS bot imports while testing RustBot to reduce console noise.
// Uncomment when switching back to USE_RUST_BOT = false.
// import { HybridBot, IntermediateBot } from "./bot.js?v=314";
// import { MeatfighterBot } from "./bot-meatfighter.js?v=6";
import { GbShader } from "./shader.js?v=28";
import { WebGBLink, discoverLanIPv4 } from "./webgblink.js?v=6";

/**
 * Build stamps shown at the bottom of the ☰ menu (reload confirmation).
 * Keep in sync with index.js?v= / style.css?v= / wasm ?v= / sw.js / bot.js banner.
 */
const GBMUL_BUILD = {
  ui:    379,              // index.js?v=
  css:   99,               // style.css?v=
  wasm:  173,              // gbmul_wasm*?v=
  stamp: '202608151600A',  // human-readable; mirror bot.js console banner
};

function fillAppVersionFooter() {
  const el = document.getElementById('app-version-text');
  if (!el) return;
  el.textContent =
    `${GBMUL_BUILD.stamp}  ·  ui ${GBMUL_BUILD.ui}  ·  css ${GBMUL_BUILD.css}  ·  wasm ${GBMUL_BUILD.wasm}`;
  el.title =
    "Alt+click = purge service worker + caches. " +
    "Stuck on an old stamp? open ?purge=1  or run __gbmulPurgeCache() in the console.";
  // Alt+click version stamp → nuclear cache clear (dev escape hatch).
  const foot = document.getElementById("app-version");
  if (foot && !foot.dataset.purgeBound) {
    foot.dataset.purgeBound = "1";
    foot.style.cursor = "pointer";
    foot.addEventListener("click", (e) => {
      if (!e.altKey) return;
      e.preventDefault();
      if (typeof window.__gbmulPurgeCache === "function") {
        setStatus("Purging service worker + caches…");
        window.__gbmulPurgeCache({ reload: true });
      } else {
        location.search = (location.search ? location.search + "&" : "?") + "purge=1";
      }
    });
  }
}
fillAppVersionFooter();

const W = 160, H = 144;
let scale = 2;

// ── canvas setup ─────────────────────────────────────────────────────────────
const canvas    = document.getElementById("screen");
const ctx       = canvas.getContext("2d");
const canvasBot = document.getElementById("screen-bot");
const ctxBot    = canvasBot.getContext("2d");

const screenWrap    = document.getElementById("screen-wrap");
const screenWrapBot = document.getElementById("screen-wrap-bot");
const dualWrap      = document.getElementById("dual-wrap");
const canvasGl      = document.getElementById("screen-gl");
const canvasGlBot   = document.getElementById("screen-gl-bot");

function applyScale(s) {
  scale = s;
  // At zoom 1x, render at 2x internally so the dot-matrix shader has room for gaps,
  // then CSS-downscale to 1x for display (bilinear on GL canvas = RetroArch filter_linear).
  const internalScale = s < 2 ? 2 : s;
  const cssW = W * s;
  const cssH = H * s;

  canvas.width     = W * internalScale;
  canvas.height    = H * internalScale;
  canvas.style.width  = cssW + "px";
  canvas.style.height = cssH + "px";

  // Bot canvas: displayed at scale/2, rendered internally at min 2x so shader has room for gaps
  const botDisplayScale   = s / 2;
  const botInternalScale  = Math.max(2, Math.ceil(botDisplayScale));
  const botW = Math.round(W * botDisplayScale);
  const botH = Math.round(H * botDisplayScale);
  canvasBot.width       = Math.round(W * botInternalScale);
  canvasBot.height      = Math.round(H * botInternalScale);
  canvasBot.style.width  = botW + "px";
  canvasBot.style.height = botH + "px";
  ctx.imageSmoothingEnabled    = false;
  ctxBot.imageSmoothingEnabled = false;

  // GL canvases: bilinear when CSS-downscaling (internal > display), pixelated otherwise
  canvasGl.style.imageRendering    = s < 2 ? "auto" : "";
  canvasGlBot.style.imageRendering = botInternalScale > botDisplayScale ? "auto" : "";

  const r    = (4 * scale).toFixed(1) + "px";
  const rBot = (2 * scale).toFixed(1) + "px";
  screenWrap.style.borderRadius    = r;
  screenWrapBot.style.borderRadius = rBot;
  screenWrap.querySelector("canvas").style.borderRadius    = r;
  screenWrapBot.querySelector("canvas").style.borderRadius = rBot;
  // Gap between the two screens = 1/10 of bot width
  dualWrap.style.gap = Math.round(botW / 10) + "px";
  // Scale shadow distances proportionally (base values at scale=1: offset 1.5px, blur 3px)
  const root = document.documentElement;
  root.style.setProperty("--sh-off",  (1.5 * scale).toFixed(1) + "px");
  root.style.setProperty("--sh-blur", (3   * scale).toFixed(1) + "px");
  // ROM splash hit-target tracks the LCD size/position.
  if (typeof syncRomDropzoneHit === "function") syncRomDropzoneHit();
}

// ── zoom control ─────────────────────────────────────────────────────────────
const zoomSlider = document.getElementById("zoom-slider");
const zoomValue  = document.getElementById("zoom-value");

// Restore saved zoom (clamp to integer in case of old stored decimal value)
const savedZoom = Math.round(parseFloat(localStorage.getItem("gbmul_zoom") ?? "2"));
zoomSlider.value = savedZoom;
zoomValue.textContent = savedZoom + "×";
applyScale(savedZoom);

zoomSlider.addEventListener("input", () => {
  const v = parseInt(zoomSlider.value, 10);
  zoomValue.textContent = v + "×";
  applyScale(v);
  localStorage.setItem("gbmul_zoom", v);
});

// ── shader passes ─────────────────────────────────────────────────────────────
const shaderSlider = document.getElementById("shader-slider");
const shaderValue  = document.getElementById("shader-value");

const SHADER_DESCS = ['Off', 'Pass 0', 'Pass 1', 'Pass 2+3', 'Full'];

let gbShader = null;
let gbShaderBot = null;
let shaderLevel = parseInt(localStorage.getItem("gbmul_shader_level") ?? "4", 10);

try {
  gbShader    = new GbShader(canvasGl);
  gbShaderBot = new GbShader(canvasGlBot);
} catch (e) {
  console.warn("[shader] WebGL2 unavailable:", e);
}

function applyShaderLevel(level) {
  shaderLevel = gbShader ? level : 0;
  shaderSlider.value = shaderLevel;
  shaderValue.textContent = SHADER_DESCS[shaderLevel] ?? shaderLevel;
  canvasGl.classList.toggle("shader-active", shaderLevel > 0);
  canvasGlBot.classList.toggle("shader-active", shaderLevel > 0);
  localStorage.setItem("gbmul_shader_level", shaderLevel);
}

shaderSlider.addEventListener("input", () => {
  applyShaderLevel(parseInt(shaderSlider.value, 10));
});

if (!gbShader) shaderSlider.disabled = true;
applyShaderLevel(shaderLevel);

// ── pre-shader gray levels ────────────────────────────────────────────────────
{
  const DEFAULTS = [255, 153, 77, 0];
  const KEYS = DEFAULTS.map((_, i) => `gbmul_gl_${i}`);

  function applyGrayLevels() {
    const levels = DEFAULTS.map((d, i) => {
      const s = localStorage.getItem(KEYS[i]);
      return s !== null ? parseInt(s, 10) : d;
    });
    if (gbShader)    gbShader.grayLevels    = levels;
    if (gbShaderBot) gbShaderBot.grayLevels = levels;
    levels.forEach((v, i) => {
      document.getElementById(`gl-val-${i}`).textContent = v;
      document.getElementById(`gl-${i}`).value = v;
    });
  }

  applyGrayLevels();

  DEFAULTS.forEach((_, i) => {
    document.getElementById(`gl-${i}`).addEventListener("input", e => {
      localStorage.setItem(KEYS[i], e.target.value);
      document.getElementById(`gl-val-${i}`).textContent = e.target.value;
      if (gbShader)    gbShader.grayLevels[i]    = parseInt(e.target.value, 10);
      if (gbShaderBot) gbShaderBot.grayLevels[i] = parseInt(e.target.value, 10);
    });
    if (!gbShader) document.getElementById(`gl-${i}`).disabled = true;
  });

  document.getElementById("gray-levels-reset").addEventListener("click", () => {
    KEYS.forEach(k => localStorage.removeItem(k));
    applyGrayLevels();
  });
}

// ── shader brightness (CSS filter, uniform across all tones) ──────────────────
const brightnessSlider = document.getElementById("brightness-slider");
const brightnessValue  = document.getElementById("brightness-value");

{
  const saved = parseFloat(localStorage.getItem("gbmul_brightness") ?? "1.5");
  brightnessSlider.value = saved;
  brightnessValue.textContent = saved.toFixed(2);
  const bFilter = saved === 1.0 ? "" : `brightness(${saved})`;
  canvasGl.style.filter    = bFilter;
  canvasGlBot.style.filter = bFilter;
}

brightnessSlider.addEventListener("input", () => {
  const v = parseFloat(brightnessSlider.value);
  brightnessValue.textContent = v.toFixed(2);
  const bFilter = v === 1.0 ? "" : `brightness(${v})`;
  canvasGl.style.filter    = bFilter;
  canvasGlBot.style.filter = bFilter;
  localStorage.setItem("gbmul_brightness", v);
});

if (!gbShader) brightnessSlider.disabled = true;

// ── shadow sliders (per-zoom) ─────────────────────────────────────────────────
{
  // Defaults tuned empirically per zoom level
  const SHADOW_DEFAULTS = {
    2: { offset: 1.1, darkness: 1.8, softness: 1.4 },
    3: { offset: 0.2, darkness: 3.4, softness: 1.3 },
    4: { offset: 0.8, darkness: 4.3, softness: 1.3 },
  };
  const shadowDefaultFor = (zoom, key) => {
    const z = Math.min(Math.max(Math.round(zoom), 2), 4);
    return SHADOW_DEFAULTS[z][key];
  };

  const offsetSlider  = document.getElementById("shadow-offset-slider");
  const offsetValue   = document.getElementById("shadow-offset-value");
  const opacitySlider = document.getElementById("shadow-opacity-slider");
  const opacityValue  = document.getElementById("shadow-opacity-value");
  const sharpSlider   = document.getElementById("shadow-sharpness-slider");
  const sharpValue    = document.getElementById("shadow-sharpness-value");

  const applyShadowForZoom = (zoom) => {
    const offset   = parseFloat(localStorage.getItem(`gbmul_shadow_offset_z${zoom}`)   ?? shadowDefaultFor(zoom, "offset"));
    const darkness = parseFloat(localStorage.getItem(`gbmul_shadow_darkness_z${zoom}`) ?? shadowDefaultFor(zoom, "darkness"));
    const softness = parseFloat(localStorage.getItem(`gbmul_shadow_softness_z${zoom}`) ?? shadowDefaultFor(zoom, "softness"));
    offsetSlider.value  = offset;   offsetValue.textContent  = offset.toFixed(1);
    opacitySlider.value = darkness; opacityValue.textContent = darkness.toFixed(1);
    sharpSlider.value   = softness; sharpValue.textContent   = softness.toFixed(1);
    const applyToShaders = (offset, darkness, softness) => {
      if (gbShader)    { gbShader.shadowOffset    = offset; gbShader.shadowStrength    = darkness; gbShader.shadowSoftness    = softness; }
      if (gbShaderBot) { gbShaderBot.shadowOffset = offset; gbShaderBot.shadowStrength = darkness; gbShaderBot.shadowSoftness = softness; }
    };
    applyToShaders(offset, darkness, softness);
  };

  applyShadowForZoom(savedZoom);

  zoomSlider.addEventListener("input", () => applyShadowForZoom(parseInt(zoomSlider.value, 10)));

  offsetSlider.addEventListener("input", () => {
    const v = parseFloat(offsetSlider.value);
    offsetValue.textContent = v.toFixed(1);
    if (gbShader)    gbShader.shadowOffset    = v;
    if (gbShaderBot) gbShaderBot.shadowOffset = v;
    localStorage.setItem(`gbmul_shadow_offset_z${zoomSlider.value}`, v);
  });

  opacitySlider.addEventListener("input", () => {
    const v = parseFloat(opacitySlider.value);
    opacityValue.textContent = v.toFixed(1);
    if (gbShader)    gbShader.shadowStrength    = v;
    if (gbShaderBot) gbShaderBot.shadowStrength = v;
    localStorage.setItem(`gbmul_shadow_darkness_z${zoomSlider.value}`, v);
  });

  sharpSlider.addEventListener("input", () => {
    const v = parseFloat(sharpSlider.value);
    sharpValue.textContent = v.toFixed(1);
    if (gbShader)    gbShader.shadowSoftness    = v;
    if (gbShaderBot) gbShaderBot.shadowSoftness = v;
    localStorage.setItem(`gbmul_shadow_softness_z${zoomSlider.value}`, v);
  });

  if (!gbShader) { offsetSlider.disabled = true; opacitySlider.disabled = true; sharpSlider.disabled = true; }
}

// ── panel opacity ─────────────────────────────────────────────────────────────
{
  const slider = document.getElementById("panel-opacity-slider");
  const label  = document.getElementById("panel-opacity-value");
  const saved  = parseInt(localStorage.getItem("gbmul_panel_opacity") ?? "75", 10);
  slider.value = saved;
  label.textContent = saved + "%";
  document.documentElement.style.setProperty("--panel-opacity", saved / 100);

  slider.addEventListener("input", () => {
    const v = parseInt(slider.value, 10);
    label.textContent = v + "%";
    document.documentElement.style.setProperty("--panel-opacity", v / 100);
    localStorage.setItem("gbmul_panel_opacity", v);
  });
}

// ── screen vertical position ──────────────────────────────────────────────────
{
  const slider = document.getElementById("screen-top-slider");
  const label  = document.getElementById("screen-top-value");
  const saved  = parseInt(localStorage.getItem("gbmul_screen_top") ?? "-112", 10);
  slider.value = saved;
  label.textContent = saved;
  document.documentElement.style.setProperty("--screen-top", saved + "px");

  slider.addEventListener("input", () => {
    const v = parseInt(slider.value, 10);
    label.textContent = v;
    document.documentElement.style.setProperty("--screen-top", v + "px");
    localStorage.setItem("gbmul_screen_top", v);
  });
}

// ── touch controls layout ─────────────────────────────────────────────────────
{
  const root = document.documentElement;
  const LS_KEY = "gbmul_tc_layout";

  const TC_VARS = [
    { id: "tc-dpad-size",   prop: "--tc-dpad-size",   unit: "px",  def: 52  },
    { id: "tc-dpad-bottom", prop: "--tc-dpad-bottom", unit: "px",  def: 20  },
    { id: "tc-dpad-left",   prop: "--tc-dpad-left",   unit: "px",  def: 12  },
    { id: "tc-ab-size",     prop: "--tc-ab-size",     unit: "px",  def: 68  },
    { id: "tc-ab-angle",    prop: "--tc-ab-angle",    unit: "deg", def: 29  },
    { id: "tc-ab-gap",      prop: "--tc-ab-gap",      unit: "px",  def: 21  },
    { id: "tc-ab-bottom",   prop: "--tc-ab-bottom",   unit: "px",  def: 82  },
    { id: "tc-ab-right",    prop: "--tc-ab-right",    unit: "px",  def: 12  },
    { id: "tc-mid-bottom",  prop: "--tc-mid-bottom",  unit: "px",  def: 0   },
    { id: "tc-mid-right",   prop: "--tc-mid-right",   unit: "px",  def: 174 },
  ];

  const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");

  for (const v of TC_VARS) {
    const slider = document.getElementById(v.id);
    const label  = document.getElementById(v.id + "-val");
    const val    = saved[v.id] ?? v.def;
    slider.value = val;
    label.textContent = val;
    root.style.setProperty(v.prop, val + v.unit);

    slider.addEventListener("input", () => {
      const n = parseInt(slider.value, 10);
      label.textContent = n;
      root.style.setProperty(v.prop, n + v.unit);
      saved[v.id] = n;
      localStorage.setItem(LS_KEY, JSON.stringify(saved));
    });
  }
}

// ── theme ─────────────────────────────────────────────────────────────────────
const html = document.documentElement;
const themeSelect = document.getElementById("theme-select");
const darkMQ = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(pref) {
  if (pref === "auto") {
    html.dataset.theme = darkMQ.matches ? "dark" : "light";
  } else {
    html.dataset.theme = pref;
  }
}

themeSelect.addEventListener("change", () => {
  localStorage.setItem("gbmul_theme", themeSelect.value);
  applyTheme(themeSelect.value);
});
darkMQ.addEventListener("change", () => {
  if (themeSelect.value === "auto") applyTheme("auto");
});

// Restore saved theme preference
const savedTheme = localStorage.getItem("gbmul_theme") || "auto";
themeSelect.value = savedTheme;
applyTheme(savedTheme);


// ── input mode (auto / desktop / smartphone) ──────────────────────────────────
const inputModeSelect = document.getElementById('input-mode-select');

function applyInputMode(mode) {
  const touch = mode === 'smartphone' ||
    (mode === 'auto' && window.matchMedia('(pointer: coarse)').matches);
  document.body.classList.toggle('touch-mode', touch);
}

{
  const savedInputMode = localStorage.getItem('gbmul_input_mode') || 'auto';
  inputModeSelect.value = savedInputMode;
  applyInputMode(savedInputMode);
}

inputModeSelect.addEventListener('change', () => {
  localStorage.setItem('gbmul_input_mode', inputModeSelect.value);
  applyInputMode(inputModeSelect.value);
});

// ── burger / key panel ────────────────────────────────────────────────────────────────────
const burger   = document.getElementById("btn-burger");
const keyPanel = document.getElementById("key-panel");

// Restore saved panel state
if (localStorage.getItem("gbmul_panel_open") === "true") {
  keyPanel.classList.add("open");
  keyPanel.setAttribute("aria-hidden", "false");
}

burger.addEventListener("click", () => {
  const open = keyPanel.classList.toggle("open");
  keyPanel.setAttribute("aria-hidden", String(!open));
  localStorage.setItem("gbmul_panel_open", String(open));
});

// ── burger auto-hide after 4s of no mouse movement ───────────────────────────
let burgerHideTimer = null;
function resetBurgerTimer() {
  burger.classList.remove("burger-hidden");
  clearTimeout(burgerHideTimer);
  if (!keyPanel.classList.contains("open")) {
    burgerHideTimer = setTimeout(() => {
      if (!keyPanel.classList.contains("open")) burger.classList.add("burger-hidden");
    }, 4000);
  }
}
document.addEventListener("mousemove", resetBurgerTimer);
burger.addEventListener("click", () => {
  if (keyPanel.classList.contains("open")) {
    clearTimeout(burgerHideTimer); // panel just opened — cancel any pending hide
  } else {
    resetBurgerTimer();
  }
});
resetBurgerTimer();



// ── IndexedDB ROM cache ───────────────────────────────────────────────────────
const ROM_DB_NAME    = 'gbmul';
const ROM_DB_VERSION = 3;
const ROM_STORE_NAME = 'roms';
const SRAM_STORE_NAME = 'srams';

function _openRomDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ROM_DB_NAME, ROM_DB_VERSION);
    req.onupgradeneeded = e => {
      const db   = e.target.result;
      const oldV = e.oldVersion;
      if (oldV < 1) {
        const store = db.createObjectStore(ROM_STORE_NAME, { keyPath: 'name' });
        store.createIndex('lastUsed', 'lastUsed');
        store.createIndex('hash', 'hash', { unique: false });
      }
      if (oldV >= 1 && oldV < 2) {
        // v1→v2: add hash index (existing rows without hash are harmless)
        const store = e.target.transaction.objectStore(ROM_STORE_NAME);
        if (!store.indexNames.contains('hash')) {
          store.createIndex('hash', 'hash', { unique: false });
        }
      }
      if (oldV < 3) {
        // v2→v3: battery-backed SRAM store (keyed by ROM name)
        db.createObjectStore(SRAM_STORE_NAME, { keyPath: 'name' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function saveRomToDb(name, data, hash = null) {
  const db = await _openRomDb();
  return new Promise((resolve, reject) => {
    const tx     = db.transaction(ROM_STORE_NAME, 'readwrite');
    const record = { name, data: data.slice(), lastUsed: Date.now() };
    if (hash) record.hash = hash;
    tx.objectStore(ROM_STORE_NAME).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = e => reject(e.target.error);
  });
}

async function loadLastRomFromDb() {
  const db = await _openRomDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(ROM_STORE_NAME, 'readonly');
    const idx = tx.objectStore(ROM_STORE_NAME).index('lastUsed');
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = e => {
      const cursor = e.target.result;
      db.close();
      resolve(cursor ? cursor.value : null);
    };
    req.onerror = e => reject(e.target.error);
  });
}

async function listAllRomsFromDb() {
  const db = await _openRomDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(ROM_STORE_NAME, 'readonly');
    const req = tx.objectStore(ROM_STORE_NAME).index('lastUsed').openCursor(null, 'prev');
    const results = [];
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        results.push({ name: cursor.value.name, lastUsed: cursor.value.lastUsed });
        cursor.continue();
      } else {
        db.close();
        resolve(results);
      }
    };
    req.onerror = e => reject(e.target.error);
  });
}

async function loadRomByNameFromDb(name) {
  const db = await _openRomDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(ROM_STORE_NAME, 'readonly');
    const req = tx.objectStore(ROM_STORE_NAME).get(name);
    req.onsuccess = e => { db.close(); resolve(e.target.result ?? null); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function deleteRomFromDb(name) {
  const db = await _openRomDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROM_STORE_NAME, 'readwrite');
    tx.objectStore(ROM_STORE_NAME).delete(name);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = e => reject(e.target.error);
  });
}

async function loadRomByHashFromDb(hash) {
  const db = await _openRomDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(ROM_STORE_NAME, 'readonly');
    const req = tx.objectStore(ROM_STORE_NAME).index('hash').get(hash);
    req.onsuccess = e => { db.close(); resolve(e.target.result ?? null); };
    req.onerror   = e => reject(e.target.error);
  });
}

/**
 * SHA-256 as hex. Uses Web Crypto when available (secure context);
 * pure-JS fallback for http://LAN IPs where crypto.subtle is undefined.
 */
async function computeRomHash(bytes) {
  // Always extract an isolated ArrayBuffer — TypedArray.buffer can be larger than the view.
  const u8 = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (globalThis.crypto && crypto.subtle && typeof crypto.subtle.digest === "function") {
    try {
      // Pass a copy so the buffer is a plain ArrayBuffer (not SharedArrayBuffer).
      const hash = await crypto.subtle.digest("SHA-256", u8.slice().buffer);
      return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } catch (_) { /* fall through to pure JS */ }
  }
  return sha256HexJs(u8);
}

/** Minimal pure-JS SHA-256 (hex). Same digest as crypto.subtle for interoperability. */
function sha256HexJs(message) {
  // message: Uint8Array
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

  const len = message.length;
  // Padding: message || 0x80 || zeros || 64-bit length
  const bitLen = len * 8;
  const withPad = ((len + 9 + 63) & ~63); // multiple of 64
  const buf = new Uint8Array(withPad);
  buf.set(message);
  buf[len] = 0x80;
  // length in bits as big-endian 64-bit at the end (high 32 always 0 for ROMs < 512MB)
  const view = new DataView(buf.buffer);
  view.setUint32(withPad - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let i = 0; i < withPad; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(7, w[j - 15]) ^ rotr(18, w[j - 15]) ^ (w[j - 15] >>> 3);
      const s1 = rotr(17, w[j - 2]) ^ rotr(19, w[j - 2]) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false); ov.setUint32(4, h1, false);
  ov.setUint32(8, h2, false); ov.setUint32(12, h3, false);
  ov.setUint32(16, h4, false); ov.setUint32(20, h5, false);
  ov.setUint32(24, h6, false); ov.setUint32(28, h7, false);
  return Array.from(out).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── IndexedDB SRAM (battery save) ────────────────────────────────────────────
async function saveSramToDb(name, data) {
  const db = await _openRomDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SRAM_STORE_NAME, 'readwrite');
    tx.objectStore(SRAM_STORE_NAME).put({ name, data: data.slice() });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = e => reject(e.target.error);
  });
}

async function loadSramFromDb(name) {
  const db = await _openRomDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(SRAM_STORE_NAME, 'readonly');
    const req = tx.objectStore(SRAM_STORE_NAME).get(name);
    req.onsuccess = e => { db.close(); resolve(e.target.result?.data ?? null); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function deleteSramFromDb(name) {
  const db = await _openRomDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SRAM_STORE_NAME, 'readwrite');
    tx.objectStore(SRAM_STORE_NAME).delete(name);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror    = e => reject(e.target.error);
  });
}

let _sramSaveInterval = null;

function startSramAutosave() {
  if (_sramSaveInterval) clearInterval(_sramSaveInterval);
  _sramSaveInterval = setInterval(() => {
    if (emu && _activeRomName && !dualMode && typeof emu.get_sram === 'function') {
      if (typeof emu.is_halted === 'function' && emu.is_halted()) {
        console.log('[sram] autosave skipped: CPU halted');
        return;
      }
      const sram = emu.get_sram();
      const allFF = sram.every(b => b === 0xFF);
      const allZero = sram.every(b => b === 0);
      const nonTrivial = sram.filter(b => b !== 0xFF && b !== 0).length;
      const status = typeof emu.sram_status === 'function' ? emu.sram_status() : '';
      // LSDJ boot guard: if c3fe is not a valid LSDJ song-count, SRAM is mid-test — don't save
      const c3fe = emu.read_mem(0xC3FE);
      const lsdjValid = [6, 8, 10, 13, 14].includes(c3fe);
      if (allFF || allZero) {
        console.log(`[sram] autosave skipped: trivial SRAM (allFF=${allFF} allZero=${allZero}) ${status}`);
      } else if (!lsdjValid && nonTrivial > 100) {
        // Likely LSDJ test patterns — c3fe invalid and large number of non-trivial bytes
        console.log(`[sram] autosave skipped: looks like LSDJ test patterns (c3fe=0x${c3fe.toString(16)} invalid, nonTrivial=${nonTrivial})`);
      } else {
        console.log(`[sram] autosave saving ${sram.length}B nonTrivial=${nonTrivial} ${status}`);
        saveSramToDb(_activeRomName, sram).catch(() => {});
      }
    }
  }, 5000);
}

function stopSramAutosave() {
  if (_sramSaveInterval) { clearInterval(_sramSaveInterval); _sramSaveInterval = null; }
}

// ── emulator state ───────────────────────────────────────────────────────────
let emu     = null;   // GbEmu (single) or GbEmuPairSideA wrapper (dual) — used by all existing code
let emuPair = null;   // underlying GbEmuPair (dual mode only)
let emuB    = null;   // proxy for side B (dual mode only)
let _lastRomBytes = null;
let _activeRomName = null;
let animId = null;
let paletteIndex = parseInt(localStorage.getItem("gbmul_palette") ?? "0", 10);
const STATUS = document.getElementById("status");

// === Testing the Rust port ===
// Set to true to use the Rust implementation of the bot (RustBot) instead of the JS one.
// After wasm-pack rebuild + reload, you will see clear logs in the console.
const USE_RUST_BOT = true;   // <--- using RustBot now

// ── bot state ─────────────────────────────────────────────────────────────────
const BOT_STRATEGY_KEY = "gbmul_bot_strategy";
let _garbageA_count = 0;
/** Dual-only: last logged garbage-hole template fingerprint (avoid spam). */
let _garbHoleLogKey = '';

/**
 * GB Tetris 2P: hole column is punched once into $C400..$C409 from $C3FF
 * (blank tile $2F among garbage tiles $28). Diagnostic only — no writes.
 * Returns 1-based column, or null if template not ready / no hole.
 */
function garbHoleColFromTemplate(read) {
  let hole = null;
  let solid = 0;
  for (let c = 0; c < 10; c++) {
    const t = read(0xC400 + c);
    if (t === 0x2F) hole = c + 1;
    else if (t === 0x28) solid++;
  }
  if (hole == null || solid < 9) return null;
  return hole;
}

/** Format $C3FF + $C400 template for one side (A or B). */
function fmtGarbHoleSide(label, read) {
  const c3ff = read(0xC3FF);
  const row = [];
  for (let c = 0; c < 10; c++) row.push(read(0xC400 + c).toString(16).padStart(2, '0'));
  const col = garbHoleColFromTemplate(read);
  return `${label}: C3FF=0x${c3ff.toString(16).padStart(2, '0')}(${c3ff})` +
    ` holeCol=${col != null ? col : '?'} C400=[${row.join(' ')}]`;
}

/**
 * Log template once it becomes valid (or when it changes). Called each dual frame.
 */
function logGarbageHoleTemplateIfReady(pair) {
  if (!pair) return;
  const readA = (a) => pair.read_mem_a(a);
  const readB = (a) => pair.read_mem_b(a);
  const colA = garbHoleColFromTemplate(readA);
  const colB = garbHoleColFromTemplate(readB);
  // Only log when at least one side has a punched template.
  if (colA == null && colB == null) return;
  const key = `${readA(0xC3FF)}|${colA}|${readB(0xC3FF)}|${colB}|` +
    Array.from({ length: 10 }, (_, i) => readA(0xC400 + i)).join(',') + '|' +
    Array.from({ length: 10 }, (_, i) => readB(0xC400 + i)).join(',');
  if (key === _garbHoleLogKey) return;
  _garbHoleLogKey = key;
  console.log(
    `[garbage-hole] template ready — ${fmtGarbHoleSide('A', readA)} | ${fmtGarbHoleSide('B', readB)}`
  );
}

/**
 * Scan bottom-most garbage rows on a board for empty columns among 0x28 tiles.
 * Returns sorted unique 1-based columns that look like garbage holes.
 */
function scanBoardGarbageHoleCols(read) {
  const BASE = 0xC800, STRIDE = 32, ROWS = 18, COLS = 10;
  const cols = new Set();
  // Scan from bottom; a garbage row is mostly 0x28 with one empty (0x2F / 0x00).
  for (let row = ROWS - 1; row >= 0; row--) {
    const off = row * STRIDE + 2;
    let solid = 0;
    let holeCol = null;
    for (let col = 0; col < COLS; col++) {
      const t = read(BASE + off + col);
      if (t === 0x28) solid++;
      else if (t === 0x2F || t === 0x00) holeCol = col + 1;
    }
    if (solid >= 8 && holeCol != null) cols.add(holeCol);
  }
  return [...cols].sort((a, b) => a - b);
}

let botStrategy = localStorage.getItem(BOT_STRATEGY_KEY) || "meatfighter";
function makeBotForStrategy(s) {
  if (USE_RUST_BOT) return null;
  // JS bots not imported in Rust mode; this path should not be reached
  console.warn('makeBotForStrategy called but JS bots not loaded');
  return null;
}
function applyRomConfig(b) {
  if (b && typeof b.setSoftDropMode === 'function') {
    b.setSoftDropMode(_activeRomName === 'Tetris.gb');
  } else if (rustBot && typeof rustBot.setSoftDropMode === 'function') {
    rustBot.setSoftDropMode(_activeRomName === 'Tetris.gb');
  }
}
let bot = null;
if (!USE_RUST_BOT) {
  bot = makeBotForStrategy(botStrategy);
}
let botEnabled  = localStorage.getItem("gbmul_bot") === "1";

let rustBot = null;

function rustBotReset() {
  _pathTraceLastStep = -1;
  if (rustBot) rustBot.reset();
}

/** After emu.load_state: discard stale bot paths and replan from scratch. */
function rustBotAfterStateRestore({ misdropReplay = false, wantLock = null } = {}) {
  if (!rustBot) return;
  try {
    rustBotReset();
    if (misdropReplay) {
      const withWant = rustBot.beginReplayRestoreWithWant || rustBot.begin_replay_restore_with_want;
      const plain = rustBot.beginReplayRestore || rustBot.begin_replay_restore;
      if (wantLock && typeof withWant === 'function') {
        const wantMtype = wantLock.mtype || null;
        withWant.call(rustBot, wantLock.row, wantLock.col, wantLock.rot, wantMtype);
      } else if (typeof plain === 'function') {
        plain.call(rustBot);
      }
    } else if (typeof rustBot.beginStateRestore === 'function') {
      rustBot.beginStateRestore();
    }
  } catch (e) {
    console.warn('bot state-restore replan failed', e);
  }
}

let _pathTraceLastStep = -1;

function rustBotReadPiecePos(targetEmu) {
  if (!targetEmu || typeof targetEmu.read_mem !== 'function') return null;
  const read = (a) => targetEmu.read_mem(a);
  const ys = [0xC010, 0xC014, 0xC018, 0xC01C].map((a) => read(a));
  const xs = [0xC011, 0xC015, 0xC019, 0xC01D].map((a) => read(a));
  const row = Math.min(...ys.map((y) => Math.floor((y - 16) / 8)));
  const col = Math.min(...xs.map((x) => Math.floor((x - 24) / 8)));
  const ori = read(0xC203);
  const rot = ori & 3;
  return { row, col, rot, ori };
}

function rustBotTick() {
  if (!rustBot) return;
  const targetEmu = dualMode && emuB ? emuB : emu;
  const pre = rustBotReadPiecePos(targetEmu);
  const preAction = rustBot.action ? (typeof rustBot.action === 'string' ? rustBot.action : rustBot.action()) : '';
  if (dualMode && emuPair) rustBot.tickPairB(emuPair);
  else if (emu) rustBot.tick(emu);
  if (!botEnabled || !preAction.startsWith('path')) return;
  let tgt = { step: -1, col: -1, rot: -1 };
  try {
    const raw = rustBot.debugGetTarget ? rustBot.debugGetTarget() : null;
    if (raw) tgt = JSON.parse(raw);
  } catch (_) {}
  if (tgt.step === _pathTraceLastStep) return;
  _pathTraceLastStep = tgt.step;
  const post = rustBotReadPiecePos(targetEmu);
  let flags = {};
  let pending = '';
  try {
    if (rustBot.debugPathFlags) flags = JSON.parse(rustBot.debugPathFlags());
    if (rustBot.debugGetPendingAction) pending = rustBot.debugGetPendingAction() || '';
  } catch (_) {}
  const path = rustBot.debugGetMovePath ? rustBot.debugGetMovePath() : '';
  const pieceTag = tgt.piece ? `piece=${tgt.piece} next=${tgt.next || '?'} ` : '';
  console.warn(
    `[path] step ${tgt.step}/${path ? path.split(',').length : '?'} ` +
    `${pieceTag}` +
    `pos (${post?.row ?? '?'},${post?.col ?? '?'},r${post?.rot ?? '?'}) ` +
    `pending=${pending || '—'} holdDown=${!!flags.holdingDown} ` +
    `rest=[${path ? path.split(',').slice(tgt.step).join(',') : ''}]`
  );
}

const botCheck  = document.getElementById("bot-check");
const botStrategySelect = document.getElementById("bot-strategy-select");
const botInfo        = document.getElementById("bot-info");
const botInfoMode    = document.getElementById("bot-info-mode");
const botInfoModeRow = document.getElementById("bot-info-mode-row");
const botInfoAction  = document.getElementById("bot-info-action");
const botInfoPathText = document.getElementById("bot-info-path-text");
const botInfoLandingBadge = document.getElementById("bot-info-landing-badge");
const botInfoMisdrops = document.getElementById("bot-info-misdrops");
botCheck.checked = botEnabled;
botStrategySelect.value = botStrategy;
botCheck.addEventListener("change", () => {
  // Local 2P always needs the bot on side B — ignore uncheck while dual is on.
  if (dualMode && !botCheck.checked) {
    botCheck.checked = true;
    botEnabled = true;
    console.log('[dual] bot stays on in local 2P (opponent)');
    updateBotStatus();
    return;
  }
  botEnabled = botCheck.checked;
  // Solo preference only — dual force must not overwrite the user's 1P setting.
  if (!dualMode) {
    localStorage.setItem("gbmul_bot", botEnabled ? "1" : "0");
  }
  const b = dualMode ? emuB : emu;
  if (b) {
    if (rustBot) rustBotReset();
    else if (bot) bot.reset(b); // always reset on toggle: clean state on enable, release keys on disable
  }
  updateBotStatus();
});
botStrategySelect.addEventListener("change", () => {
  const b = dualMode ? emuB : emu;
  if (b) {
    if (rustBot) rustBotReset();
    else if (bot) bot.reset(b);
  }
  botStrategy = botStrategySelect.value;
  localStorage.setItem(BOT_STRATEGY_KEY, botStrategy);
  if (!rustBot) {
    const pps = currentBotPps();
    bot = makeBotForStrategy(botStrategy);
    if (bot) {
      bot.setPps(pps);
      applyRomConfig(bot);
    }
  }
  updateBotStatus();
});

function formatBotLandingType(raw) {
  if (!raw || raw === 'no-plan') return '—';
  if (raw === 'tspin') return 'spin';
  return raw;
}

/** Collapse consecutive soft-drop steps: D,D,D,D,D,D → D×6 */
function formatBotPathDisplay(path) {
  const steps = Array.isArray(path)
    ? path
    : (typeof path === 'string' && path ? path.split(',') : []);
  if (!steps.length) return '';
  const out = [];
  let dRun = 0;
  const flushD = () => {
    if (dRun === 0) return;
    out.push(dRun === 1 ? 'D' : `D×${dRun}`);
    dRun = 0;
  };
  for (const step of steps) {
    if (step === 'D') {
      dRun++;
    } else {
      flushD();
      out.push(step);
    }
  }
  flushD();
  return out.join(',');
}

function setBotLandingBadge(raw) {
  const type = formatBotLandingType(raw);
  if (type === '—') {
    botInfoLandingBadge.hidden = true;
    botInfoLandingBadge.textContent = '';
    botInfoLandingBadge.className = 'misdrop-type';
    return;
  }
  botInfoLandingBadge.hidden = false;
  botInfoLandingBadge.textContent = type;
  botInfoLandingBadge.className = `misdrop-type ${type}`;
}

function updateBotPathAndLanding(activeBot) {
  if (rustBot) {
    const planned = rustBot.debugGetPlannedPath
      ? rustBot.debugGetPlannedPath()
      : (rustBot.debug_get_planned_path ? rustBot.debug_get_planned_path() : '');
    botInfoPathText.textContent = formatBotPathDisplay(planned) || '—';
    const landing = rustBot.debugGetLandingType
      ? rustBot.debugGetLandingType()
      : (rustBot.debug_get_landing_type ? rustBot.debug_get_landing_type() : '');
    setBotLandingBadge(landing);
    return;
  }
  const path = activeBot?._movePath?.length ? formatBotPathDisplay(activeBot._movePath) : '';
  botInfoPathText.textContent = path || '—';
  setBotLandingBadge(activeBot?._intendedLock?.moveType);
}

function updateBotStatus() {
  const activeBot = rustBot || bot;
  if (!botEnabled) {
    botInfo.dataset.active = "false";
    botInfoMode.textContent    = "—";
    botInfoAction.textContent  = "off";
    botInfoPathText.textContent = "—";
    setBotLandingBadge('no-plan');
    botInfoMisdrops.textContent = "—";
    botInfoModeRow.hidden = true;
  } else {
    botInfo.dataset.active = "true";
    if (rustBot) {
      botInfoModeRow.hidden = false;
      const m = rustBot.mode ? (typeof rustBot.mode === 'string' ? rustBot.mode : rustBot.mode()) : 'meatfighter';
      botInfoMode.textContent = m;
      botInfoAction.textContent = (typeof rustBot.action === 'string' ? rustBot.action : (rustBot.action ? rustBot.action() : 'rust'));
      const actionText = botInfoAction.textContent;
      if (actionText.startsWith('garbage ')) setStatus(actionText);
      let ms = {count:0,total:0};
      try { const m = rustBot.misdropStats ? rustBot.misdropStats() : (rustBot.misdrop_stats ? rustBot.misdrop_stats() : null); if (m) ms = m; } catch(e){}
      botInfoMisdrops.textContent = ms.total > 0 ? `${ms.count} / ${ms.total}` : "0";
      updateBotPathAndLanding(activeBot);
    } else if (activeBot) {
      const mode = activeBot.mode;
      if (mode) {
        botInfoMode.textContent = mode;
        botInfoModeRow.hidden = false;
      } else {
        botInfoModeRow.hidden = true;
      }
      botInfoAction.textContent = activeBot.action;
      const { count, total } = activeBot.misdropStats;
      botInfoMisdrops.textContent = total > 0 ? `${count} / ${total}` : "0";
      updateBotPathAndLanding(activeBot);
    } else {
      // Bot preferred on (e.g. dual init) but instance not ready yet (WASM / RustBot).
      botInfoModeRow.hidden = true;
      botInfoMode.textContent = "—";
      botInfoAction.textContent = "…";
      botInfoPathText.textContent = "—";
      setBotLandingBadge('no-plan');
      botInfoMisdrops.textContent = "—";
    }
  }
}

// ── bot PPS control ───────────────────────────────────────────────────────────
const BOT_PPS_KEY              = "gbmul_bot_pps";
const DYNAMIC_BOT_SPEED_KEY    = "gbmul_dynamic_bot_speed";
const DYNAMIC_BOT_PPS_KEY      = "gbmul_dynamic_bot_pps";
const DYNAMIC_BOT_MODE_KEY     = "gbmul_dynamic_bot_mode"; // 'per-round' | 'first-to-4'
const DYNAMIC_BOT_PPS_DEFAULT  = 1.0;
const DYNAMIC_BOT_PPS_STEP     = 0.1;
const DYNAMIC_BOT_PPS_MIN      = 0.1;
const DYNAMIC_BOT_PPS_MAX      = 10.0;
/** First-to-N series length (4 face boxes on the 2P scoreboard). */
const VS_MATCH_WINS            = 4;

const botPpsSlider   = document.getElementById("bot-pps-slider");
const botPpsInput    = document.getElementById("bot-pps-input");
const botPpsDisplay  = document.getElementById("bot-pps-display");
const dynamicBotSpeedCheck  = document.getElementById("dynamic-bot-speed-check");
const dynamicBotPpsHint     = document.getElementById("dynamic-bot-pps-hint");
const dynamicBotPpsDisplay  = document.getElementById("dynamic-bot-pps-display");
const dynamicBotModeLabel   = document.getElementById("dynamic-bot-mode-label");
const dynamicBotModeSelect  = document.getElementById("dynamic-bot-mode-select");

/** Slider position (0–101) → PPS value (0, 0.1–30, Infinity). */
function ppsFromSlider(v) {
  if (v >= 101) return Infinity;
  if (v <= 0)   return 0;
  // Logarithmic: 0.1 at v=1, 30 at v=100
  return Math.round(0.1 * Math.pow(300, (v - 1) / 99) * 10) / 10;
}

/** PPS value → nearest slider position (0–101). */
function sliderFromPps(pps) {
  if (!isFinite(pps)) return 101;
  if (pps <= 0)       return 0;
  const v = 1 + 99 * Math.log(pps / 0.1) / Math.log(300);
  return Math.round(Math.max(1, Math.min(100, v)));
}

/** Manual (non-dynamic) PPS — restored when Dynamic Bot speed is off. */
// New players: 1.0 PPS (was ∞). Existing localStorage values still win on restore.
let manualBotPps = DYNAMIC_BOT_PPS_DEFAULT;
/** Current dynamic PPS when the option is on (resident). */
let dynamicBotPps = DYNAMIC_BOT_PPS_DEFAULT;
/**
 * Dynamic Bot speed: ON by default for new players (absent key).
 * Explicit "0" / "1" in localStorage always wins.
 */
let dynamicBotSpeedOn = (() => {
  const v = localStorage.getItem(DYNAMIC_BOT_SPEED_KEY);
  if (v === null) return true;
  return v === "1";
})();
/** 'per-round' | 'first-to-4' — when Dynamic Bot speed adjusts PPS. Default: each round. */
let dynamicBotMode = (() => {
  const m = localStorage.getItem(DYNAMIC_BOT_MODE_KEY);
  return m === 'first-to-4' ? 'first-to-4' : 'per-round';
})();

function clampDynamicPps(pps) {
  if (!isFinite(pps) || isNaN(pps)) return DYNAMIC_BOT_PPS_DEFAULT;
  return Math.round(
    Math.max(DYNAMIC_BOT_PPS_MIN, Math.min(DYNAMIC_BOT_PPS_MAX, pps)) * 10
  ) / 10;
}

function loadDynamicBotPps() {
  const raw = localStorage.getItem(DYNAMIC_BOT_PPS_KEY);
  if (raw === null) return DYNAMIC_BOT_PPS_DEFAULT;
  return clampDynamicPps(parseFloat(raw));
}

function persistDynamicBotPps() {
  localStorage.setItem(DYNAMIC_BOT_PPS_KEY, String(dynamicBotPps));
}

function updateDynamicBotPpsUi() {
  if (dynamicBotPpsDisplay) {
    dynamicBotPpsDisplay.textContent = dynamicBotPps.toFixed(1);
  }
  if (dynamicBotPpsHint) {
    dynamicBotPpsHint.hidden = !dynamicBotSpeedOn;
  }
  if (dynamicBotModeLabel) {
    dynamicBotModeLabel.hidden = !dynamicBotSpeedOn;
  }
  if (dynamicBotModeSelect) {
    dynamicBotModeSelect.value = dynamicBotMode;
  }
}

/**
 * Apply PPS to the bot and UI.
 * @param {number} pps
 * @param {{ persist?: boolean, source?: 'manual'|'dynamic'|'init' }} opts
 *   persist (default true): write to localStorage.
 *   source 'manual' also updates manualBotPps (slider/input when dynamic is off).
 */
function applyBotPps(pps, opts = {}) {
  const persist = opts.persist !== false;
  const source  = opts.source || 'manual';

  if (rustBot) {
    rustBot.setPps(pps);
  } else if (bot) {
    bot.setPps(pps);
  }

  if (source === 'manual') {
    manualBotPps = pps;
  }

  if (persist) {
    const stored = isFinite(pps) ? String(pps) : "Infinity";
    localStorage.setItem(BOT_PPS_KEY, stored);
  }

  botPpsDisplay.textContent = isFinite(pps) ? pps.toFixed(1) : "∞";
  botPpsSlider.value        = sliderFromPps(pps);
  botPpsInput.value         = isFinite(pps) ? pps.toFixed(1) : "";

  // When dynamic is on, slider/input edits also adjust the resident dynamic PPS.
  if (dynamicBotSpeedOn && source === 'manual' && isFinite(pps)) {
    dynamicBotPps = clampDynamicPps(pps);
    persistDynamicBotPps();
    updateDynamicBotPpsUi();
  }
}

/** Effective PPS currently shown / applied (dynamic or manual). */
function currentBotPps() {
  if (dynamicBotSpeedOn) return dynamicBotPps;
  return manualBotPps;
}

/** True while a dual round is live (both sides were in-game); cleared after first outcome. */
let _dynamicRoundArmed = false;

const VS_RESULT_STATES = new Set([
  '2p-round-win', '2p-round-loss', '2p-match-win', '2p-match-loss',
]);

/**
 * Dual-mode result → PPS adjust, if Dynamic Bot speed + mode allow it.
 * @param {string} state  side-A detectGameState string
 */
function onDynamicBotVsResult(state) {
  if (!dynamicBotSpeedOn || !dualMode) return;
  if (!VS_RESULT_STATES.has(state)) return;

  const isMatch = state === '2p-match-win' || state === '2p-match-loss';
  const isWin   = state === '2p-round-win' || state === '2p-match-win';
  const outcome = isWin ? 'human-win' : 'human-loss';

  // first-to-4: only adjust when the series ends; per-round: every result.
  if (dynamicBotMode === 'first-to-4' && !isMatch) {
    console.log(`[dynamic-pps] skip ${state} (mode=first-to-4, round only)`);
    // Still consume arming so mid-match results don't fire later as stale.
    // Re-arm when both sides return to in-game.
    _dynamicRoundArmed = false;
    return;
  }

  if (!_dynamicRoundArmed) {
    console.log(`[dynamic-pps] ignore ${outcome} via ${state} (not armed)`);
    return;
  }
  _dynamicRoundArmed = false;

  const before = dynamicBotPps;
  // Adaptive difficulty: win → harder bot (+PPS); lose → easier bot (−PPS).
  if (outcome === 'human-win') {
    dynamicBotPps = clampDynamicPps(dynamicBotPps + DYNAMIC_BOT_PPS_STEP);
  } else {
    dynamicBotPps = clampDynamicPps(dynamicBotPps - DYNAMIC_BOT_PPS_STEP);
  }
  persistDynamicBotPps();
  applyBotPps(dynamicBotPps, { source: 'dynamic', persist: true });
  updateDynamicBotPpsUi();
  const dir = outcome === 'human-win' ? '+' : '−';
  const scope = isMatch ? 'match' : 'round';
  const note = dynamicBotPps === before ? ' (clamp)' : '';
  console.log(
    `[dynamic-pps] ${outcome} (${scope}): ${before.toFixed(1)} → ${dynamicBotPps.toFixed(1)} PPS${note}`
  );
  setStatus(
    `Bot ${dir}${DYNAMIC_BOT_PPS_STEP.toFixed(1)} PPS → ${dynamicBotPps.toFixed(1)}`
  );
}

function setDynamicBotSpeed(on) {
  dynamicBotSpeedOn = !!on;
  localStorage.setItem(DYNAMIC_BOT_SPEED_KEY, dynamicBotSpeedOn ? "1" : "0");
  if (dynamicBotSpeedCheck) dynamicBotSpeedCheck.checked = dynamicBotSpeedOn;
  updateDynamicBotPpsUi();
  if (dynamicBotSpeedOn) {
    applyBotPps(dynamicBotPps, { source: 'dynamic', persist: true });
  } else {
    applyBotPps(manualBotPps, { source: 'manual', persist: true });
  }
}

function setDynamicBotMode(mode) {
  dynamicBotMode = mode === 'first-to-4' ? 'first-to-4' : 'per-round';
  localStorage.setItem(DYNAMIC_BOT_MODE_KEY, dynamicBotMode);
  updateDynamicBotPpsUi();
  console.log(`[dynamic-pps] mode → ${dynamicBotMode}`);
}

// Restore saved PPS on load -- moved after WASM init for RustBot
// (see after init below)

botPpsSlider.addEventListener("input", () => {
  applyBotPps(ppsFromSlider(Number(botPpsSlider.value)), { source: 'manual' });
});

botPpsInput.addEventListener("change", () => {
  const raw = botPpsInput.value.trim();
  if (raw === "" || raw.toLowerCase() === "infinity" || raw === "∞") {
    applyBotPps(Infinity, { source: 'manual' });
    return;
  }
  const pps = parseFloat(raw);
  if (!isNaN(pps) && pps >= 0) applyBotPps(pps, { source: 'manual' });
  else applyBotPps(currentBotPps(), { source: 'manual', persist: false });
});

if (dynamicBotSpeedCheck) {
  dynamicBotSpeedCheck.checked = dynamicBotSpeedOn;
  dynamicBotSpeedCheck.addEventListener("change", () => {
    setDynamicBotSpeed(dynamicBotSpeedCheck.checked);
  });
}
if (dynamicBotModeSelect) {
  dynamicBotModeSelect.value = dynamicBotMode;
  dynamicBotModeSelect.addEventListener("change", () => {
    setDynamicBotMode(dynamicBotModeSelect.value);
  });
}

// ── ROM overlay (in-device cart art through the DMG shader) ───────────────────
const romOverlay  = document.getElementById('rom-overlay');
const romDropzone = document.getElementById('rom-dropzone');
const romWglStatus = document.getElementById('rom-wgl-status');

/**
 * Pin #rom-dropzone to the LEFT half of the main LCD only.
 * Right half stays free for the in-device menu hit-targets.
 *
 * Safe to call from applyScale() at module boot: only touches the DOM
 * (never module-level lets that may still be in the TDZ).
 */
function syncRomDropzoneHit() {
  const zone = document.getElementById("rom-dropzone");
  const wrap = document.getElementById("screen-wrap");
  const overlay = document.getElementById("rom-overlay");
  if (!zone || !wrap) return;
  // Splash closed / hidden → collapse hit rect.
  if (!overlay || overlay.classList.contains("hidden")) {
    zone.style.width = "0";
    zone.style.height = "0";
    return;
  }
  // Menu open (body class set by idmSetOpen) → no ROM-pick hits.
  if (document.body.classList.contains("idm-open")) {
    zone.style.width = "0";
    zone.style.height = "0";
    return;
  }
  const r = wrap.getBoundingClientRect();
  const leftW = Math.max(0, Math.floor(r.width / 2));
  zone.style.left = `${Math.round(r.left)}px`;
  zone.style.top = `${Math.round(r.top)}px`;
  zone.style.width = `${leftW}px`;
  zone.style.height = `${Math.round(r.height)}px`;
}

// Keep the left-half hit rect aligned with the LCD on viewport changes.
window.addEventListener("resize", syncRomDropzoneHit);
window.addEventListener("scroll", syncRomDropzoneHit, { passive: true });

/** True while the ROM picker is showing cart art on the LCD. */
let romSplashOpen = false;
/** Cart lid visual: closed by default; opens on click / Start / Select / drag. */
let romCartLidOpen = false;
/** Drag-hover feedback for the on-screen cart composite. */
let romSplashDragOver = false;
let _romSplashRaf = 0;
let _romSplashRgba = null;
const _romSplashPaint = new OffscreenCanvas(W, H);
const _romSplashCtx = _romSplashPaint.getContext("2d", { willReadFrequently: true });
/** @type {HTMLImageElement|null} */
let _cartClosedImg = null;
/** @type {HTMLImageElement|null} */
let _cartOpenImg = null;
let _cartArtReady = false;
let _cartArtPromise = null;

function loadCartImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load " + src));
    img.src = src;
  });
}

function ensureCartArt() {
  if (_cartArtReady) return Promise.resolve();
  if (_cartArtPromise) return _cartArtPromise;
  _cartArtPromise = Promise.all([
    // ?v= keeps SW/browser from serving a stale bake after asset updates.
    loadCartImage("img/caseClosed-Small.png?v=4"),
    loadCartImage("img/caseOpened-Small.png?v=4"),
  ]).then(([closed, open]) => {
    _cartClosedImg = closed;
    _cartOpenImg = open;
    _cartArtReady = true;
  }).catch((err) => {
    console.warn("[rom-splash] cart art load failed:", err);
    _cartArtPromise = null;
  });
  return _cartArtPromise;
}

/** Canonical DMG luminances (bright → dark). */
const GB_GREYS = [255, 143, 111, 47];

/**
 * Snap any leftover non-palette pixel (text AA) to pure ink or bg.
 * Pre-baked case sprites are already pure 255/143/111/47 — leave them alone.
 * Used by the in-device menu (2-tone keeps the LCD shader from "melting" glyphs).
 */
function hardThresholdTextAa(data) {
  const G0 = 255, G3 = 47;
  const mid = (G0 + G3) / 2;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r === g && g === b && (r === 255 || r === 143 || r === 111 || r === 47)) {
      data[i + 3] = 255;
      continue;
    }
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const v = lum < mid ? G3 : G0;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
}

/**
 * Snap every pixel to the nearest of the 4 DMG greys (preserves mid greys for
 * the open-cart letter wave; exact palette pixels pass through unchanged).
 */
function snapToGbGreys(data) {
  const greys = GB_GREYS;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r === g && g === b && (r === 255 || r === 143 || r === 111 || r === 47)) {
      data[i + 3] = 255;
      continue;
    }
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    let best = greys[0], bestD = Math.abs(lum - best);
    for (let k = 1; k < greys.length; k++) {
      const d = Math.abs(lum - greys[k]);
      if (d < bestD) { best = greys[k]; bestD = d; }
    }
    data[i] = data[i + 1] = data[i + 2] = best;
    data[i + 3] = 255;
  }
}

/** Mid greys used for the "open cart" letter cascade (not pure white). */
const ROM_SPLASH_WAVE_GREYS = [143, 111, 47];
/** Full wave period for the open-cart letter animation (ms). */
const ROM_SPLASH_WAVE_MS = 1000;

/**
 * Draw centered text with a per-letter grey cascade (3 DMG mid/dark greys).
 * Phase travels left→right; one full cycle every ROM_SPLASH_WAVE_MS.
 */
function fillTextGreyWave(c, text, cx, y, nowMs) {
  const greys = ROM_SPLASH_WAVE_GREYS;
  const nGrey = greys.length;
  const n = text.length;
  let totalW = 0;
  const widths = new Array(n);
  for (let i = 0; i < n; i++) {
    const w = c.measureText(text[i]).width;
    widths[i] = w;
    totalW += w;
  }
  let x = Math.floor(cx - totalW / 2);
  const prevAlign = c.textAlign;
  c.textAlign = "left";
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch !== " ") {
      // Letter i lags by i/n of the period so the wave scrolls across the word.
      const phase =
        ((nowMs / ROM_SPLASH_WAVE_MS) - i / Math.max(1, n) + 1) % 1;
      const gi = Math.floor(phase * nGrey) % nGrey;
      const v = greys[gi];
      c.fillStyle = `rgb(${v},${v},${v})`;
      c.fillText(ch, x, y);
    }
    x += widths[i];
  }
  c.textAlign = prevAlign;
}

/**
 * Wrap a caption to fit the 160px LCD (Cuterminus ~6px/glyph).
 * Returns 1–2 lines; never wider than maxW.
 */
function romSplashWrapCaption(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? cur + " " + w : w;
    if (cur && c.measureText(trial).width > maxW) {
      lines.push(cur);
      cur = w;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  // Hard-clip any still-too-long line (shouldn't happen for our captions).
  return lines.map((line) => {
    if (c.measureText(line).width <= maxW) return line;
    let s = line;
    while (s.length > 1 && c.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  });
}

/**
 * Open the cart lid (visual only). Hook for a future "pop" sound.
 * @returns {boolean} true if this call transitioned closed → open
 */
function romCartOpenLid() {
  if (!romSplashOpen) return false;
  if (romCartLidOpen) return false;
  romCartLidOpen = true;
  // TODO: play a short cart-open "pop" here.
  romSplashRedraw();
  return true;
}

/** True while splash is up and not in guest WGL-waiting mode (file pick allowed). */
function romSplashAllowsPick() {
  return romSplashOpen && !romOverlay?.classList.contains("wgl-waiting");
}

/**
 * Paint a single cart (closed or open) into a 160×144 RGBA buffer.
 * Output goes through drawFrame → DMG shader (same path as the in-device menu).
 *
 * Case sprites are pre-baked ~97×98 with clean 4-grey DMG pixels (no runtime
 * posterize — that was the salt/pepper source when downscaling high-res AA art).
 */
function romSplashComposite() {
  const G0 = 255;
  const G3 = 47;
  const gray = (v) => `rgb(${v},${v},${v})`;
  const c = _romSplashCtx;
  c.imageSmoothingEnabled = false;
  c.fillStyle = gray(G0);
  c.fillRect(0, 0, W, H);

  // Captions — Cuterminus; AA edges hard-thresholded below.
  // Font must be set before wrap measure + cart vertical layout (caption height).
  const fontPx = 8;
  c.font = fontPx + 'px "Cuterminus", monospace';
  c.textBaseline = "top";
  c.textAlign = "center";
  c.shadowColor = "transparent";
  c.shadowBlur = 0;
  c.fillStyle = gray(G3);

  const wglWaiting = romOverlay?.classList.contains("wgl-waiting");
  const wglMsg = (romWglStatus && !romWglStatus.hidden && romWglStatus.textContent)
    ? String(romWglStatus.textContent).trim()
    : "";
  const cx = Math.floor(W / 2);
  const yCap = H - 12;
  const lineH = 10;
  const maxCapW = W - 4;
  const showOpen = romCartLidOpen || romSplashDragOver;

  // Closed splash: static hint + animated "open cart" (2 lines total).
  const closedHint = (!wglWaiting && !romSplashDragOver && !showOpen)
    ? "[select] or [start] to"
    : null;
  // Reserve bottom strip so the cart does not sit on the captions.
  const captionLines = closedHint
    ? 2 // hint + animated "open cart"
    : (wglWaiting && wglMsg ? 2 : 1);
  const bottomReserve = 4 + captionLines * lineH;

  // 1:1 blit of pre-baked sprites (integer position, no scale).
  const cartS = 102; // fallback if natural size unavailable (caseClosed/Opened-Small)
  const cartImg = showOpen ? _cartOpenImg : _cartClosedImg;
  if (cartImg) {
    // Draw at native pixel size — never scale (avoids reintroducing AA noise).
    const dw = cartImg.naturalWidth || cartS;
    const dh = cartImg.naturalHeight || cartS;
    const dx = Math.floor((W - dw) / 2);
    const dy = Math.max(0, Math.floor((H - bottomReserve - dh) / 2));
    c.drawImage(cartImg, dx, dy);
  }

  if (wglWaiting) {
    c.fillText("linking…", cx, yCap);
    const line = wglMsg.length > 24 ? wglMsg.slice(0, 23) + "…" : wglMsg;
    if (line) c.fillText(line, cx, Math.max(0, yCap - lineH));
  } else if (romSplashDragOver) {
    c.fillText("drop rom!", cx, yCap);
  } else if (showOpen) {
    c.fillText("insert rom", cx, yCap);
  } else {
    // Line 1 static; line 2 ("open cart") letter-wave, 1s period.
    c.fillStyle = gray(G3);
    const hintLine = c.measureText(closedHint).width <= maxCapW
      ? closedHint
      : romSplashWrapCaption(c, closedHint, maxCapW)[0];
    c.fillText(hintLine, cx, Math.max(0, yCap - lineH));
    fillTextGreyWave(c, "open cart", cx, yCap, performance.now());
  }

  // Drag-over: 1px ink frame around the LCD.
  if (romSplashDragOver) {
    c.fillStyle = gray(G3);
    c.fillRect(0, 0, W, 1);
    c.fillRect(0, H - 1, W, 1);
    c.fillRect(0, 0, 1, H);
    c.fillRect(W - 1, 0, 1, H);
  }

  const painted = c.getImageData(0, 0, W, H);
  const d = painted.data;
  // Nearest-of-4 so the animated mid greys (143/111) survive text AA.
  snapToGbGreys(d);

  if (!_romSplashRgba || _romSplashRgba.length !== d.length) {
    _romSplashRgba = new Uint8ClampedArray(d.length);
  }
  _romSplashRgba.set(d);
  return _romSplashRgba;
}

function romSplashRedraw() {
  if (!romSplashOpen) return;
  // drawFrame re-runs romSplashComposite (+ optional idm composite).
  drawFrame(ctx, _romSplashRgba || new Uint8ClampedArray(W * H * 4));
}

function romSplashStartLoop() {
  if (_romSplashRaf) return;
  const tick = () => {
    _romSplashRaf = 0;
    if (!romSplashOpen) return;
    romSplashRedraw();
    _romSplashRaf = requestAnimationFrame(tick);
  };
  _romSplashRaf = requestAnimationFrame(tick);
}

function romSplashStopLoop() {
  if (_romSplashRaf) {
    cancelAnimationFrame(_romSplashRaf);
    _romSplashRaf = 0;
  }
}

/**
 * Start / Select / A while the cart splash is up: open the lid (consume input).
 * @returns {boolean} true if the input was consumed
 */
function romSplashHandlePad(btn, down) {
  if (!romSplashOpen || !down) return romSplashOpen;
  // Start(3), Select(2), A(0) open the cart.
  if (btn === 3 || btn === 2 || btn === 0) {
    romCartOpenLid();
    return true;
  }
  return true; // swallow other pad input while splash is up
}

function showRomOverlay() {
  romOverlay.classList.remove('hidden');
  document.body.classList.add('rom-overlay-open');
  romSplashOpen = true;
  romCartLidOpen = false;
  romSplashDragOver = false;
  ensureCartArt().then(() => {
    if (romSplashOpen) romSplashRedraw();
  });
  romSplashStartLoop();
  // Align left-half hit target after layout (and after fonts/scale settle).
  requestAnimationFrame(() => {
    syncRomDropzoneHit();
    requestAnimationFrame(syncRomDropzoneHit);
  });
  // Warm fonts for captions (same as in-device menu).
  if (document.fonts?.load) {
    document.fonts.load('8px "Cuterminus"').catch(() => {});
  }
}
function hideRomOverlay() {
  romSplashOpen = false;
  romCartLidOpen = false;
  romSplashDragOver = false;
  romSplashStopLoop();
  romOverlay.classList.add('hidden');
  romOverlay.classList.remove('wgl-waiting');
  romOverlay.classList.remove('idm-open');
  document.body.classList.remove('rom-overlay-open');
  syncRomDropzoneHit(); // collapse hit rect
  // Keep body.idm-open if the menu is still open after leaving the splash.
  if (btnBrowseRom && !(typeof idm !== "undefined" && idm.open)) {
    btnBrowseRom.disabled = false;
    btnBrowseRom.tabIndex = 0;
  }
  if (romWglStatus) {
    romWglStatus.hidden = true;
    romWglStatus.textContent = '';
    romWglStatus.classList.remove('error');
  }
}

/**
 * Tear down the running emulator and park on the ROM cart splash.
 * Used when the active ROM is deleted from the local cache (or cache is empty).
 */
function unloadRomToPicker(statusMsg) {
  if (animId) {
    cancelAnimationFrame(animId);
    animId = null;
  }
  if (typeof stopSramAutosave === "function") stopSramAutosave();
  if (typeof clearPause === "function") clearPause();
  emu = null;
  emuPair = null;
  emuB = null;
  _lastRomBytes = null;
  _activeRomName = null;
  // Don't restore a savestate for a ROM that is no longer cached.
  try { localStorage.removeItem("gbmul_state"); } catch (_) { /* ignore */ }
  try { sessionStorage.removeItem("gbmul_reload_restore"); } catch (_) { /* ignore */ }
  if (typeof idm !== "undefined" && idm.open) idmHide();
  showRomOverlay();
  setStatus(statusMsg || "No ROM — open cart to load one.");
}

/** Guest join splash: keep overlay, hide file picker, show link progress. */
function showRomOverlayWglWaiting(initialMsg) {
  showRomOverlay();
  romOverlay.classList.add('wgl-waiting');
  if (romWglStatus) {
    romWglStatus.hidden = false;
    if (initialMsg) {
      romWglStatus.textContent = initialMsg;
      romWglStatus.classList.remove('error');
    }
  }
  romSplashRedraw();
}

function syncRomWglStatusMirror(msg, isError) {
  if (!romWglStatus) return;
  // Only mirror while the guest splash is in WebGBLink-waiting mode (or any open overlay + wgl msg).
  const overlayOpen = romOverlay && !romOverlay.classList.contains('hidden');
  if (!overlayOpen) return;
  romWglStatus.hidden = false;
  romWglStatus.textContent = msg;
  romWglStatus.classList.toggle('error', !!isError);
  // Ensure waiting mode is on for join guests so the file picker stays out of the way.
  if (webgblink?.isGuest || romOverlay.classList.contains('wgl-waiting')) {
    romOverlay.classList.add('wgl-waiting');
  }
  if (romSplashOpen) romSplashRedraw();
}

let _statusTimer = null;
/**
 * Bottom status line.
 * @param {string} msg
 * @param {boolean|object} [isErrorOrOpts]
 *   true → error style
 *   { error?, sticky?, wgl?, holdMs? } → finer control
 *   sticky/wgl messages do not auto-fade (needed for phone diagnosis).
 */
function setStatus(msg, isErrorOrOpts = false) {
  const opts = typeof isErrorOrOpts === "object" && isErrorOrOpts
    ? isErrorOrOpts
    : { error: !!isErrorOrOpts };
  const isError = !!opts.error;
  const sticky  = !!opts.sticky || !!opts.wgl || isError;
  const holdMs  = opts.holdMs ?? 4000;

  STATUS.textContent = msg;
  STATUS.classList.remove("fade-out");
  STATUS.classList.toggle("error", isError);
  STATUS.classList.toggle("sticky", sticky);
  STATUS.classList.toggle("wgl", !!opts.wgl);
  if (opts.wgl || sticky) {
    syncRomWglStatusMirror(msg, isError);
  }
  if (_statusTimer) clearTimeout(_statusTimer);
  if (!sticky) {
    _statusTimer = setTimeout(() => STATUS.classList.add("fade-out"), holdMs);
  }
}

/** WebGBLink status — always sticky + tagged so it stays readable on phones. */
function wglStatus(msg, isError = false) {
  setStatus(msg, { error: isError, sticky: true, wgl: true });
  console.log(isError ? "[webgblink:err]" : "[webgblink:ui]", msg);
}

// ── dual mode ─────────────────────────────────────────────────────────────────
let dualMode = localStorage.getItem("gbmul_dual") === "1";
const dualCheck = document.getElementById("dual-check");
dualCheck.checked = dualMode;
dualWrap.classList.toggle("dual", dualMode);

/**
 * Local 2P = human (A) vs bot (B). Enable the bot automatically when dual is on
 * so the user never has to dig into the menu checkbox. Solo bot preference in
 * localStorage is preserved and restored when leaving dual.
 */
function applyDualBotPolicy(reason = '') {
  if (dualMode) {
    if (!botEnabled) {
      botEnabled = true;
      botCheck.checked = true;
      const b = emuB || emu;
      if (b) {
        if (rustBot) rustBotReset();
        else if (bot) bot.reset(b);
      }
      console.log(`[dual] bot auto-enabled for local 2P${reason ? ` (${reason})` : ''}`);
      updateBotStatus();
    } else {
      botCheck.checked = true;
    }
    return;
  }
  // Leaving dual: restore solo checkbox preference.
  const soloPref = localStorage.getItem("gbmul_bot") === "1";
  if (botEnabled !== soloPref) {
    botEnabled = soloPref;
    botCheck.checked = soloPref;
    const b = emu;
    if (b) {
      if (rustBot) rustBotReset();
      else if (bot) bot.reset(b);
    }
    console.log(`[dual] bot restored to solo pref=${soloPref}${reason ? ` (${reason})` : ''}`);
    updateBotStatus();
  } else {
    botCheck.checked = botEnabled;
  }
}

dualCheck.addEventListener("change", () => {
  dualMode = dualCheck.checked;
  localStorage.setItem("gbmul_dual", dualMode ? "1" : "0");
  dualWrap.classList.toggle("dual", dualMode);
  console.log(`[dual] mode ${dualMode ? 'ON' : 'OFF'}`);
  applyDualBotPolicy(dualMode ? 'enter dual' : 'leave dual');
  _dbgFrameCount = 0; _dbgLastStateA = null; _dbgLastStateB = null;
  _dbgLastScA = -1; _dbgLastScB = -1;
  if (emu && _lastRomBytes) loadRom(_lastRomBytes);
});

// Page load with dual already on (title cursor / last session).
applyDualBotPolicy('init');

// ── show opponent screen ───────────────────────────────────────────────────────
const showBotScreenCheck = document.getElementById("show-bot-screen-check");
let showBotScreen = localStorage.getItem("gbmul_show_bot_screen") === "1";
showBotScreenCheck.checked = showBotScreen;
dualWrap.classList.toggle("show-bot-screen", showBotScreen);

showBotScreenCheck.addEventListener("change", () => {
  showBotScreen = showBotScreenCheck.checked;
  localStorage.setItem("gbmul_show_bot_screen", showBotScreen ? "1" : "0");
  dualWrap.classList.toggle("show-bot-screen", showBotScreen);
});

// ── WebGBLink panel ───────────────────────────────────────────────────────────
let webgblink    = null;
let wglRoomId    = null;
let wglPingInterval = null;

// ── WebGBLink phase tracker (phone-friendly diagnosis via bottom status) ─────
// Phases are short machine ids; labels are what the user sees.
/** @type {string|null} */
let wglPhase = null;
let wglPhaseSince = 0;
let wglWatchdogTimer = null;
/** @type {Record<string, number>} */
let wglDiag = {
  msgsIn: 0,
  msgsOut: 0,
  chunksIn: 0,
  chunksOut: 0,
  lastMsgType: "",
  lastRttMs: -1,
  announceSize: 0,
};

function wglResetDiag() {
  wglDiag = {
    msgsIn: 0, msgsOut: 0, chunksIn: 0, chunksOut: 0,
    lastMsgType: "", lastRttMs: -1, announceSize: 0,
  };
  wglPhase = null;
  wglPhaseSince = 0;
  if (wglWatchdogTimer) { clearInterval(wglWatchdogTimer); wglWatchdogTimer = null; }
}

function wglPhaseAgeSec() {
  if (!wglPhaseSince) return 0;
  return Math.floor((performance.now() - wglPhaseSince) / 1000);
}

/**
 * Enter a named wait/progress phase and refresh the status line.
 * A 1 Hz watchdog re-writes the line with elapsed time so a stuck step is obvious.
 */
function wglSetPhase(phase, detail = "") {
  const changed = phase !== wglPhase;
  if (changed) {
    wglPhase = phase;
    wglPhaseSince = performance.now();
  }
  const age = wglPhaseAgeSec();
  const ageStr = age > 0 ? ` (${age}s)` : "";
  const role = webgblink?.isHost ? "HOST" : webgblink?.isGuest ? "GUEST" : "?";
  const room = wglRoomId ? ` · room ${wglRoomId}` : "";
  const extra = detail ? ` — ${detail}` : "";

  const labels = {
    "host-open":        "Opening host peer…",
    "host-waiting":     "Waiting for guest to open the link…",
    "guest-open":       "Opening guest peer…",
    "guest-signaling":  "Signaling OK — negotiating data channel…",
    "guest-ice":        "Connecting data channel (ICE)…",
    "channel-open":     "Data channel open",
    "host-announce":    "Announcing ROM to guest…",
    "host-wait-req":    "ROM announced — waiting for guest request…",
    "host-sending":     "Sending ROM…",
    "host-wait-ready":  "ROM sent — waiting for guest ready…",
    "guest-wait-ann":   "Connected — waiting for host ROM announce…",
    "guest-cache-hit":  "ROM already cached — telling host…",
    "guest-request":    "Requesting ROM transfer…",
    "guest-receiving":  "Receiving ROM…",
    "guest-verify":     "Verifying ROM hash…",
    "guest-wait-start": "ROM ready — waiting for game start…",
    "starting":         "Starting lockstep game…",
    "running":          "Game running",
    "error":            "Error",
  };
  const base = labels[phase] || phase;
  wglStatus(`[${role}${room}] ${base}${ageStr}${extra}`, phase === "error");

  if (!wglWatchdogTimer) {
    wglWatchdogTimer = setInterval(() => {
      if (!webgblink || wglGameActive) return;
      // Re-emit same phase so the (Ns) counter ticks on a stuck step.
      if (wglPhase && wglPhase !== "running" && wglPhase !== "starting") {
        wglSetPhase(wglPhase, _wglPhaseDetailHint());
      }
    }, 1000);
  }
}

/** Extra hint while stuck in a phase (shown after a few seconds). */
function _wglPhaseDetailHint() {
  const age = wglPhaseAgeSec();
  const d = wglDiag;
  if (wglPhase === "guest-ice" && age >= 5) {
    return "still negotiating ICE (STUN / PeerJS) — works on Wi‑Fi or mobile data; check firewall / captive portal";
  }
  if (wglPhase === "guest-wait-ann" && age >= 4) {
    return d.msgsIn === 0
      ? "no messages received yet (channel may be one-way / host not announcing)"
      : `msgs in=${d.msgsIn} last=${d.lastMsgType || "—"}`;
  }
  if (wglPhase === "host-wait-req" && age >= 4) {
    return d.msgsIn === 0
      ? "guest silent — is the phone stuck before channel open?"
      : `msgs in=${d.msgsIn} last=${d.lastMsgType || "—"}`;
  }
  if (wglPhase === "guest-receiving") {
    return `${d.chunksIn} chunk(s) · last=${d.lastMsgType || "chunk"}`;
  }
  if (wglPhase === "host-sending") {
    return `${d.chunksOut} chunk(s) sent`;
  }
  if (wglPhase === "host-waiting" && age >= 8) {
    return "share the link; guest opens it anywhere (Wi‑Fi or mobile data)";
  }
  if (d.lastRttMs >= 0 && age >= 3) {
    return `rtt ${d.lastRttMs}ms · in=${d.msgsIn} out=${d.msgsOut}`;
  }
  return "";
}

function wglNoteMsgIn(typeOrKind) {
  wglDiag.msgsIn++;
  wglDiag.lastMsgType = String(typeOrKind || "");
}
function wglNoteMsgOut(typeOrKind) {
  wglDiag.msgsOut++;
  if (typeOrKind) wglDiag.lastMsgType = "→" + typeOrKind;
}

// ROM transfer state (cleared on disconnect)
let wglRomHash       = null;   // SHA-256 of host's current ROM
let wglRomMeta       = null;   // { name, hash, size } from rom-announce (guest)
let wglRomChunks     = [];     // ArrayBuffers being received (guest)
let wglGuestRomBytes = null;   // assembled Uint8Array the guest will load

// ── Lockstep input-delay netplay state ────────────────────────────────────────
// Each side runs a FULL GbEmuPair (both Game Boys) and the link cable is resolved
// in-process — exactly like local 2-player mode, which is instant and lockstep-
// safe. The only thing crossing the network is the joypad input for each frame,
// applied with a fixed delay so both deterministic simulations stay identical.
let wglGameActive   = false;
let wglLockstepSide = 'A';      // 'A' = host (left GB), 'B' = guest (right GB)
let wglLockstepAnimId = null;
let wglFrameIndex   = 0;        // next frame to step
let wglNextSendFrame = 0;       // next frame index we still owe an input for
let wglLocalButtons = 0;        // current local button mask (bit 0=A … 7=Right)
const wglLocalInputs  = new Map();  // applyFrame → our mask (locked once sent)
const wglRemoteInputs = new Map();  // applyFrame → remote mask (received)

// Input delay in frames. Remote input for frame F is sent D frames before it
// applies, giving ~D×16 ms of slack to absorb network RTT/jitter without a stall.
const WGL_INPUT_DELAY = 2;

// Title-screen / splash auto-navigation. In lockstep each side drives only its
// OWN player (host → side A, guest → side B) through the synchronized input
// queue. The host presses Start to begin (becomes in-process serial master);
// the guest only selects 2P and is pulled in as slave — same as local 2P.
let _wglAutoBtnFrames = 0;
let _wglAutoBtnCode   = -1;
let _wglSplashPressed = false;
let _wglSelected2P    = false;
let _wglStartedGame   = false;  // host: has pressed Start to begin the 2P game
let _wgl2PFrames      = 0;      // host: frames spent on the 2P title before Start
let _wglLastState     = null;

const wglIdle          = document.getElementById('wgl-idle');
const wglHosting       = document.getElementById('wgl-hosting');
const wglConnected     = document.getElementById('wgl-connected');
const wglTransfer      = document.getElementById('wgl-transfer');
const wglTransferBar   = document.getElementById('wgl-transfer-bar');
const wglTransferLabel = document.getElementById('wgl-transfer-label');

function wglShowState(state) {
  wglIdle     .hidden = state !== 'idle';
  wglHosting  .hidden = state !== 'hosting';
  wglConnected.hidden = state !== 'connected';
  if (state !== 'hosting') {
    wglHideInlineQr();
  }
  if (state === 'connected') {
    // Guest joined — dismiss share UI so host can play immediately.
    wglHideQrOverlay();
    if (typeof idm !== "undefined" && idm.open) idmHide();
  } else if (typeof idm !== "undefined" && idm.open && idm.level === 3) {
    // Hosting / idle transitions while link submenu is open — refresh labels.
    idmRender();
  }
}

function wglSetRoomCode(code) {
  wglRoomId = code;
  document.getElementById('wgl-room-code')  .textContent = code;
  document.getElementById('wgl-room-code-c').textContent = code;
}

function wglIsLoopbackHost() {
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

/** Cached LAN origin override for share links (set by ensureWglShareOrigin). */
let _wglShareOrigin = null;
let _wglLanIp = null;

/**
 * Prefer a phone-reachable origin. localhost links only open the phone's own
 * loopback — useless for WebGBLink guests on Wi‑Fi.
 */
async function ensureWglShareOrigin() {
  if (_wglShareOrigin) return _wglShareOrigin;
  if (!wglIsLoopbackHost()) {
    _wglShareOrigin = location.origin;
    return _wglShareOrigin;
  }
  try {
    const ip = await discoverLanIPv4(2000);
    if (ip) {
      _wglLanIp = ip;
      const port = location.port || (location.protocol === "https:" ? "443" : "80");
      const portPart =
        (port === "80" && location.protocol === "http:") ||
        (port === "443" && location.protocol === "https:")
          ? ""
          : ":" + port;
      _wglShareOrigin = location.protocol + "//" + ip + portPart;
      console.log("[webgblink] share origin (LAN) =", _wglShareOrigin);
      return _wglShareOrigin;
    }
  } catch (e) {
    console.warn("[webgblink] LAN IP discovery failed", e);
  }
  _wglShareOrigin = location.origin;
  return _wglShareOrigin;
}

function wglShareUrl(code, originOverride) {
  const origin = originOverride || _wglShareOrigin || location.origin;
  // Keep path (usually "/") so deep paths still work if ever hosted under a subdir.
  return origin + location.pathname + "?room=" + encodeURIComponent(code);
}

function wglUpdateShareHint() {
  const el = document.getElementById("wgl-share-hint");
  if (!el) return;
  if (wglIsLoopbackHost()) {
    const lan = _wglLanIp || "YOUR-LAN-IP";
    const port = location.port || "8000";
    el.hidden = false;
    el.innerHTML =
      "<strong>Phone guests:</strong> open GBmul on this PC as " +
      "<code>http://" + lan + ":" + port + "/</code> " +
      "(not localhost), then Host again. " +
      "A <code>localhost</code> tab only exposes loopback ICE candidates — " +
      "the phone cannot reach the data channel.";
  } else {
    el.hidden = false;
    el.textContent =
      "Share the link (or room code). Both devices need internet for PeerJS signaling; " +
      "game traffic is peer-to-peer via WebRTC (STUN) — Wi‑Fi or mobile data.";
  }
}

/** Copy text to clipboard; works without secure-context Clipboard API. */
async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) { /* fall through to legacy path */ }
  }
  // Fallback: temporary textarea + execCommand (works on http:// and older browsers).
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

async function wglCopyLink(code) {
  await ensureWglShareOrigin();
  const url = wglShareUrl(code);
  const ok = await copyTextToClipboard(url);
  if (ok) {
    const note = wglIsLoopbackHost()
      ? "Link copied (LAN). Host page should also use that LAN URL."
      : "Link copied!";
    setStatus(note);
  } else {
    setStatus("Copy failed — link: " + url, true);
    console.warn("[webgblink] clipboard copy failed; url =", url);
  }
}

// ── QR share (davidshimjs QRCode via qrcode-lib.js global) ───────────────────

let _wglQrUrl = null;
/** Cached module grid for in-device menu QR (level 4). */
let _idmQr = null; // { url, room, modules: boolean[][], count }

function wglQrAvailable() {
  return typeof QRCode === "function";
}

/**
 * Encode `text` to a boolean module grid via the vendored QRCode lib.
 * Uses a throwaway DOM node (library draws as side effect); we only keep modules.
 */
function wglBuildQrModules(text) {
  if (!wglQrAvailable()) return null;
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;";
  document.body.appendChild(el);
  try {
    // eslint-disable-next-line no-undef
    const qr = new QRCode(el, {
      text,
      width: 64,
      height: 64,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
    const o = qr._oQRCode;
    if (!o || typeof o.getModuleCount !== "function") return null;
    const n = o.getModuleCount();
    const modules = new Array(n);
    for (let y = 0; y < n; y++) {
      const row = new Array(n);
      for (let x = 0; x < n; x++) row[x] = !!o.isDark(y, x);
      modules[y] = row;
    }
    return { modules, count: n };
  } catch (err) {
    console.error("[webgblink] QR encode failed", err);
    return null;
  } finally {
    el.remove();
  }
}

/** Paint a QR into `el` for `text`. Clears previous children. */
function wglPaintQr(el, text, size = 200) {
  if (!el) return false;
  el.innerHTML = "";
  if (!wglQrAvailable()) {
    el.textContent = "QR lib missing";
    return false;
  }
  try {
    // correctLevel M is enough for short LAN URLs and keeps modules larger.
    // eslint-disable-next-line no-undef
    new QRCode(el, {
      text,
      width: size,
      height: size,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
    return true;
  } catch (err) {
    console.error("[webgblink] QR paint failed", err);
    el.textContent = "QR failed";
    return false;
  }
}

function wglHideInlineQr() {
  const box = document.getElementById("wgl-qr-inline");
  if (!box) return;
  box.innerHTML = "";
  box.classList.remove("visible");
  box.setAttribute("aria-hidden", "true");
}

/**
 * Prepare QR data for the in-device menu (full-width panel, level 4).
 * Keeps the menu open so the guest scans the GB screen itself.
 */
async function idmPrepareQr(code) {
  code = (code || wglRoomId || "").toUpperCase().trim();
  if (!code) {
    setStatus("No room code yet — Host first.", true);
    return false;
  }
  await ensureWglShareOrigin();
  const url = wglShareUrl(code);
  _wglQrUrl = url;
  const built = wglBuildQrModules(url);
  if (!built) {
    setStatus("QR encode failed.", true);
    return false;
  }
  _idmQr = { url, room: code, modules: built.modules, count: built.count };
  // Small advanced-panel mirror still useful when ☰ is open.
  const inline = document.getElementById("wgl-qr-inline");
  if (inline) {
    wglPaintQr(inline, url, 128);
    inline.classList.add("visible");
    inline.setAttribute("aria-hidden", "false");
  }
  return true;
}

/** Open in-device QR view (level 4). Menu stays open / is opened if needed. */
async function idmShowQrView(code) {
  const ok = await idmPrepareQr(code);
  if (!ok) return;
  if (!idm.open) {
    // idmSetOpen(true) resets level to 0 — open first, then enter QR view.
    idmSetOpen(true);
  }
  // Set after open so we are not wiped by idmSetOpen's level reset.
  idm.level = 4;
  idm.selected = 0;
  idmRender();
}

function idmLeaveQrView() {
  if (idm.level !== 4) return;
  idm.level = 3;
  idm.selected = 0;
  idmRender();
}

// ── In-device Join room keyboard (level 5) ───────────────────────────────────
// Room IDs are 6 chars from A–Z + 0–9 (see makeRoomId in webgblink.js).
const IDM_JOIN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const IDM_JOIN_COLS = 9; // 4×9 letter grid, then action row
const IDM_JOIN_LETTER_COUNT = IDM_JOIN_ALPHABET.length; // 36
const IDM_JOIN_KEY_DEL = IDM_JOIN_LETTER_COUNT;
const IDM_JOIN_KEY_OK  = IDM_JOIN_LETTER_COUNT + 1;
const IDM_JOIN_KEY_X   = IDM_JOIN_LETTER_COUNT + 2;
const IDM_JOIN_KEY_COUNT = IDM_JOIN_LETTER_COUNT + 3; // + DEL, OK, cancel
const IDM_JOIN_CODE_LEN = 6;

/** Open full-screen room-code entry on the GB LCD (no HTML popup). */
function idmShowJoinView() {
  if (!idm.open) idmSetOpen(true);
  idm.level = 5;
  idm.selected = 0;
  idm.joinCode = "";
  idm.joinKey = 0;
  idmRender();
}

function idmLeaveJoinView() {
  if (idm.level !== 5) return;
  idm.level = 3;
  idm.selected = Math.max(0, idmLinkItems().indexOf("join"));
  idm.joinCode = "";
  idm.joinKey = 0;
  idmRender();
}

function idmJoinAppend(ch) {
  if (idm.joinCode.length >= IDM_JOIN_CODE_LEN) return;
  idm.joinCode += ch;
  idmRender();
}

function idmJoinDelete() {
  if (!idm.joinCode.length) return false;
  idm.joinCode = idm.joinCode.slice(0, -1);
  idmRender();
  return true;
}

function idmJoinSubmit() {
  const code = (idm.joinCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== IDM_JOIN_CODE_LEN) {
    setStatus(`Room code is ${IDM_JOIN_CODE_LEN} characters (A–Z, 0–9).`, true);
    idmRender();
    return;
  }
  idmHide();
  wglJoin(code);
}

/** D-pad / A / B while level-5 join keyboard is open. */
function idmJoinHandlePad(btn) {
  // 4=Up 5=Down 6=Left 7=Right 0=A 1=B 2=Select 3=Start
  const cols = IDM_JOIN_COLS;
  const letterRows = Math.ceil(IDM_JOIN_LETTER_COUNT / cols); // 4
  const k = idm.joinKey;

  if (btn === 6) { // Left
    if (k < IDM_JOIN_LETTER_COUNT) {
      const col = k % cols;
      const row = Math.floor(k / cols);
      idm.joinKey = col > 0 ? k - 1 : row * cols + (cols - 1);
      // Clamp if last row is short (36 / 9 = 4 exact — full rows)
      if (idm.joinKey >= IDM_JOIN_LETTER_COUNT) idm.joinKey = IDM_JOIN_LETTER_COUNT - 1;
    } else {
      // Action row: DEL ↔ OK ↔ X
      idm.joinKey = k === IDM_JOIN_KEY_DEL ? IDM_JOIN_KEY_X
        : k === IDM_JOIN_KEY_OK ? IDM_JOIN_KEY_DEL
        : IDM_JOIN_KEY_OK;
    }
    idmRender();
    return true;
  }
  if (btn === 7) { // Right
    if (k < IDM_JOIN_LETTER_COUNT) {
      const col = k % cols;
      const row = Math.floor(k / cols);
      idm.joinKey = col < cols - 1 ? k + 1 : row * cols;
    } else {
      idm.joinKey = k === IDM_JOIN_KEY_DEL ? IDM_JOIN_KEY_OK
        : k === IDM_JOIN_KEY_OK ? IDM_JOIN_KEY_X
        : IDM_JOIN_KEY_DEL;
    }
    idmRender();
    return true;
  }
  if (btn === 4) { // Up
    if (k < IDM_JOIN_LETTER_COUNT) {
      const col = k % cols;
      const row = Math.floor(k / cols);
      if (row > 0) idm.joinKey = (row - 1) * cols + col;
      else {
        // Wrap to action row under same column band
        idm.joinKey = col < 3 ? IDM_JOIN_KEY_DEL : col < 6 ? IDM_JOIN_KEY_OK : IDM_JOIN_KEY_X;
      }
    } else {
      // From actions → last letter row
      const col = k === IDM_JOIN_KEY_DEL ? 1 : k === IDM_JOIN_KEY_OK ? 4 : 7;
      idm.joinKey = (letterRows - 1) * cols + col;
    }
    idmRender();
    return true;
  }
  if (btn === 5) { // Down
    if (k < IDM_JOIN_LETTER_COUNT) {
      const col = k % cols;
      const row = Math.floor(k / cols);
      if (row < letterRows - 1) {
        const next = (row + 1) * cols + col;
        idm.joinKey = next < IDM_JOIN_LETTER_COUNT ? next : IDM_JOIN_LETTER_COUNT - 1;
      } else {
        idm.joinKey = col < 3 ? IDM_JOIN_KEY_DEL : col < 6 ? IDM_JOIN_KEY_OK : IDM_JOIN_KEY_X;
      }
    } else {
      // From actions → first letter row
      const col = k === IDM_JOIN_KEY_DEL ? 1 : k === IDM_JOIN_KEY_OK ? 4 : 7;
      idm.joinKey = col;
    }
    idmRender();
    return true;
  }
  if (btn === 0 || btn === 3) { // A or Start = press key / submit on Start with full code
    if (btn === 3 && idm.joinCode.length === IDM_JOIN_CODE_LEN) {
      idmJoinSubmit();
      return true;
    }
    if (k < IDM_JOIN_LETTER_COUNT) {
      idmJoinAppend(IDM_JOIN_ALPHABET[k]);
      if (idm.joinCode.length === IDM_JOIN_CODE_LEN) {
        // Nudge focus to OK when code is complete
        idm.joinKey = IDM_JOIN_KEY_OK;
        idmRender();
      }
      return true;
    }
    if (k === IDM_JOIN_KEY_DEL) {
      idmJoinDelete();
      return true;
    }
    if (k === IDM_JOIN_KEY_OK) {
      idmJoinSubmit();
      return true;
    }
    if (k === IDM_JOIN_KEY_X) {
      idmLeaveJoinView();
      return true;
    }
    return true;
  }
  if (btn === 1) { // B = backspace, or leave if empty
    if (!idmJoinDelete()) idmLeaveJoinView();
    return true;
  }
  if (btn === 2) { // Select = cancel
    idmLeaveJoinView();
    return true;
  }
  return true;
}

/** HTML overlay QR (advanced panel / large desktop share). */
async function wglShowQrForRoom(code) {
  code = (code || wglRoomId || "").toUpperCase().trim();
  if (!code) {
    setStatus("No room code yet — Host first.", true);
    return;
  }
  await ensureWglShareOrigin();
  const url = wglShareUrl(code);
  _wglQrUrl = url;

  const overlay = document.getElementById("wgl-qr-overlay");
  const box = document.getElementById("wgl-qr-box");
  const roomEl = document.getElementById("wgl-qr-room");
  const urlEl = document.getElementById("wgl-qr-url");
  if (!overlay || !box) return;

  if (roomEl) roomEl.textContent = code;
  if (urlEl) urlEl.textContent = url;
  wglPaintQr(box, url, 220);

  // Also mirror a small QR under the advanced-menu hosting row.
  const inline = document.getElementById("wgl-qr-inline");
  if (inline) {
    wglPaintQr(inline, url, 128);
    inline.classList.add("visible");
    inline.setAttribute("aria-hidden", "false");
  }

  overlay.hidden = false;
  overlay.setAttribute("aria-hidden", "false");
}

function wglHideQrOverlay() {
  const overlay = document.getElementById("wgl-qr-overlay");
  if (!overlay) return;
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");
  const box = document.getElementById("wgl-qr-box");
  if (box) box.innerHTML = "";
}

function wglShowJoinOverlay() {
  const overlay = document.getElementById("wgl-join-overlay");
  const input = document.getElementById("wgl-join-input");
  if (!overlay) return;
  overlay.hidden = false;
  overlay.setAttribute("aria-hidden", "false");
  if (input) {
    input.value = "";
    setTimeout(() => input.focus(), 50);
  }
}

function wglHideJoinOverlay() {
  const overlay = document.getElementById("wgl-join-overlay");
  if (!overlay) return;
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");
}

// QR / join overlay buttons
document.getElementById("wgl-qr-btn")?.addEventListener("click", () => {
  if (wglRoomId) wglShowQrForRoom(wglRoomId);
});
document.getElementById("wgl-qr-close")?.addEventListener("click", wglHideQrOverlay);
document.getElementById("wgl-qr-copy")?.addEventListener("click", () => {
  if (wglRoomId) wglCopyLink(wglRoomId);
});
document.getElementById("wgl-qr-overlay")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) wglHideQrOverlay();
});
document.getElementById("wgl-join-close")?.addEventListener("click", wglHideJoinOverlay);
document.getElementById("wgl-join-overlay")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) wglHideJoinOverlay();
});
document.getElementById("wgl-join-go")?.addEventListener("click", () => {
  const input = document.getElementById("wgl-join-input");
  const code = (input?.value || "").toUpperCase().trim();
  if (!code) return;
  wglHideJoinOverlay();
  wglJoin(code);
});
document.getElementById("wgl-join-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("wgl-join-go")?.click();
  } else if (e.key === "Escape") {
    e.preventDefault();
    wglHideJoinOverlay();
  }
});

function wglDisconnect() {
  wglGameActive = false;
  if (bot) bot.setInputDelay(0); // restore local timing for non-lockstep modes
  if (wglLockstepAnimId) { cancelAnimationFrame(wglLockstepAnimId); wglLockstepAnimId = null; }
  if (wglPingInterval) { clearInterval(wglPingInterval); wglPingInterval = null; }
  if (webgblink) { webgblink.close(); webgblink = null; }
  wglRomHash = null; wglRomMeta = null; wglRomChunks = []; wglGuestRomBytes = null;
  wglLocalInputs.clear(); wglRemoteInputs.clear();
  wglFrameIndex = 0; wglNextSendFrame = 0; wglLocalButtons = 0;
  wglHideQrOverlay();
  wglHideInlineQr();
  wglHideJoinOverlay();
  wglShowState('idle');
  wglTransfer.hidden = true;
  document.getElementById('wgl-ping').textContent = '';
  wglResetNetDot();
  const lastPhase = wglPhase;
  wglResetDiag();
  wglStatus(
    lastPhase
      ? `Disconnected (was: ${lastPhase}).`
      : "WebGBLink disconnected."
  );
  if (typeof idm !== "undefined" && idm.open && idm.level === 3) idmRender();
}

const _wglNetDot = document.getElementById('wgl-net-dot');

function wglResetNetDot() {
  if (_wglNetGreenTimer) { clearTimeout(_wglNetGreenTimer); _wglNetGreenTimer = null; }
  _wglNetDot.hidden = true;
  _wglNetDot.className = '';
}

// Called once per second during lockstep. stalls + frames = total rAF ticks in window.
function wglUpdateNetQuality(stalls, frames) {
  const total = stalls + frames;
  let quality;
  if (stalls === 0)                          quality = 'green';
  else if (total > 0 && stalls / total <= 0.30) quality = 'orange';
  else                                       quality = 'red';

  _wglNetDot.hidden = false;
  _wglNetDot.className = 'net-' + quality;

  if (quality === 'green') {
    if (!_wglNetGreenTimer) {
      _wglNetGreenTimer = setTimeout(() => {
        _wglNetDot.hidden = true;
        _wglNetGreenTimer = null;
      }, 4000);
    }
  } else {
    if (_wglNetGreenTimer) { clearTimeout(_wglNetGreenTimer); _wglNetGreenTimer = null; }
    setStatus(quality === 'orange' ? 'Degraded network' : 'Bad network');
  }
  return quality;
}

function wglOnReady() {
  wglShowState('connected');
  wglSetPhase('channel-open');
  if (webgblink.isHost) {
    if (!_lastRomBytes) {
      wglSetPhase('error', 'no ROM loaded on host — load a ROM then re-host');
      return;
    }
    wglSetPhase('host-announce', (_activeRomName || 'ROM') + ' ' + _lastRomBytes.length + ' B');
    computeRomHash(_lastRomBytes).then(hash => {
      if (!webgblink?.isConnected) return;
      wglRomHash = hash;
      const announce = {
        type: 'rom-announce',
        name: _activeRomName ?? 'game.rom',
        hash,
        size: _lastRomBytes.length,
      };
      wglDiag.announceSize = announce.size;
      console.log('[webgblink] host → rom-announce', announce.name, announce.size, hash.slice(0, 12) + '…');
      webgblink.send(announce);
      wglNoteMsgOut('rom-announce');
      wglSetPhase('host-wait-req', announce.name + ' · ' + announce.size + ' B · hash ' + hash.slice(0, 8));
    }).catch(err => {
      console.error('[webgblink] host hash failed', err);
      wglSetPhase('error', 'hash failed: ' + err);
    });
    if (wglPingInterval) clearInterval(wglPingInterval);
    wglPingInterval = setInterval(() => {
      if (webgblink?.isConnected) {
        webgblink.send({ type: 'ping', ts: performance.now() });
        wglNoteMsgOut('ping');
      }
    }, 1000);
  } else {
    wglSetPhase('guest-wait-ann', 'host should send rom-announce next');
  }
}

async function wglHandleMessage(msg) {
  // PeerJS binary serialization delivers ArrayBuffers as Uint8Array on the receiver.
  // Accept any binary view and normalise to an isolated ArrayBuffer.
  if (msg instanceof ArrayBuffer || ArrayBuffer.isView(msg)) {
    const buf = msg instanceof ArrayBuffer
      ? msg
      : msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength);
    wglNoteMsgIn('chunk');
    wglHandleRomChunk(buf);
    return;
  }
  if (msg && typeof msg === 'object' && msg.type) {
    wglNoteMsgIn(msg.type);
  } else {
    wglNoteMsgIn(typeof msg);
    wglStatus(
      `[${webgblink?.isHost ? 'HOST' : 'GUEST'}] odd message type: ${Object.prototype.toString.call(msg)}`,
      true
    );
  }
  switch (msg.type) {
    case 'ping':
      webgblink.send({ type: 'pong', ts: msg.ts });
      wglNoteMsgOut('pong');
      break;
    case 'pong': {
      const rtt = Math.round(performance.now() - msg.ts);
      wglDiag.lastRttMs = rtt;
      webgblink.send({ type: 'rtt', ms: rtt });
      wglNoteMsgOut('rtt');
      document.getElementById('wgl-ping').textContent = rtt + ' ms';
      break;
    }
    case 'rtt':
      wglDiag.lastRttMs = msg.ms;
      document.getElementById('wgl-ping').textContent = msg.ms + ' ms';
      break;
    // guest-side ROM transfer
    case 'rom-announce': await wglGuestHandleAnnounce(msg); break;
    case 'rom-end':      await wglGuestHandleRomEnd(msg);   break;
    case 'game-start':   wglGuestHandleGameStart(msg);      break;
    // host-side ROM transfer responses
    case 'rom-ready':
      console.log('[webgblink] guest rom-ready → game-start');
      webgblink.send({ type: 'game-start', side: 'B' });
      wglNoteMsgOut('game-start');
      wglSetPhase('starting', 'guest ready');
      wglStartGame(_lastRomBytes, 'A');
      break;
    case 'rom-request':
      console.log('[webgblink] guest rom-request → sending ROM');
      wglSetPhase('host-sending', (wglDiag.announceSize || _lastRomBytes?.length || 0) + ' B');
      wglHostSendRom();
      break;
    // lockstep: the peer's joypad input for a future frame
    case 'input':
      wglRemoteInputs.set(msg.frame, msg.mask);
      break;
    default:
      if (msg && msg.type) {
        wglStatus(`[?] unknown msg type: ${msg.type}`, true);
      }
      break;
  }
}

// ── Lockstep netplay loop ─────────────────────────────────────────────────────

// Exposes the local player's side of a GbEmuPair as a GbEmu-like object, so all
// existing keyboard / touch / panel / stats code works unchanged. key_down/up
// update the local button MASK (applied later through the synchronized input
// queue, never directly to the emulator) to keep both simulations deterministic.
class GbEmuPairLocalSide {
  constructor(pair, side) { this._pair = pair; this._side = side; }
  key_down(btn) { wglLocalButtons |=  (1 << btn); }
  key_up(btn)   { wglLocalButtons &= ~(1 << btn); }
  read_mem(addr)       { return this._side === 'A' ? this._pair.read_mem_a(addr)   : this._pair.read_mem_b(addr); }
  read_mem_range(s, l) { return this._side === 'A' ? this._pair.read_mem_range_a(s, l) : this._pair.read_mem_range_b(s, l); }
  set_palette(i)       { this._pair.set_palette(i); }
  save_state()         { return this._pair.save_state_a(); }   // best-effort (host side only)
  load_state(b)        { this._pair.load_state_a(b); }
  get_audio_buffer()   { return this._side === 'A' ? this._pair.get_audio_buffer_a() : this._pair.get_audio_buffer_b(); }
}

function wglStartGame(romBytes, side) {
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  if (wglLockstepAnimId) { cancelAnimationFrame(wglLockstepAnimId); wglLockstepAnimId = null; }

  // Each side runs the SAME GbEmuPair (both Game Boys); GbEmuPair.load_rom skips
  // the RNG warm-up so both start bit-identical and stay in lockstep. The link
  // cable is resolved in-process — no per-frame serial traffic over the network.
  emuPair = new GbEmuPair();
  emuPair.load_rom(romBytes);
  emuPair.set_palette(paletteIndex);
  wglLockstepSide = side;                 // 'A' = host (left GB), 'B' = guest (right GB)
  emu  = new GbEmuPairLocalSide(emuPair, side);
  emuB = null;
  window._gbEmuPair = emuPair;
  installGbmulDebugBridge();
  initAudio();

  wglFrameIndex = 0; wglNextSendFrame = 0; wglLocalButtons = 0;
  wglLocalInputs.clear(); wglRemoteInputs.clear();
  _wglAutoBtnFrames = 0; _wglAutoBtnCode = -1;
  _wglSplashPressed = false; _wglSelected2P = false;
  _wglStartedGame = false; _wgl2PFrames = 0;
  _wglLastState = null;

  // Bot taps go through lockstep — they're applied WGL_INPUT_DELAY frames later.
  if (botEnabled) { if (rustBot && typeof rustBot.setInputDelay === 'function') rustBot.setInputDelay(WGL_INPUT_DELAY); else if (bot) bot.setInputDelay(WGL_INPUT_DELAY); }

  wglSetPhase('running', 'side ' + side);
  // After start, allow the status line to settle (still sticky until next setStatus).
  wglStatus(`[${side === 'A' ? 'HOST' : 'GUEST'}] Game running (side ${side})`);
  wglLockstepLoop();
}

// Auto-navigate the splash + title screens. In lockstep each side drives only
// its OWN player through the button mask (host → side A, guest → side B); the
// inputs are synchronized so both simulations stay identical. The host presses
// Start to begin (in-process serial master); the guest only selects 2P.
function wglFrameTick() {
  // Release a held auto-press after ~8 frames (keys need ≥100ms to register).
  if (_wglAutoBtnFrames > 0) {
    _wglAutoBtnFrames--;
    if (_wglAutoBtnFrames === 0 && _wglAutoBtnCode >= 0) {
      emu.key_up(_wglAutoBtnCode);
      _wglAutoBtnCode = -1;
    }
    return;
  }

  const state = detectGameState(emu);

  // Re-arm navigation each time we return to the title/splash/game-over.
  if (state !== _wglLastState) {
    if (state === 'title' || state === 'splash' || state === 'game-over' || state === 'win') {
      _wglSelected2P  = false;
      _wglStartedGame = false;
      _wgl2PFrames    = 0;
    }
    if (botEnabled) {
      if (_wglLastState === 'in-game' && state !== 'paused') {
        if (rustBot) rustBotReset(); else bot.reset(emu);
      }
      if (state === 'in-game') {
        if (rustBot) rustBot.resetStats(); else if (bot) bot.resetStats();
        window._prevPieceMinY = 255;
        clearMisdropSpawnCaptures();
        window._suppressNextMisdropCapture = false;
      }
    }
    _wglLastState = state;
  }

  // Bot tick — drive the local player's side when bot is enabled in WebGBLink mode.
  // key_down/key_up on emu routes through wglLocalButtons → lockstep protocol.
  if (botEnabled && (state === 'in-game' || state === 'paused')) {
    // Capture before tick so path setup does not overwrite plan-time spawn.
    rememberSpawnFullState();
    if (rustBot) {
      rustBotTick();
    } else {
      bot.tick(emu, state);
    }
    checkForPendingMisdropReplay();
    rememberSpawnFullState();
  }

  // Skip the splash/intro on both sides.
  if (state === 'splash') {
    if (!_wglSplashPressed) {
      _wglSplashPressed = true;
      emu.key_down(3);              // Start
      _wglAutoBtnFrames = 8; _wglAutoBtnCode = 3;
    }
    return;
  }
  _wglSplashPressed = false;

  if (state !== 'title') return;

  // Move the cursor to 2-PLAYER (both sides drive their own player).
  const c001 = emu.read_mem(0xC001);
  if (!_wglSelected2P) {
    if (c001 === 0x60) {
      _wglSelected2P = true;       // cursor on 2-PLAYER
    } else if (c001 === 0x10) {
      emu.key_down(7);             // Right → move cursor to 2-PLAYER
      _wglAutoBtnFrames = 8; _wglAutoBtnCode = 7;
    }
    return;
  }

  // Host only: after a short pause (so the guest has reached the 2P title too),
  // press Start to begin. Side A becomes the in-process serial master; side B
  // (guest) stays on the 2P title and is pulled in as slave — same as local 2P.
  if (webgblink?.isHost && !_wglStartedGame) {
    _wgl2PFrames++;
    if (_wgl2PFrames >= 30) {       // ~0.5 s
      _wglStartedGame = true;
      emu.key_down(3);             // Start
      _wglAutoBtnFrames = 8; _wglAutoBtnCode = 3;
    }
  }
}

// Diagnostics (throttled to ~1 Hz).
let _wglDbgFrames  = 0;
let _wglDbgStalls  = 0;
let _wglDbgLastLog = 0;
let _wglNetGreenTimer = null;

// Step exactly one lockstep frame. Returns false (and stalls) when the remote
// player's input for the current frame hasn't arrived yet.
function wglStepFrame() {
  // Capture + send our input for every frame up to (current + delay). Each
  // applyFrame is sent exactly once and never changed afterwards.
  while (wglNextSendFrame <= wglFrameIndex + WGL_INPUT_DELAY) {
    const mask = wglLocalButtons;
    wglLocalInputs.set(wglNextSendFrame, mask);
    if (webgblink?.isConnected) webgblink.send({ type: 'input', frame: wglNextSendFrame, mask });
    wglNextSendFrame++;
  }

  // Need the remote player's input for the frame we're about to run.
  if (!wglRemoteInputs.has(wglFrameIndex)) { _wglDbgStalls++; return false; }

  const localMask  = wglLocalInputs.get(wglFrameIndex) ?? 0;
  const remoteMask = wglRemoteInputs.get(wglFrameIndex);
  if (wglLockstepSide === 'A') { emuPair.set_input_a(localMask); emuPair.set_input_b(remoteMask); }
  else                         { emuPair.set_input_b(localMask); emuPair.set_input_a(remoteMask); }

  const both   = emuPair.run_frame_pair();
  const stride = 160 * 144 * 4;
  if (wglLockstepSide === 'A') {
    drawFrame(ctx, both.subarray(0, stride));
    drainAudio(emuPair.get_audio_buffer_a());
    emuPair.get_audio_buffer_b();                     // discard opponent audio (bound memory)
    if (showBotScreen) drawFrame(ctxBot, both.subarray(stride));
  } else {
    drawFrame(ctx, both.subarray(stride));            // own screen = side B
    drainAudio(emuPair.get_audio_buffer_b());
    emuPair.get_audio_buffer_a();                     // discard opponent audio (bound memory)
    if (showBotScreen) drawFrame(ctxBot, both.subarray(0, stride));
  }

  wglLocalInputs.delete(wglFrameIndex);
  wglRemoteInputs.delete(wglFrameIndex);
  wglFrameIndex++;

  wglFrameTick();   // drive this side's auto-navigation for the next frame

  fpsFrameTimes.push(performance.now());
  if (fpsFrameTimes.length > 180) fpsFrameTimes.shift();
  _wglDbgFrames++;
  return true;
}

function wglLockstepLoop() {
  wglGameActive = true;
  const role = webgblink?.isHost ? 'A/host' : 'B/guest';
  console.log(`[wgl-loop] lockstep started (${role}) side=${wglLockstepSide}`);
  let lastTs = null, accum = 0;

  const tick = (ts) => {
    if (!wglGameActive || !webgblink?.isConnected) {
      wglGameActive = false; wglLockstepAnimId = null;
      wglResetNetDot();
      console.log(`[wgl-loop ${role}] lockstep ended`);
      return;
    }
    wglLockstepAnimId = requestAnimationFrame(tick);
    if (lastTs === null) { lastTs = ts; return; }
    accum += Math.min(ts - lastTs, 100);   // clamp after tab suspend
    lastTs = ts;

    // Step toward real-time pace, up to a few frames per rAF to recover from a
    // stall, but never ahead of the remote (wglStepFrame stalls if its input is
    // missing).
    let steps = 0;
    while (accum >= TARGET_FRAME_MS && steps < 4) {
      if (!wglStepFrame()) break;
      accum -= TARGET_FRAME_MS;
      steps++;
    }
    if (accum > TARGET_FRAME_MS * 4) accum = TARGET_FRAME_MS * 4;   // bound backlog

    const now = performance.now();
    if (now - _wglDbgLastLog >= 1000) {
      const st = detectGameState(emu);
      const q = wglUpdateNetQuality(_wglDbgStalls, _wglDbgFrames);
      console.log(`[wgl-loop ${role}] state=${st} fps=${_wglDbgFrames} stalls=${_wglDbgStalls} quality=${q} frame=${wglFrameIndex} remoteBuf=${wglRemoteInputs.size}`);
      _wglDbgFrames = 0; _wglDbgStalls = 0; _wglDbgLastLog = now;
    }
  };

  wglLockstepAnimId = requestAnimationFrame(tick);
}

// ── Host: send ROM in binary chunks ───────────────────────────────────────────
// 4 KiB is safer on mobile SCTP / PeerJS than 16 KiB (fewer silent drops).
const WGL_CHUNK_SIZE = 4 * 1024;

async function wglHostSendRom() {
  if (!_lastRomBytes || !webgblink?.isConnected) return;
  const bytes = _lastRomBytes;
  const total = Math.ceil(bytes.length / WGL_CHUNK_SIZE);
  console.log('[webgblink] host sending ROM', bytes.length, 'B in', total, 'chunks');
  wglDiag.chunksOut = 0;
  wglSetPhase('host-sending', `0 / ${total} chunks · ${bytes.length} B`);
  for (let i = 0; i < total; i++) {
    if (!webgblink?.isConnected) {
      wglSetPhase('error', 'disconnected during ROM send');
      return;
    }
    const slice = bytes.slice(i * WGL_CHUNK_SIZE, (i + 1) * WGL_CHUNK_SIZE);
    const buf  = new ArrayBuffer(8 + slice.byteLength);
    const view = new DataView(buf);
    view.setUint32(0, i, true);
    view.setUint32(4, total, true);
    new Uint8Array(buf, 8).set(slice);
    webgblink.send(buf);
    wglDiag.chunksOut = i + 1;
    wglNoteMsgOut('chunk');
    // Yield often so the UI paints and the SCTP stack can flush on mobile.
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
    if (i % 8 === 7 || i === total - 1) {
      wglSetPhase('host-sending', `${i + 1} / ${total} chunks`);
    }
  }
  webgblink.send({ type: 'rom-end', hash: wglRomHash });
  wglNoteMsgOut('rom-end');
  console.log('[webgblink] host → rom-end');
  wglSetPhase('host-wait-ready', `${total} chunks sent`);
}

// ── Guest: handle rom-announce — check IDB cache by hash ─────────────────────
async function wglGuestHandleAnnounce(msg) {
  wglRomMeta   = msg;
  wglRomChunks = [];
  wglDiag.announceSize = msg.size || 0;
  console.log('[webgblink] rom-announce', msg.name, msg.hash.slice(0, 8) + '…');
  wglSetPhase(
    'guest-wait-ann',
    `got announce: ${msg.name || '?'} · ${msg.size || '?'} B · ${String(msg.hash || '').slice(0, 8)}`
  );
  try {
    const cached = await loadRomByHashFromDb(msg.hash);
    if (cached) {
      console.log('[webgblink] ROM found in IDB cache');
      wglGuestRomBytes = new Uint8Array(cached.data);
      _activeRomName   = cached.name;
      wglSetPhase('guest-cache-hit', cached.name || msg.name);
      webgblink.send({ type: 'rom-ready' });
      wglNoteMsgOut('rom-ready');
      wglSetPhase('guest-wait-start', 'from cache');
      return;
    }
  } catch (e) {
    console.warn('[webgblink] IDB cache lookup failed', e);
  }
  console.log('[webgblink] ROM not cached — requesting transfer');
  wglTransfer.hidden   = false;
  wglTransferLabel.textContent = 'Receiving ROM…';
  wglTransferBar.value = 0;
  wglTransferBar.max   = 1;
  wglSetPhase('guest-request', `${msg.size || '?'} B to download`);
  webgblink.send({ type: 'rom-request' });
  wglNoteMsgOut('rom-request');
  wglSetPhase('guest-receiving', '0 chunks yet');
}

// ── Guest: accumulate binary chunks ──────────────────────────────────────────
function wglHandleRomChunk(buf) {
  const view  = new DataView(buf);
  const index = view.getUint32(0, true);
  const total = view.getUint32(4, true);
  wglRomChunks[index] = buf.slice(8);
  wglDiag.chunksIn = wglRomChunks.filter(Boolean).length;
  const received = wglDiag.chunksIn;
  wglTransfer.hidden = false;
  wglTransferBar.value = total ? received / total : 0;
  wglTransferLabel.textContent = `Receiving ROM… ${received} / ${total}`;
  // Throttle status rewrites a bit (every chunk is fine for 32KB / 4KB = 8 steps).
  wglSetPhase('guest-receiving', `${received} / ${total} chunks`);
}

// ── Guest: handle rom-end — reassemble, verify SHA-256, save ─────────────────
async function wglGuestHandleRomEnd(msg) {
  if (!wglRomMeta) {
    wglSetPhase('error', 'rom-end without rom-announce');
    return;
  }
  const missing = [];
  const expected = wglRomChunks.length; // sparse array length = last index+1 if dense
  // Count holes if host told us total via last chunk header.
  let totalHint = 0;
  for (let i = 0; i < wglRomChunks.length; i++) {
    if (!wglRomChunks[i]) missing.push(i);
  }
  // Prefer total from any received chunk header (stored length of dense pack).
  try {
    // Re-read total from last non-empty is hard; use filter count vs announce size.
    totalHint = Math.ceil((wglRomMeta.size || 0) / WGL_CHUNK_SIZE) || wglRomChunks.filter(Boolean).length;
  } catch (_) { /* ignore */ }

  if (missing.length) {
    wglSetPhase(
      'error',
      `missing ${missing.length} chunk(s) e.g. #${missing.slice(0, 5).join(',')}` +
      (totalHint ? ` / ~${totalHint}` : '')
    );
    return;
  }

  wglSetPhase('guest-verify', `${wglRomChunks.filter(Boolean).length} chunks`);
  const totalSize = wglRomChunks.reduce((s, c) => s + (c ? c.byteLength : 0), 0);
  const full = new Uint8Array(totalSize);
  let off = 0;
  for (const chunk of wglRomChunks) {
    if (!chunk) continue;
    full.set(new Uint8Array(chunk), off);
    off += chunk.byteLength;
  }

  const actualHash = await computeRomHash(full);
  if (actualHash !== msg.hash) {
    wglSetPhase(
      'error',
      `hash mismatch got ${actualHash.slice(0, 12)}… want ${String(msg.hash).slice(0, 12)}… (${totalSize} B)`
    );
    console.error('[webgblink] hash mismatch', actualHash, '≠', msg.hash);
    return;
  }

  wglGuestRomBytes = full;
  _activeRomName   = wglRomMeta.name;
  wglTransfer.hidden = true;
  wglRomChunks = [];
  try {
    await saveRomToDb(wglRomMeta.name, full, actualHash);
    console.log('[webgblink] ROM saved to IndexedDB:', wglRomMeta.name, actualHash.slice(0, 12));
  } catch (e) {
    console.error('[webgblink] failed to save ROM to IndexedDB:', e);
  }
  webgblink.send({ type: 'rom-ready' });
  wglNoteMsgOut('rom-ready');
  wglSetPhase('guest-wait-start', `${totalSize} B ok`);
}

// ── Guest: handle game-start ──────────────────────────────────────────────────
function wglGuestHandleGameStart(msg) {
  console.log('[webgblink] game-start, side=', msg.side);
  if (!wglGuestRomBytes) {
    wglSetPhase('error', 'game-start but no ROM assembled');
    return;
  }
  hideRomOverlay();
  wglSetPhase('starting', 'side ' + (msg.side || '?'));
  wglStartGame(wglGuestRomBytes, msg.side);
}

// ── Button wiring ─────────────────────────────────────────────────────────────
function wglBindPeerEvents(wgl, { onReady }) {
  wgl.addEventListener('ready', onReady);
  wgl.addEventListener('message', e => wglHandleMessage(e.detail));
  wgl.addEventListener('disconnected', () => {
    const phase = wglPhase;
    wglDisconnect();
    wglStatus(
      `Peer disconnected${phase ? ` during: ${phase}` : ''}.`,
      true
    );
  });
  wgl.addEventListener('status', e => {
    const { text, level } = e.detail || {};
    if (!text) return;
    if (wglGameActive) return;
    // Map low-level webgblink events onto phases when possible.
    const t = String(text);
    if (/Opening host/i.test(t)) {
      wglSetPhase('host-open');
    } else if (/Room .+ open/i.test(t) || /waiting for guest/i.test(t)) {
      wglSetPhase('host-waiting');
    } else if (/Opening guest/i.test(t)) {
      wglSetPhase('guest-open', t);
    } else if (
      /Signaling OK/i.test(t) ||
      /negotiating data channel/i.test(t) ||
      /Guest peer connecting/i.test(t) ||
      /^Guest: ICE=/i.test(t) ||
      /^Host: ICE=/i.test(t)
    ) {
      wglSetPhase('guest-ice', t);
    } else if (/Data channel open/i.test(t)) {
      /* ready handler will set phase */
    } else if (level === 'error' || /timeout|Error\b/i.test(t)) {
      wglSetPhase('error', t);
    } else {
      wglStatus(`[…] ${t}`, false);
    }
  });
}

async function wglHost() {
  if (webgblink) wglDisconnect();
  wglResetDiag();
  await ensureWglShareOrigin();
  wglUpdateShareHint();

  if (wglIsLoopbackHost()) {
    const port = location.port || '8000';
    const ip = _wglLanIp || 'YOUR-LAN-IP';
    wglStatus(
      `Hosting from localhost — phone guests will fail. Open http://${ip}:${port}/ on this PC, then Host again.`,
      true
    );
    // Still allow hosting (two desktop tabs on localhost work); just warn loudly.
  }

  if (!_lastRomBytes) {
    wglStatus('Load a ROM before hosting a WebGBLink game.', true);
    return;
  }

  webgblink = new WebGBLink();
  wglBindPeerEvents(webgblink, { onReady: () => wglOnReady() });
  wglSetPhase('host-open', (_activeRomName || 'ROM') + ' ' + _lastRomBytes.length + ' B');
  try {
    const roomId = await webgblink.setupAsHost();
    wglSetRoomCode(roomId);
    wglShowState('hosting');
    const url = wglShareUrl(roomId);
    wglSetPhase('host-waiting', url);
    // Paint a small QR under the advanced hosting row (full QR via Show QR / idm).
    const inline = document.getElementById("wgl-qr-inline");
    if (inline) {
      wglPaintQr(inline, url, 128);
      inline.classList.add("visible");
      inline.setAttribute("aria-hidden", "false");
    }
  } catch (err) {
    webgblink = null;
    wglShowState('idle');
    wglSetPhase('error', 'host: ' + (err?.message || err));
  }
}

async function wglJoin(roomId) {
  roomId = roomId.toUpperCase().trim();
  if (!roomId) return;
  if (webgblink) wglDisconnect();
  wglResetDiag();
  // Fresh guests (incognito / no ROM yet) keep the splash — show link progress there.
  showRomOverlayWglWaiting(`Joining room ${roomId}…`);
  webgblink = new WebGBLink();
  wglSetRoomCode(roomId);
  wglSetPhase('guest-open', 'room ' + roomId + ' · page ' + location.host);
  // Register listeners before setupAsGuest: 'ready' fires before the promise resolves.
  wglBindPeerEvents(webgblink, {
    onReady: () => { wglSetRoomCode(roomId); wglOnReady(); },
  });
  try {
    await webgblink.setupAsGuest(roomId);
  } catch (err) {
    webgblink = null;
    wglShowState('idle');
    wglSetPhase('error', 'join: ' + (err?.message || err));
  }
}

document.getElementById('wgl-host-btn').addEventListener('click', () => wglHost());
document.getElementById('wgl-join-btn').addEventListener('click', () => {
  wglJoin(document.getElementById('wgl-room-input').value);
});
document.getElementById('wgl-room-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') wglJoin(e.target.value);
});
document.getElementById('wgl-cancel-btn'   ).addEventListener('click', wglDisconnect);
document.getElementById('wgl-disconnect-btn').addEventListener('click', wglDisconnect);
document.getElementById('wgl-copy-btn'  ).addEventListener('click', () => { if (wglRoomId) wglCopyLink(wglRoomId); });
document.getElementById('wgl-copy-btn-c').addEventListener('click', () => { if (wglRoomId) wglCopyLink(wglRoomId); });

// Wrapper that makes GbEmuPair side A look like a GbEmu to all existing code.
class GbEmuPairSideA {
  constructor(pair) { this._pair = pair; }
  run_frame()            { return this._pair.run_frame_a(); }
  read_mem(addr)         { return this._pair.read_mem_a(addr); }
  read_mem_range(s,l)    { return this._pair.read_mem_range_a(s, l); }
  key_down(btn)          { this._pair.key_down_a(btn); }
  key_up(btn)            { this._pair.key_up_a(btn); }
  set_palette(i)         { this._pair.set_palette(i); }
  save_state()           { return this._pair.save_state_a(); }
  load_state(b)          { this._pair.load_state_a(b); }
  get_audio_buffer()     { return this._pair.get_audio_buffer_a(); }
}

// ── WASM init ────────────────────────────────────────────────────────────────
await init({ module_or_path: './pkg/gbmul_wasm_bg.wasm?v=173' });

// ── In-device menu state (hoisted before any code that may trigger drawFrame) ─
let idmIsOpen = false;

// URL auto-join AFTER wasm is ready (game-start needs GbEmuPair).
{
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) {
    document.getElementById('webgblink-panel').open = true;
    // Show splash progress immediately (before peer open) so phones without a
    // cached ROM don't only see "Drop a ROM here".
    showRomOverlayWglWaiting(`Joining room ${roomParam.toUpperCase()}…`);
    // Small delay so the status line / panel paint first.
    setTimeout(() => wglJoin(roomParam), 50);
  }
  // Warm LAN origin cache early (helps "Copy link" on localhost hosts).
  ensureWglShareOrigin().then(() => wglUpdateShareHint()).catch(() => {});
}

if (USE_RUST_BOT) {
  try {
    rustBot = new RustBot();
    installGbmulDebugBridge();
    console.log('[bot] Using RustBot (Rust implementation)');
    console.log('[debug] window.__gbmul ready — startStateProbe(), summarizeStateProbe(), getLockLog()');
    // dual init may have enabled the bot before RustBot existed — refresh UI now.
    updateBotStatus();
  } catch(e) {
    console.warn('[bot] RustBot not available, falling back to JS bot', e);
  }
}

// Restore saved PPS on load (after possible rustBot creation)
{
  dynamicBotPps = loadDynamicBotPps();
  const saved = localStorage.getItem(BOT_PPS_KEY);
  // New player (no key): 1.0 PPS. Explicit Infinity still honoured.
  let initPps;
  if (saved === null) {
    initPps = DYNAMIC_BOT_PPS_DEFAULT;
  } else if (saved === "Infinity") {
    initPps = Infinity;
  } else {
    const n = parseFloat(saved);
    initPps = !isNaN(n) && n >= 0 ? n : DYNAMIC_BOT_PPS_DEFAULT;
  }
  // Manual baseline: if last session left dynamic PPS in BOT_PPS_KEY, keep a
  // separate manual fallback of 1.0 so toggling dynamic off stays playable.
  if (dynamicBotSpeedOn && isFinite(initPps)
      && Math.abs(initPps - dynamicBotPps) < 0.05) {
    manualBotPps = DYNAMIC_BOT_PPS_DEFAULT;
  } else {
    manualBotPps = initPps;
  }
  // Persist defaults so first-run choices stick (dynamic ON + 1.0 + per-round).
  if (localStorage.getItem(DYNAMIC_BOT_SPEED_KEY) === null) {
    localStorage.setItem(DYNAMIC_BOT_SPEED_KEY, dynamicBotSpeedOn ? "1" : "0");
  }
  if (localStorage.getItem(DYNAMIC_BOT_MODE_KEY) === null) {
    localStorage.setItem(DYNAMIC_BOT_MODE_KEY, dynamicBotMode);
  }
  if (dynamicBotSpeedOn) {
    applyBotPps(dynamicBotPps, { source: 'dynamic', persist: true });
  } else {
    applyBotPps(manualBotPps, { source: 'manual', persist: true });
  }
  if (dynamicBotSpeedCheck) dynamicBotSpeedCheck.checked = dynamicBotSpeedOn;
  updateDynamicBotPpsUi();
}

// ── Restore-on-reload toggle ─────────────────────────────────────────────────
const restoreCheck = document.getElementById("restore-check");
restoreCheck.checked = localStorage.getItem("gbmul_restore") !== "0";
restoreCheck.addEventListener("change", () => {
  localStorage.setItem("gbmul_restore", restoreCheck.checked ? "1" : "0");
});

// ── Reset on misdrop (off by default) ────────────────────────────────────────
const MISDROP_RESET_ON_KEY = 'gbmul_misdrop_reset_on';
const misdropResetCheck = document.getElementById('misdrop-reset-check');
let misdropResetOn = localStorage.getItem(MISDROP_RESET_ON_KEY) === '1';
misdropResetCheck.checked = misdropResetOn;
misdropResetCheck.addEventListener('change', () => {
  misdropResetOn = misdropResetCheck.checked;
  localStorage.setItem(MISDROP_RESET_ON_KEY, misdropResetOn ? '1' : '0');
});

// ── Alert sound on misdrop (off by default, independent of game mute) ────────
// Misc "Sound" only zeros the APU ring buffer — it does NOT gate this alert.
// Failure mode we hit: AudioContext created/resumed only at misdrop time (game
// loop, no user gesture) → stays suspended → silent. Unlock on the same
// click/key/touch path as game audio, and schedule tones only after resume.
const MISDROP_ALERT_KEY = 'gbmul_misdrop_alert';
const misdropAlertCheck = document.getElementById('misdrop-alert-check');
let misdropAlertOn = localStorage.getItem(MISDROP_ALERT_KEY) === '1';
misdropAlertCheck.checked = misdropAlertOn;
/** Dedicated AudioContext — never routed through APU mute. */
let misdropAlertCtx = null;
/** True after a user gesture successfully resumed the alert context. */
let misdropAlertUnlocked = false;

function ensureMisdropAlertCtx() {
  if (!misdropAlertCtx) {
    misdropAlertCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return misdropAlertCtx;
}

/** Call from user-gesture handlers so later game-loop misdrops can make sound. */
function unlockMisdropAlertAudio() {
  if (!misdropAlertOn) return;
  try {
    const ctx = ensureMisdropAlertCtx();
    const p = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    Promise.resolve(p).then(() => {
      if (ctx.state === 'running') misdropAlertUnlocked = true;
    }).catch(() => {});
  } catch (_) {}
}

/**
 * Schedule alert tones on a running AudioContext (direct to destination —
 * independent of Misc "Sound" / audioMuted).
 */
function scheduleMisdropAlertTones(ctx) {
  const now = ctx.currentTime;
  const tones = [
    { freq: 880, start: 0, dur: 0.12 },
    { freq: 660, start: 0.14, dur: 0.18 },
    { freq: 990, start: 0.36, dur: 0.22 },
  ];
  for (const t of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = t.freq;
    // linear ramps avoid exponentialRamp zero-edge throws on some engines
    gain.gain.setValueAtTime(0, now + t.start);
    gain.gain.linearRampToValueAtTime(0.25, now + t.start + 0.015);
    gain.gain.linearRampToValueAtTime(0, now + t.start + t.dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + t.start);
    osc.stop(now + t.start + t.dur + 0.03);
  }
}

/**
 * Short PCM beep via HTMLAudioElement (does not use game mute).
 * Helps when Web Audio is still suspended; needs prior page interaction.
 */
function playMisdropAlertHtmlBeep() {
  // 0.15s 880Hz square-ish, 8-bit mono 22050Hz WAV
  const sr = 22050;
  const n = Math.floor(sr * 0.15);
  const dataSize = n;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data');
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = t < 0.01 ? t / 0.01 : t > 0.12 ? Math.max(0, (0.15 - t) / 0.03) : 1;
    const sq = Math.sin(2 * Math.PI * 880 * t) > 0 ? 1 : -1;
    v.setUint8(44 + i, Math.max(0, Math.min(255, 128 + Math.floor(sq * env * 90))));
  }
  const blob = new Blob([buf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.volume = 0.7;
  const done = () => { try { URL.revokeObjectURL(url); } catch (_) {} };
  audio.addEventListener('ended', done);
  audio.addEventListener('error', done);
  return audio.play().then(() => {
    // second chirp
    setTimeout(() => {
      const a2 = new Audio(url);
      a2.volume = 0.7;
      a2.playbackRate = 1.15;
      a2.play().catch(() => {});
    }, 160);
  }).catch((e) => {
    done();
    throw e;
  });
}

/**
 * Distinctive alert (not the game APU). Independent of Misc "Sound".
 * Browsers do not expose OS system sounds; Notification covers background tabs.
 */
function playMisdropAlertSound() {
  const tryWebAudio = () => {
    try {
      const ctx = ensureMisdropAlertCtx();
      const after = () => {
        if (ctx.state !== 'running') {
          console.warn('[misdrop] alert AudioContext not running:', ctx.state);
          return false;
        }
        misdropAlertUnlocked = true;
        scheduleMisdropAlertTones(ctx);
        return true;
      };
      if (ctx.state === 'suspended') {
        return Promise.resolve(ctx.resume()).then(after).catch((e) => {
          console.warn('[misdrop] alert AudioContext resume failed', e);
          return false;
        });
      }
      return Promise.resolve(after());
    } catch (e) {
      console.warn('[misdrop] alert Web Audio failed', e);
      return Promise.resolve(false);
    }
  };

  // Prefer Web Audio; HTML beep only if the context cannot run (still independent of game mute).
  tryWebAudio().then((ok) => {
    if (ok) return;
    playMisdropAlertHtmlBeep().catch((e) => {
      console.warn('[misdrop] alert HTML beep failed', e);
    });
  });
}

/** OS notification when permitted — often carries the system notification sound. */
function showMisdropAlertNotification(label) {
  try {
    if (typeof Notification === 'undefined') {
      console.warn('[misdrop] Notification API unavailable');
      return;
    }
    if (Notification.permission !== 'granted') {
      console.warn(
        '[misdrop] notification permission is',
        Notification.permission,
        '— enable alerts again (or browser site settings) for OS ping when tab is backgrounded'
      );
      return;
    }
    const n = new Notification('GBmul misdrop', {
      body: label || 'Misdrop recorded',
      tag: 'gbmul-misdrop-alert',
      silent: false,
      requireInteraction: false,
    });
    setTimeout(() => { try { n.close(); } catch (_) {} }, 6000);
  } catch (e) {
    console.warn('[misdrop] notification failed', e);
  }
}

function fireMisdropAlert(label) {
  if (!misdropAlertOn) return;
  console.log('[misdrop] alert fire', {
    label,
    unlocked: misdropAlertUnlocked,
    ctxState: misdropAlertCtx?.state ?? 'none',
    notif: typeof Notification !== 'undefined' ? Notification.permission : 'n/a',
    gameMuted: typeof audioMuted !== 'undefined' ? audioMuted : 'n/a',
  });
  playMisdropAlertSound();
  showMisdropAlertNotification(label);
}

misdropAlertCheck.addEventListener('change', () => {
  misdropAlertOn = misdropAlertCheck.checked;
  localStorage.setItem(MISDROP_ALERT_KEY, misdropAlertOn ? '1' : '0');
  if (misdropAlertOn) {
    // User gesture: unlock audio + optionally request notification permission.
    unlockMisdropAlertAudio();
    playMisdropAlertSound();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        console.log('[misdrop] notification permission:', perm);
      }).catch(() => {});
    }
  }
});

// ── Auto menu navigation (off by default) ────────────────────────────────────
const AUTO_MENU_NAV_KEY = "gbmul_auto_menu_nav";
const AUTO_MENU_TARGET_KEY = "gbmul_auto_menu_target";
const autoMenuNavCheck = document.getElementById("auto-menu-nav-check");
const autoMenuTypeSelect = document.getElementById("auto-menu-type-select");
const autoMenuLevelSelect = document.getElementById("auto-menu-level-select");
const autoMenuHighSelect = document.getElementById("auto-menu-high-select");
let autoMenuNav = localStorage.getItem(AUTO_MENU_NAV_KEY) === "1";
autoMenuNavCheck.checked = autoMenuNav;

function loadAutoMenuTargetSettings() {
  try {
    const raw = localStorage.getItem(AUTO_MENU_TARGET_KEY);
    if (raw) return normalizeGameSetup(JSON.parse(raw));
  } catch { /* ignore */ }
  return defaultMenuRestoreTarget();
}

function readAutoMenuTargetFromPickers() {
  return normalizeGameSetup({
    gameType: autoMenuTypeSelect.value,
    startLevel: Number(autoMenuLevelSelect.value),
    startHeight: autoMenuTypeSelect.value === "B" ? Number(autoMenuHighSelect.value) : 0,
  });
}

function syncAutoMenuHighPickerState() {
  const isB = autoMenuTypeSelect.value === "B";
  autoMenuHighSelect.disabled = !isB;
  if (!isB) autoMenuHighSelect.value = "0";
}

function applyAutoMenuTargetToPickers(setup) {
  const norm = normalizeGameSetup(setup) || defaultMenuRestoreTarget();
  autoMenuTypeSelect.value = norm.gameType;
  autoMenuLevelSelect.value = String(norm.startLevel);
  autoMenuHighSelect.value = String(norm.startHeight);
  syncAutoMenuHighPickerState();
}

function persistAutoMenuTarget() {
  const setup = readAutoMenuTargetFromPickers();
  localStorage.setItem(AUTO_MENU_TARGET_KEY, JSON.stringify(setup));
  _menuRestoreTarget = setup;
  if (_menuNavActive && autoMenuNav) {
    resetMenuRestoreProgress();
    planMenuRestoreSequence(setup);
  }
}

function applyAutoMenuNav(enabled) {
  autoMenuNav = enabled;
  localStorage.setItem(AUTO_MENU_NAV_KEY, enabled ? "1" : "0");
  // Main-loop auto-nav owns menu Start; keep bot nav off to avoid conflicting key_up(3).
  if (rustBot?.setAutoMenuNav) rustBot.setAutoMenuNav(false);
  else if (bot?.setAutoMenuNav) bot.setAutoMenuNav(false);
}

autoMenuNavCheck.addEventListener("change", () => {
  applyAutoMenuNav(autoMenuNavCheck.checked);
});
applyAutoMenuNav(autoMenuNav);

applyAutoMenuTargetToPickers(loadAutoMenuTargetSettings());
for (const el of [autoMenuTypeSelect, autoMenuLevelSelect, autoMenuHighSelect]) {
  el.addEventListener("change", () => {
    syncAutoMenuHighPickerState();
    persistAutoMenuTarget();
  });
}

// GB menu samples buttons for ≥100ms (~6 frames at 59.73fps). Level/HIGH cursors
// need a full press+release per step — never call autoMenuTapBtn unless canPress.
// key_down runs after run_frame; hold N → N emulated frames see the press.
const AUTO_MENU_LEVEL_HOLD_FRAMES = 6;   // fast level/high d-pad (~100ms)
const AUTO_MENU_GAMETYPE_HOLD_FRAMES = 12; // A/B cursor — must not share the short level hold
const AUTO_MENU_START_HOLD_FRAMES = 10;  // splash/title/gametype Start

function autoMenuCanPress() {
  return _autoStartFrames === 0 && _autoBtnFrames === 0;
}

function autoMenuTapStart(mirrorB = false, holdFrames = AUTO_MENU_START_HOLD_FRAMES) {
  emu.key_down(3);
  if (mirrorB && emuB) emuB.key_down(3);
  _autoStartFrames = holdFrames + Math.floor(Math.random() * 3);
}

function autoMenuTapBtn(btn, holdFrames = AUTO_MENU_LEVEL_HOLD_FRAMES) {
  emu.key_down(btn);
  _autoBtnCode = btn;
  _autoBtnFrames = holdFrames;
}

/** Release a held Start immediately (title/splash Start can bleed into gametype). */
function autoMenuReleaseStart() {
  if (_autoStartFrames > 0) {
    emu.key_up(3);
    if (emuB) emuB.key_up(3);
    _autoStartFrames = 0;
  }
}

const LAST_GAME_SETUP_KEY = 'gbmul_last_game_setup';

function defaultMenuRestoreTarget() {
  return { gameType: 'A', startLevel: 0, startHeight: 0 };
}

function normalizeGameSetup(raw) {
  if (!raw) return null;
  const gameType = raw.gameType === 'B' ? 'B' : 'A';
  return {
    gameType,
    startLevel: Math.max(0, Math.min(9, Number(raw.startLevel) || 0)),
    startHeight: gameType === 'B' ? Math.max(0, Math.min(5, Number(raw.startHeight) || 0)) : 0,
  };
}

/** Persisted Type / Level / High — frozen at game start, survives misdrop ROM reload. */
function freezeLastPlayedGameSetup(setup) {
  const frozen = normalizeGameSetup(setup);
  if (!frozen) return null;
  localStorage.setItem(LAST_GAME_SETUP_KEY, JSON.stringify(frozen));
  console.info('[menu-restore] frozen game setup:', JSON.stringify(frozen));
  return frozen;
}

function loadLastPlayedGameSetup() {
  try {
    const raw = localStorage.getItem(LAST_GAME_SETUP_KEY);
    if (!raw) return null;
    return normalizeGameSetup(JSON.parse(raw));
  } catch {
    return null;
  }
}

function ensureLastPlayedGameSetupFrozen() {
  const existing = loadLastPlayedGameSetup();
  if (existing) return existing;
  return freezeLastPlayedGameSetup(statsTracker.lastGameSetup());
}

/** A/B cursor on game-type and level-select screens (0x80=A, 0x00=B). */
function readGametypeCursor(emuRef) {
  return (emuRef.read_mem(0xFF86) & 0x80) ? 'A' : 'B';
}

/** Authoritative game type on level-select → in-game (FF86 still valid on commit frame). */
function readCommittedGameType(emuRef) {
  const ff86 = emuRef.read_mem(0xFF86);
  if (ff86 === 0x80) return 'A';
  if (ff86 === 0x00) return 'B';
  if (ff86 & 0x80) return 'A';
  if (statsTracker._pendingGameType === 'A' || statsTracker._pendingGameType === 'B') {
    return statsTracker._pendingGameType;
  }
  return 'A';
}

function gametypeMatchesTarget(emuRef, target) {
  if (!target) return true;
  // On B-type HIGH panel FF86 is not reliable — trust restore target instead.
  const e1 = emuRef.read_mem(MENU_HRAM_PHASE);
  if (target.gameType === 'B' && menuPhaseIsHigh(e1)) return true;
  const want = target.gameType === 'B' ? 'B' : 'A';
  return readGametypeCursor(emuRef) === want;
}

/** Target for auto-menu — Type / Level / High from the options pickers. */
function captureMenuRestoreTarget() {
  return readAutoMenuTargetFromPickers();
}

/** True when Tetris GB menu HRAM looks like a real level-select screen (not SRAM garbage). */
function isMenuHramValid(emuRef) {
  const e1 = emuRef.read_mem(MENU_HRAM_PHASE);
  if (!menuPhaseIsLevel(e1) && !menuPhaseIsHigh(e1)) return false;
  const c002 = emuRef.read_mem(0xC002);
  if (c002 > 9) return false;
  const ff86 = emuRef.read_mem(0xFF86);
  if (ff86 !== 0x80 && ff86 !== 0x00) return false;
  if (emuRef.read_mem(MENU_HRAM_LVL_A) > 9) return false;
  if (emuRef.read_mem(MENU_HRAM_LVL_B) > 9) return false;
  if (emuRef.read_mem(MENU_HRAM_HIGH_B) > 5) return false;
  return true;
}

/** Read menu selection from live WRAM (authoritative at Start / commit). */
function readGameSetupFromMenuState(emuRef) {
  const gameType = statsTracker._pendingGameType
    || ((emuRef.read_mem(0xFF86) & 0x80) ? 'A' : 'B');
  const live = readMenuCursorLive(emuRef);
  if (gameType === 'A') {
    return { gameType: 'A', startLevel: live.level, startHeight: 0 };
  }
  // B-type Start from LEVEL panel (H0 default) — never read stale high from WRAM.
  if (live.onLevel) {
    return { gameType: 'B', startLevel: live.level, startHeight: 0 };
  }
  return { gameType: 'B', startLevel: live.level, startHeight: live.high };
}

/** Game type for menu tracking during auto-nav (target drives restore plan). */
function readPendingGameType() {
  if (_menuNavActive && _menuRestoreTarget?.gameType) {
    return _menuRestoreTarget.gameType === 'B' ? 'B' : 'A';
  }
  return statsTracker._pendingGameType === 'B' ? 'B' : 'A';
}

/** Last menu selection tracked frame-by-frame — survives the in-game transition. */
function readGameSetupFromPendingTracker(emuRef) {
  const gameType = emuRef ? readCommittedGameType(emuRef) : readPendingGameType();
  return normalizeGameSetup({
    gameType,
    startLevel: statsTracker._pendingLevel,
    startHeight: gameType === 'B' ? statsTracker._pendingHeight : 0,
  });
}

/** Decode B-type startLevel/startHeight from HRAM 0xFFA9 (= level + height at game start). */
function decodeBTypeStartFromFfa9(ffa9) {
  const f = Math.max(0, ffa9 | 0);
  if (f <= 9) {
    return { startLevel: f, startHeight: 0 };
  }
  for (let h = 5; h >= 1; h--) {
    const lv = f - h;
    if (lv >= 0 && lv <= 9) {
      return { startLevel: lv, startHeight: h };
    }
  }
  return { startLevel: Math.min(9, f), startHeight: 0 };
}

/**
 * Authoritative setup on submenu-level → in-game (after Start processed).
 * FFA9 reflects the level the game actually started at; pending tracker can lag
 * when the LEVEL/HIGH panel flickers during cursor blink.
 */
function readGameSetupAtGameStart(emuRef) {
  const gameType = readCommittedGameType(emuRef);
  const ffa9 = emuRef.read_mem(0xFFA9) | 0;
  if (gameType === 'A') {
    return normalizeGameSetup({
      gameType: 'A',
      startLevel: Math.min(9, ffa9),
      startHeight: 0,
    });
  }
  const decoded = decodeBTypeStartFromFfa9(ffa9);
  return normalizeGameSetup({ gameType: 'B', ...decoded });
}

/** True when auto-nav froze the target immediately before Start this pass. */
let _menuNavFrozenForStart = false;
/** True after freezeMenuRestoreTarget ran once this pass (avoids per-frame WRAM overwrites). */
let _menuNavDidFreezeForStart = false;
/** Last valid Type/Level/High read while on level select (before Start transition garbles E1/C002). */
let _menuSetupSnapshot = null;
/** Block commits after loadRom until the menu lobby is reached (prevents SRAM garbage commits). */
let _suppressSetupCommitUntilLobby = false;

/** Remember the last good menu selection (used when commit-frame HRAM is transitional). */
function captureMenuSetupSnapshot(emuRef) {
  if (!isMenuHramValid(emuRef)) return;
  statsTracker.updateMenuState('submenu-level', emuRef);
  const gameType = readCommittedGameType(emuRef);
  _menuSetupSnapshot = normalizeGameSetup({
    gameType,
    startLevel: statsTracker._pendingLevel,
    startHeight: gameType === 'B' ? statsTracker._pendingHeight : 0,
  });
}

/** Freeze the restore target we successfully navigated to (not transitional WRAM). */
function freezeMenuRestoreTarget(target) {
  if (_menuNavDidFreezeForStart) return loadLastPlayedGameSetup();
  _menuNavDidFreezeForStart = true;
  _menuNavFrozenForStart = true;
  const setup = normalizeGameSetup({
    gameType: target.gameType === 'B' ? 'B' : 'A',
    startLevel: target.startLevel | 0,
    startHeight: target.gameType === 'B' ? (target.startHeight ?? 0) : 0,
  });
  _menuSetupSnapshot = setup;
  return freezeLastPlayedGameSetup(setup);
}

/** Commit Type/Level/High when leaving level select (before in-game). */
function commitGameSetupAtStart(emuRef) {
  if (_suppressSetupCommitFrames > 0) {
    console.warn('[menu-restore] skipped commit (ROM load warmup)');
    return;
  }
  if (_suppressSetupCommitUntilLobby) {
    console.warn('[menu-restore] skipped commit (waiting for menu lobby)');
    return;
  }

  // Auto-nav froze the target immediately before Start — trust that snapshot only.
  if (_menuNavFrozenForStart) {
    const frozen = _menuSetupSnapshot || loadLastPlayedGameSetup();
    _menuNavFrozenForStart = false;
    _menuNavDidFreezeForStart = false;
    if (frozen) {
      console.info('[menu-restore] committed at game start (auto-nav):', JSON.stringify(frozen));
      freezeLastPlayedGameSetup(frozen);
      statsTracker.applyCommittedSetup(frozen);
      return;
    }
  }

  const ffa9 = emuRef.read_mem(0xFFA9) | 0;
  const ffa9Decoded = decodeBTypeStartFromFfa9(ffa9);
  const snap = _menuSetupSnapshot;
  const gameType = snap?.gameType
    || (ffa9Decoded.startHeight > 0 ? 'B' : readCommittedGameType(emuRef));
  let setup;

  if (gameType === 'A') {
    setup = normalizeGameSetup({
      gameType: 'A',
      startLevel: snap?.gameType === 'A' ? snap.startLevel : Math.min(9, ffa9),
      startHeight: 0,
    });
  } else if (ffa9Decoded.startHeight > 0) {
    // B-type: FFA9 = level+height at game start (e.g. 14 → L9 H5).
    setup = normalizeGameSetup({ gameType: 'B', ...ffa9Decoded });
  } else if (snap?.gameType === 'B') {
    setup = snap;
  } else if (isMenuHramValid(emuRef)) {
    statsTracker.updateMenuState('submenu-level', emuRef);
    setup = readGameSetupFromPendingTracker(emuRef);
  } else {
    console.warn(
      '[menu-restore] skipped commit (no snapshot, invalid HRAM)',
      `E1=0x${emuRef.read_mem(MENU_HRAM_PHASE).toString(16)}`,
      `C002=${emuRef.read_mem(0xC002)}`,
      `FFA9=${ffa9}`,
      `snap=${snap ? JSON.stringify(snap) : 'null'}`
    );
    return;
  }

  console.info('[menu-restore] committed at game start (manual):', JSON.stringify(setup));
  freezeLastPlayedGameSetup(setup);
  statsTracker.applyCommittedSetup(setup);
}

/** B-type HIGH panel: high H maps to c002 H+5 (H≤4) or 9 (H=5) — legacy grid sim only. */
function menuHighC002(high) {
  return high >= 5 ? 9 : high + 5;
}

/**
 * Tetris GB menu HRAM (from ROM — osnr/tetris l15bf/l16eb/l1766):
 *   0xFFE1 — phase state: 0x11/0x13 = LEVEL panel, 0x14/0x15 = HIGH panel
 *   0xFFC2 — Type-A level cursor (0–9)
 *   0xFFC3 — Type-B LEVEL cursor (0–9)
 *   0xFFC4 — Type-B HIGH cursor (0–5)
 * C000 0x40/0x50 are blink *display* bytes (C200/C210 bit7 toggle), not panel focus.
 */
const MENU_HRAM_PHASE = 0xFFE1;
const MENU_HRAM_LVL_A = 0xFFC2;
const MENU_HRAM_LVL_B = 0xFFC3;
const MENU_HRAM_HIGH_B = 0xFFC4;
/** Type-B lines-remaining countdown (BCD tens+units, 0–99) — confirmed live vs VRAM. */
const MENU_HRAM_LINES_BCD = 0xFF9E;

let _menuPanelStable = 'level';
let _menuPanelCandidate = 'level';
let _menuPanelStreak = 0;
/** After A on LEVEL panel, wait until E1 confirms HIGH before HIGH d-pad. */
let _menuAwaitHighPanel = false;

const MENU_PANEL_LEVEL_STABLE_FRAMES = 2;
const MENU_PANEL_HIGH_STABLE_FRAMES = 4;

function resetMenuPanelTracking() {
  _menuPanelStable = 'level';
  _menuPanelCandidate = 'level';
  _menuPanelStreak = 0;
  _menuAwaitHighPanel = false;
}

function menuPhaseIsHigh(e1) {
  return e1 === 0x14 || e1 === 0x15;
}

function menuPhaseIsLevel(e1) {
  return e1 === 0x11 || e1 === 0x13;
}

function readMenuPanelRaw(emuRef) {
  const e1 = emuRef.read_mem(MENU_HRAM_PHASE);
  if (menuPhaseIsHigh(e1)) return 'high';
  if (menuPhaseIsLevel(e1)) return 'level';
  if (_menuAwaitHighPanel) return 'high';
  return _menuPanelStable;
}

/** Debounced LEVEL/HIGH panel from E1 — ignores C000 blink flicker. */
function readMenuPanelStable(emuRef) {
  const raw = readMenuPanelRaw(emuRef);
  const need = raw === 'high' ? MENU_PANEL_HIGH_STABLE_FRAMES : MENU_PANEL_LEVEL_STABLE_FRAMES;
  if (raw === _menuPanelCandidate) {
    _menuPanelStreak++;
  } else {
    _menuPanelCandidate = raw;
    _menuPanelStreak = 1;
  }
  if (_menuPanelStreak >= need) {
    _menuPanelStable = raw;
    if (raw === 'high') _menuAwaitHighPanel = false;
  }
  return _menuPanelStable;
}

function menuOnLevelRow(emuRef) {
  return readMenuPanelStable(emuRef) === 'level';
}

function menuInHighPanel(emuRef) {
  return readMenuPanelStable(emuRef) === 'high';
}

/** Live LEVEL digit — C002 updates on every d-pad step in this emu; FFC3 can lag. */
function readMenuLevelCursor(emuRef) {
  const c002 = emuRef.read_mem(0xC002);
  if (c002 <= 9) return c002;
  const gameType = statsTracker._pendingGameType
    || ((emuRef.read_mem(0xFF86) & 0x80) ? 'A' : 'B');
  const addr = gameType === 'B' ? MENU_HRAM_LVL_B : MENU_HRAM_LVL_A;
  return Math.max(0, Math.min(9, emuRef.read_mem(addr) | 0));
}

/** B-type level while HIGH panel is focused (FFC3 holds LEVEL digit). */
function readMenuLevelOnHighPanel(emuRef) {
  const ffc3 = emuRef.read_mem(MENU_HRAM_LVL_B);
  if (ffc3 <= 9) return ffc3;
  if (_menuNavConfirmedLevel != null) return _menuNavConfirmedLevel;
  const c002 = emuRef.read_mem(0xC002);
  if (c002 >= 9) return 9;
  return statsTracker._pendingLevel ?? 0;
}

function readMenuHighCursor(emuRef) {
  const ffc4 = emuRef.read_mem(MENU_HRAM_HIGH_B);
  if (ffc4 <= 5) return ffc4;
  const c002 = emuRef.read_mem(0xC002);
  if (c002 >= 9) return 5;
  if (c002 <= 2) return c002;
  return Math.max(0, Math.min(5, c002 - 3));
}

function decodeMenuHigh(emuRef) {
  return readMenuHighCursor(emuRef);
}

/** Level last confirmed on the LEVEL panel during this restore pass. */
let _menuNavConfirmedLevel = null;

function menuRestoreGameType(emuRef, target) {
  if (target?.gameType === 'B') return 'B';
  if (target?.gameType === 'A') return 'A';
  if (_menuRestoreTarget?.gameType === 'B') return 'B';
  if (_menuRestoreTarget?.gameType === 'A') return 'A';
  if (statsTracker._pendingGameType === 'B') return 'B';
  if (statsTracker._pendingGameType === 'A') return 'A';
  return (emuRef.read_mem(0xFF86) & 0x80) ? 'A' : 'B';
}

/** Live cursor — panel from E1; level from C002; high from FFC4 on HIGH panel. */
function readMenuCursorLive(emuRef) {
  const gameType = menuRestoreGameType(emuRef);
  const panel = readMenuPanelStable(emuRef);
  const onHigh = gameType === 'B' && panel === 'high';
  const onLevel = gameType === 'A' || panel === 'level';
  const level = onHigh ? readMenuLevelOnHighPanel(emuRef) : readMenuLevelCursor(emuRef);
  const high = onHigh ? readMenuHighCursor(emuRef) : 0;
  const c000 = emuRef.read_mem(0xC000);
  const c002 = emuRef.read_mem(0xC002);
  const e1 = emuRef.read_mem(MENU_HRAM_PHASE);
  const ffc3 = emuRef.read_mem(MENU_HRAM_LVL_B);
  const ffc4 = emuRef.read_mem(MENU_HRAM_HIGH_B);
  return { level, high, onLevel, onHigh, panel, c000, c002, e1, ffc3, ffc4 };
}

const MENU_BTN_A = 0;
const MENU_BTN_B = 1;

/**
 * B-type level grid (cursor starts top-left = 0):
 *   row0: 0  1  2  3  4
 *   row1: 5  6  7  8  9
 */
function menuLevelGridPos(level) {
  const n = Math.max(0, Math.min(9, level | 0));
  return { row: n >= 5 ? 1 : 0, col: n >= 5 ? n - 5 : n };
}

function menuHighGridPos(high) {
  const n = Math.max(0, Math.min(5, high | 0));
  return { row: n >= 3 ? 1 : 0, col: n >= 3 ? n - 3 : n };
}

/** One D-pad step toward target on the 2-row grid (horizontal moves before vertical). */
function menuGridStepToward(cur, tgt, isHigh) {
  const posFn = isHigh ? menuHighGridPos : menuLevelGridPos;
  const curP = posFn(cur);
  const tgtP = posFn(tgt);
  if (curP.col < tgtP.col) return 7;
  if (curP.col > tgtP.col) return 6;
  if (curP.row < tgtP.row) return 5;
  if (curP.row > tgtP.row) return 4;
  return null;
}

/** D-pad steps on the Type-A row from current level to target (SRAM may not start at 0). */
function menuLevelDpadStepsLinearFrom(current, target) {
  const steps = [];
  let cur = Math.max(0, Math.min(9, current | 0));
  const tgt = Math.max(0, Math.min(9, target | 0));
  while (cur < tgt) { steps.push(7); cur++; }
  while (cur > tgt) { steps.push(6); cur--; }
  return steps;
}

/** D-pad steps on the Type-B LEVEL grid from current level to target. */
function menuLevelDpadStepsGridFrom(current, target) {
  const steps = [];
  let cur = Math.max(0, Math.min(9, current | 0));
  const tgt = Math.max(0, Math.min(9, target | 0));
  while (cur !== tgt) {
    const btn = menuGridStepToward(cur, tgt, false);
    if (btn == null) break;
    steps.push(btn);
    cur = simulateGridStep(cur, tgt, false, btn);
  }
  return steps;
}

function menuLevelDpadStepsFrom(current, target, gameType = 'B') {
  return gameType === 'A'
    ? menuLevelDpadStepsLinearFrom(current, target)
    : menuLevelDpadStepsGridFrom(current, target);
}

function menuHighDpadStepsFrom(current, high) {
  const steps = [];
  let cur = Math.max(0, Math.min(5, current | 0));
  const tgt = Math.max(0, Math.min(5, high | 0));
  while (cur !== tgt) {
    const btn = menuGridStepToward(cur, tgt, true);
    if (btn == null) break;
    steps.push(btn);
    cur = simulateGridStep(cur, tgt, true, btn);
  }
  return steps;
}

function simulateGridStep(cur, _tgt, isHigh, btn) {
  const posFn = isHigh ? menuHighGridPos : menuLevelGridPos;
  const gridFn = isHigh ? menuHighGridPos : menuLevelGridPos;
  const p = posFn(cur);
  let { row, col } = p;
  if (btn === 7) col++;
  else if (btn === 6) col--;
  else if (btn === 5) row++;
  else if (btn === 4) row--;
  const maxCol = isHigh ? 2 : 4;
  if (col < 0) col = 0;
  if (col > maxCol) col = maxCol;
  if (row < 0) row = 0;
  if (row > 1) row = 1;
  const val = isHigh
    ? (row === 0 ? col : col + 3)
    : (row === 0 ? col : col + 5);
  return Math.max(0, Math.min(isHigh ? 5 : 9, val));
}

function formatMenuNavSequence(seq) {
  return seq.map((b) => {
    if (b === 7) return 'R';
    if (b === 6) return 'L';
    if (b === 5) return 'D';
    if (b === 4) return 'U';
    if (b === MENU_BTN_A) return 'A';
    if (b === MENU_BTN_B) return 'B';
    return '?';
  }).join('');
}

function buildMenuRestoreSequence(target, startLevel = 0, startHigh = 0) {
  const gameType = target.gameType === 'B' ? 'B' : 'A';
  const seq = [...menuLevelDpadStepsFrom(startLevel, target.startLevel | 0, gameType)];
  if (gameType === 'B' && (target.startHeight ?? 0) > 0) {
    seq.push(MENU_BTN_A);
    seq.push(...menuHighDpadStepsFrom(startHigh, target.startHeight | 0));
  }
  return seq;
}

const MENU_BTN_LABEL = { 0: 'A', 1: 'B', 3: 'Start', 4: 'Up', 5: 'Down', 6: 'Left', 7: 'Right' };

/** @type {{ btn: number, btnName: string, before: object } | null} */
let _menuNavPendingOutcome = null;
let _menuNavLastSnapKey = '';

/** Nav cursor — raw E1/FFC4 on B HIGH phase (debounced panel flickers LEVEL↔HIGH). */
function readMenuNavCursor(emuRef, target) {
  const live = readMenuCursorLive(emuRef);
  const e1 = live.e1;
  const ffc3 = live.ffc3;
  const ffc4 = live.ffc4;
  const gameType = menuRestoreGameType(emuRef, target);

  if (gameType === 'B' && (_menuNavPastA || _menuAwaitHighPanel)) {
    if (menuPhaseIsHigh(e1)) {
      return {
        row: 'HIGH',
        level: ffc3 <= 9 ? ffc3 : readMenuLevelOnHighPanel(emuRef),
        height: ffc4 <= 5 ? ffc4 : readMenuHighCursor(emuRef),
        onHigh: true,
        onLevel: false,
        e1,
        ffc3,
        ffc4,
        c000: live.c000,
        c002: live.c002,
      };
    }
    if (menuPhaseIsLevel(e1)) {
      return {
        row: 'LEVEL',
        level: readMenuLevelCursor(emuRef),
        height: 0,
        onHigh: false,
        onLevel: true,
        e1,
        ffc3,
        ffc4,
        c000: live.c000,
        c002: live.c002,
      };
    }
  }

  return {
    row: live.onHigh ? 'HIGH' : live.onLevel ? 'LEVEL' : '?',
    level: live.level,
    height: live.high,
    onHigh: live.onHigh,
    onLevel: live.onLevel,
    e1,
    ffc3,
    ffc4,
    c000: live.c000,
    c002: live.c002,
  };
}

function readMenuNavSnapshot(emuRef, target) {
  if (!emuRef) return null;
  statsTracker.updateMenuState('submenu-level', emuRef);
  const cur = readMenuNavCursor(emuRef, target);
  const tgt = target || captureMenuRestoreTarget();
  return {
    row: cur.row,
    level: cur.level,
    height: cur.height,
    c000: cur.c000,
    c002: cur.c002,
    e1: cur.e1,
    ffc3: cur.ffc3,
    ffc4: cur.ffc4,
    c000Hex: '0x' + cur.c000.toString(16).toUpperCase().padStart(2, '0'),
    e1Hex: '0x' + cur.e1.toString(16).toUpperCase().padStart(2, '0'),
    target: tgt,
    seqTotal: _menuNavSequence.length,
  };
}

function formatMenuNavSnapshot(snap) {
  if (!snap) return '—';
  let s = `${snap.row} row · level ${snap.level}`;
  if (snap.target?.gameType === 'B') s += ` · high ${snap.height}`;
  s += ` · E1=${snap.e1Hex} FFC3=${snap.ffc3} FFC4=${snap.ffc4}`;
  s += ` · C000=${snap.c000Hex} C002=${snap.c002}`;
  if (autoMenuNav && snap.seqTotal > 0) {
    s += ` · ref ${formatMenuNavSequence(_menuNavSequence)}<Start>`;
  }
  return s;
}

function menuNavLogSelected(snap, note = 'selected') {
  if (!snap) return;
  const key = `${snap.row}|${snap.level}|${snap.height}|${snap.c002}|${snap.c000}`;
  if (key === _menuNavLastSnapKey) return;
  _menuNavLastSnapKey = key;
  console.log(`[menu-nav] ${note}: ${formatMenuNavSnapshot(snap)}`);
}

function menuNavLogPress(btn, why, snap) {
  const btnName = MENU_BTN_LABEL[btn] || `btn${btn}`;
  const tgt = snap.target;
  let extra = '';
  if (btn === MENU_BTN_A || btn === MENU_BTN_B) {
    extra = ` · panel ${snap.row}`;
  }
  console.log(`[menu-nav] pressing ${btnName}${extra} — ${why}`);
  console.log(`[menu-nav]   before: ${formatMenuNavSnapshot(snap)}`);
  _menuNavPendingOutcome = { btn, btnName, before: snap };
}

function menuNavStepSucceeded(btn, before, after) {
  if (btn === 3) return true;
  if (btn === MENU_BTN_A) {
    return (menuPhaseIsLevel(before.e1) && menuPhaseIsHigh(after.e1))
      || (before.row === 'LEVEL' && after.row === 'HIGH');
  }
  // Type-A: single row — any level change counts.
  if (before.target?.gameType === 'A') {
    return after.level !== before.level;
  }
  // B-type HIGH phase — FFC4 is authoritative; E1 panel flicker must not block steps.
  if (_menuNavPastA && (menuPhaseIsHigh(before.e1) || menuPhaseIsHigh(after.e1))) {
    return after.ffc4 !== before.ffc4;
  }
  if (before.row === 'LEVEL' && after.row === 'LEVEL') {
    return after.level !== before.level;
  }
  if (before.row === 'HIGH' && after.row === 'HIGH') {
    return after.height !== before.height;
  }
  return false;
}

function menuNavAdvanceAfterOutcome(btn, before, after) {
  if (!menuNavStepSucceeded(btn, before, after)) {
    const btnName = MENU_BTN_LABEL[btn] || `btn${btn}`;
    console.log(
      `[menu-nav] retry seq[${_menuNavStepIdx}] ${btnName} — no cursor change ` +
      `(level ${before.level} high ${before.height} → level ${after.level} high ${after.height})`
    );
    return;
  }
  if (btn === MENU_BTN_A) {
    _menuNavPastA = true;
    _menuAwaitHighPanel = true;
    _menuNavPhase = 'high';
    if (before.row === 'LEVEL') {
      _menuNavConfirmedLevel = after.level;
    }
  } else if (before.row === 'LEVEL' && after.row === 'LEVEL') {
    _menuNavConfirmedLevel = after.level;
  }
  _menuNavStepIdx++;
  _menuNavStepCooldown = MENU_NAV_STEP_COOLDOWN_FRAMES;
}

function menuNavLogPressOutcome(emuRef) {
  if (!_menuNavPendingOutcome || !emuRef) return;
  const { btn, btnName, before } = _menuNavPendingOutcome;
  const after = readMenuNavSnapshot(emuRef, before.target);
  console.log(`[menu-nav] released ${btnName}`);
  console.log(`[menu-nav]   after:  ${formatMenuNavSnapshot(after)}`);
  if (after.level !== before.level) {
    console.log(`[menu-nav]   → level ${before.level} → ${after.level}`);
  }
  if (after.height !== before.height) {
    console.log(`[menu-nav]   → high ${before.height} → ${after.height}`);
  }
  if (after.row !== before.row) {
    console.log(`[menu-nav]   → row ${before.row} → ${after.row}`);
  }
  if (_menuNavAwaitingOutcome) {
    menuNavAdvanceAfterOutcome(btn, before, after);
    _menuNavAwaitingOutcome = false;
  }
  _menuNavPendingOutcome = null;
  _menuNavLastSnapKey = '';
  menuNavLogSelected(after, 'now');
}

function autoMenuNavTapBtn(btn, why, target) {
  if (autoMenuNav) {
    menuNavLogPress(btn, why, readMenuNavSnapshot(emu, target));
  }
  autoMenuTapBtn(btn);
}

function autoMenuNavTapStart(why, target, mirrorB = false) {
  if (autoMenuNav) {
    menuNavLogPress(3, why, readMenuNavSnapshot(emu, target));
  }
  autoMenuTapStart(mirrorB);
}

function formatLevelSelectBadge(_emuRef, _target) {
  return 'Level Select';
}

/** Reference sequence for debug badge; also executed step-by-step by auto-nav. */
let _menuNavSequence = [];
/** Index of next button in _menuNavSequence to press. */
let _menuNavStepIdx = 0;
/** True after the A step in the sequence (HIGH panel d-pad follows). */
let _menuNavPastA = false;
/** True once c002 matched target level on the LEVEL panel (guards c002=9 / stale skips). */
let _menuLevelConfirmed = false;
/** Frames to wait after gametype Start before level-nav (Start can bleed as A on entry). */
let _menuLevelEntryFrames = 0;
/** 'level' = set LEVEL digit; 'high' = set HIGH digit after A. */
let _menuNavPhase = 'level';
/** Consecutive frames on LEVEL panel before nav starts (ignores phantom A flicker). */
let _menuStableLevelFrames = 0;
const MENU_STABLE_LEVEL_FRAMES = 6;
/** True while auto-nav is mid-restore — blocks spurious re-entry from replanning. */
let _menuNavActive = false;
/** True from d-pad/A press until release outcome is processed. */
let _menuNavAwaitingOutcome = false;
/** Frames to wait after a confirmed step before the next press. */
let _menuNavStepCooldown = 0;
const MENU_NAV_STEP_COOLDOWN_FRAMES = 6; // ~100ms at 59.73fps

function planMenuRestoreSequence(target) {
  let startLevel = 0;
  let startHigh = 0;
  if (emu && isMenuHramValid(emu)) {
    const live = readMenuCursorLive(emu);
    startLevel = live.level | 0;
    startHigh = live.high | 0;
  }
  _menuNavSequence = buildMenuRestoreSequence(target, startLevel, startHigh);
  const label = formatMenuNavSequence(_menuNavSequence);
  const gt = target.gameType === 'B' ? 'B' : 'A';
  console.log(
    `[menu-nav] planned ${gt} Lv${target.startLevel}` +
    (gt === 'B' && (target.startHeight ?? 0) > 0 ? ` H${target.startHeight}` : '') +
    ` from Lv${startLevel}` +
    (gt === 'B' && startHigh > 0 ? ` H${startHigh}` : '') +
    `: ${label}<Start> (${_menuNavSequence.length} steps)`
  );
}

function menuSelectionMatchesTarget(emuRef, target) {
  statsTracker.updateMenuState('submenu-level', emuRef);
  const tgtLevel = target.startLevel | 0;
  const tgtHigh = target.gameType === 'B' ? (target.startHeight ?? 0) : 0;

  if (target.gameType === 'A') {
    const live = readMenuCursorLive(emuRef);
    return live.level === tgtLevel;
  }
  if (tgtHigh === 0) {
    const live = readMenuCursorLive(emuRef);
    return live.onLevel && live.level === tgtLevel;
  }
  const e1 = emuRef.read_mem(MENU_HRAM_PHASE);
  const ffc3 = emuRef.read_mem(MENU_HRAM_LVL_B);
  const ffc4 = emuRef.read_mem(MENU_HRAM_HIGH_B);
  return menuPhaseIsHigh(e1) && ffc3 === tgtLevel && ffc4 === tgtHigh;
}

function menuPanelFromE1(emuRef) {
  const e1 = emuRef.read_mem(MENU_HRAM_PHASE);
  if (menuPhaseIsHigh(e1)) return 'high';
  if (menuPhaseIsLevel(e1)) return 'level';
  return null;
}

/**
 * Sequence-driven restore: press _menuNavSequence[_menuNavStepIdx] each cycle.
 * WRAM cursor bytes are unreliable; only E1 gates LEVEL vs HIGH around A.
 * Never B (exits to game-type). Inputs are queued before run_frame (see loop).
 */
function autoMenuLevelRestoreStep(target) {
  if (!autoMenuCanPress()) return;
  if (_menuNavAwaitingOutcome) return;
  if (!isMenuHramValid(emu)) return;

  if (_menuLevelEntryFrames > 0) {
    _menuLevelEntryFrames--;
    return;
  }

  if (_levelJitterFrames > 0) {
    _levelJitterFrames--;
    return;
  }

  if (_menuNavStepCooldown > 0) {
    _menuNavStepCooldown--;
    return;
  }

  if (_menuNavSequence.length === 0) {
    planMenuRestoreSequence(target);
  }

  const panel = menuPanelFromE1(emu);
  const onHigh = panel === 'high';
  const onLevel = panel === 'level' || (!_menuNavPastA && !onHigh);

  if (_menuNavStepIdx >= _menuNavSequence.length) {
    if (!menuSelectionMatchesTarget(emu, target)) {
      const live = readMenuCursorLive(emu);
      console.warn(
        `[menu-nav] sequence done but cursor Lv${live.level} H${live.high} ` +
        `≠ target Lv${target.startLevel}` +
        (target.gameType === 'B' ? ` H${target.startHeight ?? 0}` : '') +
        ' — waiting'
      );
      return;
    }
    freezeMenuRestoreTarget(target);
    autoMenuNavTapStart('begin game', target);
    return;
  }

  const btn = _menuNavSequence[_menuNavStepIdx];

  if (!_menuNavPastA) {
    if (!onLevel) {
      _menuStableLevelFrames = 0;
      return;
    }
    _menuStableLevelFrames++;
    if (_menuStableLevelFrames < MENU_STABLE_LEVEL_FRAMES) return;

    autoMenuNavTapBtn(
      btn,
      `seq[${_menuNavStepIdx}] ${formatMenuNavSequence([btn])}`,
      target
    );
    _menuNavAwaitingOutcome = true;
    return;
  }

  _menuStableLevelFrames = 0;
  if (_menuAwaitHighPanel) {
    if (!onHigh) return;
    _menuAwaitHighPanel = false;
  } else if (!onHigh) {
    return;
  }

  autoMenuNavTapBtn(btn, `seq[${_menuNavStepIdx}] ${formatMenuNavSequence([btn])}`, target);
  _menuNavAwaitingOutcome = true;
}

const clearSramCheck = document.getElementById("clear-sram-check");
clearSramCheck.addEventListener("change", () => {
  if (clearSramCheck.checked) {
    console.log('[sram] "Clear SRAM on next load" enabled — will wipe DB entry on next ROM load');
  }
});

// ── Save state before page unload / reload ──────────────────────────────────
window.addEventListener("beforeunload", () => {
  // No active ROM → nothing to persist (avoids resurrecting a deleted cart).
  if (!emu || !_activeRomName || !_lastRomBytes) return;
  saveState();
  if (restoreCheck.checked) sessionStorage.setItem("gbmul_reload_restore", "1");
  // Synchronously persist SRAM on unload (best-effort; IndexedDB is async but
  // the browser usually completes it before the page dies)
  if (!dualMode && typeof emu.get_sram === 'function') {
    const sram = emu.get_sram();
    if (sram.some(b => b !== 0)) saveSramToDb(_activeRomName, sram).catch(() => {});
  }
});

// ── ROM startup: try IndexedDB cache first, else show import overlay ──────────
(async () => {
  try {
    const cached = await loadLastRomFromDb();
    if (cached && cached.data) {
      _activeRomName = cached.name;
      setStatus(`Loading ${cached.name}…`);
      await loadRom(cached.data);
      hideRomOverlay();
      if (sessionStorage.getItem('gbmul_reload_restore')) {
        sessionStorage.removeItem('gbmul_reload_restore');
        loadState();
      }
    } else {
      // Empty cache: clear any stale savestate and show cart splash.
      try { localStorage.removeItem("gbmul_state"); } catch (_) { /* ignore */ }
      try { sessionStorage.removeItem("gbmul_reload_restore"); } catch (_) { /* ignore */ }
      _lastRomBytes = null;
      _activeRomName = null;
      showRomOverlay();
    }
  } catch (e) {
    console.warn('[rom] IndexedDB error:', e);
    showRomOverlay();
  }
})();

// ── ROM loading ──────────────────────────────────────────────────────────────
async function loadRom(bytes) {
  // Must null animId after cancel — startLoop() treats a non-null id as
  // "already running" and would skip restarting (freeze on 1P↔2P switch).
  if (animId) { cancelAnimationFrame(animId); animId = null; }
  clearPause();
  _lastRomBytes = bytes;
  emuPair = null;
  emuB    = null;
  _dbgFrameCount = 0; _dbgLastStateA = null; _dbgLastStateB = null;
  _lastTitleCursor2P = null;
  _autoRightFrames   = 0;
  _autoBtnFrames     = 0;
  _autoBtnCode       = -1;
  _autoStartFrames   = 0;
  _splashAutoPressed = false;
  _splashJitterFrames = Math.floor(Math.random() * 10); // 0-9 frames jitter for entropy in piece RNG
  _titleJitterFrames = Math.floor(Math.random() * 10);
  _gametypeJitterFrames = Math.floor(Math.random() * 10);
  _menuGametypeEntryFrames = 0;
  _levelJitterFrames = Math.floor(Math.random() * 10);
  _dbgLastScA = -1; _dbgLastScB = -1;
  window._suppressNextMisdropCapture = false;
  _lastGameState = null;
  _pendingState = null;
  _pendingStateCount = 0;
  _suppressSetupCommitFrames = 120;
  _suppressSetupCommitUntilLobby = true;
  _menuSetupSnapshot = null;
  resetMenuRestoreProgress();
  if (autoMenuNav) {
    _menuRestoreTarget = captureMenuRestoreTarget();
    _gametypeSeqIdx = 0;
    console.log('[menu-restore] loadRom target:', JSON.stringify(_menuRestoreTarget));
    statsTracker._pendingLevel = 0;
    statsTracker._pendingHeight = 0;
    _menuLevelConfirmed = false;
    _menuLevelEntryFrames = 0;
    _menuNavPhase = 'level';
    _menuStableLevelFrames = 0;
    _menuNavActive = false;
    _menuNavConfirmedLevel = null;
    _menuNavStepIdx = 0;
    _menuNavPastA = false;
    _menuNavAwaitingOutcome = false;
    _menuNavStepCooldown = 0;
    resetMenuPanelTracking();
  }

  console.log(`[loadRom] mode=${dualMode ? 'dual (GbEmuPair)' : 'single (GbEmu)'} bytes=${bytes.length}`);

  // Load saved SRAM before load_rom so it's present during warmup frames.
  // Memory::load_rom does NOT reset eram, so pre-loading SRAM here works.
  let preloadedSram = null;
  if (!dualMode && _activeRomName) {
    // Clear SRAM from DB if the user ticked "Clear SRAM on next load"
    if (clearSramCheck.checked) {
      await deleteSramFromDb(_activeRomName);
      clearSramCheck.checked = false;
      console.log(`[sram] cleared DB entry for "${_activeRomName}" (user requested)`);
    }
    try {
      preloadedSram = await loadSramFromDb(_activeRomName);
      if (preloadedSram) {
        const allFF = preloadedSram.every(b => b === 0xFF);
        const allZero = preloadedSram.every(b => b === 0);
        const nonTrivial = preloadedSram.filter(b => b !== 0xFF && b !== 0).length;
        const first8 = Array.from(preloadedSram.slice(0, 8)).map(b => b.toString(16).padStart(2,'0')).join(' ');
        console.log(`[sram] DB entry found: ${preloadedSram.length}B allFF=${allFF} allZero=${allZero} nonTrivial=${nonTrivial} first8=[${first8}]`);
      } else {
        console.log(`[sram] no DB entry for "${_activeRomName}" — starting with fresh 0xFF SRAM`);
      }
    } catch (e) {
      console.warn('[sram] failed to load:', e);
    }
  }

  try {
    if (dualMode) {
      emuPair = new GbEmuPair();
      emuPair.load_rom(bytes);
      emu  = new GbEmuPairSideA(emuPair);
      emuB = {
        read_mem:       (addr) => emuPair.read_mem_b(addr),
        read_mem_range: (s, l) => emuPair.read_mem_range_b(s, l),
        key_down:       (btn)  => emuPair.key_down_b(btn),
        key_up:         (btn)  => emuPair.key_up_b(btn),
      };
      window._gbEmuPair = emuPair;
    } else {
      emu = new GbEmu();
      if (preloadedSram && typeof emu.set_sram === 'function') {
        emu.set_sram(preloadedSram);
        console.log(`[sram] set_sram() done`);
      }
      emu.load_rom(bytes);
      if (typeof emu.sram_status === 'function') {
        console.log(`[sram] after load_rom: ${emu.sram_status()}`);
      }

      // LSDJ debug: log title and initial state
      {
        const tb = emu.read_mem_range(0x134, 4);
        const title = String.fromCharCode(tb[0], tb[1], tb[2], tb[3]);
        if (title === 'LSDj') {
          console.log(`[lsdj] ROM detected, initial: ${emu.sram_status()}`);
        }
      }

      window._gbEmu = emu;
    }
  } catch (e) {
    setStatus("Error loading ROM: " + e, true);
    return;
  }

  // Fresh ROM load (including post-misdrop auto-reset): reset the bot so it
  // doesn't carry stale planning state (last_ori, targets, last_placement, etc.)
  // from the previous game. This prevents bogus immediate misdrops on the new game.
  if (rustBot) rustBotReset();
  clearMisdropSpawnCaptures();
  window._prevPieceMinY = 255;

  emu.set_palette(paletteIndex);
  startSramAutosave();

  applyRomConfig(bot);
  if (rustBot && typeof rustBot.setSoftDropMode === 'function') {
    rustBot.setSoftDropMode(_activeRomName === 'Tetris.gb');
  }
  initAudio();
  installGbmulDebugBridge();
  const restoredProbe = stateProbeRestore();
  if (stateProbeAutoEnabled() && !_stateProbeActive) {
    startStateProbe({ sampleEvery: 8 });
  } else if (restoredProbe > 0) {
    console.info(`[state-probe] restored ${restoredProbe} entries from session`);
  }
  setStatus("Running…");
  startLoop();
}

// ── ROM import: drag-and-drop ─────────────────────────────────────────────────
let _dragOverTimer = null;
function setRomSplashDragOver(on) {
  romDropzone.classList.toggle('drag-over', on);
  if (on && romSplashOpen) romCartOpenLid(); // drag-over opens the lid
  if (romSplashDragOver === on) return;
  romSplashDragOver = on;
  if (romSplashOpen) romSplashRedraw();
}
document.addEventListener('dragover', e => {
  e.preventDefault();
  setRomSplashDragOver(true);
  clearTimeout(_dragOverTimer);
  _dragOverTimer = setTimeout(() => setRomSplashDragOver(false), 150);
});
document.addEventListener('dragleave', e => {
  if (e.relatedTarget === null) setRomSplashDragOver(false);
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  setRomSplashDragOver(false);
  romCartOpenLid(); // ensure open state if a file is dropped
  const file = e.dataTransfer.files[0];
  if (!file) return;

  // .sav file: import as SRAM for the currently-running ROM
  if (file.name.toLowerCase().endsWith('.sav')) {
    if (!_activeRomName) {
      setStatus('Load a ROM first before importing a .sav file.', true);
      return;
    }
    const savBytes = new Uint8Array(await file.arrayBuffer());
    await saveSramToDb(_activeRomName, savBytes);
    console.log(`[sram] imported ${savBytes.length} bytes from ${file.name} for ${_activeRomName}`);
    setStatus(`Save imported (${savBytes.length} bytes). Reloading…`);
    // Reload ROM with new SRAM
    const romEntry = await loadRomByNameFromDb(_activeRomName);
    const romBytes = romEntry ? new Uint8Array(romEntry.data) : null;
    if (romBytes) await loadRom(romBytes);
    return;
  }

  _activeRomName = file.name;
  setStatus('Loading ' + file.name + '…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  hideRomOverlay();
  await loadRom(bytes);
  saveRomToDb(file.name, bytes).catch(err => console.warn('[rom] IDB save failed:', err));
  renderRomManager();
});

// ── ROM import: file picker ───────────────────────────────────────────────────
const romFileInput = document.getElementById('rom-file-input');
const btnBrowseRom = document.getElementById('btn-browse-rom');

/**
 * Click / keyboard activate on the splash hit-target:
 *  1st interaction → open the cart lid (visual)
 *  2nd (lid already open) → native file picker
 */
function romSplashActivatePick() {
  if (!romSplashAllowsPick()) return;
  // Menu owns the screen while open — never open the file picker from under it.
  if (typeof idm !== "undefined" && idm.open) return;
  if (!romCartLidOpen) {
    romCartOpenLid();
    return;
  }
  romFileInput.click();
}

btnBrowseRom.addEventListener('click', (e) => {
  e.preventDefault();
  if (typeof idm !== "undefined" && idm.open) return;
  romSplashActivatePick();
});
// Whole dropzone is also a hit target (role=button).
romDropzone.addEventListener('click', (e) => {
  // Avoid double-fire when the transparent button is the click target.
  if (e.target === btnBrowseRom || btnBrowseRom.contains(e.target)) return;
  if (e.target === romFileInput) return;
  if (typeof idm !== "undefined" && idm.open) return;
  romSplashActivatePick();
});
romDropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (typeof idm !== "undefined" && idm.open) return;
    romSplashActivatePick();
  }
});

romFileInput.addEventListener('change', async () => {
  const file = romFileInput.files[0];
  if (!file) return;
  romFileInput.value = '';
  _activeRomName = file.name;
  setStatus('Loading ' + file.name + '…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  hideRomOverlay();
  await loadRom(bytes);
  saveRomToDb(file.name, bytes).catch(err => console.warn('[rom] IDB save failed:', err));
  renderRomManager();
});

// ── ROM manager panel ─────────────────────────────────────────────────────────
const romManagerDetails = document.getElementById('rom-manager');
const romList           = document.getElementById('rom-list');
const btnAddRom         = document.getElementById('btn-add-rom');

btnAddRom.addEventListener('click', () => romFileInput.click());

romManagerDetails.addEventListener('toggle', () => {
  if (romManagerDetails.open) renderRomManager();
});

async function renderRomManager() {
  const roms = await listAllRomsFromDb().catch(() => []);
  romList.innerHTML = '';
  if (roms.length === 0) {
    const li = document.createElement('li');
    li.className = 'rom-item-empty';
    li.textContent = 'No ROMs cached';
    romList.appendChild(li);
    return;
  }
  for (const rom of roms) {
    const li = document.createElement('li');
    li.className = 'rom-item' + (rom.name === _activeRomName ? ' rom-item-active' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'rom-name';
    nameSpan.textContent = rom.name;
    nameSpan.title = rom.name;

    const loadBtn = document.createElement('button');
    loadBtn.className = 'rom-load-btn';
    loadBtn.textContent = 'Load';
    loadBtn.disabled = rom.name === _activeRomName;
    loadBtn.addEventListener('click', async () => {
      const entry = await loadRomByNameFromDb(rom.name);
      if (!entry) { setStatus('ROM not found in cache', true); return; }
      _activeRomName = entry.name;
      setStatus(`Loading ${entry.name}…`);
      hideRomOverlay();
      await loadRom(entry.data);
      await saveRomToDb(entry.name, entry.data); // refresh lastUsed
      renderRomManager();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'rom-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Remove from cache';
    delBtn.addEventListener('click', async () => {
      const name = rom.name;
      const wasActive = _activeRomName === name;
      await deleteRomFromDb(name);
      // Battery save for this cart is useless without the ROM bytes.
      await deleteSramFromDb(name).catch(() => {});
      const remaining = await listAllRomsFromDb().catch(() => []);
      if (wasActive || remaining.length === 0) {
        // Stop the running game and return to the cart splash so a reload
        // cannot resurrect the deleted ROM from RAM / savestate.
        unloadRomToPicker(
          remaining.length === 0
            ? "ROM cache empty — open cart to load one."
            : `Removed ${name}.`
        );
      }
      renderRomManager();
    });

    li.appendChild(nameSpan);
    li.appendChild(loadBtn);
    li.appendChild(delBtn);
    romList.appendChild(li);
  }
}

// ── Game stats tracker ───────────────────────────────────────────────────────
//
// Records per-game stats to localStorage (key: gbmul_game_stats).
// Each record stores: id, dateStart, dateStop, durationSec, players,
// gameType (A/B), startLevel, startHeight (B-type), botType, pps,
// score, lines, finalLevel, piecesLocked, attacks, avgAttackPerMin, outcome
// ('win' | 'game-over' | 'misdrop-abort').
// Lines: Type A = VRAM 0x990F counts up; Type B = HRAM 0xFF9E BCD counts down (lines cleared at end).
// Console debug: [stats-lines] — enable verbose steps with localStorage gbmul_debug_lines=1
// Console debug: [stats-win]  — Type-B win finalization with localStorage gbmul_debug_win=1
//
// Attack rules:  single→0  double→1  triple→2  quad→4
//
// Menu address map:
//   0xFF86 at submenu-gametype: 0x80(128)=A-type, 0x00=B-type
//   0xC002 at submenu-level  : live LEVEL cursor (0–9) — updates every d-pad step
//   0xFFC3 at submenu-level  : B-type LEVEL digit (can lag); 0xFFC4 = HIGH cursor (0–5)
//   0xFFE1 at submenu-level  : 0x11/0x13=LEVEL panel, 0x14/0x15=HIGH panel (authoritative)
//   0xC000 at submenu-level  : blink display only (0xFF/0x40/0x50 flicker) — NOT panel focus
//   0xFFA9 at game start     : displayed level (B-type = startLevel+startHeight)
//
const STATS_LS_KEY    = 'gbmul_game_stats';
const STATS_MAX_RECS  = 500;
// Type-A rocket / max-out: game skips the GAME OVER screen and returns to title.
const ATYPE_MAXOUT_SCORE = 100000;

function statsLoadAll() {
  try { return JSON.parse(localStorage.getItem(STATS_LS_KEY) || '[]'); }
  catch { return []; }
}
function statsPersist(list) {
  if (list.length > STATS_MAX_RECS) list = list.slice(-STATS_MAX_RECS);
  localStorage.setItem(STATS_LS_KEY, JSON.stringify(list));
}

function statsLinesDebugEnabled() {
  return localStorage.getItem('gbmul_debug_lines') !== '0';
}

function statsWinDebugEnabled() {
  return localStorage.getItem('gbmul_debug_win') !== '0';
}

function statsWinLog(msg, extra) {
  if (!statsWinDebugEnabled()) return;
  if (extra !== undefined) console.info(`[stats-win] ${msg}`, extra);
  else console.info(`[stats-win] ${msg}`);
}

function linesTileToDigit(tile) {
  if (tile <= 9) return tile;
  if (tile === 0x2F) return null;
  if (tile >= 0x30 && tile <= 0x39) return tile - 0x30;
  if (tile >= 0x10 && tile <= 0x19) return tile - 0x10;
  return null;
}

function readLinesVramRaw(emuRef) {
  const base = 0x9800 + 8 * 32;
  const tH = emuRef.read_mem(base + 15);
  const tT = emuRef.read_mem(base + 16);
  const tU = emuRef.read_mem(base + 17);
  const dH = linesTileToDigit(tH);
  const dT = linesTileToDigit(tT);
  const dU = linesTileToDigit(tU);
  let altDecoded = 0;
  if (dH != null) altDecoded += dH * 100;
  if (dT != null) altDecoded += dT * 10;
  if (dU != null) altDecoded += dU;
  return {
    addrH: base + 15,
    addrT: base + 16,
    addrU: base + 17,
    tH,
    tT,
    tU,
    dH,
    dT,
    dU,
    literal: readLinesVRAM(emuRef),
    altDecoded,
  };
}

function readLinesWramProbe(emuRef) {
  const c0a8 = emuRef.read_mem(0xC0A8);
  const c0a9 = emuRef.read_mem(0xC0A9);
  const ff9e = emuRef.read_mem(0xFF9E);
  return {
    c0a8,
    c0a9,
    c0a8Bcd: bcdByte(c0a8),
    c0a9Bcd: bcdByte(c0a9),
    bcdLoHi: bcdByte(c0a8) + bcdByte(c0a9) * 100,
    bcdHiLo: bcdByte(c0a9) + bcdByte(c0a8) * 100,
    ff9e,
    ff9eBcd: bcdByte(ff9e),
  };
}

function readLinesHramBcd(emuRef) {
  return bcdByte(emuRef.read_mem(MENU_HRAM_LINES_BCD));
}

function readLinesCounterSource(gameType) {
  return gameType === 'B' ? 'hram-FF9E' : 'vram-990F';
}

function readLinesCounter(emuRef, gameType) {
  return gameType === 'B' ? readLinesHramBcd(emuRef) : readLinesVRAM(emuRef);
}

function readLinesDebugSnapshot(emuRef, gameType = 'A') {
  return {
    source: readLinesCounterSource(gameType),
    counter: readLinesCounter(emuRef, gameType),
    vram: readLinesVramRaw(emuRef),
    hramLinesBcd: readLinesHramBcd(emuRef),
    wram: readLinesWramProbe(emuRef),
    ffa9: emuRef.read_mem(0xFFA9),
    ff86: emuRef.read_mem(0xFF86),
  };
}

function statsLinesLog(msg, extra) {
  if (!statsLinesDebugEnabled()) return;
  if (extra !== undefined) console.info(`[stats-lines] ${msg}`, extra);
  else console.info(`[stats-lines] ${msg}`);
}

class GameStatsTracker {
  constructor() {
    this._active           = false;
    this._pendingGameType  = 'A';   // 'A' or 'B', captured at submenu-gametype
    this._pendingLevel     = 0;     // level 0–9 from LEVEL panel
    this._pendingHeight    = 0;     // height 0–5 from HIGH panel (B-type)
    this._prevC002         = -1;
    this._linesDisplayMode = null;  // 'countup' | 'countdown' | null (auto-detected)
    this._linesDebugEvents = [];
  }

  // ── Menu state tracking (call every frame during submenu states) ─────────
  updateMenuState(state, emu) {
    if (state === 'submenu-gametype') {
      if (autoMenuNav && _menuRestoreTarget) {
        this._pendingGameType = _menuRestoreTarget.gameType;
      } else {
        // 0xFF86 = 0x80 → A-type cursor;  0x00 → B-type cursor
        this._pendingGameType = (emu.read_mem(0xFF86) & 0x80) ? 'A' : 'B';
      }
      this._pendingLevel     = 0;
      this._pendingHeight    = 0;
      this._prevC002         = -1;
    } else if (state === 'submenu-level') {
      const e1 = emu.read_mem(MENU_HRAM_PHASE);
      // FF86 reads 0x80 on B-type HIGH panel — do not flip to A there.
      if (menuPhaseIsHigh(e1) && (_menuRestoreTarget?.gameType === 'B' || this._pendingGameType === 'B')) {
        this._pendingGameType = 'B';
      } else {
        const ff86 = emu.read_mem(0xFF86);
        if (ff86 === 0x80 || ff86 === 0x00) {
          this._pendingGameType = (ff86 & 0x80) ? 'A' : 'B';
        }
      }
      if (this._pendingGameType === 'B') {
        if (menuPhaseIsHigh(e1)) {
          this._pendingLevel = readMenuLevelOnHighPanel(emu);
          this._pendingHeight = readMenuHighCursor(emu);
        } else if (menuPhaseIsLevel(e1)) {
          this._pendingLevel = readMenuLevelCursor(emu);
        }
      } else {
        this._pendingLevel = readMenuLevelCursor(emu);
      }
      this._prevC002 = readMenuLevelCursor(emu);
    }
  }

  /** Type-A rocket ending — no GAME OVER screen; score peak is the reliable signal. */
  isATypeMaxOutCondition() {
    return this._active
      && this._gameType === 'A'
      && this._pieces > 0
      && this._peakScore >= ATYPE_MAXOUT_SCORE;
  }

  /** Outcome for an active session that is ending. */
  inferGameOutcome(emuRef) {
    if (this.isBTypeWinCondition(emuRef)) return 'win';
    if (this.isATypeMaxOutCondition()) return 'win';
    return 'game-over';
  }

  /** Type-B goal reached: HRAM countdown hit 0 (or all goal lines cleared). */
  isBTypeWinCondition(emuRef) {
    if (!this._active || this._gameType !== 'B') return false;
    if (this._linesRemainingPeak <= 0) return false;
    // FF9E can flicker count-up on Type-A starts misidentified as B — never win in countup mode.
    if (this._linesDisplayMode === 'countup') return false;
    if (this._linesCleared <= 0) return false;
    const remaining = readLinesHramBcd(emuRef);
    if (remaining === 0) return true;
    // Fallback when remaining reads stale but countdown goal was met.
    return this._linesDisplayMode === 'countdown'
      && this._linesCleared >= this._linesRemainingPeak;
  }

  /**
   * Finalize an active Type-B session as win when the countdown reached 0.
   * Returns true if endGame('win') was called.
   */
  maybeFinalizeBTypeWin(emuRef, reason = 'tick') {
    if (!this.isBTypeWinCondition(emuRef)) return false;
    statsWinLog('finalize win', {
      reason,
      cleared: this._linesCleared,
      peak: this._linesRemainingPeak,
      remaining: readLinesHramBcd(emuRef),
      mem: readLinesDebugSnapshot(emuRef, 'B'),
    });
    this.endGame('win', emuRef);
    return true;
  }

  /**
   * Finalize a dangling in-game session (Type-B win, Type-A rocket, or top-out
   * that skipped the game-over screen). Returns outcome recorded, or null.
   */
  maybeFinalizeActiveGame(emuRef, reason = 'leave') {
    if (!this._active) return null;
    // Ignore empty sessions — stale WRAM score can fake A-type max-out before first lock.
    if (this._pieces <= 0) return null;
    const outcome = this.inferGameOutcome(emuRef);
    statsWinLog('finalize active session', {
      reason,
      outcome,
      gameType: this._gameType,
      peakScore: this._peakScore,
      pieces: this._pieces,
      cleared: this._linesCleared,
    });
    this.endGame(outcome, emuRef);
    return outcome;
  }

  getWinDebugState(emuRef) {
    return {
      active: this._active,
      gameType: this._gameType,
      peakScore: this._peakScore,
      cleared: this._linesCleared,
      peak: this._linesRemainingPeak,
      remaining: emuRef ? readLinesHramBcd(emuRef) : null,
      bWin: emuRef ? this.isBTypeWinCondition(emuRef) : false,
      aMaxOut: this.isATypeMaxOutCondition(),
      c201: emuRef ? emuRef.read_mem(PROBE_C201) : null,
      c204: emuRef ? emuRef.read_mem(PROBE_INGAME_ADDR) : null,
      vram9885: emuRef ? emuRef.read_mem(PROBE_VRAM_GO_ADDR) : null,
    };
  }

  /** Call when a fresh game begins (lobby → in-game transition). */
  startGame(botEnabled, botType, pps, emu) {
    if (this._active && emu) {
      const outcome = this.inferGameOutcome(emu);
      statsWinLog('startGame — closing dangling session', {
        outcome,
        peakScore: this._peakScore,
        pieces: this._pieces,
      });
      this.endGame(outcome, emu);
    }
    this._active      = true;
    this._startTs     = Date.now();
    this._dateStart   = new Date().toISOString();
    this._humanUsed   = !botEnabled;
    this._botUsed     = botEnabled;
    this._botType     = botEnabled ? botType : null;
    this._pps         = botEnabled ? pps : null;
    this._pieces      = 0;
    this._singles     = 0;
    this._doubles     = 0;
    this._triples     = 0;
    this._quads       = 0;
    this._prevCurOri  = -1;
    this._prevNextOri = -1;
    // Prefer frozen setup committed at submenu-level → in-game (auto-nav or manual).
    const committed = loadLastPlayedGameSetup();
    if (committed) {
      this.applyCommittedSetup(committed);
    } else {
      this._gameType = this._pendingGameType;
      const ffa9 = emu.read_mem(0xFFA9);
      if (this._gameType === 'A') {
        this._startLevel = ffa9;
        this._startHeight = null;
      } else {
        this._startLevel = Math.min(this._pendingLevel, 9);
        this._startHeight = Math.max(0, Math.min(5, this._pendingHeight));
        if (this._startHeight === 0 && ffa9 > this._startLevel) {
          this._startHeight = Math.min(5, ffa9 - this._startLevel);
        }
      }
    }
    // FF86 reads 0x00 on early Type-A frames — never downgrade menu-committed Type A.
    const lockedType = this._gameType;
    const ff86 = emu.read_mem(0xFF86);
    if (ff86 === 0x80) {
      this._gameType = 'A';
    } else if (ff86 === 0x00 && lockedType !== 'A' && this._pendingGameType !== 'A') {
      this._gameType = 'B';
    }

    this._linesDisplayMode = null;
    this._linesDebugEvents = [];
    this._prevLines = readLinesCounter(emu, this._gameType);
    this._linesCleared = 0;
    this._linesRemainingPeak = 0;
    // Never seed from WRAM — previous game's score can linger for a few frames.
    this._peakScore = 0;

    console.info('[stats] startGame', {
      gameType: this._gameType,
      pendingGameType: this._pendingGameType,
      committed: committed || null,
      ff86,
      startLevel: this._startLevel,
      wramScore: readScoreBcd(emu),
    });
    statsLinesLog('startGame', {
      gameType: this._gameType,
      pendingGameType: this._pendingGameType,
      startLevel: this._startLevel,
      startHeight: this._startHeight,
      source: readLinesCounterSource(this._gameType),
      prevLines: this._prevLines,
      mem: readLinesDebugSnapshot(emu, this._gameType),
    });
  }

  /** Apply an explicit Type/Level/High snapshot (from freezeLastPlayedGameSetup). */
  applyCommittedSetup(setup) {
    const norm = normalizeGameSetup(setup);
    if (!norm) return;
    this._gameType = norm.gameType;
    this._startLevel = norm.startLevel;
    this._startHeight = norm.gameType === 'B' ? norm.startHeight : null;
  }

  /** Call every frame while nextState === 'in-game'. */
  tick(emu, botEnabled, botType, pps) {
    if (!this._active) return;

    if (botEnabled) {
      this._botUsed = true;
      this._botType = botType;
      this._pps     = pps;
    } else {
      this._humanUsed = true;
    }

    // ── piece-lock detection via C203/C213 transition ─────────────────────
    const curOri  = emu.read_mem(0xC203);
    const nextOri = emu.read_mem(0xC213);
    if (this._prevCurOri !== -1 &&
        curOri !== this._prevCurOri &&
        curOri === this._prevNextOri) {
      this._pieces++;
    }
    this._prevCurOri  = curOri;
    this._prevNextOri = nextOri;

    // Track score only after first lock — avoids stale WRAM from the prior game.
    if (this._pieces > 0) {
      const scoreNow = readScoreBcd(emu);
      if (scoreNow > this._peakScore) this._peakScore = scoreNow;
    }

    this._updateLinesCounter(emu);
    this.maybeFinalizeBTypeWin(emu, 'tick');
  }

  /**
   * Type A: VRAM 0x990F counts up. Type B: HRAM 0xFF9E BCD counts down (goal→0).
   */
  _updateLinesCounter(emuRef) {
    const linesNow = readLinesCounter(emuRef, this._gameType);
    const prevPeak = this._linesRemainingPeak;
    if (linesNow > this._linesRemainingPeak) {
      this._linesRemainingPeak = linesNow;
    }
    let clearDelta = 0;
    let attackDelta = 0;
    if (linesNow < this._prevLines) {
      this._linesDisplayMode = this._linesDisplayMode || 'countdown';
      clearDelta = this._prevLines - linesNow;
      attackDelta = Math.min(clearDelta, 4);
    } else if (linesNow > this._prevLines) {
      this._linesDisplayMode = this._linesDisplayMode || 'countup';
      clearDelta = linesNow - this._prevLines;
      attackDelta = Math.min(clearDelta, 4);
    }
    if (attackDelta === 1) this._singles++;
    else if (attackDelta === 2) this._doubles++;
    else if (attackDelta === 3) this._triples++;
    else if (attackDelta === 4) this._quads++;
    if (clearDelta > 0) this._linesCleared += clearDelta;

    if (clearDelta > 0 || linesNow !== this._prevLines || this._linesRemainingPeak !== prevPeak) {
      const evt = {
        t: Date.now(),
        source: readLinesCounterSource(this._gameType),
        mode: this._linesDisplayMode,
        prev: this._prevLines,
        now: linesNow,
        clearDelta,
        attackDelta,
        cleared: this._linesCleared,
        peak: this._linesRemainingPeak,
        mem: readLinesDebugSnapshot(emuRef, this._gameType),
      };
      this._linesDebugEvents.push(evt);
      if (this._linesDebugEvents.length > 200) this._linesDebugEvents.shift();
      if (clearDelta > 0 || this._linesRemainingPeak !== prevPeak) {
        statsLinesLog(
          `${readLinesCounterSource(this._gameType)} ${this._prevLines}→${linesNow}` +
          ` mode=${this._linesDisplayMode} Δclear=${clearDelta}` +
          ` cleared=${this._linesCleared} peak=${this._linesRemainingPeak}`,
          evt.mem
        );
      }
    }
    this._prevLines = linesNow;
  }

  /** Lines cleared at game end — handles A count-up and B countdown displays. */
  computeFinalLines(emuRef, outcome) {
    const finalRemaining = readLinesCounter(emuRef, this._gameType);
    const fromCountdown = this._linesRemainingPeak > 0
      ? Math.max(0, this._linesRemainingPeak - finalRemaining)
      : 0;
    let lines = Math.max(this._linesCleared, fromCountdown);
    // Type-B win: countdown reached 0 — goal equals peak remaining.
    if (outcome === 'win' && this._linesRemainingPeak > 0) {
      lines = Math.max(lines, this._linesRemainingPeak);
    }
    return {
      lines,
      finalRemaining,
      fromCountdown,
      cleared: this._linesCleared,
      peak: this._linesRemainingPeak,
      mode: this._linesDisplayMode,
    };
  }

  getLinesDebugState() {
    return {
      active: this._active,
      gameType: this._gameType,
      displayMode: this._linesDisplayMode,
      prevLines: this._prevLines,
      cleared: this._linesCleared,
      peak: this._linesRemainingPeak,
      events: this._linesDebugEvents.slice(-40),
      source: readLinesCounterSource(this._gameType),
      mem: emu ? readLinesDebugSnapshot(emu, this._gameType) : null,
    };
  }

  /** Last started game's menu settings (stats + menu-restore fallback). */
  lastGameSetup() {
    const frozen = loadLastPlayedGameSetup();
    if (frozen) return frozen;
    return {
      gameType: this._gameType || 'A',
      startLevel: this._startLevel ?? 0,
      startHeight: this._startHeight ?? 0,
    };
  }

  /** Call when the game ends (game-over or win). Idempotent. */
  endGame(outcome, emu) {
    if (!this._active) return;
    this._updateLinesCounter(emu);

    const stopTs     = Date.now();
    // Duration in seconds, rounded to hundredths
    const durationSec = Math.round((stopTs - this._startTs) / 10) / 100;

    // Peak score from in-game ticks — WRAM can be stale on Type-B win screen.
    const score = Math.max(this._peakScore, readScoreBcd(emu));
    const finalLevel = emu.read_mem(0xFFA9);
    const linesResult = this.computeFinalLines(emu, outcome);
    const lines = linesResult.lines;

    statsLinesLog('endGame', {
      outcome,
      gameType: this._gameType,
      recordedLines: lines,
      ...linesResult,
      source: readLinesCounterSource(this._gameType),
      mem: readLinesDebugSnapshot(emu, this._gameType),
      eventCount: this._linesDebugEvents.length,
      lastEvents: this._linesDebugEvents.slice(-8),
    });

    const attacks = this._doubles * 1 + this._triples * 2 + this._quads * 4;

    const avgAttackPerMin = durationSec > 0
      ? Math.round((attacks / (durationSec / 60)) * 100) / 100
      : 0;

    const players = (this._humanUsed && this._botUsed) ? 'both'
                  : this._botUsed                      ? 'bot'
                                                       : 'human';

    const ppsStored = this._botUsed
      ? (isFinite(this._pps) ? this._pps : -1)
      : null;

    // Timestamps with millisecond precision
    const dateStartMs = this._startTs;
    const dateStopMs  = stopTs;

    const record = {
      id:             dateStartMs,
      dateStart:      new Date(dateStartMs).toISOString(),
      dateStop:       new Date(dateStopMs).toISOString(),
      durationSec,
      players,
      gameType:       this._gameType,
      startLevel:     this._startLevel,
      startHeight:    this._startHeight,  // null for A-type
      botType:        this._botUsed ? this._botType : null,
      pps:            ppsStored,
      score,
      lines,
      finalLevel,
      piecesLocked:   this._pieces,
      attacks,
      singles:        this._singles,
      doubles:        this._doubles,
      triples:        this._triples,
      quads:          this._quads,
      avgAttackPerMin,
      outcome,
    };

    const list = statsLoadAll();
    list.push(record);
    statsPersist(list);
    console.info('[stats] Game record saved:', record);
    this._active = false;
  }
}

const statsTracker = new GameStatsTracker();
if (statsLinesDebugEnabled()) {
  console.info(
    '[stats-lines] debug on — filter console by [stats-lines]; ' +
    'live state: __gbmul.getStatsLinesDebug(); disable: __gbmul.setStatsLinesDebug(false)'
  );
}
if (statsWinDebugEnabled()) {
  console.info(
    '[stats-win] debug on — filter console by [stats-win]; ' +
    'live state: __gbmul.getStatsWinDebug(); disable: __gbmul.setStatsWinDebug(false)'
  );
}
let _cachedPanelLines = 0;   // last lines value read from VRAM, updated per-frame in loop()

let _currentStateB = null; // kept in sync every frame for keyboard mirroring

// ── dual-mode debug state ─────────────────────────────────────────────────────
let _dbgFrameCount = 0;
let _dbgLastStateA = null;
let _dbgLastStateB = null;
let _dbgLastScA    = -1;
let _dbgLastScB    = -1;

function _dbgSerialStr(emuRef) {
  const sc  = emuRef.read_mem(0xFF02);
  const sb  = emuRef.read_mem(0xFF01);
  const ifr = emuRef.read_mem(0xFF0F);
  const busy   = (sc & 0x80) ? 'BUSY' : 'idle';
  const role   = (sc & 0x01) ? 'master' : 'slave';
  const irq    = (ifr & 0x08) ? ' IRQ!' : '';
  return `SB=0x${sb.toString(16).padStart(2,'0')} SC=0x${sc.toString(16).padStart(2,'0')}(${busy}/${role})${irq}`;
}

// ── audio ─────────────────────────────────────────────────────────────────────
// Ring buffer accumulates WASM samples (interleaved L/R) between audio callbacks.
const AUDIO_RING_SIZE = 16384; // stereo frame slots (power of 2, ~186ms of headroom at 44100Hz)
const audioRingL = new Float32Array(AUDIO_RING_SIZE);
const audioRingR = new Float32Array(AUDIO_RING_SIZE);
let audioWritePos = 0;
let audioReadPos  = 0;
let audioCtx   = null;
let audioNode  = null;
let audioMuted  = localStorage.getItem("gbmul_sound") === "0";
let audioVolume = parseFloat(localStorage.getItem("gbmul_volume") ?? "0.5");

function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  // Same user-gesture path: unlock misdrop alert AudioContext so game-loop
  // fireMisdropAlert can actually make sound later (independent of game mute).
  unlockMisdropAlertAudio();
}

function initAudio() {
  if (audioCtx) return;
  // sampleRate: 44100 ensures consistent pitch across OS (Windows defaults to 48000 Hz).
  // AudioContext starts suspended on page load (browser autoplay policy); resumeAudio()
  // is called on the first user gesture (click, keydown, touchstart) to unlock it.
  audioCtx = new AudioContext({ sampleRate: 44100 });
  // ScriptProcessorNode: 4096-frame buffer, 0 inputs, 2 outputs (stereo).
  // Deprecated but supported everywhere — good enough for a first prototype.
  audioNode = audioCtx.createScriptProcessor(4096, 0, 2);
  audioNode.onaudioprocess = (e) => {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    for (let i = 0; i < outL.length; i++) {
      if (audioWritePos > audioReadPos) {
        const l = audioRingL[audioReadPos % AUDIO_RING_SIZE];
        const r = audioRingR[audioReadPos % AUDIO_RING_SIZE];
        audioReadPos++;
        outL[i] = audioMuted ? 0 : l * audioVolume;
        outR[i] = audioMuted ? 0 : r * audioVolume;
      } else {
        outL[i] = 0;
        outR[i] = 0;
      }
    }
  };
  audioNode.connect(audioCtx.destination);
  console.log('[audio] ScriptProcessorNode ready, ctx sampleRate =', audioCtx.sampleRate);
}

function drainAudio(samples) {
  if (!samples) return;
  // Guard against overrun: if we've accumulated more than AUDIO_RING_SIZE/2 unread
  // samples, drop the oldest to keep latency bounded.
  const unread = audioWritePos - audioReadPos;
  if (unread > AUDIO_RING_SIZE / 2) audioReadPos += unread - AUDIO_RING_SIZE / 4;
  for (let i = 0; i + 1 < samples.length; i += 2) {
    audioRingL[audioWritePos % AUDIO_RING_SIZE] = samples[i];
    audioRingR[audioWritePos % AUDIO_RING_SIZE] = samples[i + 1];
    audioWritePos++;
  }
}

const _offscreen    = new OffscreenCanvas(W, H);
const _offscreenCtx = _offscreen.getContext("2d", { willReadFrequently: true });

/** Last main-screen frame (160×144 RGBA). Used to freeze + composite the in-device menu. */
let _lastFrameRgba = null;
let _lastFrameHasFrame = false;
/** Mirror of idm.open — safe to read from drawFrame before the idm object exists. */
const _frameComposite = new Uint8ClampedArray(W * H * 4);
const _idmPaintCanvas = new OffscreenCanvas(W, H);
const _idmPaintCtx = _idmPaintCanvas.getContext("2d", { willReadFrequently: true });

// Cuterminus is 6×8 — load early so menu glyphs are ready when first opened.
if (document.fonts?.load) {
  document.fonts.load('8px "Cuterminus"').catch(() => {});
}

/**
 * Paint the in-device menu into a 160×144 RGBA buffer already holding the game frame.
 * Output is what the DMG shader / 2D path will display — so the menu gets shaded too.
 *
 * Greys use only the 4 GB luminances (255/143/111/47). After canvas text (which
 * anti-aliases), the panel is hard-thresholded so mid greys never reach the shader —
 * those mid greys were turning into soft "shadow" blobs under the LCD pass.
 *
 * Level 4 (QR share) and level 5 (join keyboard) use the full screen width.
 */
function idmCompositeInto(rgba) {
  const G0 = 255; // LCD off / panel bg
  const G1 = 143; // mid-light (palette swatch only)
  const G2 = 111; // mid-dark (palette swatch only)
  const G3 = 47;  // full ink / selected bar
  const gray = (v) => `rgb(${v},${v},${v})`;

  // Leave the left half as the frozen game frame (full brightness — no dim).
  // Paint the menu panel on a clean offscreen buffer so canvas anti-alias never
  // bleeds into game pixels, then hard-threshold the panel to pure GB greys.
  const dst = _frameComposite;
  dst.set(rgba);

  // QR / join keyboard: full-width panel. Normal menus: right half only.
  const fullScreenUi = typeof idm !== "undefined" && (idm.level === 4 || idm.level === 5);
  const panelW = fullScreenUi ? W : Math.floor(W / 2); // 160 or 80
  const px = W - panelW;

  const c = _idmPaintCtx;
  c.imageSmoothingEnabled = false;
  // Opaque white panel — never translucent over the game.
  c.fillStyle = gray(G0);
  c.fillRect(0, 0, W, H);
  // 1px solid separator on the panel's left edge (half-width menus only)
  if (!fullScreenUi) {
    c.fillStyle = gray(G3);
    c.fillRect(px, 0, 1, H);
  }

  // Layout in native GB pixels (Cuterminus cell ≈ 6×8 at 8px)
  const fontPx = 8;
  const itemH = 12;

  // Bitmap-style text: no stroke, integer positions only.
  c.font = fontPx + 'px "Cuterminus", monospace';
  c.textBaseline = "top";
  c.textAlign = "left";
  c.shadowColor = "transparent";
  c.shadowBlur = 0;
  c.shadowOffsetX = 0;
  c.shadowOffsetY = 0;
  c.lineWidth = 1;
  c.globalAlpha = 1;

  // ── Full-screen join keyboard (level 5) ───────────────────────────────────
  if (typeof idm !== "undefined" && idm.level === 5) {
    const ink = G3;
    const code = String(idm.joinCode || "").toUpperCase().slice(0, IDM_JOIN_CODE_LEN);
    const focus = idm.joinKey | 0;
    const cols = IDM_JOIN_COLS;
    const cellW = 16; // 9 cols × 16 = 144, 8px side pad
    const cellH = 12;
    const gridW = cols * cellW;
    const gridX = Math.floor((W - gridW) / 2);
    const titleY = 3;
    const slotY = 16;
    const gridY = 34;
    const letterRows = Math.ceil(IDM_JOIN_LETTER_COUNT / cols);
    const actionY = gridY + letterRows * cellH + 4;
    const hintY = H - 10;

    // Title
    c.fillStyle = gray(ink);
    c.textAlign = "center";
    c.fillText("join room", Math.floor(W / 2), titleY);
    c.textAlign = "left";

    // Six code slots (underscore placeholders)
    const slotW = 14;
    const slotGap = 4;
    const slotsW = IDM_JOIN_CODE_LEN * slotW + (IDM_JOIN_CODE_LEN - 1) * slotGap;
    let sx = Math.floor((W - slotsW) / 2);
    for (let i = 0; i < IDM_JOIN_CODE_LEN; i++) {
      const ch = code[i] || "";
      const active = i === code.length && code.length < IDM_JOIN_CODE_LEN;
      if (active) {
        c.fillStyle = gray(ink);
        c.fillRect(sx, slotY - 1, slotW, 11);
        c.fillStyle = gray(G0);
        c.textAlign = "center";
        c.fillText("_", sx + Math.floor(slotW / 2), slotY + 1);
      } else {
        c.fillStyle = gray(ink);
        c.fillRect(sx, slotY + 9, slotW, 1);
        c.textAlign = "center";
        if (ch) c.fillText(ch, sx + Math.floor(slotW / 2), slotY + 1);
      }
      sx += slotW + slotGap;
    }
    c.textAlign = "left";

    // Letter / digit grid
    for (let i = 0; i < IDM_JOIN_LETTER_COUNT; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gridX + col * cellW;
      const y = gridY + row * cellH;
      const selected = focus === i;
      if (selected) {
        c.fillStyle = gray(ink);
        c.fillRect(x + 1, y, cellW - 2, cellH - 1);
        c.fillStyle = gray(G0);
      } else {
        c.fillStyle = gray(ink);
      }
      c.textAlign = "center";
      c.fillText(IDM_JOIN_ALPHABET[i], x + Math.floor(cellW / 2), y + 2);
    }
    c.textAlign = "left";

    // Action row: DEL · OK · X
    const actions = [
      { key: IDM_JOIN_KEY_DEL, label: "del", w: 36 },
      { key: IDM_JOIN_KEY_OK,  label: "ok",  w: 36 },
      { key: IDM_JOIN_KEY_X,   label: "x",   w: 36 },
    ];
    const actGap = 8;
    const actTotal = actions.reduce((s, a) => s + a.w, 0) + actGap * (actions.length - 1);
    let ax = Math.floor((W - actTotal) / 2);
    for (const a of actions) {
      const selected = focus === a.key;
      if (selected) {
        c.fillStyle = gray(ink);
        c.fillRect(ax, actionY, a.w, cellH - 1);
        c.fillStyle = gray(G0);
      } else {
        c.fillStyle = gray(ink);
        // Outline box for unselected actions
        c.fillRect(ax, actionY, a.w, 1);
        c.fillRect(ax, actionY + cellH - 2, a.w, 1);
        c.fillRect(ax, actionY, 1, cellH - 1);
        c.fillRect(ax + a.w - 1, actionY, 1, cellH - 1);
      }
      c.textAlign = "center";
      c.fillText(a.label, ax + Math.floor(a.w / 2), actionY + 2);
      ax += a.w + actGap;
    }
    c.textAlign = "left";

    // Hint
    c.fillStyle = gray(ink);
    c.textAlign = "center";
    c.fillText("A type  B back", Math.floor(W / 2), hintY);
    c.textAlign = "left";
  } else if (typeof idm !== "undefined" && idm.level === 4) {
  // ── Full-screen QR share (level 4) ────────────────────────────────────────
    // Quiet-zone frame + QR modules + caption.
    // Use pure white (G0) + darkest GB grey (G3=47). The LCD shader rank-maps
    // 2-tone frames across the full palette, so G3 becomes the darkest green.
    const ink = G3;
    const caption = "Scan to join";
    const room = (_idmQr && _idmQr.room) || wglRoomId || "";
    const roomLine = room ? "room " + String(room).slice(0, 6) : "";
    const hint = "B/Esc back";

    const topPad = 4;
    const capH = 10;
    const roomH = roomLine ? 10 : 0;
    const botH = 12;
    const framePad = 4; // white quiet zone inside the ink frame

    // Available square for modules (keep integer module size ≥ 2 when possible).
    const availH = H - topPad - capH - roomH - botH - 2;
    const availW = W - 8;
    const n = (_idmQr && _idmQr.count) || 0;
    let cell = n > 0 ? Math.floor(Math.min(availW, availH) / n) : 0;
    if (cell < 1) cell = 1;
    const qrPx = n * cell;
    // Outer frame: 1px ink border + quiet zone + modules.
    const outer = qrPx + framePad * 2 + 2;
    const frameX = Math.floor((W - outer) / 2);
    const frameY = topPad + capH + roomH + Math.floor((availH - outer) / 2);

    // Caption centered
    c.fillStyle = gray(ink);
    c.textAlign = "center";
    c.fillText(caption, Math.floor(W / 2), topPad);
    if (roomLine) {
      c.fillText(roomLine, Math.floor(W / 2), topPad + capH);
    }
    c.textAlign = "left";

    // Ink frame rectangle
    c.fillStyle = gray(ink);
    c.fillRect(frameX, frameY, outer, 1);
    c.fillRect(frameX, frameY + outer - 1, outer, 1);
    c.fillRect(frameX, frameY, 1, outer);
    c.fillRect(frameX + outer - 1, frameY, 1, outer);
    // Quiet zone (already white panel bg)

    // Modules
    if (_idmQr && n > 0) {
      const qx = frameX + 1 + framePad;
      const qy = frameY + 1 + framePad;
      c.fillStyle = gray(ink);
      for (let my = 0; my < n; my++) {
        const row = _idmQr.modules[my];
        for (let mx = 0; mx < n; mx++) {
          if (row[mx]) c.fillRect(qx + mx * cell, qy + my * cell, cell, cell);
        }
      }
    } else {
      c.fillStyle = gray(ink);
      c.textAlign = "center";
      c.fillText("no qr", Math.floor(W / 2), Math.floor(H / 2) - 4);
      c.textAlign = "left";
    }

    // Bottom hint
    c.fillStyle = gray(ink);
    c.textAlign = "center";
    c.fillText(hint, Math.floor(W / 2), H - botH + 1);
    c.textAlign = "left";
  } else {
    // ── Standard half-width item list ───────────────────────────────────────
    const items = idmItems();
    const n = items.length;
    const itemsTop = Math.floor(H / 2 - (n * itemH) / 2);

    // ABOUT header block
    if (idm.level === 2) {
      const lineGap = itemH;
      const blockTop = itemsTop - lineGap * 3 - 4;
      const lx = px + 8;
      c.fillStyle = gray(G3);
      c.fillText("gbmul", lx, blockTop);
      c.fillText("build", lx, blockTop + lineGap);
      c.fillText(String(GBMUL_BUILD.stamp || "—").slice(0, 14), lx, blockTop + lineGap * 2);
    }

    for (let i = 0; i < n; i++) {
      const item = items[i];
      const iy = itemsTop + i * itemH;
      const selected = i === idm.selected;
      // Selected = inverted bar (dark bg / light ink).
      if (selected) {
        c.fillStyle = gray(G3);
        c.fillRect(px + 1, iy, panelW - 1, itemH - 1);
      }
      const textY = iy + Math.floor((itemH - fontPx) / 2);
      // Pure ink only (G0 or G3) — mid greys anti-alias into soft shadow blobs.
      const ink = selected ? G0 : G3;

      c.fillStyle = gray(ink);
      c.fillText(">", px + 3, textY);
      c.fillText(idmLabel(item), px + 12, textY);

      // Checkbox / palette swatch on the right
      if (IDM_CHECKABLE.has(item)) {
        const bs = 8;
        const cbx = px + panelW - 12;
        const cby = textY;
        // Integer-pixel rects (no +0.5 strokes — those blur into mid greys).
        c.fillStyle = gray(ink);
        c.fillRect(cbx, cby, bs, 1);
        c.fillRect(cbx, cby + bs - 1, bs, 1);
        c.fillRect(cbx, cby, 1, bs);
        c.fillRect(cbx + bs - 1, cby, 1, bs);
        if (idmIsChecked(item)) {
          for (let t = 1; t < bs - 1; t++) {
            c.fillRect(cbx + t, cby + t, 1, 1);
            c.fillRect(cbx + (bs - 1 - t), cby + t, 1, 1);
          }
        }
      } else if (item === "palette") {
        const sw = [G0, G1, G2, G3];
        const swSize = 6;
        let sx = px + panelW - 4 - sw.length * (swSize + 1);
        const sy = textY + 1;
        for (const g of sw) {
          c.fillStyle = gray(g);
          c.fillRect(sx, sy, swSize, swSize);
          if (g === G0) {
            c.fillStyle = gray(G3);
            c.fillRect(sx, sy, swSize, 1);
            c.fillRect(sx, sy + swSize - 1, swSize, 1);
            c.fillRect(sx, sy, 1, swSize);
            c.fillRect(sx + swSize - 1, sy, 1, swSize);
          }
          sx += swSize + 1;
        }
      }
    }
  }

  // Hard-threshold the panel only: canvas text anti-aliases into mid greys that
  // the DMG shadow pass turns into soft "melted" glyph shapes. Force every panel
  // pixel to a pure GB grey; text edges go solid ink or solid bg (no mid tones).
  const painted = c.getImageData(px, 0, panelW, H);
  const d = painted.data;
  const mid = (G0 + G3) / 2; // ~151 — darker → ink, lighter → bg
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // Keep exact 4-level palette swatches.
    if (r === g && g === b && (r === G0 || r === G1 || r === G2 || r === G3)) {
      d[i + 3] = 255;
      continue;
    }
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // 1-bit for labels / arrows / checks / separator. Works for both dark-on-light
    // (non-selected) and light-on-dark (selected bar) because AA edges sit mid-grey.
    const v = lum < mid ? G3 : G0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }

  // Blit thresholded panel onto the frozen game frame.
  for (let y = 0; y < H; y++) {
    const srcRow = y * panelW * 4;
    const dstRow = (y * W + px) * 4;
    dst.set(d.subarray(srcRow, srcRow + panelW * 4), dstRow);
  }
  return dst;
}

/** Re-draw the frozen game frame + menu through the normal (shader) path. */
function idmRedrawShaded() {
  if (romSplashOpen) {
    romSplashRedraw();
    return;
  }
  if (!_lastFrameRgba) return;
  drawFrame(ctx, _lastFrameRgba);
}

function drawFrame(targetCtx, rgba) {
  let pixels = rgba;

  // Main screen: ROM cart splash (no game) or freeze + in-device menu composite.
  // Both paths paint into the 160×144 buffer that feeds the DMG shader.
  if (targetCtx === ctx) {
    if (romSplashOpen) {
      pixels = romSplashComposite();
      // Menu can open over the splash (GBmul / Esc) — composite on top.
      if (idmIsOpen) {
        pixels = idmCompositeInto(pixels);
      }
    } else {
      if (!_lastFrameRgba || _lastFrameRgba.length !== rgba.length) {
        _lastFrameRgba = new Uint8ClampedArray(rgba.length);
      }
      if (!idmIsOpen) {
        _lastFrameRgba.set(rgba);
        _lastFrameHasFrame = true;
      } else if (!_lastFrameHasFrame) {
        // First frame after open with no prior snapshot — use whatever we have.
        _lastFrameRgba.set(rgba);
        _lastFrameHasFrame = true;
      }
      if (idmIsOpen) {
        pixels = idmCompositeInto(_lastFrameRgba);
      }
    }
  }

  // Route main screen through WebGL shader when active
  if (targetCtx === ctx && shaderLevel > 0 && gbShader) {
    canvasGl.width  = targetCtx.canvas.width;
    canvasGl.height = targetCtx.canvas.height;
    gbShader.render(pixels, shaderLevel);
    return;
  }
  // Route bot screen through WebGL shader when active
  if (targetCtx === ctxBot && shaderLevel > 0 && gbShaderBot) {
    canvasGlBot.width  = targetCtx.canvas.width;
    canvasGlBot.height = targetCtx.canvas.height;
    gbShaderBot.render(pixels, shaderLevel);
    return;
  }
  const img = new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), W, H);
  _offscreenCtx.putImageData(img, 0, 0);
  targetCtx.imageSmoothingEnabled = false;
  targetCtx.drawImage(_offscreen, 0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
}

// ── game loop ────────────────────────────────────────────────────────────────
// Tracks the last known game-state so the badge is only updated on a change.
let _lastGameState = null; // "menu" | "in-game" | null

/** Block spurious submenu-level→in-game commits right after loadRom (stale HRAM). */
let _suppressSetupCommitFrames = 0;
let _lastTitleCursor2P = null; // null=unknown, false=1P, true=2P
let _autoRightFrames   = 0;     // frames left to hold Right pressed (auto 2P cursor, needs ~100ms)
let _autoBtnFrames     = 0;     // generic auto-tap hold (gametype/level cursor nudges)
let _autoBtnCode       = -1;
let _autoStartFrames   = 0;     // frames left to hold Start pressed (auto menu advance)
let _splashJitterFrames = 0;    // random frames to wait on splash before pressing Start (for PRNG entropy)
/** One-shot guard: auto splash-skip must not re-fire Start during the same splash visit. */
let _splashAutoPressed = false;
let _titleJitterFrames = 0;
let _gametypeJitterFrames = 0;
/** Wait after gametype entry so title Start release does not confirm A-type. */
let _menuGametypeEntryFrames = 0;
const MENU_GAMETYPE_ENTRY_FRAMES = 18;
/** Steps done on game-type screen: [Right] for B, [] for A. */
let _gametypeSeqIdx = 0;
let _levelJitterFrames = 0;
/** @type {{ gameType: string, startLevel: number, startHeight: number } | null} */
let _menuRestoreTarget = null;
function resetMenuRestoreProgress() {
  _menuNavSequence = [];
  _menuNavStepIdx = 0;
  _menuNavPastA = false;
  _menuNavPendingOutcome = null;
  _menuNavLastSnapKey = '';
  _menuNavAwaitingOutcome = false;
  _menuNavStepCooldown = 0;
  _menuNavFrozenForStart = false;
  _menuNavDidFreezeForStart = false;
  _menuSetupSnapshot = null;
  _menuLevelConfirmed = false;
  _menuNavPhase = 'level';
  _menuStableLevelFrames = 0;
  _menuNavConfirmedLevel = null;
  resetMenuPanelTracking();
  // Keep _menuNavActive — cleared only on in-game or loadRom.
}
// Debounce non-playing states: require a state to appear for this many
// consecutive frames before we act on it.  This prevents spurious bot resets
// caused by transient VRAM values during line-clear animations (the game-over
// tile detector can fire for a single frame during flashing lines).
const STATE_DEBOUNCE_FRAMES = 3;
let _pendingState      = null;
let _pendingStateCount = 0;

// Frame pacing: target ~59.73 Hz regardless of display refresh rate.
// Without this, high-refresh displays (90/120/144 Hz) run the emulator too fast,
// generating excess audio samples which play back at higher pitch.
const TARGET_FRAME_MS = 1000 / 59.7275;
let _loopLastTs = null;
let _loopAccum  = 0;

/**
 * Start (or resume) the frame loop. Always go through rAF so `timestamp` is a
 * real high-res time — calling `loop()` directly leaves `timestamp` undefined,
 * which poisons `_loopAccum` with NaN and freezes the emulator forever.
 */
function startLoop() {
  if (emulationPaused) return;
  if (animId != null) return;
  _loopLastTs = null;
  _loopAccum = 0;
  animId = requestAnimationFrame(loop);
}

function loop(timestamp) {
  if (emulationPaused) { animId = null; return; }
  animId = requestAnimationFrame(loop);
  if (!emu) return;

  fpsFrameTimes.push(performance.now());
  if (fpsFrameTimes.length > 180) fpsFrameTimes.shift(); // cap at ~3 s

  // Guard: non-rAF entry (legacy callers) must not poison the frame clock.
  if (timestamp == null || !Number.isFinite(timestamp)) {
    _loopLastTs = null;
    _loopAccum = 0;
    return;
  }

  if (_loopLastTs === null) { _loopLastTs = timestamp; return; }
  const _loopElapsed = Math.min(timestamp - _loopLastTs, 100); // clamp: avoid spiral after tab suspend
  _loopLastTs = timestamp;
  _loopAccum += _loopElapsed;

  while (_loopAccum >= TARGET_FRAME_MS) {
    _loopAccum -= TARGET_FRAME_MS;
    if (_suppressSetupCommitFrames > 0) _suppressSetupCommitFrames--;

  // Hold / release auto-right press for dual 2P cursor auto-select (~100ms minimum)
  if (_autoRightFrames > 0) {
    _autoRightFrames--;
    if (_autoRightFrames === 0) emu.key_up(7);
  }

  // Hold / release generic auto-tap (gametype Left, level Up, etc.)
  if (_autoBtnFrames > 0) {
    _autoBtnFrames--;
    if (_autoBtnFrames === 0 && _autoBtnCode >= 0) {
      emu.key_up(_autoBtnCode);
      _autoBtnCode = -1;
      if (autoMenuNav && _lastGameState === 'submenu-level') {
        menuNavLogPressOutcome(emu);
      }
    }
  }

  // Hold / release auto-Start press for dual splash skip (~100ms minimum)
  if (_autoStartFrames > 0) {
    _autoStartFrames--;
    if (_autoStartFrames === 0) {
      emu.key_up(3);
      if (emuB) emuB.key_up(3);
      if (autoMenuNav && _menuNavPendingOutcome) {
        menuNavLogPressOutcome(emu);
      }
    }
  }

  // Bot inputs must be applied BEFORE run_frame so Down releases take effect
  // before the emulated frame where the piece lands (Rosy instant-lock on S→L spin).
  const _preFrameState = detectGameState(emu);

  // Menu nav before run_frame. Use debounced _lastGameState too — raw detectGameState
  // can flicker to "title" when C201 clears for a frame during cursor blink.
  if (_lastGameState === 'submenu-level' || _preFrameState === 'submenu-level') {
    captureMenuSetupSnapshot(emu);
  }

  if (autoMenuNav && (isHighScoreEntryScreen(emu) || isRocketPostGame(emu) || isPostGameScoreboardFamily(emu))) {
    // Post-GO scoreboard / rocket / name entry — never auto-nav.
  } else if (autoMenuNav
      && _lastGameState !== 'high-score-entry' && _preFrameState !== 'high-score-entry'
      && _lastGameState !== 'rocket' && _preFrameState !== 'rocket'
      && (_lastGameState === 'submenu-level' || _preFrameState === 'submenu-level')) {
    // Stale E1 can mis-detect gametype as level select — never level-nav on C000=0x70.
    if (emu.read_mem(0xC000) !== 0x70
        && !isPostGameScoreboardFamily(emu)) {
      const target = _menuRestoreTarget || captureMenuRestoreTarget();
      // FF86 reads 0x80 on B-type HIGH panel — only fix game type before nav starts.
      if (!gametypeMatchesTarget(emu, target) && !_menuNavActive) {
        if (autoMenuCanPress()) {
          console.log(
            `[menu-nav] level select is Type ${readGametypeCursor(emu)} ` +
            `but target is ${target.gameType} — pressing B`
          );
          autoMenuTapBtn(MENU_BTN_B, AUTO_MENU_GAMETYPE_HOLD_FRAMES);
        }
      } else {
        autoMenuLevelRestoreStep(target);
      }
    }
  }

  if (botEnabled) {
    const botStatePre = dualMode && emuB ? detectGameState(emuB) : _preFrameState;
    const shouldTickPre =
      botStatePre === 'in-game' || botStatePre === 'paused'
      || (!autoMenuNav && !dualMode);
    if (shouldTickPre) {
      // Capture plan-time spawn BEFORE bot plans/presses — same frame can CW while still high.
      rememberSpawnFullState();
      if (rustBot) {
        rustBotTick();
      } else if (bot) {
        bot.tick(emu, botStatePre);
      }
    }
  }

  if (dualMode && emuPair) {
    // Interleaved 512-cycle slices so serial link-cable exchanges complete
    // within the same GB frame — reduces 2P pre-game handshake from ~14 s
    // to ~0.2 s with no change to visual frame rate.
    const both = emuPair.run_frame_pair();
    drainAudio(emuPair.get_audio_buffer_a());
    const stride = 160 * 144 * 4;
    drawFrame(ctx, both.subarray(0, stride));
    drawFrame(ctxBot, both.subarray(stride));
  } else {
    const frame = emu.run_frame();
    drainAudio(emu.get_audio_buffer());
    drawFrame(ctx, frame);
  }

  // Post-frame pose sample for deferred lock verify (sprite RAM matches rendered frame).
  if (botEnabled && rustBot) {
    try {
      if (dualMode && emuPair && typeof rustBot.tickPostFramePairB === 'function') {
        rustBot.tickPostFramePairB(emuPair);
      } else if (typeof rustBot.tickPostFrame === 'function') {
        rustBot.tickPostFrame(emu);
      }
      drainLockAuditToStorage();
    } catch (e) { /* optional */ }
    // Detect garbage via link-cable height drops (instant, no debounce).
    try {
      if (dualMode && emuPair && typeof rustBot.addGarbageLines === 'function') {
        // Observe ROM garbage-hole template ($C400 / $C3FF) — diagnostic only.
        logGarbageHoleTemplateIfReady(emuPair);
        const lines = emuPair.takeLinkGarbage();
        if (lines > 0) {
          const holesB = scanBoardGarbageHoleCols((a) => emuPair.read_mem_b(a));
          console.log(
            `[garbage] link height-drop → ${lines} line(s) sent (A→B)` +
            ` | B board hole col(s) (1-based): ${holesB.length ? holesB.join(',') : 'n/a'}` +
            ` | ${fmtGarbHoleSide('B', (a) => emuPair.read_mem_b(a))}`
          );
          setStatus(`garbage ${lines} lines sent`);
          rustBot.addGarbageLines(lines);
        }
      }
    } catch (e) { /* optional */ }
    // Detect garbage received by the human (side A) from the bot.
    // First non-zero snapshot is baseline (start height / setup), not an attack.
    try {
      if (dualMode && emuPair) {
        const BASE = 0xC800, STRIDE = 32, ROWS = 18, COLS = 10;
        let countA = 0;
        for (let row = 0; row < ROWS; row++) {
          const off = row * STRIDE + 2;
          for (let col = 0; col < COLS; col++) {
            if (emuPair.read_mem_a(BASE + off + col) === 0x28) countA++;
          }
        }
        if (countA > _garbageA_count) {
          if (_garbageA_count === 0) {
            console.log(`[garbage] A baseline ${countA} tile(s) — not an attack`);
          } else {
            const added = Math.floor((countA - _garbageA_count) / 9);
            if (added > 0) {
              const holesA = scanBoardGarbageHoleCols((a) => emuPair.read_mem_a(a));
              console.log(
                `[garbage] A WRAM +${added} line(s) received (B→A)` +
                ` | A board hole col(s) (1-based): ${holesA.length ? holesA.join(',') : 'n/a'}` +
                ` | ${fmtGarbHoleSide('A', (a) => emuPair.read_mem_a(a))}`
              );
              setStatus(`garbage ${added} lines received`);
            }
          }
        }
        _garbageA_count = countA;
      }
    } catch (e) { /* optional */ }
  }

  // Push game-state change to badge – only touches the DOM when state transitions.
  // "in-game" and "paused" are committed immediately; all other states are
  // debounced to avoid acting on single-frame VRAM glitches.
  const rawState = detectGameState(emu);
  // Hysteresis: C201 oscillates during attract demo; keep "demo" while it flickers
  // to "in-game". We leave demo only when detectGameState returns something unambiguous.
  //
  // Guard against false transitions FROM an active game:
  //   - 'submenu-gametype' / 'submenu-level': detected via C204 bit7=0 + C201≠0. During
  //     ARE (piece lock → next spawn) C204 bit7 briefly drops while C201 still holds the
  //     last piece's pixel Y → false submenu. Can never be legitimately reached from in-game.
  //   - 'demo': C201=0x40 inside the in-game branch; same collision with piece at row 6.
  // Only in-game/paused — post-game (rocket/name entry) legitimately reaches level select.
  const _inActiveGame = _lastGameState === 'in-game' || _lastGameState === 'paused';
  const _ambiguous    = rawState === 'submenu-gametype' || rawState === 'submenu-level' || rawState === 'demo';
  const effectiveRaw  = (rawState === 'in-game' && _lastGameState === 'demo') ? 'demo'
                      : (_ambiguous && _inActiveGame) ? _lastGameState
                      : rawState;
  let nextState;
  if (effectiveRaw === 'in-game' || effectiveRaw === 'paused'
      || effectiveRaw === 'win' || effectiveRaw === 'game-over'
      || effectiveRaw === 'rocket' || effectiveRaw === 'high-score-entry'
      || VS_RESULT_STATES.has(effectiveRaw)) {
    // Commit immediately — no debounce for active play or terminal outcomes.
    _pendingState      = null;
    _pendingStateCount = 0;
    nextState = effectiveRaw;
  } else {
    if (effectiveRaw === _pendingState) {
      _pendingStateCount++;
    } else {
      _pendingState      = effectiveRaw;
      _pendingStateCount = 1;
    }
    // Only commit once the state has been stable for enough frames.
    nextState = (_pendingStateCount >= STATE_DEBOUNCE_FRAMES) ? effectiveRaw : (_lastGameState ?? effectiveRaw);
  }

  if (nextState !== _lastGameState) {
    const prevGameState = _lastGameState;
    // Type-B win / Type-A rocket skip game-over — finalize when leaving in-game.
    // 2P result cutscenes are also terminal for the active dual round.
    if (prevGameState === 'in-game'
        && nextState !== 'in-game' && nextState !== 'paused'
        && nextState !== 'win' && nextState !== 'game-over' && nextState !== 'rocket'
        && !VS_RESULT_STATES.has(nextState)) {
      const finalized = statsTracker.maybeFinalizeActiveGame(emu, 'leave-in-game');
      if (finalized === 'win') nextState = 'win';
    }
    _lastGameState = nextState;
    gameStateBadge.dataset.state = nextState;
    gameStateLabel.textContent   = STATE_LABELS[nextState] ?? nextState;
    const c204v = emu.read_mem(PROBE_INGAME_ADDR);
    const c201v = emu.read_mem(PROBE_C201);
    const c000v = emu.read_mem(PROBE_C000);
    const cffcv = emu.read_mem(PROBE_PAUSE_ADDR);
    const c001v = emu.read_mem(PROBE_C001);
    const e1v = emu.read_mem(MENU_HRAM_PHASE);
    gameStateBadge.title =
      `0xC000=0x${c000v.toString(16).toUpperCase().padStart(2,"0")} ` +
      `0xC201=0x${c201v.toString(16).toUpperCase().padStart(2,"0")} ` +
      `0xC001=0x${c001v.toString(16).toUpperCase().padStart(2,"0")} ` +
      `0xE1=0x${e1v.toString(16).toUpperCase().padStart(2,"0")} ` +
      `0xC204=0x${c204v.toString(16).toUpperCase().padStart(2,"0")} ` +
      `0xCFFC=0x${cffcv.toString(16).toUpperCase().padStart(2,"0")}`;
    // Reset bot when leaving in-game (game-over, paused, title, 2P result)
    if (nextState !== "in-game" && nextState !== "paused") {
      if (botEnabled) {
        const b = dualMode ? emuB : emu;
        if (b) { if (rustBot) rustBotReset(); else bot.reset(b); }
      }
    }
    // Reset per-game stats only when a fresh game begins from a lobby/end state.
    // Transitions from 'paused' are resumes. 'win' is an end state like 'game-over'.
    const LOBBY_STATES = new Set([
      'splash', 'title', 'demo', 'submenu-gametype', 'submenu-level',
      'game-over', 'win',
      '2p-round-win', '2p-round-loss', '2p-match-win', '2p-match-loss',
    ]);
    if (nextState === 'in-game' && prevGameState === 'submenu-level') {
      commitGameSetupAtStart(emu);
    }
    if (nextState === "in-game" && (prevGameState === null || LOBBY_STATES.has(prevGameState))) {
      if (botEnabled) { 
        if (rustBot) rustBot.resetStats(); else if (bot) bot.resetStats(); 
        window._prevPieceMinY = 255;
        clearMisdropSpawnCaptures();
        window._suppressNextMisdropCapture = false;
      }
      _garbageA_count = 0;
      _garbHoleLogKey = '';
      if (dualMode && emuPair) {
        // Snapshot as soon as the round starts (template may still be unpunched).
        console.log(
          `[garbage-hole] round start — ${fmtGarbHoleSide('A', (a) => emuPair.read_mem_a(a))}` +
          ` | ${fmtGarbHoleSide('B', (a) => emuPair.read_mem_b(a))}`
        );
      }
      statsTracker.startGame(botEnabled, 'hybrid', rustBot ? Infinity : bot._ppsLimit, emu);
    }
    // Finalise stats record when a game ends.
    if (nextState === 'game-over' || nextState === 'win') {
      statsTracker.endGame(nextState, emu);
    }
    if (nextState === 'splash' && prevGameState !== 'splash') {
      _splashJitterFrames = Math.floor(Math.random() * 10);
      _splashAutoPressed = false;
    }
    if (nextState === 'title' && prevGameState !== 'title') {
      _titleJitterFrames = Math.floor(Math.random() * 10);
      // Splash Start must not bleed into the title (would confirm 1P/2P → game-type).
      autoMenuReleaseStart();
    }
    if (nextState === 'submenu-gametype' && prevGameState !== 'submenu-gametype') {
      _suppressSetupCommitUntilLobby = false;
      _gametypeJitterFrames = Math.floor(Math.random() * 10);
      if (autoMenuNav) {
        autoMenuReleaseStart();
        _menuGametypeEntryFrames = MENU_GAMETYPE_ENTRY_FRAMES;
        _gametypeSeqIdx = 0;
        _menuRestoreTarget = captureMenuRestoreTarget();
        statsTracker._pendingGameType = _menuRestoreTarget.gameType;
        console.log('[menu-nav] gametype entry — restore', JSON.stringify(_menuRestoreTarget));
        resetMenuRestoreProgress();
      }
    }
    if ((nextState === 'high-score-entry' || nextState === 'rocket')
        && prevGameState !== nextState) {
      _menuNavActive = false;
      resetMenuRestoreProgress();
      console.log(`[menu-nav] ${nextState} — auto-nav paused`);
    }
    if (nextState === 'submenu-level' && prevGameState !== 'submenu-level') {
      const freshEntry = !_menuNavActive && (
        prevGameState === 'submenu-gametype'
        || prevGameState === 'title' || prevGameState === 'splash'
        || prevGameState === 'demo' || prevGameState === null
      );
      if (freshEntry) {
        _menuNavActive = true;
        _levelJitterFrames = Math.floor(Math.random() * 10);
        resetMenuRestoreProgress();
        if (autoMenuNav) {
          statsTracker._pendingLevel = 0;
          statsTracker._pendingHeight = 0;
          _menuLevelConfirmed = false;
          _menuNavPhase = 'level';
          _menuStableLevelFrames = 0;
          if (prevGameState === 'submenu-gametype') {
            _menuLevelEntryFrames = 30;
          }
          const t = _menuRestoreTarget || captureMenuRestoreTarget();
          statsTracker._pendingGameType = t.gameType;
          _menuNavConfirmedLevel = null;
          if (gametypeMatchesTarget(emu, t)) {
            console.log('[menu-nav] entered level select — restore target:', JSON.stringify(t));
            planMenuRestoreSequence(t);
            menuNavLogSelected(readMenuNavSnapshot(emu, t), 'entered');
          } else {
            _menuNavActive = false;
            console.log(
              `[menu-nav] level select Type ${readGametypeCursor(emu)} ≠ target ${t.gameType}` +
              ' — will press B to game-type screen'
            );
          }
        }
      } else if (_menuNavActive) {
        _levelJitterFrames = Math.max(_levelJitterFrames, 3);
      }
    }
    if (nextState === 'in-game' && (prevGameState === 'submenu-level' || prevGameState === 'submenu-gametype')) {
      _menuRestoreTarget = null;
      _menuNavActive = false;
      resetMenuRestoreProgress();
    }
  }

  // Always auto-skip splash after loadRom / 1P↔2P switch (both sides in dual).
  // Independent of "Auto-advance menus" — that option continues past the title.
  // One-shot only: a second Start (or hold into title) confirms player count and
  // jumps straight to game-type select.
  if (nextState === 'splash') {
    if (_splashJitterFrames > 0) {
      _splashJitterFrames--;
    } else if (!_splashAutoPressed && autoMenuCanPress()) {
      _splashAutoPressed = true;
      // Short hold (~100ms) — long enough for the ROM, short enough not to carry
      // into the title if release-on-transition races a few frames late.
      autoMenuTapStart(dualMode, 6);
    }
  } else if (nextState !== 'splash' && _splashAutoPressed && _autoStartFrames === 0) {
    // Visit complete; allow a future splash (e.g. after another mode switch).
    _splashAutoPressed = false;
  }

  if (autoMenuNav && nextState === 'title') {
    if (_titleJitterFrames > 0) {
      _titleJitterFrames--;
    } else if (autoMenuCanPress()) {
      autoMenuTapStart();
    }
  }

  if (autoMenuNav && nextState === 'submenu-gametype') {
    if (_menuGametypeEntryFrames > 0) {
      _menuGametypeEntryFrames--;
    } else {
      const target = _menuRestoreTarget || captureMenuRestoreTarget();
      // Sequence-driven: B needs one Right from default A; never trust FF86 alignment.
      const gametypeSeq = target.gameType === 'B' ? [7] : [];
      if (_gametypeSeqIdx < gametypeSeq.length) {
        if (autoMenuCanPress()) {
          const btn = gametypeSeq[_gametypeSeqIdx];
          console.log(`[menu-nav] gametype seq[${_gametypeSeqIdx}] ${btn === 7 ? 'Right' : 'Left'}`);
          autoMenuTapBtn(btn, AUTO_MENU_GAMETYPE_HOLD_FRAMES);
          _gametypeSeqIdx++;
        }
      } else if (_gametypeJitterFrames > 0) {
        _gametypeJitterFrames--;
      } else if (autoMenuCanPress()) {
        statsTracker._pendingGameType = target.gameType;
        console.log(`[menu-nav] gametype Start — Type ${target.gameType}`);
        autoMenuTapStart();
      }
    }
  }

  if (nextState === 'submenu-level') {
    const target = _menuRestoreTarget || captureMenuRestoreTarget();
    if (autoMenuNav) menuNavLogSelected(readMenuNavSnapshot(emu, target));
    gameStateLabel.textContent = formatLevelSelectBadge(emu, target);
  }

  // Title screen cursor: sync the 2-Player checkbox with the in-game 1P/2P cursor.
  // C001=0x10 → 1 Player, C001=0x60 → 2 Player.
  // - On first arrival (null→value): sync checkbox visually, no ROM reload.
  // - On actual cursor move (false↔true): fire change event only if mode differs,
  //   triggering the full dual/solo switch + loadRom (once, not every frame).
  if (nextState === 'title') {
    const c001 = emu.read_mem(0xC001);
    // Only act on known stable cursor values. Any other value means the game
    // is transitioning away (Start pressed) — ignore to avoid spurious mode switches.
    if (c001 === 0x10 || c001 === 0x60) {
      const cursor2P = (c001 === 0x60);
      if (_lastTitleCursor2P !== cursor2P) {
        const firstArrival = (_lastTitleCursor2P === null);
        _lastTitleCursor2P = cursor2P;
        if (!firstArrival && cursor2P !== dualMode) {
          dualCheck.checked = cursor2P;
          dualCheck.dispatchEvent(new Event('change'));
        }
        // In dual mode, auto-select 2P on first title screen arrival (cursor starts at 1P)
        if (firstArrival && dualMode && !cursor2P && autoMenuCanPress()) {
          emu.key_down(7); // Right arrow → move cursor to 2P
          _autoRightFrames = AUTO_MENU_LEVEL_HOLD_FRAMES;
        }
      }
    }
  } else {
    _lastTitleCursor2P = null;
  }

  // Stats: track menu state for game-type/level/height capture
  if (nextState === 'submenu-gametype' || nextState === 'submenu-level') {
    statsTracker.updateMenuState(nextState, emu);
  }
  // Stats tick — record piece locks and line clears every in-game frame.
  if (nextState === 'in-game') {
    statsTracker.tick(emu, botEnabled, 'hybrid', rustBot ? Infinity : bot._ppsLimit);
  }

  stateProbeTick(emu, nextState);

  // Lines display cache — read directly from VRAM tilemap (0x990F–0x9911).
  // VRAM only updates after the animation ends, so there are zero transients.
  if (nextState === 'in-game' || nextState === 'paused') {
    const panelType = statsTracker._gameType || statsTracker._pendingGameType;
    _cachedPanelLines = readLinesCounter(emu, panelType);
  }

  // Side B state detection (dual mode only, computed once for both debug and bot)
  const stateB = (dualMode && emuB) ? detectGameState(emuB) : null;
  _currentStateB = stateB;

  // ── Dual-mode debug logging + Dynamic Bot speed ───────────────────────────
  if (dualMode && emuB) {
    _dbgFrameCount++;

    // Arm dynamic PPS once both sides are in a live round.
    // Re-arm after returning to in-game from a result / lobby.
    const aLive = nextState === 'in-game' || nextState === 'paused';
    const bLive = stateB === 'in-game' || stateB === 'paused';
    if (aLive && bLive) _dynamicRoundArmed = true;

    // Log A state changes + Dynamic Bot speed (side A = human).
    // 2P: Mario/Luigi cutscene; round vs match from FFD7/FFD8 (first to 4).
    if (nextState !== _dbgLastStateA) {
      console.log(`[dual] A: ${_dbgLastStateA ?? '—'} → ${nextState}`);
      if (VS_RESULT_STATES.has(nextState)) {
        onDynamicBotVsResult(nextState);
      } else if (nextState === 'game-over') {
        // Solo-style game-over on A is rare in dual; treat as loss if armed.
        onDynamicBotVsResult('2p-round-loss');
      }
      _dbgLastStateA = nextState;
    }
    // Log B state changes (debug only — outcome taken from A to avoid double fire)
    if (stateB !== _dbgLastStateB) {
      console.log(`[dual] B: ${_dbgLastStateB ?? '—'} → ${stateB}`);
      _dbgLastStateB = stateB;
    }

    // Log SC register changes (serial transfer activity on either side)
    const scA = emu.read_mem(0xFF02);
    const scB = emuB.read_mem(0xFF02);
    if (scA !== _dbgLastScA || scB !== _dbgLastScB) {
      console.log(`[link] A: ${_dbgSerialStr(emu)}  B: ${_dbgSerialStr(emuB)}`);
      _dbgLastScA = scA;
      _dbgLastScB = scB;
    }

    // Periodic snapshot every ~5s (300 frames)
    if (_dbgFrameCount % 300 === 0) {
      console.log(`[dual:f${_dbgFrameCount}] A=${nextState}  B=${stateB}`);
      console.log(`[link] A: ${_dbgSerialStr(emu)}  B: ${_dbgSerialStr(emuB)}`);
    }
  }

  if (botEnabled) {
    checkForPendingMisdropReplay();
    rememberSpawnFullState();
    updateBotStatus();
    // Auto-pause on first misdrop (solo mode only — dual mode plays on)
    const pauseReq = rustBot ? rustBot.consumePauseRequest() : (bot ? bot.consumePauseRequest() : false);
    if (!dualMode && pauseReq) {
      emulationPaused = true;
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      btnPause.textContent = "▶";
      btnPause.title = "Resume";
      btnPause.classList.add("paused");
    }
  }
  } // end while (_loopAccum >= TARGET_FRAME_MS)
}

// ── keyboard input + remapping ───────────────────────────────────────────────
// Game Boy buttons use KeyboardEvent.code (layout-independent physical keys).
// Hotkeys (palette/save/…) are remappable the same way. Esc stays fixed for menus.
const KEYBINDS_STORAGE_KEY = "gbmul_keybinds";

/** @typedef {'btn'|'hotkey'} KeybindKind */
/**
 * @type {ReadonlyArray<{
 *   id: string,
 *   label: string,
 *   kind: KeybindKind,
 *   btn?: number,
 *   defaultCode: string,
 * }>}
 */
const KEYBIND_DEFS = [
  { id: "up",      label: "D-Pad Up",      kind: "btn", btn: 4, defaultCode: "ArrowUp" },
  { id: "down",    label: "D-Pad Down",    kind: "btn", btn: 5, defaultCode: "ArrowDown" },
  { id: "left",    label: "D-Pad Left",    kind: "btn", btn: 6, defaultCode: "ArrowLeft" },
  { id: "right",   label: "D-Pad Right",   kind: "btn", btn: 7, defaultCode: "ArrowRight" },
  { id: "a",       label: "A",             kind: "btn", btn: 0, defaultCode: "KeyX" },
  { id: "b",       label: "B",             kind: "btn", btn: 1, defaultCode: "KeyZ" },
  { id: "start",   label: "Start",         kind: "btn", btn: 3, defaultCode: "Enter" },
  { id: "select",  label: "Select",        kind: "btn", btn: 2, defaultCode: "Backspace" },
  { id: "palette", label: "Cycle palette", kind: "hotkey", defaultCode: "KeyP" },
  { id: "save",    label: "Save state",    kind: "hotkey", defaultCode: "KeyS" },
  { id: "load",    label: "Load state",    kind: "hotkey", defaultCode: "KeyL" },
  { id: "reset",   label: "Reset",         kind: "hotkey", defaultCode: "KeyR" },
  { id: "bot",     label: "Toggle bot",    kind: "hotkey", defaultCode: "KeyB" },
];

const KEYBIND_DEFAULTS = Object.fromEntries(
  KEYBIND_DEFS.map((d) => [d.id, d.defaultCode])
);

/** @type {Record<string, string>} action id → KeyboardEvent.code */
let keyBinds = { ...KEYBIND_DEFAULTS };

/** @type {Record<string, number>} code → GB button index */
let KEY_MAP = {};

/** @type {Record<string, string>} code → hotkey action id */
let HOTKEY_MAP = {};

/** Action id currently waiting for a key press, or null. */
let _kbListeningId = null;
/** True while a capture-phase key listener is attached for rebinding. */
let _kbCaptureAttached = false;

function formatKeyCode(code) {
  if (!code) return "—";
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5);
  if (code === "Escape") return "Esc";
  if (code === "Backspace") return "Backspace";
  if (code === "Enter") return "Enter";
  if (code === "Space") return "Space";
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  if (code.startsWith("Shift")) return code;
  if (code.startsWith("Control")) return code.replace("Control", "Ctrl");
  if (code.startsWith("Alt")) return code;
  if (code.startsWith("Meta")) return code;
  return code;
}

function rebuildKeyMaps() {
  KEY_MAP = {};
  HOTKEY_MAP = {};
  for (const def of KEYBIND_DEFS) {
    const code = keyBinds[def.id] || def.defaultCode;
    if (def.kind === "btn" && def.btn !== undefined) {
      KEY_MAP[code] = def.btn;
    } else if (def.kind === "hotkey") {
      HOTKEY_MAP[code] = def.id;
    }
  }
}

function loadKeyBinds() {
  keyBinds = { ...KEYBIND_DEFAULTS };
  try {
    const raw = localStorage.getItem(KEYBINDS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const def of KEYBIND_DEFS) {
      const c = parsed[def.id];
      if (typeof c === "string" && c.length > 0 && c !== "Escape") {
        keyBinds[def.id] = c;
      }
    }
  } catch (_) { /* keep defaults */ }
}

function saveKeyBinds() {
  try {
    localStorage.setItem(KEYBINDS_STORAGE_KEY, JSON.stringify(keyBinds));
  } catch (_) { /* quota / private mode */ }
}

function isModifierOnlyCode(code) {
  return (
    code === "ShiftLeft" || code === "ShiftRight" ||
    code === "ControlLeft" || code === "ControlRight" ||
    code === "AltLeft" || code === "AltRight" ||
    code === "MetaLeft" || code === "MetaRight"
  );
}

function detachKeybindCapture() {
  if (!_kbCaptureAttached) return;
  window.removeEventListener("keydown", onKeybindCaptureKey, true);
  window.removeEventListener("keyup", onKeybindCaptureKey, true);
  _kbCaptureAttached = false;
}

function attachKeybindCapture() {
  if (_kbCaptureAttached) return;
  // Capture on window so we win over focused <button> Space/Enter activation
  // and any other document-level game handlers.
  window.addEventListener("keydown", onKeybindCaptureKey, true);
  window.addEventListener("keyup", onKeybindCaptureKey, true);
  _kbCaptureAttached = true;
}

/**
 * Capture-phase rebind handler. Completes on the first non-modifier keydown.
 * keyup is only swallowed so Space/Enter don't synthesize a click that
 * re-enters listen mode on the (recreated) bind button.
 */
function onKeybindCaptureKey(e) {
  if (!_kbListeningId) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  if (e.type === "keyup") return;

  if (e.code === "Escape") {
    cancelKeybindListen();
    return;
  }
  if (isModifierOnlyCode(e.code)) return;
  if (e.repeat) return;

  const actionId = _kbListeningId;
  // Leave listen mode *before* mutating binds / re-rendering.
  cancelKeybindListen();
  setKeyBind(actionId, e.code);
}

function setKeyBind(actionId, code) {
  if (!actionId || !code || code === "Escape") return false;
  // One physical key → one action: free the code from any other binding.
  for (const def of KEYBIND_DEFS) {
    if (def.id !== actionId && keyBinds[def.id] === code) {
      keyBinds[def.id] = KEYBIND_DEFAULTS[def.id];
      // If default also collides with the new bind target, leave it until user fixes.
      if (keyBinds[def.id] === code) {
        keyBinds[def.id] = "";
      }
    }
  }
  keyBinds[actionId] = code;
  // Repair empty slots by restoring defaults (conflict shown in UI if still shared).
  for (const def of KEYBIND_DEFS) {
    if (!keyBinds[def.id]) {
      keyBinds[def.id] = def.defaultCode;
    }
  }
  rebuildKeyMaps();
  saveKeyBinds();
  renderKeybindTable();
  return true;
}

function resetKeyBinds() {
  cancelKeybindListen();
  keyBinds = { ...KEYBIND_DEFAULTS };
  rebuildKeyMaps();
  saveKeyBinds();
  renderKeybindTable();
}

function codesInUse() {
  const m = new Map(); // code → [action ids]
  for (const def of KEYBIND_DEFS) {
    const c = keyBinds[def.id];
    if (!c) continue;
    if (!m.has(c)) m.set(c, []);
    m.get(c).push(def.id);
  }
  return m;
}

function cancelKeybindListen() {
  _kbListeningId = null;
  detachKeybindCapture();
  document.querySelectorAll("#kb-map-body .kb-bind-btn.listening").forEach((el) => {
    el.classList.remove("listening");
    el.textContent = formatKeyCode(keyBinds[el.dataset.action]);
  });
}

function startKeybindListen(actionId, btnEl) {
  if (_kbListeningId === actionId) {
    cancelKeybindListen();
    return;
  }
  cancelKeybindListen();
  _kbListeningId = actionId;
  // Blur so Space/Enter don't activate the button after the bind keystroke.
  if (btnEl && typeof btnEl.blur === "function") btnEl.blur();
  if (document.activeElement && document.activeElement !== document.body) {
    try { document.activeElement.blur(); } catch (_) { /* ignore */ }
  }
  btnEl.classList.add("listening");
  btnEl.textContent = "Press key…";
  attachKeybindCapture();
}

function renderKeybindTable() {
  const tbody = document.getElementById("kb-map-body");
  if (!tbody) return;
  const usage = codesInUse();
  tbody.replaceChildren();
  for (const def of KEYBIND_DEFS) {
    const tr = document.createElement("tr");
    const tdA = document.createElement("td");
    tdA.textContent = def.label;
    const tdK = document.createElement("td");
    const btn = document.createElement("button");
    btn.type = "button";
    // Avoid Space/Enter activating a focused bind button during rebind.
    btn.tabIndex = -1;
    btn.className = "kb-bind-btn";
    btn.dataset.action = def.id;
    const code = keyBinds[def.id];
    btn.textContent = formatKeyCode(code);
    const owners = usage.get(code) || [];
    if (owners.length > 1) btn.classList.add("conflict");
    if (_kbListeningId === def.id) {
      btn.classList.add("listening");
      btn.textContent = "Press key…";
    }
    // pointerdown: enter listen mode before focus settles on the button.
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startKeybindListen(def.id, btn);
    });
    // Still block click activation (keyboard / accessibility paths).
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    tdK.appendChild(btn);
    tr.appendChild(tdA);
    tr.appendChild(tdK);
    tbody.appendChild(tr);
  }
}

function codeIsBoundToBtn(code, btnIndex) {
  return KEY_MAP[code] === btnIndex;
}

function codeIsHotkey(code, actionId) {
  return HOTKEY_MAP[code] === actionId;
}

loadKeyBinds();
rebuildKeyMaps();
renderKeybindTable();
document.getElementById("kb-reset-btn")?.addEventListener("click", () => {
  resetKeyBinds();
});

/**
 * Dual local 2P: side B must leave splash with the human, otherwise the link
 * handshake never starts and Start on the title screen bounces back to splash.
 * Keyboard already did this; touch controls must too (mobile Safari/Chrome).
 * Start = button index 3.
 */
function maybeMirrorStartToSideB(down) {
  if (!dualMode || !emuB) return;
  if (down) {
    if (_currentStateB === 'splash') emuB.key_down(3);
  } else {
    // Always release — B may have left splash mid-hold.
    emuB.key_up(3);
  }
}

// ── In-device menu (SDL-style overlay on the GB screen) ───────────────────────
// Simplified user settings. Structure mirrors gbmul-sdl2 MAIN / MISC / ABOUT.
// The edge panel (#key-panel) is the "advanced menu" for full settings/debug.
// Cuterminus lowercase glyphs (bitmap font looks better at 8px than CAPS).
const IDM_MAIN = ["save", "load", "reset", "a.load", "a.save", "link", "misc", "quit"];
const IDM_MISC = ["fps", "shot", "palette", "bot", "sound", "tc", "about", "back"];
const IDM_ABOUT = ["back"];
// level 3 = WebGBLink (host / join / qr / cancel). Labels depend on link state.
const IDM_CHECKABLE = new Set(["a.load", "a.save", "fps", "bot", "sound"]);
// level 6 = TC layout adjust (D-pad / A-B positions).
const IDM_TC = ["dpadB", "dpadL", "dpadS", "abB", "abR", "abS", "abA", "abG", "save", "back"];

const AUTO_SAVE_KEY = "gbmul_auto_save";
let autoSaveOnQuit = localStorage.getItem(AUTO_SAVE_KEY) === "1";

const idmRoot   = document.getElementById("idm");
const idmList   = document.getElementById("idm-list");
const idmAbout  = document.getElementById("idm-about");
const idmBuild  = document.getElementById("idm-build");

const idm = {
  open: false,
  // 0=main, 1=misc, 2=about, 3=link, 4=qr, 5=join room keyboard, 6=TC layout
  level: 0,
  selected: 0,
  /** Emulation pause state before the menu opened (restored on close). */
  _prevPaused: false,
  /** Level-5 join: typed room code (A–Z0–9, max 6) + keyboard focus index. */
  joinCode: "",
  joinKey: 0,
  /** Level-6 TC layout: preview values indexed by sel. */
  tcVals: null,
};

/** Dynamic WebGBLink submenu items (short Cuterminus labels). */
function idmLinkItems() {
  if (webgblink?.isConnected) {
    return ["status", "qr", "copy", "drop", "back"];
  }
  if (webgblink?.isHost && wglRoomId) {
    return ["hosting", "qr", "copy", "cancel", "back"];
  }
  if (webgblink?.isGuest) {
    return ["joining", "cancel", "back"];
  }
  return ["host", "join", "back"];
}

function idmItems() {
  if (idm.level === 1) return IDM_MISC;
  if (idm.level === 2) return IDM_ABOUT;
  if (idm.level === 3) return idmLinkItems();
  // Levels 4 (QR) and 5 (join keyboard) are full-screen canvas UIs — no list items.
  if (idm.level === 4 || idm.level === 5) return [];
  if (idm.level === 6) return IDM_TC;
  return IDM_MAIN;
}

/** Display label for a menu item (Cuterminus, keep short ≤ ~10 chars). */
function idmLabel(item) {
  switch (item) {
    case "hosting": return wglRoomId ? "room " + String(wglRoomId).slice(0, 6) : "hosting";
    case "joining": return wglRoomId ? "join " + String(wglRoomId).slice(0, 6) : "joining";
    case "status":  return webgblink?.isConnected ? "linked" : "status";
    case "drop":    return "drop";
    case "tc":      return "tc layout";
    case "dpadB":   return "dpad ⋅" + (idm.tcVals?.dpadB ?? "–");
    case "dpadL":   return "dpad ←" + (idm.tcVals?.dpadL ?? "–");
    case "dpadS":   return "dpad sz " + (idm.tcVals?.dpadS ?? "–");
    case "abB":     return "a/b ⋅" + (idm.tcVals?.abB ?? "–");
    case "abR":     return "a/b →" + (idm.tcVals?.abR ?? "–");
    case "abS":     return "a/b sz " + (idm.tcVals?.abS ?? "–");
    case "abA":     return "a/b ∠" + (idm.tcVals?.abA ?? "–") + "°";
    case "abG":     return "a/b gap " + (idm.tcVals?.abG ?? "–");
    case "save":    return "save";
    default:        return item;
  }
}

function idmIsChecked(item) {
  switch (item) {
    case "a.load": return !!restoreCheck?.checked;
    case "a.save": return autoSaveOnQuit;
    case "fps":    return !!fpsCheck?.checked;
    case "bot":    return !!botCheck?.checked;
    case "sound":  return !!soundCheck?.checked;
    default:       return false;
  }
}

/** Rough 4-shade preview for the current palette (CSS only — not exact GB colours). */
function idmPaletteSwatches() {
  // Cycle through a few known looks; index just shifts which set is shown.
  const sets = [
    ["#e0f8d0", "#88c070", "#346856", "#081820"], // DMG-ish
    ["#f8f8f8", "#a8a8a8", "#505050", "#000000"], // greyscale
    ["#fce4ec", "#f48fb1", "#ad1457", "#4a0028"], // pink
    ["#e3f2fd", "#64b5f6", "#1565c0", "#0d1b2a"], // blue
    ["#fff8e1", "#ffd54f", "#f9a825", "#3e2723"], // amber
    ["#f3e5f5", "#ce93d8", "#7b1fa2", "#1a0033"], // purple
  ];
  return sets[paletteIndex % sets.length];
}

function idmRender() {
  if (!idmRoot || !idmList) return;
  const items = idmItems();
  if (items.length && idm.selected >= items.length) idm.selected = 0;

  if (idmAbout) idmAbout.hidden = idm.level !== 2;
  if (idmBuild && idm.level === 2) {
    idmBuild.textContent = GBMUL_BUILD.stamp || "—";
  }

  idmList.replaceChildren();
  // Level 4 QR / level 5 join keyboard: canvas composite only (no DOM list).
  if (idm.level === 4 || idm.level === 5) {
    if (idm.open) idmRedrawShaded();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const li = document.createElement("li");
    li.className = "idm-item" + (i === idm.selected ? " selected" : "");
    li.setAttribute("role", "menuitem");
    li.dataset.index = String(i);

    const arrow = document.createElement("span");
    arrow.className = "idm-arrow";
    arrow.textContent = ">";
    li.appendChild(arrow);

    const label = document.createElement("span");
    label.className = "idm-label";
    label.textContent = idmLabel(item);
    li.appendChild(label);

    if (IDM_CHECKABLE.has(item)) {
      const cb = document.createElement("span");
      cb.className = "idm-check" + (idmIsChecked(item) ? " on" : "");
      cb.setAttribute("aria-hidden", "true");
      li.appendChild(cb);
    } else if (item === "palette") {
      const sw = document.createElement("span");
      sw.className = "idm-swatch";
      sw.setAttribute("aria-hidden", "true");
      for (const c of idmPaletteSwatches()) {
        const cell = document.createElement("i");
        cell.style.background = c;
        sw.appendChild(cell);
      }
      li.appendChild(sw);
    }

    li.addEventListener("click", (ev) => {
      ev.preventDefault();
      idm.selected = i;
      idmConfirm();
    });
    idmList.appendChild(li);
  }
  if (idm.open) {
    if (romSplashOpen) romSplashRedraw();
    else idmRedrawShaded();
  }
}

function idmSetOpen(open) {
  if (!idmRoot) return;
  if (open === idm.open) {
    if (open) idmRender();
    return;
  }
  idm.open = open;
  idmIsOpen = open;
  // ROM splash hit-layer must not steal menu clicks while the menu is up.
  document.body.classList.toggle("idm-open", open);
  romOverlay?.classList.toggle("idm-open", open);
  if (btnBrowseRom) {
    btnBrowseRom.disabled = !!open;
    btnBrowseRom.tabIndex = open ? -1 : 0;
  }
  syncRomDropzoneHit();
  if (open) {
    idm.level = 0;
    idm.selected = 0;
    idm._prevPaused = emulationPaused;
    // Pause the game while the in-device menu is open (SDL behaviour).
    if (!emulationPaused) {
      emulationPaused = true;
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      if (btnPause) {
        btnPause.textContent = "▶";
        btnPause.title = "Resume";
        btnPause.classList.add("paused");
      }
    }
    idmRoot.hidden = false;
    idmRoot.setAttribute("aria-hidden", "false");
    idmRoot.classList.add("open");
    idmRender();
    // Paint menu into the shaded frame immediately (emulator is paused).
    // On the ROM splash there is no game loop — force a splash+menu redraw.
    if (romSplashOpen) romSplashRedraw();
    else idmRedrawShaded();
  } else {
    idmRoot.classList.remove("open");
    idmRoot.setAttribute("aria-hidden", "true");
    idmRoot.hidden = true;
    idm.level = 0;
    idm.selected = 0;
    idm.tcVals = null;
    idmTcHideGhost();
    _idmQr = null;
    idm.joinCode = "";
    idm.joinKey = 0;
    // Restore prior pause state and re-arm the frame clock cleanly.
    // startLoop() will draw the clean game frame (no menu composite).
    if (romSplashOpen) {
      romSplashRedraw();
    } else if (!idm._prevPaused && emulationPaused) {
      emulationPaused = false;
      if (btnPause) {
        btnPause.textContent = "⏸";
        btnPause.title = "Pause";
        btnPause.classList.remove("paused");
      }
      startLoop();
    } else {
      // Was already paused: still need one clean redraw without the menu.
      idmRedrawShaded();
    }
  }
}

function idmShow() { idmSetOpen(true); }
function idmHide() { idmSetOpen(false); }
function idmToggle() { idmSetOpen(!idm.open); }

// Phone-friendly open: tap “GBmul” under the main screen (same as Esc).
const idmTrigger = document.getElementById("idm-trigger");
if (idmTrigger) {
  idmTrigger.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    idmToggle();
  });
}

function idmNavUp() {
  if (!idm.open || idm.level === 4 || idm.level === 5) return;
  const n = idmItems().length;
  if (!n) return;
  idm.selected = (idm.selected - 1 + n) % n;
  idmRender();
}
function idmNavDown() {
  if (!idm.open || idm.level === 4 || idm.level === 5) return;
  const n = idmItems().length;
  if (!n) return;
  idm.selected = (idm.selected + 1) % n;
  idmRender();
}

/** Pop one level (join/qr→link, about→misc, link→main, misc→main, main→close). Returns true if closed. */
function idmNavBack() {
  if (!idm.open) return true;
  if (idm.level === 5) {
    idmLeaveJoinView();
    return false;
  }
  if (idm.level === 4) {
    idmLeaveQrView();
    return false;
  }
  if (idm.level === 2) {
    idm.level = 1;
    idm.selected = IDM_MISC.indexOf("about");
    if (idm.selected < 0) idm.selected = 0;
    idmRender();
    return false;
  }
  if (idm.level === 3) {
    idm.level = 0;
    idm.selected = IDM_MAIN.indexOf("link");
    if (idm.selected < 0) idm.selected = 0;
    idmRender();
    return false;
  }
  if (idm.level === 6) {
    idmTcExit();
    return false;
  }
  if (idm.level === 1) {
    idm.level = 0;
    idm.selected = IDM_MAIN.indexOf("misc");
    if (idm.selected < 0) idm.selected = 0;
    idmRender();
    return false;
  }
  idmHide();
  return true;
}

function idmToggleCheckbox(item) {
  switch (item) {
    case "a.load":
      if (restoreCheck) {
        restoreCheck.checked = !restoreCheck.checked;
        restoreCheck.dispatchEvent(new Event("change"));
      }
      break;
    case "a.save":
      autoSaveOnQuit = !autoSaveOnQuit;
      localStorage.setItem(AUTO_SAVE_KEY, autoSaveOnQuit ? "1" : "0");
      break;
    case "fps":
      if (fpsCheck) {
        fpsCheck.checked = !fpsCheck.checked;
        fpsCheck.dispatchEvent(new Event("change"));
      }
      break;
    case "bot":
      if (botCheck) {
        // Dual mode refuses uncheck — still attempt for visual parity; dual policy re-checks.
        botCheck.checked = !botCheck.checked;
        botCheck.dispatchEvent(new Event("change"));
      }
      break;
    case "sound":
      if (soundCheck) {
        soundCheck.checked = !soundCheck.checked;
        soundCheck.dispatchEvent(new Event("change"));
      }
      break;
  }
  idmRender();
}

function idmConfirm() {
  if (!idm.open) return;
  const item = idmItems()[idm.selected];
  if (!item) return;
  console.log(`[idm] confirm ${item}`);

  switch (item) {
    case "save":
      if (idm.level === 6) { idmTcSave(); break; }
      saveState();
      idmHide();
      break;
    case "load":
      loadState();
      idmHide();
      break;
    case "reset":
      resetEmu();
      idmHide();
      break;
    case "a.load":
    case "a.save":
    case "fps":
    case "bot":
    case "sound":
      idmToggleCheckbox(item);
      break;
    case "palette":
      cyclePalette();
      idmRender();
      break;
    case "shot": {
      // Screenshot of the main GB canvas (PNG download).
      const c = document.getElementById("screen-gl")?.classList.contains("shader-active")
        ? document.getElementById("screen-gl")
        : document.getElementById("screen");
      try {
        const url = c.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = url;
        a.download = `gbmul-${Date.now()}.png`;
        a.click();
        setStatus("Screenshot saved.");
      } catch (err) {
        setStatus("Screenshot failed: " + err, true);
      }
      idmHide();
      break;
    }
    case "misc":
      idm.level = 1;
      idm.selected = 0;
      idmRender();
      break;
    case "about":
      idm.level = 2;
      idm.selected = 0;
      idmRender();
      break;
    case "link":
      idm.level = 3;
      idm.selected = 0;
      idmRender();
      break;
    case "tc":
      idmEnterTcLayout();
      break;
    // ── WebGBLink submenu (level 3) ────────────────────────────────────────
    case "host":
      // Stay in menu; after room opens jump to full-width QR view.
      wglHost().then(() => {
        if (wglRoomId) idmShowQrView(wglRoomId);
        else idmRender();
      }).catch(() => { idmRender(); });
      break;
    case "join":
      // Full-screen in-device keyboard (stays under the DMG shader).
      idmShowJoinView();
      break;
    case "qr":
      if (wglRoomId) idmShowQrView(wglRoomId);
      else setStatus("Host a game first to get a QR.", true);
      break;
    case "copy":
      if (wglRoomId) wglCopyLink(wglRoomId);
      else setStatus("No room to copy.", true);
      break;
    case "cancel":
    case "drop":
      wglDisconnect();
      idmRender();
      break;
    case "hosting":
    case "joining":
    case "status":
      // Informational rows — open in-device QR when a room exists.
      if (wglRoomId) idmShowQrView(wglRoomId);
      break;
    case "back":
      idmNavBack();
      break;
    case "dpadB": case "dpadL": case "dpadS":
    case "abB": case "abR": case "abS": case "abA": case "abG":
      // Selected in TC level — left/right adjusts, A just re-renders.
      idmRender();
      break;
    case "quit":
      if (autoSaveOnQuit && emu) saveState();
      idmHide();
      // Web has no process exit — park on the ROM picker.
      showRomOverlay();
      setStatus("Quit — drop a ROM to play again.");
      break;
    default:
      break;
  }
}

// ── TC layout in-device menu ──────────────────────────────────────────────────
const TC_LAYOUT_KEYS = ["dpadB", "dpadL", "dpadS", "abB", "abR", "abS", "abA", "abG"];
const TC_LAYOUT_DEFAULTS = { dpadB: 20, dpadL: 12, dpadS: 52, abB: 82, abR: 12, abS: 68, abA: 29, abG: 21 };
const TC_LAYOUT_STEPS = { dpadB: 2, dpadL: 2, dpadS: 2, abB: 2, abR: 2, abS: 2, abA: 1, abG: 1 };
const TC_LAYOUT_MIN = { dpadB: 0, dpadL: 0, dpadS: 28, abB: 0, abR: 0, abS: 28, abA: 0, abG: 0 };
const TC_LAYOUT_MAX = { dpadB: 150, dpadL: 150, dpadS: 72, abB: 150, abR: 150, abS: 80, abA: 45, abG: 40 };

function idmBuildTcGhost() {
  let ghost = document.getElementById("tc-ghost");
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.id = "tc-ghost";
    ghost.className = "tc-ghost";
    ghost.hidden = true;
    ghost.setAttribute("aria-hidden", "true");
    document.body.appendChild(ghost);
  }
  ghost.innerHTML = "";
  const dpad = document.createElement("div");
  dpad.className = "tc-ghost-dpad";
  dpad.innerHTML = "<div style='grid-column:2;grid-row:1;border-radius:10px 10px 0 0'>▲</div><div style='grid-column:1;grid-row:2;border-radius:10px 0 0 10px'>◀</div><div class=tc-ghost-dpad-center style='grid-column:2;grid-row:2;border-radius:0'></div><div style='grid-column:3;grid-row:2;border-radius:0 10px 10px 0'>▶</div><div style='grid-column:2;grid-row:3;border-radius:0 0 10px 10px'>▼</div>";
  ghost.appendChild(dpad);
  const ab = document.createElement("div");
  ab.className = "tc-ghost-ab";
  ab.innerHTML = "<div class=tc-ghost-ab-a>A</div><div class=tc-ghost-ab-b>B</div>";
  ghost.appendChild(ab);
}

function idmTcApplyGhost() {
  const ghost = document.getElementById("tc-ghost");
  if (!ghost) return;
  const v = idm.tcVals;
  ghost.style.setProperty("--tc-ghost-dpad-bottom", v.dpadB + "px");
  ghost.style.setProperty("--tc-ghost-dpad-left",   v.dpadL + "px");
  ghost.style.setProperty("--tc-ghost-dpad-size",    v.dpadS + "px");
  ghost.style.setProperty("--tc-ghost-ab-bottom",    v.abB + "px");
  ghost.style.setProperty("--tc-ghost-ab-right",     v.abR + "px");
  ghost.style.setProperty("--tc-ghost-ab-size",      v.abS + "px");
  ghost.style.setProperty("--tc-ghost-ab-angle",     v.abA + "deg");
  ghost.style.setProperty("--tc-ghost-ab-gap",       v.abG + "px");
}

function idmTcShowGhost() {
  const ghost = document.getElementById("tc-ghost");
  if (!ghost) return;
  idmBuildTcGhost();
  idmTcApplyGhost();
  ghost.hidden = false;
}

function idmTcHideGhost() {
  const ghost = document.getElementById("tc-ghost");
  if (!ghost) return;
  ghost.hidden = true;
  ghost.innerHTML = "";
}

function idmEnterTcLayout() {
  idm.level = 6;
  idm.selected = 0;
  const root = document.documentElement;
  const saved = JSON.parse(localStorage.getItem("gbmul_tc_layout") || "{}");
  idm.tcVals = {};
  for (const k of TC_LAYOUT_KEYS) {
    const v = saved[k] ?? TC_LAYOUT_DEFAULTS[k];
    idm.tcVals[k] = v;
  }
  idmBuildTcGhost();
  idmTcApplyGhost();
  idmTcShowGhost();
  idmRender();
}

function idmTcExit() {
  idmTcHideGhost();
  idm.tcVals = null;
  idm.level = 1;
  idm.selected = IDM_MISC.indexOf("tc");
  if (idm.selected < 0) idm.selected = 0;
  idmRender();
}

function idmTcAdjust(dir) {
  const item = idmItems()[idm.selected];
  if (!TC_LAYOUT_KEYS.includes(item)) return;
  const v = idm.tcVals[item] + dir * (TC_LAYOUT_STEPS[item] || 2);
  idm.tcVals[item] = Math.max(TC_LAYOUT_MIN[item], Math.min(TC_LAYOUT_MAX[item], v));
  idmTcApplyGhost();
  idmRender();
}

function idmTcSave() {
  const root = document.documentElement;
  const saved = JSON.parse(localStorage.getItem("gbmul_tc_layout") || "{}");
  const v = idm.tcVals;
  const propMap = { dpadB:"dpad-bottom", dpadL:"dpad-left", dpadS:"dpad-size",
                    abB:"ab-bottom", abR:"ab-right", abS:"ab-size", abA:"ab-angle", abG:"ab-gap" };
  const unitMap = { abA:"deg" };
  for (const k of TC_LAYOUT_KEYS) {
    saved[k] = v[k];
    root.style.setProperty("--tc-" + propMap[k], v[k] + (unitMap[k] || "px"));
  }
  localStorage.setItem("gbmul_tc_layout", JSON.stringify(saved));
  idmTcHideGhost();
  idm.tcVals = null;
  setStatus("TC layout saved");
  idm.level = 1;
  idm.selected = 0;
  idmRender();
}

/**
 * Handle a Game Boy button while the in-device menu is open.
 * Returns true if the input was consumed (must not reach the emulator).
 */
function idmHandlePad(btn, down) {
  if (!idm.open || !down) return idm.open;
  // Join room keyboard: D-pad moves cursor, A types, B deletes / back.
  if (idm.level === 5) {
    return idmJoinHandlePad(btn);
  }
  // QR full-screen view: any button / Start / A / B / Select dismisses to link menu.
  if (idm.level === 4) {
    idmLeaveQrView();
    return true;
  }
  // 4=Up 5=Down 0=A 1=B 2=Select 3=Start
  if (btn === 4) { idmNavUp(); return true; }
  if (btn === 5) { idmNavDown(); return true; }
  if (btn === 0 || btn === 3) { idmConfirm(); return true; }
  if (btn === 1 || btn === 2) { idmNavBack(); return true; }
  // Left/Right: adjust TC value when in TC layout level.
  if (idm.level === 6 && (btn === 6 || btn === 7)) {
    idmTcAdjust(btn === 6 ? -1 : 1);
    return true;
  }
  return true;
}

// Dim click closes the menu (like tapping outside).
idmRoot?.querySelector(".idm-dim")?.addEventListener("click", () => idmHide());

document.addEventListener("click",      resumeAudio);
document.addEventListener("touchstart",  resumeAudio);

let lastEscTime = 0;

document.addEventListener("keydown", (e) => {
  resumeAudio();

  // Rebind is handled in capture phase (onKeybindCaptureKey). Skip game input.
  if (_kbListeningId) return;

  // Don't steal typing from form fields in the advanced menu.
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

  if (e.code === "Escape") {
    e.preventDefault();
    // Close QR / join overlays first (side-by-side share dialogs).
    const qrOv = document.getElementById("wgl-qr-overlay");
    const joinOv = document.getElementById("wgl-join-overlay");
    if (qrOv && !qrOv.hidden) { wglHideQrOverlay(); return; }
    if (joinOv && !joinOv.hidden) { wglHideJoinOverlay(); return; }
    const now = Date.now();
    // Double-Esc opens/closes the advanced (edge) menu — same as before.
    if (now - lastEscTime < 400) {
      lastEscTime = 0;
      if (idm.open) idmHide();
      const open = keyPanel.classList.toggle("open");
      keyPanel.setAttribute("aria-hidden", String(!open));
      localStorage.setItem("gbmul_panel_open", String(open));
      if (open) clearTimeout(burgerHideTimer); else resetBurgerTimer();
      return;
    }
    lastEscTime = now;
    // Single Esc: toggle in-device menu (or step back one level).
    if (idm.open) {
      idmNavBack();
    } else {
      // Close advanced panel first if it's open, otherwise open in-device.
      if (keyPanel.classList.contains("open")) {
        keyPanel.classList.remove("open");
        keyPanel.setAttribute("aria-hidden", "true");
        localStorage.setItem("gbmul_panel_open", "false");
        resetBurgerTimer();
      } else {
        idmShow();
      }
    }
    return;
  }

  // In-device menu captures pad + confirm keys (honours remapped bindings).
  // Route through idmHandlePad so join keyboard (level 5) gets Left/Right too.
  if (idm.open) {
    // Desktop convenience: type unbound letter/digit keys on the join screen.
    // Keys bound to A/B/D-pad/Start/Select stay pad actions (so X/Z still work as A/B).
    if (idm.level === 5) {
      if (e.key === "Backspace") {
        e.preventDefault();
        idmJoinDelete();
        return;
      }
      const ch = (e.key || "").toUpperCase();
      const isPadKey = [0, 1, 2, 3, 4, 5, 6, 7].some((b) => codeIsBoundToBtn(e.code, b));
      if (ch.length === 1 && IDM_JOIN_ALPHABET.includes(ch) && !isPadKey) {
        e.preventDefault();
        idmJoinAppend(ch);
        if (idm.joinCode.length === IDM_JOIN_CODE_LEN) {
          idm.joinKey = IDM_JOIN_KEY_OK;
          idmRender();
        }
        return;
      }
    }
    for (const b of [4, 5, 6, 7, 0, 1, 2, 3]) {
      if (codeIsBoundToBtn(e.code, b)) {
        e.preventDefault();
        idmHandlePad(b, true);
        return;
      }
    }
    // Swallow other game keys while menu is open.
    if (KEY_MAP[e.code] !== undefined) { e.preventDefault(); return; }
  }

  // ROM cart splash: Start / Select / A open the lid (no emu yet).
  if (romSplashOpen) {
    if (codeIsBoundToBtn(e.code, 3) || codeIsBoundToBtn(e.code, 2) || codeIsBoundToBtn(e.code, 0)) {
      e.preventDefault();
      romCartOpenLid();
      return;
    }
    if (KEY_MAP[e.code] !== undefined) { e.preventDefault(); return; }
  }

  if (!emu) return;
  const btn = KEY_MAP[e.code];
  if (btn !== undefined) { e.preventDefault(); emu.key_down(btn); }

  if (codeIsBoundToBtn(e.code, 3)) maybeMirrorStartToSideB(true);

  const hot = HOTKEY_MAP[e.code];
  if (hot === "palette") { e.preventDefault(); cyclePalette(); }
  else if (hot === "save") { e.preventDefault(); saveState(); }
  else if (hot === "load") { e.preventDefault(); loadState(); }
  else if (hot === "reset") { e.preventDefault(); resetEmu(); }
  else if (hot === "bot") {
    e.preventDefault();
    botCheck.checked = !botCheck.checked;
    botCheck.dispatchEvent(new Event("change"));
  }
});

document.addEventListener("keyup", (e) => {
  if (_kbListeningId) return;
  if (idm.open) {
    // Swallow pad releases so they don't leak into the emulator after close.
    if (KEY_MAP[e.code] !== undefined) { e.preventDefault(); return; }
  }
  if (romSplashOpen) {
    if (KEY_MAP[e.code] !== undefined) { e.preventDefault(); return; }
  }
  if (!emu) return;
  const btn = KEY_MAP[e.code];
  if (btn !== undefined) emu.key_up(btn);
  if (codeIsBoundToBtn(e.code, 3)) maybeMirrorStartToSideB(false);
});

// ── palette ──────────────────────────────────────────────────────────────────
function cyclePalette() {
  if (!emu) return;
  paletteIndex = (paletteIndex + 1) % GbEmu.palette_count();
  emu.set_palette(paletteIndex);
  localStorage.setItem("gbmul_palette", String(paletteIndex));
}
document.getElementById("btn-palette").addEventListener("click", cyclePalette);

// ── save / load state ────────────────────────────────────────────────────────
function saveState() {
  if (!emu) return;
  try {
    const bytes = emu.save_state();
    localStorage.setItem("gbmul_state", JSON.stringify(Array.from(bytes)));
    setStatus("State saved.");
  } catch (e) { setStatus("Save failed: " + e, true); }
}

function loadState() {
  if (!emu) return;
  const raw = localStorage.getItem("gbmul_state");
  if (!raw) { setStatus("No saved state found."); return; }
  try {
    const bytes = new Uint8Array(JSON.parse(raw));
    emu.load_state(bytes);
    // Re-seed the lines cache from VRAM immediately after restore.
    _cachedPanelLines = readLinesVRAM(emu);
    rustBotAfterStateRestore();
    window._prevPieceMinY = 255;
    clearMisdropSpawnCaptures();
    _lastGameState = null;
    _pendingState = null;
    _pendingStateCount = 0;
    _suppressSetupCommitFrames = 120;
    _suppressSetupCommitUntilLobby = true;
    _menuSetupSnapshot = null;
    setStatus("State loaded.");
  } catch (e) { setStatus("Load failed: " + e, true); }
}

// ── Lock audit log (survives reload — for MCP / false-negative debugging) ───
const LOCK_LOG_KEY = 'gbmul_lock_log';
const LOCK_LOG_MAX = 80;

function loadLockLog() {
  try {
    const raw = localStorage.getItem(LOCK_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function drainLockAuditToStorage() {
  if (!rustBot) return;
  const take = rustBot.takeLockAuditJson || rustBot.take_lock_audit_json;
  if (typeof take !== 'function') return;
  try {
    const json = take.call(rustBot);
    if (!json || json === '[]') return;
    const incoming = JSON.parse(json);
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    const merged = [...incoming, ...loadLockLog()].slice(0, LOCK_LOG_MAX);
    localStorage.setItem(LOCK_LOG_KEY, JSON.stringify(merged));
  } catch (e) {
    console.warn('[lock-log] drain failed', e);
  }
}

// ── Game-state probe (calibrate rocket / high-score / post-game screens) ───
const STATE_PROBE_LS_KEY = 'gbmul_state_probe_log';
let _stateProbeActive = false;
let _stateProbeLog = [];
let _stateProbeFrame = 0;
let _stateProbeLastState = null;
let _stateProbeLastFp = '';
let _stateProbeSampleEvery = 0;
let _stateProbeMaxEntries = 2000;

function stateProbeAutoEnabled() {
  return localStorage.getItem('gbmul_auto_state_probe') !== '0';
}

function stateProbePersist() {
  try {
    sessionStorage.setItem(STATE_PROBE_LS_KEY, JSON.stringify(_stateProbeLog.slice(-_stateProbeMaxEntries)));
  } catch { /* quota */ }
}

function stateProbeRestore() {
  try {
    const raw = sessionStorage.getItem(STATE_PROBE_LS_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      _stateProbeLog = parsed;
      return parsed.length;
    }
  } catch { /* ignore */ }
  return 0;
}

function captureStateProbeSnapshot(emuRef, badgeState) {
  const raw = detectGameState(emuRef);
  return {
    badge: badgeState,
    raw,
    c000: emuRef.read_mem(0xC000),
    c001: emuRef.read_mem(0xC001),
    c201: emuRef.read_mem(0xC201),
    c204: emuRef.read_mem(0xC204),
    cffc: emuRef.read_mem(0xCFFC),
    c0c6: emuRef.read_mem(0xC0C6), // wScoreboardState (name-entry / post-game)
    c0c7: emuRef.read_mem(0xC0C7),
    e1: emuRef.read_mem(0xFFE1),
    ff86: emuRef.read_mem(0xFF86),
    ffa9: emuRef.read_mem(0xFFA9),
    vram9885: emuRef.read_mem(0x9885),
    vram990f: emuRef.read_mem(0x990F),
    score: readScoreBcd(emuRef),
    statsActive: statsTracker._active,
    statsGameType: statsTracker._gameType,
    statsPeakScore: statsTracker._peakScore,
    statsPieces: statsTracker._pieces,
  };
}

function stateProbeFingerprint(snap) {
  const hx = (v) => v.toString(16).toUpperCase().padStart(2, '0');
  return [
    `C000=${hx(snap.c000)}`,
    `C001=${hx(snap.c001)}`,
    `C201=${hx(snap.c201)}`,
    `C204=${hx(snap.c204)}`,
    `CFFC=${hx(snap.cffc)}`,
    `C0C6=${hx(snap.c0c6)}`,
    `E1=${hx(snap.e1)}`,
    `VRAM85=${hx(snap.vram9885)}`,
    `FF86=${hx(snap.ff86)}`,
  ].join(' ');
}

function stateProbePush(emuRef, badgeState, reason) {
  const snap = captureStateProbeSnapshot(emuRef, badgeState);
  const fp = stateProbeFingerprint(snap);
  const entry = {
    t: Date.now(),
    frame: _stateProbeFrame,
    reason,
    fp,
    ...snap,
  };
  _stateProbeLog.push(entry);
  if (_stateProbeLog.length > _stateProbeMaxEntries) {
    _stateProbeLog.shift();
  }
  stateProbePersist();
  // console.info(
  //   `[state-probe] ${reason} badge=${badgeState} raw=${snap.raw} ${fp} ` +
  //   `score=${snap.score} C0C6=0x${snap.c0c6.toString(16)}`
  // );
  return entry;
}

function stateProbeTick(emuRef, badgeState) {
  if (!_stateProbeActive || !emuRef) return;
  const snap = captureStateProbeSnapshot(emuRef, badgeState);
  const fp = stateProbeFingerprint(snap);
  const stateChanged = badgeState !== _stateProbeLastState;
  const fpChanged = fp !== _stateProbeLastFp;
  const periodic = _stateProbeSampleEvery > 0
    && (_stateProbeFrame % _stateProbeSampleEvery === 0);
  if (stateChanged) {
    stateProbePush(emuRef, badgeState, 'state-change');
  } else if (fpChanged) {
    stateProbePush(emuRef, badgeState, 'fp-change');
  } else if (periodic) {
    stateProbePush(emuRef, badgeState, 'periodic');
  }
  _stateProbeLastState = badgeState;
  _stateProbeLastFp = fp;
  _stateProbeFrame++;
}

function startStateProbe(opts = {}) {
  _stateProbeActive = true;
  _stateProbeLog = [];
  _stateProbeFrame = 0;
  _stateProbeLastState = null;
  _stateProbeLastFp = '';
  _stateProbeSampleEvery = Math.max(0, Number(opts.sampleEvery) || 0);
  _stateProbeMaxEntries = Math.max(50, Number(opts.maxEntries) || 800);
  console.info(
    '[state-probe] started' +
    (_stateProbeSampleEvery ? ` sampleEvery=${_stateProbeSampleEvery} frames` : ' (transitions only)') +
    ' — play through top-out → rocket → name entry; then __gbmul.summarizeStateProbe()'
  );
  if (emu) stateProbePush(emu, _lastGameState ?? 'unknown', 'start');
}

function stopStateProbe() {
  if (_stateProbeActive && emu) {
    stateProbePush(emu, _lastGameState ?? 'unknown', 'stop');
  }
  _stateProbeActive = false;
  console.info(`[state-probe] stopped — ${_stateProbeLog.length} entries captured`);
  return _stateProbeLog.length;
}

function getStateProbeLog() {
  return _stateProbeLog.slice();
}

function clearStateProbeLog() {
  _stateProbeLog = [];
  _stateProbeFrame = 0;
  _stateProbeLastState = null;
  _stateProbeLastFp = '';
  try { sessionStorage.removeItem(STATE_PROBE_LS_KEY); } catch { /* ignore */ }
}

function summarizeStateProbe() {
  const groups = new Map();
  for (const e of _stateProbeLog) {
    const key = `${e.fp} | badge=${e.badge} raw=${e.raw}`;
    if (!groups.has(key)) {
      groups.set(key, {
        fp: e.fp,
        badge: e.badge,
        raw: e.raw,
        count: 0,
        scoreMin: e.score,
        scoreMax: e.score,
        reasons: new Set(),
        sample: e,
      });
    }
    const g = groups.get(key);
    g.count++;
    g.scoreMin = Math.min(g.scoreMin, e.score);
    g.scoreMax = Math.max(g.scoreMax, e.score);
    g.reasons.add(e.reason);
  }
  const rows = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => ({
      fp: g.fp,
      badge: g.badge,
      raw: g.raw,
      count: g.count,
      scoreRange: g.scoreMin === g.scoreMax ? g.scoreMin : `${g.scoreMin}-${g.scoreMax}`,
      reasons: [...g.reasons],
      c000: g.sample.c000,
      c201: g.sample.c201,
      c204: g.sample.c204,
      cffc: g.sample.cffc,
      vram9885: g.sample.vram9885,
    }));
  console.table(rows);
  return rows;
}

function exportStateProbeJson() {
  const json = JSON.stringify(_stateProbeLog, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `state-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  return _stateProbeLog.length;
}

function installGbmulDebugBridge() {
  window.__gbmul = {
    getEmu: () => (dualMode && emuB ? emuB : emu),
    getBot: () => rustBot,
    getMenuNavDebug: () => {
      const target = _menuRestoreTarget || captureMenuRestoreTarget();
      const snap = emu ? readMenuNavSnapshot(emu, target) : null;
      return {
        autoMenuNav,
        target,
        sequence: _menuNavSequence,
        stepIdx: _menuNavStepIdx,
        awaitingOutcome: _menuNavAwaitingOutcome,
        stepCooldown: _menuNavStepCooldown,
        pastA: _menuNavPastA,
        sequenceText: formatMenuNavSequence(_menuNavSequence) + '<Start>',
        matchesTarget: emu ? menuSelectionMatchesTarget(emu, target) : false,
        phase: _menuNavPhase,
        stableLevelFrames: _menuStableLevelFrames,
        live: emu ? readMenuCursorLive(emu) : null,
        snapshot: snap,
        snapshotText: formatMenuNavSnapshot(snap),
        pendingOutcome: _menuNavPendingOutcome,
        canPress: autoMenuCanPress(),
        autoStartFrames: _autoStartFrames,
        autoBtnFrames: _autoBtnFrames,
        autoBtnCode: _autoBtnCode,
        levelJitterFrames: _levelJitterFrames,
        levelEntryFrames: _menuLevelEntryFrames,
        levelConfirmed: _menuLevelConfirmed,
        gametypeEntryFrames: _menuGametypeEntryFrames,
        gametypeSeqIdx: _gametypeSeqIdx,
        liveGametype: emu ? readGametypeCursor(emu) : null,
        c000: emu ? emu.read_mem(0xC000) : null,
        ff86: emu ? emu.read_mem(0xFF86) : null,
        pendingGameType: statsTracker._pendingGameType,
        awaitHighPanel: _menuAwaitHighPanel,
        emulationPaused,
        gameState: _lastGameState,
      };
    },
    readMenuNavSnapshot: (target) => (emu ? readMenuNavSnapshot(emu, target) : null),
    buildMenuRestoreSequence: (target) => buildMenuRestoreSequence(target || captureMenuRestoreTarget()),
    getStatsLinesDebug: () => statsTracker.getLinesDebugState(),
    setStatsLinesDebug: (on) => {
      localStorage.setItem('gbmul_debug_lines', on ? '1' : '0');
      console.info(`[stats-lines] verbose logging ${on ? 'enabled' : 'disabled'}`);
    },
    getStatsWinDebug: () => statsTracker.getWinDebugState(emu),
    setStatsWinDebug: (on) => {
      localStorage.setItem('gbmul_debug_win', on ? '1' : '0');
      console.info(`[stats-win] verbose logging ${on ? 'enabled' : 'disabled'}`);
    },
    startStateProbe: (opts) => startStateProbe(opts),
    stopStateProbe: () => stopStateProbe(),
    getStateProbeLog: () => getStateProbeLog(),
    clearStateProbeLog: () => clearStateProbeLog(),
    summarizeStateProbe: () => summarizeStateProbe(),
    exportStateProbeJson: () => exportStateProbeJson(),
    isStateProbeActive: () => _stateProbeActive,
    setAutoStateProbe: (on) => {
      localStorage.setItem('gbmul_auto_state_probe', on ? '1' : '0');
      console.info(`[state-probe] auto-start ${on ? 'enabled' : 'disabled'}`);
    },
    getLockLog: () => loadLockLog(),
    clearLockLog: () => localStorage.removeItem(LOCK_LOG_KEY),
    getMisdropReplays: () => loadMisdropReplays(),
    drainLockAudit: () => drainLockAuditToStorage(),
    getStats: () => {
      if (!rustBot) return null;
      const fn = rustBot.misdropStats || rustBot.misdrop_stats;
      return typeof fn === 'function' ? fn.call(rustBot) : null;
    },
    readSprite: () => rustBotReadPiecePos(dualMode && emuB ? emuB : emu),
    readBoardRows: (fromRow = 0, toRow = 19) => {
      const e = dualMode && emuB ? emuB : emu;
      if (!e?.read_mem) return [];
      const rows = [];
      for (let row = fromRow; row <= toRow; row++) {
        let bits = '';
        for (let col = 0; col < 10; col++) {
          const v = e.read_mem(0x800 + row * 16 + 2 + col);
          bits += (v & 0x7f) ? '#' : '.';
        }
        rows.push(`${row}:${bits}`);
      }
      return rows;
    },
    findLocks: (piece) => {
      const log = loadLockLog();
      return piece ? log.filter((e) => e.piece === piece) : log;
    },
  };
  // Legacy aliases — getters so MCP works after loadRom (emu starts null).
  Object.defineProperty(window, '__emu', {
    get: () => (dualMode && emuB ? emuB : emu),
    configurable: true,
  });
  Object.defineProperty(window, '__rustBot', {
    get: () => rustBot,
    configurable: true,
  });
}

// ── Misdrop replays using FULL emulator state (brutal but reliable) ──────────
const MISDROP_REPLAYS_KEY = 'gbmul_misdrop_replays_v2';

function base64FromBytes(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function bytesFromBase64(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function loadMisdropReplays() {
  try {
    const raw = localStorage.getItem(MISDROP_REPLAYS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveMisdropReplays(list) {
  try {
    localStorage.setItem(MISDROP_REPLAYS_KEY, JSON.stringify(list.slice(0, 30)));
  } catch (e) { console.warn('failed to save misdrop replays', e); }
}

// Human pair_label only (2-ply context). Fixture ids in manifest.json are capability+board — not this string.
function formatMisdropTs(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function misdropReplayLabel(meta, ts = Date.now()) {
  const types = ['I','O','T','S','Z','L','J'];
  const curType = meta.current_piece ? types[meta.current_piece.piece_type] || '?' : '?';
  const nxtType = meta.next_piece ? types[meta.next_piece.piece_type] || '?' : '?';
  return `${curType}→${nxtType} ${formatMisdropTs(ts)}`;
}

function misdropExportFilename(entry) {
  const types = ['I','O','T','S','Z','L','J'];
  const meta = entry.meta || {};
  const curType = meta.current_piece ? types[meta.current_piece.piece_type] || 'X' : 'X';
  const nxtType = meta.next_piece ? types[meta.next_piece.piece_type] || 'X' : 'X';
  const ts = entry.ts || Date.now();
  return `misdrop_${curType}_${nxtType}_${formatMisdropTs(ts)}.json`;
}

function misdropReplayDetail(meta) {
  if (!meta?.misdrop) return '';
  const m = meta.misdrop;
  const fmt = (col, rot, row) => {
    const base = `c${col} rot${rot}`;
    return row != null && row !== undefined ? `${base} row${row}` : base;
  };
  const gotLabel = m.got_valid === false ? 'got (stale/ARE)' : 'got';
  const parts = [
    `want ${fmt(m.wanted_col, m.wanted_rot, m.wanted_row)}`,
    `${gotLabel} ${fmt(m.actual_col, m.actual_rot, m.actual_row)}`,
  ];
  if (m.path?.length) parts.push(m.path.join(''));
  return parts.join(' · ');
}

function addMisdropReplayWithState(jsonStr, stateBytes) {
  if (!jsonStr) return;
  let meta = {};
  try { meta = JSON.parse(jsonStr); } catch {}
  const misType = meta.misdrop ? meta.misdrop.move_type : null;
  const ts = Date.now();
  const entry = {
    ts,
    label: misdropReplayLabel(meta, ts),
    type: misType,
    meta,
    state: base64FromBytes(stateBytes)
  };
  const list = loadMisdropReplays();
  list.unshift(entry);
  saveMisdropReplays(list);
  updateMisdropReplayList();
  console.log('[misdrop] saved replay with full state', entry.label);
  fireMisdropAlert(entry.label);

  // 2P: log the misdrop but keep both games running (no ROM reload).
  if (dualMode) {
    console.log('[misdrop] 2P — replay saved, game continues');
    return;
  }

  if (!misdropResetOn) {
    console.log('[misdrop] 1P — replay saved, game continues (reset on misdrop disabled)');
    return;
  }

  // 1P: ensure Type/Level/High snapshot survives reset, then record stats.
  ensureLastPlayedGameSetupFrozen();
  if (emu) {
    if (statsTracker.isBTypeWinCondition(emu) || statsTracker.isATypeMaxOutCondition()) {
      statsWinLog('suppress misdrop-abort — game completion detected', statsTracker.getWinDebugState(emu));
      statsTracker.maybeFinalizeActiveGame(emu, 'misdrop');
      return;
    }
    if (!statsTracker._active) {
      statsWinLog('suppress misdrop-abort — session already finalized');
      return;
    }
    statsTracker.endGame('misdrop-abort', emu);
  }

  // 1P: reset bot + reload ROM for a fresh game after misdrop.
  if (rustBot) {
    try { rustBotReset(); } catch (e) {}
  }
  clearMisdropSpawnCaptures();
  window._prevPieceMinY = 255;

  setTimeout(() => {
    try {
      if (typeof resetEmu === 'function') resetEmu();
    } catch (e) {}
  }, 50);
}

function deleteMisdropReplay(idx) {
  const list = loadMisdropReplays();
  list.splice(idx, 1);
  saveMisdropReplays(list);
  updateMisdropReplayList();
}

/** Download replay JSON for `node tools/import_misdrop_replay.js <file> --merge` */
function exportMisdropReplayForImport(idx = 0) {
  const list = loadMisdropReplays();
  const entry = list[idx];
  if (!entry) {
    console.warn('[misdrop] no replay at index', idx);
    return null;
  }
  const json = JSON.stringify(entry, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = misdropExportFilename(entry);
  a.click();
  URL.revokeObjectURL(a.href);
  console.log('[misdrop] exported for fixture import:', entry.label, '→', a.download);
  console.log('[misdrop] import: node tools/import_misdrop_replay.js', a.download, '--merge');
  return entry;
}
window.__exportMisdropReplayForImport = exportMisdropReplayForImport;

function clearMisdropReplays() {
  localStorage.removeItem(MISDROP_REPLAYS_KEY);
  updateMisdropReplayList();
}

function upgradeOldMisdropTypesIfNeeded() {
  if (window._misdropTypesUpgraded) return;
  window._misdropTypesUpgraded = true;

  let list;
  try {
    const raw = localStorage.getItem(MISDROP_REPLAYS_KEY);
    list = raw ? JSON.parse(raw) : [];
  } catch { return; }

  const emu = window.__emu;
  const rustBot = window.__rustBot;
  if (!emu || !rustBot || typeof rustBot.debug_classify_intention !== 'function') {
    console.warn('[misdrop] cannot auto-classify replays yet (debug methods not ready)');
    return;
  }

  let labelUpgraded = 0;
  for (const entry of list) {
    if (!entry?.label || !/#\d+\s*$/.test(entry.label)) continue;
    const ts = entry.ts || Date.now();
    entry.label = misdropReplayLabel(entry.meta || {}, ts);
    labelUpgraded++;
  }
  if (labelUpgraded > 0) {
    try {
      localStorage.setItem(MISDROP_REPLAYS_KEY, JSON.stringify(list.slice(0, 30)));
      console.log(`[misdrop] upgraded ${labelUpgraded} replay label(s) to timestamp format`);
      updateMisdropReplayList();
    } catch (e) {}
  }

  const saved = emu.save_state();
  let upgraded = 0;
  try {
    for (const entry of list) {
      if (!entry || !entry.state) continue;
      try {
        const bytes = bytesFromBase64(entry.state);
        emu.load_state(bytes);
        rustBotReset();
        for (let f = 0; f < 60; f++) {
          try { rustBotTick(); } catch (e) {}
        }
        const t = rustBot.debug_classify_intention();
        if (t && t !== 'no-plan' && t !== 'unknown') {
          if (entry.type !== t) {
            entry.type = t;
            upgraded++;
          }
        }
      } catch (e) {}
    }
  } finally {
    try { 
      emu.load_state(saved); 
      if (rustBot) rustBotReset();
      clearMisdropSpawnCaptures();
      window._prevPieceMinY = 255;
    } catch (e) {}
  }

  if (upgraded > 0) {
    try {
      localStorage.setItem(MISDROP_REPLAYS_KEY, JSON.stringify(list.slice(0, 30)));
      console.log(`[misdrop] re-classified ${upgraded} replay(s) using full intention (last non-D move)`);
      updateMisdropReplayList();
    } catch (e) {}
  }
}

function updateMisdropReplayList() {
  const container = document.getElementById('misdrop-replay-list');
  const countEl = document.getElementById('misdrop-replay-count');
  if (!container) return;
  const list = loadMisdropReplays();
  if (countEl) countEl.textContent = `(${list.length})`;
  const clearBtn = document.getElementById('misdrop-clear-all');
  if (clearBtn) clearBtn.style.display = list.length > 0 ? '' : 'none';
  container.innerHTML = '';
  if (list.length === 0) {
    const div = document.createElement('div');
    div.style.fontSize = '11px';
    div.style.opacity = '0.7';
    div.textContent = 'No misdrop replays yet.';
    container.appendChild(div);
    return;
  }
  list.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'misdrop-row';

    const main = document.createElement('div');
    main.className = 'misdrop-row-main';

    const label = document.createElement('span');
    label.className = 'misdrop-label';
    label.textContent = entry.label || 'replay';
    main.appendChild(label);

    if (entry.type) {
      const typeSpan = document.createElement('span');
      typeSpan.className = `misdrop-type ${entry.type}`;
      typeSpan.textContent = entry.type;
      main.appendChild(typeSpan);
    }

    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = 'Restore';
    restoreBtn.onclick = () => restoreMisdropReplay(entry);
    main.appendChild(restoreBtn);

    const exportBtn = document.createElement('button');
    exportBtn.textContent = 'Export';
    exportBtn.title = 'Download JSON for tools/import_misdrop_replay.js';
    exportBtn.onclick = () => exportMisdropReplayForImport(idx);
    main.appendChild(exportBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'X';
    delBtn.onclick = () => deleteMisdropReplay(idx);
    main.appendChild(delBtn);

    row.appendChild(main);

    const detail = entry.meta ? misdropReplayDetail(entry.meta) : '';
    if (detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'misdrop-detail';
      detailEl.textContent = detail;
      if (entry.meta?.misdrop?.path) {
        detailEl.title = `path: ${entry.meta.misdrop.path.join(', ')}`;
      }
      row.appendChild(detailEl);
    } else {
      row.title = 'No metadata (old entry — replay still restorable)';
    }

    container.appendChild(row);
  });
}

function restoreMisdropReplay(entry) {
  if (!entry.state) {
    alert('This replay has no full state saved (old entry?).');
    return;
  }
  try {
    if (entry.meta?.misdrop) {
      const m = entry.meta.misdrop;
      console.log('[misdrop] restore chain:', {
        label: entry.label,
        move_type: m.move_type,
        wanted: { col: m.wanted_col, rot: m.wanted_rot, row: m.wanted_row ?? null },
        actual: { col: m.actual_col, rot: m.actual_rot, row: m.actual_row ?? null, valid: m.got_valid !== false },
        path: m.path || [],
        path_len: m.path_len,
      });
    }
    const bytes = bytesFromBase64(entry.state);
    emu.load_state(bytes);

    // Replan + execute from scratch like live play — do NOT force the logged want target.
    // (Logged want/got above are for comparison only.)
    rustBotAfterStateRestore({ misdropReplay: true, wantLock: null });
    console.log('[misdrop] restore: plan from scratch (no forced target)');

    // Prevent JS side from immediately treating any transient spawn capture as a new one for misdrop pairing.
    window._prevPieceMinY = 255;
    clearMisdropSpawnCaptures();

    // Belt-and-suspenders: if any pending replay notification slips through for this restored piece,
    // the next check will silently drain it instead of creating a duplicate entry + triggering resetEmu.
    window._suppressNextMisdropCapture = true;

    emulationPaused = false;
    const pb = document.getElementById('btn-pause');
    if (pb) { pb.textContent = '⏸'; pb.title = 'Pause'; pb.classList.remove('paused'); }
    setStatus('Misdrop replay restored (full state).');
    if (typeof updateTetrisPanel === 'function') updateTetrisPanel();
  } catch (e) {
    console.error(e);
    alert('Restore failed: ' + e);
  }
}

function rustBotHasPendingMisdropPairing() {
  const peek = rustBot && (rustBot.hasPendingMisdropPairing || rustBot.has_pending_misdrop_pairing);
  return !!(peek && typeof peek === 'function' && peek.call(rustBot));
}

/** Clear spawn ring + legacy pairing fields (ROM reload / misdrop reset / restore). */
function clearMisdropSpawnCaptures() {
  window._spawnCaptureRing = [];
  window._lastSpawnFullState = null;
  window._misdropPairingState = null;
  window._lastSpawnCaptureOri = 0xff;
}

// Misdrop replay pairing (Phase 4 + ring-2 + plan-spawn hardening):
// - Capture ONLY at plan-time spawn: high Y, spawn orientation (rot 0), spawn col ~3.
// - Never update ring/pairing while Path/lock-verify/pending replay (mid-path CW still high).
// - On drain, pick ring entry matching meta (cur, next, rot, spawn_col).
// - Never fall back to live save_state() (that is post-lock / mid-path garbage).
function misdropReplayStateBytes(meta) {
  const ring = window._spawnCaptureRing || [];
  const wantCur = meta?.current_piece?.piece_type;
  const wantNext = meta?.next_piece?.piece_type;
  const wantRot = meta?.current_piece?.rot;
  const wantCol = meta?.current_piece?.spawn_col;
  const names = ['I', 'O', 'T', 'S', 'Z', 'L', 'J'];
  const nameOf = (t) => (t != null && t >= 0 && t < names.length ? names[t] : '?');
  const tag = (e) =>
    `${nameOf(e.cur)}→${nameOf(e.next)} r${e.rot ?? '?'} c${e.col ?? '?'}`;

  if (wantCur != null && ring.length > 0) {
    // Tightest match first: piece pair + spawn rot + spawn col.
    let pick = ring.find(
      (e) =>
        e.cur === wantCur &&
        (wantNext == null || e.next === wantNext) &&
        (wantRot == null || e.rot === wantRot) &&
        (wantCol == null || e.col === wantCol)
    );
    let how = 'pair+rot+col';
    if (!pick) {
      pick = ring.find(
        (e) =>
          e.cur === wantCur &&
          (wantNext == null || e.next === wantNext) &&
          (wantRot == null || e.rot === wantRot)
      );
      how = 'pair+rot';
    }
    if (!pick) {
      pick = ring.find(
        (e) => e.cur === wantCur && (wantNext == null || e.next === wantNext)
      );
      how = 'pair';
    }
    if (!pick) {
      pick = ring.find((e) => e.cur === wantCur && (e.rot === 0 || e.rot == null));
      how = 'cur+spawn-rot';
    }
    if (!pick) {
      pick = ring.find((e) => e.cur === wantCur);
      how = 'cur-only';
    }
    if (pick) {
      if (pick.rot != null && wantRot != null && pick.rot !== wantRot) {
        console.warn(
          `[misdrop] spawn capture rot mismatch: meta r${wantRot} vs saved r${pick.rot} (${how})`
        );
      }
      if (pick !== ring[0] || how !== 'pair+rot+col') {
        console.warn(
          `[misdrop] spawn ring pick ${tag(pick)} via ${how} ` +
          `(meta ${nameOf(wantCur)}→${nameOf(wantNext)} r${wantRot ?? '?'} c${wantCol ?? '?'}; ` +
          `ring=[${ring.map(tag).join(', ')}])`
        );
      }
      return pick.bytes;
    }
    // Ring has captures but none match this piece — pairing/lastSpawn are the same
    // stale slots (empty early-game board bug). Do not attach wrong board.
    console.error(
      `[misdrop] spawn ring miss for meta ${nameOf(wantCur)}→${nameOf(wantNext)} ` +
      `r${wantRot ?? '?'} c${wantCol ?? '?'}; ring=[${ring.map(tag).join(', ')}] — refusing stale fallback`
    );
    return null;
  }

  // Ring empty (first piece / after clear): single-slot fallbacks only.
  if (window._misdropPairingState) {
    console.warn('[misdrop] using _misdropPairingState (empty ring)');
    return window._misdropPairingState;
  }
  if (window._lastSpawnFullState) {
    console.warn('[misdrop] using _lastSpawnFullState (empty ring)');
    return window._lastSpawnFullState;
  }
  // No silent live fallback — that attaches mid-path / post-lock boards.
  console.error(
    '[misdrop] no plan-time spawn savestate available — refusing live save_state fallback'
  );
  return null;
}

/** Spawn orientation index 0..3 for a CUR_ORI byte, or -1 if unknown. */
function oriToSpawnRot(ori) {
  for (const [start, end] of ORI_RANGES) {
    if (ori >= start && ori < end) return ori - start;
  }
  return -1;
}

/** Leftmost board column of the active piece from sprite X (JS twin of piece_left_col). */
function livePieceLeftCol() {
  const PIX_X_OFF = 24;
  const PIX_CELL = 8;
  const xs = [0xC011, 0xC015, 0xC019, 0xC01D].map((a) => emu.read_mem(a));
  let minCol = 99;
  for (const px of xs) {
    const col = Math.floor((px - PIX_X_OFF) / PIX_CELL);
    if (col >= 0 && col < 10 && col < minCol) minCol = col;
  }
  return minCol === 99 ? -1 : minCol;
}

/**
 * Plan-time spawn capture only.
 * Rejects: mid-path (Path pending), non-spawn rotations, off-center cols after DAS.
 */
function rememberSpawnFullState() {
  if (!emu || !botEnabled) return;
  try {
    // Path / lock-verify / pending misdrop: never replace the plan-time board.
    if (rustBotHasPendingMisdropPairing()) {
      return;
    }

    const PIX_Y_OFF = 16;
    const PIX_CELL = 8;
    const ys = [0xC010, 0xC014, 0xC018, 0xC01C].map((addr) => emu.read_mem(addr));
    const minY = Math.min(...ys);
    const minRow = Math.floor((minY - PIX_Y_OFF) / PIX_CELL);
    // True spawn height only (same gate as Rust at_true_spawn).
    if (!(minRow <= 0 && minY < 0x18)) {
      window._prevPieceMinY = minY;
      return;
    }

    const ori = emu.read_mem(0xC203);
    const cur = oriToType(ori);
    const rot = oriToSpawnRot(ori);
    if (cur < 0 || rot < 0) {
      window._prevPieceMinY = minY;
      return;
    }
    // Spawn orientation only — CW/CCW at the top is already mid-path (T→L fixture bug).
    if (rot !== 0) {
      window._prevPieceMinY = minY;
      return;
    }

    const col = livePieceLeftCol();
    // Classic spawn col is 3; allow 2–4 for I / rounding, reject post-slide far laterals.
    if (col < 2 || col > 4) {
      window._prevPieceMinY = minY;
      return;
    }

    const next = oriToType(emu.read_mem(0xC213));
    const ring = window._spawnCaptureRing || [];
    // Same piece already captured at this ori+col — skip re-entrant frames.
    if (ring.length && ring[0].ori === ori && ring[0].col === col) {
      window._prevPieceMinY = minY;
      return;
    }

    const spawnState = emu.save_state();
    ring.unshift({ bytes: spawnState, cur, next, ori, rot, col });
    if (ring.length > 2) ring.length = 2;
    window._spawnCaptureRing = ring;
    window._lastSpawnFullState = spawnState;
    window._lastSpawnCaptureOri = ori;
    window._misdropPairingState = spawnState;
    window._prevPieceMinY = minY;
  } catch (e) {}
}

function checkForPendingMisdropReplay() {
  const take = rustBot && (rustBot.takePendingReplayJson || rustBot.take_pending_replay_json);
  if (!take || typeof take !== 'function' || !emu) return;
  try {
    const jsonStr = take.call(rustBot);
    if (jsonStr && jsonStr.length > 2) {
      if (window._suppressNextMisdropCapture) {
        // Just restored a replay — do not create a new entry or trigger post-capture resetEmu.
        window._suppressNextMisdropCapture = false;
        return;
      }
      let meta = {};
      try { meta = JSON.parse(jsonStr); } catch (_) {}
      // Plan-time spawn board only — never mid-path / post-lock live state.
      const stateBytes = misdropReplayStateBytes(meta);
      if (!stateBytes) {
        console.error(
          '[misdrop] dropped replay — no plan-time spawn savestate (see ring/pairing logs)'
        );
        return;
      }
      addMisdropReplayWithState(jsonStr, stateBytes);
      if (rustBot.debugTakePathTrace) {
        const trace = rustBot.debugTakePathTrace();
        if (trace) console.warn('[path] misdrop trace:\n' + trace);
      }
    }
  } catch (e) {
    console.warn('[misdrop] error checking pending replay', e);
  }
}

function resetEmu() {
  if (!emu || !_lastRomBytes) return;
  loadRom(_lastRomBytes);
}

// ── FPS counter ───────────────────────────────────────────────────────────────
const FPS_HISTORY_LEN  = 150;          // 15 s × 10 samples/s
const FPS_INTERVAL_MS  = 100;          // sample every 100 ms

const fpsOverlay  = document.getElementById("fps-overlay");
const fpsCtx2     = fpsOverlay.getContext("2d");
const fpsCheck    = document.getElementById("fps-check");

let fpsHistory    = [];   // sampled FPS values (up to FPS_HISTORY_LEN)
let fpsFrameTimes = [];   // raw frame timestamps, rolling ~3 s window
let fpsVisible    = false;

function setFpsVisible(v) {
  fpsVisible = v;
  fpsOverlay.classList.toggle("visible", v);
  if (!v) fpsCtx2.clearRect(0, 0, fpsOverlay.width, fpsOverlay.height);
  localStorage.setItem("gbmul_fps", v ? "1" : "0");
}

// Restore saved preference
fpsCheck.checked = localStorage.getItem("gbmul_fps") === "1";
setFpsVisible(fpsCheck.checked);
fpsCheck.addEventListener("change", () => setFpsVisible(fpsCheck.checked));

const soundCheck = document.getElementById("sound-check");
soundCheck.checked = !audioMuted;
soundCheck.addEventListener("change", () => {
  audioMuted = !soundCheck.checked;
  localStorage.setItem("gbmul_sound", audioMuted ? "0" : "1");
});

const volumeSlider = document.getElementById("volume-slider");
const volumeValue  = document.getElementById("volume-value");
volumeSlider.value = Math.round(audioVolume * 100);
volumeValue.textContent = `${Math.round(audioVolume * 100)}%`;
volumeSlider.addEventListener("input", () => {
  audioVolume = volumeSlider.value / 100;
  volumeValue.textContent = `${volumeSlider.value}%`;
  localStorage.setItem("gbmul_volume", String(audioVolume));
});

setInterval(() => {
  if (!fpsVisible) return;
  const now     = performance.now();
  const cutoff  = now - 1000;
  // count frames that occurred within the last second
  let count = 0;
  for (let i = fpsFrameTimes.length - 1; i >= 0; i--) {
    if (fpsFrameTimes[i] < cutoff) break;
    count++;
  }
  fpsHistory.push(count);
  if (fpsHistory.length > FPS_HISTORY_LEN) fpsHistory.shift();
  drawFpsOverlay(count);
}, FPS_INTERVAL_MS);

function drawFpsOverlay(fps) {
  const OW = fpsOverlay.width;
  const OH = fpsOverlay.height;
  fpsCtx2.clearRect(0, 0, OW, OH);

  // background
  fpsCtx2.fillStyle = "rgba(0,0,0,0.60)";
  fpsRoundRect(fpsCtx2, 0, 0, OW, OH, 4);
  fpsCtx2.fill();

  // FPS label
  const color = fps >= 55 ? "#6f6" : fps >= 30 ? "#ff6" : "#f66";
  fpsCtx2.fillStyle = color;
  fpsCtx2.font = "bold 12px monospace";
  fpsCtx2.textBaseline = "top";
  fpsCtx2.fillText(String(fps).padStart(2, " ") + " FPS", 5, 4);

  // graph area
  if (fpsHistory.length < 2) return;
  const gx = 3, gy = 20, gw = OW - 6, gh = OH - 23;
  const maxFps = 70;
  const step   = gw / (FPS_HISTORY_LEN - 1);
  const pts    = fpsHistory;

  // filled area
  fpsCtx2.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = gx + (FPS_HISTORY_LEN - pts.length + i) * step;
    const y = gy + gh - (Math.min(pts[i], maxFps) / maxFps) * gh;
    i === 0 ? fpsCtx2.moveTo(x, y) : fpsCtx2.lineTo(x, y);
  }
  const rx = gx + (FPS_HISTORY_LEN - 1) * step;
  const lx = gx + (FPS_HISTORY_LEN - pts.length) * step;
  fpsCtx2.lineTo(rx, gy + gh);
  fpsCtx2.lineTo(lx, gy + gh);
  fpsCtx2.closePath();
  const grad = fpsCtx2.createLinearGradient(0, gy, 0, gy + gh);
  grad.addColorStop(0, "rgba(100,255,100,0.45)");
  grad.addColorStop(1, "rgba(100,255,100,0.05)");
  fpsCtx2.fillStyle = grad;
  fpsCtx2.fill();

  // stroke line
  fpsCtx2.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = gx + (FPS_HISTORY_LEN - pts.length + i) * step;
    const y = gy + gh - (Math.min(pts[i], maxFps) / maxFps) * gh;
    i === 0 ? fpsCtx2.moveTo(x, y) : fpsCtx2.lineTo(x, y);
  }
  fpsCtx2.strokeStyle = "rgba(120,255,120,0.9)";
  fpsCtx2.lineWidth   = 1;
  fpsCtx2.stroke();
}

function fpsRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

document.getElementById("btn-save").addEventListener("click", saveState);
document.getElementById("btn-load-state").addEventListener("click", loadState);
document.getElementById("btn-reset").addEventListener("click", resetEmu);

// Misdrop replays UI (full state) — list is populated on changes + initial load
updateMisdropReplayList();
upgradeOldMisdropTypesIfNeeded();

const misClr = document.getElementById('misdrop-clear-all');
if (misClr) misClr.addEventListener('click', () => {
  if (confirm('Clear all misdrop replays?')) clearMisdropReplays();
});

// ── pause / resume ────────────────────────────────────────────────────────────
let emulationPaused = false;
const btnPause = document.getElementById("btn-pause");

function clearPause() {
  emulationPaused = false;
  btnPause.textContent = "⏸";
  btnPause.title = "Pause";
  btnPause.classList.remove("paused");
}

btnPause.addEventListener("click", () => {
  if (!emu) return;
  emulationPaused = !emulationPaused;
  if (emulationPaused) {
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    btnPause.textContent = "▶";
    btnPause.title = "Resume";
    btnPause.classList.add("paused");
  } else {
    btnPause.textContent = "⏸";
    btnPause.title = "Pause";
    btnPause.classList.remove("paused");
    startLoop();
  }
});

// ── game state badge ──────────────────────────────────────────────────────────
//
// States detected for Tetris GB using WRAM and VRAM addresses:
//
//   0xC000       → 0x80 EXCLUSIVELY during title screen (initial and post-demo).
//                  Checked first to short-circuit: C204 stays 0x80 after demo ends
//                  but C000 reliably returns to 0x80, so we catch it before in-game.
//   0xC204 bit7  → set during active play, demo, pause, game-over, and win
//   0xCFFC       → 0x01 only when paused mid-game; 0x1C during line-clear animation
//   0x9885       → VRAM BG tilemap row 4 col 5:
//                    0x2F = blank (all non-game-over/win states)
//                    0x10 = 'G' of "GAME OVER"
//                    0x26 = Type-B win score screen tile (confirmed 2026-06-11)
//   0xC201       → 0x40 during attract/demo mode; 0x28 during real in-game
//
// Detection priority (checked top-down each frame):
//   1. gametype  : 0xC201 !== 0 && 0xC000 === 0x70
//   2. title     : 0xC000 === 0x80                      (initial or post-demo title)
//   3. paused    : (0xC204 & 0x80) && 0xCFFC === 0x01
//   4. game-over : (0xC204 & 0x80) && VRAM[0x9885] === 0x10
//   5. win       : (0xC204 & 0x80) && VRAM[0x9885] === 0x26
//   6. demo      : (0xC204 & 0x80) && 0xC201 === 0x40   (attract/demo mode)
//   7. in-game   : (0xC204 & 0x80)                      (active piece falling)
//   8. splash    : 0xC000 === 0 AND 0xC201 === 0         (WRAM not yet initialised)
//   9. submenu   : E1 level/high phase or 0xC201 !== 0  (level select; only when C204 clear)
//  10. title     : else fallback
//
// Calibration data:
//   state           C000  C201  C204  CFFC  VRAM[0x9885]
//   splash          0x00  0x00  0x00  0x00  0x2F
//   title (init)    0x80  0x00  0x00  0x00  0x96
//   title (post-dm) 0x80  0x10  0x80  0x00  0x96  ← C204 stays set after demo
//   demo            0x00  0x40  0x80  0x00  0x2F
//   game-type menu  0x70  0x70  0x00  0x00  0x2F
//   level select    0xFF  0x40  0x00  0x00  0x2F  ← C204=0 prevents demo confusion
//   in-game         0x00  0x28  0x80  0x00  0x2F
//   paused          0x00  0x68  0x80  0x01  0x2F
//   game-over       0x00  0x10  0x80  0x00  0x10
//   win (Type-B)    0x00  0x58  0x80  0x05  0x26
//   top-out fill    0x00  ...   0x80/0  ...  0x87/0x88  (NOT rocket — grid fill artefact)
//   rocket (Type-A) C204=0  C001=0x50  E1=0x2F–0x31  (post game-over, before name entry)
//   name entry      C204=0  C001=0x50  E1≥0x32       (C000≈0x52 C201≈0x6A live probe)
//   level select    C204=0  C001=0x30  E1=0x11/0x13
//
const PROBE_INGAME_ADDR = 0xC204;
const PROBE_INGAME_MASK = 0x80;
const PROBE_C201        = 0xC201;
const PROBE_C001        = 0xC001;
const PROBE_C000        = 0xC000;
const PROBE_PAUSE_ADDR   = 0xCFFC;  // 0x01 = paused mid-game; 0x1c = line-clear animation; 0x00 = running
const PROBE_VRAM_GO_ADDR = 0x9885;  // BG tilemap r4c5: 0x10='G' during GAME OVER, 0x26=win, 0x2F otherwise
const PROBE_VRAM_GO_TILE = 0x10;    // tile for 'G' (tile encoding: ASCII - 0x37)
const PROBE_VRAM_WIN_TILE = 0x26;   // tile at same address during Type-B win score screen
const PROBE_VRAM_TOPOUT_LO = 0x87;  // solid-grid top-out artefact (not post-game)
const PROBE_VRAM_TOPOUT_HI = 0x88;
const PROBE_SCOREBOARD_C001 = 0x50;       // post-GO scoreboard family (level select uses 0x30)
const MENU_HRAM_POSTGAME_NAME = 0x32;     // E1 ≥ 0x32 → 3-letter name entry (empirical)

function isTopOutGridFill(emu) {
  const v = emu.read_mem(PROBE_VRAM_GO_ADDR);
  return v === PROBE_VRAM_TOPOUT_LO || v === PROBE_VRAM_TOPOUT_HI;
}

function isPostGameScoreboardFamily(emu) {
  return (emu.read_mem(PROBE_INGAME_ADDR) & PROBE_INGAME_MASK) === 0
    && emu.read_mem(PROBE_C001) === PROBE_SCOREBOARD_C001;
}

/** Type-A rocket launch after GAME OVER — C001=0x50, E1=0x2F–0x31. */
function isRocketPostGame(emu) {
  if (!isPostGameScoreboardFamily(emu) || isTopOutGridFill(emu)) return false;
  const e1 = emu.read_mem(MENU_HRAM_PHASE);
  if (menuPhaseIsLevel(e1) || menuPhaseIsHigh(e1)) return false;
  return e1 < MENU_HRAM_POSTGAME_NAME;
}

/** 3-letter name entry — C001=0x50, E1≥0x32 (live: C000=0x52 C201=0x6A). */
function isHighScoreEntryScreen(emu) {
  if (!isPostGameScoreboardFamily(emu) || isTopOutGridFill(emu)) return false;
  const e1 = emu.read_mem(MENU_HRAM_PHASE);
  if (menuPhaseIsLevel(e1) || menuPhaseIsHigh(e1)) return false;
  return e1 >= MENU_HRAM_POSTGAME_NAME;
}

// Multiplayer flag + 2P result probes (live dual-mode 2026-07).
const PROBE_MP_FLAG       = 0xFFC5; // 1 while in 2P / link mode
const PROBE_MP_WINS       = 0xFFD7; // this side's series wins
const PROBE_MP_LOSSES     = 0xFFD8; // opponent's series wins
const E1_VS_RESULT_WIN    = 0x20;   // this side won the round (Mario celebrate)
const E1_VS_RESULT_LOSS   = 0x21;   // this side lost the round (Luigi cry)

/** Series over when either side has first-to-4. RAM may read 5 after the 4th point. */
function vsMatchOver(wins, losses) {
  return wins >= VS_MATCH_WINS || losses >= VS_MATCH_WINS;
}

function detectGameState(emu) {
  // Prefer Rust implementation (M4: game state detection ported to Rust for sharing
  // with device version). Includes logic for high-level states; board/placed blocks
  // composition is provided separately via tetris_read_bitboard (from M1 data models).
  if (emu && typeof emu.detect_game_state === 'function') {
    return emu.detect_game_state();
  }
  // Fallback to JS version (during migration).
  const c000 = emu.read_mem(PROBE_C000);
  const c201 = emu.read_mem(PROBE_C201);
  const e1 = emu.read_mem(MENU_HRAM_PHASE);
  // Game-type screen (C000=0x70) before E1 — HRAM phase persists in SRAM after B play.
  if (c201 !== 0 && c000 === 0x70) return "submenu-gametype";
  // C000=0x80 is exclusive to the title screen (initial and post-demo).
  // Must be checked before C204 because C204 stays set after the demo ends.
  if (c000 === 0x80) return "title";
  // Type-B win after C204 clears: C201=0x58 only valid with win-screen VRAM/CFFC.
  if (c201 === 0x58 && (emu.read_mem(PROBE_INGAME_ADDR) & PROBE_INGAME_MASK) === 0) {
    const vram9885 = emu.read_mem(PROBE_VRAM_GO_ADDR);
    const cffc = emu.read_mem(PROBE_PAUSE_ADDR);
    if (vram9885 === PROBE_VRAM_WIN_TILE || cffc === 0x05) return "win";
  }
  // 2P Mario/Luigi result cutscene (before C204→InGame fallthrough).
  // Round vs full match: FFD7/FFD8 series scores (first to 4; RAM may show 5).
  if (emu.read_mem(PROBE_MP_FLAG) === 1) {
    const matchOver = vsMatchOver(
      emu.read_mem(PROBE_MP_WINS),
      emu.read_mem(PROBE_MP_LOSSES),
    );
    if (e1 === E1_VS_RESULT_WIN)  return matchOver ? "2p-match-win"  : "2p-round-win";
    if (e1 === E1_VS_RESULT_LOSS) return matchOver ? "2p-match-loss" : "2p-round-loss";
  }
  // C204 play family before E1 — HRAM menu phase persists in SRAM after B-type
  // and would otherwise mask game-over / Type-B win (VRAM 0x9885 probe).
  if ((emu.read_mem(PROBE_INGAME_ADDR) & PROBE_INGAME_MASK) !== 0) {
    const cffc = emu.read_mem(PROBE_PAUSE_ADDR);
    const vram9885 = emu.read_mem(PROBE_VRAM_GO_ADDR);
    if (cffc === 0x01)                     return "paused";
    if (vram9885 === PROBE_VRAM_GO_TILE)   return "game-over";
    // VRAM 0x26 only — C201=0x58 is piece Y during play, not a win probe.
    if (vram9885 === PROBE_VRAM_WIN_TILE)  return "win";
    if (c201 === 0x40)                     return "demo";
    return "in-game";
  }
  if (c000 === 0 && c201 === 0) return "splash";
  if ((emu.read_mem(PROBE_INGAME_ADDR) & PROBE_INGAME_MASK) === 0 && isTopOutGridFill(emu)) {
    return "in-game";
  }
  if (isRocketPostGame(emu))                 return "rocket";
  if (isHighScoreEntryScreen(emu))           return "high-score-entry";
  // E1 is stable during level select; only when C204 is clear (not in-game/win).
  if (menuPhaseIsLevel(e1) || menuPhaseIsHigh(e1)) return "submenu-level";
  // C001=0x50 post-GO family — never plain level select (C001=0x30).
  if (c201 !== 0 && emu.read_mem(PROBE_C001) !== PROBE_SCOREBOARD_C001) return "submenu-level";
  // C201 briefly clears during level-select cursor blink — stay on level select.
  if (c000 === 0xFF || c000 === 0x40 || c000 === 0x50) return "submenu-level";
  return "title";
}

const STATE_LABELS = {
  "loading":          "Loading…",
  "splash":           "Splash",
  "title":            "Title",
  "demo":             "Demo",
  "submenu-gametype": "Game Type",
  "submenu-level":    "Level Select",
  "in-game":          "In Game",
  "paused":           "Paused",
  "game-over":        "Game Over",
  "win":              "Type-B Win!",
  "rocket":           "Rocket!",
  "high-score-entry": "High Score Entry",
  "2p-round-win":     "2P Round Win",
  "2p-round-loss":    "2P Round Loss",
  "2p-match-win":     "2P Game Win",
  "2p-match-loss":    "2P Game Loss",
};

const gameStateBadge = document.getElementById("game-state-badge");
const gameStateLabel = document.getElementById("game-state-label");
// Badge updates are driven by loop() above – no polling interval needed.

// ── memory inspector ──────────────────────────────────────────────────────────
//
// Watch addresses displayed in the ☰ panel, updated every second.
// Add or remove entries here to observe different WRAM regions.
// Columns: addr (hex), human-readable label.
//
const MEM_WATCH = [
  { addr: 0xC204, label: "In-game probe (bit7)"           },
  { addr: 0xCFFC, label: "Pause flag (0x01=paused)"       },
  { addr: 0xC201, label: "Sub-state / phase"              },
  { addr: 0xC000, label: "Menu blink display (unstable)"  },
  { addr: 0xFFE1, label: "Menu phase (13=L,14/15=H)"      },
  { addr: 0xFFC3, label: "B-type level cursor (0–9)"      },
  { addr: 0xFFC4, label: "B-type HIGH cursor (0–5)"       },
  { addr: 0xC0A0, label: "Score[0] (BCD)"                 },
  { addr: 0xFFA9, label: "Level (HRAM, binary)"           },
  { addr: 0xFF9C, label: "0xFF9C (pulses on each line-clear; NOT hundreds)"  },
  { addr: 0xFF9E, label: "Lines lo (HRAM, BCD tens+units, 0-99)" },
];

const memWatchBody = document.getElementById("mem-watch-body");

// Build rows once
MEM_WATCH.forEach(({ addr, label }, i) => {
  const tr = document.createElement("tr");
  tr.innerHTML =
    `<td title="${label}">0x${addr.toString(16).toUpperCase().padStart(4, "0")}</td>` +
    `<td id="mw-hex-${i}">–</td>` +
    `<td id="mw-dec-${i}">–</td>`;
  memWatchBody.appendChild(tr);
});

setInterval(() => {
  if (!emu) return;
  MEM_WATCH.forEach(({ addr }, i) => {
    const v = emu.read_mem(addr);
    document.getElementById(`mw-hex-${i}`).textContent =
      "0x" + v.toString(16).toUpperCase().padStart(2, "0");
    document.getElementById(`mw-dec-${i}`).textContent = v;
  });
}, 1000);

// ── Tetris game-state panel ───────────────────────────────────────────────
//
// Memory map (GB Tetris / Tetris DX, confirmed empirically):
//   Board   : 0xC800 + row*32 + 2  (10 bytes per row, rows 0-17)
//             Occupied cell = value in 0x80-0x8F excluding 0x8E (wall)
//   Score   : 0xC0A0-C0A2  BCD, low byte first  (bcd2→bcd1→bcd0 * 10000/100/1)
//   Level   : 0xFFA9       binary (HRAM) — tracks displayed level; for B-type = startLevel+startHeight at game start
//   Lines A : VRAM tilemap r8c15/c16/c17 (0x990F/10/11) — tile values 0–9 = digit; 0x2F = blank
//   Lines B : HRAM 0xFF9E BCD — remaining lines countdown (Type-B goal→0)
//   Cur ori : 0xC203       current piece orientation ID (0x00-0x1B, sequential step 1)
//   Next ori: 0xC213       next piece orientation ID (always spawn orientation → C203 on lock)
//   Squares : C010/C011, C014/C015, C018/C019, C01C/C01D  (Y,X pixel pairs)
//
// Piece types (orientation ID → type, 0=I 1=O 2=T 3=S 4=Z 5=L 6=J):
// Confirmed empirically: IDs are sequential (step 1), 4 consecutive IDs per piece.
//   L: 0x00-0x03   J: 0x04-0x07   I: 0x08-0x0B   O: 0x0C-0x0F
//   Z: 0x10-0x13   S: 0x14-0x17   T: 0x18-0x1B
//
const TS = {
  BOARD_BASE   : 0xC800,
  BOARD_STRIDE : 32,
  BOARD_ROWS   : 18,
  BOARD_COLS   : 10,
  SCORE0       : 0xC0A0,
  LEVEL        : 0xFFA9,   // HRAM, binary — displayed level
  // Lines counter is read from the BG tilemap (VRAM), not HRAM/WRAM.
  // FF9C is NOT the hundreds digit — it pulses briefly on every clear event.
  // See readLinesVRAM() for the confirmed addresses.
  LINES_HI_VRAM : 0x990F,  // VRAM BG tilemap r8c15 — hundreds digit tile (0-9 or 0x2F=blank)
  LINES_TN_VRAM : 0x9910,  // VRAM BG tilemap r8c16 — tens digit tile
  LINES_UN_VRAM : 0x9911,  // VRAM BG tilemap r8c17 — units digit tile
  CUR_ORI      : 0xC203,
  NEXT_ORI     : 0xC213,
  // 4 squares (Y,X pixel pairs), board-relative
  SQ_ADDRS     : [[0xC010, 0xC011], [0xC014, 0xC015], [0xC018, 0xC019], [0xC01C, 0xC01D]],
};

// Piece type lookup: orientation ID → { name, color }
const PIECE_COLORS = [
  '#ff1588', // I – hot pink
  '#00b7ff', // O – blue
  '#fe8100', // T – orange
  '#27c02a', // S – green
  '#79c8e7', // Z – light blue
  '#ff5eaa', // L – soft pink
  '#ffffff', // J – white
];
const PIECE_NAMES = ['I','O','T','S','Z','L','J'];

// Orientation ID ranges per piece type (inclusive start, exclusive end)
// Format: [startID, endID_exclusive, typeIndex]
// IDs are sequential (step 1); each piece occupies 4 consecutive IDs starting at its spawn value.
const ORI_RANGES = [
  [0x00, 0x04, 5], // L (spawn 0x00, orientations 0x00-0x03)
  [0x04, 0x08, 6], // J (spawn 0x04, orientations 0x04-0x07)
  [0x08, 0x0C, 0], // I (spawn 0x08, orientations 0x08-0x0B)
  [0x0C, 0x10, 1], // O (spawn 0x0C, orientations 0x0C-0x0F)
  [0x10, 0x14, 4], // Z (spawn 0x10, orientations 0x10-0x13)
  [0x14, 0x18, 3], // S (spawn 0x14, orientations 0x14-0x17)
  [0x18, 0x1C, 2], // T (spawn 0x18, orientations 0x18-0x1B)
];

function oriToType(ori) {
  for (const [start, end, idx] of ORI_RANGES) {
    if (ori >= start && ori < end) return idx;
  }
  return -1; // unknown
}

function bcdByte(b) {
  return ((b >> 4) & 0xF) * 10 + (b & 0xF);
}

function readScoreBcd(emuRef) {
  return bcdByte(emuRef.read_mem(0xC0A2)) * 10000
       + bcdByte(emuRef.read_mem(0xC0A1)) * 100
       + bcdByte(emuRef.read_mem(0xC0A0));
}

// Read the lines counter from the BG tilemap.
// Confirmed layout: VRAM 0x9800, row 8, cols 15/16/17 = hundreds/tens/units.
// Tile values 0–9 are the literal digit; tile 0x2F (47) = blank = leading zero.
function readLinesVRAM(emu) {
  const base = 0x9800 + 8 * 32;  // 0x990E = start of row 8
  const tH = emu.read_mem(base + 15);  // 0x990F – hundreds
  const tT = emu.read_mem(base + 16);  // 0x9910 – tens
  const tU = emu.read_mem(base + 17);  // 0x9911 – units
  return (tH < 10 ? tH : 0) * 100
       + (tT < 10 ? tT : 0) * 10
       + (tU < 10 ? tU : 0);
}

function isOccupied(v) {
  return ((v & 0xF0) === 0x80 && v !== 0x8E) || v === 0x28;
}

function isGarbageTile(v) {
  return v === 0x28;
}

// Tile value low-nibble → piece colour for locked cells.
// Confirmed by live lock-detection: oriToType + tile-nibble correlation.
const TILE_COLORS = {
  // Horizontal I piece:  0xa, 0xb, 0xf  (left-cap, middle, right-cap)
  // Vertical I piece:    0x0, 0x8, 0x9  (top-cap, middle, bottom-cap)
  0x0: PIECE_COLORS[0], // I – cyan
  0x1: PIECE_COLORS[6], // J – blue
  0x2: PIECE_COLORS[4], // Z – red
  0x3: PIECE_COLORS[1], // O – yellow
  0x4: PIECE_COLORS[5], // L – orange
  0x5: PIECE_COLORS[2], // T – purple
  0x6: PIECE_COLORS[3], // S – green
  0x8: PIECE_COLORS[0], // I – cyan (vertical segment)
  0x9: PIECE_COLORS[0], // I – cyan (vertical segment)
  0xa: PIECE_COLORS[0], // I – cyan (horizontal segment)
  0xb: PIECE_COLORS[0], // I – cyan (horizontal segment)
  0xf: PIECE_COLORS[0], // I – cyan (horizontal end-cap)
};
function tileColor(v) {
  return TILE_COLORS[v & 0x0F] || '#888888';
}

// Canvas references
const tsBoardCanvas = document.getElementById('ts-board');
const tsBoardCtx    = tsBoardCanvas.getContext('2d');
const tsCurCanvas   = document.getElementById('ts-cur-canvas');
const tsCurCtx      = tsCurCanvas.getContext('2d');
const tsNextCanvas  = document.getElementById('ts-next-canvas');
const tsNextCtx     = tsNextCanvas.getContext('2d');

const tsScore = document.getElementById('ts-score');
const tsLevel = document.getElementById('ts-level');
const tsLines = document.getElementById('ts-lines');

// Board cell size in panel canvas
const TS_CELL = 10; // px per cell in the panel board
const TS_COLS = TS.BOARD_COLS;
const TS_ROWS = TS.BOARD_ROWS;

// Resize canvases to exact cell grid
tsBoardCanvas.width  = TS_COLS * TS_CELL;
tsBoardCanvas.height = TS_ROWS * TS_CELL;

// Convert board-relative pixel coord to board row/col
// Board left wall offset: 8px (1 tile), each tile = 8px
// Board top offset: 16px (2 tiles)
const BOARD_PIX_X_OFF = 24;
const BOARD_PIX_Y_OFF = 16;
const BOARD_PIX_CELL  = 8;

// Canonical spawn shapes (row, col) for each piece type index
const PIECE_SHAPES = [
  [[0,0],[0,1],[0,2],[0,3]],          // I
  [[0,0],[0,1],[1,0],[1,1]],          // O
  [[0,1],[1,0],[1,1],[1,2]],          // T
  [[0,1],[0,2],[1,0],[1,1]],          // S
  [[0,0],[0,1],[1,1],[1,2]],          // Z
  [[0,2],[1,0],[1,1],[1,2]],          // L
  [[0,0],[1,0],[1,1],[1,2]],          // J
];

function drawPiecePreview(ctx, typeIdx) {
  drawPieceShapeByType(ctx, typeIdx, typeIdx >= 0 ? PIECE_COLORS[typeIdx] : null);
}

function drawPieceShapeByType(ctx, typeIdx, color) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (typeIdx < 0 || !PIECE_SHAPES[typeIdx]) return;
  const squares = PIECE_SHAPES[typeIdx];
  drawCurrentPieceShape(ctx, squares.map(([row,col]) => ({row,col})), color || '#888');
}

// Draw the actual 4-square shape of the current piece (from pixel coords)
function drawCurrentPieceShape(ctx, squares, color) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = 'rgba(0,0,0,0.08)';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (squares.length === 0 || color == null) return;

  const rows = squares.map(s => s.row), cols = squares.map(s => s.col);
  const minRow = Math.min(...rows), minCol = Math.min(...cols);
  const maxRow = Math.max(...rows), maxCol = Math.max(...cols);
  const spanR = maxRow - minRow + 1, spanC = maxCol - minCol + 1;
  const cell = Math.min(Math.floor(ctx.canvas.width / (spanC + 1)),
                        Math.floor(ctx.canvas.height / (spanR + 1)));
  const offX = Math.floor((ctx.canvas.width  - spanC * cell) / 2);
  const offY = Math.floor((ctx.canvas.height - spanR * cell) / 2);
  ctx.fillStyle = color;
  for (const { row, col } of squares) {
    ctx.fillRect(
      offX + (col - minCol) * cell + 1,
      offY + (row - minRow) * cell + 1,
      cell - 2, cell - 2
    );
  }
}

let _lastTsState = null;

function updateTetrisPanel() {
  if (!emu) return;

  const inGame = (emu.read_mem(0xC204) & 0x80) !== 0;
  if (!inGame) {
    if (_lastTsState !== 'out') {
      _lastTsState = 'out';
      tsScore.textContent = '–';
      tsLevel.textContent = '–';
      tsLines.textContent = '–';
      tsBoardCtx.clearRect(0, 0, tsBoardCanvas.width, tsBoardCanvas.height);
      drawPiecePreview(tsCurCtx, -1);
      drawPiecePreview(tsNextCtx, -1);
    }
    return;
  }

  // ── score ──
  const s0 = emu.read_mem(TS.SCORE0);
  const s1 = emu.read_mem(TS.SCORE0 + 1);
  const s2 = emu.read_mem(TS.SCORE0 + 2);
  const score = bcdByte(s2) * 10000 + bcdByte(s1) * 100 + bcdByte(s0);

  // ── level & lines ──
  const level = emu.read_mem(TS.LEVEL);
  // _cachedPanelLines is updated per-frame in loop() with a cooldown gate;
  // just read it here.
  const lines = _cachedPanelLines;

  tsScore.textContent = score.toString();
  tsLevel.textContent = level.toString();
  tsLines.textContent = lines.toString();

  // ── piece types ──
  const curOri  = emu.read_mem(TS.CUR_ORI);
  const nextOri = emu.read_mem(TS.NEXT_ORI);
  const curType  = oriToType(curOri);
  const nextType = oriToType(nextOri);

  // Current piece: gather squares from pixel coords
  const curSquaresArr = [];
  const curSquaresSet = new Set();
  for (const [yAddr, xAddr] of TS.SQ_ADDRS) {
    const py = emu.read_mem(yAddr);
    const px = emu.read_mem(xAddr);
    const row = Math.floor((py - BOARD_PIX_Y_OFF) / BOARD_PIX_CELL);
    const col = Math.floor((px - BOARD_PIX_X_OFF) / BOARD_PIX_CELL);
    if (col >= 0 && col < TS_COLS && row < TS_ROWS) {
      // Allow row < 0 for the preview shape (piece spawning above the board)
      curSquaresArr.push({ row, col });
      if (row >= 0) curSquaresSet.add(row * TS_COLS + col);
    }
  }

  // Pick colour from piece type (may be off) or fall back to neutral
  const curColor  = curType >= 0 ? PIECE_COLORS[curType] : '#888888';
  const nextColor = nextType >= 0 ? PIECE_COLORS[nextType] : '#888888';

  drawCurrentPieceShape(tsCurCtx, curSquaresArr, curColor);
  drawPiecePreview(tsNextCtx, nextType);

  // ── board ──
  tsBoardCtx.clearRect(0, 0, tsBoardCanvas.width, tsBoardCanvas.height);

  // Dark background
  tsBoardCtx.fillStyle = '#111';
  tsBoardCtx.fillRect(0, 0, tsBoardCanvas.width, tsBoardCanvas.height);

  for (let row = 0; row < TS_ROWS; row++) {
    const base = TS.BOARD_BASE + row * TS.BOARD_STRIDE + 2;
    for (let col = 0; col < TS_COLS; col++) {
      const v    = emu.read_mem(base + col);
      const x    = col * TS_CELL;
      const y    = row * TS_CELL;
      const key  = row * TS_COLS + col;

      if (curSquaresSet.has(key)) {
        tsBoardCtx.fillStyle = curColor;
        tsBoardCtx.fillRect(x + 1, y + 1, TS_CELL - 2, TS_CELL - 2);
      } else if (isGarbageTile(v)) {
        tsBoardCtx.fillStyle = '#555';
        tsBoardCtx.fillRect(x + 1, y + 1, TS_CELL - 2, TS_CELL - 2);
      } else if (isOccupied(v)) {
        tsBoardCtx.fillStyle = tileColor(v);
        tsBoardCtx.fillRect(x + 1, y + 1, TS_CELL - 2, TS_CELL - 2);
      }

      // Cell grid line
      tsBoardCtx.strokeStyle = 'rgba(255,255,255,0.06)';
      tsBoardCtx.strokeRect(x + 0.5, y + 0.5, TS_CELL - 1, TS_CELL - 1);
    }
  }

  _lastTsState = 'in';
}

// Update panel every frame (driven by the existing game loop via requestAnimationFrame)
// We hook into a simple interval at ~15fps to avoid heavy DOM writes every frame.
setInterval(updateTetrisPanel, 66);

// Extra safety: periodically drain any pending misdrop replay (in case the per-tick check missed it)
setInterval(() => {
  const take = botEnabled && rustBot && (rustBot.takePendingReplayJson || rustBot.take_pending_replay_json);
  if (take && typeof take === 'function' && emu) {
    try {
      const jsonStr = take.call(rustBot);
      if (jsonStr && jsonStr.length > 2) {
        if (window._suppressNextMisdropCapture) {
          window._suppressNextMisdropCapture = false;
          return;
        }
        let meta = {};
        try { meta = JSON.parse(jsonStr); } catch (_) {}
        const stateBytes = misdropReplayStateBytes(meta);
        if (!stateBytes) {
          console.error('[misdrop] interval drain dropped replay — no plan-time spawn');
          return;
        }
        addMisdropReplayWithState(jsonStr, stateBytes);
      }
    } catch (e) {}
  }
}, 200);

// ── touch controls ────────────────────────────────────────────────────────────
{
  // Multi-touch: one finger on D-pad (diagonals OK) + another on A/B/Start.
  // D-pad is a single hit-zone; position maps to Up/Down/Left/Right bits so
  // Left+Down (wall soft-drop / tuck) works like a real Game Boy cross.
  //
  // activeTouches: id → { kind: 'dpad'|'btn', el?, btn?, idm? }
  const activeTouches = new Map();
  const tcContainer = document.getElementById('touch-controls');
  const tcDpad = document.getElementById('tc-dpad');
  const dpadBtnEls = {
    4: document.getElementById('tc-up'),
    5: document.getElementById('tc-down'),
    6: document.getElementById('tc-left'),
    7: document.getElementById('tc-right'),
  };
  /** Refcount of held D-pad directions (4=Up 5=Down 6=Left 7=Right). */
  const dpadHeld = { 4: 0, 5: 0, 6: 0, 7: 0 };
  /** Dead zone around pad centre (fraction of half-size) — avoids accidental diagonals. */
  const DPAD_DEAD = 0.28;

  function dpadDirsFromPoint(clientX, clientY) {
    if (!tcDpad) return [];
    const r = tcDpad.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return [];
    const nx = (clientX - r.left) / r.width - 0.5;  // -0.5 … +0.5
    const ny = (clientY - r.top) / r.height - 0.5;
    const dirs = [];
    if (ny < -DPAD_DEAD) dirs.push(4); // Up
    if (ny >  DPAD_DEAD) dirs.push(5); // Down
    if (nx < -DPAD_DEAD) dirs.push(6); // Left
    if (nx >  DPAD_DEAD) dirs.push(7); // Right
    return dirs;
  }

  function applyDpadDirs(nextDirs) {
    const want = new Set(nextDirs);
    for (const btn of [4, 5, 6, 7]) {
      const on = want.has(btn);
      const was = dpadHeld[btn] > 0;
      if (on && !was) {
        dpadHeld[btn] = 1;
        if (emu) emu.key_down(btn);
        dpadBtnEls[btn]?.classList.add('tc-pressed');
      } else if (!on && was) {
        dpadHeld[btn] = 0;
        if (emu) emu.key_up(btn);
        dpadBtnEls[btn]?.classList.remove('tc-pressed');
      }
    }
  }

  function clearAllDpad() {
    applyDpadDirs([]);
  }

  function releaseTouch(t) {
    const entry = activeTouches.get(t.identifier);
    if (!entry) return;
    if (entry.kind === 'dpad') {
      clearAllDpad();
      activeTouches.delete(t.identifier);
      return;
    }
    entry.el?.classList.remove('tc-pressed');
    if (entry.idm || entry.romSplash) {
      activeTouches.delete(t.identifier);
      return;
    }
    if (emu && entry.btn !== undefined) emu.key_up(entry.btn);
    if (entry.btn === 3) maybeMirrorStartToSideB(false);
    activeTouches.delete(t.identifier);
  }

  tcContainer.addEventListener('touchstart', e => {
    e.preventDefault();
    resumeAudio();
    for (const t of e.changedTouches) {
      // Prefer whole D-pad zone (diagonals); then A/B/Start/Select.
      const onDpad = tcDpad && (
        t.target === tcDpad || tcDpad.contains(t.target)
      );
      if (onDpad) {
        // One finger owns the D-pad; extra pad touches are ignored.
        if ([...activeTouches.values()].some(v => v.kind === 'dpad')) continue;
        if (typeof idm !== 'undefined' && idm.open) {
          // Menu: discrete pad only (no diagonals needed).
          const dirs = dpadDirsFromPoint(t.clientX, t.clientY);
          const btn = dirs[0];
          if (btn !== undefined) idmHandlePad(btn, true);
          activeTouches.set(t.identifier, { kind: 'btn', btn, idm: true });
          continue;
        }
        applyDpadDirs(dpadDirsFromPoint(t.clientX, t.clientY));
        activeTouches.set(t.identifier, { kind: 'dpad' });
        continue;
      }

      const el = t.target.closest('[data-btn]');
      if (!el || el.closest('#tc-dpad')) continue;
      const btn = parseInt(el.dataset.btn, 10);
      el.classList.add('tc-pressed');
      if (typeof idm !== 'undefined' && idm.open) {
        idmHandlePad(btn, true);
        activeTouches.set(t.identifier, { kind: 'btn', el, btn, idm: true });
        continue;
      }
      // ROM cart splash: Start / Select / A open the lid.
      if (romSplashOpen) {
        romSplashHandlePad(btn, true);
        activeTouches.set(t.identifier, { kind: 'btn', el, btn, romSplash: true });
        continue;
      }
      if (emu) emu.key_down(btn);
      // Same dual splash mirror as keyboard Enter — without this, mobile 2P
      // Start on title fails (B still on splash) and both fall back to splash.
      if (btn === 3) maybeMirrorStartToSideB(true);
      activeTouches.set(t.identifier, { kind: 'btn', el, btn });
    }
  }, { passive: false });

  // Slide within the cross: hold Left then drag toward Down → Left+Down held.
  tcContainer.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const entry = activeTouches.get(t.identifier);
      if (!entry || entry.kind !== 'dpad') continue;
      if (typeof idm !== 'undefined' && idm.open) continue;
      applyDpadDirs(dpadDirsFromPoint(t.clientX, t.clientY));
    }
  }, { passive: false });

  tcContainer.addEventListener('touchend', e => {
    e.preventDefault();
    for (const t of e.changedTouches) releaseTouch(t);
  }, { passive: false });

  tcContainer.addEventListener('touchcancel', e => {
    for (const t of e.changedTouches) releaseTouch(t);
    // Nuclear option: clear everything if any touch is cancelled
    activeTouches.forEach((entry, id) => {
      if (entry.kind === 'dpad') {
        clearAllDpad();
      } else {
        entry.el?.classList.remove('tc-pressed');
        if (!entry.idm && emu && entry.btn !== undefined) emu.key_up(entry.btn);
        if (entry.btn === 3) maybeMirrorStartToSideB(false);
      }
      activeTouches.delete(id);
    });
    clearAllDpad();
  });
}

// === TEMP DEBUG HELPERS FOR MISDROP CLASSIFICATION STUDY (using bot's intention) ===
window.__dumpMisdropClassifications = async function() {
  const key = 'gbmul_misdrop_replays_v2';
  let list = [];
  try {
    const raw = localStorage.getItem(key);
    list = raw ? JSON.parse(raw) : [];
  } catch (e) { return {error: 'parse ' + e}; }
  console.log('[debug] classifying', list.length, 'misdrop replays using bot intention');

  const results = [];
  if (!emu || !rustBot || typeof emu.save_state !== 'function' || typeof emu.load_state !== 'function') {
    return {error: 'no emu/rustBot'};
  }

  const bytesFromBase64 = (b64) => {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const saved = emu.save_state();
    let info = { label: entry.label || '??', idx: i, intention: 'error', path: '[]' };
    try {
      const bytes = bytesFromBase64(entry.state);
      emu.load_state(bytes);

      // Reset bot cleanly (no suppress) so it plans normally for this spawn state
      rustBotReset();

      // Advance enough frames for the bot to see the piece and build its plan
      // (planning happens in handle_idle on ori change, then path is computed)
      for (let f = 0; f < 30; f++) {
        try { rustBot.tick(emu); } catch (e) {}
      }

      // Get the bot's intended path and classification per your rule
      let pathJson = '[]';
      let classification = 'unknown';
      const dbgPath = rustBot.debugGetMovePath || rustBot.debug_get_move_path;
      const dbgClass = rustBot.debugClassifyIntention || rustBot.debug_classify_intention;
      const dbgTgt = rustBot.debugGetTarget || rustBot.debug_get_target;
      try {
        if (typeof dbgPath === 'function') {
          pathJson = dbgPath.call(rustBot);
        }
        if (typeof dbgClass === 'function') {
          classification = dbgClass.call(rustBot);
        }
      } catch (e) {}

      info.path = pathJson;
      info.intention = classification;

      // Also get target for context
      try {
        if (typeof dbgTgt === 'function') {
          info.target = dbgTgt.call(rustBot);
        }
      } catch (e) {}

      const recorded = entry.meta?.misdrop;
      if (recorded) {
        info.recorded = {
          move_type: recorded.move_type,
          wanted: { col: recorded.wanted_col, rot: recorded.wanted_rot, row: recorded.wanted_row ?? null },
          actual: { col: recorded.actual_col, rot: recorded.actual_rot, row: recorded.actual_row ?? null },
          path: recorded.path || [],
        };
      }
      const rowFmt = (w, g) => (w != null || g != null) ? ` row${w ?? '?'}→${g ?? '?'}` : '';
      console.log(entry.label, '-> intention:', classification, 'path:', pathJson, recorded ? `(recorded: ${recorded.move_type} want c${recorded.wanted_col} rot${recorded.wanted_rot}${rowFmt(recorded.wanted_row, recorded.actual_row)} got c${recorded.actual_col} rot${recorded.actual_rot})` : '');
    } catch (e) {
      info.error = e.message;
    } finally {
      try { emu.load_state(saved); } catch {}
    }
    results.push(info);
    await new Promise(r => setTimeout(r, 3));
  }

  console.log('=== CLASSIFICATION BY BOT INTENTION COMPLETE ===');
  const summary = {};
  results.forEach(r => {
    const t = r.intention || 'error';
    summary[t] = (summary[t] || 0) + 1;
  });
  console.log('Summary by intention:', summary);
  console.table(results.map(r => ({label: r.label, intention: r.intention, path: r.path, target: r.target})));
  window.__lastMisdropDump = results;
  return { results, summary };
};

console.log('[debug] Misdrop classification dumper ready (intention-based). Call window.__dumpMisdropClassifications()');

