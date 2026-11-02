/* =====================================================================
   Platformer Studio — pixel painting engine
   Paints tile art, either on the tile sheet or directly on the platform
   in the level. Both change the same sheet, so every matching tile on the
   map updates live.

   Sheets can be 128, 256, 512 or 1024 pixels wide. The map always shows a
   tile in the same space, so a surface is painted in "art pixels": world
   position times the sheet's scale (its width / 128).

   Soft brush edges come in two kinds:
   • Dither (default): an ordered pattern, so every pixel stays an exact
     palette colour and the art stays true pixel art.
   • Fade: real transparency, which blends into in-between colours.
   A stroke tracks how strongly each pixel has been covered, so going over
   the same spot in one stroke never builds up.

   The Heal brush marks an area while you drag and rebuilds it on release:
   see heal.js. Empty pixels it covers are filled in too, unless "keep
   inside" protects them.

   A custom brush (see brushes.js) stamps an uploaded shape along the
   stroke, with its own spacing, scatter and random changes per stamp. A
   stamp with a random colour lies on top of the ones before it, rather
   than joining them in one even coat. In Dither mode that colour is the
   nearest in the palette, so the art stays true pixel art.
   ===================================================================== */
(function (PS) {
  'use strict';

  const T = PS.TILE;
  const st = PS.state;
  const { MASK_AT, ATLAS, FULL } = PS.Autotile;
  const Pal = PS.Palettes;
  const Br = PS.Brushes;

  const BRUSHES = [
    { key: 'round', name: 'Round', tip: 'Round: the everyday brush' },
    { key: 'square', name: 'Square', tip: 'Square: blocky shapes and clean edges' },
    { key: 'dither', name: 'Dither', tip: 'Dither: a checker pattern, for smooth shading between two colours' },
    { key: 'spray', name: 'Spray', tip: 'Spray: scattered pixels, for moss, dirt and speckles' },
    { key: 'texture', name: 'Texture', tip: 'Texture: mixes in the shades next to your colour, for rough surfaces' },
    { key: 'lighter', name: 'Lighter', tip: 'Lighter: makes painted pixels lighter, keeping their colour' },
    { key: 'darker', name: 'Darker', tip: 'Darker: makes painted pixels darker, keeping their colour' },
    { key: 'heal', name: 'Heal', tip: 'Heal (H): paint over a seam and release. The area is rebuilt with matching texture, so the seam is gone.' },
  ];

  /** Ordered-dither thresholds, used to fade soft brush edges without transparency. */
  const BAYER = [
    [0.0625, 0.5625, 0.1875, 0.6875],
    [0.8125, 0.3125, 0.9375, 0.4375],
    [0.25, 0.75, 0.125, 0.625],
    [1, 0.5, 0.875, 0.375],
  ];

  let stroke = null;
  let hoverPt = null;
  let lastWarn = 0;

  const MAX_HEAL_AREA = 4000000;
  const prefs = () => st.prefs.paint;
  const mod = (v, n) => ((v % n) + n) % n;
  const sheetSize = (ts) => { const c = PS.Assets.tilesetCanvas(ts); return c ? c.width : PS.Autotile.SHEET; };

  function warn(msg) {
    const now = performance.now();
    if (now - lastWarn < 2500) return;
    lastWarn = now;
    PS.UI.toast(msg, 'info', { duration: 3000 });
  }

  /* ------------------------------ Brush shape ------------------------------ */
  /** How strongly the brush covers an offset from its centre: 0 to 1. size and hard describe the brush. */
  function coverage(brush, dx, dy, size, hard, fade, px, py) {
    const r = Math.max(size / 2, 0.5);
    const square = brush === 'square';
    const dist = square ? Math.max(Math.abs(dx), Math.abs(dy)) / r : Math.hypot(dx, dy) / r;
    if (dist > (square ? 1.01 : 1 + 0.25 / Math.max(r, 1))) return 0;
    let a = 1;
    if (size > 1 && hard < 1) {
      const f = dist <= hard ? 1 : Math.max(0, (1 - dist) / (1 - hard));
      if (fade) a = f;
      else if (f < BAYER[py & 3][px & 3]) return 0;
    }
    if (brush === 'dither' && ((px + py) & 1)) return 0;
    return a;
  }

  /** How strongly a custom brush covers a pixel with mask strength v, 0 to 255.
   *  Full hardness gives a crisp shape; lower keeps more of the image's greys. */
  function maskCoverage(v, hard, fade, px, py) {
    if (!v) return 0;
    const k = v / 255;
    const low = hard / 2, high = 1 - hard / 2;
    const f = high <= low ? (k >= 0.5 ? 1 : 0) : PS.util.clamp((k - low) / (high - low), 0, 1);
    if (fade) return f;
    return f < BAYER[py & 3][px & 3] ? 0 : 1;
  }

  /* ------------------------------ Editing a sheet ------------------------------ */
  function editOf(ts) {
    let e = stroke.edits.get(ts);
    if (e) return e;
    const canvas = PS.Assets.tilesetCanvas(ts);
    if (!canvas) return null;
    const res = canvas.width;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, res, res);
    e = {
      ts, ctx, img, res, tile: res / 4,
      before: new ImageData(new Uint8ClampedArray(img.data), res, res),
      cover: new Uint8Array(res * res),
      x0: res, y0: res, x1: -1, y1: -1,         // area changed in this stroke
      fx0: res, fy0: res, fx1: -1, fy1: -1,     // area not yet sent to the canvas
    };
    stroke.edits.set(ts, e);
    return e;
  }

  function touch(e, x, y) {
    if (x < e.x0) e.x0 = x;
    if (y < e.y0) e.y0 = y;
    if (x > e.x1) e.x1 = x;
    if (y > e.y1) e.y1 = y;
    if (x < e.fx0) e.fx0 = x;
    if (y < e.fy0) e.fy0 = y;
    if (x > e.fx1) e.fx1 = x;
    if (y > e.fy1) e.fy1 = y;
  }

  function touchAll(e) {
    touch(e, 0, 0);
    touch(e, e.res - 1, e.res - 1);
  }

  /** Apply the current tool to one pixel of a sheet, at strength a. */
  function plot(ts, ax, ay, a) {
    const e = editOf(ts);
    if (!e) return;
    const { res, tile } = e;
    if (ax < 0 || ay < 0 || ax >= res || ay >= res) return;
    const mask = MASK_AT[Math.floor(ay / tile)][Math.floor(ax / tile)];
    if (mask === 0) return;                         // the Empty tile always stays empty
    if (prefs().inside && !(mask & (1 << ((ax % tile >= tile / 2 ? 1 : 0) + (ay % tile >= tile / 2 ? 2 : 0))))) return;

    const idx = ay * res + ax;
    const cover = Math.round(a * 255);
    if (!cover) return;
    const layered = !!stroke.dabRgb;                // a stamp with its own colour goes over the last one
    if (!layered && cover <= e.cover[idx]) return;  // already covered this strongly in this stroke
    e.cover[idx] = cover;

    const A = cover / 255;
    const i = idx * 4;
    const d = e.img.data, b = layered ? d : e.before.data;
    const br = b[i], bg = b[i + 1], bb = b[i + 2], ba = b[i + 3] / 255;
    touch(e, ax, ay);

    if (stroke.erase) {
      d[i] = br; d[i + 1] = bg; d[i + 2] = bb;
      d[i + 3] = Math.round(b[i + 3] * (1 - A));
      return;
    }
    const brush = stroke.brush;
    if (brush === 'lighter' || brush === 'darker') {
      if (ba === 0) return;
      const s = Pal.tone([br, bg, bb], brush === 'lighter' ? 1 : -1);
      d[i] = Math.round(br + (s[0] - br) * A);
      d[i + 1] = Math.round(bg + (s[1] - bg) * A);
      d[i + 2] = Math.round(bb + (s[2] - bb) * A);
      d[i + 3] = b[i + 3];
      return;
    }
    let s = stroke.dabRgb || stroke.rgb;
    if (brush === 'texture') {
      const roll = Math.random();
      if (roll >= 0.5) s = roll < 0.75 ? stroke.rgbLight : stroke.rgbDark;
    }
    const keep = ba * (1 - A);
    const out = A + keep;
    d[i] = Math.round((s[0] * A + br * keep) / out);
    d[i + 1] = Math.round((s[1] * A + bg * keep) / out);
    d[i + 2] = Math.round((s[2] * A + bb * keep) / out);
    d[i + 3] = Math.round(out * 255);
  }

  /** May this sheet pixel be changed? The Empty tile stays empty, and "keep inside" is respected. */
  function editable(e, ax, ay) {
    const { res, tile } = e;
    if (ax < 0 || ay < 0 || ax >= res || ay >= res) return false;
    const mask = MASK_AT[Math.floor(ay / tile)][Math.floor(ax / tile)];
    if (mask === 0) return false;
    return !prefs().inside || !!(mask & (1 << ((ax % tile >= tile / 2 ? 1 : 0) + (ay % tile >= tile / 2 ? 2 : 0))));
  }

  /** Rebuild everything the Heal stroke covered, as one step. */
  function finishHeal() {
    const h = stroke.heal;
    const { size } = prefs();
    const offset = (size - 1) / 2;
    const first = h.target;
    const scale = first.scale || 1;
    const margin = Math.ceil(size / 2) + 1;
    const xs = h.points.map((p) => p.x), ys = h.points.map((p) => p.y);
    const left = Math.min(...xs) - margin, top = Math.min(...ys) - margin;
    const right = Math.max(...xs) + margin, bottom = Math.max(...ys) + margin;
    // Enough art around the stroke to copy texture from: at least a tile and a half.
    const fitted = (room) => ({ x0: left - room, y0: top - room, w: right - left + 1 + room * 2, h: bottom - top + 1 + room * 2 });
    let region = fitted(Math.max(size * 2, Math.round(T * scale * 1.5)));
    if (region.w * region.h > MAX_HEAL_AREA) region = fitted(Math.round(T * scale * 0.75));
    if (region.w * region.h > MAX_HEAL_AREA) {
      warn('That stroke is too long to heal in one go. Try shorter strokes along each seam.');
      return;
    }
    const mask = new Uint8Array(region.w * region.h);
    for (const p of h.points) {
      const px0 = p.x - Math.floor(offset), py0 = p.y - Math.floor(offset);
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
        if (coverage('round', dx - offset, dy - offset, size, 1, true, 0, 0) <= 0) continue;
        const gx = px0 + dx - region.x0, gy = py0 + dy - region.y0;
        if (gx >= 0 && gy >= 0 && gx < region.w && gy < region.h) mask[gy * region.w + gx] = 1;
      }
    }
    const edits = (m) => editOf(m.ts);
    const results = PS.Heal.run({
      region, mask,
      map: (x, y) => first.healMap(x, y, h.cx, h.cy),
      read: (m) => {
        const e = edits(m);
        if (!e) return null;
        const i = (m.y * e.res + m.x) * 4, d = e.before.data;
        return [d[i], d[i + 1], d[i + 2], d[i + 3]];
      },
      canEdit: (m) => { const e = edits(m); return !!e && editable(e, m.x, m.y); },
      stride: Math.max(1, Math.round(scale)),
    });
    if (!results.length) {
      warn('Nothing to heal here. Try starting closer to some art.');
      return;
    }
    const fade = prefs().fade;
    const palette = stroke.palette;
    const memo = new Map();
    for (const px of results) {
      const e = editOf(px.ts);
      const i = (px.y * e.res + px.x) * 4;
      let r = PS.util.clamp(px.r, 0, 255), g = PS.util.clamp(px.g, 0, 255), b = PS.util.clamp(px.b, 0, 255), a = PS.util.clamp(px.a, 0, 255);
      if (!fade) {
        // Dither mode keeps to the palette: a slight pattern hides the steps between its colours.
        const spread = (BAYER[px.y & 3][px.x & 3] - 0.53) * 16;
        const key = (Math.round(PS.util.clamp(r + spread, 0, 255) / 4) << 12) | (Math.round(PS.util.clamp(g + spread, 0, 255) / 4) << 6) | Math.round(PS.util.clamp(b + spread, 0, 255) / 4);
        let m = memo.get(key);
        if (!m) { m = Pal.toRgb(Pal.nearest([r + spread, g + spread, b + spread], palette)); memo.set(key, m); }
        [r, g, b] = m;
        a = a < 128 ? 0 : 255;
      }
      const d = e.img.data;
      d[i] = Math.round(r); d[i + 1] = Math.round(g); d[i + 2] = Math.round(b); d[i + 3] = Math.round(a);
      touch(e, px.x, px.y);
    }
  }

  /** Stamp the brush at a point. target.map turns surface coordinates into a sheet pixel. */
  function dab(cx, cy, target) {
    const { size, hardness, fade } = prefs();
    const brush = stroke.brush;
    if (Br.isCustom(brush)) { stampCustom(cx, cy, target); return; }
    const hard = hardness / 100;
    const offset = (size - 1) / 2;
    const x0 = cx - Math.floor(offset), y0 = cy - Math.floor(offset);
    for (let py = y0; py < y0 + size; py++) {
      for (let px = x0; px < x0 + size; px++) {
        const a = coverage(brush, px - x0 - offset, py - y0 - offset, size, hard, fade, px, py);
        if (a <= 0) continue;
        if (brush === 'spray' && Math.random() > 0.22) continue;
        const m = target.map(px, py);
        if (m) plot(m.ts, m.x, m.y, a);
      }
    }
  }

  /** A number from -1 to 1, for changes that go either way. */
  const either = () => Math.random() * 2 - 1;

  /** This stamp's colour, when hue or brightness are random. */
  function stampColor() {
    const { hueJitter, lightJitter, fade } = prefs();
    if (!hueJitter && !lightJitter) return null;
    const rgb = Br.shift(stroke.rgb, either() * hueJitter, (either() * lightJitter) / 100);
    return fade ? rgb : Pal.toRgb(Pal.nearest(rgb, stroke.palette));
  }

  /** Stamp a custom brush around the pointer's position. */
  function stampCustom(cx, cy, target) {
    const pr = prefs();
    const brush = Br.get(stroke.brush);
    // Random size only shrinks, so a stamp never outgrows the brush outline.
    const size = Math.max(1, Math.round(pr.size * (1 - (Math.random() * pr.sizeJitter) / 100)));
    const stamp = Br.stamp(brush, size, either() * pr.angleJitter);
    const reach = (pr.size * pr.scatter) / 100;
    const turn = Math.random() * Math.PI * 2, far = Math.sqrt(Math.random()) * reach;
    const x0 = Math.round(cx + Math.cos(turn) * far) - Math.floor((stamp.w - 1) / 2);
    const y0 = Math.round(cy + Math.sin(turn) * far) - Math.floor((stamp.h - 1) / 2);
    const hard = pr.hardness / 100;
    stroke.dabRgb = stampColor();
    for (let y = 0; y < stamp.h; y++) {
      for (let x = 0; x < stamp.w; x++) {
        const px = x0 + x, py = y0 + y;
        const a = maskCoverage(stamp.mask[y * stamp.w + x], hard, pr.fade, px, py);
        if (a <= 0) continue;
        const m = target.map(px, py);
        if (m) plot(m.ts, m.x, m.y, a);
      }
    }
    stroke.dabRgb = null;
  }

  /** Stamps along a line, spaced by distance. The distance carries over between pointer moves,
   *  so the gaps stay even however slowly the pointer travels. */
  function stampLine(x0, y0, x1, y1, target) {
    const { size, spacing } = prefs();
    const gap = Math.max(1, (size * spacing) / 100);
    const dist = Math.hypot(x1 - x0, y1 - y0);
    let at = Math.max(0, gap - stroke.travel);      // the size can change mid-stroke, with [ and ]
    for (; at <= dist; at += gap) {
      const k = dist ? at / dist : 0;
      stampCustom(Math.round(x0 + (x1 - x0) * k), Math.round(y0 + (y1 - y0) * k), target);
    }
    stroke.travel = dist - (at - gap);
  }

  /** Dabs along a line. Big brushes overlap plenty with fewer dabs, which keeps them fast. */
  function line(x0, y0, x1, y1, target) {
    if (Br.isCustom(stroke.brush)) { stampLine(x0, y0, x1, y1, target); return; }
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const spacing = Math.max(1, Math.floor(prefs().size / 4));
    for (let k = spacing; k < steps; k += spacing) {
      dab(Math.round(x0 + ((x1 - x0) * k) / steps), Math.round(y0 + ((y1 - y0) * k) / steps), target);
    }
    dab(x1, y1, target);
  }

  /** Send painted pixels to the canvas, so the map and sheet update right away. */
  function flush() {
    if (!stroke) return;
    let any = false;
    for (const e of stroke.edits.values()) {
      if (e.fx1 < 0) continue;
      e.ctx.putImageData(e.img, 0, 0, e.fx0, e.fy0, e.fx1 - e.fx0 + 1, e.fy1 - e.fy0 + 1);
      e.fx0 = e.res; e.fy0 = e.res; e.fx1 = -1; e.fy1 = -1;
      e.ts.version = (e.ts.version || 0) + 1;
      any = true;
    }
    if (any) {
      PS.Renderer.invalidateTileset();
      PS.bus.emit('art');
    }
  }

  /** Copy part of a stroke's image, so undo only keeps what changed. */
  function slice(img, x0, y0, w, h) {
    const out = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      const from = ((y0 + y) * img.width + x0) * 4;
      out.data.set(img.data.subarray(from, from + w * 4), y * w * 4);
    }
    return out;
  }

  function sameData(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function saveSource(ts) {
    const canvas = PS.Assets.tilesetCanvas(ts);
    if (canvas) ts.src = canvas.toDataURL('image/png');
  }

  function afterArtChange(label) {
    PS.Renderer.invalidateTileset();
    if (label) PS.App.documentChanged('tiles');
    PS.bus.emit('art');
    PS.bus.emit('art-done');
  }

  /** Make the finished edit a single undo step. */
  function commit(label) {
    const s = stroke;
    if (!s) return;
    flush();
    stroke = null;
    const changes = [];
    let bytes = 0;
    for (const e of s.edits.values()) {
      if (e.x1 < 0) continue;
      const w = e.x1 - e.x0 + 1, h = e.y1 - e.y0 + 1;
      const before = slice(e.before, e.x0, e.y0, w, h), after = slice(e.img, e.x0, e.y0, w, h);
      if (sameData(before.data, after.data)) continue;
      changes.push({ ts: e.ts, x: e.x0, y: e.y0, before, after });
      bytes += before.data.length * 2;
    }
    if (!changes.length) return;
    for (const c of changes) saveSource(c.ts);
    const apply = (key) => {
      for (const c of changes) {
        const canvas = PS.Assets.tilesetCanvas(c.ts);
        if (!canvas) continue;
        canvas.getContext('2d', { willReadFrequently: true }).putImageData(c[key], c.x, c.y);
        c.ts.version = (c.ts.version || 0) + 1;
        saveSource(c.ts);
      }
    };
    PS.History.push({ label, scope: 'pixels', bytes, undo: () => apply('before'), redo: () => apply('after') });
    afterArtChange(label);
  }

  /* ------------------------------ What is under the pointer ------------------------------ */
  function layersToTry() {
    const p = st.project;
    const active = PS.Project.activeTileLayer();
    return [active, ...[...p.layers].reverse()].filter((l) => l && l.type === 'tiles' && l.visible);
  }

  /** A sheet pixel for a position on the level, in world units. */
  function sheetPixel(hit) {
    const ts = PS.Project.tileset(hit.tilesetId);
    if (!ts) return null;
    const res = sheetSize(ts);
    const scale = res / PS.Autotile.SHEET;
    const [col, row] = ATLAS[hit.mask];
    const tile = res / 4;
    return { ts, x: col * tile + Math.min(tile - 1, Math.floor(hit.lx * scale)), y: row * tile + Math.min(tile - 1, Math.floor(hit.ly * scale)) };
  }

  /** A flat surface of the level. Its coordinates are art pixels of the tileset under the pointer. */
  function worldSurface(layer, wx, wy, z, id) {
    const get = PS.Autotile.getter(layer);
    const ts = PS.Project.tileset(id);
    const scale = ts ? sheetSize(ts) / PS.Autotile.SHEET : 1;
    const map = (px, py) => {
      const ux = (px + 0.5) / scale, uy = (py + 0.5) / scale;
      if (!PS.Project.inBounds(Math.floor(ux / T), Math.floor(uy / T))) return null;
      const hit = PS.Autotile.pixelAt(get, ux, uy);
      return hit ? sheetPixel(hit) : null;
    };
    return {
      kind: 'world', layer, z, scale,
      x: Math.floor(wx * scale), y: Math.floor(wy * scale),
      map,
      // Which display tile a pixel belongs to: the cuts between these are what healing removes.
      healMap: (px, py) => {
        const m = map(px, py);
        if (!m) return null;
        const t = T * scale;
        m.cell = Math.floor((py + t / 2) / t) * 4096 + Math.floor((px + t / 2) / t);
        return m;
      },
    };
  }

  /** A side wall of an iso block shows the Middle tile, so paint lands there. */
  function wallSurface(layer, id, across, down, cellX, cellY, face, z) {
    const ts = PS.Project.tileset(id);
    const res = ts ? sheetSize(ts) : PS.Autotile.SHEET;
    const scale = res / PS.Autotile.SHEET, tile = res / 4;
    const [col, row] = ATLAS[FULL];
    return {
      kind: 'wall', layer, cellX, cellY, face, z, scale,
      x: Math.floor(across * scale), y: Math.floor(down * scale),
      // Every wall shows this one tile, so a brush reaching past the edge paints on around it.
      map: (px, py) => (ts ? { ts, x: col * tile + mod(px, tile), y: row * tile + mod(py, tile) } : null),
      // Walls repeat the same tile side by side and stacked, so healing wraps around it.
      healMap: (px, py) => (ts ? {
        ts, x: col * tile + mod(px, tile), y: row * tile + mod(py, tile),
        cell: Math.floor(py / tile) * 4096 + Math.floor(px / tile),
      } : null),
    };
  }

  /** The paintable surface at a point on the level canvas, or null. */
  function surfaceAt(pt) {
    const R = PS.Renderer;
    const w = R.screenToWorld(pt.x, pt.y);
    const wanted = stroke && stroke.layer;
    if (!PS.Iso.active()) {
      if (!PS.Project.inBounds(Math.floor(w.x / T), Math.floor(w.y / T))) return null;
      for (const layer of wanted ? [wanted] : layersToTry()) {
        const hit = PS.Autotile.pixelAt(PS.Autotile.getter(layer), w.x, w.y);
        if (hit) return worldSurface(layer, w.x, w.y, 0, hit.tilesetId);
      }
      return null;
    }
    const wld = PS.Iso.world();
    const hit = PS.Iso.pick(w.x, w.y, wld);
    if (hit.face === 'ground') {
      if (!PS.Project.inBounds(hit.x, hit.y)) return null;
      const layers = wanted && !wanted.solid ? [wanted] : [...wld.ground].reverse();
      for (const layer of layers) {
        const found = PS.Autotile.pixelAt(PS.Autotile.getter(layer), hit.ux, hit.uy);
        if (found) return worldSurface(layer, hit.ux, hit.uy, 0, found.tilesetId);
      }
      return null;
    }
    const i = PS.Project.idx(hit.x, hit.y);
    const span = wld.spans.find((s) => s.solid && s.layer.data[i] && hit.level * T >= s.z0 && hit.level * T < s.z1);
    if (!span) return null;
    if (hit.face === 'top') {
      const found = PS.Autotile.pixelAt(PS.Autotile.getter(span.layer), hit.ux, hit.uy);
      return found ? worldSurface(span.layer, hit.ux, hit.uy, hit.top, found.tilesetId) : null;
    }
    const across = hit.face === 'left' ? hit.ux - hit.x * T : T - (hit.uy - hit.y * T);
    const down = T - (hit.z - hit.level * T);
    return wallSurface(span.layer, span.layer.data[i], across, down, hit.x, hit.y, hit.face, hit.level);
  }

  /** The tile that continues a tile's shape in a direction (dx, dy of -1, 0 or 1). On the map, a tile's
   *  edge touches a tile whose near corners match; this one simply carries the same shape on. */
  function continuation(mask, dx, dy) {
    let m = mask;
    if (dx) {
      const top = m & (dx > 0 ? 2 : 1), bottom = m & (dx > 0 ? 8 : 4);
      m = (top ? 3 : 0) | (bottom ? 12 : 0);
    }
    if (dy) {
      const left = m & (dy > 0 ? 4 : 1), right = m & (dy > 0 ? 8 : 2);
      m = (left ? 5 : 0) | (right ? 10 : 0);
    }
    return m;
  }

  /* ------------------------------ Single-shot tools ------------------------------ */
  function pickColor(m) {
    const canvas = PS.Assets.tilesetCanvas(m.ts);
    if (!canvas) return;
    const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(m.x, m.y, 1, 1).data;
    if (px[3] < 128) return warn('That pixel is empty, so there is no colour to pick.');
    Paint.setColor(Pal.nearest([px[0], px[1], px[2]], Pal.active().colors));
  }

  /** Flood one colour area, staying inside the tile that was clicked. */
  function floodFill(m) {
    begin({ erase: false, label: 'Fill' });
    stroke.brush = 'round';
    const e = editOf(m.ts);
    if (!e) { stroke = null; return; }
    const { res, tile } = e;
    const d = e.img.data;
    const x0 = m.x - (m.x % tile), y0 = m.y - (m.y % tile);
    const si = (m.y * res + m.x) * 4;
    const r = d[si], g = d[si + 1], b = d[si + 2], a = d[si + 3];
    const seen = new Uint8Array(tile * tile);
    const todo = [m.y * res + m.x];
    const list = [];
    while (todo.length) {
      const idx = todo.pop();
      const x = idx % res, y = (idx - x) / res;
      if (x < x0 || y < y0 || x >= x0 + tile || y >= y0 + tile) continue;
      const k = (y - y0) * tile + x - x0;
      if (seen[k]) continue;
      const i = idx * 4;
      if (d[i + 3] !== a || (a !== 0 && (d[i] !== r || d[i + 1] !== g || d[i + 2] !== b))) continue;
      seen[k] = 1;
      list.push(x, y);
      todo.push(idx + 1, idx - 1, idx + res, idx - res);
    }
    for (let k = 0; k < list.length; k += 2) plot(m.ts, list[k], list[k + 1], 1);
    commit('Fill area');
  }

  function begin({ erase, label, layer = null }) {
    const color = st.paintColor;
    const wanted = prefs().brush;
    stroke = {
      erase, label, layer, brush: Br.isCustom(wanted) && !Br.get(wanted) ? 'round' : wanted, color, palette: Pal.active().colors,
      rgb: Pal.toRgb(color), rgbLight: Pal.toRgb(Pal.step(color, 1)), rgbDark: Pal.toRgb(Pal.step(color, -1)),
      edits: new Map(), last: null, travel: 0, dabRgb: null,
    };
  }

  /** Start painting on a surface. */
  function startOn(target, e) {
    const tool = e.altKey ? 'picker' : prefs().tool;
    const m = target.map(target.x, target.y);
    if (tool === 'picker') { if (m) pickColor(m); return false; }
    if (tool === 'fill') { if (m) floodFill(m); return false; }
    const erase = tool === 'eraser' || e.button === 2;
    const label = erase ? 'Erase pixels' : prefs().brush === 'heal' ? 'Heal seam' : 'Paint pixels';
    begin({ erase, label, layer: target.layer || null });
    if (erase) stroke.brush = 'round';
    if (stroke.brush === 'heal') {
      // Healing works on the whole stroke at once, when the button is released.
      stroke.heal = { target, cx: target.x, cy: target.y, points: [{ x: target.x, y: target.y }] };
      return true;
    }
    dab(target.x, target.y, target);
    stroke.last = target;
    flush();
    return true;
  }

  function continueOn(target) {
    if (!stroke || !target) return;
    if (stroke.heal) {
      const h = stroke.heal;
      if (target.kind !== h.target.kind || target.scale !== h.target.scale) return;
      if (target.kind === 'wall' && (target.cellX !== h.target.cellX || target.cellY !== h.target.cellY || target.face !== h.target.face || target.z !== h.target.z)) return;
      const end = h.points[h.points.length - 1];
      const steps = Math.max(Math.abs(target.x - end.x), Math.abs(target.y - end.y));
      const spacing = Math.max(1, Math.floor(prefs().size / 4));
      for (let k = spacing; k < steps; k += spacing) {
        h.points.push({ x: Math.round(end.x + ((target.x - end.x) * k) / steps), y: Math.round(end.y + ((target.y - end.y) * k) / steps) });
      }
      if (steps) h.points.push({ x: target.x, y: target.y });
      PS.bus.emit('art');
      return;
    }
    const last = stroke.last;
    const sameFace = last && last.kind === target.kind && last.scale === target.scale
      && (target.kind !== 'wall' || (last.cellX === target.cellX && last.cellY === target.cellY && last.face === target.face && last.z === target.z));
    if (sameFace) line(last.x, last.y, target.x, target.y, target);
    else {
      dab(target.x, target.y, target);
      stroke.travel = 0;
    }
    stroke.last = target;
    flush();
  }

  const Paint = {
    BRUSHES,
    sheetSize,

    get stroking() { return !!stroke; },

    /** The largest brush for a sheet: 16 art pixels on a 128 sheet, in proportion on bigger ones. */
    maxSize(res) { return 16 * Math.max(1, Math.round(res / PS.Autotile.SHEET)); },

    setColor(hex) {
      st.paintColor = hex;
      PS.bus.emit('paint-ui');
    },

    setTool(tool) {
      prefs().tool = tool;
      PS.savePrefs();
      PS.bus.emit('paint-ui');
      PS.Renderer.request();
    },

    setBrush(key) {
      prefs().brush = key;
      prefs().tool = 'brush';
      PS.savePrefs();
      PS.bus.emit('paint-ui');
    },

    setSize(v, max = 128) {
      prefs().size = PS.util.clamp(Math.round(v), 1, max);
      PS.savePrefs();
      PS.bus.emit('paint-ui');
      PS.Renderer.request();
    },

    setHardness(v) {
      prefs().hardness = PS.util.clamp(v, 0, 100);
      PS.savePrefs();
    },

    /** Soft edges: true blends with real transparency, false keeps to a palette-only dither. */
    setFade(on) {
      const pr = prefs();
      pr.fade = !!on;
      // A hard or tiny brush would show no difference, which would look like the switch did nothing.
      if (on && pr.hardness >= 100) pr.hardness = 40;
      if (on && pr.size < 8) pr.size = 8;
      PS.savePrefs();
      PS.bus.emit('paint-ui');
    },

    /** Spacing, scatter or a random amount, for custom brushes. */
    setDynamic(key, v) {
      prefs()[key] = v;
      PS.savePrefs();
    },

    /** Add brushes from image files and select the last one. */
    async addBrushes(files) {
      let added = null;
      const failed = [];
      for (const file of files) {
        if (Br.list().length >= Br.MAX_BRUSHES) {
          PS.UI.toast(`You can keep up to ${Br.MAX_BRUSHES} custom brushes. Remove one to add another.`, 'error');
          break;
        }
        try {
          if (!PS.util.isImageFile(file)) throw new Error('type');
          const img = await PS.util.loadImage(await PS.util.readAsDataURL(file));
          const brush = Br.add(img, PS.util.fileBase(file.name));
          if (!brush) throw new Error('empty');
          added = brush;
        } catch (e) {
          failed.push(file.name);
        }
      }
      if (failed.length) PS.UI.toast(`No brush shape found in ${failed.join(', ')}. Use a black and white image.`, 'error');
      if (added) Paint.setBrush(Br.keyOf(added));
    },

    removeBrush(brush) {
      const selected = prefs().brush === Br.keyOf(brush);
      Br.remove(brush);
      if (selected) Paint.setBrush('round');
      else PS.bus.emit('paint-ui');
    },

    invertBrush(brush) {
      if (!Br.invert(brush)) return warn('This shape fills its whole image, so inverting it would leave nothing to paint.');
      PS.bus.emit('paint-ui');
    },

    /** The brush footprint for the little preview: [x, y, strength] per pixel. */
    previewPixels(size, hardness, brush, fade = false) {
      const out = [];
      if (Br.isCustom(brush)) {
        const custom = Br.get(brush);
        if (!custom) return out;
        const stamp = Br.stamp(custom, size);
        const ox = Math.floor((size - stamp.w) / 2), oy = Math.floor((size - stamp.h) / 2);
        for (let y = 0; y < stamp.h; y++) for (let x = 0; x < stamp.w; x++) {
          const a = maskCoverage(stamp.mask[y * stamp.w + x], hardness / 100, fade, x, y);
          if (a > 0) out.push([x + ox, y + oy, a]);
        }
        return out;
      }
      const offset = (size - 1) / 2;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const a = coverage(brush, x - offset, y - offset, size, hardness / 100, fade, x, y);
        if (a > 0) out.push([x, y, a]);
      }
      return out;
    },

    /* ------------------------------ Tile sheet canvas ------------------------------ */
    sheetTarget(ts, x, y) {
      const res = sheetSize(ts), tile = res / 4;
      const tileOf = (v) => Math.floor(v / tile);
      return {
        kind: 'sheet', x, y, scale: res / PS.Autotile.SHEET,
        // A brush paints every tile it touches. plot() keeps out the Empty tile and respects "keep inside".
        map: (px, py) => ({ ts, x: px, y: py }),
        // Sheet tiles aren't neighbours on the map. Healing sees past a tile's edge to the tile that
        // continues it there, and rebuilds both, so the seam is gone wherever those two meet.
        healMap: (px, py, cx, cy) => {
          const col = tileOf(cx), row = tileOf(cy);
          const dx = tileOf(px) - col, dy = tileOf(py) - row;
          const mask = MASK_AT[row][col];
          const cell = tileOf(py) * 4096 + tileOf(px);
          if (!dx && !dy) return mask ? { ts, x: px, y: py, cell } : null;
          const next = continuation(mask, Math.sign(dx), Math.sign(dy));
          if (!next) return null;
          const [nc, nr] = ATLAS[next];
          return { ts, x: nc * tile + mod(px, tile), y: nr * tile + mod(py, tile), cell };
        },
      };
    },

    sheetDown(ts, x, y, e) {
      const tile = sheetSize(ts) / 4;
      if (MASK_AT[Math.floor(y / tile)][Math.floor(x / tile)] === 0 && !e.altKey) {
        warn('This is the Empty tile. It is never drawn, so it can’t be painted.');
        return false;
      }
      return startOn(Paint.sheetTarget(ts, x, y), e);
    },

    sheetMove(ts, x, y) { continueOn(Paint.sheetTarget(ts, x, y)); },

    /* ------------------------------ Level canvas ------------------------------ */
    canvasDown(pt, e) {
      hoverPt = pt;
      const target = surfaceAt(pt);
      if (!target) {
        warn('There is no tile here to paint. Paint on a platform, or on the tile sheet next to the level.');
        return;
      }
      startOn(target, e);
    },

    canvasMove(pt) {
      hoverPt = pt;
      if (stroke) continueOn(surfaceAt(pt));
      PS.Renderer.request();
    },

    canvasLeave() {
      hoverPt = null;
      PS.Renderer.request();
    },

    /** Finish whichever stroke is running. */
    up() {
      if (!stroke) return;
      if (stroke.heal) finishHeal();
      commit(stroke.label);
    },

    /** The area marked so far by a Heal stroke: brush-sized squares, for showing it while dragging. */
    healTrail() {
      if (!stroke || !stroke.heal) return null;
      return { kind: stroke.heal.target.kind, scale: stroke.heal.target.scale, z: stroke.heal.target.z, size: prefs().size, points: stroke.heal.points };
    },

    /** Abandon the current stroke and put the pixels back. */
    cancel() {
      if (!stroke) return false;
      for (const e of stroke.edits.values()) {
        e.ctx.putImageData(e.before, 0, 0);
        e.ts.version = (e.ts.version || 0) + 1;
      }
      stroke = null;
      PS.Renderer.invalidateTileset();
      PS.bus.emit('art');
      return true;
    },

    /** Show where the brush will land on the level. */
    drawCursor(ctx) {
      const R = PS.Renderer;
      const trail = Paint.healTrail();
      if (trail && trail.kind === 'world') {
        const half = Math.floor((trail.size - 1) / 2), k = trail.scale, s0 = R.scale, c0 = R.view;
        ctx.fillStyle = 'rgba(139, 123, 255, 0.38)';
        ctx.beginPath();
        for (const p of trail.points) {
          const x = (p.x - half) / k, y = (p.y - half) / k, w = trail.size / k;
          if (PS.Iso.active()) {
            const pts = [[x, y], [x + w, y], [x + w, y + w], [x, y + w]].map(([u, v]) => { const q = PS.Iso.project(u, v, trail.z); return [q.x, q.y]; });
            pts.forEach(([u, v], i) => { const sx = (u - c0.x) * s0, sy = (v - c0.y) * s0; if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
            ctx.closePath();
          } else {
            ctx.rect((x - c0.x) * s0, (y - c0.y) * s0, w * s0, w * s0);
          }
        }
        ctx.fill();
      }
      if (!hoverPt) return;
      const target = surfaceAt(hoverPt);
      if (!target) return;
      const size = prefs().size;
      const offset = Math.floor((size - 1) / 2);
      const d = R.dpr, s = R.scale, cam = R.view, k = target.scale;
      ctx.beginPath();
      if (target.kind === 'wall') {
        const m = Math.max(4 * d, (size / k) * s * 0.5);
        const c = R.screenToWorld(hoverPt.x, hoverPt.y);
        const sx = (c.x - cam.x) * s, sy = (c.y - cam.y) * s;
        ctx.rect(sx - m, sy - m, m * 2, m * 2);
      } else if (PS.Iso.active()) {
        const x0 = (target.x - offset) / k, y0 = (target.y - offset) / k, w = size / k;
        const pts = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + w], [x0, y0 + w]].map(([x, y]) => {
          const q = PS.Iso.project(x, y, target.z);
          return [q.x, q.y];
        });
        PS.Iso.tracePolygon(ctx, pts, { camX: cam.x, camY: cam.y, s });
      } else {
        const x0 = Math.round(((target.x - offset) / k - cam.x) * s), y0 = Math.round(((target.y - offset) / k - cam.y) * s);
        ctx.rect(x0 + 0.5, y0 + 0.5, Math.max(1, Math.round((size / k) * s) - 1), Math.max(1, Math.round((size / k) * s) - 1));
      }
      ctx.lineWidth = 3 * d;
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.stroke();
      ctx.lineWidth = Math.max(1, d);
      ctx.strokeStyle = prefs().tool === 'eraser' ? R.theme.danger : '#fff';
      ctx.stroke();
    },

    /* ------------------------------ Whole-tile actions ------------------------------ */
    /** Run `fn(data, res)` on a sheet's pixels as one undo step. */
    editSheet(ts, label, fn) {
      if (stroke) return;
      begin({ erase: false, label });
      const e = editOf(ts);
      if (!e) { stroke = null; return; }
      fn(e.img.data, e.res);
      touchAll(e);
      commit(label);
    },

    copyTile(ts, col, row) {
      const canvas = PS.Assets.tilesetCanvas(ts);
      if (!canvas) return null;
      const t = canvas.width / 4;
      return canvas.getContext('2d', { willReadFrequently: true }).getImageData(col * t, row * t, t, t);
    },

    /** Paste a copied tile. A tile copied from a sheet of another resolution is resized to fit. */
    pasteTile(ts, col, row, tile) {
      Paint.editSheet(ts, 'Paste tile', (d, res) => {
        const t = res / 4;
        for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) {
          const sx = Math.floor((x * tile.width) / t), sy = Math.floor((y * tile.height) / t);
          const si = (sy * tile.width + sx) * 4, di = ((row * t + y) * res + col * t + x) * 4;
          for (let k = 0; k < 4; k++) d[di + k] = tile.data[si + k];
        }
      });
    },

    transformTile(ts, col, row, label, pick) {
      const copy = Paint.copyTile(ts, col, row);
      if (!copy) return;
      Paint.editSheet(ts, label, (d, res) => {
        const t = res / 4;
        for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) {
          const [sx, sy, clear] = pick(x, y, t);
          const si = (sy * t + sx) * 4, di = ((row * t + y) * res + col * t + x) * 4;
          if (clear) { d[di + 3] = 0; continue; }
          for (let k = 0; k < 4; k++) d[di + k] = copy.data[si + k];
        }
      });
    },

    /** Replace a whole sheet with new art of any resolution, as one undo step. */
    replaceArt(ts, canvas, label) {
      const old = { canvas: PS.Assets.tilesetCanvas(ts), src: ts.src };
      const next = { canvas, src: canvas.toDataURL('image/png') };
      const use = (v) => {
        ts.canvas = v.canvas;
        ts.src = v.src;
        ts.version = (ts.version || 0) + 1;
      };
      use(next);
      const bytes = (canvas.width * canvas.height + (old.canvas ? old.canvas.width * old.canvas.height : 0)) * 4;
      PS.History.push({ label, scope: 'pixels', bytes, undo: () => use(old), redo: () => use(next) });
      afterArtChange(label);
    },

    /** Recolour tilesets with their nearest palette colours, as one undo step. */
    snapToPalette(list, label = 'Match palette') {
      if (stroke) return 0;
      begin({ erase: false, label });
      const colors = Pal.active().colors;
      let n = 0;
      for (const ts of list) {
        const e = editOf(ts);
        if (!e) continue;
        const copy = PS.Sprites.canvas(e.res, e.res);
        const ctx = copy.getContext('2d', { willReadFrequently: true });
        ctx.putImageData(e.img, 0, 0);
        if (Pal.snapCanvas(copy, colors)) {
          e.img = ctx.getImageData(0, 0, e.res, e.res);
          touchAll(e);
          n++;
        }
      }
      commit(label);
      return n;
    },
  };

  PS.Paint = Paint;
})(window.PS);
