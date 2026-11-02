/* =====================================================================
   Platformer Studio — dual-grid tile engine
   Based on the system used by TileMapDual (github.com/pablogila/TileMapDual).

   The map stores which cells are filled (the "world grid"). What is drawn
   is a second "display grid", offset by half a tile, so every display tile
   sits on the corner where four world cells meet:

        world (dx-1, dy-1) | world (dx, dy-1)
        -------------------+------------------      display tile (dx, dy)
        world (dx-1, dy)   | world (dx, dy)

   Those four cells give a 4-bit mask, which needs just 16 tiles to draw
   every shape, including inner corners. The sheet layout is TileMapDual's
   "Standard" template: 128 × 128 pixels, 4 × 4 tiles of 32 × 32.

   Mask bits: 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right.

   Sheets can also be 256, 512 or 1024 pixels wide, with the same layout.
   A tile always fills the same space on the map, whatever its resolution.
   ===================================================================== */
(function (PS) {
  'use strict';

  const T = PS.TILE;
  const SHEET = T * 4;

  /** mask -> [column, row] on the sheet. */
  const ATLAS = [
    [0, 3], [3, 3], [0, 2], [1, 2], [0, 0], [3, 2], [2, 3], [3, 1],
    [1, 3], [0, 1], [1, 0], [2, 2], [3, 0], [2, 0], [1, 1], [2, 1],
  ];
  const MASK_AT = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  ATLAS.forEach(([c, r], m) => { MASK_AT[r][c] = m; });

  const NAMES = {
    0: 'Empty', 15: 'Middle', 12: 'Top edge', 3: 'Bottom edge', 5: 'Right edge', 10: 'Left edge',
    8: 'Top-left corner', 4: 'Top-right corner', 2: 'Bottom-left corner', 1: 'Bottom-right corner',
    7: 'Inside corner, bottom right', 11: 'Inside corner, bottom left', 13: 'Inside corner, top right', 14: 'Inside corner, top left',
    6: 'Diagonal /', 9: 'Diagonal \\',
  };

  /** Draw part of a sheet. High-resolution art is smoothed when shown smaller than its real size;
   *  otherwise pixels stay crisp. */
  function blit(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (sw > dw && img.width > SHEET) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.imageSmoothingEnabled = false;
    } else {
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    }
  }

  const Autotile = {
    ATLAS, MASK_AT, NAMES, SHEET,
    RESOLUTIONS: [128, 256, 512, 1024],
    blit,
    FULL: 15,

    maskAt: (col, row) => MASK_AT[row][col],

    /** Returns get(x, y) for a tile layer, optionally with pending (preview) overrides. */
    getter(layer, overrides) {
      const p = PS.state.project;
      const w = p.width, h = p.height, data = layer.data, edge = p.level.edgeConnect;
      // Side-on, the sky is open above the map. In iso, the far edges connect like the others.
      const openTop = p.view !== 'iso';
      return (x, y) => {
        if (y < 0 && openTop) return 0;
        if (x < 0 || y < 0 || x >= w || y >= h) {
          if (!edge) return 0;
          x = x < 0 ? 0 : x >= w ? w - 1 : x;
          y = y < 0 ? 0 : y >= h ? h - 1 : y;
        }
        const i = y * w + x;
        if (overrides && overrides.has(i)) return overrides.get(i);
        return data[i];
      };
    },

    /** Draw display tile (dx, dy) into the rectangle px, py, pw, ph. Returns true if anything was drawn. */
    drawDisplay(ctx, get, dx, dy, px, py, pw, ph) {
      const a = get(dx - 1, dy - 1), b = get(dx, dy - 1), c = get(dx - 1, dy), d = get(dx, dy);
      if (!a && !b && !c && !d) return false;
      if (PS.state.project.level.connectAcross) return drawConnected(ctx, a, b, c, d, px, py, pw, ph);
      // Each tileset present draws its own shape, once.
      let drew = false;
      if (a) drew = drawShape(ctx, a, a, b, c, d, px, py, pw, ph) || drew;
      if (b && b !== a) drew = drawShape(ctx, b, a, b, c, d, px, py, pw, ph) || drew;
      if (c && c !== a && c !== b) drew = drawShape(ctx, c, a, b, c, d, px, py, pw, ph) || drew;
      if (d && d !== a && d !== b && d !== c) drew = drawShape(ctx, d, a, b, c, d, px, py, pw, ph) || drew;
      return drew;
    },

    /** What is shown at world position (wx, wy) on a layer: which tileset, which tile (mask) and
     *  where inside it (lx, ly, in world units from 0 to 32). Returns null if nothing is there. */
    pixelAt(get, wx, wy) {
      const dx = Math.floor((wx + T / 2) / T), dy = Math.floor((wy + T / 2) / T);
      const a = get(dx - 1, dy - 1), b = get(dx, dy - 1), c = get(dx - 1, dy), d = get(dx, dy);
      if (!a && !b && !c && !d) return null;
      const lx = wx + T / 2 - dx * T, ly = wy + T / 2 - dy * T;
      const under = [a, b, c, d][(lx >= T / 2 ? 1 : 0) + (ly >= T / 2 ? 2 : 0)];
      const v = under || a || b || c || d;
      const across = PS.state.project.level.connectAcross;
      const test = (n) => (across ? n !== 0 : n === v);
      const mask = (test(a) ? 1 : 0) | (test(b) ? 2 : 0) | (test(c) ? 4 : 0) | (test(d) ? 8 : 0);
      return { tilesetId: v, mask, lx, ly };
    },
  };

  function drawShape(ctx, v, a, b, c, d, px, py, pw, ph) {
    const img = PS.Assets.tilesetImage(v);
    if (!img) return false;
    const mask = (a === v ? 1 : 0) | (b === v ? 2 : 0) | (c === v ? 4 : 0) | (d === v ? 8 : 0);
    const [col, row] = ATLAS[mask];
    const t = img.width / 4;
    blit(ctx, img, col * t, row * t, t, t, px, py, pw, ph);
    return true;
  }

  /** "Connect different tilesets": all tilesets share one shape, and each corner shows its own art. */
  function drawConnected(ctx, a, b, c, d, px, py, pw, ph) {
    const mask = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
    const [col, row] = ATLAS[mask];
    const midX = Math.round(pw / 2), midY = Math.round(ph / 2);
    let drew = false;
    [a, b, c, d].forEach((v, q) => {
      if (!v) return;
      const img = PS.Assets.tilesetImage(v);
      if (!img) return;
      const qx = q & 1, qy = q >> 1;
      const t = img.width / 4;
      blit(ctx, img, col * t + qx * t / 2, row * t + qy * t / 2, t / 2, t / 2,
        px + (qx ? midX : 0), py + (qy ? midY : 0), qx ? pw - midX : midX, qy ? ph - midY : midY);
      drew = true;
    });
    return drew;
  }

  PS.Autotile = Autotile;
})(window.PS);
