/* =====================================================================
   Platformer Studio — drawing tools & object placement
   Receives grid-cell pointer events from the input manager (app.js) and
   turns them into document edits through PS.History.
   ===================================================================== */
(function (PS) {
  'use strict';

  const { rectFrom, clamp } = PS.util;
  const st = PS.state;
  const Proj = () => PS.Project;

  const DEFS = [
    { key: 'pencil', name: 'Pencil', icon: 'pencil', shortcut: 'P', tip: 'Pencil (P): click or drag to paint terrain. Right-click to erase.', hint: 'Drag to paint · right-click erases' },
    { key: 'eraser', name: 'Eraser', icon: 'eraser', shortcut: 'E', tip: 'Eraser (E): remove tiles. With the Objects layer selected it removes objects.', hint: 'Drag to erase' },
    { key: 'rect', name: 'Rectangle', icon: 'rect', shortcut: 'R', tip: 'Rectangle (R): drag to draw an outline of tiles.', hint: 'Drag to draw a rectangle outline' },
    { key: 'rectFill', name: 'Filled rectangle', icon: 'rectFill', shortcut: '⇧R', tip: 'Filled rectangle (Shift+R): drag to draw a solid block.', hint: 'Drag to draw a solid block' },
    { key: 'fill', name: 'Fill bucket', icon: 'fill', shortcut: 'G', tip: 'Fill bucket (G): fill a connected area. Stays inside the selection if you have one.', hint: 'Click to fill an area' },
    { key: 'eyedropper', name: 'Eyedropper', icon: 'eyedropper', shortcut: 'I', tip: 'Eyedropper (I): click a tile or object to pick it up.', hint: 'Click a tile or object to pick it' },
    { key: 'select', name: 'Select', icon: 'select', shortcut: 'V', tip: 'Select (V): drag to select tiles, drag inside the selection to move it. Click objects to edit or drag them.', hint: 'Drag to select · drag selection to move · Ctrl+C / Ctrl+V' },
    { key: 'move', name: 'Move', icon: 'move', shortcut: 'M', tip: 'Move selection (M): drag anywhere to move the selected tiles.', hint: 'Drag to move the selected tiles' },
  ];
  const TILE_TOOLS = new Set(['pencil', 'eraser', 'rect', 'rectFill', 'fill']);

  let lastWarn = 0;
  function warnOnce(msg, type = 'warn') {
    const now = performance.now();
    if (now - lastWarn < 1500) return;
    lastWarn = now;
    PS.UI.toast(msg, type);
  }

  function warnLocked(layer) {
    warnOnce(`“${layer.name}” is locked. Unlock it in the Layers panel to edit it.`);
  }

  /** The tile layer to draw on, switching away from the Objects layer if needed. */
  function ensureTileLayer() {
    let layer = Proj().activeTileLayer();
    if (layer) return layer;
    layer = Proj().defaultTileLayer();
    if (!layer) {
      warnOnce('There is no tile layer to draw on. Add one with the + button in the Layers panel.');
      return null;
    }
    st.activeLayerId = layer.id;
    PS.App.refreshLayers();
    PS.UI.toast(`Drawing on the “${layer.name}” layer`, 'info', { duration: 1800 });
    return layer;
  }

  function cellsInRect(r, filled, cb) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (!filled && x !== r.x && y !== r.y && x !== r.x + r.w - 1 && y !== r.y + r.h - 1) continue;
        if (Proj().inBounds(x, y)) cb(x, y);
      }
    }
  }

  function clampRect(r) {
    const p = st.project;
    const x0 = clamp(r.x, 0, p.width - 1), y0 = clamp(r.y, 0, p.height - 1);
    const x1 = clamp(r.x + r.w - 1, 0, p.width - 1), y1 = clamp(r.y + r.h - 1, 0, p.height - 1);
    if (r.x + r.w - 1 < 0 || r.y + r.h - 1 < 0 || r.x >= p.width || r.y >= p.height) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  const inside = (r, c) => r && c.x >= r.x && c.y >= r.y && c.x < r.x + r.w && c.y < r.y + r.h;

  function objectName(o) {
    if (o.kind === 'spawn') return 'player start';
    if (o.kind === 'goal') return 'goal';
    if (o.kind === 'enemy') return PS.Assets.enemy(o.type).name;
    return PS.Assets.collectible(o.type).name;
  }

  const Tools = {
    DEFS,
    TILE_TOOLS,
    hover: null,
    dragging: false,
    objectDrag: null,       // { id, x, y } while an object is being dragged
    selectionDraft: null,   // rectangle while dragging a new selection
    drag: null,

    def(key) { return DEFS.find((d) => d.key === key); },

    setTool(key) {
      if (Tools.drag) Tools.cancel();
      st.tool = key;
      if (key !== 'place') st.placeItem = null;
      PS.bus.emit('tool');
      PS.Renderer.request();
    },

    setPlaceItem(item) {
      if (Tools.drag) Tools.cancel();
      st.placeItem = item;
      st.tool = 'place';
      PS.bus.emit('tool');
      PS.Renderer.request();
    },

    hint() {
      if (st.tool === 'place' && st.placeItem) {
        const k = st.placeItem.kind;
        if (k === 'spawn') return 'Click to set where the player starts';
        if (k === 'goal') return 'Click to place the goal';
        return 'Click to place · click an existing one to edit · right-click removes';
      }
      const d = Tools.def(st.tool);
      return d ? d.hint : '';
    },

    selectObject(id) {
      st.selectedObjectId = id || 0;
      if (id) st.selection = null;
      PS.App.refreshProps();
      PS.Renderer.request();
    },

    deleteObject(id) {
      const o = Proj().object(id);
      if (!o) return;
      const objLayer = Proj().objectsLayer();
      if (objLayer && objLayer.locked) return warnLocked(objLayer);
      const name = objectName(o);
      PS.History.change(`Delete ${name}`, () => Proj().removeObject(id), 'objects');
      if (st.selectedObjectId === id) st.selectedObjectId = 0;
      PS.App.refreshProps();
    },

    /* ------------------------------ Pointer handling ------------------------------ */
    down(cell, e) {
      const tool = st.tool;
      const right = e.button === 2;
      Tools.hover = cell;
      const objLayer = Proj().objectsLayer();
      const objVisible = objLayer && objLayer.visible;

      // Objects: select, drag, delete
      if (tool === 'place' || tool === 'select') {
        const obj = objVisible ? Proj().objectAt(cell.x, cell.y) : null;
        if (obj) {
          if (tool === 'place' && right) return Tools.deleteObject(obj.id);
          Tools.selectObject(obj.id);
          if (objLayer.locked) return warnLocked(objLayer);
          Tools.drag = { type: 'object', obj, start: cell };
          Tools.objectDrag = { id: obj.id, x: obj.x, y: obj.y };
          Tools.dragging = true;
          return;
        }
        if (tool === 'place') {
          if (!right) Tools.placeObject(cell);
          return;
        }
      }

      if (tool === 'eyedropper') return Tools.pick(cell);

      if (tool === 'eraser' && Proj().activeLayer() && Proj().activeLayer().type === 'objects') {
        if (objLayer.locked) return warnLocked(objLayer);
        Tools.drag = { type: 'objErase', before: PS.History.capture('objects'), removed: 0 };
        Tools.dragging = true;
        Tools.eraseObjectAt(cell);
        return;
      }

      if (tool === 'select' || tool === 'move') {
        if (st.selectedObjectId) Tools.selectObject(0);
        if (st.selection && (tool === 'move' || inside(st.selection, cell))) return Tools.beginMoveSelection(cell);
        if (tool === 'move') return warnOnce('Select some tiles first with the Select tool (V), then drag them.', 'info');
        Tools.drag = { type: 'select', start: cell };
        Tools.selectionDraft = clampRect(rectFrom(cell, cell));
        st.selection = null;
        Tools.dragging = true;
        PS.App.refreshProps();
        return;
      }

      // Tile tools
      const layer = ensureTileLayer();
      if (!layer) return;
      if (layer.locked) return warnLocked(layer);
      const value = tool === 'eraser' || right ? 0 : st.activeTilesetId;
      if (value && !Proj().tileset(value)) {
        warnOnce('Pick a tileset in the Tilesets panel first. You can upload your own or use the starters.');
        PS.UI.flashSection('secTilesets');
        return;
      }
      if (!layer.visible) warnOnce(`The “${layer.name}” layer is hidden. Turn its eye on to see what you draw.`, 'info');

      if (tool === 'pencil' || tool === 'eraser') {
        PS.History.beginStroke(layer);
        Tools.drag = { type: 'stroke', layer, value, last: cell };
        Tools.dragging = true;
        if (Proj().inBounds(cell.x, cell.y)) PS.History.paint(layer, cell.x, cell.y, value);
      } else if (tool === 'rect' || tool === 'rectFill') {
        Tools.drag = { type: 'rect', layer, value, start: cell, end: cell, filled: tool === 'rectFill' };
        Tools.dragging = true;
      } else if (tool === 'fill') {
        Tools.floodFill(layer, cell, value);
      }
      PS.Renderer.request();
    },

    move(cell) {
      const changed = !Tools.hover || Tools.hover.x !== cell.x || Tools.hover.y !== cell.y;
      Tools.hover = cell;
      const d = Tools.drag;
      if (d && changed) {
        if (d.type === 'stroke') {
          PS.util.line(d.last.x, d.last.y, cell.x, cell.y, (x, y) => {
            if (Proj().inBounds(x, y)) PS.History.paint(d.layer, x, y, d.value);
          });
          d.last = cell;
        } else if (d.type === 'rect') {
          d.end = cell;
        } else if (d.type === 'select') {
          Tools.selectionDraft = clampRect(rectFrom(d.start, cell));
        } else if (d.type === 'moveSel') {
          d.dx = cell.x - d.start.x;
          d.dy = cell.y - d.start.y;
        } else if (d.type === 'object') {
          const free = !Proj().objectAt(cell.x, cell.y) || Proj().objectAt(cell.x, cell.y) === d.obj;
          if (Proj().inBounds(cell.x, cell.y) && free) Tools.objectDrag = { id: d.obj.id, x: cell.x, y: cell.y };
        } else if (d.type === 'objErase') {
          Tools.eraseObjectAt(cell);
        }
      }
      if (changed || d) PS.Renderer.request();
      return changed;
    },

    up() {
      const d = Tools.drag;
      Tools.drag = null;
      Tools.dragging = false;
      if (!d) return;
      if (d.type === 'stroke') {
        PS.History.endStroke(d.value ? 'Draw tiles' : 'Erase tiles');
      } else if (d.type === 'rect') {
        PS.History.beginStroke(d.layer);
        cellsInRect(rectFrom(d.start, d.end), d.filled, (x, y) => PS.History.paint(d.layer, x, y, d.value));
        PS.History.endStroke(d.value ? (d.filled ? 'Draw filled rectangle' : 'Draw rectangle') : 'Erase rectangle');
      } else if (d.type === 'select') {
        st.selection = Tools.selectionDraft;
        Tools.selectionDraft = null;
        PS.App.refreshProps();
      } else if (d.type === 'moveSel') {
        Tools.dropSelection(d);
      } else if (d.type === 'object') {
        const to = Tools.objectDrag;
        Tools.objectDrag = null;
        if (to && (to.x !== d.obj.x || to.y !== d.obj.y)) {
          PS.History.change(`Move ${objectName(d.obj)}`, () => { d.obj.x = to.x; d.obj.y = to.y; }, 'objects');
        }
        PS.App.refreshProps();
      } else if (d.type === 'objErase') {
        if (d.removed) PS.History.commit(`Erase ${PS.util.plural(d.removed, 'object')}`, d.before);
        PS.App.refreshProps();
      }
      PS.Renderer.request();
    },

    /** Escape or tool change in the middle of a drag: undo whatever it did. */
    cancel() {
      const d = Tools.drag;
      Tools.drag = null;
      Tools.dragging = false;
      Tools.objectDrag = null;
      Tools.selectionDraft = null;
      if (!d) return false;
      if (d.type === 'stroke' || d.type === 'moveSel') PS.History.cancelStroke();
      if (d.type === 'objErase' && d.removed) PS.History.commit(`Erase ${PS.util.plural(d.removed, 'object')}`, d.before);
      PS.Renderer.request();
      return true;
    },

    leave() {
      Tools.hover = null;
      PS.Renderer.request();
    },

    /* ------------------------------ Preview ------------------------------ */
    preview() {
      if (st.workspace === 'paint') return null;
      const d = Tools.drag;
      if (d && d.type === 'rect') {
        const cells = new Map();
        cellsInRect(rectFrom(d.start, d.end), d.filled, (x, y) => cells.set(Proj().idx(x, y), d.value));
        return { kind: 'cells', layer: d.layer, cells, alpha: 0.7 };
      }
      if (d && d.type === 'moveSel') {
        const cells = new Map();
        const { sel } = d;
        for (let y = 0; y < sel.h; y++) for (let x = 0; x < sel.w; x++) {
          const v = d.cells[y * sel.w + x];
          const tx = sel.x + x + d.dx, ty = sel.y + y + d.dy;
          if (v && Proj().inBounds(tx, ty)) cells.set(Proj().idx(tx, ty), v);
        }
        return { kind: 'cells', layer: d.layer, cells, alpha: 0.85, showErase: false };
      }
      if (d) return null;
      const h = Tools.hover;
      if (!h || !Proj().inBounds(h.x, h.y) || st.mode !== 'edit') return null;

      if (st.tool === 'place' && st.placeItem) {
        const it = st.placeItem;
        const existing = Proj().objectAt(h.x, h.y);
        if (existing) return null;
        let frame = null;
        if (it.kind === 'spawn') frame = PS.Assets.character(st.project.character).frames.idle[0];
        else if (it.kind === 'goal') frame = PS.Assets.goal(it.type).frames[0];
        else if (it.kind === 'enemy') frame = PS.Assets.enemy(it.type).frames[0];
        else frame = PS.Assets.collectible(it.type).frames[0];
        const objLayer = Proj().objectsLayer();
        return { kind: 'object', frame, x: h.x, y: h.y, valid: !(objLayer && objLayer.locked) };
      }
      const layer = Proj().activeTileLayer() || Proj().defaultTileLayer();
      if (!layer || layer.locked) return layer ? { kind: 'none', blocked: true } : null;
      const i = Proj().idx(h.x, h.y);
      if (st.tool === 'pencil' && Proj().tileset(st.activeTilesetId) && layer.data[i] !== st.activeTilesetId) {
        return { kind: 'cells', layer, cells: new Map([[i, st.activeTilesetId]]), alpha: 0.55 };
      }
      if (st.tool === 'eraser' && layer.type === 'tiles' && layer.data[i] && Proj().activeLayer() && Proj().activeLayer().type === 'tiles') {
        return { kind: 'cells', layer, cells: new Map([[i, 0]]) };
      }
      return null;
    },

    /* ------------------------------ Tile operations ------------------------------ */
    floodFill(layer, start, value) {
      if (!Proj().inBounds(start.x, start.y)) return;
      const p = st.project, w = p.width, h = p.height, data = layer.data;
      const target = data[start.y * w + start.x];
      if (target === value) return;
      const sel = inside(st.selection, start) ? st.selection : { x: 0, y: 0, w, h };
      const seen = new Uint8Array(w * h);
      const stack = [start.y * w + start.x];
      PS.History.beginStroke(layer);
      while (stack.length) {
        const i = stack.pop();
        if (seen[i]) continue;
        seen[i] = 1;
        if (data[i] !== target) continue;
        const x = i % w, y = (i - x) / w;
        PS.History.paint(layer, x, y, value);
        if (x > sel.x) stack.push(i - 1);
        if (x < sel.x + sel.w - 1) stack.push(i + 1);
        if (y > sel.y) stack.push(i - w);
        if (y < sel.y + sel.h - 1) stack.push(i + w);
      }
      PS.History.endStroke(value ? 'Fill area' : 'Erase area');
    },

    pick(cell) {
      if (!Proj().inBounds(cell.x, cell.y)) return;
      const objLayer = Proj().objectsLayer();
      const obj = objLayer && objLayer.visible ? Proj().objectAt(cell.x, cell.y) : null;
      if (obj) {
        if (obj.kind === 'spawn') Tools.setPlaceItem({ kind: 'spawn' });
        else Tools.setPlaceItem({ kind: obj.kind, type: obj.type });
        PS.UI.toast(`Picked ${objectName(obj)}`, 'info', { duration: 1500 });
        return;
      }
      const active = Proj().activeTileLayer();
      const order = [active, ...[...st.project.layers].reverse()].filter((l) => l && l.type === 'tiles' && l.visible);
      for (const layer of order) {
        const v = Proj().get(layer, cell.x, cell.y);
        if (!v) continue;
        st.activeTilesetId = v;
        st.activeLayerId = layer.id;
        Tools.setTool('pencil');
        PS.App.refreshAssets();
        PS.App.refreshLayers();
        PS.UI.toast(`Picked “${Proj().tileset(v).name}” on ${layer.name}`, 'info', { duration: 1500 });
        return;
      }
      PS.UI.toast('Nothing to pick here', 'info', { duration: 1200 });
    },

    eraseObjectAt(cell) {
      const o = Proj().objectAt(cell.x, cell.y);
      if (!o) return;
      Proj().removeObject(o.id);
      if (st.selectedObjectId === o.id) st.selectedObjectId = 0;
      Tools.drag.removed++;
      PS.Renderer.request();
    },

    placeObject(cell) {
      const it = st.placeItem;
      if (!it || !Proj().inBounds(cell.x, cell.y)) return;
      const objLayer = Proj().objectsLayer();
      if (!objLayer) return;
      if (objLayer.locked) return warnLocked(objLayer);
      if (!objLayer.visible) {
        objLayer.visible = true;
        PS.App.refreshLayers();
        PS.UI.toast('The Objects layer was hidden, so it has been turned back on.', 'info');
      }
      const p = st.project;
      if (p.objects.length >= PS.LIMITS.maxObjects) return warnOnce('This level has the maximum number of objects.');
      if (it.kind === 'spawn' || it.kind === 'goal') {
        const existing = it.kind === 'spawn' ? Proj().spawn() : Proj().goal();
        let placed = existing;
        PS.History.change(existing ? `Move ${it.kind === 'spawn' ? 'player start' : 'goal'}` : `Place ${it.kind === 'spawn' ? 'player start' : 'goal'}`, () => {
          if (existing) {
            existing.x = cell.x; existing.y = cell.y;
            if (it.kind === 'goal') existing.type = it.type;
          } else {
            placed = Proj().addObject(Proj().createObject(it.kind, it.type || null, cell.x, cell.y));
          }
        }, 'objects');
        Tools.selectObject(placed.id);
        return;
      }
      const o = Proj().createObject(it.kind, it.type, cell.x, cell.y);
      PS.History.change(`Place ${objectName(o)}`, () => { Proj().addObject(o); }, 'objects');
      Tools.selectObject(o.id);
    },

    /* ------------------------------ Selection ------------------------------ */
    beginMoveSelection(cell) {
      const layer = ensureTileLayer();
      if (!layer) return;
      if (layer.locked) return warnLocked(layer);
      const sel = st.selection;
      const cells = new Uint16Array(sel.w * sel.h);
      PS.History.beginStroke(layer);
      for (let y = 0; y < sel.h; y++) for (let x = 0; x < sel.w; x++) {
        cells[y * sel.w + x] = Proj().get(layer, sel.x + x, sel.y + y);
        PS.History.paint(layer, sel.x + x, sel.y + y, 0);
      }
      Tools.drag = { type: 'moveSel', layer, sel: { ...sel }, cells, start: cell, dx: 0, dy: 0 };
      Tools.dragging = true;
      PS.Renderer.request();
    },

    dropSelection(d) {
      const { sel } = d;
      for (let y = 0; y < sel.h; y++) for (let x = 0; x < sel.w; x++) {
        const v = d.cells[y * sel.w + x];
        if (v) PS.History.paint(d.layer, sel.x + x + d.dx, sel.y + y + d.dy, v);
      }
      PS.History.endStroke('Move tiles');
      st.selection = clampRect({ x: sel.x + d.dx, y: sel.y + d.dy, w: sel.w, h: sel.h });
      PS.App.refreshProps();
    },

    selectAll() {
      const p = st.project;
      st.selection = { x: 0, y: 0, w: p.width, h: p.height };
      st.selectedObjectId = 0;
      if (st.tool !== 'select' && st.tool !== 'move') Tools.setTool('select');
      PS.App.refreshProps();
      PS.Renderer.request();
    },

    deselect() {
      if (!st.selection && !st.selectedObjectId) return false;
      st.selection = null;
      st.selectedObjectId = 0;
      PS.App.refreshProps();
      PS.Renderer.request();
      return true;
    },

    copy(silent) {
      const sel = st.selection;
      const layer = Proj().activeTileLayer();
      if (!sel || !layer) { if (!silent) warnOnce('Select some tiles on a tile layer first (V).', 'info'); return false; }
      const cells = new Uint16Array(sel.w * sel.h);
      let n = 0;
      for (let y = 0; y < sel.h; y++) for (let x = 0; x < sel.w; x++) {
        const v = Proj().get(layer, sel.x + x, sel.y + y);
        cells[y * sel.w + x] = v;
        if (v) n++;
      }
      st.clipboard = { w: sel.w, h: sel.h, cells };
      if (!silent) PS.UI.toast(`Copied ${PS.util.plural(n, 'tile')}`, 'success', { duration: 1400 });
      return true;
    },

    clearSelection(label = 'Delete tiles') {
      const sel = st.selection;
      const layer = ensureTileLayer();
      if (!sel || !layer) return;
      if (layer.locked) return warnLocked(layer);
      PS.History.beginStroke(layer);
      cellsInRect(sel, true, (x, y) => PS.History.paint(layer, x, y, 0));
      PS.History.endStroke(label);
      PS.Renderer.request();
    },

    cut() {
      if (!Tools.copy(true)) return warnOnce('Select some tiles on a tile layer first (V).', 'info');
      Tools.clearSelection('Cut tiles');
    },

    paste() {
      const clip = st.clipboard;
      if (!clip) return warnOnce('Nothing to paste yet. Select tiles and press Ctrl+C first.', 'info');
      const layer = ensureTileLayer();
      if (!layer) return;
      if (layer.locked) return warnLocked(layer);
      const h = Tools.hover;
      const at = h && Proj().inBounds(h.x, h.y) ? h : st.selection ? { x: st.selection.x, y: st.selection.y } : { x: 0, y: 0 };
      PS.History.beginStroke(layer);
      for (let y = 0; y < clip.h; y++) for (let x = 0; x < clip.w; x++) {
        const v = clip.cells[y * clip.w + x];
        if (v && Proj().tileset(v)) PS.History.paint(layer, at.x + x, at.y + y, v);
      }
      PS.History.endStroke('Paste tiles');
      st.selection = clampRect({ x: at.x, y: at.y, w: clip.w, h: clip.h });
      st.selectedObjectId = 0;
      if (st.tool !== 'select' && st.tool !== 'move') Tools.setTool('select');
      PS.App.refreshProps();
      PS.Renderer.request();
    },
  };

  PS.Tools = Tools;
})(window.PS);
