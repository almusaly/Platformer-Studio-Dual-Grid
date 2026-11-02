/* =====================================================================
   Platformer Studio — seam healing
   Rebuilds the painted area instead of tinting it, in the two steps real
   healing tools use:

   1. Texture synthesis (after Harrison's "Resynthesizer"): the area is
      filled from its edges inward. Each pixel copies the surrounding pixel
      whose neighbourhood best matches what is already there, and carries
      on from where its neighbours copied. A second pass then corrects the
      first with every pixel known, which repairs where the fills meet.

   2. Poisson image editing (Pérez, Gangnet & Blake, 2003): the colours are
      solved so the new texture keeps its detail yet meets the untouched art
      exactly at the edge. Colour differences are only ever taken from inside
      a piece of source texture, so the jump where two pieces join, like the
      original seam, simply isn't there to reproduce.

   Unknowns are sheet pixels, not map positions. One sheet pixel shown in
   several places is one unknown, so its neighbours in all those places
   count, and a tile that repeats comes out seamless with itself.

   Empty pixels in the stroke are rebuilt like any other, and transparency
   is solved along with the colours, so a hole fills in without a ring
   around it. Empty pixels outside the stroke are left out altogether: they
   are never copied from, and the new art doesn't fade towards them.
   ===================================================================== */
(function (PS) {
  'use strict';

  const WINDOW = 3;           // how far around a pixel to compare, in steps of `stride`
  const RANDOM_TRIES = 24;    // places to try per pixel, besides continuing from its neighbours
  const JUMP_HANDICAP = 1.6;
  const MISSING = 3 * 255 * 255;
  const MAX_ITERATIONS = 500;
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const AROUND = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

  /** Solve the colours by conjugate gradient, one channel at a time. */
  function solve(count, edges, diag, rhs, guess) {
    const r = new Float64Array(count), z = new Float64Array(count), p = new Float64Array(count), q = new Float64Array(count);
    const x = Float64Array.from(guess);
    const apply = (v, out) => {
      for (let i = 0; i < count; i++) out[i] = diag[i] * v[i];
      for (let k = 0; k < edges.length; k += 2) { out[edges[k]] -= v[edges[k + 1]]; out[edges[k + 1]] -= v[edges[k]]; }
    };
    apply(x, q);
    let rz = 0;
    for (let i = 0; i < count; i++) { r[i] = rhs[i] - q[i]; z[i] = r[i] / diag[i]; p[i] = z[i]; rz += r[i] * z[i]; }
    for (let it = 0; it < MAX_ITERATIONS && rz > 1e-3 * count; it++) {
      apply(p, q);
      let pq = 0;
      for (let i = 0; i < count; i++) pq += p[i] * q[i];
      if (pq <= 0) break;
      const alpha = rz / pq;
      let next = 0;
      for (let i = 0; i < count; i++) {
        x[i] += alpha * p[i];
        r[i] -= alpha * q[i];
        z[i] = r[i] / diag[i];
        next += r[i] * z[i];
      }
      const beta = next / rz;
      rz = next;
      for (let i = 0; i < count; i++) p[i] = z[i] + beta * p[i];
    }
    return x;
  }

  const Heal = {
    /** Rebuild an area. region: { x0, y0, w, h } on the surface; mask: 1 for pixels in the brush stroke.
     *  map(x, y): the sheet pixel shown at a surface position, as { ts, x, y, cell }, or null.
     *  read(m): that pixel's [r, g, b, a]. canEdit(m): may it change?
     *  stride: comparison spacing, so large sheets compare features rather than single pixels.
     *  Returns the new colours as [{ ts, x, y, r, g, b, a }], or nothing if there is no art to copy from. */
    run({ region, mask, map, read, canEdit, stride = 1 }) {
      const { x0, y0, w, h } = region;
      const size = w * h;
      const node = new Int32Array(size).fill(-1);
      const known = new Uint8Array(size);
      const cells = new Float64Array(size);
      const colors = new Float32Array(size * 4);
      const pixels = new Array(size);
      const keys = new Float64Array(size);
      const ids = new Map();
      const tsIndex = new Map();

      for (let g = 0; g < size; g++) {
        const m = map(x0 + (g % w), y0 + Math.floor(g / w));
        if (!m) continue;
        const c = read(m);
        if (!c) continue;
        if (!tsIndex.has(m.ts)) tsIndex.set(m.ts, tsIndex.size);
        pixels[g] = m;
        keys[g] = tsIndex.get(m.ts) * 1e8 + m.y * 8192 + m.x + 1;
        cells[g] = m.cell;
        colors[g * 4] = c[0]; colors[g * 4 + 1] = c[1]; colors[g * 4 + 2] = c[2]; colors[g * 4 + 3] = c[3];
        if (mask[g] && canEdit(m) && !ids.has(keys[g])) ids.set(keys[g], ids.size);
      }
      const count = ids.size;
      if (!count) return [];

      const rep = new Int32Array(count).fill(-1);
      for (let g = 0; g < size; g++) {
        if (!pixels[g]) continue;
        const id = ids.get(keys[g]);
        if (id === undefined) {
          if (colors[g * 4 + 3]) known[g] = 1; else pixels[g] = undefined;
          continue;
        }
        node[g] = id;
        // Prefer a place in the stroke as the one to compare around.
        if (rep[id] < 0 || (mask[g] && !mask[rep[id]])) rep[id] = g;
      }

      /* ---------- 1. Texture synthesis ---------- */
      const out = new Float32Array(count * 4);
      const source = new Int32Array(count).fill(-1);
      const filled = new Uint8Array(count);
      const inBox = (g, dx, dy) => { const x = g % w + dx, y = Math.floor(g / w) + dy; return x >= 0 && y >= 0 && x < w && y < h; };

      // A pixel touching another tile is part of a cut, so it isn't texture to copy from.
      const usable = [];
      const clean = new Uint8Array(size);
      for (let g = 0; g < size; g++) {
        if (!known[g]) continue;
        let onCut = false;
        for (const [dx, dy] of SIDES) {
          if (inBox(g, dx, dy) && pixels[g + dx + dy * w] && cells[g + dx + dy * w] !== cells[g]) onCut = true;
        }
        if (!onCut) { clean[g] = 1; usable.push(g); }
      }
      // With no art around the stroke, the art inside it is all there is to copy.
      if (!usable.length) {
        for (let g = 0; g < size; g++) if (pixels[g] && colors[g * 4 + 3]) { clean[g] = 1; usable.push(g); }
      }
      if (!usable.length) return [];

      const offsets = [];
      for (let dy = -WINDOW; dy <= WINDOW; dy++) for (let dx = -WINDOW; dx <= WINDOW; dx++) {
        if (dx || dy) offsets.push([dx * stride, dy * stride]);
      }
      const colorOf = (g) => {
        if (known[g]) return g;
        const id = node[g];
        return id >= 0 && filled[id] ? -1 - id : null;
      };
      const channel = (ref, c) => (ref >= 0 ? colors[ref * 4 + c] : out[(-1 - ref) * 4 + c]);
      const cost = (target, cand, limit) => {
        let sum = 0;
        for (const [dx, dy] of offsets) {
          if (!inBox(target, dx, dy)) continue;
          const ref = colorOf(target + dx + dy * w);
          if (ref === null) continue;
          if (!inBox(cand, dx, dy) || !known[cand + dx + dy * w]) { sum += MISSING; }
          else {
            const s = cand + dx + dy * w;
            for (let c = 0; c < 4; c++) { const d = channel(ref, c) - colors[s * 4 + c]; sum += d * d; }
          }
          if (sum >= limit) return sum;
        }
        return sum;
      };

      // Fill from the edges inward, so each pixel has something to match.
      const order = [];
      const queued = new Uint8Array(count);
      let front = [];
      for (let g = 0; g < size; g++) {
        const id = node[g];
        if (id < 0 || queued[id]) continue;
        if (SIDES.some(([dx, dy]) => inBox(g, dx, dy) && known[g + dx + dy * w])) { queued[id] = 1; front.push(id); }
      }
      const occurrences = Array.from({ length: count }, () => []);
      for (let g = 0; g < size; g++) if (node[g] >= 0) occurrences[node[g]].push(g);
      while (front.length) {
        const next = [];
        for (const id of front) {
          order.push(id);
          for (const g of occurrences[id]) for (const [dx, dy] of SIDES) {
            if (!inBox(g, dx, dy)) continue;
            const other = node[g + dx + dy * w];
            if (other >= 0 && !queued[other]) { queued[other] = 1; next.push(other); }
          }
        }
        front = next;
      }
      for (let id = 0; id < count; id++) if (!queued[id]) order.push(id);

      const synthesize = () => {
        for (const id of order) {
          const target = rep[id];
          let best = source[id], bestCost = best >= 0 ? cost(target, best, Infinity) : Infinity;
          const consider = (cand, handicap = 1) => {
            if (cand === best || cand < 0 || cand >= size || !clean[cand]) return;
            const c = cost(target, cand, bestCost / handicap) * handicap;
            if (c < bestCost) { bestCost = c; best = cand; }
          };
          // Carry on from where the neighbours copied, which keeps shapes whole.
          for (const [dx, dy] of AROUND) {
            if (!inBox(target, dx, dy)) continue;
            const g = target + dx + dy * w;
            const from = known[g] ? g : node[g] >= 0 ? source[node[g]] : -1;
            if (from >= 0 && inBox(from, -dx, -dy)) consider(from - dx - dy * w);
          }
          // Jumping elsewhere must be clearly better, so copied pieces stay large and whole.
          for (let k = 0; k < RANDOM_TRIES; k++) consider(usable[Math.floor(Math.random() * usable.length)], JUMP_HANDICAP);
          source[id] = best;
          for (let c = 0; c < 4; c++) out[id * 4 + c] = colors[best * 4 + c];
          filled[id] = 1;
        }
      };
      synthesize();   // inward from the edges
      synthesize();   // again with everything filled in, which repairs where the fills meet

      /* ---------- 2. Poisson solve ---------- */
      const EPSILON = 1e-3;    // keeps the system solvable where a stroke touches no fixed pixels
      const diag = new Float64Array(count).fill(EPSILON);
      const rhs = [new Float64Array(count), new Float64Array(count), new Float64Array(count), new Float64Array(count)];
      for (let c = 0; c < 4; c++) for (let id = 0; id < count; id++) rhs[c][id] = EPSILON * out[id * 4 + c];
      const edges = [];
      const sameTexture = (a, b) => a >= 0 && b >= 0 && clean[a] && clean[b] && cells[a] === cells[b];

      /** The colour difference wanted between two neighbours, from what they copied. */
      const wanted = (sa, dx, dy, c) => {
        if (sa < 0 || !inBox(sa, dx, dy)) return 0;
        const sb = sa + dx + dy * w;
        if (!known[sb] || !sameTexture(sa, sb)) return 0;
        return colors[sa * 4 + c] - colors[sb * 4 + c];
      };

      for (let g = 0; g < size; g++) {
        if (!pixels[g]) continue;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          if (!inBox(g, dx, dy)) continue;
          const o = g + dx + dy * w;
          if (!pixels[o]) continue;
          const a = node[g], b = node[o];
          if (a < 0 && b < 0) continue;
          if (a >= 0 && b >= 0) {
            if (a === b) continue;
            diag[a]++; diag[b]++;
            edges.push(a, b);
            // Each side says what its own source does here. Where two copied pieces join, any jump
            // between them isn't in either source, so it vanishes while the texture carries on.
            for (let c = 0; c < 4; c++) {
              const v = (wanted(source[a], dx, dy, c) - wanted(source[b], -dx, -dy, c)) / 2;
              rhs[c][a] += v; rhs[c][b] -= v;
            }
          } else if (a >= 0) {
            diag[a]++;
            for (let c = 0; c < 4; c++) rhs[c][a] += colors[o * 4 + c] + wanted(source[a], dx, dy, c);
          } else {
            diag[b]++;
            for (let c = 0; c < 4; c++) rhs[c][b] += colors[g * 4 + c] + wanted(source[b], -dx, -dy, c);
          }
        }
      }
      const channels = [0, 1, 2, 3].map((c) => solve(count, edges, diag, rhs[c], Float64Array.from({ length: count }, (_, id) => out[id * 4 + c])));

      const result = new Array(count);
      for (let id = 0; id < count; id++) {
        const m = pixels[rep[id]];
        result[id] = { ts: m.ts, x: m.x, y: m.y, r: channels[0][id], g: channels[1][id], b: channels[2][id], a: channels[3][id] };
      }
      return result;
    },
  };

  PS.Heal = Heal;
})(window.PS);
