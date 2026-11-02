/* =====================================================================
   Platformer Studio — rendering engine & editor camera

   • Tile layers are rendered into cached 16×16-tile chunk canvases at
     native resolution. Editing a cell only marks the chunks around it as
     dirty, so large maps stay fast.
   • All screen positions are rounded to whole device pixels and image
     smoothing is off, so pixel art stays crisp at every zoom level.
   • The same chunk drawing is shared by the editor, play mode and export.
   • Tiles are drawn on the dual grid: a chunk holds every display tile that
     touches it, each sitting half a tile up and to the left of its index.
   • Chunks hold 32 pixels per tile. When zoomed in on a high-resolution
     sheet they would lose detail, so those tiles are drawn straight from
     the sheet instead, keeping its full resolution.
   ===================================================================== */
(function (PS) {
  'use strict';

  const T = PS.TILE;
  const CH = 16;                 // chunk size in tiles
  const CHP = CH * T;            // chunk size in pixels
  const ZOOMS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12];
  const { clamp } = PS.util;

  const caches = new Map();      // layerId -> Map(chunkKey -> { canvas, dirty })
  const spare = [];              // recycled chunk canvases
  const scratch = [];            // two screen-sized canvases for layer shadows

  /** A cleared screen-sized drawing surface for building a layer shadow. */
  function scratchContext(i, w, h) {
    const c = scratch[i] || (scratch[i] = PS.Sprites.canvas(w, h));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    return ctx;
  }

  function chunkCanvas() {
    const c = spare.pop() || PS.Sprites.canvas(CHP, CHP);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, CHP, CHP);
    return c;
  }

  function renderChunk(layer, cx, cy, ch) {
    const p = PS.state.project;
    const get = PS.Autotile.getter(layer);
    const x0 = cx * CH, y0 = cy * CH;
    const x1 = Math.min(p.width, x0 + CH), y1 = Math.min(p.height, y0 + CH);
    let ctx = null;
    if (ch.canvas) { ctx = ch.canvas.getContext('2d'); ctx.clearRect(0, 0, CHP, CHP); }
    let any = false;
    for (let dy = y0; dy <= y1; dy++) {
      for (let dx = x0; dx <= x1; dx++) {
        const a = get(dx - 1, dy - 1), b = get(dx, dy - 1), c = get(dx - 1, dy), d = get(dx, dy);
        if (!a && !b && !c && !d) continue;
        if (!ctx) { ch.canvas = chunkCanvas(); ctx = ch.canvas.getContext('2d'); }
        const px = (dx - x0) * T - T / 2, py = (dy - y0) * T - T / 2;
        if (PS.Autotile.drawDisplay(ctx, get, dx, dy, px, py, T, T)) any = true;
      }
    }
    if (!any && ch.canvas) { spare.push(ch.canvas); ch.canvas = null; }
    ch.dirty = false;
  }

  function getChunk(layer, cx, cy) {
    let cache = caches.get(layer.id);
    if (!cache) { cache = new Map(); caches.set(layer.id, cache); }
    const key = cx + ',' + cy;
    let ch = cache.get(key);
    if (!ch) { ch = { canvas: null, dirty: true }; cache.set(key, ch); }
    if (ch.dirty) renderChunk(layer, cx, cy, ch);
    return ch.canvas;
  }

  const R = {
    CH, ZOOMS,
    canvas: null,
    ctx: null,
    dpr: 1,
    cssW: 0,
    cssH: 0,
    view: { x: 0, y: 0, zoom: 2 },
    theme: {},
    pending: false,

    init(canvas) {
      R.canvas = canvas;
      R.ctx = canvas.getContext('2d', { alpha: true });
      new ResizeObserver(() => R.resize()).observe(canvas.parentElement);
      window.addEventListener('resize', () => R.resize());
      R.readTheme();
      R.resize();
    },

    readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => cs.getPropertyValue(n).trim();
      R.theme = {
        dark: document.documentElement.dataset.theme !== 'light',
        grid: v('--grid-line'),
        border: v('--map-border'),
        accent: v('--accent'),
        accent2: v('--accent-2'),
        danger: v('--danger'),
      };
      R.checkerPattern = null;
      R.request();
    },

    resize() {
      const host = R.canvas.parentElement.getBoundingClientRect();
      if (!host.width || !host.height) return;   // hidden during fullscreen painting: keep the view as it is
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(host.width * dpr)), h = Math.max(1, Math.round(host.height * dpr));
      // Keep the same world point in the middle of the view when the stage changes size.
      if (R.cssW && R.cssH) {
        R.view.x += (R.cssW - host.width) / (2 * R.view.zoom);
        R.view.y += (R.cssH - host.height) / (2 * R.view.zoom);
      }
      R.cssW = host.width; R.cssH = host.height;
      if (R.canvas.width !== w || R.canvas.height !== h || R.dpr !== dpr) {
        R.canvas.width = w; R.canvas.height = h;
        R.dpr = dpr;
        R.checkerPattern = null;
      }
      R.snap();
      if (PS.state.mode === 'play' && PS.Game) PS.Game.onResize();
      R.request();
    },

    get scale() { return R.view.zoom * R.dpr; },

    request() {
      if (R.pending) return;
      R.pending = true;
      requestAnimationFrame(() => {
        R.pending = false;
        if (PS.state.mode === 'edit' && PS.state.project) R.renderEditor();
      });
    },

    /* ------------------------------ Camera ------------------------------ */
    screenToWorld(cssX, cssY) {
      return { x: cssX / R.view.zoom + R.view.x, y: cssY / R.view.zoom + R.view.y };
    },

    cellAt(cssX, cssY) {
      const w = R.screenToWorld(cssX, cssY);
      if (PS.Iso.active()) return PS.Iso.cellAt(w.x, w.y);
      return { x: Math.floor(w.x / T), y: Math.floor(w.y / T) };
    },

    snap() {
      const s = R.scale;
      R.view.x = Math.round(R.view.x * s) / s;
      R.view.y = Math.round(R.view.y * s) / s;
    },

    zoomTo(z, cssX = R.cssW / 2, cssY = R.cssH / 2) {
      z = clamp(z, ZOOMS[0], ZOOMS[ZOOMS.length - 1]);
      const before = R.screenToWorld(cssX, cssY);
      R.view.zoom = z;
      R.view.x = before.x - cssX / z;
      R.view.y = before.y - cssY / z;
      R.snap();
      R.request();
      PS.bus.emit('view');
    },

    zoomStep(dir, cssX, cssY) {
      const z = R.view.zoom;
      let next;
      if (dir > 0) next = ZOOMS.find((v) => v > z + 1e-6) || z;
      else next = [...ZOOMS].reverse().find((v) => v < z - 1e-6) || z;
      R.zoomTo(next, cssX, cssY);
    },

    panBy(dxCss, dyCss) {
      R.view.x -= dxCss / R.view.zoom;
      R.view.y -= dyCss / R.view.zoom;
      R.snap();
      R.request();
    },

    /** The world area the level covers, for centring and fitting. */
    bounds() {
      if (PS.Iso.active()) return PS.Iso.bounds();
      const p = PS.state.project;
      return { x: 0, y: 0, w: p.width * T, h: p.height * T };
    },

    center() {
      const b = R.bounds();
      R.view.x = b.x + b.w / 2 - R.cssW / (2 * R.view.zoom);
      R.view.y = b.y + b.h / 2 - R.cssH / (2 * R.view.zoom);
      R.snap();
      R.request();
    },

    fit() {
      const b = R.bounds();
      const pad = R.cssW < 600 ? 20 : 56;
      const z = Math.min((R.cssW - pad * 2) / b.w, (R.cssH - pad * 2) / b.h);
      R.view.zoom = clamp(z >= 1 ? Math.floor(z * R.dpr) / R.dpr || 1 : z, ZOOMS[0], ZOOMS[ZOOMS.length - 1]);
      R.center();
      PS.bus.emit('view');
    },

    /* ------------------------------ Caches ------------------------------ */
    invalidateCell(layer, x, y) {
      const cache = caches.get(layer.id);
      if (!cache) return;
      const x0 = Math.floor((x - 1) / CH), x1 = Math.floor((x + 1) / CH);
      const y0 = Math.floor((y - 1) / CH), y1 = Math.floor((y + 1) / CH);
      for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
        const ch = cache.get(cx + ',' + cy);
        if (ch) ch.dirty = true;
      }
    },

    invalidateLayer(layer) {
      const cache = caches.get(layer.id);
      if (!cache) return;
      for (const ch of cache.values()) if (ch.canvas) spare.push(ch.canvas);
      caches.delete(layer.id);
    },

    invalidateAll() {
      for (const cache of caches.values()) for (const ch of cache.values()) if (ch.canvas) spare.push(ch.canvas);
      caches.clear();
      if (spare.length > 64) spare.length = 64;
      R.request();
    },

    /** Painted art changed: redraw every place the tileset appears, keeping the canvases. */
    invalidateTileset() {
      for (const cache of caches.values()) for (const ch of cache.values()) ch.dirty = true;
      R.request();
    },

    /* ------------------------------ Shared drawing ------------------------------ */
    /** Draw a tile layer. camX/camY: world position at the top-left; s: device px per world px. */
    drawTileLayer(ctx, layer, camX, camY, s, vw, vh, alpha = 1) {
      const p = PS.state.project;
      const cx0 = Math.max(0, Math.floor(camX / CHP));
      const cy0 = Math.max(0, Math.floor(camY / CHP));
      const cx1 = Math.min(Math.ceil(p.width / CH) - 1, Math.floor((camX + vw / s) / CHP));
      const cy1 = Math.min(Math.ceil(p.height / CH) - 1, Math.floor((camY + vh / s) / CHP));
      if (alpha <= 0) return;
      ctx.globalAlpha = alpha;
      if (s > 1 && R.showsHires(layer, camX, camY, s, vw, vh)) {
        R.drawTilesDirect(ctx, layer, camX, camY, s, vw, vh);
        ctx.globalAlpha = 1;
        return;
      }
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = getChunk(layer, cx, cy);
          if (!c) continue;
          const x0 = Math.round((cx * CHP - camX) * s), x1 = Math.round(((cx + 1) * CHP - camX) * s);
          const y0 = Math.round((cy * CHP - camY) * s), y1 = Math.round(((cy + 1) * CHP - camY) * s);
          ctx.drawImage(c, x0, y0, x1 - x0, y1 - y0);
        }
      }
      ctx.globalAlpha = 1;
    },

    /** Is any tile of this layer in view from a sheet larger than the standard 128? */
    showsHires(layer, camX, camY, s, vw, vh) {
      const p = PS.state.project;
      const hires = new Set();
      for (const ts of p.tilesets) if (PS.Assets.isHires(ts)) hires.add(ts.id);
      if (!hires.size) return false;
      const x0 = Math.max(0, Math.floor(camX / T) - 1), x1 = Math.min(p.width - 1, Math.floor((camX + vw / s) / T) + 1);
      const y0 = Math.max(0, Math.floor(camY / T) - 1), y1 = Math.min(p.height - 1, Math.floor((camY + vh / s) / T) + 1);
      for (let y = y0; y <= y1; y++) {
        const row = y * p.width;
        for (let x = x0; x <= x1; x++) if (hires.has(layer.data[row + x])) return true;
      }
      return false;
    },

    /** Draw the display tiles in view straight from their sheets, at full detail. */
    drawTilesDirect(ctx, layer, camX, camY, s, vw, vh) {
      const p = PS.state.project;
      const get = PS.Autotile.getter(layer);
      const sx = (v) => Math.round((v - camX) * s), sy = (v) => Math.round((v - camY) * s);
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx(0), sy(0), sx(p.width * T) - sx(0), sy(p.height * T) - sy(0));
      ctx.clip();
      const x0 = Math.max(0, Math.floor(camX / T)), x1 = Math.min(p.width, Math.ceil((camX + vw / s) / T));
      const y0 = Math.max(0, Math.floor(camY / T)), y1 = Math.min(p.height, Math.ceil((camY + vh / s) / T));
      for (let dy = y0; dy <= y1; dy++) {
        for (let dx = x0; dx <= x1; dx++) {
          const px = sx((dx - 0.5) * T), py = sy((dy - 0.5) * T);
          PS.Autotile.drawDisplay(ctx, get, dx, dy, px, py, sx((dx + 0.5) * T) - px, sy((dy + 0.5) * T) - py);
        }
      }
      ctx.restore();
    },

    /** Draw a tile layer repeated sideways without end, for parallax scenery. */
    drawTileLayerRepeat(ctx, layer, camX, camY, s, vw, vh, alpha = 1) {
      const lw = PS.state.project.width * T;
      const first = Math.floor(camX / lw), last = Math.floor((camX + vw / s) / lw);
      for (let k = first; k <= last; k++) R.drawTileLayer(ctx, layer, camX - k * lw, camY, s, vw, vh, alpha);
    },

    /** Draw a 32×32 sprite whose top-left world position is (wx, wy). */
    drawSprite(ctx, img, wx, wy, camX, camY, s, flip = false, alpha = 1, scaleX = 1, scaleY = 1) {
      if (!img) return;
      const x0 = Math.round((wx - camX) * s), y0 = Math.round((wy - camY) * s);
      const size = Math.round(T * s);
      ctx.globalAlpha = alpha;
      if (flip || scaleX !== 1 || scaleY !== 1) {
        const w = Math.max(1, Math.round(size * scaleX)), h = Math.max(1, Math.round(size * scaleY));
        ctx.save();
        ctx.translate(x0 + Math.round(size / 2), y0 + size);
        ctx.scale(flip ? -1 : 1, 1);
        ctx.drawImage(img, -Math.round(w / 2), -h, w, h);
        ctx.restore();
      } else {
        ctx.drawImage(img, x0, y0, size, size);
      }
      ctx.globalAlpha = 1;
    },

    /** First frame used to show an object in the editor and in exports. */
    objectFrame(o) {
      const p = PS.state.project;
      if (o.kind === 'spawn') return PS.Assets.character(p.character).frames.idle[0];
      if (o.kind === 'goal') return PS.Assets.goal(o.type).frames[0];
      if (o.kind === 'enemy') return PS.Assets.enemy(o.type).frames[0];
      if (o.kind === 'collectible') return PS.Assets.collectible(o.type).frames[0];
      return null;
    },

    drawObjectsStatic(ctx, camX, camY, s, filter, alpha = 1, dragged = null) {
      for (const o of PS.state.project.objects) {
        if (filter && !filter(o)) continue;
        const pos = dragged && dragged.id === o.id ? dragged : o;
        const flip = o.kind === 'enemy' && o.props.dir < 0;
        R.drawSprite(ctx, R.objectFrame(o), pos.x * T, pos.y * T, camX, camY, s, flip, alpha);
      }
    },

    /** The layers whose shadows reach shown[i]. shown: the layers being drawn, bottom to top. */
    shadowCasters(shown, i) {
      return shown.filter((c, j) => j > i && c.shadowOn && j - i <= c.shadowReach && c.shadowOpacity * c.opacity > 0);
    },

    /**
     * Draw a layer with the shadows of the layers above it. The shadows are painted
     * onto a copy of the layer, keeping that copy's alpha: empty areas stay empty
     * and see-through pixels take only part of each shadow.
     * draw(ctx, layer, alpha) paints a layer where it currently sits on screen.
     */
    drawWithShadow(ctx, layer, casters, W, H, s, alpha, draw) {
      if (alpha <= 0) return;
      if (!casters.length) return draw(ctx, layer, alpha);
      const under = scratchContext(0, W, H);
      draw(under, layer, 1);
      for (const above of casters) {
        const over = scratchContext(1, W, H);
        draw(over, above, 1);
        // The caster sits just off the canvas, so only its shadow falls on the layer.
        under.save();
        under.globalCompositeOperation = 'source-atop';
        under.globalAlpha = above.shadowOpacity * above.opacity;
        under.shadowColor = above.shadowColor;
        under.shadowBlur = above.shadowBlur * s;
        under.shadowOffsetX = Math.round(above.shadowX * s) + W;
        under.shadowOffsetY = Math.round(above.shadowY * s);
        under.drawImage(over.canvas, -W, 0);
        under.restore();
      }
      ctx.globalAlpha = alpha;
      ctx.drawImage(under.canvas, 0, 0);
      ctx.globalAlpha = 1;
    },

    /** Let go of the shadow canvases after a very large drawing, such as an image export. */
    releaseScratch() {
      scratch.length = 0;
    },

    checker(ctx) {
      if (!R.checkerPattern) {
        const size = Math.max(4, Math.round(8 * R.dpr));
        const c = PS.Sprites.canvas(size * 2, size * 2);
        const g = c.getContext('2d');
        const k = PS.state.prefs.checker;
        const a = R.theme.dark ? 44 : 246;
        const b = R.theme.dark ? Math.round(44 + 34 * k) : Math.round(246 - 40 * k);
        g.fillStyle = `rgb(${a},${a},${a + (R.theme.dark ? 8 : 2)})`;
        g.fillRect(0, 0, size * 2, size * 2);
        g.fillStyle = `rgb(${b},${b},${b + (R.theme.dark ? 8 : 2)})`;
        g.fillRect(0, 0, size, size);
        g.fillRect(size, size, size, size);
        R.checkerPattern = ctx.createPattern(c, 'repeat');
      }
      return R.checkerPattern;
    },

    /* ------------------------------ Editor frame ------------------------------ */
    renderEditor() {
      if (PS.Iso.active()) return R.renderEditorIso();
      const ctx = R.ctx, p = PS.state.project, st = PS.state;
      const s = R.scale, cam = R.view;
      const W = R.canvas.width, H = R.canvas.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, W, H);

      const mx0 = Math.round(-cam.x * s), my0 = Math.round(-cam.y * s);
      const mx1 = Math.round((p.width * T - cam.x) * s), my1 = Math.round((p.height * T - cam.y) * s);

      // Map backdrop with a soft shadow
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 24 * R.dpr;
      ctx.shadowOffsetY = 6 * R.dpr;
      ctx.fillStyle = p.level.transparentSky ? (R.theme.dark ? '#2c2f38' : '#f2f3f7') : p.level.sky;
      ctx.fillRect(mx0, my0, mx1 - mx0, my1 - my0);
      ctx.restore();
      if (p.level.transparentSky) {
        const pat = R.checker(ctx);
        pat.setTransform && pat.setTransform(new DOMMatrix().translate(mx0, my0));
        ctx.fillStyle = pat;
        ctx.fillRect(mx0, my0, mx1 - mx0, my1 - my0);
      }

      // Layers, bottom to top
      const preview = PS.Tools.preview();
      const focus = st.prefs.highlightLayer;
      ctx.save();
      ctx.beginPath();
      ctx.rect(mx0, my0, mx1 - mx0, my1 - my0);
      ctx.clip();
      const drawLayer = (c, layer, a) => {
        if (layer.type !== 'tiles') return R.drawObjectsStatic(c, cam.x, cam.y, s, null, a, PS.Tools.objectDrag);
        const sway = R.swayOffset(layer);
        if (sway === null) R.drawTileLayer(c, layer, cam.x, cam.y, s, W, H, a);
        else R.drawTileLayerRepeat(c, layer, Math.round((cam.x + sway) * s) / s, cam.y, s, W, H, a);
      };
      const shown = p.layers.filter((l) => l.visible);
      shown.forEach((layer, i) => {
        const dim = focus && layer.id !== st.activeLayerId ? 0.25 : 1;
        R.drawWithShadow(ctx, layer, R.shadowCasters(shown, i), W, H, s, layer.opacity * dim, drawLayer);
        if (preview && preview.kind === 'cells' && preview.layer === layer) R.drawCellPreview(ctx, preview);
      });
      // Previews for hidden layers are still useful feedback
      if (preview && preview.kind === 'cells' && !preview.layer.visible) R.drawCellPreview(ctx, preview);
      ctx.restore();

      R.drawGrid(ctx, mx0, my0, mx1, my1);
      ctx.lineWidth = Math.max(1, R.dpr);
      ctx.strokeStyle = R.theme.border;
      ctx.strokeRect(mx0 - 0.5, my0 - 0.5, mx1 - mx0 + 1, my1 - my0 + 1);

      R.drawObjectOverlays(ctx);
      if (preview && preview.kind === 'object') R.drawObjectPreview(ctx, preview);
      R.drawSelection(ctx);
      R.drawHover(ctx, preview);
      if (st.workspace === 'paint') { R.drawPixelGrid(ctx, mx0, my0, mx1, my1); PS.Paint.drawCursor(ctx); }
    },

    /* ------------------------------ Parallax preview ------------------------------
       The editor keeps layers lined up so you always paint where you click.
       This briefly sways the camera to show how the layers will move in play. */
    previewStart: 0,

    /** World offset of a layer during the preview, or null when it stays put. */
    swayOffset(layer) {
      if (!R.previewStart) return null;
      const t = (performance.now() - R.previewStart) / 1000;
      const speed = PS.Project.layerSpeed(layer);
      const drift = PS.Project.layerDrift(layer);
      if (speed === 1 && !drift) return null;
      return Math.sin(t * 1.6) * 96 * (speed - 1) - t * drift;
    },

    previewParallax() {
      if (PS.Iso.active()) return PS.UI.toast('Parallax applies to the 2D view. In iso mode, layers sit at real heights.', 'info');
      R.previewStart = performance.now();
      const tick = () => {
        if (performance.now() - R.previewStart > 4000 || PS.state.mode !== 'edit') {
          R.previewStart = 0;
          R.request();
          return;
        }
        R.request();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },

    /* ------------------------------ Isometric editor frame ------------------------------ */
    renderEditorIso() {
      const ctx = R.ctx, p = PS.state.project, st = PS.state;
      const s = R.scale, cam = R.view;
      const W = R.canvas.width, H = R.canvas.height;
      const Iso = PS.Iso;
      const v = { camX: cam.x, camY: cam.y, s, W, H };
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, W, H);
      if (p.level.transparentSky) {
        ctx.fillStyle = R.checker(ctx);
      } else {
        ctx.fillStyle = p.level.sky;
      }
      ctx.fillRect(0, 0, W, H);

      const wld = Iso.world();
      const objLayer = PS.Project.objectsLayer();
      const focus = st.prefs.highlightLayer;
      const drag = PS.Tools.objectDrag;
      const entities = objLayer && objLayer.visible
        ? Iso.objectEntities(wld, null, drag)
        : [];
      if (focus && objLayer && objLayer.id !== st.activeLayerId) for (const e of entities) e.alpha = 0.25;
      const preview = PS.Tools.preview();
      if (preview && preview.kind === 'object' && preview.frame) {
        const top = wld.topAt(preview.x, preview.y);
        entities.push(Iso.entity({ cx: (preview.x + 0.5) * T, cy: (preview.y + 0.5) * T, z: top, size: 18, frame: preview.frame, alpha: preview.valid ? 0.6 : 0.25 }));
      }
      Iso.drawScene(ctx, {
        camX: cam.x, camY: cam.y, s, W, H, wld, entities,
        alpha: (layer) => layer.opacity * (focus && layer.id !== st.activeLayerId ? 0.25 : 1),
      });

      if (st.prefs.showGrid && T * s >= 5) Iso.drawGrid(ctx, v, p.level.transparentSky ? R.theme.grid : 'rgba(10, 20, 40, 0.16)');

      if (preview && preview.kind === 'cells') R.drawIsoPreview(ctx, preview, v);

      const line = (pts, color, width, dash) => {
        Iso.tracePolygon(ctx, pts, v);
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.setLineDash(dash || []);
        ctx.stroke();
        ctx.setLineDash([]);
      };

      // Selected object, and start / goal labels
      const d = R.dpr;
      ctx.font = `700 ${Math.round(9 * d)}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (objLayer && objLayer.visible) {
        for (const e of entities) {
          const o = e.object;
          if (!o) continue;
          const pos = Iso.project(e.cx, e.cy, e.z);
          const cx = Math.round((pos.x - cam.x) * s), cy = Math.round((pos.y - T - cam.y) * s);
          if (o.kind === 'spawn' || o.kind === 'goal') {
            const label = o.kind === 'spawn' ? 'START' : 'GOAL';
            const tw = ctx.measureText(label).width + 10 * d;
            ctx.fillStyle = o.kind === 'spawn' ? '#14b37d' : '#f59f00';
            R.roundRect(ctx, cx - tw / 2, cy - 15 * d, tw, 14 * d, 5 * d);
            ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.fillText(label, cx, cy - 7.5 * d);
          }
          if (o.id === st.selectedObjectId) {
            const hw = Math.round((T / 2) * s), h = Math.round(T * s);
            ctx.lineWidth = 2 * d;
            ctx.strokeStyle = R.theme.accent;
            R.roundRect(ctx, cx - hw - 2 * d, cy - 2 * d, hw * 2 + 4 * d, h + 4 * d, 5 * d);
            ctx.stroke();
          }
        }
      }

      const sel = PS.Tools.selectionDraft || st.selection;
      if (sel) {
        const pts = Iso.cellPolygon(sel.x, sel.y, sel.w, sel.h, 0);
        Iso.tracePolygon(ctx, pts, v);
        ctx.fillStyle = 'rgba(139, 123, 255, 0.16)';
        ctx.fill();
        line(pts, '#fff', Math.max(1, d));
        line(pts, R.theme.accent, Math.max(1, d), [5 * d, 4 * d]);
      }

      const hover = PS.Tools.hover;
      if (hover && PS.Project.inBounds(hover.x, hover.y) && !PS.Tools.dragging && st.tool !== 'select' && st.tool !== 'move') {
        const pts = Iso.cellPolygon(hover.x, hover.y, 1, 1, hover.z || 0);
        line(pts, 'rgba(0,0,0,0.35)', 3 * d);
        line(pts, st.tool === 'eraser' || (preview && preview.blocked) ? R.theme.danger : '#ffffff', Math.max(1, d));
      }
      if (st.workspace === 'paint') PS.Paint.drawCursor(ctx);
    },

    drawIsoPreview(ctx, preview, v) {
      const p = PS.state.project, Iso = PS.Iso;
      const layer = preview.layer;
      const z = (layer.solid ? layer.elev + layer.blocks : layer.elev) * T;
      const get = PS.Autotile.getter(layer, preview.cells);
      for (const [i, value] of preview.cells) {
        const x = i % p.width, y = Math.floor(i / p.width);
        if (value) {
          ctx.globalAlpha = preview.alpha || 0.7;
          Iso.drawGhost(ctx, get, x, y, z, v);
          ctx.globalAlpha = 1;
        } else if (preview.showErase !== false) {
          Iso.tracePolygon(ctx, Iso.cellPolygon(x, y, 1, 1, z), v);
          ctx.fillStyle = 'rgba(255, 92, 122, 0.4)';
          ctx.fill();
        }
      }
    },

    /** At high zoom in Paint mode, show every art pixel. */
    drawPixelGrid(ctx, mx0, my0, mx1, my1) {
      const s = R.scale, cam = R.view;
      if (s < 10 || PS.state.project.tilesets.some((t) => PS.Assets.isHires(t))) return;
      const W = R.canvas.width, H = R.canvas.height;
      ctx.beginPath();
      for (let x = Math.max(0, Math.floor(cam.x)); x <= cam.x + W / s; x++) {
        const px = Math.round((x - cam.x) * s) + 0.5;
        ctx.moveTo(px, Math.max(my0, 0)); ctx.lineTo(px, Math.min(my1, H));
      }
      for (let y = Math.max(0, Math.floor(cam.y)); y <= cam.y + H / s; y++) {
        const py = Math.round((y - cam.y) * s) + 0.5;
        ctx.moveTo(Math.max(mx0, 0), py); ctx.lineTo(Math.min(mx1, W), py);
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
      ctx.stroke();
    },

    drawCellPreview(ctx, preview) {
      const p = PS.state.project, s = R.scale, cam = R.view;
      const get = PS.Autotile.getter(preview.layer, preview.cells);
      const size = T * s;
      const rect = (x0, y0, x1, y1) => {
        const dx = Math.round((x0 - cam.x) * s), dy = Math.round((y0 - cam.y) * s);
        return { dx, dy, dw: Math.round((x1 - cam.x) * s) - dx, dh: Math.round((y1 - cam.y) * s) - dy };
      };
      // Painting a cell can change the four display tiles around it.
      const seen = new Set();
      for (const [i, v] of preview.cells) {
        const x = i % p.width, y = Math.floor(i / p.width);
        if (v) {
          ctx.globalAlpha = preview.alpha || 0.7;
          for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
            const key = (y + oy) * (p.width + 1) + x + ox;
            if (seen.has(key)) continue;
            seen.add(key);
            const r = rect((x + ox - 0.5) * T, (y + oy - 0.5) * T, (x + ox + 0.5) * T, (y + oy + 0.5) * T);
            PS.Autotile.drawDisplay(ctx, get, x + ox, y + oy, r.dx, r.dy, r.dw, r.dh);
          }
          ctx.globalAlpha = 1;
        } else if (preview.showErase !== false) {
          const { dx, dy, dw, dh } = rect(x * T, y * T, (x + 1) * T, (y + 1) * T);
          ctx.fillStyle = 'rgba(255, 92, 122, 0.35)';
          ctx.fillRect(dx, dy, dw, dh);
          ctx.strokeStyle = 'rgba(255, 92, 122, 0.9)';
          ctx.lineWidth = Math.max(1, R.dpr);
          if (size > 8) ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
        }
      }
    },

    drawGrid(ctx, mx0, my0, mx1, my1) {
      const p = PS.state.project, s = R.scale, cam = R.view;
      if (!PS.state.prefs.showGrid || T * s < 5) return;
      const W = R.canvas.width, H = R.canvas.height;
      const x0 = Math.max(0, Math.floor(cam.x / T)), x1 = Math.min(p.width, Math.ceil((cam.x + W / s) / T));
      const y0 = Math.max(0, Math.floor(cam.y / T)), y1 = Math.min(p.height, Math.ceil((cam.y + H / s) / T));
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const px = Math.round((x * T - cam.x) * s) + 0.5;
        ctx.moveTo(px, Math.max(my0, 0)); ctx.lineTo(px, Math.min(my1, H));
      }
      for (let y = y0; y <= y1; y++) {
        const py = Math.round((y * T - cam.y) * s) + 0.5;
        ctx.moveTo(Math.max(mx0, 0), py); ctx.lineTo(Math.min(mx1, W), py);
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = p.level.transparentSky ? R.theme.grid : 'rgba(10, 20, 40, 0.16)';
      ctx.stroke();
    },

    cellRect(x, y, w = 1, h = 1) {
      const s = R.scale, cam = R.view;
      const x0 = Math.round((x * T - cam.x) * s), y0 = Math.round((y * T - cam.y) * s);
      return { x: x0, y: y0, w: Math.round(((x + w) * T - cam.x) * s) - x0, h: Math.round(((y + h) * T - cam.y) * s) - y0 };
    },

    roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
    },

    drawObjectOverlays(ctx) {
      const st = PS.state, p = st.project, d = R.dpr;
      const objLayer = PS.Project.objectsLayer();
      if (!objLayer || !objLayer.visible) return;
      ctx.font = `700 ${Math.round(9 * d)}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const o of p.objects) {
        const drag = PS.Tools.objectDrag;
        const pos = drag && drag.id === o.id ? drag : o;
        const r = R.cellRect(pos.x, pos.y);
        if (o.kind === 'spawn' || o.kind === 'goal') {
          const label = o.kind === 'spawn' ? 'START' : 'GOAL';
          const tw = ctx.measureText(label).width + 10 * d;
          const ly = r.y - 8 * d;
          ctx.fillStyle = o.kind === 'spawn' ? '#14b37d' : '#f59f00';
          R.roundRect(ctx, r.x + r.w / 2 - tw / 2, ly - 7 * d, tw, 14 * d, 5 * d);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.fillText(label, r.x + r.w / 2, ly + 0.5 * d);
        }
        if (o.id === st.selectedObjectId) {
          if (o.kind === 'enemy') R.drawEnemyRange(ctx, o, pos);
          ctx.lineWidth = 2 * d;
          ctx.strokeStyle = R.theme.accent;
          R.roundRect(ctx, r.x - 2 * d, r.y - 2 * d, r.w + 4 * d, r.h + 4 * d, 5 * d);
          ctx.stroke();
        }
      }
    },

    drawEnemyRange(ctx, o, pos) {
      const d = R.dpr, b = o.props.behavior;
      ctx.save();
      ctx.strokeStyle = R.theme.accent2;
      ctx.fillStyle = R.theme.accent2;
      ctx.lineWidth = 2 * d;
      ctx.setLineDash([6 * d, 4 * d]);
      if (b === 'patrol' || b === 'fly') {
        const a = R.cellRect(pos.x - o.props.distance, pos.y, o.props.distance * 2 + 1, 1);
        const cy = a.y + a.h / 2;
        ctx.beginPath(); ctx.moveTo(a.x, cy); ctx.lineTo(a.x + a.w, cy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillRect(a.x - d, cy - 6 * d, 2 * d, 12 * d);
        ctx.fillRect(a.x + a.w - d, cy - 6 * d, 2 * d, 12 * d);
      } else if (b === 'chase') {
        const c = R.cellRect(pos.x, pos.y);
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(c.x + c.w / 2, c.y + c.h / 2, o.props.range * T * R.scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.07;
        ctx.fill();
      }
      ctx.restore();
    },

    drawObjectPreview(ctx, pv) {
      const s = R.scale, cam = R.view;
      if (pv.frame) R.drawSprite(ctx, pv.frame, pv.x * T, pv.y * T, cam.x, cam.y, s, pv.flip, pv.valid ? 0.6 : 0.25);
    },

    drawSelection(ctx) {
      const st = PS.state, d = R.dpr;
      const sel = PS.Tools.selectionDraft || st.selection;
      if (!sel) return;
      const r = R.cellRect(sel.x, sel.y, sel.w, sel.h);
      ctx.fillStyle = 'rgba(139, 123, 255, 0.10)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.lineWidth = Math.max(1, d);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.setLineDash([5 * d, 4 * d]);
      ctx.strokeStyle = R.theme.accent;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.setLineDash([]);
    },

    drawHover(ctx, preview) {
      const h = PS.Tools.hover;
      if (!h || !PS.Project.inBounds(h.x, h.y) || PS.Tools.dragging) return;
      const tool = PS.state.tool;
      if (tool === 'select' || tool === 'move') return;
      const r = R.cellRect(h.x, h.y);
      const d = R.dpr;
      ctx.lineWidth = 2 * d;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.strokeRect(r.x + d, r.y + d, r.w - 2 * d, r.h - 2 * d);
      ctx.lineWidth = Math.max(1, d);
      ctx.strokeStyle = tool === 'eraser' ? R.theme.danger : (preview && preview.blocked ? R.theme.danger : '#ffffff');
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    },
  };

  PS.Renderer = R;
})(window.PS);
