/* =====================================================================
   Platformer Studio — undo / redo
   Two kinds of entries:
   • strokes   — a list of changed cells on one layer (pencil, eraser,
                 rectangle, fill, paste, move). One entry per gesture.
   • snapshots — a before/after copy of part of the document, used for
                 objects, layers, resizing and tileset changes.
     scope 'objects' copies only objects (cheap);
     scope 'layers'  copies layer settings and order without tile data;
     scope 'all'     copies everything including tile data.
   Painted tile art adds its own entries through History.push.
   ===================================================================== */
(function (PS) {
  'use strict';

  const P = () => PS.state.project;
  const MAX_ART_BYTES = 300 * 1024 * 1024;
  const undoStack = [];
  const redoStack = [];
  let stroke = null;

  const cloneObjects = (list) => list.map((o) => ({ ...o, props: { ...o.props } }));
  const layerMeta = (l) => ({
    id: l.id, name: l.name, type: l.type, visible: l.visible, locked: l.locked, opacity: l.opacity, solid: l.solid, depth: l.depth,
    drift: l.drift, repeat: l.repeat, groupId: l.groupId, elev: l.elev, blocks: l.blocks,
    shadowOn: l.shadowOn, shadowColor: l.shadowColor, shadowOpacity: l.shadowOpacity, shadowX: l.shadowX, shadowY: l.shadowY, shadowBlur: l.shadowBlur, shadowReach: l.shadowReach,
  });
  const cloneGroups = (list) => list.map((g) => ({ ...g }));

  function snapshot(scope) {
    const p = P();
    const s = { scope, objects: cloneObjects(p.objects), character: p.character };
    if (scope === 'layers') { s.layers = p.layers.map(layerMeta); s.groups = cloneGroups(p.groups); }
    if (scope === 'all') {
      s.groups = cloneGroups(p.groups);
      s.width = p.width;
      s.height = p.height;
      s.layers = p.layers.map((l) => ({ ...layerMeta(l), data: l.data ? l.data.slice() : null }));
      s.tilesets = p.tilesets.slice();
      s.characters = p.characters.slice();
      s.customCollectibles = p.customCollectibles.slice();
    }
    return s;
  }

  function restore(s) {
    const p = P();
    p.objects = cloneObjects(s.objects);
    p.character = s.character;
    if (s.scope === 'layers') {
      const byId = new Map(p.layers.map((l) => [l.id, l]));
      p.layers = s.layers.filter((m) => byId.has(m.id)).map((m) => {
        const l = byId.get(m.id);
        Object.assign(l, m);
        return l;
      });
      p.groups = cloneGroups(s.groups);
    }
    if (s.scope === 'all') {
      p.groups = cloneGroups(s.groups);
      p.width = s.width;
      p.height = s.height;
      p.layers = s.layers.map((l) => ({ ...l, data: l.data ? l.data.slice() : null }));
      p.tilesets = s.tilesets.slice();
      p.characters = s.characters.slice();
      p.customCollectibles = s.customCollectibles.slice();
    }
  }

  function push(entry) {
    undoStack.push(entry);
    if (undoStack.length > PS.LIMITS.maxHistory) undoStack.shift();
    // Big sheets take a lot of memory, so very old paint steps are let go first.
    let bytes = undoStack.reduce((sum, e) => sum + (e.bytes || 0), 0);
    while (bytes > MAX_ART_BYTES && undoStack.length > 1) bytes -= undoStack.shift().bytes || 0;
    redoStack.length = 0;
    PS.bus.emit('history');
  }

  const History = {
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    peekUndo: () => undoStack[undoStack.length - 1],
    peekRedo: () => redoStack[redoStack.length - 1],

    clear() { undoStack.length = 0; redoStack.length = 0; stroke = null; PS.bus.emit('history'); },

    /** Record an action that was already done. entry: { label, scope, undo, redo } */
    push,

    /** Run `fn` as one undoable action. If fn returns false, nothing is recorded. */
    change(label, fn, scope = 'all') {
      const before = snapshot(scope);
      const result = fn();
      if (result === false) return false;
      const after = snapshot(scope);
      push({ label, scope, undo: () => restore(before), redo: () => restore(after) });
      PS.App.documentChanged(scope === 'objects' ? 'objects' : 'all');
      return true;
    },

    /** For multi-step gestures: take a snapshot now, commit it later. */
    capture(scope) { return snapshot(scope); },

    commit(label, before) {
      const after = snapshot(before.scope);
      push({ label, scope: before.scope, undo: () => restore(before), redo: () => restore(after) });
      PS.App.documentChanged(before.scope === 'objects' ? 'objects' : 'all');
    },

    /* ------------------------------ Strokes ------------------------------ */
    beginStroke(layer) {
      stroke = { layerId: layer.id, changes: new Map() };
    },

    get stroking() { return !!stroke; },

    /** Change a cell as part of the current stroke. */
    paint(layer, x, y, v) {
      if (!stroke || !PS.Project.inBounds(x, y)) return;
      const i = PS.Project.idx(x, y);
      const old = PS.Project.set(layer, x, y, v);
      const c = stroke.changes.get(i);
      if (c) c[1] = v; else stroke.changes.set(i, [old, v]);
    },

    endStroke(label) {
      const s = stroke;
      stroke = null;
      if (!s) return false;
      const idx = [], before = [], after = [];
      for (const [i, [b, a]] of s.changes) if (b !== a) { idx.push(i); before.push(b); after.push(a); }
      if (!idx.length) return false;
      const apply = (values) => {
        const layer = PS.Project.layer(s.layerId);
        if (!layer) return;
        for (let k = 0; k < idx.length; k++) PS.Project.setIdx(layer, idx[k], values[k]);
      };
      push({ label, scope: 'cells', undo: () => apply(before), redo: () => apply(after) });
      PS.App.documentChanged('tiles');
      return true;
    },

    /** Abort the current stroke and put every touched cell back. */
    cancelStroke() {
      const s = stroke;
      stroke = null;
      if (!s) return;
      const layer = PS.Project.layer(s.layerId);
      if (layer) for (const [i, [b]] of s.changes) PS.Project.setIdx(layer, i, b);
      PS.Renderer.request();
    },

    undo() {
      if (stroke) History.cancelStroke();
      const e = undoStack.pop();
      if (!e) return;
      e.undo();
      redoStack.push(e);
      PS.App.afterHistory(e, 'Undid');
    },

    redo() {
      const e = redoStack.pop();
      if (!e) return;
      e.redo();
      undoStack.push(e);
      PS.App.afterHistory(e, 'Redid');
    },
  };

  PS.History = History;
})(window.PS);
