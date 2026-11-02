/* =====================================================================
   Platformer Studio — isometric view
   In iso mode the map is a floor plan seen from above at an angle:
   x runs to the lower right, y to the lower left, z straight up.

   • Art: nothing extra to draw. The same 16-tile sheet is projected onto
     2:1 diamonds, and blocks use the Middle tile for their side walls,
     with shading snapped back onto the active palette (with block shadows
     on, shading only darkens and keeps every hue). High-resolution
     sheets keep their detail here too.
   • Solid layers are raised blocks. Other layers lie flat on the ground.
   • Every cell's top is drawn as four quarter-diamonds, one from each of
     the four dual-grid display tiles it touches, so walls, tops and
     characters can all be depth-sorted cell by cell.
   • Blocks cast shadows from a sun. Each surface finds the blocks between
     it and the sun, and repaints the part they cover with darkened art.
   ===================================================================== */
(function (PS) {
  'use strict';

  const T = PS.TILE;
  const Q = T / 2;
  const { FULL, ATLAS } = PS.Autotile;
  const st = PS.state;
  const P = () => st.project;
  const LEFT_SHADE = 0.82, RIGHT_SHADE = 0.62;
  const MAX_LEVELS = 16;

  const atlases = new Map();   // tileset id -> { sig, quads, left, right }
  let shadowCache = null;
  let castCache = null;        // the shadows of the current blocks and sun

  /* ------------------------------ Projected art ------------------------------ */
  /** quads: one quarter-diamond per mask and quadrant. left/right: sheared walls of the Middle tile.
   *  Built at the sheet's own resolution (S times the base size), so detail is kept. */
  function buildAtlas(ts) {
    const srcCanvas = PS.Assets.tilesetCanvas(ts);
    if (!srcCanvas) return null;
    const res = srcCanvas.width, S = res / (T * 4), tile = res / 4;
    const src = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, res, res).data;
    const qw = T * S, qh = Q * S;
    const quads = PS.Sprites.canvas(qw * 4, qh * 16);
    const qctx = quads.getContext('2d');
    const qimg = qctx.createImageData(quads.width, quads.height);
    const out = qimg.data;
    for (let mask = 1; mask < 16; mask++) {
      const [col, row] = ATLAS[mask];
      for (let q = 0; q < 4; q++) {
        const qx = q & 1, qy = q >> 1;
        for (let j = 0; j < qh; j++) for (let i = 0; i < qw; i++) {
          const sx = (i + 0.5) / S - Q, sy = (j + 0.5) / S;
          const u = sy + sx / 2, v = sy - sx / 2;
          if (u < 0 || v < 0 || u >= Q || v >= Q) continue;
          const si = (((row * tile + qy * tile / 2 + Math.floor(v * S)) * res) + col * tile + qx * tile / 2 + Math.floor(u * S)) * 4;
          const oi = ((mask * qh + j) * quads.width + q * qw + i) * 4;
          out[oi] = src[si]; out[oi + 1] = src[si + 1]; out[oi + 2] = src[si + 2]; out[oi + 3] = src[si + 3];
        }
      }
    }
    qctx.putImageData(qimg, 0, 0);
    const sh = shades();
    const at = { S, quads, left: wall(src, res, true, sh.left), right: wall(src, res, false, sh.right) };
    if (sh.dark) {
      at.quadsDark = darkened(quads, sh.dark);
      at.leftDark = darkened(at.left, sh.dark);
      at.rightDark = darkened(at.right, sh.dark);
    }
    return at;
  }

  /** How bright each wall is, and how much a cast shadow darkens things. When the sun casts shadows,
   *  a wall facing away from it is as dark as a shadow, and turning toward it brightens the wall from there. */
  function shades() {
    const iso = P().iso;
    if (!iso.blockShadows) return { left: LEFT_SHADE, right: RIGHT_SHADE, dark: 0 };
    const sun = sunOf(iso);
    const dark = 1 - iso.shadowDarkness;
    return {
      left: dark + (1 - dark) * Math.max(0, sun.hy),
      right: dark + (1 - dark) * Math.max(0, sun.hx),
      dark,
    };
  }

  /** A darker colour. Sunlight only changes brightness, so it keeps its hue. Without a sun, shading snaps onto the palette. */
  function shadeRgb(rgb, factor, colors) {
    if (P().iso.blockShadows) return rgb.map((v) => Math.round(v * factor));
    return PS.Palettes.toRgb(PS.Palettes.shaded(rgb, factor, colors));
  }

  const cssRgb = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;

  /** A copy of a canvas in shadow: the same colours, only darker. */
  function darkened(canvas, factor) {
    const c = PS.Sprites.canvas(canvas.width, canvas.height);
    const ctx = c.getContext('2d');
    const img = canvas.getContext('2d').getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.round(d[i] * factor); d[i + 1] = Math.round(d[i + 1] * factor); d[i + 2] = Math.round(d[i + 2] * factor);
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function wall(src, res, isLeft, factor) {
    const [col, row] = ATLAS[FULL];
    const colors = PS.Palettes.active().colors;
    const tile = res / 4;
    const c = PS.Sprites.canvas(tile, tile * 1.5);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(c.width, c.height);
    const memo = new Map();
    for (let i = 0; i < tile; i++) {
      const offset = isLeft ? i >> 1 : (tile - 1 - i) >> 1;
      for (let h = 0; h < tile; h++) {
        const si = (((row * tile + h) * res) + col * tile + i) * 4;
        if (src[si + 3] === 0) continue;
        const key = (src[si] << 16) | (src[si + 1] << 8) | src[si + 2];
        let rgb = memo.get(key);
        if (!rgb) { rgb = shadeRgb([src[si], src[si + 1], src[si + 2]], factor, colors); memo.set(key, rgb); }
        const oi = ((offset + h) * tile + i) * 4;
        img.data[oi] = rgb[0]; img.data[oi + 1] = rgb[1]; img.data[oi + 2] = rgb[2]; img.data[oi + 3] = src[si + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Draw an atlas sprite, smoothing high-resolution art that is shown smaller than its real size. */
  function blitArt(ctx, at, canvas, sx, sy, sw, sh, dx, dy, dw, dh) {
    const smooth = at.S > 1 && dw < sw;
    if (smooth) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
    ctx.drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh);
    if (smooth) ctx.imageSmoothingEnabled = false;
  }

  function atlasOf(id) {
    const ts = PS.Project.tileset(id);
    if (!ts) return null;
    const iso = P().iso;
    const sig = (ts.version || 0) + '|' + PS.Palettes.active().key + '|' + (iso.blockShadows ? iso.sunAngle + '|' + iso.shadowDarkness : '');
    let a = atlases.get(id);
    if (a && a.sig === sig && a.canvas === ts.canvas) return a;
    const built = buildAtlas(ts);
    if (!built) return null;
    a = { ...built, sig, canvas: ts.canvas };
    atlases.set(id, a);
    return a;
  }

  /** A soft-looking contact shadow, made of a dither pattern so it stays pixel art. */
  function shadowSprite() {
    const color = PS.Palettes.darkest();
    if (shadowCache && shadowCache.color === color) return shadowCache.canvas;
    const c = PS.Sprites.canvas(T, Q);
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    for (let y = 0; y < Q; y++) for (let x = 0; x < T; x++) {
      const d = ((x + 0.5 - Q) / Q) ** 2 + ((y + 0.5 - Q / 2) / (Q / 2)) ** 2;
      if (d > 1) continue;
      if (d < 0.45 || (x + y) % 2 === 0) ctx.fillRect(x, y, 1, 1);
    }
    shadowCache = { color, canvas: c };
    return c;
  }

  /* ------------------------------ Cast shadows ------------------------------ */
  /** The direction toward the sun. 0° is the top of the screen, turning clockwise.
   *  hx, hy: the same direction along the ground, run: ground covered per unit of height. */
  function sunOf(iso) {
    const a = iso.sunAngle * Math.PI / 180, e = iso.sunHeight * Math.PI / 180;
    const hx = (Math.sin(a) - Math.cos(a)) / Math.SQRT2, hy = -(Math.sin(a) + Math.cos(a)) / Math.SQRT2;
    return { hx, hy, run: 1 / Math.tan(e), dir: [hx * Math.cos(e), hy * Math.cos(e), Math.sin(e)] };
  }

  /** Convex outline of a set of points, always wound the same way so outlines can be merged in one path. */
  function hull(pts) {
    pts.sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const half = (list) => {
      const out = [];
      for (const q of list) {
        while (out.length > 1 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
        out.push(q);
      }
      out.pop();
      return out;
    };
    return [...half(pts), ...half([...pts].reverse())];
  }

  /** The shadows of the solid spans under the current sun. Results are kept until a block or the sun changes. */
  function castShadows(spans) {
    const p = P(), iso = p.iso;
    if (!iso.blockShadows) return null;
    const w = p.width, h = p.height;
    const casters = spans.filter((s) => s.solid && s.alpha > 0);
    let sig = `${w}|${h}|${iso.sunAngle}|${iso.sunHeight}`;
    for (const s of casters) {
      let hash = 0;
      const data = s.layer.data;
      for (let i = 0; i < data.length; i++) hash = (Math.imul(hash, 31) + (data[i] ? 1 : 0)) | 0;
      sig += `|${s.z0},${s.z1},${hash}`;
    }
    if (castCache && castCache.sig === sig) return castCache;

    const sun = sunOf(iso);
    const columns = new Array(w * h).fill(null);
    let maxTop = 0;
    for (const s of casters) {
      for (let i = 0; i < w * h; i++) {
        if (!s.layer.data[i]) continue;
        (columns[i] || (columns[i] = [])).push(s);
        if (s.z1 > maxTop) maxTop = s.z1;
      }
    }

    /** Add the shadow of one block to a path, if it falls on a flat receiver.
     *  axis: which coordinate the receiver is flat in (0 x, 1 y, 2 z). box: the receiver's limits. */
    const addBlock = (path, cx, cy, span, axis, plane, box) => {
      const x0 = cx * T, y0 = cy * T, z0 = axis === 2 ? Math.max(span.z0, plane) : span.z0;
      const pts = [];
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let c = 0; c < 8; c++) {
        const q = [c & 1 ? x0 + T : x0, c & 2 ? y0 + T : y0, c & 4 ? span.z1 : z0];
        const t = (q[axis] - plane) / sun.dir[axis];
        for (let k = 0; k < 3; k++) {
          q[k] = k === axis ? plane : q[k] - t * sun.dir[k];
          if (q[k] < lo[k]) lo[k] = q[k];
          if (q[k] > hi[k]) hi[k] = q[k];
        }
        pts.push(Iso.project(q[0], q[1], q[2]));
      }
      if (box) for (let k = 0; k < 3; k++) {
        if (k !== axis && (hi[k] <= box[k * 2] || lo[k] >= box[k * 2 + 1])) return false;
      }
      const out = hull(pts);
      out.forEach((q, i) => (i ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y)));
      path.closePath();
      return true;
    };

    /** Everything between one flat surface and the sun, as a path on screen. Null when it is fully sunlit. */
    const trace = (axis, plane, box) => {
      if (sun.dir[axis] < 1e-6) return null;
      const reach = Math.max(0, maxTop - box[4]) * sun.run;
      const xa = Math.max(0, Math.floor((box[0] + Math.min(0, sun.hx * reach)) / T));
      const xb = Math.min(w - 1, Math.ceil((box[1] + Math.max(0, sun.hx * reach)) / T));
      const ya = Math.max(0, Math.floor((box[2] + Math.min(0, sun.hy * reach)) / T));
      const yb = Math.min(h - 1, Math.ceil((box[3] + Math.max(0, sun.hy * reach)) / T));
      const path = new Path2D();
      let shaded = false;
      for (let cy = ya; cy <= yb; cy++) for (let cx = xa; cx <= xb; cx++) {
        const col = columns[cy * w + cx];
        if (!col) continue;
        // A wall is only shaded by what stands in front of it.
        if (axis === 0 && cx * T < plane) continue;
        if (axis === 1 && cy * T < plane) continue;
        for (const span of col) {
          if (span.z1 <= box[4] || (axis === 2 && span.z1 <= plane)) continue;
          if (addBlock(path, cx, cy, span, axis, plane, box)) shaded = true;
        }
      }
      return shaded ? path : null;
    };

    const memo = new Map();
    const remember = (key, make) => {
      let out = memo.get(key);
      if (out === undefined) { out = make(); memo.set(key, out); }
      return out;
    };
    let ground;
    castCache = {
      sig,
      /** The shaded part of a cell's top at a height. */
      top: (x, y, z) => remember(`t${x},${y},${z}`, () => trace(2, z, [x * T, (x + 1) * T, y * T, (y + 1) * T, z, Infinity])),
      /** The shaded part of a one-block-tall wall: isLeft faces +y, otherwise it faces +x. */
      wall: (x, y, z, isLeft) => remember(`${isLeft ? 'l' : 'r'}${x},${y},${z}`, () => (isLeft
        ? trace(1, (y + 1) * T, [x * T, (x + 1) * T, (y + 1) * T, (y + 1) * T, z, z + T])
        : trace(0, (x + 1) * T, [(x + 1) * T, (x + 1) * T, y * T, (y + 1) * T, z, z + T]))),
      /** The shadow of every block on the base plate. */
      ground() {
        if (ground === undefined) {
          ground = new Path2D();
          for (let i = 0; i < w * h; i++) {
            for (const span of columns[i] || []) addBlock(ground, i % w, Math.floor(i / w), span, 2, 0, null);
          }
        }
        return ground;
      },
    };
    return castCache;
  }

  /** Paint only inside a shadow path, which is in world units. */
  function inShadow(ctx, path, v, paint) {
    ctx.save();
    ctx.translate(-v.camX * v.s, -v.camY * v.s);
    ctx.scale(v.s, v.s);
    ctx.clip(path);
    ctx.scale(1 / v.s, 1 / v.s);
    ctx.translate(v.camX * v.s, v.camY * v.s);
    paint();
    ctx.restore();
  }

  /* ------------------------------ World ------------------------------ */
  /** Height information for the visible layers: flat ground layers and raised spans. */
  function world() {
    const p = P();
    const w = p.width, h = p.height;
    const ground = [], spans = [];
    for (const layer of p.layers) {
      if (layer.type !== 'tiles' || !layer.visible) continue;
      if (layer.solid) spans.push({ layer, solid: true, z0: layer.elev * T, z1: (layer.elev + layer.blocks) * T });
      else if (layer.elev > 0) spans.push({ layer, solid: false, z0: layer.elev * T, z1: layer.elev * T });
      else ground.push(layer);
    }
    spans.sort((a, b) => a.z0 - b.z0);
    const solids = spans.filter((s) => s.solid);
    const levels = Math.min(MAX_LEVELS, solids.reduce((m, s) => Math.max(m, s.z1 / T), 0));
    return {
      ground, spans, levels,
      solidAt(x, y, level) {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        const i = y * w + x, z = level * T;
        for (const s of solids) if (z >= s.z0 && z < s.z1 && s.layer.data[i]) return true;
        return false;
      },
      /** Height (in pixels) of the highest solid surface in a cell. */
      topAt(x, y) {
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        const i = y * w + x;
        let top = 0;
        for (const s of solids) if (s.layer.data[i] && s.z1 > top) top = s.z1;
        return top;
      },
      /** Height of the surface directly below a height, for shadows and landing. */
      surfaceBelow(x, y, z) {
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        const i = y * w + x;
        let top = 0;
        for (const s of solids) if (s.layer.data[i] && s.z1 > top && s.z1 <= z + 1) top = s.z1;
        return top;
      },
      hasFloor(x, y) {
        if (x < 0 || y < 0 || x >= w || y >= h) return false;
        if (!p.iso.pits) return true;
        const i = y * w + x;
        for (const l of ground) if (l.data[i]) return true;
        for (const s of solids) if (s.z0 === 0 && s.layer.data[i]) return true;
        return false;
      },
    };
  }

  /* ------------------------------ Drawing helpers ------------------------------ */
  function drawTop(ctx, get, x, y, z, v, cast) {
    drawQuads(ctx, get, x, y, z, v, 'quads');
    if (!cast || !hasArt(get, x, y)) return;
    const path = cast.top(x, y, z);
    if (path) inShadow(ctx, path, v, () => drawQuads(ctx, get, x, y, z, v, 'quadsDark'));
  }

  /** Whether any of a cell's four quarters shows a tile. */
  function hasArt(get, x, y) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (get(x + dx, y + dy)) return true;
    return false;
  }

  function drawQuads(ctx, get, x, y, z, v, sheet) {
    for (let q = 0; q < 4; q++) {
      const qx = q & 1, qy = q >> 1;
      const dx = x + qx, dy = y + qy;
      const a = get(dx - 1, dy - 1), b = get(dx, dy - 1), c = get(dx - 1, dy), d = get(dx, dy);
      if (!a && !b && !c && !d) continue;
      const pa = x * T + qx * Q, pb = y * T + qy * Q;
      const tq = (1 - qx) + (1 - qy) * 2;     // this corner of the cell is the opposite corner of the display tile
      const sx0 = Math.round((pa - pb - Q - v.camX) * v.s), sx1 = Math.round((pa - pb + Q - v.camX) * v.s);
      const sy0 = Math.round(((pa + pb) / 2 - z - v.camY) * v.s), sy1 = Math.round(((pa + pb) / 2 - z + Q - v.camY) * v.s);
      if (sx1 < 0 || sy1 < 0 || sx0 > v.W || sy0 > v.H) continue;
      const draw = (id, mask) => {
        const at = atlasOf(id);
        if (at) blitArt(ctx, at, at[sheet], tq * T * at.S, mask * Q * at.S, T * at.S, Q * at.S, sx0, sy0, sx1 - sx0, sy1 - sy0);
      };
      if (P().level.connectAcross) {
        const own = [a, b, c, d][tq];
        if (own) draw(own, (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0));
        continue;
      }
      const list = [a, b, c, d];
      for (let k = 0; k < 4; k++) {
        const id = list[k];
        if (!id || list.indexOf(id) !== k) continue;
        draw(id, (a === id ? 1 : 0) | (b === id ? 2 : 0) | (c === id ? 4 : 0) | (d === id ? 8 : 0));
      }
    }
  }

  function drawWalls(ctx, wld, span, x, y, id, v, cast) {
    const at = atlasOf(id);
    if (!at) return;
    const ax = (x - y) * T, ay = (x + y) * Q;
    for (let z = span.z0; z < span.z1; z += T) {
      const level = z / T;
      const top = ay - (z + T);
      const dy0 = Math.round((top + Q - v.camY) * v.s), dy1 = Math.round((top + Q + T + Q - v.camY) * v.s);
      if (!wld.solidAt(x, y + 1, level)) {
        const dx0 = Math.round((ax - T - v.camX) * v.s), dx1 = Math.round((ax - v.camX) * v.s);
        blitArt(ctx, at, at.left, 0, 0, at.left.width, at.left.height, dx0, dy0, dx1 - dx0, dy1 - dy0);
        const path = cast && cast.wall(x, y, z, true);
        if (path) inShadow(ctx, path, v, () => blitArt(ctx, at, at.leftDark, 0, 0, at.left.width, at.left.height, dx0, dy0, dx1 - dx0, dy1 - dy0));
      }
      if (!wld.solidAt(x + 1, y, level)) {
        const dx0 = Math.round((ax - v.camX) * v.s), dx1 = Math.round((ax + T - v.camX) * v.s);
        blitArt(ctx, at, at.right, 0, 0, at.right.width, at.right.height, dx0, dy0, dx1 - dx0, dy1 - dy0);
        const path = cast && cast.wall(x, y, z, false);
        if (path) inShadow(ctx, path, v, () => blitArt(ctx, at, at.rightDark, 0, 0, at.right.width, at.right.height, dx0, dy0, dx1 - dx0, dy1 - dy0));
      }
    }
  }

  function polygon(ctx, pts, v) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const sx = Math.round((x - v.camX) * v.s), sy = Math.round((y - v.camY) * v.s);
      if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
    });
    ctx.closePath();
  }

  const Iso = {
    world,

    active: () => !!P() && P().view === 'iso',

    project: (x, y, z = 0) => ({ x: x - y, y: (x + y) / 2 - z }),
    unproject: (sx, sy, z = 0) => ({ x: sy + z + sx / 2, y: sy + z - sx / 2 }),

    /** The screen area covered by the whole level, including tall blocks. */
    bounds() {
      const p = P();
      const levels = world().levels;
      const top = -(levels + 1) * T;
      return { x: -p.height * T, y: top, w: (p.width + p.height) * T, h: (p.width + p.height) * Q - top + T };
    },

    /** The base plate under the level, unless empty cells are meant to be pits. */
    drawGroundPlate(ctx, v, cast) {
      const p = P();
      if (p.iso.pits) return;
      const w = p.width * T, h = p.height * T;
      const corner = (x, y) => [x - y, (x + y) / 2];
      const n = corner(0, 0), e = corner(w, 0), s = corner(w, h), o = corner(0, h);
      const colors = PS.Palettes.active().colors;
      const base = PS.Palettes.toRgb(p.iso.ground);
      const depth = 12;
      polygon(ctx, [o, s, [s[0], s[1] + depth], [o[0], o[1] + depth]], v);
      const sh = shades();
      ctx.fillStyle = cssRgb(shadeRgb(base, sh.left * 0.8, colors));
      ctx.fill();
      polygon(ctx, [s, e, [e[0], e[1] + depth], [s[0], s[1] + depth]], v);
      ctx.fillStyle = cssRgb(shadeRgb(base, sh.right * 0.8, colors));
      ctx.fill();
      polygon(ctx, [n, e, s, o], v);
      ctx.fillStyle = p.iso.ground;
      ctx.fill();
      if (cast) {
        const dark = cssRgb(shadeRgb(base, 1 - p.iso.shadowDarkness, colors));
        inShadow(ctx, cast.ground(), v, () => {
          polygon(ctx, [n, e, s, o], v);
          ctx.fillStyle = dark;
          ctx.fill();
        });
      }
    },

    drawShadow(ctx, cx, cy, z, radius, v) {
      const pos = Iso.project(cx, cy, z);
      const dx0 = Math.round((pos.x - radius - v.camX) * v.s), dx1 = Math.round((pos.x + radius - v.camX) * v.s);
      const dy0 = Math.round((pos.y - radius / 2 - v.camY) * v.s), dy1 = Math.round((pos.y + radius / 2 - v.camY) * v.s);
      ctx.drawImage(shadowSprite(), dx0, dy0, dx1 - dx0, dy1 - dy0);
    },

    /** Build a drawable from a position on the floor plan.
     *  cx, cy: centre of its footprint. z: height of its feet. size: footprint width.
     *  shadow: draw a contact shadow on the surface below it. */
    entity({ cx, cy, z, size = 16, frame, flip = false, alpha = 1, oy = 0, sx = 1, sy = 1, shadow = false, wld }) {
      return {
        cx, cy, z, size, frame, flip, alpha, oy, sx, sy, shadow, wld,
        x1: Math.floor((cx + size / 2 - 0.01) / T),
        y1: Math.floor((cy + size / 2 - 0.01) / T),
      };
    },

    drawEntity(ctx, e, v) {
      if (e.shadow && e.wld) {
        const ground = e.wld.surfaceBelow(Math.floor(e.cx / T), Math.floor(e.cy / T), e.z);
        const k = Math.max(0.45, 1 - (e.z - ground) / 110);
        if (e.wld.hasFloor(Math.floor(e.cx / T), Math.floor(e.cy / T)) || ground > 0) {
          Iso.drawShadow(ctx, e.cx, e.cy, ground, Math.max(5, e.size * 0.7) * k, v);
        }
      }
      const pos = Iso.project(e.cx, e.cy, e.z);
      PS.Renderer.drawSprite(ctx, e.frame, pos.x - Q, pos.y - T + e.oy, v.camX, v.camY, v.s, e.flip, e.alpha, e.sx, e.sy);
    },

    /** Draw the level back to front. opts: { camX, camY, s, W, H, entities, alpha(layer), filter(layer), wld } */
    drawScene(ctx, opts) {
      const p = P();
      const wld = opts.wld || world();
      const v = { camX: opts.camX, camY: opts.camY, s: opts.s, W: opts.W, H: opts.H };
      const w = p.width, h = p.height;
      const use = (layer) => !opts.filter || opts.filter(layer);
      const alphaOf = (layer) => (opts.alpha ? opts.alpha(layer) : layer.opacity);

      const spans = wld.spans.filter((s) => use(s.layer)).map((s) => ({ ...s, get: PS.Autotile.getter(s.layer), alpha: alphaOf(s.layer) }));
      const cast = castShadows(spans);

      Iso.drawGroundPlate(ctx, v, cast);

      // Cells that can be seen, in a safe back-to-front order: x, then y.
      const levelsPx = (wld.levels + 1) * T;
      const visible = (x, y) => {
        const sx = ((x - y) * T - v.camX) * v.s, sy = ((x + y) * Q - v.camY) * v.s;
        return sx > -T * v.s && sx < v.W + T * v.s && sy > -T * v.s - T * v.s && sy < v.H + levelsPx * v.s;
      };

      // Flat ground layers
      for (const layer of wld.ground) {
        if (!use(layer)) continue;
        const a = alphaOf(layer);
        if (a <= 0) continue;
        ctx.globalAlpha = a;
        const get = PS.Autotile.getter(layer);
        for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
          if (visible(x, y)) drawTop(ctx, get, x, y, 0, v, cast);
        }
      }
      ctx.globalAlpha = 1;

      // Raised blocks and everything standing among them
      const buckets = new Map();
      const late = [];
      for (const e of opts.entities || []) {
        if (e.x1 < 0 || e.y1 < 0 || e.x1 >= w || e.y1 >= h) { late.push(e); continue; }
        const key = e.y1 * w + e.x1;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(e);
      }
      for (const list of buckets.values()) list.sort((a, b) => a.z - b.z || (a.cx + a.cy) - (b.cx + b.cy));

      for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
        const list = buckets.get(y * w + x);
        if (!spans.length && !list) continue;
        const seen = visible(x, y);
        let ei = 0;
        const i = y * w + x;
        for (const span of spans) {
          while (list && ei < list.length && list[ei].z <= span.z0) Iso.drawEntity(ctx, list[ei++], v);
          if (!seen || span.alpha <= 0) continue;
          ctx.globalAlpha = span.alpha;
          const id = span.layer.data[i];
          if (span.solid && id) drawWalls(ctx, wld, span, x, y, id, v, cast);
          drawTop(ctx, span.get, x, y, span.z1, v, cast);
          ctx.globalAlpha = 1;
        }
        while (list && ei < list.length) Iso.drawEntity(ctx, list[ei++], v);
      }
      for (const e of late) Iso.drawEntity(ctx, e, v);
      ctx.globalAlpha = 1;
    },

    /** Drawables for the placed objects, used by the editor and by image export. */
    objectEntities(wld, filter, dragged) {
      const p = P();
      const out = [];
      for (const o of p.objects) {
        if (filter && !filter(o)) continue;
        const pos = dragged && dragged.id === o.id ? dragged : o;
        const cx = (pos.x + 0.5) * T, cy = (pos.y + 0.5) * T;
        const top = wld.topAt(pos.x, pos.y);
        let shadow, z = top;
        if (o.kind === 'spawn') shadow = p.iso.shadowPlayer;
        else if (o.kind === 'enemy') {
          shadow = p.iso.shadowNpc;
          if (o.type === 'flyer' || o.props.behavior === 'fly') z = top + Iso.FLY_HEIGHT;
        } else {
          shadow = p.iso.shadowObjects;
          if (o.kind === 'collectible') z = top + Iso.ITEM_HEIGHT;
        }
        out.push(Iso.entity({
          cx, cy, z, size: o.kind === 'collectible' ? 10 : 18, frame: PS.Renderer.objectFrame(o), flip: o.kind === 'enemy' && o.props.dir < 0,
          shadow, wld, alpha: 1,
        }));
        out[out.length - 1].object = o;
      }
      return out;
    },

    FLY_HEIGHT: 20,
    ITEM_HEIGHT: 6,

    /* ------------------------------ Picking ------------------------------ */
    /** Follow the line of sight from a screen point down to the first thing it meets. */
    pick(sx, sy, wld = world()) {
      const base = Iso.unproject(sx, sy, 0);
      let prev = null;
      for (let t = wld.levels * T + 1; t >= 0; t--) {
        const ux = base.x + t, uy = base.y + t;
        const cell = { x: Math.floor(ux / T), y: Math.floor(uy / T), level: Math.floor(t / T) };
        if (t < wld.levels * T && wld.solidAt(cell.x, cell.y, cell.level)) {
          let face = 'top';
          if (prev && prev.level === cell.level) face = prev.x > cell.x ? 'right' : prev.y > cell.y ? 'left' : 'top';
          return { ...cell, face, ux, uy, z: t, top: (cell.level + 1) * T };
        }
        prev = cell;
      }
      return { x: Math.floor(base.x / T), y: Math.floor(base.y / T), level: 0, face: 'ground', ux: base.x, uy: base.y, z: 0, top: 0 };
    },

    /** The map cell under a screen point for the current tool.
     *  Tools that add tiles aim at the layer's own height, others aim at what is visibly there. */
    cellAt(sx, sy) {
      const layer = PS.Project.activeTileLayer() || PS.Project.defaultTileLayer();
      if (st.tool === 'pencil' || st.tool === 'rect' || st.tool === 'rectFill' || st.tool === 'fill' || st.tool === 'move') {
        const z = layer ? layer.elev * T : 0;
        const plan = Iso.unproject(sx, sy, z);
        return { x: Math.floor(plan.x / T), y: Math.floor(plan.y / T), z };
      }
      const wld = world();
      const hit = Iso.pickObject(sx, sy, wld);
      if (hit) return { x: hit.x, y: hit.y, z: wld.topAt(hit.x, hit.y) };
      const g = Iso.pick(sx, sy, wld);
      return { x: g.x, y: g.y, z: g.top };
    },

    /** The object whose picture is under a screen point, frontmost first. */
    pickObject(sx, sy, wld) {
      const objLayer = PS.Project.objectsLayer();
      if (!objLayer || !objLayer.visible) return null;
      const list = Iso.objectEntities(wld).sort((a, b) => (b.cx + b.cy) - (a.cx + a.cy));
      for (const e of list) {
        const pos = Iso.project(e.cx, e.cy, e.z);
        if (sx >= pos.x - Q + 4 && sx < pos.x + Q - 4 && sy >= pos.y - T && sy < pos.y + 2) return e.object;
      }
      return null;
    },

    /** Outline of a rectangle of cells on the floor plan at height z. */
    cellPolygon(x, y, w, h, z) {
      const c = (px, py) => { const q = Iso.project(px * T, py * T, z); return [q.x, q.y]; };
      return [c(x, y), c(x + w, y), c(x + w, y + h), c(x, y + h)];
    },

    tracePolygon: polygon,

    /** Draw ghost tiles for a preview, at the height of the layer's top. */
    drawGhost(ctx, get, x, y, z, v) { drawTop(ctx, get, x, y, z, v); },

    drawGrid(ctx, v, color) {
      const p = P();
      ctx.beginPath();
      const line = (a, b) => {
        ctx.moveTo(Math.round((a.x - v.camX) * v.s) + 0.5, Math.round((a.y - v.camY) * v.s) + 0.5);
        ctx.lineTo(Math.round((b.x - v.camX) * v.s) + 0.5, Math.round((b.y - v.camY) * v.s) + 0.5);
      };
      for (let x = 0; x <= p.width; x++) line(Iso.project(x * T, 0), Iso.project(x * T, p.height * T));
      for (let y = 0; y <= p.height; y++) line(Iso.project(0, y * T), Iso.project(p.width * T, y * T));
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.stroke();
    },
  };

  PS.Iso = Iso;
})(window.PS);
