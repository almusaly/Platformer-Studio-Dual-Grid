/* =====================================================================
   Platformer Studio — level data model
   Map manager, layer manager and object manager. Pure data: rendering
   caches are notified through PS.Renderer.invalidate* calls only.

   Cells store a tileset id (0 = empty). The displayed tile variant is
   never stored; the autotile engine derives it from the neighbours.
   ===================================================================== */
(function (PS) {
  'use strict';

  const { clamp } = PS.util;

  const DEFAULT_PHYSICS = { walkSpeed: 150, runSpeed: 250, jumpStrength: 480, gravity: 1400, doubleJump: true };
  const DEFAULT_GAME = { lives: 3, stomp: true, winCondition: 'goal', requiredScore: 100, cameraSmoothing: true };
  const DEFAULT_LEVEL = { sky: '#9fd8f5', transparentSky: false, connectAcross: false, edgeConnect: true, parallax: true };
  const DEFAULT_ISO = { ground: '#5a6988', pits: false, shadowPlayer: true, shadowNpc: true, shadowObjects: true, blockShadows: true, sunAngle: 285, sunHeight: 45, shadowDarkness: 0.4 };

  const ENEMY_BEHAVIORS = [
    { key: 'stationary', name: 'Stay still', desc: 'Stays in one place.' },
    { key: 'patrol', name: 'Patrol', desc: 'Walks left and right within the patrol distance.' },
    { key: 'edge', name: 'Platform patrol', desc: 'Walks along its platform and turns around at edges and walls.' },
    { key: 'fly', name: 'Flying patrol', desc: 'Flies left and right without falling.' },
    { key: 'chase', name: 'Chase', desc: 'Moves toward the player when they come close.' },
  ];

  const ENEMY_DEFAULTS = {
    slime: { behavior: 'patrol', speed: 2, distance: 3, dir: 1, range: 6 },
    robot: { behavior: 'edge', speed: 3, distance: 3, dir: 1, range: 6 },
    spiky: { behavior: 'stationary', speed: 2, distance: 2, dir: 1, range: 5 },
    flyer: { behavior: 'fly', speed: 3, distance: 3, dir: 1, range: 6 },
  };

  const DEFAULT_LAYERS = [
    { name: 'Background', type: 'tiles', solid: false, depth: 0.5 },
    { name: 'Decoration', type: 'tiles', solid: false, depth: 0.8 },
    { name: 'Terrain', type: 'tiles', solid: true, depth: 1 },
    { name: 'Objects', type: 'objects', solid: false, depth: 1 },
    { name: 'Foreground', type: 'tiles', solid: false, depth: 1.25 },
  ];

  const P = () => PS.state.project;
  const invalidateCell = (layer, x, y) => PS.Renderer && PS.Renderer.invalidateCell(layer, x, y);
  const invalidateAll = () => PS.Renderer && PS.Renderer.invalidateAll();

  function makeLayer(p, def) {
    return {
      id: p.nextId++,
      name: def.name,
      type: def.type,
      visible: def.visible !== false,
      locked: !!def.locked,
      opacity: def.opacity == null ? 1 : def.opacity,
      solid: !!def.solid,
      depth: def.depth == null ? 1 : def.depth,
      drift: def.drift || 0,
      repeat: !!def.repeat,
      groupId: def.groupId || 0,
      elev: def.elev || 0,
      blocks: def.blocks || 1,
      shadowOn: !!def.shadowOn,
      shadowColor: def.shadowColor || '#000000',
      shadowOpacity: def.shadowOpacity == null ? 0.5 : def.shadowOpacity,
      shadowX: def.shadowX == null ? 4 : def.shadowX,
      shadowY: def.shadowY == null ? 4 : def.shadowY,
      shadowBlur: def.shadowBlur || 0,
      shadowReach: def.shadowReach || 1,
      data: def.type === 'tiles' ? (def.data || new Uint16Array(p.width * p.height)) : null,
    };
  }

  const Project = {
    DEFAULT_PHYSICS, DEFAULT_GAME, DEFAULT_LEVEL, DEFAULT_ISO, ENEMY_BEHAVIORS, ENEMY_DEFAULTS,

    create({ name = 'My Platformer', width = 20, height = 12, starters = true } = {}) {
      const p = {
        name, width, height, tileSize: PS.TILE, nextId: 1,
        tilesets: [], characters: [], customCollectibles: [],
        layers: [], objects: [], groups: [],
        palettes: [], paletteKey: PS.Palettes.DEFAULT_KEY,
        view: 'side',
        iso: { ...DEFAULT_ISO },
        character: 'ninja',
        physics: { ...DEFAULT_PHYSICS },
        game: { ...DEFAULT_GAME },
        level: { ...DEFAULT_LEVEL },
      };
      for (const def of DEFAULT_LAYERS) p.layers.push(makeLayer(p, def));
      if (starters) {
        for (const t of PS.Tilegen.starters()) p.tilesets.push({ id: p.nextId++, name: t.name, src: t.src });
      }
      return p;
    },

    newId() { return P().nextId++; },

    /* ------------------------------ Grid ------------------------------ */
    inBounds(x, y) { const p = P(); return x >= 0 && y >= 0 && x < p.width && y < p.height; },
    idx(x, y) { return y * P().width + x; },

    get(layer, x, y) {
      if (!layer || !layer.data || !Project.inBounds(x, y)) return 0;
      return layer.data[y * P().width + x];
    },

    /** Set one cell; returns the previous value. Caller records history. */
    set(layer, x, y, v) {
      if (!layer || !layer.data || !Project.inBounds(x, y)) return 0;
      const i = y * P().width + x;
      const old = layer.data[i];
      if (old !== v) {
        layer.data[i] = v;
        invalidateCell(layer, x, y);
      }
      return old;
    },

    setIdx(layer, i, v) {
      const w = P().width;
      Project.set(layer, i % w, Math.floor(i / w), v);
    },

    /* ------------------------------ Layers ------------------------------ */
    layer(id) { return P().layers.find((l) => l.id === id) || null; },
    objectsLayer() { return P().layers.find((l) => l.type === 'objects') || null; },
    tileLayers() { return P().layers.filter((l) => l.type === 'tiles'); },
    activeLayer() { return Project.layer(PS.state.activeLayerId); },

    /** The layer that tile tools draw on: the active layer if it holds tiles. */
    activeTileLayer() {
      const l = Project.activeLayer();
      return l && l.type === 'tiles' ? l : null;
    },

    /** Preferred tile layer when the user starts drawing on the objects layer. */
    defaultTileLayer() {
      const tiles = Project.tileLayers();
      return tiles.find((l) => l.solid && l.visible && !l.locked) || tiles.find((l) => !l.locked) || tiles[0] || null;
    },

    addLayer(name, index) {
      const p = P();
      const at = index == null ? p.layers.length : clamp(index, 0, p.layers.length);
      // New layers join the parallax: slower behind the solid terrain, faster in front of it.
      const terrain = p.layers.findIndex((l) => l.solid);
      const layer = makeLayer(p, { name, type: 'tiles', solid: false, depth: terrain < 0 ? 1 : at <= terrain ? 0.75 : 1.25 });
      p.layers.splice(at, 0, layer);
      return layer;
    },

    duplicateLayer(id) {
      const p = P();
      const src = Project.layer(id);
      if (!src || src.type !== 'tiles') return null;
      const copy = makeLayer(p, { ...src, name: PS.util.cleanName(src.name + ' copy', 'Layer copy', 30), data: src.data.slice() });
      p.layers.splice(p.layers.indexOf(src) + 1, 0, copy);
      return copy;
    },

    removeLayer(id) {
      const p = P();
      const i = p.layers.findIndex((l) => l.id === id);
      if (i < 0 || p.layers[i].type === 'objects') return false;
      p.layers.splice(i, 1);
      Project.tidyGroups();
      invalidateAll();
      return true;
    },

    moveLayer(id, toIndex) {
      const p = P();
      const i = p.layers.findIndex((l) => l.id === id);
      if (i < 0) return false;
      const to = clamp(toIndex, 0, p.layers.length - 1);
      if (to === i) return false;
      const [l] = p.layers.splice(i, 1);
      p.layers.splice(to, 0, l);
      return true;
    },

    /* ------------------------------ Groups & parallax ------------------------------ */
    group(id) { return P().groups.find((g) => g.id === id) || null; },
    groupLayers(id) { return P().layers.filter((l) => l.groupId === id); },

    /** A group or a layer holding a solid layer or the objects must follow the camera exactly. */
    speedLocked(layer) {
      if (layer.type === 'objects' || layer.solid) return true;
      return !!layer.groupId && Project.groupLayers(layer.groupId).some((l) => l.solid || l.type === 'objects');
    },

    /** How fast a layer scrolls compared with the camera. Grouped layers share one speed. */
    layerSpeed(layer) {
      if (!P().level.parallax || Project.speedLocked(layer)) return 1;
      const g = layer.groupId ? Project.group(layer.groupId) : null;
      return g ? g.depth : layer.depth;
    },

    /** Sideways movement in pixels per second, even when the camera is still. */
    layerDrift(layer) {
      if (!P().level.parallax || Project.speedLocked(layer)) return 0;
      const g = layer.groupId ? Project.group(layer.groupId) : null;
      return g ? g.drift : layer.drift;
    },

    layerRepeat(layer) {
      const g = layer.groupId ? Project.group(layer.groupId) : null;
      return g ? g.repeat : layer.repeat;
    },

    /** Put two layers in a group. They end up next to each other in the layer list. */
    groupWith(layer, other) {
      const p = P();
      let g = other.groupId ? Project.group(other.groupId) : null;
      if (!g) {
        let n = p.groups.length + 1;
        while (p.groups.some((x) => x.name === `Group ${n}`)) n++;
        g = { id: Project.newId(), name: `Group ${n}`, depth: other.depth, drift: other.drift, repeat: other.repeat, collapsed: false };
        p.groups.push(g);
        other.groupId = g.id;
      }
      layer.groupId = g.id;
      Project.tidyGroups();
      return g;
    },

    /** Move a whole group past its neighbour: one layer, or all of the next group. */
    moveGroup(id, delta) {
      const p = P();
      const members = Project.groupLayers(id);
      if (!members.length) return false;
      const rest = p.layers.filter((l) => l.groupId !== id);
      let at = p.layers.slice(0, p.layers.indexOf(members[0])).filter((l) => l.groupId !== id).length;
      const next = rest[delta > 0 ? at : at - 1];
      if (!next) return false;
      const size = next.groupId ? Project.groupLayers(next.groupId).length : 1;
      at += delta > 0 ? size : -size;
      rest.splice(at, 0, ...members);
      p.layers = rest;
      return true;
    },

    /** Move a whole group above or below a layer, or above or below that layer's group. */
    placeGroup(id, targetId, above) {
      const p = P();
      const members = Project.groupLayers(id);
      const target = Project.layer(targetId);
      if (!members.length || !target || target.groupId === id) return false;
      const rest = p.layers.filter((l) => l.groupId !== id);
      const side = target.groupId ? Project.groupLayers(target.groupId) : [target];
      const at = rest.indexOf(above ? side[side.length - 1] : side[0]);
      rest.splice(above ? at + 1 : at, 0, ...members);
      if (rest.every((l, i) => l === p.layers[i])) return false;
      p.layers = rest;
      return true;
    },

    /** Keep each group's layers next to each other, and drop groups with fewer than two layers. */
    tidyGroups() {
      const p = P();
      for (const g of p.groups) {
        const members = Project.groupLayers(g.id);
        if (members.length < 2) {
          for (const l of members) { l.groupId = 0; l.depth = g.depth; l.drift = g.drift; l.repeat = g.repeat; }
          continue;
        }
        const first = p.layers.indexOf(members[0]);
        const others = p.layers.filter((l) => l.groupId !== g.id);
        const before = p.layers.slice(0, first).filter((l) => l.groupId !== g.id).length;
        others.splice(before, 0, ...members);
        p.layers = others;
      }
      p.groups = p.groups.filter((g) => Project.groupLayers(g.id).length >= 2);
    },

    layerTileCount(layer) {
      if (!layer || !layer.data) return 0;
      let n = 0;
      for (let i = 0; i < layer.data.length; i++) if (layer.data[i]) n++;
      return n;
    },

    totalTiles() {
      let n = 0;
      for (const l of Project.tileLayers()) n += Project.layerTileCount(l);
      return n;
    },

    /* ------------------------------ Resizing ------------------------------ */
    resizeOffset(w, h, anchor) {
      const p = P();
      return { dx: Math.round((w - p.width) * anchor.ax), dy: Math.round((h - p.height) * anchor.ay) };
    },

    /** How many tiles/objects would fall outside the map after a resize. */
    resizeLoss(w, h, anchor) {
      const p = P();
      const { dx, dy } = Project.resizeOffset(w, h, anchor);
      let tiles = 0, objects = 0;
      for (const l of Project.tileLayers()) {
        for (let y = 0; y < p.height; y++) {
          for (let x = 0; x < p.width; x++) {
            if (!l.data[y * p.width + x]) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) tiles++;
          }
        }
      }
      for (const o of p.objects) {
        const nx = o.x + dx, ny = o.y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) objects++;
      }
      return { tiles, objects };
    },

    resize(w, h, anchor) {
      const p = P();
      const { dx, dy } = Project.resizeOffset(w, h, anchor);
      for (const l of Project.tileLayers()) {
        const next = new Uint16Array(w * h);
        for (let y = 0; y < p.height; y++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let x = 0; x < p.width; x++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            next[ny * w + nx] = l.data[y * p.width + x];
          }
        }
        l.data = next;
      }
      p.objects = p.objects.filter((o) => {
        o.x += dx; o.y += dy;
        return o.x >= 0 && o.y >= 0 && o.x < w && o.y < h;
      });
      p.width = w;
      p.height = h;
      const sel = PS.state.selection;
      if (sel) PS.state.selection = null;
      invalidateAll();
    },

    /* ------------------------------ Objects ------------------------------ */
    objectAt(x, y) {
      const list = P().objects;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].x === x && list[i].y === y) return list[i];
      return null;
    },
    object(id) { return P().objects.find((o) => o.id === id) || null; },
    spawn() { return P().objects.find((o) => o.kind === 'spawn') || null; },
    goal() { return P().objects.find((o) => o.kind === 'goal') || null; },

    createObject(kind, type, x, y) {
      const o = { id: Project.newId(), kind, type: type || null, x, y, props: {} };
      if (kind === 'enemy') o.props = { ...(ENEMY_DEFAULTS[type] || ENEMY_DEFAULTS.slime) };
      if (kind === 'collectible') {
        const def = PS.Assets.collectible(type);
        o.props = { points: def.points, anim: def.anim, sound: def.sound };
      }
      return o;
    },

    addObject(o) { P().objects.push(o); return o; },

    removeObject(id) {
      const p = P();
      const i = p.objects.findIndex((o) => o.id === id);
      if (i < 0) return false;
      p.objects.splice(i, 1);
      return true;
    },

    /* ------------------------------ Tilesets ------------------------------ */
    tileset(id) { return P().tilesets.find((t) => t.id === id) || null; },

    tilesetUsage(id) {
      let n = 0;
      for (const l of Project.tileLayers()) for (let i = 0; i < l.data.length; i++) if (l.data[i] === id) n++;
      return n;
    },

    removeTileset(id) {
      const p = P();
      for (const l of Project.tileLayers()) for (let i = 0; i < l.data.length; i++) if (l.data[i] === id) l.data[i] = 0;
      p.tilesets = p.tilesets.filter((t) => t.id !== id);
      invalidateAll();
    },
  };

  PS.Project = Project;
})(window.PS);
