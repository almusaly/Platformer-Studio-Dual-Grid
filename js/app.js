/* =====================================================================
   Platformer Studio — application bootstrap, input manager and toolbar
   ===================================================================== */
(function (PS) {
  'use strict';

  const { $, el } = PS.util;
  const st = PS.state;
  const T = PS.TILE;

  let spaceHeld = false;
  let pan = null;
  let pointerId = null;
  let wheelAcc = 0;
  let statusTimer = 0;
  let mapAnchor = { ax: 0, ay: 1 };

  /* ============================== App API (used by other modules) ============================== */
  const refreshPanelsSoon = PS.util.debounce(() => {
    PS.PropsPanel.render();
    PS.AssetsPanel.renderTilesets();
    PS.AssetsPanel.updateActive();
  }, 200);

  const App = {
    documentChanged(scope) {
      st.dirty = true;
      PS.Storage.scheduleAutosave();
      PS.Renderer.request();
      if (scope === 'all') { PS.LayersPanel.render(); PS.PropsPanel.render(); PS.AssetsPanel.render(); App.refreshToolbar(); }
      else if (scope === 'objects') PS.PropsPanel.render();
      else if (scope === 'tiles') refreshPanelsSoon();
      else if (scope === 'meta') App.refreshToolbar();
      App.updateEmpty();
    },

    afterHistory(entry, verb) {
      const p = st.project;
      if (entry.scope !== 'cells') PS.Renderer.invalidateAll();
      if (entry.scope === 'pixels') PS.bus.emit('art');
      if (!PS.Project.layer(st.activeLayerId)) {
        const l = PS.Project.defaultTileLayer() || p.layers[0];
        st.activeLayerId = l ? l.id : 0;
      }
      if (!PS.Project.tileset(st.activeTilesetId)) st.activeTilesetId = p.tilesets.length ? p.tilesets[0].id : 0;
      if (st.selectedObjectId && !PS.Project.object(st.selectedObjectId)) st.selectedObjectId = 0;
      const s = st.selection;
      if (s && (s.x + s.w > p.width || s.y + s.h > p.height)) st.selection = null;
      st.dirty = true;
      PS.Storage.scheduleAutosave();
      App.refreshAll();
      App.flashStatus(`${verb}: ${entry.label}`);
    },

    refreshAll() {
      PS.AssetsPanel.render();
      PS.LayersPanel.render();
      PS.PropsPanel.render();
      PS.PaintPanel.render();
      App.refreshToolbar();
      App.updateStatus();
      App.updateEmpty();
      PS.Renderer.request();
    },

    refreshLayers() { PS.LayersPanel.render(); App.updateStatus(); },
    refreshProps() { PS.PropsPanel.render(); },
    refreshAssets() { PS.AssetsPanel.render(); },

    refreshToolbar() {
      const p = st.project;
      const name = $('#projectName');
      if (document.activeElement !== name) name.value = p.name;
      $('#mapSizeLabel').textContent = `${p.width} × ${p.height}`;
      App.updateUndo();
      App.updateZoom();
      $('#btnGrid').classList.toggle('on', st.prefs.showGrid);
      $('#wsBuild').classList.toggle('on', st.workspace === 'build');
      $('#wsPaint').classList.toggle('on', st.workspace === 'paint');
      $('#viewSide').classList.toggle('on', p.view !== 'iso');
      $('#viewIso').classList.toggle('on', p.view === 'iso');
    },

    /** Switch between building the level and painting its tiles. */
    setWorkspace(ws) {
      if (st.workspace === ws) { if (ws === 'paint') PS.PaintPanel.render(); return; }
      PS.Tools.cancel();
      PS.Paint.cancel();
      PS.Tools.hover = null;
      st.workspace = ws;
      document.body.classList.toggle('paint', ws === 'paint');
      document.body.classList.toggle('paint-right', ws === 'paint' && !!st.prefs.paintRightOpen);
      document.body.classList.toggle('paint-full', ws === 'paint' && !!st.prefs.paintFull);
      if (ws === 'paint') {
        if (!st.project.tilesets.length) {
          st.workspace = 'build';
          document.body.classList.remove('paint', 'paint-right', 'paint-full');
          App.refreshToolbar();
          return PS.PaintPanel.openNewTileset();
        }
        PS.PaintPanel.render();
        App.flashStatus('Paint on the sheet, or right on a platform. Tiles update everywhere.');
      } else {
        PS.AssetsPanel.render();
      }
      App.refreshToolbar();
      App.updateStatus();
      App.updateEmpty();
      PS.Renderer.request();
    },

    /** Switch the level between the normal 2D view and iso. */
    setView(view) {
      const p = st.project;
      if (p.view === view) return;
      PS.Tools.cancel();
      PS.Tools.hover = null;
      p.view = view;
      PS.Renderer.invalidateAll();
      PS.Renderer.fit();
      App.documentChanged('meta');
      PS.LayersPanel.render();
      if (PS.Settings.isOpen) PS.Settings.render();
      if (view === 'iso') {
        PS.UI.toast('Iso view: your map is now a floor plan. Solid layers become blocks you can jump onto.', 'info', {
          duration: 6000,
          action: { label: 'Shadows & options', fn: () => PS.Settings.open('iso view') },
        });
      } else {
        PS.UI.toast('Back to the 2D view.', 'info', { duration: 1800 });
      }
    },

    updateUndo() {
      const u = $('#btnUndo'), r = $('#btnRedo');
      const H = PS.History;
      u.disabled = !H.canUndo();
      r.disabled = !H.canRedo();
      const mod = PS.util.isMac ? '⌘' : 'Ctrl+';
      u.dataset.tip = H.canUndo() ? `Undo “${H.peekUndo().label}” (${mod}Z)` : 'Nothing to undo';
      r.dataset.tip = H.canRedo() ? `Redo “${H.peekRedo().label}” (${mod}Shift+Z)` : 'Nothing to redo';
    },

    updateZoom() {
      $('#zoomLabel').textContent = Math.round(PS.Renderer.view.zoom * 100) + '%';
    },

    updateStatus(cell) {
      const layer = PS.Project.activeLayer();
      if (cell !== undefined) {
        $('#statusCell').textContent = cell && PS.Project.inBounds(cell.x, cell.y) ? `${cell.x + 1}, ${cell.y + 1}` : '–';
      }
      $('#statusLayer').textContent = layer ? `${layer.name}${layer.locked ? ' (locked)' : ''}` : '';
      if (!statusTimer) $('#statusHint').textContent = st.workspace === 'paint' ? 'Drag to paint · right-click erases · Alt-click picks a colour' : PS.Tools.hint();
    },

    flashStatus(text) {
      clearTimeout(statusTimer);
      $('#statusHint').textContent = text;
      statusTimer = setTimeout(() => { statusTimer = 0; App.updateStatus(); }, 1800);
    },

    updateEmpty() {
      const p = st.project;
      const empty = st.mode === 'edit' && st.workspace === 'build' && $('#welcome').hidden && !p.objects.length && PS.Project.totalTiles() === 0;
      $('#emptyHint').hidden = !empty;
    },

    async setProject(p) {
      if (PS.Game.running) PS.Game.stop();
      PS.Tools.cancel();
      st.project = p;
      st.selection = null;
      st.selectedObjectId = 0;
      st.clipboard = null;
      st.placeItem = null;
      st.tool = 'pencil';
      PS.Paint.cancel();
      st.paintColor = PS.Palettes.nearest(PS.Palettes.toRgb(st.paintColor), PS.Palettes.active().colors);
      const layer = p.layers.find((l) => l.type === 'tiles' && l.solid) || PS.Project.defaultTileLayer() || p.layers[0];
      st.activeLayerId = layer ? layer.id : 0;
      st.activeTilesetId = p.tilesets.length ? p.tilesets[0].id : 0;
      PS.History.clear();
      PS.Renderer.invalidateAll();
      PS.Assets.prune();
      App.refreshAll();
      PS.Renderer.fit();
      const failed = await PS.Assets.preload(p);
      if (failed) PS.UI.toast(`${PS.util.plural(failed, 'image')} in this project could not be loaded and will look blank.`, 'warn', { duration: 6000 });
      App.refreshAll();
      st.dirty = false;
      PS.Storage.autosave();
    },

    async openProjectFile(file) {
      if (st.dirty && PS.History.canUndo()) {
        const ok = await PS.UI.confirm({ title: 'Open another project?', text: 'Your current level will be replaced. Save it first if you want to keep it.', ok: 'Open project' });
        if (!ok) return;
      }
      PS.Storage.openFile(file);
    },

    setTheme(theme) {
      st.prefs.theme = theme;
      document.documentElement.dataset.theme = theme;
      PS.savePrefs();
      PS.Renderer.readTheme();
    },

    showWelcome(force) {
      if (!force && st.prefs.welcomeDismissed) return;
      $('#welcome').hidden = false;
      App.updateEmpty();
    },

    hideWelcome() {
      $('#welcome').hidden = true;
      st.prefs.welcomeDismissed = true;
      PS.savePrefs();
      App.updateEmpty();
    },
  };
  PS.App = App;

  /* ============================== Example level ============================== */
  function buildExample() {
    const p = PS.Project.create({ name: 'Example Level', width: 40, height: 14 });
    const [grass, stone, ice] = p.tilesets;
    const layer = (name) => p.layers.find((l) => l.name === name);
    const terrain = layer('Terrain'), bg = layer('Background');
    const fill = (l, ts, x0, y0, x1, y1) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) l.data[y * p.width + x] = ts.id;
    };
    fill(terrain, grass, 0, 12, 13, 13);
    fill(terrain, grass, 17, 12, 26, 13);
    fill(terrain, grass, 29, 12, 39, 13);
    fill(terrain, grass, 5, 10, 8, 11);
    fill(terrain, stone, 12, 9, 16, 9);
    fill(terrain, stone, 20, 9, 21, 11);
    fill(terrain, ice, 23, 8, 27, 8);
    fill(terrain, stone, 32, 10, 33, 11);
    fill(terrain, stone, 34, 9, 35, 11);
    fill(bg, ice, 1, 7, 9, 11);
    fill(bg, ice, 4, 5, 7, 6);
    fill(bg, ice, 18, 6, 30, 11);
    fill(bg, ice, 22, 3, 26, 5);
    bg.opacity = 0.4;

    let id = p.nextId;
    const add = (kind, type, x, y, props) => {
      const o = { id: id++, kind, type, x, y, props: props || {} };
      if (kind === 'enemy') o.props = { ...PS.Project.ENEMY_DEFAULTS[type], ...props };
      if (kind === 'collectible') {
        const d = PS.Sprites.collectibles[type];
        o.props = { points: d.points, anim: d.anim, sound: d.sound };
      }
      p.objects.push(o);
    };
    add('spawn', null, 2, 11);
    add('goal', 'flag', 38, 11);
    for (const [x, y] of [[6, 9], [7, 9], [13, 8], [14, 8], [15, 8], [24, 7], [25, 7], [26, 7]]) add('collectible', 'coin', x, y);
    add('collectible', 'gem', 20, 8);
    add('collectible', 'gem', 35, 8);
    add('collectible', 'star', 28, 5);
    add('collectible', 'heart', 18, 11);
    add('enemy', 'slime', 10, 11, { behavior: 'patrol', distance: 2 });
    add('enemy', 'slime', 30, 11, { behavior: 'patrol', distance: 2 });
    add('enemy', 'robot', 27, 7, { behavior: 'edge', dir: -1 });
    add('enemy', 'flyer', 17, 6, { behavior: 'fly', distance: 2 });
    p.nextId = id;
    return p;
  }

  /** A small iso level: a meadow with stepped hills and a goal on top. */
  function buildIsoExample() {
    const p = PS.Project.create({ name: 'Iso Example', width: 16, height: 16 });
    p.view = 'iso';
    const [, stone, ice] = p.tilesets;
    const colors = PS.Palettes.BUILTIN[0].colors;
    const green = PS.Tilegen.suggest('meadow', colors);
    const meadow = { id: p.nextId++, name: 'Meadow', src: PS.Tilegen.generate('meadow', green.top, green.body, colors).toDataURL('image/png') };
    p.tilesets.push(meadow);
    const layer = (name) => p.layers.find((l) => l.name === name);
    const ground = layer('Background'), terrain = layer('Terrain'), hills = layer('Foreground');
    ground.depth = 1;
    hills.name = 'Hills';
    hills.solid = true;
    hills.elev = 1;
    const fill = (l, ts, x0, y0, x1, y1) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) l.data[y * p.width + x] = ts.id;
    };
    fill(ground, meadow, 0, 0, 15, 15);
    fill(layer('Decoration'), ice, 11, 1, 14, 4);
    fill(terrain, stone, 3, 3, 6, 6);
    fill(terrain, meadow, 8, 7, 13, 12);
    fill(terrain, stone, 1, 10, 3, 13);
    fill(hills, meadow, 10, 9, 13, 12);

    let id = p.nextId;
    const add = (kind, type, x, y, props) => {
      const o = { id: id++, kind, type, x, y, props: props || {} };
      if (kind === 'enemy') o.props = { ...PS.Project.ENEMY_DEFAULTS[type], ...props };
      if (kind === 'collectible') {
        const d = PS.Sprites.collectibles[type];
        o.props = { points: d.points, anim: d.anim, sound: d.sound };
      }
      p.objects.push(o);
    };
    add('spawn', null, 1, 1);
    add('goal', 'flag', 12, 11);
    for (const [x, y] of [[4, 4], [5, 5], [9, 8], [11, 10], [2, 11], [12, 2], [7, 2], [7, 13]]) add('collectible', 'coin', x, y);
    add('collectible', 'gem', 13, 3);
    add('enemy', 'slime', 7, 5, { behavior: 'patrol', distance: 3 });
    add('enemy', 'robot', 9, 11, { behavior: 'edge', dir: 1 });
    add('enemy', 'flyer', 6, 9, { behavior: 'fly', distance: 2 });
    p.nextId = id;
    return p;
  }

  /* ============================== Map size popover ============================== */
  function openMapSize() {
    const pop = $('#mapSizePop');
    if (PS.UI.isPopoverOpen(pop)) return PS.UI.closePopovers();
    const p = st.project;
    $('#mapW').value = p.width;
    $('#mapH').value = p.height;
    renderAnchor();
    updateMapInfo();
    PS.UI.openPopover(pop, $('#btnMapSize'));
    $('#mapW').focus();
    $('#mapW').select();
  }

  function renderAnchor() {
    const grid = $('#anchorGrid');
    const names = [['top left', 'top', 'top right'], ['left', 'centre', 'right'], ['bottom left', 'bottom', 'bottom right']];
    grid.replaceChildren();
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      grid.append(el('button', {
        type: 'button', class: mapAnchor.ax === x / 2 && mapAnchor.ay === y / 2 ? 'on' : '',
        'data-tip': `Keep the level pinned to the ${names[y][x]}`, 'aria-label': names[y][x],
        onclick: () => { mapAnchor = { ax: x / 2, ay: y / 2 }; renderAnchor(); },
      }));
    }
  }

  function readMapSize() {
    const { minMap, maxMap } = PS.LIMITS;
    const w = Number($('#mapW').value), h = Number($('#mapH').value);
    const ok = Number.isInteger(w) && Number.isInteger(h) && w >= minMap && h >= minMap && w <= maxMap && h <= maxMap;
    return { w, h, ok };
  }

  function updateMapInfo() {
    const info = $('#mapSizeInfo');
    const { w, h, ok } = readMapSize();
    info.classList.toggle('warn', !ok);
    info.textContent = ok
      ? `${w * T} × ${h * T} pixels · ${(w * h).toLocaleString()} cells`
      : `Please enter whole numbers from ${PS.LIMITS.minMap} to ${PS.LIMITS.maxMap}.`;
    $('#mapSizeApply').disabled = !ok;
  }

  async function applyMapSize() {
    const { w, h, ok } = readMapSize();
    if (!ok) return;
    const p = st.project;
    if (w === p.width && h === p.height) return PS.UI.closePopovers();
    const loss = PS.Project.resizeLoss(w, h, mapAnchor);
    PS.UI.closePopovers();
    if (loss.tiles || loss.objects) {
      const parts = [];
      if (loss.tiles) parts.push(PS.util.plural(loss.tiles, 'tile'));
      if (loss.objects) parts.push(PS.util.plural(loss.objects, 'object'));
      const okLoss = await PS.UI.confirm({
        title: 'Shrink the map?',
        text: `${parts.join(' and ')} would be outside the new size and will be removed.\nYou can undo this. Changing which side the level is pinned to may keep more of it.`,
        ok: 'Resize anyway', danger: true,
      });
      if (!okLoss) return;
    }
    PS.History.change(`Resize map to ${w} × ${h}`, () => PS.Project.resize(w, h, mapAnchor));
    PS.Renderer.fit();
    PS.UI.toast(`Map is now ${w} × ${h} tiles`, 'success', { duration: 1800 });
  }

  /* ============================== Input manager ============================== */
  function canvasPoint(e) {
    const r = PS.Renderer.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function initCanvasInput() {
    const canvas = PS.Renderer.canvas;
    const stage = $('#stage');

    canvas.addEventListener('pointerdown', (e) => {
      if (st.mode !== 'edit') return;
      canvas.focus({ preventScroll: true });
      PS.UI.closePopovers();
      if (PS.UI.narrow()) document.body.classList.remove('left-open', 'right-open');
      const pt = canvasPoint(e);
      if (e.button === 1 || (e.button === 0 && spaceHeld)) {
        e.preventDefault();
        pan = { x: pt.x, y: pt.y };
        canvas.setPointerCapture(e.pointerId);
        stage.classList.add('panning');
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      if (pointerId !== null) return;
      pointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      if (st.workspace === 'paint') {
        PS.Paint.canvasDown(pt, e);
        return;
      }
      PS.Tools.down(PS.Renderer.cellAt(pt.x, pt.y), e);
      App.updateStatus();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (st.mode !== 'edit') return;
      const pt = canvasPoint(e);
      if (pan) {
        PS.Renderer.panBy(pt.x - pan.x, pt.y - pan.y);
        pan = { x: pt.x, y: pt.y };
        return;
      }
      if (pointerId !== null && e.pointerId !== pointerId) return;
      if (st.workspace === 'paint') { PS.Paint.canvasMove(pt); return; }
      const cell = PS.Renderer.cellAt(pt.x, pt.y);
      if (PS.Tools.move(cell)) App.updateStatus(cell);
    });

    const end = (e) => {
      if (pan) {
        pan = null;
        stage.classList.remove('panning');
        return;
      }
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      if (st.workspace === 'paint') { PS.Paint.up(); return; }
      PS.Tools.up();
      App.updateStatus();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      if (st.workspace === 'paint') { PS.Paint.canvasLeave(); return; }
      if (!PS.Tools.dragging) { PS.Tools.leave(); App.updateStatus(null); }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('auxclick', (e) => e.preventDefault());

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (st.mode !== 'edit') return;
      const pt = canvasPoint(e);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        PS.Renderer.panBy(-(e.deltaY || e.deltaX) * unit, 0);
        return;
      }
      wheelAcc += e.deltaY * unit;
      const threshold = e.ctrlKey ? 10 : 40;
      if (Math.abs(wheelAcc) >= threshold) {
        PS.Renderer.zoomStep(wheelAcc < 0 ? 1 : -1, pt.x, pt.y);
        wheelAcc = 0;
      }
    }, { passive: false });
  }

  function nudgeObject(dx, dy) {
    const o = PS.Project.object(st.selectedObjectId);
    if (!o) return false;
    const nx = o.x + dx, ny = o.y + dy;
    if (!PS.Project.inBounds(nx, ny) || PS.Project.objectAt(nx, ny)) return true;
    const objLayer = PS.Project.objectsLayer();
    if (objLayer && objLayer.locked) return true;
    PS.History.change('Nudge object', () => { o.x = nx; o.y = ny; }, 'objects');
    return true;
  }

  function cycleTileset(dir) {
    const list = st.project.tilesets;
    if (!list.length) return;
    const i = list.findIndex((t) => t.id === st.activeTilesetId);
    const next = list[(i + dir + list.length) % list.length];
    st.activeTilesetId = next.id;
    if (!PS.Tools.TILE_TOOLS.has(st.tool)) PS.Tools.setTool('pencil');
    PS.AssetsPanel.renderTilesets();
    PS.AssetsPanel.updateActive();
    App.flashStatus(`Tileset: ${next.name}`);
    PS.Renderer.request();
  }

  function anyDialogOpen() {
    return $('#confirmDialog').open || $('#spriteDialog').open || $('#tilesetDialog').open || $('#paletteDialog').open;
  }

  function initKeyboard() {
    const stage = $('#stage');
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && st.mode === 'play') e.preventDefault();
      if (anyDialogOpen()) return;

      if (st.mode === 'play') {
        const overlay = !$('#gameOverlay').hidden;
        if (overlay && (e.key === 'Enter' || e.key === ' ') && document.activeElement && document.activeElement.tagName === 'BUTTON') return;
        if (PS.Game.keyDown(e)) e.preventDefault();
        return;
      }

      if (PS.util.isTypingTarget(e.target)) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (e.code === 'Space') {
        e.preventDefault();
        if (!spaceHeld) { spaceHeld = true; stage.classList.add('tool-pan'); }
        return;
      }

      if (mod) {
        const actions = {
          z: () => (e.shiftKey ? PS.History.redo() : PS.History.undo()),
          y: () => PS.History.redo(),
          s: () => PS.Storage.saveFile(),
          o: () => { $('#fileProject').value = ''; $('#fileProject').click(); },
          c: () => PS.Tools.copy(),
          x: () => PS.Tools.cut(),
          v: () => PS.Tools.paste(),
          a: () => PS.Tools.selectAll(),
        };
        if (actions[key]) { e.preventDefault(); actions[key](); }
        return;
      }
      if (e.altKey) return;

      // Only from the level or the page itself, so Tab can still move between buttons and fields.
      if (e.key === 'Tab' && (e.target === document.body || e.target === PS.Renderer.canvas)) {
        e.preventDefault();
        App.setWorkspace(st.workspace === 'paint' ? 'build' : 'paint');
        return;
      }

      if (st.workspace === 'paint') {
        const paintKeys = { b: 'brush', e: 'eraser', g: 'fill', i: 'picker' };
        if (paintKeys[key]) { PS.Paint.setTool(paintKeys[key]); return; }
        if (key === 'h') { PS.Paint.setBrush('heal'); return; }
        const size = st.prefs.paint.size;
        const res = PS.Project.tileset(st.activeTilesetId) ? PS.Paint.sheetSize(PS.Project.tileset(st.activeTilesetId)) : PS.Autotile.SHEET;
        const change = Math.max(1, Math.round(size * 0.2));
        if (e.key === '[') { PS.Paint.setSize(size - change, PS.Paint.maxSize(res)); App.flashStatus(`Brush size ${st.prefs.paint.size}`); return; }
        if (e.key === ']') { PS.Paint.setSize(size + change, PS.Paint.maxSize(res)); App.flashStatus(`Brush size ${st.prefs.paint.size}`); return; }
        if (key === 'f') { PS.PaintPanel.toggleFull(); return; }
        if (PS.PaintPanel.isFull && ['+', '=', '-', '_', '0'].includes(e.key)) {
          PS.PaintPanel.zoomSheet(e.key === '0' ? 0 : e.key === '+' || e.key === '=' ? 1 : -1);
          return;
        }
        if (e.key === 'Escape') {
          if (PS.Paint.cancel()) return;
          if (PS.PaintPanel.isFull) PS.PaintPanel.toggleFull();
          else App.setWorkspace('build');
          return;
        }
        if (['Delete', 'Backspace', 'r', 'R', 'p', 'v', 'm'].includes(e.key)) return;
      }

      const toolKeys = { p: 'pencil', e: 'eraser', g: 'fill', i: 'eyedropper', v: 'select', m: 'move' };
      if (toolKeys[key]) { PS.Tools.setTool(toolKeys[key]); return; }
      if (key === 'r') { PS.Tools.setTool(e.shiftKey ? 'rectFill' : 'rect'); return; }

      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (st.selectedObjectId) PS.Tools.deleteObject(st.selectedObjectId);
          else if (st.selection) PS.Tools.clearSelection();
          break;
        case 'Escape':
          if (PS.Tools.cancel()) break;
          if (PS.UI.closePopovers()) break;
          if (PS.Settings.close()) break;
          if (!$('#welcome').hidden) { App.hideWelcome(); break; }
          if (PS.Tools.deselect()) break;
          if (st.tool === 'place') PS.Tools.setTool('select');
          break;
        case 'Enter':
          e.preventDefault();
          PS.Game.start();
          break;
        case '+':
        case '=':
          PS.Renderer.zoomStep(1);
          break;
        case '-':
        case '_':
          PS.Renderer.zoomStep(-1);
          break;
        case '0':
          PS.Renderer.fit();
          break;
        case '[':
          cycleTileset(-1);
          break;
        case ']':
          cycleTileset(1);
          break;
        case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
          const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (nudgeObject(d[0], d[1])) e.preventDefault();
          else { PS.Renderer.panBy(-d[0] * 64, -d[1] * 64); e.preventDefault(); }
          break;
        }
        default:
      }
    });

    window.addEventListener('keyup', (e) => {
      if (st.mode === 'play') { if (PS.Game.keyUp(e)) e.preventDefault(); return; }
      if (e.code === 'Space') { spaceHeld = false; stage.classList.remove('tool-pan'); }
    });

    window.addEventListener('blur', () => {
      spaceHeld = false;
      stage.classList.remove('tool-pan');
      PS.Game.blur();
    });
  }

  /* ============================== Toolbar ============================== */
  function initToolbar() {
    const name = $('#projectName');
    name.addEventListener('change', () => {
      st.project.name = PS.util.cleanName(name.value, 'My Platformer', 40);
      name.value = st.project.name;
      App.documentChanged('meta');
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });

    $('#btnNew').addEventListener('click', async () => {
      const ok = await PS.UI.confirm({
        title: 'Start a new project?',
        text: 'Your current level will be replaced with an empty map. Save it first if you want to keep it.',
        ok: 'New project',
      });
      if (!ok) return;
      await App.setProject(PS.Project.create());
      PS.UI.toast('New project ready. Pick a tileset and start drawing.', 'success');
    });

    const fileProject = $('#fileProject');
    $('#btnOpen').addEventListener('click', () => { fileProject.value = ''; fileProject.click(); });
    fileProject.addEventListener('change', () => { if (fileProject.files[0]) App.openProjectFile(fileProject.files[0]); });
    $('#btnSave').addEventListener('click', () => PS.Storage.saveFile());
    $('#btnUndo').addEventListener('click', () => PS.History.undo());
    $('#btnRedo').addEventListener('click', () => PS.History.redo());

    $('#btnMapSize').addEventListener('click', openMapSize);
    $('#mapW').addEventListener('input', updateMapInfo);
    $('#mapH').addEventListener('input', updateMapInfo);
    for (const input of [$('#mapW'), $('#mapH')]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); applyMapSize(); }
        if (e.key === 'Escape') PS.UI.closePopovers();
      });
    }
    $('#mapSizeApply').addEventListener('click', applyMapSize);
    $('#mapSizeCancel').addEventListener('click', () => PS.UI.closePopovers());
    const presets = [[20, 12, 'Small'], [40, 15, 'Medium'], [80, 20, 'Long'], [20, 40, 'Tall']];
    $('#sizePresets').replaceChildren(...presets.map(([w, h, label]) => el('button', {
      type: 'button', text: `${label} ${w}×${h}`,
      onclick: () => { $('#mapW').value = w; $('#mapH').value = h; updateMapInfo(); },
    })));

    $('#wsBuild').addEventListener('click', (e) => { e.currentTarget.blur(); App.setWorkspace('build'); });
    $('#wsPaint').addEventListener('click', (e) => { e.currentTarget.blur(); App.setWorkspace('paint'); });
    $('#viewSide').addEventListener('click', () => App.setView('side'));
    $('#viewIso').addEventListener('click', () => App.setView('iso'));

    $('#btnZoomIn').addEventListener('click', () => PS.Renderer.zoomStep(1));
    $('#btnZoomOut').addEventListener('click', () => PS.Renderer.zoomStep(-1));
    $('#zoomLabel').addEventListener('click', () => PS.Renderer.fit());
    $('#btnFit').addEventListener('click', () => PS.Renderer.fit());
    $('#btnGrid').addEventListener('click', () => {
      st.prefs.showGrid = !st.prefs.showGrid;
      PS.savePrefs();
      App.refreshToolbar();
      PS.Renderer.request();
    });

    $('#btnPlay').addEventListener('click', () => (PS.Game.running ? PS.Game.stop() : PS.Game.start()));
    $('#btnExport').addEventListener('click', (e) => PS.Exporter.open(e.currentTarget));
    $('#btnSettings').addEventListener('click', () => PS.Settings.toggle());
    $('#toggleLeft').addEventListener('click', () => PS.UI.toggleSidebar('left'));
    $('#toggleRight').addEventListener('click', () => PS.UI.toggleSidebar('right'));

    $('#hudPause').addEventListener('click', () => PS.Game.togglePause());
    $('#hudRestart').addEventListener('click', () => PS.Game.restart());
    $('#hudExit').addEventListener('click', () => PS.Game.stop());

    $('#welcomeClose').addEventListener('click', () => App.hideWelcome());
    $('#welcomeStart').addEventListener('click', () => {
      App.hideWelcome();
      if (st.project.tilesets.length) {
        st.activeTilesetId = st.activeTilesetId || st.project.tilesets[0].id;
        PS.Tools.setTool('pencil');
        PS.UI.flashSection('secTilesets');
      }
    });
    $('#welcomeExample').addEventListener('click', async () => {
      if (st.dirty && PS.History.canUndo()) {
        const ok = await PS.UI.confirm({ title: 'Open the example level?', text: 'It replaces your current level. Save first if you want to keep it.', ok: 'Open example' });
        if (!ok) return;
      }
      App.hideWelcome();
      await App.setProject(buildExample());
      PS.UI.toast('Example loaded. Press Play (or Enter) to try it!', 'success', { duration: 4000 });
    });

    $('#welcomeIsoExample').addEventListener('click', async () => {
      if (st.dirty && PS.History.canUndo()) {
        const ok = await PS.UI.confirm({ title: 'Open the iso example?', text: 'It replaces your current level. Save first if you want to keep it.', ok: 'Open example' });
        if (!ok) return;
      }
      App.hideWelcome();
      await App.setProject(buildIsoExample());
      st.activeTilesetId = st.project.tilesets[st.project.tilesets.length - 1].id;
      PS.AssetsPanel.render();
      PS.UI.toast('Iso example loaded. Press Play, then use the arrow keys and Space.', 'success', { duration: 4000 });
    });

    PS.bus.on('history', () => App.updateUndo());
    PS.bus.on('view', () => App.updateZoom());
    PS.bus.on('tool', () => { App.updateStatus(); PS.PropsPanel.render(); });
    PS.bus.on('mode', () => {
      const play = $('#btnPlay');
      const playing = PS.Game.running;
      play.querySelector('[data-icon]').dataset.icon = playing ? 'stop' : 'play';
      play.querySelector('.label').textContent = playing ? 'Stop' : 'Play';
      play.dataset.tip = playing ? 'Back to the editor (Esc)' : 'Playtest your level (Enter)';
      $('#hudPause').dataset.icon = PS.Game.paused ? 'play' : 'pause';
      PS.hydrateIcons(document.getElementById('topbar'));
      PS.hydrateIcons(document.getElementById('hud'));
      PS.Settings.close();
      PS.UI.closePopovers();
      App.updateEmpty();
      PS.Renderer.request();
    });
  }

  /* ============================== Startup ============================== */
  async function init() {
    const prefs = st.prefs;
    document.documentElement.dataset.theme = prefs.theme === 'light' ? 'light' : 'dark';
    document.body.classList.toggle('left-closed', !!prefs.leftClosed);
    document.body.classList.toggle('right-closed', !!prefs.rightClosed);

    PS.hydrateIcons();
    PS.UI.initTooltips();
    PS.UI.initSections();
    PS.Renderer.init($('#canvas'));
    PS.AssetsPanel.init();
    PS.LayersPanel.init();
    PS.SpriteEditor.init();
    PS.PaintPanel.init();
    PS.Settings.init();
    initToolbar();
    initCanvasInput();
    initKeyboard();

    const restored = await PS.Storage.restore();
    await App.setProject(restored || PS.Project.create());
    if (restored && (restored.objects.length || PS.Project.totalTiles())) {
      PS.UI.toast('Welcome back! Your last project was restored.', 'success');
    }
    App.showWelcome(false);
    window.addEventListener('beforeunload', () => { if (st.project) PS.Storage.autosave(); });
    window.addEventListener('resize', () => {
      if (!PS.UI.narrow()) document.body.classList.remove('left-open', 'right-open');
    });
  }

  // Unexpected errors: log for developers, show a friendly message to users.
  window.addEventListener('error', (e) => {
    console.error(e.error || e.message);
    if (PS.UI) PS.UI.toast('Something went wrong, but your work is safe. If it keeps happening, save your project and reload the page.', 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
  });

  init();
})(window.PS);
