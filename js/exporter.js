/* =====================================================================
   Platformer Studio — PNG image export
   Renders the level at native resolution (32 px per tile) and scales it
   up with nearest-neighbour sampling. Editor guides are never included.
   Follows the current view, so an iso level exports as an iso picture.
   ===================================================================== */
(function (PS) {
  'use strict';

  const T = PS.TILE;
  const { el } = PS.util;
  const MAX_SIDE = 16384, MAX_AREA = 120e6;

  let opts = null;

  function defaults() {
    const p = PS.state.project;
    const objLayer = PS.Project.objectsLayer();
    const objs = !objLayer || objLayer.visible;
    return {
      layers: new Set(p.layers.filter((l) => l.type === 'tiles' && l.visible).map((l) => l.id)),
      spawn: objs, enemies: objs, collectibles: objs, goal: objs,
      grid: false,
      transparent: p.level.transparentSky,
      scale: 1,
    };
  }

  /** Size of the picture at original scale. */
  function baseSize() {
    const p = PS.state.project;
    if (PS.Iso.active()) {
      const b = PS.Iso.bounds();
      return { w: b.w, h: b.h };
    }
    return { w: p.width * T, h: p.height * T };
  }

  const fits = (s) => {
    const base = baseSize();
    const w = base.w * s, h = base.h * s;
    return w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_AREA;
  };

  const Exporter = {
    render(o) {
      const p = PS.state.project, R = PS.Renderer;
      const { w: W, h: H } = baseSize();
      const s = o.scale;
      const out = PS.Sprites.canvas(W * s, H * s);
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      if (!o.transparent) {
        ctx.fillStyle = p.level.sky;
        ctx.fillRect(0, 0, W * s, H * s);
      }
      const want = { spawn: o.spawn, enemy: o.enemies, collectible: o.collectibles, goal: o.goal };
      if (PS.Iso.active()) {
        const b = PS.Iso.bounds();
        const wld = PS.Iso.world();
        PS.Iso.drawScene(ctx, {
          camX: b.x, camY: b.y, s, W: W * s, H: H * s, wld,
          entities: PS.Iso.objectEntities(wld, (obj) => want[obj.kind]),
          filter: (layer) => o.layers.has(layer.id),
        });
        if (o.grid) PS.Iso.drawGrid(ctx, { camX: b.x, camY: b.y, s }, 'rgba(0, 0, 0, 0.28)');
        return out;
      }
      const drawLayer = (c, layer, a) => {
        if (layer.type === 'tiles') R.drawTileLayer(c, layer, 0, 0, s, W * s, H * s, a);
        else R.drawObjectsStatic(c, 0, 0, s, (obj) => want[obj.kind], a);
      };
      // Layers left out of the picture catch no shadows.
      const shown = p.layers.filter((l) => (l.type === 'tiles' ? o.layers.has(l.id) : Object.values(want).some(Boolean)));
      shown.forEach((layer, i) => {
        R.drawWithShadow(ctx, layer, R.shadowCasters(shown, i), W * s, H * s, s, layer.opacity, drawLayer);
      });
      R.releaseScratch();
      if (o.grid) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
        for (let x = 1; x < p.width; x++) ctx.fillRect(x * T * s, 0, 1, H * s);
        for (let y = 1; y < p.height; y++) ctx.fillRect(0, y * T * s, W * s, 1);
      }
      return out;
    },

    download() {
      const p = PS.state.project;
      if (!fits(opts.scale)) return PS.UI.toast('That size is too large for the browser. Choose a smaller size.', 'warn');
      let canvas;
      try {
        canvas = Exporter.render(opts);
      } catch (e) {
        return PS.UI.toast('The image could not be created. Try a smaller size.', 'error');
      }
      canvas.toBlob((blob) => {
        if (!blob) return PS.UI.toast('The image could not be created. Try a smaller size.', 'error');
        const suffix = opts.scale > 1 ? `@${opts.scale}x` : '';
        PS.util.downloadBlob(blob, `${PS.util.safeFileName(p.name)}${suffix}.png`);
        PS.UI.toast(`Image downloaded (${canvas.width} × ${canvas.height} px)`, 'success');
      }, 'image/png');
    },

    /** Build and show the export popover next to the toolbar button. */
    open(anchor) {
      const pop = document.getElementById('exportPop');
      if (!pop.hidden) return PS.UI.closePopovers();
      opts = defaults();
      Exporter.build(pop);
      PS.UI.openPopover(pop, anchor);
    },

    build(pop) {
      const p = PS.state.project;
      const check = (label, checked, onchange, tip) => el('label', { class: 'check', 'data-tip': tip || null },
        el('input', { type: 'checkbox', checked, onchange: (e) => { onchange(e.target.checked); } }),
        el('span', { text: label }));

      const tileLayers = [...p.layers].reverse().filter((l) => l.type === 'tiles');
      const sizeLabel = el('div', { class: 'export-size' });
      const seg = el('div', { class: 'segmented' });
      const updateSize = () => {
        const s = opts.scale;
        const base = baseSize();
        sizeLabel.textContent = `Image size: ${base.w * s} × ${base.h * s} pixels`;
        for (const b of seg.children) b.classList.toggle('on', Number(b.dataset.scale) === s);
      };
      const hires = p.tilesets.some((t) => PS.Assets.isHires(t));
      for (const s of hires ? [1, 2, 4, 8] : [1, 2, 4]) {
        seg.append(el('button', {
          dataset: { scale: s }, text: s === 1 ? 'Original' : `${s}×`, disabled: !fits(s),
          'data-tip': fits(s) ? (s === 1 ? 'One image pixel per art pixel' : `Every pixel becomes a ${s} × ${s} block. Stays crisp.`) : 'Too large for this map',
          onclick: () => { opts.scale = s; updateSize(); },
        }));
      }

      pop.replaceChildren(
        el('h4', { text: 'Export image' }),
        el('p', { class: 'hint', text: 'Download your level as a PNG picture. Editor guides are never included.' }),
        el('div', { class: 'export-section' },
          el('h5', { text: 'Layers' }),
          el('div', { class: 'check-list' }, tileLayers.map((l) => check(l.name, opts.layers.has(l.id), (on) => { on ? opts.layers.add(l.id) : opts.layers.delete(l.id); })))),
        el('div', { class: 'export-section' },
          el('h5', { text: 'Game objects' }),
          el('div', { class: 'check-list' },
            check('Player start', opts.spawn, (on) => { opts.spawn = on; }),
            check('Enemies', opts.enemies, (on) => { opts.enemies = on; }),
            check('Collectibles', opts.collectibles, (on) => { opts.collectibles = on; }),
            check('Goal', opts.goal, (on) => { opts.goal = on; }))),
        el('div', { class: 'export-section' },
          el('h5', { text: 'Size' }), seg, sizeLabel,
          hires ? el('p', { class: 'hint', text: 'Your high-resolution tilesets keep their full detail at larger sizes.' }) : null),
        el('details', { class: 'adv export-section' },
          el('summary', null, el('span', { 'data-icon': 'chevron' }), 'More options'),
          el('div', { class: 'stack' },
            check('Grid lines', opts.grid, (on) => { opts.grid = on; }, 'Draw thin lines between tiles'),
            check('Transparent background', opts.transparent, (on) => { opts.transparent = on; }, 'Leave the sky see-through instead of filling it with the sky colour'))),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', onclick: () => { PS.UI.closePopovers(); PS.Storage.saveFile(); }, 'data-tip': 'Save the editable project (.json) with all images included' },
            el('span', { 'data-icon': 'save' }), 'Project file'),
          el('button', { class: 'btn primary', onclick: () => Exporter.download() }, el('span', { 'data-icon': 'download' }), 'Download PNG')),
      );
      updateSize();
      PS.hydrateIcons(pop);
    },
  };

  PS.Exporter = Exporter;
})(window.PS);
