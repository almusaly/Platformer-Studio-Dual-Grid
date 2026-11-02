/* =====================================================================
   Platformer Studio — built-in pixel art
   Everything is drawn procedurally into 32×32 canvases at startup, so the
   app works offline with no image files. All shapes are filled pixel by
   pixel (never anti-aliased) to stay crisp at any zoom.
   ===================================================================== */
(function (PS) {
  'use strict';

  const S = 32;

  function canvas(w = S, h = S) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** Create a 32×32 sprite. `draw(r, shape)`:
   *  r(x, y, w, h, color) fills a rectangle;
   *  shape(test, color) fills each pixel whose centre passes test(x, y). */
  function make(draw) {
    const c = canvas();
    const ctx = c.getContext('2d');
    const r = (x, y, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); };
    const shape = (test, col) => {
      ctx.fillStyle = col;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (test(x + 0.5, y + 0.5)) ctx.fillRect(x, y, 1, 1);
    };
    draw(r, shape);
    return c;
  }

  const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

  function polygon(pts) {
    return (x, y) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
  }

  function starPoints(cx, cy, outer, inner, n = 5) {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / n;
      const rad = i % 2 ? inner : outer;
      pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
    return pts;
  }

  /* ============================== Characters ==============================
     All heroes face right. Poses: idle (2 frames), walk (4), jump (1), fall (1). */
  const POSES = {
    idle: [{ pose: 'idle', frame: 0, bob: 0 }, { pose: 'idle', frame: 1, bob: 1 }],
    walk: [0, 1, 2, 3].map((f) => ({ pose: 'walk', frame: f, bob: f % 2 ? -1 : 0 })),
    jump: [{ pose: 'jump', frame: 0, bob: -1 }],
    fall: [{ pose: 'fall', frame: 0, bob: 0 }],
  };

  function armOffset(p) {
    if (p.pose === 'walk') return [1, 0, -1, 0][p.frame];
    if (p.pose === 'jump') return -3;
    if (p.pose === 'fall') return -2;
    return 0;
  }

  function legs(r, p, pants, shoes, lx = 11, rx = 17, w = 4) {
    let ol = 0, or = 0, hl = 8, hr = 8;
    if (p.pose === 'walk') [ol, or] = [[-2, 2], [0, 0], [2, -2], [0, 0]][p.frame];
    else if (p.pose === 'jump') { ol = 1; or = 2; hl = 6; hr = 7; }
    else if (p.pose === 'fall') { ol = -2; or = 2; }
    const leg = (x, h) => { r(x, 24, w, h - 2, pants); r(x, 24 + h - 2, w + 1, 2, shoes); };
    leg(lx + ol, hl);
    leg(rx + or, hr);
  }

  const CHARACTER_ART = {
    ninja: {
      name: 'Ninja',
      draw(r, p) {
        const b = p.bob, a = armOffset(p);
        const flow = p.pose === 'idle' ? 0 : 1;
        legs(r, p, '#232a52', '#11152b');
        r(4, 6 + b + flow, 6, 2, '#e5484d');
        r(1, 8 + b + flow * 2, 5, 2, '#c53030');
        r(10, 15 + b, 12, 10, '#2d3561');
        r(10, 21 + b, 12, 2, '#e5484d');
        r(10, 3 + b, 12, 1, '#2d3561');
        r(9, 4 + b, 14, 12, '#2d3561');
        r(11, 8 + b, 11, 4, '#f3cfa6');
        r(16, 9 + b, 2, 2, '#14172b');
        r(20, 9 + b, 2, 2, '#14172b');
        r(9, 5 + b, 14, 2, '#e5484d');
        r(15, 16 + b + a, 4, 6, '#1f2547');
        r(15, 22 + b + a, 4, 2, '#f3cfa6');
      },
    },
    robot: {
      name: 'Robot',
      draw(r, p) {
        const b = p.bob, a = armOffset(p);
        legs(r, p, '#5b6577', '#2f3542');
        r(15, 1 + b, 2, 3, '#8d99ae');
        r(14, 0 + b, 4, 2, '#ff6b6b');
        r(8, 4 + b, 16, 11, '#b4bdcc');
        r(8, 14 + b, 16, 1, '#7b8596');
        r(7, 7 + b, 1, 4, '#5b6577');
        r(24, 7 + b, 1, 4, '#5b6577');
        r(10, 7 + b, 13, 5, '#1c2333');
        r(13, 8 + b, 3, 3, '#5ef2ff');
        r(18, 8 + b, 3, 3, '#5ef2ff');
        r(9, 15 + b, 14, 10, '#8792a3');
        r(9, 15 + b, 14, 1, '#a3adbd');
        r(12, 18 + b, 6, 3, '#ffd43b');
        r(16, 17 + b + a, 4, 6, '#6b7588');
        r(16, 23 + b + a, 4, 1, '#4a5263');
      },
    },
    explorer: {
      name: 'Explorer',
      draw(r, p) {
        const b = p.bob, a = armOffset(p);
        legs(r, p, '#7a6142', '#3d2b1a');
        r(5, 15 + b, 6, 9, '#8a5a2b');
        r(5, 17 + b, 6, 1, '#5c3b1a');
        r(10, 15 + b, 12, 10, '#4f9d69');
        r(10, 22 + b, 12, 1, '#5c3b1a');
        r(10, 7 + b, 12, 9, '#f1c27d');
        r(10, 8 + b, 3, 5, '#6b4423');
        r(18, 10 + b, 2, 2, '#222');
        r(18, 13 + b, 3, 1, '#b5651d');
        r(10, 2 + b, 12, 5, '#b07d47');
        r(10, 5 + b, 12, 1, '#5c3b1a');
        r(6, 7 + b, 20, 2, '#9a6a3a');
        r(15, 16 + b + a, 4, 6, '#43875a');
        r(15, 22 + b + a, 4, 2, '#f1c27d');
      },
    },
    dino: {
      name: 'Dinosaur',
      draw(r, p) {
        const b = p.bob, a = armOffset(p);
        const g = '#4cc764', d = '#2f9e44';
        legs(r, p, g, d, 10, 17, 5);
        r(0, 18 + b, 3, 2, g);
        r(2, 16 + b, 6, 5, g);
        r(7, 13 + b, 15, 12, g);
        r(11, 17 + b, 9, 7, '#d8f5a2');
        r(8, 11 + b, 2, 2, d);
        r(11, 10 + b, 2, 3, d);
        r(14, 1 + b, 2, 2, d);
        r(15, 13 + b, 8, 2, g);
        r(15, 3 + b, 13, 10, g);
        r(17, 2 + b, 9, 1, g);
        r(26, 6 + b, 3, 6, g);
        r(21, 5 + b, 3, 3, '#fff');
        r(23, 6 + b, 1, 2, '#111');
        r(27, 7 + b, 1, 1, d);
        r(19, 11 + b, 10, 1, d);
        r(21, 17 + b + a, 4, 2, d);
      },
    },
    pip: {
      name: 'Pip',
      draw(r, p) {
        const b = p.bob, a = armOffset(p);
        const o = '#ff8c42', od = '#e4682a';
        legs(r, p, '#3d4a7a', '#252e52');
        r(9, 15 + b, 14, 10, o);
        r(12, 20 + b, 8, 3, od);
        r(9, 0 + b, 3, 3, o);
        r(20, 0 + b, 3, 3, o);
        r(9, 2 + b, 14, 1, o);
        r(8, 3 + b, 16, 13, o);
        r(11, 6 + b, 11, 8, '#ffe1c4');
        r(15, 8 + b, 2, 3, '#222');
        r(19, 8 + b, 2, 3, '#222');
        r(13, 11 + b, 2, 1, '#ff9aa2');
        r(21, 11 + b, 1, 1, '#ff9aa2');
        r(15, 17 + b + a, 4, 6, od);
        r(15, 23 + b + a, 4, 2, '#ffe1c4');
      },
    },
  };

  /* ============================== Enemies ============================== */
  const ENEMY_ART = {
    slime: {
      name: 'Slime',
      draw(r, shape, f) {
        const rx = 12 + f * 2, ry = 15 - f * 3;
        shape((x, y) => y <= 31 && ellipse(16, 31, rx, ry)(x, y), '#3fb950');
        shape((x, y) => y <= 30 && ellipse(16, 30.5, rx - 1.5, ry - 1.5)(x, y), '#5bd16a');
        shape(ellipse(11, 31 - ry + 5, 2.6, 2), '#b9f6c3');
        const ey = 31 - ry + 7;
        r(17, ey, 2, 3, '#173d1d');
        r(22, ey, 2, 3, '#173d1d');
        r(17, ey, 1, 1, '#fff');
        r(22, ey, 1, 1, '#fff');
      },
    },
    robot: {
      name: 'Walker Bot',
      draw(r, shape, f) {
        r(15, 2, 2, 4, '#6c7093');
        r(14, 0, 4, 2, '#ff3b3b');
        r(8, 6, 16, 13, '#4a4e69');
        r(8, 6, 16, 2, '#6c7093');
        r(16, 10, 6, 4, '#2b2d42');
        r(17, 11, 4, 2, '#ff3b3b');
        r(18, 11, 1, 1, '#ffd0d0');
        r(10, 19, 12, 6, '#3a3d56');
        r(10, 21, 12, 1, '#ffb703');
        const l = f ? 5 : 7, rr = f ? 7 : 5;
        r(10, 25, 4, l, '#22243a');
        r(18, 25, 4, rr, '#22243a');
        r(9, 24 + l, 6, 1, '#11121c');
        r(17, 24 + rr, 6, 1, '#11121c');
      },
    },
    spiky: {
      name: 'Spiky',
      draw(r, shape, f) {
        const s = f ? 1 : 0;
        const spike = '#f1e6ff';
        r(15, 3 - s, 2, 5 + s, spike);
        r(8, 6 - s, 2, 4 + s, spike);
        r(22, 6 - s, 2, 4 + s, spike);
        r(2 - s, 17, 5 + s, 2, spike);
        r(25, 17, 5 + s, 2, spike);
        r(5, 9, 2, 2, spike);
        r(25, 9, 2, 2, spike);
        shape(ellipse(16, 19, 11, 10), '#7b2cbf');
        shape(ellipse(16, 18, 9.5, 8.5), '#9d4edd');
        r(11, 16, 4, 4, '#fff');
        r(18, 16, 4, 4, '#fff');
        r(13, 17, 2, 2, '#10002b');
        r(20, 17, 2, 2, '#10002b');
        r(10, 14, 5, 1, '#3c096c');
        r(18, 14, 5, 1, '#3c096c');
        r(14, 23, 5, 1, '#3c096c');
        r(9 + s, 28, 5, 3, '#5a189a');
        r(18 - s, 28, 5, 3, '#5a189a');
      },
    },
    flyer: {
      name: 'Bat',
      draw(r, shape, f) {
        const wing = '#7b5fc7';
        if (f === 0) {
          shape(polygon([[10, 15], [1, 4], [3, 12], [0, 17], [10, 19]]), wing);
          shape(polygon([[22, 15], [31, 4], [29, 12], [32, 17], [22, 19]]), wing);
        } else {
          shape(polygon([[10, 14], [1, 20], [4, 22], [2, 27], [11, 19]]), wing);
          shape(polygon([[22, 14], [31, 20], [28, 22], [30, 27], [21, 19]]), wing);
        }
        r(11, 8, 2, 4, '#4a2f8a');
        r(19, 8, 2, 4, '#4a2f8a');
        shape(ellipse(16, 16, 7, 7), '#4a2f8a');
        shape(ellipse(16, 15.5, 5.5, 5.5), '#5f43a8');
        r(13, 14, 2, 2, '#ffd60a');
        r(18, 14, 2, 2, '#ffd60a');
        r(14, 19, 1, 2, '#fff');
        r(17, 19, 1, 2, '#fff');
      },
    },
  };

  /* ============================== Collectibles ============================== */
  const COLLECTIBLE_ART = {
    coin: {
      name: 'Coin', points: 10, life: 0, anim: 'none', sound: 'coin',
      frames: [7, 5, 2, 5].map((rx) => (r, shape) => {
        shape(ellipse(16, 16, rx + 0.5, 9), '#e8a400');
        if (rx > 2) {
          shape(ellipse(16, 16, rx - 0.6, 7.8), '#ffd43b');
          shape(ellipse(16, 16, Math.max(rx - 3, 0.6), 5.5), '#fab005');
          r(16 - Math.max(1, rx - 4), 10, 1, 2, '#fff3bf');
        }
      }),
    },
    gem: {
      name: 'Gem', points: 25, life: 0, anim: 'bob', sound: 'chime',
      frames: [0, 1].map((f) => (r, shape) => {
        const test = (x, y) => {
          if (y >= 8 && y < 13) return Math.abs(x - 16) <= 6 + (y - 8) * 0.9;
          if (y >= 13 && y < 27) return Math.abs(x - 16) <= 10.5 * (27 - y) / 14;
          return false;
        };
        shape(test, '#1098ad');
        shape((x, y) => test(x, y) && x < 16 + (y < 13 ? 3 : 1), '#3bc9db');
        shape((x, y) => y >= 8 && y < 13 && test(x, y), '#99e9f2');
        r(f ? 18 : 12, f ? 10 : 9, 2, 2, '#fff');
        if (f) r(14, 16, 1, 1, '#e3fafc');
      }),
    },
    star: {
      name: 'Star', points: 50, life: 0, anim: 'pulse', sound: 'power',
      frames: [0, 1].map((f) => (r, shape) => {
        const o = f ? 13 : 12.5, i = f ? 5.6 : 5.2;
        shape(polygon(starPoints(16, 17, o, i)), '#f08c00');
        shape(polygon(starPoints(16, 17, o - 1.6, i - 0.9)), '#ffd43b');
        r(13, 15, 2, 3, '#7a4a00');
        r(18, 15, 2, 3, '#7a4a00');
        r(11, 9, 2, 2, '#fff3bf');
      }),
    },
    heart: {
      name: 'Heart', points: 0, life: 1, anim: 'bob', sound: 'power',
      frames: [9.5, 9].map((s) => (r, shape) => {
        const heart = (k) => (x, y) => {
          const X = (x - 16) / k, Y = -(y - 15) / k;
          const a = X * X + Y * Y - 1;
          return a * a * a - X * X * Y * Y * Y <= 0;
        };
        shape(heart(s + 1), '#c9184a');
        shape(heart(s), '#ff4d6d');
        r(10, 10, 3, 2, '#ffb3c1');
        r(10, 12, 1, 1, '#ffb3c1');
      }),
    },
  };

  /* ============================== Goals ============================== */
  const GOAL_ART = {
    flag: {
      name: 'Flag',
      frames: [0, 1].map((f) => (r, shape) => {
        const wave = (x) => Math.round(Math.sin((x - 10) / 3 + f * Math.PI) * 1.2);
        shape((x, y) => x >= 10 && x < 27 && y >= 4 + wave(x) && y < 17 + wave(x), '#2fb344');
        shape((x, y) => x >= 10 && x < 27 && y >= 14 + wave(x) && y < 17 + wave(x), '#238636');
        shape((x, y) => ellipse(18, 10 + wave(18), 3, 3)(x, y), '#fff');
        r(8, 3, 2, 27, '#dee2e6');
        r(9, 3, 1, 27, '#adb5bd');
        r(7, 1, 4, 3, '#ffd43b');
        r(5, 29, 8, 3, '#868e96');
        r(5, 29, 8, 1, '#adb5bd');
      }),
    },
    portal: {
      name: 'Portal',
      frames: [0, 1].map((f) => (r, shape) => {
        shape(ellipse(16, 17, 11, 14.5), '#5f3dc4');
        shape(ellipse(16, 17, 9, 12.5), '#845ef7');
        shape(ellipse(16, 17, f ? 7 : 6, f ? 10 : 11), '#b197fc');
        shape(ellipse(16, 17, f ? 4 : 5, f ? 7.5 : 6.5), '#e5dbff');
        shape(ellipse(16, 17, 2, 3), '#fff');
        r(f ? 7 : 24, 8, 2, 2, '#fff');
        r(f ? 23 : 8, 25, 1, 1, '#fff');
      }),
    },
  };

  /* ============================== Build library ============================== */
  const lib = { characters: {}, enemies: {}, collectibles: {}, goals: {} };

  for (const [key, def] of Object.entries(CHARACTER_ART)) {
    const frames = {};
    for (const [anim, poses] of Object.entries(POSES)) frames[anim] = poses.map((p) => make((r, shape) => def.draw(r, p, shape)));
    lib.characters[key] = { key, name: def.name, frames, fps: 8 };
  }
  for (const [key, def] of Object.entries(ENEMY_ART)) {
    lib.enemies[key] = { key, name: def.name, frames: [0, 1].map((f) => make((r, shape) => def.draw(r, shape, f))) };
  }
  for (const [key, def] of Object.entries(COLLECTIBLE_ART)) {
    lib.collectibles[key] = {
      key, name: def.name, points: def.points, life: def.life, anim: def.anim, sound: def.sound,
      frames: def.frames.map((fn) => make(fn)),
    };
  }
  for (const [key, def] of Object.entries(GOAL_ART)) {
    lib.goals[key] = { key, name: def.name, frames: def.frames.map((fn) => make(fn)) };
  }

  lib.canvas = canvas;
  PS.Sprites = lib;
})(window.PS);
