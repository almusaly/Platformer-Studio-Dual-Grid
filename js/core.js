/* =====================================================================
   Platformer Studio — core: namespace, constants, utilities, app state
   Every file adds to the single global `PS` namespace and nothing else.
   ===================================================================== */
window.PS = window.PS || {};

(function (PS) {
  'use strict';

  PS.TILE = 32;
  PS.LIMITS = { minMap: 1, maxMap: 256, maxHistory: 120, maxLayers: 24, maxObjects: 5000 };

  /* ------------------------------ Utilities ------------------------------ */
  const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'multiple', 'readOnly', 'draggable']);

  const util = {
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),

    approach(v, target, delta) {
      return v < target ? Math.min(v + delta, target) : Math.max(v - delta, target);
    },

    $: (sel, root = document) => root.querySelector(sel),
    $$: (sel, root = document) => Array.from(root.querySelectorAll(sel)),

    /** Small DOM builder. Text is always inserted as text, never as HTML.
     *  The `html` key is reserved for trusted constants such as icons. */
    el(tag, props, ...children) {
      const node = document.createElement(tag);
      if (props) {
        for (const [k, v] of Object.entries(props)) {
          if (v == null || v === false) continue;
          if (k === 'class') node.className = v;
          else if (k === 'text') node.textContent = v;
          else if (k === 'html') node.innerHTML = v;
          else if (k === 'dataset') Object.assign(node.dataset, v);
          else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
          else if (PROP_KEYS.has(k)) node[k] = v;
          else node.setAttribute(k, v === true ? '' : v);
        }
      }
      for (const c of children.flat(Infinity)) {
        if (c == null || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
      }
      return node;
    },

    debounce(fn, ms) {
      let t = 0;
      const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
      d.flush = (...args) => { clearTimeout(t); fn(...args); };
      return d;
    },

    /** Bresenham line between two cells, so fast strokes never leave gaps. */
    line(x0, y0, x1, y1, cb) {
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 4096; guard++) {
        cb(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    },

    rectFrom(a, b) {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      return { x, y, w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1 };
    },

    downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = util.el('a', { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },

    readAsDataURL(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('read'));
        r.readAsDataURL(file);
      });
    },

    readAsText(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('read'));
        r.readAsText(file);
      });
    },

    loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image'));
        img.src = src;
      });
    },

    isImageFile(file) {
      return !!file && /^image\/(png|gif|webp|bmp|jpeg|x-icon|avif)$/.test(file.type);
    },

    /** Strip control characters and limit length of user-provided names. */
    cleanName(s, fallback = 'Untitled', max = 40) {
      const v = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
      return v || fallback;
    },

    fileBase(name) {
      return String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    },

    safeFileName(name) {
      return (String(name || 'level').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'level').slice(0, 60);
    },

    isTypingTarget(t) {
      if (!t || !t.tagName) return false;
      if (t.isContentEditable) return true;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
      if (t.tagName === 'INPUT') return !['checkbox', 'radio', 'range', 'button', 'color', 'file'].includes(t.type);
      return false;
    },

    formatTime(sec) {
      const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    },

    /** Deterministic hash noise in [0, 1). Used by procedural art. */
    hash2(x, y) {
      let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    },

    int(v, def, min, max) {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? util.clamp(n, min, max) : def;
    },

    num(v, def, min, max) {
      const n = Number(v);
      return Number.isFinite(n) ? util.clamp(n, min, max) : def;
    },

    oneOf(v, list, def) { return list.includes(v) ? v : def; },

    plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; },

    isMac: /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
  };
  PS.util = util;

  /* ------------------------------ Event bus ------------------------------ */
  const listeners = new Map();
  PS.bus = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    emit(name, data) {
      const set = listeners.get(name);
      if (set) for (const fn of set) fn(data);
    },
  };

  /* ------------------------------ Application state ------------------------------
     `project` is the editable level document (saved to files).
     Everything else is editor UI state and is never part of a saved project. */
  const PREF_KEY = 'platformer-studio-prefs';
  const defaultPrefs = {
    theme: 'dark',
    showGrid: true,
    checker: 0.5,
    highlightLayer: false,
    sound: true,
    leftClosed: false,
    rightClosed: false,
    welcomeDismissed: false,
    collapsed: {},
    paintRightOpen: false,
    userPalettes: [],
    paintFull: false,
    customBrushes: [],
    paint: {
      tool: 'brush', brush: 'round', size: 2, hardness: 100, fade: false, guide: true, inside: false,
      spacing: 25, scatter: 0, sizeJitter: 0, angleJitter: 0, hueJitter: 0, lightJitter: 0,
    },
  };

  function loadPrefs() {
    try {
      const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      const prefs = Object.assign({}, defaultPrefs, raw && typeof raw === 'object' ? raw : {});
      prefs.paint = Object.assign({}, defaultPrefs.paint, prefs.paint);
      if (!Array.isArray(prefs.userPalettes)) prefs.userPalettes = [];
      if (!Array.isArray(prefs.customBrushes)) prefs.customBrushes = [];
      return prefs;
    } catch (e) {
      return Object.assign({}, defaultPrefs);
    }
  }

  PS.state = {
    project: null,
    mode: 'edit',            // 'edit' | 'play'
    workspace: 'build',      // 'build' places tiles and objects, 'paint' edits tile art
    paintColor: '#63c74d',
    tool: 'pencil',
    placeItem: null,         // { kind: 'spawn'|'goal'|'enemy'|'collectible', type }
    activeTilesetId: 0,
    activeLayerId: 0,
    selectedObjectId: 0,
    selection: null,         // tile rectangle { x, y, w, h }
    clipboard: null,         // { w, h, cells: Uint16Array }
    dirty: false,            // unsaved changes since last file save
    prefs: loadPrefs(),
  };

  PS.savePrefs = function () {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(PS.state.prefs)); } catch (e) { /* storage unavailable */ }
  };
})(window.PS);
