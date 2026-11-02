/* =====================================================================
   Platformer Studio — colour palettes
   Painting uses the colours of the active palette, except the Lighter and
   Darker brushes, which shade the art's own colours. Palettes can
   be pasted or uploaded from lospec.com/palette-list in any of the formats
   it offers (.hex, .pal, .gpl, .txt, .ase, PNG) or extracted from an image.
   ===================================================================== */
(function (PS) {
  'use strict';

  const expand = (s) => s.split(' ').map((c) => '#' + c);
  const BUILTIN = [
    { key: 'b:endesga-32', name: 'Endesga 32', colors: expand('be4a2f d77643 ead4aa e4a672 b86f50 733e39 3e2731 a22633 e43b44 f77622 feae34 fee761 63c74d 3e8948 265c42 193c3e 124e89 0099db 2ce8f5 ffffff c0cbdc 8b9bb4 5a6988 3a4466 262b44 181425 ff0044 68386c b55088 f6757a e8b796 c28569') },
    { key: 'b:sweetie-16', name: 'Sweetie 16', colors: expand('1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179 29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57') },
    { key: 'b:pico-8', name: 'PICO-8', colors: expand('000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa') },
    { key: 'b:db16', name: 'DawnBringer 16', colors: expand('140c1c 442434 30346d 4e4a4e 854c30 346524 d04648 757161 597dce d27d2c 8595a1 6daa2c d2aa99 6dc2ca dad45e deeed6') },
    { key: 'b:game-boy', name: 'Game Boy', colors: expand('0f380f 306230 8bac0f 9bbc0f') },
  ];
  const DEFAULT_KEY = BUILTIN[0].key;
  const MAX_COLORS = 256;
  const st = PS.state;

  /* ------------------------------ Colour maths ------------------------------ */
  const toRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const toHex = (r, g, b) => '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

  /** Perceptual-ish colour distance ("redmean"). */
  function distance(a, b) {
    const rm = (a[0] + b[0]) / 2;
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
  }

  function nearest(rgb, colors) {
    let best = colors[0], bestD = Infinity;
    for (const c of colors) {
      const d = distance(rgb, toRgb(c));
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /* ------------------------------ Parsing ------------------------------ */
  function unique(list) {
    const out = [];
    const seen = new Set();
    for (const c of list) {
      const v = c.toLowerCase();
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= MAX_COLORS) break;
    }
    return out;
  }

  function parseText(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed);
        if (Array.isArray(json.colors)) return { name: json.name, colors: parseText(json.colors.join('\n')).colors };
      } catch (e) { /* fall through to plain text */ }
    }
    const lines = trimmed.split(/\r?\n/);
    const colors = [];
    let name = '';
    const nums = /^\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\b/;
    const header = lines[0] || '';
    const isRgbList = /^JASC-PAL/i.test(header) || /^GIMP Palette/i.test(header);
    lines.forEach((line, i) => {
      if (/^JASC-PAL/i.test(header) && i < 3) return;
      const nm = /^\s*(?:Name|;\s*Palette Name):\s*(.+)$/i.exec(line);
      if (nm) { name = nm[1].trim(); return; }
      if (isRgbList) {
        if (line.startsWith('#')) return;
        const m = nums.exec(line);
        if (m && [m[1], m[2], m[3]].every((v) => Number(v) <= 255)) colors.push(toHex(Number(m[1]), Number(m[2]), Number(m[3])));
        return;
      }
      if (line.trim().startsWith(';')) return;
      // paint.net files are AARRGGBB; everything else is RRGGBB, with or without #.
      for (const token of line.match(/#?\b[0-9a-f]{6}(?:[0-9a-f]{2})?\b/gi) || []) {
        const h = token.replace('#', '');
        colors.push('#' + (h.length === 8 ? h.slice(2) : h));
      }
    });
    return { name, colors: unique(colors) };
  }

  /** Adobe Swatch Exchange, the binary .ase format. */
  function parseAse(buffer) {
    const v = new DataView(buffer);
    if (buffer.byteLength < 12 || v.getUint32(0) !== 0x41534546) return { name: '', colors: [] };
    const blocks = v.getUint32(8);
    const colors = [];
    let pos = 12;
    const byte = (f) => Math.max(0, Math.min(255, Math.round(f * 255)));
    for (let i = 0; i < blocks && pos + 6 <= buffer.byteLength; i++) {
      const type = v.getUint16(pos), len = v.getUint32(pos + 2);
      pos += 6;
      if (type === 1) {
        const nameLen = v.getUint16(pos);
        const c = pos + 2 + nameLen * 2;
        const model = String.fromCharCode(v.getUint8(c), v.getUint8(c + 1), v.getUint8(c + 2), v.getUint8(c + 3));
        if (model === 'RGB ') colors.push(toHex(byte(v.getFloat32(c + 4)), byte(v.getFloat32(c + 8)), byte(v.getFloat32(c + 12))));
        else if (model === 'GRAY') { const g = byte(v.getFloat32(c + 4)); colors.push(toHex(g, g, g)); }
      }
      pos += len;
    }
    return { name: '', colors: unique(colors) };
  }

  /** Reduce many colours to a small palette with median cut. */
  function medianCut(pixels, count) {
    let boxes = [pixels];
    while (boxes.length < count) {
      let bi = -1, bestRange = -1, axis = 0;
      boxes.forEach((box, i) => {
        if (box.length < 2) return;
        for (let a = 0; a < 3; a++) {
          let lo = 255, hi = 0;
          for (const px of box) { if (px[a] < lo) lo = px[a]; if (px[a] > hi) hi = px[a]; }
          if (hi - lo > bestRange) { bestRange = hi - lo; bi = i; axis = a; }
        }
      });
      if (bi < 0 || bestRange <= 0) break;
      const box = boxes[bi].sort((p, q) => p[axis] - q[axis]);
      const mid = box.length >> 1;
      boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid));
    }
    return boxes.map((box) => {
      const sum = [0, 0, 0];
      for (const px of box) { sum[0] += px[0]; sum[1] += px[1]; sum[2] += px[2]; }
      return toHex(Math.round(sum[0] / box.length), Math.round(sum[1] / box.length), Math.round(sum[2] / box.length));
    });
  }

  /** Exact colours of a palette image (in reading order), or a reduced set for a photo or artwork. */
  function fromImage(img, reduceTo = 32) {
    const w = Math.min(img.width, 512), h = Math.min(img.height, 512);
    const c = PS.Sprites.canvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const seen = new Set();
    const ordered = [];
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      pixels.push([data[i], data[i + 1], data[i + 2]]);
      const hex = toHex(data[i], data[i + 1], data[i + 2]);
      if (!seen.has(hex)) { seen.add(hex); if (ordered.length <= MAX_COLORS) ordered.push(hex); }
    }
    if (ordered.length <= MAX_COLORS) return unique(ordered);
    return unique(medianCut(pixels, reduceTo));
  }

  const Palettes = {
    BUILTIN, DEFAULT_KEY, MAX_COLORS,
    toRgb, toHex, luma, nearest, parseText, parseAse, fromImage,

    /** Stored in the project file too, so a project opens with its palette on any computer. */
    list() {
      const seen = new Set(BUILTIN.map((b) => b.key));
      const out = BUILTIN.slice();
      const user = [...st.prefs.userPalettes, ...(st.project ? st.project.palettes : [])];
      for (const u of user) {
        if (seen.has(u.key)) continue;
        seen.add(u.key);
        out.push(u);
      }
      return out;
    },

    get(key) { return Palettes.list().find((x) => x.key === key) || null; },

    active() { return Palettes.get(st.project && st.project.paletteKey) || BUILTIN[0]; },

    setActive(key) {
      const pal = Palettes.get(key);
      if (!pal) return;
      const p = st.project;
      p.paletteKey = key;
      if (!key.startsWith('b:') && !p.palettes.some((x) => x.key === key)) p.palettes.push(pal);
      st.paintColor = nearest(toRgb(st.paintColor), pal.colors);
      PS.bus.emit('palette');
    },

    /** Add a palette for this project and future ones, and make it active. */
    add(name, colors) {
      const clean = PS.util.cleanName(name, 'My palette', 40);
      const key = 'u:' + colors.join('').replace(/#/g, '').slice(0, 64) + ':' + colors.length;
      const pal = { key, name: clean, colors };
      if (!st.prefs.userPalettes.some((x) => x.key === key)) {
        st.prefs.userPalettes.push(pal);
        PS.savePrefs();
      }
      Palettes.setActive(key);
      return pal;
    },

    /** Forget a saved palette. Built-in palettes stay. */
    remove(key) {
      if (key.startsWith('b:')) return;
      st.prefs.userPalettes = st.prefs.userPalettes.filter((x) => x.key !== key);
      PS.savePrefs();
      const p = st.project;
      p.palettes = p.palettes.filter((x) => x.key !== key);
      if (p.paletteKey === key) Palettes.setActive(DEFAULT_KEY);
      else PS.bus.emit('palette');
    },

    /** Read a palette from a dropped or chosen file. Never throws. */
    async fromFile(file) {
      const name = PS.util.fileBase(file.name);
      const fail = (error) => ({ ok: false, error });
      try {
        let parsed;
        if (/\.ase$/i.test(file.name)) {
          parsed = parseAse(await file.arrayBuffer());
        } else if (PS.util.isImageFile(file)) {
          const img = await PS.util.loadImage(await PS.util.readAsDataURL(file));
          parsed = { name: '', colors: fromImage(img) };
        } else if (file.size > 1024 * 1024) {
          return fail(`“${file.name}” is too large to be a palette file.`);
        } else {
          parsed = parseText(await PS.util.readAsText(file));
        }
        if (parsed.colors.length < 2) return fail(`No colours were found in “${file.name}”. Use a .hex, .pal, .gpl, .txt or .ase file, or an image.`);
        return { ok: true, name: parsed.name || name, colors: parsed.colors };
      } catch (e) {
        return fail(`“${file.name}” couldn't be read as a palette.`);
      }
    },

    /** Read a palette from pasted text: a Lospec link, a palette name, or a list of colours. */
    async fromInput(text) {
      const value = text.trim();
      if (!value) return { ok: false, error: 'Paste a Lospec link or a list of colours first.' };
      const link = /lospec\.com\/palette-list\/([a-z0-9-]+)/i.exec(value);
      if (link) {
        try {
          const res = await fetch(`https://lospec.com/palette-list/${link[1].toLowerCase()}.json`);
          if (!res.ok) throw new Error('status');
          const parsed = parseText(await res.text());
          if (parsed.colors.length < 2) throw new Error('empty');
          return { ok: true, name: parsed.name || PS.util.fileBase(link[1]), colors: parsed.colors };
        } catch (e) {
          return { ok: false, error: 'That palette couldn’t be downloaded. Check the link and your connection, or download the .hex file from the Lospec page and upload it here.' };
        }
      }
      const parsed = parseText(value);
      if (parsed.colors.length < 2) return { ok: false, error: 'No colours found. Paste a Lospec link, or colours like #1a1c2c #5d275d.' };
      return { ok: true, name: parsed.name, colors: parsed.colors };
    },

    /** The next lighter (dir = 1) or darker (dir = -1) colour in a palette, keeping the hue close. */
    step(hex, dir, colors = Palettes.active().colors) {
      const rgb = toRgb(hex), l = luma(rgb);
      const tint = (c, cl) => c.map((v) => (v + 12) / (cl + 12));
      const own = tint(rgb, l);
      let best = null, bestScore = Infinity;
      for (const c of colors) {
        const q = toRgb(c), ql = luma(q);
        const dl = (ql - l) * dir;
        if (dl < 6) continue;
        // Comparing colours relative to their brightness finds a true shade of the same colour.
        const t = tint(q, ql);
        const drift = (t[0] - own[0]) ** 2 + (t[1] - own[1]) ** 2 + (t[2] - own[2]) ** 2;
        const score = drift * 30000 + dl * dl;
        if (score < bestScore) { bestScore = score; best = c; }
      }
      return best || hex;
    },

    /** The same colour, naturally lighter (dir = 1) or darker (dir = -1). Works from the colour
     *  itself rather than the palette, so its hue never changes. Bright colours lighten toward white. */
    tone(rgb, dir) {
      if (dir < 0) return rgb.map((v) => Math.round(v * 0.8));
      const top = Math.max(...rgb);
      const target = Math.max(top * 1.25, top + 8);     // near-black still needs a visible step
      const scale = top ? Math.min(target, 255) / top : 0;
      const toWhite = Math.max(0, target - 255) / target;
      return rgb.map((v) => {
        const c = top ? v * scale : target;
        return Math.round(c + (255 - c) * toWhite);
      });
    },

    /** A darkened copy of a colour, snapped back onto the palette. */
    shaded(rgb, factor, colors = Palettes.active().colors) {
      return nearest([rgb[0] * factor, rgb[1] * factor, rgb[2] * factor], colors);
    },

    darkest(colors = Palettes.active().colors) {
      return colors.reduce((a, b) => (luma(toRgb(b)) < luma(toRgb(a)) ? b : a));
    },

    /** Replace every pixel of a canvas with its nearest palette colour, keeping its transparency.
     *  Returns true if anything changed. */
    snapCanvas(canvas, colors = Palettes.active().colors) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      const memo = new Map();
      let changed = false;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        let m = memo.get(key);
        if (m === undefined) { m = toRgb(nearest([d[i], d[i + 1], d[i + 2]], colors)); memo.set(key, m); }
        if (d[i] !== m[0] || d[i + 1] !== m[1] || d[i + 2] !== m[2]) {
          d[i] = m[0]; d[i + 1] = m[1]; d[i + 2] = m[2];
          changed = true;
        }
      }
      if (changed) ctx.putImageData(img, 0, 0);
      return changed;
    },
  };

  PS.Palettes = Palettes;
})(window.PS);
