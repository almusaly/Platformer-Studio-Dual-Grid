/* =====================================================================
   Platformer Studio — dual-grid tile sheet generator
   Builds complete 16-tile sheets from a few colours, so no external art
   tool is needed. Also provides the blank template and converts classic
   3 × 3 tilesets (from older projects and uploads) to the dual layout.
   ===================================================================== */
(function (PS) {
  'use strict';

  const T = PS.TILE;
  const SHEET = T * 4;
  const hash = PS.util.hash2;
  const { ATLAS } = PS.Autotile;
  const canvas = (w = SHEET, h = SHEET) => PS.Sprites.canvas(w, h);

  /** How a pixel of a dual tile relates to the shape. Returns null when it is outside the shape.
   *  The shape's edges run along the tile's centre lines, so distances are measured from there. */
  function shapeAt(mask, x, y, radius) {
    const qx = x >= T / 2 ? 1 : 0, qy = y >= T / 2 ? 1 : 0;
    if (!(mask & (1 << (qx + 2 * qy)))) return null;
    const hOpen = !(mask & (1 << (1 - qx + 2 * qy)));
    const vOpen = !(mask & (1 << (qx + 2 * (1 - qy))));
    const dOpen = !(mask & (1 << (1 - qx + 2 * (1 - qy))));
    const ex = qx ? x - T / 2 : T / 2 - x;
    const ey = qy ? y - T / 2 : T / 2 - y;
    if (hOpen && vOpen && ex < radius && ey < radius) {
      const ax = radius - ex, ay = radius - ey;
      if (ax * ax + ay * ay > radius * radius + 0.5) return null;
    }
    const dx = Math.floor(ex), dy = Math.floor(ey);
    let top = Infinity, bottom = Infinity, left = Infinity, right = Infinity;
    if (vOpen) { if (qy) top = dy; else bottom = dy; }
    if (hOpen) { if (qx) left = dx; else right = dx; }
    if (dOpen && !hOpen && !vOpen) {
      const inner = Math.max(dx, dy);
      if (qy) top = inner; else bottom = inner;
    }
    return { top, bottom, left, right, side: Math.min(left, right), edge: Math.min(top, bottom, left, right) };
  }

  /* ------------------------------ Styles ------------------------------
     colors: top, topLight, topDark (the surface) and body, bodyLight, bodyDark, line. */
  const body = {
    noise(c, x, y, s) {
      const n = hash(x, y);
      if (s.edge < 1) return c.line;
      if (s.edge < 3) return c.bodyDark;
      if (n > 0.93) return c.bodyDark;
      if (n < 0.06) return c.bodyLight;
      return hash(x >> 2, y >> 2) > 0.85 ? c.bodyDark : c.body;
    },
    bricks(c, x, y, s) {
      if (s.edge < 1) return c.line;
      const row = Math.floor(y / 8), bx = (x + (row % 2) * 8) % 16;
      if (y % 8 === 0 || bx === 0) return c.bodyDark;
      if (y % 8 === 1 || bx === 1) return c.bodyLight;
      return hash(Math.floor((x + (row % 2) * 8) / 16), row) > 0.7 && hash(x, y) > 0.5 ? c.bodyLight : c.body;
    },
    streaks(c, x, y, s) {
      if (s.edge < 1) return c.line;
      if (s.edge < 3) return c.body;
      if ((x + y) % 16 < 2 && (x + y) % 32 < 16) return c.bodyLight;
      return hash(x, y) > 0.95 ? c.bodyLight : y > 20 ? c.bodyDark : c.body;
    },
    planks(c, x, y, s) {
      if (s.edge < 1) return c.line;
      if (y % 8 === 0) return c.bodyDark;
      if (y % 8 === 1) return c.bodyLight;
      if ((x + Math.floor(y / 8) * 11) % 32 === 0) return c.bodyDark;
      return hash(Math.floor(x / 4), y >> 3) > 0.8 ? c.bodyLight : c.body;
    },
    plain(c, x, y, s) {
      if (s.edge < 1) return c.line;
      if (s.top < 2 || s.left < 2) return c.bodyLight;
      if (s.bottom < 3 || s.right < 3) return c.bodyDark;
      return c.body;
    },
  };

  const cap = {
    /** Grass with an uneven lower edge and a bright top. */
    grass(c, x, y, s) {
      const depth = 6 + Math.floor(hash(x, 7) * 3);
      if (s.top >= depth) return null;
      if (s.side < 1 || s.top === 0) return c.topDark;
      if (s.top === depth - 1) return c.topDark;
      const n = hash(x, y);
      if (s.top < 3) return n > 0.6 ? c.topLight : c.top;
      return n > 0.85 ? c.topLight : c.top;
    },
    /** Snow: a thick smooth layer. */
    snow(c, x, y, s) {
      const depth = 4 + Math.floor(hash(x >> 1, 3) * 3);
      if (s.top >= depth) return null;
      if (s.top === 0 || s.side < 1) return c.topDark;
      return hash(x, y) > 0.8 ? c.topDark : c.topLight;
    },
    /** A thin bright rim, as on cut stone. */
    rim(c, x, y, s) {
      if (s.top === 0) return c.line;
      if (s.top < 3) return s.side < 1 ? c.line : c.top;
      return null;
    },
    none: () => null,
  };

  const STYLES = {
    grass: { name: 'Grass', cap: 'grass', body: 'noise', radius: 4, targets: { top: '#63c74d', body: '#b86f50' } },
    stone: { name: 'Stone', cap: 'rim', body: 'bricks', radius: 3, targets: { top: '#c0cbdc', body: '#8b9bb4' } },
    snow: { name: 'Snow', cap: 'snow', body: 'streaks', radius: 5, targets: { top: '#ffffff', body: '#0099db' } },
    wood: { name: 'Wood', cap: 'rim', body: 'planks', radius: 2, targets: { top: '#e4a672', body: '#b86f50' } },
    smooth: { name: 'Smooth', cap: 'none', body: 'plain', radius: 4, targets: { top: '#feae34', body: '#f77622' } },
    meadow: { name: 'Meadow', cap: 'none', body: 'noise', radius: 3, targets: { top: '#63c74d', body: '#63c74d' } },
  };

  /** Work out the shades of a style from two chosen colours, staying on the palette. */
  function shadesFor(top, bodyColor, colors) {
    const P = PS.Palettes;
    const bodyDark = P.step(bodyColor, -1, colors);
    return {
      top, topLight: P.step(top, 1, colors), topDark: P.step(top, -1, colors),
      body: bodyColor, bodyLight: P.step(bodyColor, 1, colors), bodyDark,
      line: P.step(bodyDark, -1, colors),
    };
  }

  /** colorAt receives a position in the 32-unit tile space, whatever the resolution. */
  function paintSheet(colorAt, res = SHEET) {
    const c = canvas(res, res);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(res, res);
    const rgb = new Map();
    const scale = res / SHEET, tile = res / 4;
    for (let mask = 1; mask < 16; mask++) {
      const [col, row] = ATLAS[mask];
      for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
        const hex = colorAt(mask, (x + 0.5) / scale, (y + 0.5) / scale);
        if (!hex) continue;
        let v = rgb.get(hex);
        if (!v) { v = PS.Palettes.toRgb(hex); rgb.set(hex, v); }
        const i = ((row * tile + y) * res + col * tile + x) * 4;
        img.data[i] = v[0]; img.data[i + 1] = v[1]; img.data[i + 2] = v[2]; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  const Tilegen = {
    STYLES,

    /** A finished sheet in a style, from two main colours chosen on a palette. */
    generate(styleKey, top, bodyColor, colors, res = SHEET) {
      const style = STYLES[styleKey] || STYLES.smooth;
      const shades = shadesFor(top, bodyColor, colors);
      const capFn = cap[style.cap], bodyFn = body[style.body];
      return paintSheet((mask, x, y) => {
        const s = shapeAt(mask, x, y, style.radius);
        if (!s) return null;
        const ix = Math.floor(x), iy = Math.floor(y);
        return capFn(shades, ix, iy, s) || bodyFn(shades, ix, iy, s);
      }, res);
    },

    /** The two main colours a style should start with on a palette. */
    suggest(styleKey, colors) {
      const t = (STYLES[styleKey] || STYLES.smooth).targets;
      const P = PS.Palettes;
      return { top: P.nearest(P.toRgb(t.top), colors), body: P.nearest(P.toRgb(t.body), colors) };
    },

    /** Empty sheet that shows only where each tile's shape goes: the template to paint on or download. */
    template(color = '#ff396a') {
      return paintSheet((mask, x, y) => (shapeAt(mask, x, y, 0) ? color : null));
    },

    /** A blank sheet to paint on from scratch. */
    blank(res = SHEET) { return canvas(res, res); },

    /** Convert a classic 96 × 96, 3 × 3 tileset: each corner of a dual tile takes the matching quarter. */
    fromClassic(img) {
      const c = canvas();
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const Q = T / 2;
      for (let mask = 1; mask < 16; mask++) {
        const [col, row] = ATLAS[mask];
        for (let q = 0; q < 4; q++) {
          if (!(mask & (1 << q))) continue;
          const qx = q & 1, qy = q >> 1;
          const hOpen = !(mask & (1 << ((1 - qx) + 2 * qy)));
          const vOpen = !(mask & (1 << (qx + 2 * (1 - qy))));
          const sc = hOpen ? (qx ? 0 : 2) : 1;
          const sr = vOpen ? (qy ? 0 : 2) : 1;
          ctx.drawImage(img, sc * T + (1 - qx) * Q, sr * T + (1 - qy) * Q, Q, Q, col * T + qx * Q, row * T + qy * Q, Q, Q);
        }
      }
      return c;
    },

    /** The three tilesets every new project starts with, using the default palette. */
    starters() {
      if (!starterCache) {
        const colors = PS.Palettes.BUILTIN[0].colors;
        const make = (name, style) => {
          const s = Tilegen.suggest(style, colors);
          return { name, src: Tilegen.generate(style, s.top, s.body, colors).toDataURL('image/png') };
        };
        starterCache = [make('Grass', 'grass'), make('Stone', 'stone'), make('Ice', 'snow')];
      }
      return starterCache;
    },
  };
  let starterCache = null;

  PS.Tilegen = Tilegen;
})(window.PS);
