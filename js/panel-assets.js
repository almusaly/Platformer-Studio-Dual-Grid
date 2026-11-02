/* =====================================================================
   Platformer Studio — left sidebar: assets and drawing tools
   ===================================================================== */
(function (PS) {
  'use strict';

  const { el, $, $$ } = PS.util;
  const st = PS.state;
  const UI = () => PS.UI;

  let pendingItem = null; // custom collectible waiting for confirmation
  const TILESET_SIZES = [[128, 128], [256, 256], [512, 512], [1024, 1024], [96, 96]];
  const PALETTE_FILE = /\.(hex|pal|gpl|ase)$/i;

  function card({ name, thumb, active, kind, key, tip, onclick, tools = [] }) {
    const c = el('button', {
      class: 'asset-card' + (active ? ' active' : ''), type: 'button',
      dataset: { kind, key: String(key), name: name.toLowerCase() },
      'data-tip': tip || name, onclick,
    }, thumb, el('span', { class: 'card-name', text: name }));
    for (const t of tools) {
      c.append(el('span', {
        class: 'card-tool', role: 'button', tabindex: 0, 'data-tip': t.tip, html: PS.icon(t.icon, 12),
        onclick: (e) => { e.stopPropagation(); t.fn(); },
        onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); t.fn(); } },
      }));
    }
    return c;
  }

  function addCard(label, tip, onclick) {
    return el('button', { class: 'asset-card add-card', type: 'button', 'data-tip': tip, onclick },
      el('span', { class: 'thumb', html: PS.icon('plus', 20) }), el('span', { class: 'card-name', text: label }));
  }

  /* ------------------------------ Tilesets ------------------------------ */
  function selectTileset(id) {
    st.activeTilesetId = id;
    if (!PS.Tools.TILE_TOOLS.has(st.tool)) PS.Tools.setTool('pencil');
    if (!PS.Project.activeTileLayer()) {
      const l = PS.Project.defaultTileLayer();
      if (l) { st.activeLayerId = l.id; PS.App.refreshLayers(); }
    }
    Panel.renderTilesets();
    Panel.updateActive();
    PS.Renderer.request();
  }

  async function uploadTilesets(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    let added = 0, firstId = 0, errors = 0;
    for (const file of list) {
      const res = await PS.Assets.readImageFile(file, { sizes: TILESET_SIZES });
      if (!res.ok) {
        if (errors++ < 3) UI().toast(res.error, 'error', { duration: 7000 });
        continue;
      }
      const ts = { id: PS.Project.newId(), name: res.name, src: res.src };
      st.project.tilesets.push(ts);
      await PS.Assets.setTilesetSource(ts, ts.src);
      if (!firstId) firstId = ts.id;
      added++;
    }
    if (!added) return;
    PS.App.documentChanged('meta');
    selectTileset(firstId);
    UI().toast(added === 1 ? 'Tileset added. Drag on the grid to draw with it.' : `${added} tilesets added`, 'success');
  }

  async function replaceTileset(file) {
    const ts = PS.Project.tileset(st.activeTilesetId);
    if (!ts || !file) return;
    const res = await PS.Assets.readImageFile(file, { sizes: TILESET_SIZES });
    if (!res.ok) return UI().toast(res.error, 'error', { duration: 7000 });
    await PS.Assets.setTilesetSource(ts, res.src);
    PS.Renderer.invalidateAll();
    PS.App.documentChanged('meta');
    Panel.renderTilesets();
    UI().toast(`“${ts.name}” image replaced. The map updated everywhere it is used.`, 'success');
  }

  async function deleteTileset(ts) {
    const used = PS.Project.tilesetUsage(ts.id);
    if (used) {
      const ok = await UI().confirm({
        title: `Delete “${ts.name}”?`,
        text: `This tileset is used in ${PS.util.plural(used, 'cell')}. Those tiles will be removed from the map.\nYou can undo this.`,
        ok: 'Delete', danger: true,
      });
      if (!ok) return;
    }
    const idx = st.project.tilesets.indexOf(ts);
    PS.History.change(`Delete tileset “${ts.name}”`, () => PS.Project.removeTileset(ts.id));
    const rest = st.project.tilesets;
    st.activeTilesetId = rest.length ? rest[Math.min(idx, rest.length - 1)].id : 0;
    Panel.render();
    UI().toast(`Deleted “${ts.name}”`, 'info', { action: { label: 'Undo', fn: () => PS.History.undo() } });
  }

  /* ------------------------------ Characters ------------------------------ */
  function chooseCharacter(key) {
    if (st.project.character !== key) {
      PS.History.change('Change character', () => { st.project.character = key; }, 'objects');
    }
    PS.Tools.setPlaceItem({ kind: 'spawn' });
    Panel.renderCharacters();
    if (!PS.Project.spawn()) PS.UI.toast('Now click the map to set where the player starts.', 'info', { duration: 2500 });
  }

  function guessFrames(img) {
    const w = img.width, h = img.height;
    if (w === 32 && h === 32) return { fw: 32, fh: 32 };
    if (w > h && w % h === 0) return { fw: h, fh: h };
    if (h > w && h % w === 0) return { fw: w, fh: w };
    if (w % 32 === 0 && h % 32 === 0) return { fw: 32, fh: 32 };
    return { fw: w, fh: h };
  }

  async function uploadCharacter(file) {
    if (!file) return;
    const res = await PS.Assets.readImageFile(file, { maxSide: 4096 });
    if (!res.ok) return UI().toast(res.error, 'error', { duration: 7000 });
    const { fw, fh } = guessFrames(res.img);
    const count = Math.floor(res.img.width / fw) * Math.floor(res.img.height / fh);
    const ch = {
      id: PS.Project.newId(), name: res.name, src: res.src, frameW: fw, frameH: fh, fps: 8,
      anims: { idle: [0], walk: count > 1 ? Array.from({ length: Math.min(count, 8) }, (_, i) => i) : [], jump: [], fall: [] },
    };
    st.project.characters.push(ch);
    await PS.Assets.load(ch.src).catch(() => {});
    PS.App.documentChanged('meta');
    chooseCharacter('char:' + ch.id);
    if (count > 1) {
      PS.SpriteEditor.open(ch);
    } else if (res.img.width !== 32 || res.img.height !== 32) {
      UI().toast(`“${ch.name}” is ${res.img.width} × ${res.img.height}. It has been scaled to fit a 32 × 32 tile without stretching.`, 'info', { duration: 5000 });
    } else {
      UI().toast(`“${ch.name}” added. It gets a gentle bounce while moving.`, 'success');
    }
  }

  /* ------------------------------ Collectibles ------------------------------ */
  async function uploadCollectible(file) {
    if (!file) return;
    const res = await PS.Assets.readImageFile(file, { maxSide: 1024 });
    if (!res.ok) return UI().toast(res.error, 'error', { duration: 7000 });
    pendingItem = { name: res.name, src: res.src, w: res.img.width, h: res.img.height, img: res.img, points: 10 };
    Panel.renderPendingItem();
    UI().flashSection('secCollectibles');
  }

  function confirmPendingItem() {
    const it = pendingItem;
    if (!it) return;
    const def = { id: PS.Project.newId(), name: PS.util.cleanName(it.name, 'Item', 30), src: it.src, points: it.points, anim: 'bob', sound: 'coin' };
    st.project.customCollectibles.push(def);
    pendingItem = null;
    PS.Assets.load(def.src).catch(() => {});
    PS.App.documentChanged('meta');
    Panel.renderPendingItem();
    Panel.renderCollectibles();
    PS.Tools.setPlaceItem({ kind: 'collectible', type: 'item:' + def.id });
    UI().toast(`“${def.name}” added. Click the map to place it.`, 'success');
  }

  async function deleteCollectible(def) {
    const key = 'item:' + def.id;
    const used = st.project.objects.filter((o) => o.type === key).length;
    if (used) {
      const ok = await UI().confirm({
        title: `Delete “${def.name}”?`,
        text: `${PS.util.plural(used, 'copy')} of it ${used === 1 ? 'is' : 'are'} placed in the level and will be removed.\nYou can undo this.`.replace('copys', 'copies'),
        ok: 'Delete', danger: true,
      });
      if (!ok) return;
    }
    PS.History.change(`Delete collectible “${def.name}”`, () => {
      st.project.customCollectibles = st.project.customCollectibles.filter((c) => c !== def);
      st.project.objects = st.project.objects.filter((o) => o.type !== key);
    });
    if (st.placeItem && st.placeItem.type === key) PS.Tools.setTool('select');
    if (!PS.Project.object(st.selectedObjectId)) st.selectedObjectId = 0;
    Panel.renderCollectibles();
    PS.App.refreshProps();
  }

  /* ------------------------------ Drop zones ------------------------------ */
  async function importPaletteFile(file) {
    const res = await PS.Palettes.fromFile(file);
    if (!res.ok) return UI().toast(res.error, 'error', { duration: 6000 });
    const pal = PS.Palettes.add(res.name, res.colors);
    UI().toast(`Palette “${pal.name}” added (${PS.util.plural(pal.colors.length, 'colour')}).`, 'success');
  }

  function routeFiles(files, target) {
    const list = Array.from(files);
    const json = list.find((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
    if (json) return PS.App.openProjectFile(json);
    if (!list.length) return;
    if (PALETTE_FILE.test(list[0].name)) return importPaletteFile(list[0]);
    if (target === 'character') return uploadCharacter(list[0]);
    if (target === 'collectible') return uploadCollectible(list[0]);
    return uploadTilesets(list);
  }

  function initDrops() {
    for (const zone of $$('.drop-zone')) {
      zone.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); zone.classList.add('drag-over'); } });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('drag-over');
        if (st.mode === 'edit') routeFiles(e.dataTransfer.files, zone.dataset.drop);
      });
    }
    // Anywhere else: images become tilesets, .json opens a project
    window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (st.mode === 'edit' && e.dataTransfer.files.length) routeFiles(e.dataTransfer.files, 'tileset');
    });
  }

  /* ------------------------------ Panel ------------------------------ */
  const Panel = {
    uploadTilesets,

    init() {
      const fileTs = $('#fileTileset'), fileRep = $('#fileReplaceTileset');
      const fileCh = $('#fileCharacter'), fileCol = $('#fileCollectible');
      const pickFile = (input) => { input.value = ''; input.click(); };
      $('#btnUploadTileset').addEventListener('click', (e) => { e.stopPropagation(); pickFile(fileTs); });
      $('#btnNewTileset').addEventListener('click', (e) => { e.stopPropagation(); PS.PaintPanel.openNewTileset(); });
      $('#btnUploadCharacter').addEventListener('click', (e) => { e.stopPropagation(); pickFile(fileCh); });
      $('#btnUploadCollectible').addEventListener('click', (e) => { e.stopPropagation(); pickFile(fileCol); });
      fileTs.addEventListener('change', () => uploadTilesets(fileTs.files));
      fileRep.addEventListener('change', () => replaceTileset(fileRep.files[0]));
      fileCh.addEventListener('change', () => uploadCharacter(fileCh.files[0]));
      fileCol.addEventListener('change', () => uploadCollectible(fileCol.files[0]));
      Panel.pickFile = pickFile;
      $('#assetSearch').addEventListener('input', Panel.applySearch);
      initDrops();
      PS.bus.on('tool', () => Panel.updateActive());
      PS.bus.on('assets-ready', () => { Panel.renderCharacters(); Panel.renderCollectibles(); });
    },

    render() {
      Panel.renderTilesets();
      Panel.renderCharacters();
      Panel.renderEnemies();
      Panel.renderCollectibles();
      Panel.renderGoals();
      Panel.renderTools();
      Panel.renderPendingItem();
      Panel.applySearch();
    },

    renderTilesets() {
      const p = st.project;
      const list = $('#tilesetList');
      list.replaceChildren(...p.tilesets.map((ts) => card({
        name: ts.name, kind: 'tileset', key: ts.id, active: ts.id === st.activeTilesetId,
        tip: `${ts.name}: click to draw with it`,
        thumb: el('img', { class: 'thumb checker-bg' + (PS.Assets.isHires(ts) ? ' hires' : ''), src: ts.src, alt: '', draggable: false }),
        onclick: () => selectTileset(ts.id),
      })),
      addCard('New', 'Create a tileset here: pick a style and colours, then paint it', () => PS.PaintPanel.openNewTileset()),
      addCard('Upload', 'Upload a dual-grid sheet of 128, 256, 512 or 1024 pixels (or a classic 96 × 96 set, which is converted). You can pick several at once.', () => Panel.pickFile($('#fileTileset'))));
      $('#tilesetCount').textContent = p.tilesets.length ? String(p.tilesets.length) : '';

      const detail = $('#tilesetDetail');
      const ts = PS.Project.tileset(st.activeTilesetId);
      if (!ts) {
        detail.replaceChildren(el('p', { class: 'hint', text: p.tilesets.length
          ? 'Pick a tileset above to start drawing.'
          : 'Click New to create a tileset right here, no other app needed. You can also upload or drop a sheet of 128 to 1024 pixels.' }));
        return;
      }
      const sheet = el('div', { class: 'ts-nine checker-bg' }, el('img', { class: PS.Assets.isHires(ts) ? 'hires' : null, src: ts.src, alt: '' }),
        PS.Autotile.MASK_AT.flat().map((m) => el('span', { 'data-tip': `${PS.Autotile.NAMES[m]}: placed automatically` })));
      const used = PS.Project.tilesetUsage(ts.id);
      detail.replaceChildren(el('div', { class: 'ts-detail' },
        el('div', { class: 'ts-detail-top' }, sheet,
          el('div', { class: 'ts-meta' },
            el('input', {
              value: ts.name, maxlength: 30, 'aria-label': 'Tileset name', 'data-tip': 'Rename this tileset',
              onchange: (e) => { ts.name = PS.util.cleanName(e.target.value, ts.name, 30); e.target.value = ts.name; PS.App.documentChanged('meta'); Panel.renderTilesets(); },
            }),
            el('span', { class: 'usage', text: used ? `Used in ${PS.util.plural(used, 'cell')}` : 'Not used yet' }),
            el('span', { class: 'usage', text: `${PS.Paint.sheetSize(ts)} × ${PS.Paint.sheetSize(ts)} pixels. Corners and edges are chosen for you as you draw.` }))),
        el('button', { class: 'btn sm primary block', 'data-tip': 'Paint this tileset on its sheet or directly on your platforms (Tab)', onclick: () => PS.App.setWorkspace('paint') },
          el('span', { 'data-icon': 'brush', 'data-icon-size': 14 }), 'Paint this tileset'),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn sm', 'data-tip': 'Swap in a new sheet of 128, 256, 512 or 1024 pixels. Everything drawn with it updates.', onclick: () => Panel.pickFile($('#fileReplaceTileset')) },
            el('span', { 'data-icon': 'refresh', 'data-icon-size': 14 }), 'Replace'),
          el('button', { class: 'btn sm danger', 'data-tip': 'Delete this tileset', onclick: () => deleteTileset(ts) },
            el('span', { 'data-icon': 'trash', 'data-icon-size': 14 }), 'Delete'))));
      PS.hydrateIcons(detail);
      Panel.updateActive();
    },

    renderCharacters() {
      const p = st.project;
      $('#characterList').replaceChildren(...PS.Assets.characterList().map((c) => card({
        name: c.name, kind: 'character', key: c.key, active: p.character === c.key,
        tip: c.custom ? `${c.name} (your upload): click to use, then click the map` : `${c.name}: click to use, then click the map to set the start`,
        thumb: UI().spriteThumb(PS.Assets.character(c.key).frames.idle[0], 48, 'thumb' + (c.custom ? ' checker-bg' : '')),
        onclick: () => chooseCharacter(c.key),
        tools: c.custom ? [{ icon: 'film', tip: 'Set up animation frames', fn: () => PS.SpriteEditor.open(c.def) }] : [],
      })), addCard('Upload', 'Upload your own 32 × 32 character or a sprite sheet', () => Panel.pickFile($('#fileCharacter'))));
      Panel.updateActive();
    },

    renderEnemies() {
      $('#enemyList').replaceChildren(...PS.Assets.enemyList().map((e) => card({
        name: e.name, kind: 'enemy', key: e.key,
        tip: `${e.name}: click, then click the map to place`,
        thumb: UI().spriteThumb(e.frames[0]),
        onclick: () => PS.Tools.setPlaceItem({ kind: 'enemy', type: e.key }),
      })));
      Panel.updateActive();
    },

    renderCollectibles() {
      $('#collectibleList').replaceChildren(...PS.Assets.collectibleList().map((c) => {
        const def = PS.Assets.collectible(c.key);
        const value = def.life ? '+1 life' : `${def.points} points`;
        return card({
          name: c.name, kind: 'collectible', key: c.key,
          tip: `${c.name} (${value}): click, then click the map to place`,
          thumb: UI().spriteThumb(def.frames[0], 48, 'thumb' + (c.custom ? ' checker-bg' : '')),
          onclick: () => PS.Tools.setPlaceItem({ kind: 'collectible', type: c.key }),
          tools: c.custom ? [{ icon: 'trash', tip: 'Delete this collectible', fn: () => deleteCollectible(c.def) }] : [],
        });
      }), addCard('Upload', 'Upload your own collectible image (transparent PNG, ideally 32 × 32)', () => Panel.pickFile($('#fileCollectible'))));
      Panel.updateActive();
    },

    renderPendingItem() {
      const box = $('#collectiblePending');
      const it = pendingItem;
      if (!it) { box.replaceChildren(); return; }
      const prev = el('canvas', { width: 32, height: 32, class: 'checker-bg' });
      const ctx = prev.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      let s = Math.min(32 / it.w, 32 / it.h);
      if (s >= 1) s = Math.floor(s);
      const dw = Math.max(1, Math.round(it.w * s)), dh = Math.max(1, Math.round(it.h * s));
      ctx.drawImage(it.img, Math.floor((32 - dw) / 2), Math.floor((32 - dh) / 2), dw, dh);
      const note = it.w === 32 && it.h === 32 ? 'Perfect size: 32 × 32.' :
        `This image is ${it.w} × ${it.h}. It will be ${it.w > 32 || it.h > 32 ? 'shrunk' : 'centred'} to fit one 32 × 32 tile without stretching.`;
      box.replaceChildren(el('div', { class: 'pending-card' },
        el('div', { class: 'pc-top' }, prev,
          el('div', { class: 'stack', style: 'gap:6px;flex:1;min-width:0' },
            el('input', { value: it.name, maxlength: 30, 'aria-label': 'Collectible name', oninput: (e) => { it.name = e.target.value; } }),
            UI().numberField('Points', it.points, { min: 0, max: 100000 }, (v) => { it.points = v; }))),
        el('span', { class: 'hint', text: note }),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn sm', text: 'Cancel', onclick: () => { pendingItem = null; Panel.renderPendingItem(); } }),
          el('button', { class: 'btn sm primary', text: 'Add collectible', onclick: confirmPendingItem }))));
    },

    renderGoals() {
      $('#goalList').replaceChildren(...PS.Assets.goalList().map((g) => card({
        name: g.name, kind: 'goal', key: g.key,
        tip: `${g.name}: click, then click the map. There is one goal per level.`,
        thumb: UI().spriteThumb(g.frames[0]),
        onclick: () => PS.Tools.setPlaceItem({ kind: 'goal', type: g.key }),
      })));
      Panel.updateActive();
    },

    renderTools() {
      $('#toolGrid').replaceChildren(...PS.Tools.DEFS.map((d) => el('button', {
        class: 'tool-btn' + (st.tool === d.key ? ' active' : ''), type: 'button',
        dataset: { tool: d.key }, 'data-tip': d.tip, 'aria-label': d.name,
        onclick: () => PS.Tools.setTool(d.key),
      }, el('span', { html: PS.icon(d.icon, 18) }), el('span', { class: 'key', text: d.shortcut }))));
    },

    updateActive() {
      const it = st.tool === 'place' ? st.placeItem : null;
      for (const c of $$('#leftbar .asset-card[data-kind]')) {
        const { kind, key } = c.dataset;
        let on = false;
        if (kind === 'tileset') on = Number(key) === st.activeTilesetId && PS.Tools.TILE_TOOLS.has(st.tool);
        else if (kind === 'character') on = st.project.character === key;
        else if (it) on = it.kind === kind && it.type === key;
        c.classList.toggle('active', on);
      }
      for (const b of $$('#toolGrid .tool-btn')) b.classList.toggle('active', b.dataset.tool === st.tool);
    },

    applySearch() {
      const q = $('#assetSearch').value.trim().toLowerCase();
      document.body.classList.toggle('searching', !!q);
      let any = false;
      for (const panel of $$('#leftbar .sidebar-scroll .panel')) {
        let visible = 0;
        for (const c of panel.querySelectorAll('.asset-card')) {
          const match = !q || (!c.classList.contains('add-card') && (c.dataset.name || '').includes(q));
          c.hidden = !match;
          if (match) visible++;
        }
        panel.hidden = !!q && !visible;
        if (visible) any = true;
      }
      $('#noResults').hidden = !q || any;
    },
  };

  PS.AssetsPanel = Panel;
})(window.PS);
