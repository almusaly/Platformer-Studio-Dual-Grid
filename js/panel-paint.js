/* =====================================================================
   Platformer Studio — Paint workspace
   Left: tools, brushes and palette. Next to the level: the tile sheet and
   a small live sample. Also the "new tileset" and "add palette" dialogs.
   ===================================================================== */
(function (PS) {
  'use strict';

  const { el, $ } = PS.util;
  const st = PS.state;
  const T = PS.TILE;
  const ZOOMS = [0.125, 0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
  const Pal = PS.Palettes;
  const { ATLAS, MASK_AT, NAMES } = PS.Autotile;
  const UI = () => PS.UI;
  const prefs = () => st.prefs.paint;

  /** A little level shape showing how the tiles connect, including every kind of corner. */
  const SAMPLE = [
    '.........',
    '.##...##.',
    '.####.##.',
    '.#######.',
    '...###...',
    '.#.###.#.',
    '.......#.',
  ];

  let hoverTile = null;        // { col, row } under the pointer on the sheet
  // How the sheet sits in its view: zoom is screen pixels per sheet pixel, x and y its corner.
  // While `fit` is on, it always shows the whole sheet.
  const view = { fit: true, zoom: 1, x: 0, y: 0 };
  let lastRes = 0;
  let selectedTile = { col: 2, row: 1 };
  let tileClipboard = null;
  let sheetPointer = null;
  let raf = 0;
  let guideCache = null;

  const activeTileset = () => PS.Project.tileset(st.activeTilesetId);

  /* ------------------------------ Tile sheet ------------------------------ */
  const activeRes = () => { const ts = activeTileset(); return ts ? PS.Paint.sheetSize(ts) : PS.Autotile.SHEET; };

  function fitView() {
    const host = $('#sheetHost');
    const res = activeRes();
    const room = Math.max(32, Math.min(host.clientWidth, host.clientHeight) - 8);
    const z = room / res;
    view.zoom = z >= 1 ? Math.floor(z) : z;
    view.x = Math.round((host.clientWidth - res * view.zoom) / 2);
    view.y = Math.round((host.clientHeight - res * view.zoom) / 2);
  }

  /** Zoom one step, keeping the point under (cx, cy) in place. */
  function zoomStep(dir, cx, cy) {
    const host = $('#sheetHost');
    if (cx === undefined) { cx = host.clientWidth / 2; cy = host.clientHeight / 2; }
    const z = view.zoom;
    const next = dir > 0 ? ZOOMS.find((v) => v > z + 1e-6) : [...ZOOMS].reverse().find((v) => v < z - 1e-6);
    if (!next) return;
    view.fit = false;
    view.x = cx - ((cx - view.x) * next) / z;
    view.y = cy - ((cy - view.y) * next) / z;
    view.zoom = next;
    clampView();
    requestDraw();
  }

  /** Always keep some of the sheet in view, so it can't be lost. */
  function clampView() {
    const host = $('#sheetHost');
    const size = activeRes() * view.zoom, keep = 48;
    view.x = PS.util.clamp(view.x, keep - size, host.clientWidth - keep);
    view.y = PS.util.clamp(view.y, keep - size, host.clientHeight - keep);
  }

  function setFit() {
    view.fit = true;
    requestDraw();
  }

  function checkerPattern(ctx) {
    const cs = getComputedStyle(document.documentElement);
    const c = PS.Sprites.canvas(16, 16);
    const g = c.getContext('2d');
    g.fillStyle = cs.getPropertyValue('--checker-a').trim();
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = cs.getPropertyValue('--checker-b').trim();
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    return ctx.createPattern(c, 'repeat');
  }

  function drawSheet() {
    const canvas = $('#sheetPaint');
    const host = $('#sheetHost');
    const ts = activeTileset();
    const res = activeRes();
    const tileRes = res / 4;
    if (view.fit) fitView();
    const dpr = window.devicePixelRatio || 1;
    const cssW = host.clientWidth, cssH = host.clientHeight;
    const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W; canvas.height = H;
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    }
    $('#sheetZoomLabel').textContent = Math.round(view.zoom * 100) + '%';

    const ctx = canvas.getContext('2d');
    const scale = view.zoom * dpr;
    const ox = Math.round(view.x * dpr), oy = Math.round(view.y * dpr);
    const size = Math.round(res * scale);
    const tile = tileRes * scale;
    const px = (v) => Math.round(v * scale);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = checkerPattern(ctx);
    ctx.fillRect(ox, oy, size, size);

    // Crisp when zoomed in; smoothed only when more pixels than the screen can show are squeezed in.
    const art = ts ? PS.Assets.tilesetCanvas(ts) : null;
    if (prefs().guide) {
      if (!guideCache) guideCache = PS.Tilegen.template('#ff396a');
      const pixels = art ? art.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, res, res).data : null;
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = 0.22;
      // Each tile keeps its guide until it is mostly painted.
      for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
        const mask = MASK_AT[row][col];
        if (!mask) continue;
        let painted = 0;
        if (pixels) {
          const step = Math.max(1, tileRes / 32);
          for (let y = 0; y < tileRes; y += step) for (let x = 0; x < tileRes; x += step) {
            if (pixels[((row * tileRes + y) * res + col * tileRes + x) * 4 + 3]) painted++;
          }
        }
        const shape = (mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1);
        if (painted >= shape * 256 * 0.5) continue;
        ctx.drawImage(guideCache, col * T, row * T, T, T, ox + px(col * tileRes), oy + px(row * tileRes), px(tileRes), px(tileRes));
      }
      ctx.globalAlpha = 1;
    }
    if (art) {
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(art, ox, oy, size, size);
      ctx.imageSmoothingEnabled = false;
    }

    // The Empty tile is never drawn on the map.
    const [ec, er] = ATLAS[0];
    const ex = ox + ec * tile, ey = oy + er * tile;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ex, ey, tile, tile);
    ctx.clip();
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = -tile; k < tile; k += 12) {
      ctx.moveTo(ex + k, ey + tile);
      ctx.lineTo(ex + k + tile, ey);
    }
    ctx.stroke();
    ctx.restore();

    if (scale >= 6) {
      const first = (from) => Math.max(0, Math.floor(-from / scale));
      ctx.beginPath();
      for (let k = first(ox); k <= res && ox + k * scale <= W; k++) {
        if (k % tileRes === 0) continue;
        ctx.moveTo(ox + Math.round(k * scale) + 0.5, Math.max(0, oy)); ctx.lineTo(ox + Math.round(k * scale) + 0.5, Math.min(H, oy + size));
      }
      for (let k = first(oy); k <= res && oy + k * scale <= H; k++) {
        if (k % tileRes === 0) continue;
        ctx.moveTo(Math.max(0, ox), oy + Math.round(k * scale) + 0.5); ctx.lineTo(Math.min(W, ox + size), oy + Math.round(k * scale) + 0.5);
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(128,128,128,0.13)';
      ctx.stroke();
    }
    ctx.beginPath();
    for (let k = 0; k <= 4; k++) {
      const lineAt = Math.min(Math.round(k * tile), size - 1) + 0.5;
      ctx.moveTo(ox + lineAt, oy); ctx.lineTo(ox + lineAt, oy + size);
      ctx.moveTo(ox, oy + lineAt); ctx.lineTo(ox + size, oy + lineAt);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(128,128,128,0.6)';
    ctx.stroke();

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#8b7bff';
    ctx.strokeRect(ox + selectedTile.col * tile + 1, oy + selectedTile.row * tile + 1, tile - 2, tile - 2);
    const trail = PS.Paint.healTrail();
    if (trail && trail.kind === 'sheet') {
      const half = Math.floor((trail.size - 1) / 2), bw = trail.size * scale;
      ctx.fillStyle = 'rgba(139, 123, 255, 0.38)';
      ctx.beginPath();
      for (const p of trail.points) ctx.rect(ox + (p.x - half) * scale, oy + (p.y - half) * scale, bw, bw);
      ctx.fill();
    }
    if (hoverTile && sheetPointer) {
      const bs = prefs().size;
      const off = Math.floor((bs - 1) / 2);
      const bx = ox + (sheetPointer.x - off) * scale, by = oy + (sheetPointer.y - off) * scale, bw = Math.max(1, bs * scale);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeRect(bx - 0.5, by - 0.5, bw + 1, bw + 1);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bw - 1);
    }
  }

  /** The sample fills its box in fullscreen painting, and stays small next to the level. */
  function drawSample() {
    const canvas = $('#sheetSample');
    const box = $('#sheetSampleBox');
    const cols = SAMPLE[0].length, rows = SAMPLE.length;
    const full = document.body.classList.contains('paint-full');
    const roomW = box.clientWidth || 288;
    const cssW = Math.floor(full ? Math.min(roomW, ((box.clientHeight - 24) * cols) / rows) : Math.min(roomW, 288));
    if (cssW <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(cssW * dpr), H = Math.round((cssW * rows * dpr) / cols);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    canvas.style.width = cssW + 'px';
    canvas.style.height = Math.round((cssW * rows) / cols) + 'px';
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    const ts = activeTileset();
    if (!ts) return;
    const scale = W / (cols * T);
    const get = (x, y) => (SAMPLE[y] && SAMPLE[y][x] === '#' ? ts.id : 0);
    for (let dy = 0; dy <= rows; dy++) for (let dx = 0; dx <= cols; dx++) {
      const px = Math.round((dx - 0.5) * T * scale), py = Math.round((dy - 0.5) * T * scale);
      const qx = Math.round((dx + 0.5) * T * scale), qy = Math.round((dy + 0.5) * T * scale);
      PS.Autotile.drawDisplay(ctx, get, dx, dy, px, py, qx - px, qy - py);
    }
  }

  function requestDraw() {
    if (raf || st.workspace !== 'paint') return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (st.workspace !== 'paint') return;
      drawSheet();
      drawSample();
    });
  }

  /** The sheet pixel under the pointer. `inside` is false when it is off the sheet. */
  function sheetPoint(e) {
    const r = $('#sheetPaint').getBoundingClientRect();
    const res = activeRes();
    const x = Math.floor((e.clientX - r.left - view.x) / view.zoom);
    const y = Math.floor((e.clientY - r.top - view.y) / view.zoom);
    return { x: PS.util.clamp(x, 0, res - 1), y: PS.util.clamp(y, 0, res - 1), inside: x >= 0 && y >= 0 && x < res && y < res };
  }

  function updateCaption() {
    const cap = $('#sheetCaption');
    const t = hoverTile || selectedTile;
    const mask = MASK_AT[t.row][t.col];
    cap.textContent = mask === 0
      ? 'Empty tile: never drawn on the map.'
      : `${NAMES[mask]}${hoverTile ? '' : ' (selected)'}`;
  }

  function initSheet() {
    const canvas = $('#sheetPaint');
    const host = $('#sheetHost');
    let down = false;
    let panFrom = null;
    const spaceHeld = () => $('#stage').classList.contains('tool-pan');

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && spaceHeld())) {
        e.preventDefault();
        panFrom = { x: e.clientX, y: e.clientY };
        host.classList.add('panning');
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== 0 && e.button !== 2) return;
      const ts = activeTileset();
      if (!ts) return;
      const pt = sheetPoint(e);
      if (!pt.inside) return;
      const tile = activeRes() / 4;
      sheetPointer = pt;
      selectedTile = { col: Math.floor(pt.x / tile), row: Math.floor(pt.y / tile) };
      hoverTile = selectedTile;
      updateCaption();
      renderTileActions();
      canvas.setPointerCapture(e.pointerId);
      down = PS.Paint.sheetDown(ts, pt.x, pt.y, e);
      requestDraw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (panFrom) {
        view.fit = false;
        view.x += e.clientX - panFrom.x;
        view.y += e.clientY - panFrom.y;
        panFrom = { x: e.clientX, y: e.clientY };
        clampView();
        requestDraw();
        return;
      }
      host.classList.toggle('can-pan', spaceHeld());
      const pt = sheetPoint(e);
      const tile = activeRes() / 4;
      sheetPointer = pt.inside ? pt : null;
      hoverTile = pt.inside ? { col: Math.floor(pt.x / tile), row: Math.floor(pt.y / tile) } : null;
      updateCaption();
      const ts = activeTileset();
      if (down && ts && pt.inside) PS.Paint.sheetMove(ts, pt.x, pt.y);
      requestDraw();
    });
    const end = () => {
      if (panFrom) {
        panFrom = null;
        host.classList.remove('panning');
        return;
      }
      if (!down) return;
      down = false;
      PS.Paint.up();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      if (down) return;
      hoverTile = null;
      sheetPointer = null;
      updateCaption();
      requestDraw();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomStep(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    new ResizeObserver(requestDraw).observe(host);
    new ResizeObserver(requestDraw).observe($('#sheetSampleBox'));
    $('#sheetZoomIn').addEventListener('click', () => zoomStep(1));
    $('#sheetZoomOut').addEventListener('click', () => zoomStep(-1));
    $('#sheetZoomLabel').addEventListener('click', setFit);
  }

  function renderTileActions() {
    const box = $('#tileActions');
    const ts = activeTileset();
    const { col, row } = selectedTile;
    const locked = MASK_AT[row][col] === 0;
    const act = (icon, label, tip, fn, disabled) => el('button', {
      class: 'btn sm', 'data-tip': tip, disabled: disabled || locked || !ts, onclick: fn,
    }, el('span', { html: PS.icon(icon, 13) }), label);
    box.replaceChildren(
      act('copy', 'Copy', 'Copy the selected tile', () => { tileClipboard = PS.Paint.copyTile(ts, col, row); UI().toast('Tile copied', 'success', { duration: 1200 }); }),
      act('dup', 'Paste', 'Paste the copied tile over the selected one', () => PS.Paint.pasteTile(ts, col, row, tileClipboard), !tileClipboard),
      act('flipH', 'Flip', 'Flip the selected tile left to right', () => PS.Paint.transformTile(ts, col, row, 'Flip tile', (x, y, t) => [t - 1 - x, y])),
      act('flipV', 'Flip', 'Flip the selected tile top to bottom', () => PS.Paint.transformTile(ts, col, row, 'Flip tile', (x, y, t) => [x, t - 1 - y])),
      act('trash', 'Clear', 'Erase the selected tile', () => PS.Paint.transformTile(ts, col, row, 'Clear tile', () => [0, 0, true])));
  }

  function renderStrip() {
    const strip = $('#sheetStrip');
    const list = st.project.tilesets;
    strip.replaceChildren(
      ...list.map((ts) => el('button', {
        class: 'sheet-chip' + (ts.id === st.activeTilesetId ? ' on' : ''), 'data-tip': `Paint “${ts.name}”`, 'aria-label': ts.name,
        onclick: () => { st.activeTilesetId = ts.id; Panel.render(); },
      }, el('img', { class: 'checker-bg' + (PS.Assets.isHires(ts) ? ' hires' : ''), src: ts.src, alt: '', draggable: false }), el('span', { text: ts.name }))),
      el('button', { class: 'sheet-chip add', 'data-tip': 'Create a new tileset', 'aria-label': 'New tileset', onclick: () => Panel.openNewTileset(), html: PS.icon('plus', 16) }));
  }

  /* ------------------------------ Side panel ------------------------------ */
  function drawBrushPreview(canvas, key) {
    const box = canvas.width;
    const thumb = !!key && PS.Brushes.isCustom(key);   // a custom brush's card shows its whole shape
    const size = thumb ? box : key ? 7 : Math.min(prefs().size, box);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, box, box);
    ctx.imageSmoothingEnabled = false;
    const brush = key || prefs().brush;
    const fade = thumb || (!key && prefs().fade);
    const hardness = thumb ? 0 : key ? (key === 'spray' ? 40 : 100) : prefs().hardness;
    const cell = Math.max(1, Math.floor(box / Math.max(size, 8)));
    const off = Math.floor((box - size * cell) / 2);
    ctx.fillStyle = st.paintColor;
    const pixels = PS.Paint.previewPixels(size, hardness, brush === 'heal' ? 'round' : brush, fade);
    if (brush === 'heal') {
      // Two colours meeting with a fade between them.
      const a = Pal.toRgb(st.paintColor), b = Pal.toRgb(Pal.step(st.paintColor, -1));
      for (const [x, y] of pixels) {
        const k = PS.util.clamp((x + 0.5) / size, 0, 1);
        ctx.fillStyle = `rgb(${a[0] + (b[0] - a[0]) * k},${a[1] + (b[1] - a[1]) * k},${a[2] + (b[2] - a[2]) * k})`;
        ctx.fillRect(off + x * cell, off + y * cell, cell, cell);
      }
      return;
    }
    for (const [x, y, a] of pixels) {
      if (brush === 'spray' && PS.util.hash2(x * 3 + 1, y * 5 + 2) > 0.45) continue;
      ctx.globalAlpha = a;
      ctx.fillRect(off + x * cell, off + y * cell, cell, cell);
    }
    ctx.globalAlpha = 1;
    if (brush === 'lighter' || brush === 'darker') {
      ctx.fillStyle = Pal.toHex(...Pal.tone(Pal.toRgb(st.paintColor), brush === 'lighter' ? 1 : -1));
      for (const [x, y] of pixels) {
        if (brush === 'lighter' ? y < size / 2 : y >= size / 2) ctx.fillRect(off + x * cell, off + y * cell, cell, cell);
      }
    }
    if (brush === 'texture') {
      for (const [x, y] of pixels) {
        const n = PS.util.hash2(x + 9, y + 4);
        if (n > 0.55) continue;
        ctx.fillStyle = Pal.step(st.paintColor, n < 0.27 ? 1 : -1);
        ctx.fillRect(off + x * cell, off + y * cell, cell, cell);
      }
    }
  }

  /** Spacing, scatter, the random amounts and the actions of the selected custom brush. */
  function customBrushControls(brush) {
    const pr = prefs();
    const slider = (label, key, tip, { min = 0, max = 100, step = 5, format = (v) => `${v}%` } = {}) => {
      const field = UI().rangeField(label, {
        min, max, step, value: pr[key], format,
        oninput: (v) => { pr[key] = v; },
        onchange: (v) => PS.Paint.setDynamic(key, v),
      });
      field.setAttribute('data-tip', tip);
      return field;
    };
    return el('div', { class: 'stack custom-brush' },
      el('div', { class: 'paint-group-head' },
        el('h5', { text: brush.name }),
        el('div', { class: 'custom-brush-actions' },
          el('button', {
            class: 'btn sm', type: 'button', 'data-tip': 'Swap which part of the image paints',
            onclick: () => PS.Paint.invertBrush(brush),
          }, 'Invert'),
          el('button', {
            class: 'icon-btn danger', type: 'button', 'data-tip': 'Remove this brush', 'aria-label': 'Remove this brush', html: PS.icon('trash', 15),
            onclick: () => PS.Paint.removeBrush(brush),
          }))),
      slider('Spacing', 'spacing', 'The gap between stamps, as a share of the brush size', { min: 5, max: 300 }),
      slider('Scatter', 'scatter', 'How far a stamp can land from the pointer, as a share of the brush size', { max: 300 }),
      slider('Random size', 'sizeJitter', 'How much smaller a stamp can be than the brush size', { }),
      slider('Random rotation', 'angleJitter', 'How far a stamp can turn, either way', { max: 180, format: (v) => `±${v}°` }),
      slider('Random hue', 'hueJitter', 'How far a stamp’s colour can move around the colour wheel, either way', { max: 180, format: (v) => `±${v}°` }),
      slider('Random brightness', 'lightJitter', 'How much lighter or darker a stamp can be', { format: (v) => `±${v}%` }));
  }

  function renderSide() {
    const side = $('#paintSide');
    const pr = prefs();
    const pal = Pal.active();
    const customBrush = PS.Brushes.get(pr.brush);
    const customActive = !!customBrush && pr.tool === 'brush';
    const toolBtn = (key, icon, label, tip) => el('button', {
      class: 'paint-tool' + (pr.tool === key ? ' on' : ''), type: 'button', 'data-tip': tip, 'aria-pressed': pr.tool === key ? 'true' : 'false',
      onclick: () => PS.Paint.setTool(key),
    }, el('span', { html: PS.icon(icon, 18) }), el('span', { text: label }));

    const sizePreview = el('canvas', { class: 'brush-preview checker-bg', width: 48, height: 48 });
    const options = Pal.list().map((x) => ({ value: x.key, label: `${x.name} (${x.colors.length})` }));

    const body = el('div', { class: 'stack' },
      el('section', { class: 'paint-group' },
        el('div', { class: 'paint-tools' },
          toolBtn('brush', 'brush', 'Brush', 'Brush (B): paint with the chosen colour. Right-click erases.'),
          toolBtn('eraser', 'eraser', 'Eraser', 'Eraser (E): clear pixels.'),
          toolBtn('fill', 'fill', 'Fill', 'Fill (G): fill a connected colour area inside one tile.'),
          toolBtn('picker', 'eyedropper', 'Pick', 'Pick colour (I): click a pixel to use its colour. Holding Alt does the same.'))),

      el('section', { class: 'paint-group' },
        el('h5', { text: 'Brush' }),
        el('div', { class: 'brush-grid' }, [
          ...PS.Paint.BRUSHES,
          ...PS.Brushes.list().map((b) => ({ key: PS.Brushes.keyOf(b), name: b.name, tip: `${b.name}: your custom brush` })),
        ].map((b) => {
          const c = el('canvas', { width: 28, height: 28 });
          drawBrushPreview(c, b.key);
          return el('button', {
            class: 'brush-card' + (pr.brush === b.key && pr.tool === 'brush' ? ' on' : ''), type: 'button', 'data-tip': b.tip,
            onclick: () => PS.Paint.setBrush(b.key),
          }, c, el('span', { text: b.name }));
        }).concat(el('button', {
          class: 'brush-card add', type: 'button', 'data-tip': 'Upload a black and white image of any shape to use as a brush',
          onclick: () => { const input = $('#fileBrush'); input.value = ''; input.click(); },
        }, el('span', { class: 'brush-add-icon', html: PS.icon('upload', 18) }), el('span', { text: 'Upload' })))),
        el('div', { class: 'brush-sliders' },
          el('div', { class: 'stack', style: 'flex:1;min-width:0;gap:6px' },
            UI().rangeField('Size', {
              min: 1, max: PS.Paint.maxSize(activeRes()), value: pr.size, format: (v) => `${v} px`,
              oninput: (v) => { pr.size = v; drawBrushPreview(sizePreview); PS.Renderer.request(); requestDraw(); },
              onchange: (v) => PS.Paint.setSize(v),
            }),
            UI().rangeField('Hardness', {
              min: 0, max: 100, step: 5, value: pr.hardness, format: (v) => `${v}%`,
              oninput: (v) => { pr.hardness = v; drawBrushPreview(sizePreview); },
              onchange: (v) => PS.Paint.setHardness(v),
            })),
          sizePreview),
        el('div', { class: 'field' }, el('span', { text: 'Soft edges' }),
          UI().segmented([
            { value: false, label: 'Dither', tip: 'Fade the edge with a pixel pattern. Every pixel stays a palette colour.' },
            { value: true, label: 'Fade', tip: 'Fade the edge with real transparency, like a soft airbrush.' },
          ], !!pr.fade, (v) => PS.Paint.setFade(v))),
        customActive ? customBrushControls(customBrush) : null,
        el('p', { class: 'hint', text: customActive
          ? `The shape is resized so its longest side matches Size. Hardness 100% keeps it crisp; lower keeps the image’s greys. ${pr.fade ? 'Random hue and brightness use any colour in Fade.' : 'In Dither, random hue and brightness pick the nearest palette colour, so a small palette may show little change.'}`
          : pr.brush === 'heal' && pr.tool === 'brush'
          ? `Paint over a seam, on the sheet or on a platform, and release to rebuild that area. Cover the whole seam. Empty pixels you cover get filled in. ${pr.fade ? 'Fade gives the cleanest result, using in-between colours.' : 'Dither keeps to your palette; choose Fade for the cleanest result.'} Hardness doesn’t affect this brush.`
          : (pr.brush === 'lighter' || pr.brush === 'darker') && pr.tool === 'brush'
          ? 'Shades the art’s own colours, so its hue stays the same. The new shades may not be in your palette.'
          : pr.fade
          ? 'Fade blends into in-between colours, so soft areas are no longer limited to your palette.'
          : 'Low hardness fades the edge with a pattern, so only palette colours are used.' })),

      el('section', { class: 'paint-group' },
        el('div', { class: 'paint-group-head' },
          el('h5', { text: 'Colour palette' }),
          el('button', { class: 'btn sm', 'data-tip': 'Add a palette from Lospec, a file or an image', onclick: () => Panel.openPaletteDialog() }, el('span', { html: PS.icon('plus', 13) }), 'Add')),
        el('div', { class: 'palette-row' },
          UI().selectField('', options, pal.key, (v) => Panel.changePalette(v)),
          pal.key.startsWith('b:') ? null : el('button', {
            class: 'icon-btn danger', 'data-tip': 'Remove this palette', 'aria-label': 'Remove this palette', html: PS.icon('trash', 15),
            onclick: () => Pal.remove(pal.key),
          })),
        el('div', { class: 'swatches', role: 'listbox', 'aria-label': 'Palette colours' }, pal.colors.map((c) => el('button', {
          class: 'swatch' + (c === st.paintColor ? ' on' : ''), type: 'button', style: `background:${c}`,
          'data-tip': c, 'aria-label': `Colour ${c}`, 'aria-selected': c === st.paintColor ? 'true' : 'false',
          onclick: () => PS.Paint.setColor(c),
        }))),
        el('button', {
          class: 'btn sm block', 'data-tip': 'Change every pixel of this tileset to its nearest colour in this palette',
          onclick: () => Panel.matchPalette([activeTileset()].filter(Boolean)),
        }, el('span', { html: PS.icon('palette', 14) }), 'Match this tileset to palette')));

    side.replaceChildren(el('div', { class: 'sidebar-scroll paint-scroll' }, body));
    drawBrushPreview(sizePreview);
    PS.hydrateIcons(side);
  }

  /* ------------------------------ New tileset dialog ------------------------------ */
  function openNewTileset(target) {
    const dlg = $('#tilesetDialog');
    const colors = Pal.active().colors;
    const startStyle = 'grass';
    const state = {
      style: startStyle, role: 'top', name: target ? target.name : '',
      res: target ? PS.Paint.sheetSize(target) : PS.Autotile.SHEET,
      ...PS.Tilegen.suggest(startStyle, colors),
    };
    const preview = el('canvas', { class: 'wizard-sample checker-bg', width: 288, height: 224 });
    const sheet = el('canvas', { class: 'wizard-sheet checker-bg', width: 128, height: 128 });

    // The previews stay at the standard size, so changing a colour is instant at any resolution.
    const makeArt = (res = PS.Autotile.SHEET) => (state.style === 'blank' ? PS.Tilegen.blank(res) : PS.Tilegen.generate(state.style, state.top, state.body, colors, res));

    const resNote = el('p', { class: 'hint' });
    const updateResNote = () => {
      const t = state.res / 4;
      resNote.textContent = state.res === PS.Autotile.SHEET
        ? `Each tile is ${t} × ${t} pixels: classic pixel art.`
        : `Each tile is ${t} × ${t} pixels, shown in the same space on the map. Zoom in to see and paint the detail. Larger sheets use more memory and make bigger project files.`;
    };
    const resPicker = UI().segmented(PS.Autotile.RESOLUTIONS.map((r) => ({ value: r, label: String(r), tip: `${r} × ${r} sheet, ${r / 4} pixels per tile` })), state.res, (v) => { state.res = v; updateResNote(); });
    updateResNote();

    const redraw = () => {
      const art = makeArt();
      const sctx = sheet.getContext('2d');
      sctx.clearRect(0, 0, 128, 128);
      sctx.drawImage(art, 0, 0);
      const ctx = preview.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, preview.width, preview.height);
      const tiny = PS.Autotile;
      for (let dy = 0; dy <= SAMPLE.length; dy++) for (let dx = 0; dx <= SAMPLE[0].length; dx++) {
        const corner = (x, y) => (SAMPLE[y] && SAMPLE[y][x] === '#' ? 1 : 0);
        const a = corner(dx - 1, dy - 1), b = corner(dx, dy - 1), c = corner(dx - 1, dy), d = corner(dx, dy);
        const mask = a | (b << 1) | (c << 2) | (d << 3);
        if (!mask) continue;
        const [col, row] = tiny.ATLAS[mask];
        ctx.drawImage(art, col * T, row * T, T, T, (dx - 0.5) * T, (dy - 0.5) * T, T, T);
      }
    };

    const chooser = el('div');
    // Styles with no separate top surface only need one colour.
    const roles = () => (state.style === 'smooth' || state.style === 'meadow'
      ? [['body', 'Main colour']]
      : [['top', 'Top colour'], ['body', 'Main colour']]);
    const renderChooser = () => {
      const blank = state.style === 'blank';
      if (!roles().some(([key]) => key === state.role)) state.role = 'body';
      chooser.replaceChildren(
        blank ? el('div', { class: 'stack', style: 'gap:8px' },
          el('p', { class: 'hint', text: 'You get an empty template with a faint guide on every tile. Paint them however you like.' }),
          el('button', {
            class: 'btn sm', type: 'button', 'data-tip': 'A 128 × 128 PNG of the 16 tile shapes, if you ever want to draw in another app',
            onclick: () => PS.Tilegen.template().toBlob((blob) => { if (blob) PS.util.downloadBlob(blob, 'dual-grid-template.png'); }, 'image/png'),
          }, el('span', { html: PS.icon('download', 14) }), 'Download the template')) : el('div', { class: 'stack', style: 'gap:8px' },
          el('div', { class: 'role-row' }, roles().map(([key, label]) => el('button', {
            class: 'role-chip' + (state.role === key ? ' on' : ''), type: 'button',
            onclick: () => { state.role = key; renderChooser(); },
          }, el('i', { style: `background:${state[key]}` }), label))),
          el('div', { class: 'swatches compact' }, colors.map((c) => el('button', {
            class: 'swatch' + (state[state.role] === c ? ' on' : ''), type: 'button', style: `background:${c}`, 'aria-label': `Colour ${c}`,
            onclick: () => { state[state.role] = c; renderChooser(); redraw(); },
          }))),
          el('p', { class: 'hint', text: `Using the ${Pal.active().name} palette. Lighter and darker shades are picked for you.` })));
    };

    const styleCards = [...Object.entries(PS.Tilegen.STYLES), ['blank', { name: 'Blank' }]].map(([key, def]) => {
      const c = el('canvas', { width: 96, height: 64 });
      const ctx = c.getContext('2d');
      if (key !== 'blank') {
        const sug = PS.Tilegen.suggest(key, colors);
        const art = PS.Tilegen.generate(key, sug.top, sug.body, colors);
        for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 4; dx++) {
          const f = (x, y) => (y >= 1 && y <= 2 && x >= 1 && x <= 2 ? 1 : 0);
          const mask = f(dx - 1, dy - 1) | (f(dx, dy - 1) << 1) | (f(dx - 1, dy) << 2) | (f(dx, dy) << 3);
          if (!mask) continue;
          const [col, row] = ATLAS[mask];
          ctx.drawImage(art, col * T, row * T, T, T, (dx - 0.5) * 32, (dy - 0.5) * 32 - 8, 32, 32);
        }
      } else {
        ctx.drawImage(PS.Tilegen.template('#ff396a'), 0, 0, 128, 128, 16, 0, 64, 64);
      }
      const btn = el('button', {
        class: 'style-card' + (key === state.style ? ' on' : ''), type: 'button',
        onclick: () => {
          state.style = key;
          if (key !== 'blank') Object.assign(state, PS.Tilegen.suggest(key, colors));
          state.role = 'top';
          for (const b of btn.parentElement.children) b.classList.remove('on');
          btn.classList.add('on');
          renderChooser();
          redraw();
        },
      }, c, el('span', { text: def.name }));
      return btn;
    });

    const nameInput = el('input', { value: state.name, maxlength: 30, placeholder: 'For example: Mossy rock', 'aria-label': 'Tileset name', oninput: (e) => { state.name = e.target.value; } });

    dlg.replaceChildren(
      el('div', { class: 'sprite-head' },
        el('h3', { text: target ? `Restart “${target.name}”` : 'Create a tileset' }),
        el('button', { class: 'icon-btn', 'data-tip': 'Close', 'aria-label': 'Close', html: PS.icon('x', 18), onclick: () => dlg.close() })),
      el('div', { class: 'wizard' },
        el('div', { class: 'wizard-main' },
          el('h5', { text: '1. Start from' }),
          el('div', { class: 'style-grid' }, styleCards),
          el('h5', { text: '2. Colours' }),
          chooser,
          el('h5', { text: '3. Resolution' }),
          resPicker, resNote,
          target ? null : el('h5', { text: '4. Name' }),
          target ? null : nameInput),
        el('div', { class: 'wizard-side' },
          el('h5', { text: 'How it connects' }), preview,
          el('h5', { text: 'The 16 tiles' }), sheet)),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
        el('button', {
          class: 'btn primary',
          onclick: () => {
            const art = makeArt(state.res);
            dlg.close();
            if (target) {
              PS.Paint.replaceArt(target, art, 'Restart tileset');
              Panel.render();
              return;
            }
            createTileset(PS.util.cleanName(state.name, state.style === 'blank' ? 'My tileset' : PS.Tilegen.STYLES[state.style].name, 30), art);
          },
        }, target ? 'Replace art' : 'Create and paint')));
    renderChooser();
    redraw();
    UI().hideTip();
    dlg.showModal();
    if (!target) nameInput.focus();
  }

  function createTileset(name, art) {
    const ts = { id: 0, name, src: art.toDataURL('image/png'), canvas: art, version: 1 };
    PS.History.change(`Create tileset “${name}”`, () => {
      ts.id = PS.Project.newId();
      st.project.tilesets.push(ts);
    });
    st.activeTilesetId = ts.id;
    PS.App.setWorkspace('paint');
    PS.AssetsPanel.render();
    UI().toast(`“${name}” is ready. Paint on the sheet, or on a platform in the level.`, 'success', { duration: 4000 });
  }

  /* ------------------------------ Add palette dialog ------------------------------ */
  function openPaletteDialog() {
    const dlg = $('#paletteDialog');
    let found = null;
    const preview = el('div', { class: 'swatches compact palette-preview' });
    const message = el('p', { class: 'hint' });
    const nameInput = el('input', { maxlength: 40, placeholder: 'Palette name', 'aria-label': 'Palette name', disabled: true });
    const addBtn = el('button', { class: 'btn primary', text: 'Add palette', disabled: true });
    const textInput = el('textarea', {
      rows: 3, spellcheck: 'false', 'aria-label': 'Lospec link or colour list',
      placeholder: 'https://lospec.com/palette-list/sweetie-16\nor colours like: #1a1c2c #5d275d #b13e53',
    });

    const show = (res) => {
      if (!res.ok) {
        found = null;
        message.textContent = res.error;
        message.classList.add('warn');
        preview.replaceChildren();
        nameInput.disabled = true;
        addBtn.disabled = true;
        return;
      }
      found = res;
      message.classList.remove('warn');
      message.textContent = `Found ${PS.util.plural(res.colors.length, 'colour')}.`;
      preview.replaceChildren(...res.colors.map((c) => el('span', { class: 'swatch', style: `background:${c}`, 'data-tip': c })));
      nameInput.disabled = false;
      nameInput.value = res.name || '';
      addBtn.disabled = false;
    };

    const readInput = async () => {
      message.classList.remove('warn');
      message.textContent = 'Reading…';
      show(await Pal.fromInput(textInput.value));
    };
    const readFile = async (file) => { if (file) show(await Pal.fromFile(file)); };

    const fileInput = $('#filePalette');
    fileInput.onchange = () => readFile(fileInput.files[0]);

    const drop = el('div', { class: 'palette-drop' },
      el('span', { html: PS.icon('upload', 18) }),
      el('span', { text: 'Drop a palette file or image here' }),
      el('button', { class: 'btn sm', type: 'button', text: 'Choose a file', onclick: () => { fileInput.value = ''; fileInput.click(); } }),
      el('small', { text: '.hex  .pal  .gpl  .txt  .ase  or any image' }));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('over');
      readFile(e.dataTransfer.files[0]);
    });

    addBtn.addEventListener('click', () => {
      if (!found) return;
      const pal = Pal.add(nameInput.value || found.name, found.colors);
      dlg.close();
      paletteAdopted(pal);
    });

    dlg.replaceChildren(
      el('div', { class: 'sprite-head' },
        el('h3', { text: 'Add a colour palette' }),
        el('button', { class: 'icon-btn', 'data-tip': 'Close', 'aria-label': 'Close', html: PS.icon('x', 18), onclick: () => dlg.close() })),
      el('p', { class: 'help-text' }, 'Pick any palette on ',
        el('a', { href: 'https://lospec.com/palette-list', target: '_blank', rel: 'noopener', text: 'lospec.com/palette-list' }),
        ', then paste its link here, or download it and upload the file.'),
      el('div', { class: 'stack', style: 'margin-top:12px' },
        el('label', { class: 'field' }, el('span', { text: 'Paste a link or colours' }), textInput),
        el('button', { class: 'btn sm', type: 'button', text: 'Get colours', onclick: readInput }),
        drop, message, preview,
        el('label', { class: 'field' }, el('span', { text: 'Name' }), nameInput)),
      el('div', { class: 'actions' }, el('button', { class: 'btn', text: 'Cancel', onclick: () => dlg.close() }), addBtn));
    UI().hideTip();
    dlg.showModal();
    textInput.focus();
  }

  function paletteAdopted(pal) {
    const list = st.project.tilesets;
    UI().toast(`Now painting with “${pal.name}”.`, 'success', {
      duration: 6000,
      action: list.length ? { label: 'Match tilesets', fn: () => Panel.matchPalette(list) } : null,
    });
  }

  const Panel = {
    SAMPLE,

    init() {
      initSheet();
      $('#sheetRestart').addEventListener('click', () => { const ts = activeTileset(); if (ts) openNewTileset(ts); });
      $('#sheetGuide').addEventListener('click', () => {
        prefs().guide = !prefs().guide;
        PS.savePrefs();
        Panel.renderDockButtons();
        requestDraw();
      });
      $('#sheetInside').addEventListener('click', () => {
        prefs().inside = !prefs().inside;
        PS.savePrefs();
        Panel.renderDockButtons();
      });
      $('#sheetDownload').addEventListener('click', () => {
        const ts = activeTileset();
        const canvas = ts ? PS.Assets.tilesetCanvas(ts) : null;
        if (!canvas) return;
        canvas.toBlob((blob) => { if (blob) PS.util.downloadBlob(blob, PS.util.safeFileName(ts.name) + '.png'); }, 'image/png');
      });
      $('#sheetDone').addEventListener('click', () => PS.App.setWorkspace('build'));
      $('#sheetFull').addEventListener('click', () => Panel.toggleFull());
      $('#fileBrush').addEventListener('change', (e) => PS.Paint.addBrushes([...e.target.files]));
      PS.bus.on('art', requestDraw);
      PS.bus.on('art-done', () => { renderStrip(); PS.AssetsPanel.renderTilesets(); });
      PS.bus.on('paint-ui', () => { if (st.workspace === 'paint') renderSide(); requestDraw(); });
      PS.bus.on('palette', () => { if (st.workspace === 'paint') renderSide(); PS.Renderer.request(); });
      PS.bus.on('assets-ready', () => { if (st.workspace === 'paint') Panel.render(); });
    },

    renderDockButtons() {
      $('#sheetGuide').classList.toggle('on', !!prefs().guide);
      $('#sheetInside').classList.toggle('on', !!prefs().inside);
      $('#sheetFull').classList.toggle('on', !!st.prefs.paintFull);
    },

    /** Fullscreen painting: the level steps aside and the live sample grows. */
    toggleFull() {
      st.prefs.paintFull = !st.prefs.paintFull;
      PS.savePrefs();
      document.body.classList.toggle('paint-full', st.prefs.paintFull);
      Panel.renderDockButtons();
      view.fit = true;
      requestDraw();
    },

    get isFull() { return st.workspace === 'paint' && !!st.prefs.paintFull; },

    zoomSheet(dir) { if (dir) zoomStep(dir); else setFit(); },

    /** Where a sheet pixel is on screen, for tools and tests. */
    sheetToClient(x, y) {
      const r = $('#sheetPaint').getBoundingClientRect();
      return { x: r.left + view.x + (x + 0.5) * view.zoom, y: r.top + view.y + (y + 0.5) * view.zoom };
    },

    render() {
      if (st.workspace !== 'paint') return;
      if (!activeTileset() && st.project.tilesets.length) st.activeTilesetId = st.project.tilesets[0].id;
      // A brush keeps its size on the art when moving to a sheet of another resolution.
      const res = activeRes();
      if (res !== lastRes) {
        if (lastRes) prefs().size = PS.util.clamp(Math.round((prefs().size * res) / lastRes), 1, PS.Paint.maxSize(res));
        lastRes = res;
        view.fit = true;
      }
      const pal = Pal.active();
      if (!pal.colors.includes(st.paintColor)) st.paintColor = Pal.nearest(Pal.toRgb(st.paintColor), pal.colors);
      renderSide();
      renderStrip();
      renderTileActions();
      updateCaption();
      Panel.renderDockButtons();
      requestDraw();
    },

    changePalette(key) {
      Pal.setActive(key);
      PS.App.documentChanged('meta');
      paletteAdopted(Pal.active());
    },

    matchPalette(list) {
      const n = PS.Paint.snapToPalette(list);
      if (n) {
        UI().toast(`${PS.util.plural(n, 'tileset')} recoloured to match “${Pal.active().name}”.`, 'success', { action: { label: 'Undo', fn: () => PS.History.undo() } });
      } else {
        UI().toast('Everything already uses this palette.', 'info');
      }
    },

    openNewTileset,
    openPaletteDialog,
  };

  PS.PaintPanel = Panel;
})(window.PS);
