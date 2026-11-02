/* =====================================================================
   Platformer Studio — saving, loading and autosave
   Project files are self-contained JSON: every image is embedded as a
   data URL, and tile layers are run-length encoded. Imported files are
   fully validated and normalised; nothing from a file is trusted.
   ===================================================================== */
(function (PS) {
  'use strict';

  const U = PS.util;
  const FORMAT = 'platformer-studio';
  const AUTOSAVE_KEY = 'platformer-studio-autosave';
  const BUILTIN_CHARACTERS = Object.keys(PS.Sprites.characters);
  const ENEMY_TYPES = Object.keys(PS.Sprites.enemies);
  const ITEM_TYPES = Object.keys(PS.Sprites.collectibles);
  const GOAL_TYPES = Object.keys(PS.Sprites.goals);
  const BEHAVIORS = PS.Project.ENEMY_BEHAVIORS.map((b) => b.key);
  const ANIMS = ['none', 'bob', 'spin', 'pulse'];
  const SOUNDS = ['coin', 'chime', 'power', 'none'];

  class ProjectError extends Error {}
  const fail = (msg) => { throw new ProjectError(msg); };
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isHexColor = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
  const isImageURL = (s) => typeof s === 'string' && /^data:image\/(png|gif|webp|bmp|jpeg|avif);base64,[A-Za-z0-9+/=]+$/.test(s);

  /* ------------------------------ Run-length encoding ------------------------------ */
  function encodeRLE(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
      const v = data[i];
      let n = 1;
      while (i + n < data.length && data[i + n] === v) n++;
      out.push(v, n);
      i += n;
    }
    return out;
  }

  function decodeRLE(arr, size, validIds) {
    if (!Array.isArray(arr) || arr.length % 2) fail('A layer in this file is damaged.');
    const out = new Uint16Array(size);
    let pos = 0;
    for (let k = 0; k < arr.length; k += 2) {
      const v = arr[k], n = arr[k + 1];
      if (!Number.isInteger(v) || !Number.isInteger(n) || n < 1 || v < 0 || pos + n > size) fail('A layer in this file is damaged.');
      if (v && validIds.has(v)) out.fill(v, pos, pos + n);
      pos += n;
    }
    if (pos !== size) fail('A layer in this file does not match the map size.');
    return out;
  }

  /* ------------------------------ Serialize ------------------------------ */
  function serialize(p) {
    return {
      format: FORMAT,
      version: 2,
      name: p.name,
      width: p.width,
      height: p.height,
      tileSize: PS.TILE,
      nextId: p.nextId,
      tilesets: p.tilesets.map((t) => ({ id: t.id, name: t.name, src: t.src })),
      characters: p.characters.map((c) => ({ id: c.id, name: c.name, src: c.src, frameW: c.frameW, frameH: c.frameH, anims: c.anims, fps: c.fps })),
      customCollectibles: p.customCollectibles.map((c) => ({ id: c.id, name: c.name, src: c.src, points: c.points, anim: c.anim, sound: c.sound })),
      layers: p.layers.map((l) => ({
        id: l.id, name: l.name, type: l.type, visible: l.visible, locked: l.locked,
        opacity: l.opacity, solid: l.solid, depth: l.depth,
        drift: l.drift, repeat: l.repeat, groupId: l.groupId, elev: l.elev, blocks: l.blocks,
        shadowOn: l.shadowOn, shadowColor: l.shadowColor, shadowOpacity: l.shadowOpacity, shadowX: l.shadowX, shadowY: l.shadowY, shadowBlur: l.shadowBlur, shadowReach: l.shadowReach,
        data: l.data ? encodeRLE(l.data) : undefined,
      })),
      objects: p.objects.map((o) => ({ id: o.id, kind: o.kind, type: o.type, x: o.x, y: o.y, props: o.props })),
      groups: p.groups.map((g) => ({ id: g.id, name: g.name, depth: g.depth, drift: g.drift, repeat: g.repeat, collapsed: g.collapsed })),
      palettes: p.palettes.map((x) => ({ key: x.key, name: x.name, colors: x.colors })),
      paletteKey: p.paletteKey,
      view: p.view,
      iso: p.iso,
      character: p.character,
      physics: p.physics,
      game: p.game,
      level: p.level,
    };
  }

  /* ------------------------------ Deserialize (validate + normalise) ------------------------------ */
  function deserialize(raw) {
    if (!isObj(raw)) fail("This file doesn't contain a Platformer Studio project.");
    if (raw.format !== FORMAT && !(Array.isArray(raw.layers) && 'width' in raw)) fail("This file doesn't look like a Platformer Studio project.");
    const { minMap, maxMap } = PS.LIMITS;
    const width = raw.width, height = raw.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < minMap || height < minMap || width > maxMap || height > maxMap) {
      fail(`The map size in this file is invalid. Sizes must be between ${minMap} and ${maxMap} tiles.`);
    }
    let maxId = 0;
    const takeId = (v, used) => {
      let id = Number.isInteger(v) && v > 0 && v < 60000 && !used.has(v) ? v : 0;
      if (!id) id = -1;
      if (id > 0) { used.add(id); maxId = Math.max(maxId, id); }
      return id;
    };
    const used = new Set();
    const pending = [];
    const fixIds = () => { for (const a of pending) { a.id = ++maxId; used.add(a.id); } };

    const p = {
      name: U.cleanName(raw.name, 'My Platformer', 40),
      width, height, tileSize: PS.TILE, nextId: 1,
      tilesets: [], characters: [], customCollectibles: [], layers: [], objects: [], groups: [],
      palettes: [], paletteKey: PS.Palettes.DEFAULT_KEY,
      view: raw.view === 'iso' ? 'iso' : 'side',
      iso: { ...PS.Project.DEFAULT_ISO },
      character: 'ninja',
      physics: { ...PS.Project.DEFAULT_PHYSICS },
      game: { ...PS.Project.DEFAULT_GAME },
      level: { ...PS.Project.DEFAULT_LEVEL },
    };

    for (const t of Array.isArray(raw.tilesets) ? raw.tilesets.slice(0, 200) : []) {
      if (!isObj(t) || !isImageURL(t.src)) continue;
      const ts = { id: takeId(t.id, used), name: U.cleanName(t.name, 'Tileset', 30), src: t.src };
      if (ts.id < 0) pending.push(ts);
      p.tilesets.push(ts);
    }
    for (const c of Array.isArray(raw.characters) ? raw.characters.slice(0, 100) : []) {
      if (!isObj(c) || !isImageURL(c.src)) continue;
      const anims = {};
      for (const k of PS.Assets.ANIMS) {
        const list = isObj(c.anims) && Array.isArray(c.anims[k]) ? c.anims[k] : [];
        anims[k] = list.filter((i) => Number.isInteger(i) && i >= 0 && i < 256).slice(0, 64);
      }
      const ch = {
        id: takeId(c.id, used), name: U.cleanName(c.name, 'Hero', 30), src: c.src,
        frameW: U.int(c.frameW, 32, 1, 2048), frameH: U.int(c.frameH, 32, 1, 2048),
        anims, fps: U.int(c.fps, 8, 1, 30),
      };
      if (ch.id < 0) pending.push(ch);
      p.characters.push(ch);
    }
    for (const c of Array.isArray(raw.customCollectibles) ? raw.customCollectibles.slice(0, 200) : []) {
      if (!isObj(c) || !isImageURL(c.src)) continue;
      const it = {
        id: takeId(c.id, used), name: U.cleanName(c.name, 'Item', 30), src: c.src,
        points: U.int(c.points, 10, 0, 100000), anim: U.oneOf(c.anim, ANIMS, 'bob'), sound: U.oneOf(c.sound, SOUNDS, 'coin'),
      };
      if (it.id < 0) pending.push(it);
      p.customCollectibles.push(it);
    }

    for (const x of Array.isArray(raw.palettes) ? raw.palettes.slice(0, 64) : []) {
      if (!isObj(x) || typeof x.key !== 'string' || !x.key.startsWith('u:') || x.key.length > 120 || !Array.isArray(x.colors)) continue;
      const colors = x.colors.filter(isHexColor).slice(0, PS.Palettes.MAX_COLORS);
      if (colors.length >= 2) p.palettes.push({ key: x.key, name: U.cleanName(x.name, 'Palette', 40), colors });
    }
    if (typeof raw.paletteKey === 'string') {
      if (PS.Palettes.BUILTIN.some((b) => b.key === raw.paletteKey) || p.palettes.some((x) => x.key === raw.paletteKey)) p.paletteKey = raw.paletteKey;
    }
    const iso = isObj(raw.iso) ? raw.iso : {};
    p.iso = {
      ground: isHexColor(iso.ground) ? iso.ground : PS.Project.DEFAULT_ISO.ground,
      pits: !!iso.pits,
      shadowPlayer: iso.shadowPlayer !== false,
      shadowNpc: iso.shadowNpc !== false,
      shadowObjects: iso.shadowObjects !== false,
      blockShadows: iso.blockShadows !== false,
      sunAngle: Number.isFinite(iso.sunAngle) ? U.clamp(iso.sunAngle, 0, 360) : PS.Project.DEFAULT_ISO.sunAngle,
      sunHeight: Number.isFinite(iso.sunHeight) ? U.clamp(iso.sunHeight, 15, 85) : PS.Project.DEFAULT_ISO.sunHeight,
      shadowDarkness: Number.isFinite(iso.shadowDarkness) ? U.clamp(iso.shadowDarkness, 0.1, 0.8) : PS.Project.DEFAULT_ISO.shadowDarkness,
    };

    if (!Array.isArray(raw.layers) || !raw.layers.length) fail('This project has no layers.');
    const tsIds = () => new Set(p.tilesets.map((t) => t.id));
    const layersRaw = raw.layers.slice(0, PS.LIMITS.maxLayers);
    const tmpLayers = [];
    for (const l of layersRaw) {
      if (!isObj(l)) continue;
      const type = l.type === 'objects' ? 'objects' : 'tiles';
      if (type === 'objects' && tmpLayers.some((x) => x.type === 'objects')) continue;
      tmpLayers.push({ l, type });
    }
    // Ids are fixed after all assets so new ids never collide.
    fixIds();
    pending.length = 0;
    const groupIds = new Set();
    for (const g of Array.isArray(raw.groups) ? raw.groups.slice(0, PS.LIMITS.maxLayers) : []) {
      if (!isObj(g)) continue;
      const group = {
        id: takeId(g.id, used), name: U.cleanName(g.name, 'Group', 30),
        depth: U.num(g.depth, 1, 0.1, 1.5), drift: U.num(g.drift, 0, -120, 120), repeat: !!g.repeat, collapsed: !!g.collapsed,
      };
      if (group.id < 0) continue;
      groupIds.add(group.id);
      p.groups.push(group);
    }
    for (const { l, type } of tmpLayers) {
      const layer = {
        id: takeId(l.id, used),
        name: U.cleanName(l.name, type === 'objects' ? 'Objects' : 'Layer', 30),
        type,
        visible: l.visible !== false,
        locked: !!l.locked,
        opacity: U.num(l.opacity, 1, 0, 1),
        solid: type === 'tiles' && !!l.solid,
        depth: U.num(l.depth, 1, 0.1, 1.5),
        drift: U.num(l.drift, 0, -120, 120),
        repeat: !!l.repeat,
        groupId: type === 'tiles' && groupIds.has(l.groupId) ? l.groupId : 0,
        elev: U.int(l.elev, 0, 0, 8),
        blocks: U.int(l.blocks, 1, 1, 4),
        shadowOn: !!l.shadowOn,
        shadowColor: isHexColor(l.shadowColor) ? l.shadowColor : '#000000',
        shadowOpacity: U.num(l.shadowOpacity, 0.5, 0, 1),
        shadowX: U.int(l.shadowX, 4, -32, 32),
        shadowY: U.int(l.shadowY, 4, -32, 32),
        shadowBlur: U.int(l.shadowBlur, 0, 0, 16),
        shadowReach: U.int(l.shadowReach, 1, 1, PS.LIMITS.maxLayers - 1),
        data: type === 'tiles' ? decodeRLE(l.data, width * height, tsIds()) : null,
      };
      if (layer.id < 0) pending.push(layer);
      p.layers.push(layer);
    }
    if (!p.layers.some((l) => l.type === 'objects')) {
      const ol = { id: -1, name: 'Objects', type: 'objects', visible: true, locked: false, opacity: 1, solid: false, depth: 1, drift: 0, repeat: false, groupId: 0, elev: 0, blocks: 1, shadowOn: false, shadowColor: '#000000', shadowOpacity: 0.5, shadowX: 4, shadowY: 4, shadowBlur: 0, shadowReach: 1, data: null };
      pending.push(ol);
      p.layers.push(ol);
    }
    fixIds();
    pending.length = 0;

    const occupied = new Set();
    let hasSpawn = false, hasGoal = false;
    const customItems = new Set(p.customCollectibles.map((c) => 'item:' + c.id));
    for (const o of Array.isArray(raw.objects) ? raw.objects.slice(0, PS.LIMITS.maxObjects) : []) {
      if (!isObj(o)) continue;
      const x = o.x, y = o.y;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) continue;
      if (occupied.has(y * width + x)) continue;
      const props = isObj(o.props) ? o.props : {};
      let obj = null;
      if (o.kind === 'spawn' && !hasSpawn) { obj = { kind: 'spawn', type: null, props: {} }; hasSpawn = true; }
      else if (o.kind === 'goal' && !hasGoal) { obj = { kind: 'goal', type: U.oneOf(o.type, GOAL_TYPES, 'flag'), props: {} }; hasGoal = true; }
      else if (o.kind === 'enemy') {
        const type = U.oneOf(o.type, ENEMY_TYPES, 'slime');
        const d = PS.Project.ENEMY_DEFAULTS[type];
        obj = {
          kind: 'enemy', type, props: {
            behavior: U.oneOf(props.behavior, BEHAVIORS, d.behavior),
            speed: U.int(props.speed, d.speed, 1, 10),
            distance: U.int(props.distance, d.distance, 0, 50),
            dir: props.dir < 0 ? -1 : 1,
            range: U.int(props.range, d.range, 1, 40),
          },
        };
      } else if (o.kind === 'collectible') {
        const type = ITEM_TYPES.includes(o.type) || customItems.has(o.type) ? o.type : null;
        if (!type) continue;
        const def = ITEM_TYPES.includes(type) ? PS.Sprites.collectibles[type] : p.customCollectibles.find((c) => 'item:' + c.id === type);
        obj = {
          kind: 'collectible', type, props: {
            points: U.int(props.points, def.points, 0, 100000),
            anim: U.oneOf(props.anim, ANIMS, def.anim),
            sound: U.oneOf(props.sound, SOUNDS, def.sound),
          },
        };
      }
      if (!obj) continue;
      occupied.add(y * width + x);
      obj.id = takeId(o.id, used);
      if (obj.id < 0) pending.push(obj);
      obj.x = x; obj.y = y;
      p.objects.push(obj);
    }
    fixIds();

    const customChars = new Set(p.characters.map((c) => 'char:' + c.id));
    p.character = BUILTIN_CHARACTERS.includes(raw.character) || customChars.has(raw.character) ? raw.character : 'ninja';

    const ph = isObj(raw.physics) ? raw.physics : {};
    const d = PS.Project.DEFAULT_PHYSICS;
    p.physics = {
      walkSpeed: U.int(ph.walkSpeed, d.walkSpeed, 40, 400),
      runSpeed: U.int(ph.runSpeed, d.runSpeed, 60, 600),
      jumpStrength: U.int(ph.jumpStrength, d.jumpStrength, 150, 900),
      gravity: U.int(ph.gravity, d.gravity, 300, 3500),
      doubleJump: ph.doubleJump !== false,
    };
    const g = isObj(raw.game) ? raw.game : {};
    const dg = PS.Project.DEFAULT_GAME;
    p.game = {
      lives: U.int(g.lives, dg.lives, 1, 99),
      stomp: g.stomp !== false,
      winCondition: U.oneOf(g.winCondition, ['goal', 'all', 'score'], 'goal'),
      requiredScore: U.int(g.requiredScore, dg.requiredScore, 0, 1000000),
      cameraSmoothing: g.cameraSmoothing !== false,
    };
    const lv = isObj(raw.level) ? raw.level : {};
    p.level = {
      sky: typeof lv.sky === 'string' && /^#[0-9a-f]{6}$/i.test(lv.sky) ? lv.sky : PS.Project.DEFAULT_LEVEL.sky,
      transparentSky: !!lv.transparentSky,
      connectAcross: !!lv.connectAcross,
      edgeConnect: lv.edgeConnect !== false,
      parallax: lv.parallax !== false,
    };
    p.groups = p.groups.filter((g) => p.layers.filter((l) => l.groupId === g.id).length >= 2);
    for (const l of p.layers) if (l.groupId && !p.groups.some((g) => g.id === l.groupId)) l.groupId = 0;
    p.nextId = Math.max(maxId, Number.isInteger(raw.nextId) && raw.nextId < 60000 ? raw.nextId - 1 : 0) + 1;
    return p;
  }

  /* ------------------------------ Large autosaves ------------------------------
     Browser localStorage holds only about 5 MB, which a few high-resolution
     sheets can fill. Projects too big for it go to IndexedDB instead. */
  const openDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open('platformer-studio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('autosave');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function dbRun(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('autosave', mode);
      const req = fn(tx.objectStore('autosave'));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  /* ------------------------------ Public API ------------------------------ */
  let autosaveFailed = false;
  let savedInDb = true;   // assume there may be an old copy, so the first small save clears it

  const Storage = {
    serialize,
    deserialize,

    saveFile() {
      try {
        const p = PS.state.project;
        const json = JSON.stringify(serialize(p));
        PS.util.downloadBlob(new Blob([json], { type: 'application/json' }), U.safeFileName(p.name) + '.json');
        PS.state.dirty = false;
        PS.UI.toast('Project saved. Open this file later with the folder button.', 'success');
      } catch (e) {
        PS.UI.toast('Sorry, the project could not be saved. Please try again.', 'error');
      }
    },

    async openFile(file) {
      if (!file) return;
      if (file.size > 80 * 1024 * 1024) return PS.UI.toast('That file is too large to be a project.', 'error');
      let p;
      try {
        const text = await U.readAsText(file);
        let raw;
        try { raw = JSON.parse(text); } catch (e) { fail(`“${file.name}” isn't a project file. Choose a .json file saved from Platformer Studio.`); }
        p = deserialize(raw);
      } catch (e) {
        return PS.UI.toast(e instanceof ProjectError ? e.message : 'This project could not be opened.', 'error', { duration: 6000 });
      }
      await PS.App.setProject(p);
      PS.UI.toast(`Opened “${p.name}”`, 'success');
    },

    scheduleAutosave: U.debounce(() => Storage.autosave(), 900),

    autosave() {
      const p = PS.state.project;
      if (!p) return;
      const json = JSON.stringify(serialize(p));
      const saved = () => {
        if (!autosaveFailed) return;
        autosaveFailed = false;
        PS.UI.toast('Autosave is working again.', 'success');
      };
      try {
        localStorage.setItem(AUTOSAVE_KEY, json);
        saved();
        if (savedInDb) {
          savedInDb = false;
          dbRun('readwrite', (store) => store.delete(AUTOSAVE_KEY)).catch(() => {});
        }
      } catch (e) {
        try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e2) { /* ignore */ }
        savedInDb = true;
        dbRun('readwrite', (store) => store.put(json, AUTOSAVE_KEY)).then(saved).catch(() => {
          if (autosaveFailed) return;
          autosaveFailed = true;
          PS.UI.toast('Autosave paused: browser storage is full (large images take up space). Use Save to download your project.', 'warn', { duration: 7000 });
        });
      }
    },

    async restore() {
      try {
        // A copy in IndexedDB only exists while it is the newest one.
        const big = await dbRun('readonly', (store) => store.get(AUTOSAVE_KEY)).catch(() => null);
        const raw = big || localStorage.getItem(AUTOSAVE_KEY);
        if (!raw) return null;
        return deserialize(JSON.parse(raw));
      } catch (e) {
        return null;
      }
    },

    clearAutosave() {
      try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) { /* ignore */ }
    },
  };

  PS.Storage = Storage;
})(window.PS);
