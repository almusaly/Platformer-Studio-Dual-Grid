/* =====================================================================
   Platformer Studio — asset manager
   Caches decoded images (by data URL) and the 32×32 frames derived from
   custom characters and collectibles, so rendering never re-decodes.
   Every tileset gets a working canvas: painting changes it directly, and
   the map redraws from it, so the edits show live everywhere.
   ===================================================================== */
(function (PS) {
  'use strict';

  const lib = PS.Sprites;
  const images = new Map();           // src -> { img, ok, failed, waiters }
  const derived = new Map();          // custom asset object -> { sig, value }

  const notifyReady = PS.util.debounce(() => {
    derived.clear();
    if (PS.Renderer) { PS.Renderer.invalidateAll(); PS.Renderer.request(); }
    PS.bus.emit('assets-ready');
  }, 30);

  function entry(src) {
    let e = images.get(src);
    if (!e) {
      e = { img: new Image(), ok: false, failed: false, waiters: [] };
      e.img.onload = () => { e.ok = true; e.waiters.forEach((w) => w.resolve(e.img)); e.waiters = []; notifyReady(); };
      e.img.onerror = () => { e.failed = true; e.waiters.forEach((w) => w.reject(new Error('image'))); e.waiters = []; };
      e.img.src = src;
      images.set(src, e);
    }
    return e;
  }

  function fitFrame(img, sx, sy, sw, sh, align = 'bottom') {
    const c = lib.canvas();
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    let s = Math.min(32 / sw, 32 / sh);
    if (s >= 1) s = Math.floor(s);
    const dw = Math.max(1, Math.round(sw * s)), dh = Math.max(1, Math.round(sh * s));
    const dx = Math.floor((32 - dw) / 2);
    const dy = align === 'bottom' ? 32 - dh : Math.floor((32 - dh) / 2);
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    return c;
  }

  function cached(obj, sig, build) {
    const hit = derived.get(obj);
    if (hit && hit.sig === sig) return hit.value;
    const value = build();
    if (value) derived.set(obj, { sig, value });
    return value;
  }

  /** Give a tileset its working canvas, at the image's own resolution.
   *  Classic 3 × 3 sheets are converted to the dual layout. */
  function adoptTileset(ts, img) {
    const classic = img.width === 96 && img.height === 96;
    const size = img.width === img.height && PS.Autotile.RESOLUTIONS.includes(img.width) ? img.width : PS.Autotile.SHEET;
    const c = classic ? PS.Tilegen.fromClassic(img) : lib.canvas(size, size);
    if (!classic) c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
    if (classic) ts.src = c.toDataURL('image/png');
    ts.canvas = c;
    ts.version = (ts.version || 0) + 1;
    return c;
  }

  const ANIMS = ['idle', 'walk', 'jump', 'fall'];

  const Assets = {
    ANIMS,

    /** Decoded image for src, or null while it is still loading. */
    image(src) {
      if (!src) return null;
      const e = entry(src);
      return e.ok ? e.img : null;
    },

    load(src) {
      const e = entry(src);
      if (e.ok) return Promise.resolve(e.img);
      if (e.failed) return Promise.reject(new Error('image'));
      return new Promise((resolve, reject) => e.waiters.push({ resolve, reject }));
    },

    /** Load every image used by a project; resolves with the number of failures. */
    async preload(p) {
      const srcs = [
        ...p.tilesets.map((t) => t.src),
        ...p.characters.map((c) => c.src),
        ...p.customCollectibles.map((c) => c.src),
      ];
      const results = await Promise.allSettled(srcs.map((s) => Assets.load(s)));
      for (const ts of p.tilesets) Assets.tilesetCanvas(ts);
      return results.filter((r) => r.status === 'rejected').length;
    },

    /** Drop decoded images that the current project no longer references. */
    prune() {
      const p = PS.state.project;
      const keep = new Set([...p.tilesets, ...p.characters, ...p.customCollectibles].map((a) => a.src));
      for (const src of images.keys()) if (!keep.has(src)) images.delete(src);
      derived.clear();
    },

    clearDerived(obj) { if (obj) derived.delete(obj); else derived.clear(); },

    /** Is this sheet larger than the standard 128? Such art is shown smoothed when small. */
    isHires(ts) { return !!ts.canvas && ts.canvas.width > PS.Autotile.SHEET; },

    tilesetImage(id) {
      const ts = PS.Project.tileset(id);
      return ts ? Assets.tilesetCanvas(ts) : null;
    },

    /** The canvas a tileset is drawn from and painted on, or null while its image is loading. */
    tilesetCanvas(ts) {
      if (ts.canvas) return ts.canvas;
      const img = Assets.image(ts.src);
      return img ? adoptTileset(ts, img) : null;
    },

    /** Swap a tileset's art for a new canvas or image data URL. */
    async setTilesetSource(ts, src) {
      ts.src = src;
      ts.canvas = null;
      await Assets.load(src).catch(() => {});
      Assets.tilesetCanvas(ts);
      if (PS.Renderer) PS.Renderer.invalidateTileset(ts.id);
    },

    /* ------------------------------ Characters ------------------------------ */
    customCharacter(key) {
      if (typeof key !== 'string' || !key.startsWith('char:')) return null;
      const id = Number(key.slice(5));
      return PS.state.project.characters.find((c) => c.id === id) || null;
    },

    characterList() {
      const list = Object.values(lib.characters).map((c) => ({ key: c.key, name: c.name, custom: false }));
      for (const c of PS.state.project.characters) list.push({ key: 'char:' + c.id, name: c.name, custom: true, def: c });
      return list;
    },

    /** Frame sets for a character: { frames: {idle, walk, jump, fall}, fps, fallback } */
    character(key) {
      if (lib.characters[key]) return { ...lib.characters[key], fallback: false, custom: false };
      const def = Assets.customCharacter(key);
      if (!def) return { ...lib.characters.ninja, fallback: false, custom: false };
      const img = Assets.image(def.src);
      if (!img) return { ...lib.characters.ninja, name: def.name, fallback: false, custom: true, loading: true };
      const sig = [def.src.length, def.frameW, def.frameH, JSON.stringify(def.anims), def.fps].join('|');
      return cached(def, sig, () => {
        const sheet = Assets.sheetFrames(img, def.frameW, def.frameH);
        const all = sheet.map((f) => fitFrame(img, f.x, f.y, f.w, f.h, 'bottom'));
        const pick = (list) => (list || []).filter((i) => i >= 0 && i < all.length).map((i) => all[i]);
        let idle = pick(def.anims.idle);
        if (!idle.length) idle = [all[0]];
        let walk = pick(def.anims.walk);
        if (!walk.length) walk = idle;
        const jumpRaw = pick(def.anims.jump), fallRaw = pick(def.anims.fall);
        const jump = jumpRaw.length ? jumpRaw : fallRaw.length ? fallRaw : [idle[0]];
        const fall = fallRaw.length ? fallRaw : jump;
        const animated = idle.length > 1 || walk.length > 1 || jumpRaw.length > 0 || fallRaw.length > 0;
        return { key: 'char:' + def.id, name: def.name, frames: { idle, walk, jump, fall }, fps: def.fps || 8, fallback: !animated, custom: true };
      });
    },

    /** Rectangles of each frame in a sprite sheet, reading left-to-right, top-to-bottom. */
    sheetFrames(img, fw, fh) {
      const cols = Math.max(1, Math.floor(img.width / fw));
      const rows = Math.max(1, Math.floor(img.height / fh));
      const out = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        if (out.length >= 256) return out;
        out.push({ x: x * fw, y: y * fh, w: Math.min(fw, img.width), h: Math.min(fh, img.height) });
      }
      return out;
    },

    /* ------------------------------ Enemies & goals ------------------------------ */
    enemy(type) { return lib.enemies[type] || lib.enemies.slime; },
    enemyList() { return Object.values(lib.enemies); },
    goal(type) { return lib.goals[type] || lib.goals.flag; },
    goalList() { return Object.values(lib.goals); },

    /* ------------------------------ Collectibles ------------------------------ */
    customCollectible(key) {
      if (typeof key !== 'string' || !key.startsWith('item:')) return null;
      const id = Number(key.slice(5));
      return PS.state.project.customCollectibles.find((c) => c.id === id) || null;
    },

    collectible(type) {
      if (lib.collectibles[type]) return { ...lib.collectibles[type], custom: false };
      const def = Assets.customCollectible(type);
      if (!def) return { ...lib.collectibles.coin, name: 'Missing item', custom: false };
      const img = Assets.image(def.src);
      const base = { key: 'item:' + def.id, name: def.name, points: def.points, life: 0, anim: def.anim, sound: def.sound, custom: true };
      if (!img) return { ...base, frames: lib.collectibles.coin.frames, loading: true };
      const v = cached(def, def.src.length + '|' + def.src.slice(-32), () => ({
        frames: [fitFrame(img, 0, 0, img.width, img.height, 'center')],
      }));
      return { ...base, frames: v.frames };
    },

    collectibleList() {
      const list = Object.values(lib.collectibles).map((c) => ({ key: c.key, name: c.name }));
      for (const c of PS.state.project.customCollectibles) list.push({ key: 'item:' + c.id, name: c.name, custom: true, def: c });
      return list;
    },

    /* ------------------------------ Upload validation ------------------------------ */
    /** Read and validate an uploaded image. Never throws; returns { ok, src, img, error }. */
    async readImageFile(file, { sizes = null, maxSide = 2048 } = {}) {
      const name = file && file.name ? `“${file.name}”` : 'This file';
      if (!PS.util.isImageFile(file)) {
        return { ok: false, error: `${name} isn't a supported image. Please use a PNG (best for transparency), GIF, WebP or JPEG.` };
      }
      if (file.size > 8 * 1024 * 1024) {
        return { ok: false, error: `${name} is larger than 8 MB. Pixel-art images are usually much smaller; try exporting it again as PNG.` };
      }
      let src, img;
      try {
        src = await PS.util.readAsDataURL(file);
        img = await PS.util.loadImage(src);
      } catch (e) {
        return { ok: false, error: `${name} couldn't be opened. The file might be damaged; try saving it again from your art app.` };
      }
      if (sizes && !sizes.some(([w, h]) => img.width === w && img.height === h)) {
        return {
          ok: false,
          error: `${name} is ${img.width} × ${img.height} pixels. Tilesets must be square, 4 × 4 tiles: 128, 256, 512 or 1024 pixels wide. A classic 96 × 96 set also works, and is converted for you. ` +
            `You can also create one right here with the New button.`,
        };
      }
      if (img.width > maxSide || img.height > maxSide) {
        return { ok: false, error: `${name} is ${img.width} × ${img.height} pixels, which is too large. Please keep images under ${maxSide} pixels per side.` };
      }
      return { ok: true, src, img, name: PS.util.cleanName(PS.util.fileBase(file.name), 'Untitled', 30) };
    },
  };

  PS.Assets = Assets;
})(window.PS);
