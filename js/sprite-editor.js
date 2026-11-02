/* =====================================================================
   Platformer Studio — character animation setup (sprite sheets)
   A visual frame picker: choose an animation tab, click frames in the
   order they should play, watch the live preview. No code involved.
   ===================================================================== */
(function (PS) {
  'use strict';

  const { el, $ } = PS.util;
  const TABS = [
    { key: 'idle', name: 'Idle' },
    { key: 'walk', name: 'Walk' },
    { key: 'jump', name: 'Jump' },
    { key: 'fall', name: 'Fall' },
  ];

  let s = null;        // editing session
  let raf = 0;

  function frames() { return PS.Assets.sheetFrames(s.img, s.fw, s.fh); }

  function drawSheet() {
    const cv = $('#sheetCanvas');
    const img = s.img;
    const z = s.zoom;
    cv.width = Math.round(img.width * z);
    cv.height = Math.round(img.height * z);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const cell = 8;
    for (let y = 0; y < cv.height; y += cell) for (let x = 0; x < cv.width; x += cell) {
      ctx.fillStyle = ((x + y) / cell) % 2 ? '#3a3f4d' : '#2c303b';
      ctx.fillRect(x, y, cell, cell);
    }
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const list = s.anims[s.tab];
    const fs = frames();
    ctx.font = `700 ${Math.max(10, Math.round(11))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fs.forEach((f, i) => {
      const x = Math.round(f.x * z), y = Math.round(f.y * z), w = Math.round(f.w * z), h = Math.round(f.h * z);
      const usedElsewhere = TABS.some((t) => t.key !== s.tab && s.anims[t.key].includes(i));
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      if (usedElsewhere) {
        ctx.fillStyle = 'rgba(79,224,196,0.12)';
        ctx.fillRect(x, y, w, h);
      }
      const order = list.indexOf(i);
      if (order >= 0) {
        ctx.fillStyle = 'rgba(139,123,255,0.25)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#8b7bff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
        ctx.fillStyle = '#8b7bff';
        ctx.beginPath();
        ctx.arc(x + 10, y + 10, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(String(order + 1), x + 10, y + 10.5);
      }
    });
  }

  function renderTabs() {
    $('#animTabs').replaceChildren(...TABS.map((t) => el('button', {
      type: 'button', class: s.tab === t.key ? 'on' : '',
      onclick: () => { s.tab = t.key; renderAll(); },
    }, t.name + ' ', el('small', { text: `(${s.anims[t.key].length})` }))));
    const fallback = { idle: 'first frame', walk: 'idle frames', jump: 'fall or idle frames', fall: 'jump or idle frames' };
    $('#animSummary').replaceChildren(...TABS.map((t) => el('div', null,
      el('span', { text: t.name }),
      el('span', { text: s.anims[t.key].length ? PS.util.plural(s.anims[t.key].length, 'frame') : `uses ${fallback[t.key]}` }))));
    $('#spriteHint').textContent = `Click frames in the order the ${s.tab} animation should play. Click a chosen frame again to remove it.`;
  }

  function renderAll() {
    renderTabs();
    drawSheet();
  }

  function previewLoop(now) {
    raf = requestAnimationFrame(previewLoop);
    const cv = $('#spritePreview');
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 96, 96);
    const fs = frames();
    let list = s.anims[s.tab].filter((i) => i < fs.length);
    if (!list.length) list = s.anims.idle.filter((i) => i < fs.length);
    if (!list.length) list = [0];
    const f = fs[list[Math.floor((now / 1000) * s.fps) % list.length]];
    if (!f) return;
    let k = Math.min(32 / f.w, 32 / f.h);
    if (k >= 1) k = Math.floor(k);
    const dw = Math.max(1, Math.round(f.w * k)), dh = Math.max(1, Math.round(f.h * k));
    ctx.drawImage(s.img, f.x, f.y, f.w, f.h, Math.floor((32 - dw) / 2) * 3, (32 - dh) * 3, dw * 3, dh * 3);
  }

  function close() {
    cancelAnimationFrame(raf);
    raf = 0;
    const dlg = $('#spriteDialog');
    if (dlg.open) dlg.close();
    s = null;
  }

  function save() {
    const def = s.def;
    const max = frames().length;
    def.name = PS.util.cleanName($('#spriteName').value, def.name, 30);
    def.frameW = s.fw;
    def.frameH = s.fh;
    def.fps = s.fps;
    def.anims = {};
    for (const t of TABS) def.anims[t.key] = s.anims[t.key].filter((i) => i < max);
    PS.Assets.clearDerived(def);
    PS.App.documentChanged('meta');
    PS.AssetsPanel.renderCharacters();
    PS.App.refreshProps();
    PS.Renderer.request();
    close();
    PS.UI.toast(`“${def.name}” animation saved`, 'success');
  }

  async function remove() {
    const def = s.def;
    const ok = await PS.UI.confirm({ title: `Delete “${def.name}”?`, text: 'This removes the uploaded character. You can undo this.', ok: 'Delete', danger: true });
    if (!ok) return;
    close();
    const key = 'char:' + def.id;
    PS.History.change(`Delete character “${def.name}”`, () => {
      const p = PS.state.project;
      p.characters = p.characters.filter((c) => c !== def);
      if (p.character === key) p.character = 'ninja';
    });
    PS.AssetsPanel.renderCharacters();
    PS.App.refreshProps();
  }

  function setFrameSize() {
    const w = PS.util.int($('#spriteFW').value, s.fw, 1, s.img.width);
    const h = PS.util.int($('#spriteFH').value, s.fh, 1, s.img.height);
    $('#spriteFW').value = w;
    $('#spriteFH').value = h;
    if (w === s.fw && h === s.fh) return;
    s.fw = w;
    s.fh = h;
    const max = frames().length;
    for (const t of TABS) s.anims[t.key] = s.anims[t.key].filter((i) => i < max);
    renderAll();
  }

  const SpriteEditor = {
    init() {
      $('#sheetCanvas').addEventListener('click', (e) => {
        if (!s) return;
        const r = e.currentTarget.getBoundingClientRect();
        const x = (e.clientX - r.left) / s.zoom, y = (e.clientY - r.top) / s.zoom;
        const cols = Math.max(1, Math.floor(s.img.width / s.fw));
        const cx = Math.floor(x / s.fw), cy = Math.floor(y / s.fh);
        if (cx >= cols) return;
        const i = cy * cols + cx;
        if (i >= frames().length) return;
        const list = s.anims[s.tab];
        const at = list.indexOf(i);
        if (at >= 0) list.splice(at, 1); else if (list.length < 64) list.push(i);
        renderAll();
      });
      $('#spriteFW').addEventListener('change', setFrameSize);
      $('#spriteFH').addEventListener('change', setFrameSize);
      $('#spriteFps').addEventListener('input', (e) => { s.fps = Number(e.target.value); $('#spriteFpsLabel').textContent = s.fps; });
      $('#spriteSave').addEventListener('click', save);
      $('#spriteCancel').addEventListener('click', close);
      $('#spriteClose').addEventListener('click', close);
      $('#spriteDialog').addEventListener('close', () => { cancelAnimationFrame(raf); raf = 0; s = null; });
      const actions = $('#spriteDialog .actions');
      actions.prepend(el('button', { class: 'btn danger', style: 'margin-right:auto', onclick: () => s && remove() },
        el('span', { html: PS.icon('trash', 14) }), 'Delete character'));
    },

    async open(def) {
      let img;
      try { img = await PS.Assets.load(def.src); } catch (e) { return PS.UI.toast('This character image could not be loaded.', 'error'); }
      s = {
        def, img, fw: def.frameW, fh: def.frameH, fps: def.fps || 8, tab: 'idle',
        anims: Object.fromEntries(TABS.map((t) => [t.key, (def.anims[t.key] || []).slice()])),
        zoom: Math.max(0.25, Math.min(8, Math.floor(Math.min(520 / img.width, 360 / img.height)) || Math.min(520 / img.width, 360 / img.height))),
      };
      $('#spriteName').value = def.name;
      $('#spriteFW').value = s.fw;
      $('#spriteFH').value = s.fh;
      $('#spriteFW').max = img.width;
      $('#spriteFH').max = img.height;
      $('#spriteFps').value = s.fps;
      $('#spriteFpsLabel').textContent = s.fps;
      $('.preview-box').classList.add('checker-bg');
      renderAll();
      PS.UI.hideTip();
      $('#spriteDialog').showModal();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(previewLoop);
    },
  };

  PS.SpriteEditor = SpriteEditor;
})(window.PS);
