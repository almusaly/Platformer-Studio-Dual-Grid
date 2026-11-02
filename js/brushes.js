/* =====================================================================
   Platformer Studio — custom brushes
   Turns an uploaded image of any shape into a brush. A brush is a mask of
   strengths, 0 to 255, cropped to its shape and at most 128 pixels on its
   longest side, which is the largest brush size. It is kept with the other
   preferences, so brushes are there for every project.

   Which part of an image paints:
   • With transparency, the visible part does, whatever its colour.
   • Otherwise the shape is whichever of black or white isn't the
     background, judged from the image's border. Invert swaps them.

   Stamps are the mask resized so its longest side fits the brush size,
   keeping its proportions, then rotated.
   ===================================================================== */
(function (PS) {
  'use strict';

  const st = PS.state;
  const PREFIX = 'custom:';
  const MAX_SIDE = 128;
  const READ_SIDE = 512;       // large uploads are reduced to this before they are read
  const MAX_BRUSHES = 24;
  const MAX_STAMPS = 160;
  const ANGLE_STEP = 2;        // random rotations share stamps, so they stay fast
  const FAINT = 8;             // weaker than this is noise, such as JPEG artefacts around a shape

  const masks = new Map();     // brush id -> decoded mask
  const stamps = new Map();    // brush id, size and angle -> finished stamp

  const list = () => st.prefs.customBrushes;

  /* ------------------------------ Storing a mask ------------------------------ */
  function encode(mask) {
    let s = '';
    for (let i = 0; i < mask.length; i++) s += String.fromCharCode(mask[i]);
    return btoa(s);
  }

  function decode(text) {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function maskOf(brush) {
    let m = masks.get(brush.id);
    if (!m) {
      m = decode(brush.data);
      masks.set(brush.id, m);
    }
    return m;
  }

  function forget(id) {
    masks.delete(id);
    for (const key of stamps.keys()) if (key.startsWith(`${id}|`)) stamps.delete(key);
  }

  /* ------------------------------ Reading an image ------------------------------ */
  /** Strengths from RGBA pixels, or null when the image has no shape at all. */
  function maskFromPixels(data, w, h) {
    const n = w * h;
    const out = new Uint8Array(n);
    let clear = 0;
    for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 128) clear++;
    if (clear === n) return null;
    if (clear > 0) {
      for (let i = 0; i < n; i++) out[i] = data[i * 4 + 3];
      return out;
    }
    let edge = 0, count = 0;
    const light = (x, y) => {
      const i = (y * w + x) * 4;
      return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    };
    for (let x = 0; x < w; x++) { edge += light(x, 0) + light(x, h - 1); count += 2; }
    for (let y = 0; y < h; y++) { edge += light(0, y) + light(w - 1, y); count += 2; }
    const whiteShape = edge / count < 128;
    let top = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = light(x, y);
      const a = Math.round(whiteShape ? v : 255 - v);
      out[y * w + x] = a;
      if (a > top) top = a;
    }
    // One flat colour has no background to tell apart, so the whole image is the shape.
    if (top < FAINT) out.fill(255);
    return out;
  }

  /** Cut away the empty space around a shape, so its size is the shape's own. */
  function trim(mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (mask[y * w + x] < FAINT) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const out = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) out.set(mask.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + cw), y * cw);
    return { mask: out, w: cw, h: ch };
  }

  /** Resize by averaging the area each new pixel covers. Works in both directions. */
  function resize(mask, w, h, nw, nh) {
    const out = new Uint8Array(nw * nh);
    const kx = w / nw, ky = h / nh;
    for (let y = 0; y < nh; y++) {
      const top = y * ky, bottom = (y + 1) * ky;
      for (let x = 0; x < nw; x++) {
        const left = x * kx, right = (x + 1) * kx;
        let sum = 0, area = 0;
        for (let sy = Math.floor(top); sy < Math.min(h, Math.ceil(bottom)); sy++) {
          const wy = Math.min(bottom, sy + 1) - Math.max(top, sy);
          for (let sx = Math.floor(left); sx < Math.min(w, Math.ceil(right)); sx++) {
            const wx = Math.min(right, sx + 1) - Math.max(left, sx);
            sum += mask[sy * w + sx] * wx * wy;
            area += wx * wy;
          }
        }
        out[y * nw + x] = area ? Math.round(sum / area) : 0;
      }
    }
    return out;
  }

  /** The longest side becomes `side`, and the shape keeps its proportions. */
  function fit(w, h, side) {
    const k = side / Math.max(w, h);
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  /** Turn pixels into brush data, or null when they hold no shape. */
  function build(data, w, h) {
    const mask = maskFromPixels(data, w, h);
    const cut = mask && trim(mask, w, h);
    if (!cut) return null;
    if (Math.max(cut.w, cut.h) <= MAX_SIDE) return cut;
    const size = fit(cut.w, cut.h, MAX_SIDE);
    return { mask: resize(cut.mask, cut.w, cut.h, size.w, size.h), w: size.w, h: size.h };
  }

  /* ------------------------------ Stamps ------------------------------ */
  /** Bilinear rotation about the centre, on a canvas big enough for any angle. */
  function rotate(mask, w, h, degrees) {
    const rad = (degrees * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const nw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
    const nh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
    const out = new Uint8Array(nw * nh);
    const read = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const dx = x + 0.5 - nw / 2, dy = y + 0.5 - nh / 2;
      const sx = dx * cos + dy * sin + w / 2 - 0.5, sy = -dx * sin + dy * cos + h / 2 - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const v = (read(x0, y0) * (1 - fx) + read(x0 + 1, y0) * fx) * (1 - fy)
        + (read(x0, y0 + 1) * (1 - fx) + read(x0 + 1, y0 + 1) * fx) * fy;
      out[y * nw + x] = Math.round(v);
    }
    return { mask: out, w: nw, h: nh };
  }

  /** The strongest pixel paints fully, so thin shapes survive being made small. */
  function normalize(mask) {
    let top = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] > top) top = mask[i];
    if (top === 0 || top === 255) return mask;
    for (let i = 0; i < mask.length; i++) mask[i] = Math.round((mask[i] * 255) / top);
    return mask;
  }

  const Brushes = {
    PREFIX,
    MAX_BRUSHES,

    isCustom: (key) => typeof key === 'string' && key.startsWith(PREFIX),
    keyOf: (brush) => PREFIX + brush.id,
    list,
    get: (key) => (Brushes.isCustom(key) ? list().find((b) => Brushes.keyOf(b) === key) || null : null),

    /** A new brush from a loaded image, or null when the image holds no shape. */
    add(image, name) {
      const iw = image.naturalWidth || image.width, ih = image.naturalHeight || image.height;
      const size = Math.max(iw, ih) > READ_SIDE ? fit(iw, ih, READ_SIDE) : { w: iw, h: ih };
      const canvas = PS.Sprites.canvas(size.w, size.h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, size.w, size.h);
      const made = build(ctx.getImageData(0, 0, size.w, size.h).data, size.w, size.h);
      if (!made) return null;
      const brush = {
        id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
        name: PS.util.cleanName(name, 'Brush', 24), w: made.w, h: made.h, data: encode(made.mask),
      };
      list().push(brush);
      PS.savePrefs();
      return brush;
    },

    remove(brush) {
      const i = list().indexOf(brush);
      if (i < 0) return;
      list().splice(i, 1);
      forget(brush.id);
      PS.savePrefs();
    },

    /** Swap which part of the image paints. */
    invert(brush) {
      const mask = maskOf(brush);
      const out = new Uint8Array(mask.length);
      for (let i = 0; i < mask.length; i++) out[i] = 255 - mask[i];
      // A shape that filled its box leaves nothing behind, so it stays as it was.
      const cut = trim(out, brush.w, brush.h);
      if (!cut) return false;
      forget(brush.id);
      brush.w = cut.w;
      brush.h = cut.h;
      brush.data = encode(cut.mask);
      PS.savePrefs();
      return true;
    },

    /** The brush fitted to a size and turned by some degrees: { mask, w, h }. */
    stamp(brush, size, degrees = 0) {
      const angle = ((Math.round(degrees / ANGLE_STEP) * ANGLE_STEP) % 360 + 360) % 360;
      const key = `${brush.id}|${size}|${angle}`;
      let s = stamps.get(key);
      if (s) return s;
      const to = fit(brush.w, brush.h, size);
      let made = { mask: resize(maskOf(brush), brush.w, brush.h, to.w, to.h), w: to.w, h: to.h };
      if (angle) made = rotate(made.mask, made.w, made.h, angle);
      normalize(made.mask);
      if (stamps.size >= MAX_STAMPS) stamps.clear();
      stamps.set(key, made);
      return made;
    },

    /** A colour shifted by hue (in degrees) and brightness (-1 to 1). */
    shift(rgb, hueBy, lightBy) {
      const [r, g, b] = rgb.map((v) => v / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), chroma = max - min;
      let l = (max + min) / 2;
      const s = chroma ? chroma / (1 - Math.abs(2 * l - 1)) : 0;
      let h = 0;
      if (chroma) {
        if (max === r) h = ((g - b) / chroma + 6) % 6;
        else if (max === g) h = (b - r) / chroma + 2;
        else h = (r - g) / chroma + 4;
      }
      h = (((h * 60 + hueBy) % 360) + 360) % 360 / 60;
      l = PS.util.clamp(l + lightBy, 0, 1);
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs((h % 2) - 1));
      const m = l - c / 2;
      const [cr, cg, cb] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h) % 6];
      return [Math.round((cr + m) * 255), Math.round((cg + m) * 255), Math.round((cb + m) * 255)];
    },

    build,
    resize,
    rotate,
  };

  PS.Brushes = Brushes;
})(window.PS);
