// www/texture.js — procedural paper-grain background texture
(function () {
  'use strict';

  const W = 512, H = 512;
  const TILE = 192; // display size in px
  let cachedLight = null;
  let cachedDark  = null;

  function fade(t) { return t * t * (3 - 2 * t); }

  // Hash two integers + seed → [0, 1)
  function hash(x, y, s) {
    let n = Math.imul(x ^ Math.imul(s, 2999), 0x9e3779b9)
          ^ Math.imul(y ^ Math.imul(s, 6271), 0x85ebca6b);
    n ^= n >>> 13;
    n  = Math.imul(n, 0x45d9f3b);
    n ^= n >>> 15;
    return (n >>> 0) / 0x100000000;
  }

  // Smooth value noise — P must be a power-of-2 cell period (ensures tileability)
  function vn(x, y, s, P) {
    const xi = Math.floor(x) | 0, yi = Math.floor(y) | 0;
    const u = fade(x - xi), v = fade(y - yi);
    const m = P - 1;
    return (
      hash( xi    & m,  yi    & m, s) * (1-u) * (1-v)
    + hash((xi+1) & m,  yi    & m, s) *    u  * (1-v)
    + hash( xi    & m, (yi+1) & m, s) * (1-u) *    v
    + hash((xi+1) & m, (yi+1) & m, s) *    u  *    v
    ) * 2 - 1; // → [-1, 1]
  }

  // fBm with automatic doubling of period per octave (keeps tiling intact)
  function fbm(x, y, s, octaves, P0) {
    let v = 0, a = 1, tot = 0, P = P0;
    for (let o = 0; o < octaves; o++) {
      v += vn(x, y, s + o * 17, P) * a;
      tot += a;
      a *= 0.5; x *= 2; y *= 2; P *= 2;
    }
    return v / tot; // → [-1, 1]
  }

  function generate(dark) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(W, H);
    const d = img.data;

    // Light base: ~(220,221,222)   Dark base: #1a1a2e = (26,26,46)
    const baseR = dark ? 26  : 220;
    const baseG = dark ? 26  : 221;
    const baseB = dark ? 46  : 222;
    const fineA  = dark ? 7 : 11;
    const broadA = dark ? 1 : 2;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const fine  = fbm(x * 0.5, y * 0.5, 7, 5, 256);
        const broad = fbm(x / 64,  y / 64,  31, 2, 8);
        const lum = fine * fineA + broad * broadA;
        const i = (y * W + x) * 4;
        d[i]   = Math.min(255, Math.max(0, (baseR + lum) | 0));
        d[i+1] = Math.min(255, Math.max(0, (baseG + lum) | 0));
        d[i+2] = Math.min(255, Math.max(0, (baseB + lum) | 0));
        d[i+3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  function apply() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const b = document.body;
    if (dark) {
      if (!cachedDark) cachedDark = generate(true);
      b.style.backgroundImage  = `url(${cachedDark})`;
    } else {
      if (!cachedLight) cachedLight = generate(false);
      b.style.backgroundImage  = `url(${cachedLight})`;
    }
    b.style.backgroundSize   = `${TILE}px ${TILE}px`;
    b.style.backgroundRepeat = 'repeat';
  }

  // Script is placed at bottom of <body>, so document.body is available immediately
  apply();

  // Re-apply when dark/light theme toggles
  new MutationObserver(apply)
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
