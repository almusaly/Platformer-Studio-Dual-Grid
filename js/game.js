/* =====================================================================
   Platformer Studio — play mode
   Physics & collision, player controller, enemy controller, collectibles,
   game state, gameplay camera, rendering and HUD.

   Play mode builds a separate runtime copy of the level. The editable
   project is never modified while playing.
   Physics runs at a fixed 120 steps per second; no body ever moves more
   than a few pixels per step, so nothing can tunnel through a tile.

   Iso mode has its own physics section: bodies move on the floor plan
   (x, y) and in height (z), and are drawn depth-sorted among the blocks.
   ===================================================================== */
(function (PS) {
  'use strict';

  const T = PS.TILE;
  const DT = 1 / 120;
  const MAX_FALL = 900;
  const { clamp, approach, $ } = PS.util;

  const PLAYER_W = 18, PLAYER_H = 28;
  const ENEMY_BOX = { slime: [24, 18], robot: [18, 26], spiky: [22, 22], flyer: [22, 16] };

  const ISO_SPEED = 0.75;   // floor-plan speed, so walking feels the same on the diagonal grid
  const ISO_PLAYER = { w: 16, h: 28 };
  const ISO_ENEMY = { slime: [20, 18], robot: [16, 26], spiky: [20, 22], flyer: [20, 16] };

  const keys = { left: false, right: false, up: false, down: false, jump: false, run: false };
  let jumpPressed = false;

  let rt = null;            // runtime state, rebuilt on every (re)start
  let raf = 0, last = 0, acc = 0, paused = false;
  let msgTimer = 0, hintTimer = 0;
  const hudCache = {};

  const P = () => PS.state.project;
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const overlap3 = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.w && a.y + a.w > b.y && a.z < b.z + b.h && a.z + a.h > b.z;
  const touches = (a, b) => (rt.iso ? overlap3(a, b) : overlap(a, b));

  /* ============================== Physics & collision ============================== */
  function solidAt(tx, ty) {
    if (tx < 0 || tx >= rt.w) return true;        // side walls at the map border
    if (ty < 0 || ty >= rt.h) return false;        // open sky above, pit below
    return rt.solid[ty * rt.w + tx] === 1;
  }

  /** Move a body horizontally and stop it at the first solid tile. Returns -1/1 on a hit. */
  function moveX(b, dx) {
    if (!dx) return 0;
    b.x += dx;
    const top = Math.floor(b.y / T), bot = Math.floor((b.y + b.h - 0.01) / T);
    if (dx > 0) {
      const tx = Math.floor((b.x + b.w - 0.01) / T);
      for (let ty = top; ty <= bot; ty++) if (solidAt(tx, ty)) { b.x = tx * T - b.w; return 1; }
    } else {
      const tx = Math.floor(b.x / T);
      for (let ty = top; ty <= bot; ty++) if (solidAt(tx, ty)) { b.x = (tx + 1) * T; return -1; }
    }
    return 0;
  }

  function moveY(b, dy) {
    if (!dy) return 0;
    b.y += dy;
    const left = Math.floor(b.x / T), right = Math.floor((b.x + b.w - 0.01) / T);
    if (dy > 0) {
      const ty = Math.floor((b.y + b.h - 0.01) / T);
      for (let tx = left; tx <= right; tx++) if (solidAt(tx, ty)) { b.y = ty * T - b.h; return 1; }
    } else {
      const ty = Math.floor(b.y / T);
      for (let tx = left; tx <= right; tx++) if (solidAt(tx, ty)) { b.y = (ty + 1) * T; return -1; }
    }
    return 0;
  }

  /* ============================== Iso physics ==============================
     A body has a square footprint (x, y, w) and a height range (z, z + h). */
  function isoSolid(tx, ty, level) {
    if (tx < 0 || ty < 0 || tx >= rt.w || ty >= rt.h) return true;   // walls at the map border
    if (level < 0) return rt.wld.hasFloor(tx, ty);
    return rt.wld.solidAt(tx, ty, level);
  }

  function isoHits(b) {
    const x1 = Math.floor((b.x + b.w - 0.01) / T), y1 = Math.floor((b.y + b.w - 0.01) / T);
    const l0 = Math.floor(b.z / T), l1 = Math.floor((b.z + b.h - 0.01) / T);
    for (let l = l0; l <= l1; l++) {
      for (let y = Math.floor(b.y / T); y <= y1; y++) {
        for (let x = Math.floor(b.x / T); x <= x1; x++) if (isoSolid(x, y, l)) return true;
      }
    }
    return false;
  }

  /** Move along one axis and stop at the first solid block. Returns -1/1 on a hit. */
  function isoMove(b, axis, d) {
    if (!d) return 0;
    b[axis] += d;
    if (!isoHits(b)) return 0;
    const size = axis === 'z' ? b.h : b.w;
    b[axis] = d > 0 ? Math.floor((b[axis] + size - 0.01) / T) * T - size : (Math.floor(b[axis] / T) + 1) * T;
    return d > 0 ? 1 : -1;
  }

  function isoCentre(b) {
    return PS.Iso.project(b.x + b.w / 2, b.y + b.w / 2, b.z + b.h / 2);
  }

  /* ============================== Runtime construction ============================== */
  function buildIso() {
    const p = P();
    const wld = PS.Iso.world();
    const sp = PS.Project.spawn();
    const player = {
      x: 0, y: 0, z: 0, w: ISO_PLAYER.w, h: ISO_PLAYER.h, vx: 0, vy: 0, vz: 0,
      onGround: false, facing: 1, coyote: 0, buffer: 0, jumps: 0, cut: false,
      invuln: 0, anim: 'idle', animT: 0, prevZ: 0,
    };
    const enemies = [], items = [];
    let goal = null;
    for (const o of p.objects) {
      const cx = (o.x + 0.5) * T, cy = (o.y + 0.5) * T;
      const top = wld.topAt(o.x, o.y);
      if (o.kind === 'enemy') {
        const [ew, eh] = ISO_ENEMY[o.type] || ISO_ENEMY.slime;
        const flying = o.type === 'flyer' || o.props.behavior === 'fly';
        enemies.push({
          type: o.type, behavior: o.props.behavior, flying,
          x: cx - ew / 2, y: cy - ew / 2, z: flying ? top + PS.Iso.FLY_HEIGHT : top, w: ew, h: eh,
          vx: 0, vy: 0, vz: 0, originX: cx - ew / 2,
          speed: o.props.speed * 20 * ISO_SPEED, dist: o.props.distance * T, range: o.props.range * T,
          dir: o.props.dir < 0 ? -1 : 1, face: o.props.dir < 0 ? -1 : 1,
          onGround: false, alive: true, deadT: 0, animT: Math.random(),
        });
      } else if (o.kind === 'collectible') {
        const def = PS.Assets.collectible(o.type);
        const z = top + PS.Iso.ITEM_HEIGHT;
        items.push({
          type: o.type, cx, cy, z,
          box: { x: cx - 10, y: cy - 10, w: 20, z: z - 6, h: 28 },
          points: o.props.points, life: def.life, anim: o.props.anim, sound: o.props.sound,
          taken: false, phase: (o.x * 7 + o.y * 3) % 10,
        });
      } else if (o.kind === 'goal') {
        goal = { type: o.type, cx, cy, z: top, box: { x: cx - 10, y: cy - 10, w: 20, z: top, h: T } };
      }
    }
    rt = {
      iso: true, wld, w: p.width, h: p.height, player, enemies, items, goal,
      spawn: sp ? { x: sp.x, y: sp.y } : { x: 0, y: 0 },
      score: 0, lives: p.game.lives, time: 0, collected: 0, totalItems: items.length, stomped: 0,
      status: 'playing', particles: [], texts: [], shake: 0, t: 0,
      cam: { x: 0, y: 0, look: 0 }, scale: 1,
    };
    placeAtSpawn();
    rt.scale = viewScale();
    updateCamera(0, true);
  }

  function build() {
    if (PS.Iso.active()) return buildIso();
    const p = P();
    const w = p.width, h = p.height;
    const solid = new Uint8Array(w * h);
    for (const l of p.layers) {
      if (l.type !== 'tiles' || !l.solid || !l.visible) continue;
      for (let i = 0; i < l.data.length; i++) if (l.data[i]) solid[i] = 1;
    }
    const sp = PS.Project.spawn();
    const player = {
      x: 0, y: 0, w: PLAYER_W, h: PLAYER_H, vx: 0, vy: 0,
      onGround: false, facing: 1, coyote: 0, buffer: 0, jumps: 0, cut: false,
      invuln: 0, anim: 'idle', animT: 0, prevBottom: 0,
    };
    const enemies = [], items = [];
    let goal = null;
    for (const o of p.objects) {
      if (o.kind === 'enemy') {
        const [ew, eh] = ENEMY_BOX[o.type] || ENEMY_BOX.slime;
        const flying = o.type === 'flyer' || o.props.behavior === 'fly';
        const x = o.x * T + (T - ew) / 2;
        const y = flying ? o.y * T + (T - eh) / 2 : o.y * T + T - eh;
        enemies.push({
          type: o.type, behavior: o.props.behavior, flying,
          x, y, w: ew, h: eh, vx: 0, vy: 0, originX: x,
          speed: o.props.speed * 20, dist: o.props.distance * T, range: o.props.range * T,
          dir: o.props.dir < 0 ? -1 : 1, face: o.props.dir < 0 ? -1 : 1,
          onGround: false, alive: true, deadT: 0, animT: Math.random(),
        });
      } else if (o.kind === 'collectible') {
        const def = PS.Assets.collectible(o.type);
        items.push({
          type: o.type, x: o.x * T, y: o.y * T,
          box: { x: o.x * T + 6, y: o.y * T + 6, w: T - 12, h: T - 12 },
          points: o.props.points, life: def.life, anim: o.props.anim, sound: o.props.sound,
          taken: false, phase: (o.x * 7 + o.y * 3) % 10,
        });
      } else if (o.kind === 'goal') {
        goal = { type: o.type, x: o.x * T, y: o.y * T, box: { x: o.x * T + 6, y: o.y * T + 2, w: T - 12, h: T - 2 } };
      }
    }
    rt = {
      w, h, solid, player, enemies, items, goal,
      spawn: sp ? { x: sp.x, y: sp.y } : { x: 0, y: 0 },
      score: 0, lives: p.game.lives, time: 0, collected: 0, totalItems: items.length, stomped: 0,
      status: 'playing', particles: [], texts: [], shake: 0, t: 0,
      cam: { x: 0, y: 0, look: 0 }, scale: 1,
    };
    placeAtSpawn();
    rt.scale = viewScale();
    updateCamera(0, true);
  }

  function placeAtSpawn() {
    const pl = rt.player;
    if (rt.iso) {
      pl.x = (rt.spawn.x + 0.5) * T - pl.w / 2;
      pl.y = (rt.spawn.y + 0.5) * T - pl.w / 2;
      pl.z = rt.wld.topAt(rt.spawn.x, rt.spawn.y);
      pl.vx = 0; pl.vy = 0; pl.vz = 0; pl.jumps = 0; pl.coyote = 0; pl.buffer = 0;
      pl.onGround = false;
      return;
    }
    pl.x = rt.spawn.x * T + (T - pl.w) / 2;
    pl.y = rt.spawn.y * T + T - pl.h;
    pl.vx = 0; pl.vy = 0; pl.jumps = 0; pl.coyote = 0; pl.buffer = 0;
    pl.onGround = false;
  }

  /* ============================== Player controller ============================== */
  function updatePlayer(dt) {
    const pl = rt.player, ph = P().physics;
    const dir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const maxS = keys.run ? ph.runSpeed : ph.walkSpeed;
    const accel = pl.onGround ? maxS * 11 : maxS * 7;
    const decel = pl.onGround ? maxS * 13 : maxS * 3;

    if (dir) {
      const turning = Math.sign(pl.vx) === -dir;
      pl.vx = approach(pl.vx, dir * maxS, (turning ? accel * 1.8 : accel) * dt);
      pl.facing = dir;
    } else {
      pl.vx = approach(pl.vx, 0, decel * dt);
    }

    // Jumping: coyote time, input buffering, double jump, variable height
    if (jumpPressed) pl.buffer = 0.13;
    if (pl.onGround) { pl.coyote = 0.1; pl.jumps = 0; }
    else {
      pl.coyote -= dt;
      if (pl.coyote <= 0 && pl.jumps === 0) pl.jumps = 1;   // walked off a ledge: only the air jump is left
    }
    if (pl.buffer > 0) {
      if (pl.coyote > 0) {
        pl.vy = -ph.jumpStrength;
        pl.jumps = 1; pl.coyote = 0; pl.buffer = 0; pl.onGround = false; pl.cut = true;
        PS.Sfx.play('jump');
        dust(pl.x + pl.w / 2, pl.y + pl.h, 5);
      } else if (jumpPressed && ph.doubleJump && pl.jumps < 2) {
        pl.vy = -ph.jumpStrength * 0.9;
        pl.jumps = 2; pl.buffer = 0; pl.cut = true;
        PS.Sfx.play('double');
        burst(pl.x + pl.w / 2, pl.y + pl.h, '#ffffff', 8, 60);
      }
    }
    pl.buffer -= dt;
    if (!keys.jump && pl.cut && pl.vy < 0) { pl.vy *= 0.5; pl.cut = false; }

    const g = ph.gravity * (pl.vy > 0 ? 1.15 : 1);
    pl.vy = Math.min(pl.vy + g * dt, MAX_FALL);

    pl.prevBottom = pl.y + pl.h;
    if (moveX(pl, pl.vx * dt)) pl.vx = 0;
    const wasGround = pl.onGround;
    const hitY = moveY(pl, pl.vy * dt);
    if (hitY > 0) {
      if (!wasGround && pl.vy > 300) dust(pl.x + pl.w / 2, pl.y + pl.h, 4);
      pl.vy = 0; pl.onGround = true; pl.cut = false;
    } else {
      if (hitY < 0) pl.vy = 0;
      pl.onGround = false;
    }
    if (pl.invuln > 0) pl.invuln -= dt;

    // Animation state
    const anim = !pl.onGround ? (pl.vy < 0 ? 'jump' : 'fall') : Math.abs(pl.vx) > 12 ? 'walk' : 'idle';
    if (anim !== pl.anim) { pl.anim = anim; pl.animT = 0; }
    pl.animT += dt;

    if (pl.y > rt.h * T + 64) fell();
  }

  function updatePlayerIso(dt) {
    const pl = rt.player, ph = P().physics;
    // Arrow keys follow the screen: right is +x -y on the floor plan, down is +x +y.
    const across = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    const along = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    let dx = across + along, dy = along - across;
    const len = Math.hypot(dx, dy);
    if (len) { dx /= len; dy /= len; }
    const maxS = (keys.run ? ph.runSpeed : ph.walkSpeed) * ISO_SPEED;
    const accel = pl.onGround ? maxS * 11 : maxS * 7;
    const decel = pl.onGround ? maxS * 13 : maxS * 3;
    const rate = (len ? accel : decel) * dt;
    pl.vx = approach(pl.vx, dx * maxS, rate);
    pl.vy = approach(pl.vy, dy * maxS, rate);
    if (Math.abs(pl.vx - pl.vy) > 10) pl.facing = pl.vx - pl.vy > 0 ? 1 : -1;

    if (jumpPressed) pl.buffer = 0.13;
    if (pl.onGround) { pl.coyote = 0.1; pl.jumps = 0; }
    else {
      pl.coyote -= dt;
      if (pl.coyote <= 0 && pl.jumps === 0) pl.jumps = 1;
    }
    if (pl.buffer > 0) {
      if (pl.coyote > 0) {
        pl.vz = ph.jumpStrength;
        pl.jumps = 1; pl.coyote = 0; pl.buffer = 0; pl.onGround = false; pl.cut = true;
        PS.Sfx.play('jump');
        const c = PS.Iso.project(pl.x + pl.w / 2, pl.y + pl.w / 2, pl.z);
        dust(c.x, c.y, 5);
      } else if (jumpPressed && ph.doubleJump && pl.jumps < 2) {
        pl.vz = ph.jumpStrength * 0.9;
        pl.jumps = 2; pl.buffer = 0; pl.cut = true;
        PS.Sfx.play('double');
        const c = PS.Iso.project(pl.x + pl.w / 2, pl.y + pl.w / 2, pl.z);
        burst(c.x, c.y, '#ffffff', 8, 60);
      }
    }
    pl.buffer -= dt;
    if (!keys.jump && pl.cut && pl.vz > 0) { pl.vz *= 0.5; pl.cut = false; }

    const g = ph.gravity * (pl.vz < 0 ? 1.15 : 1);
    pl.vz = Math.max(pl.vz - g * dt, -MAX_FALL);

    pl.prevZ = pl.z;
    if (isoMove(pl, 'x', pl.vx * dt)) pl.vx = 0;
    if (isoMove(pl, 'y', pl.vy * dt)) pl.vy = 0;
    const hitZ = isoMove(pl, 'z', pl.vz * dt);
    if (hitZ < 0) {
      if (!pl.onGround && pl.vz < -300) {
        const c = PS.Iso.project(pl.x + pl.w / 2, pl.y + pl.w / 2, pl.z);
        dust(c.x, c.y, 4);
      }
      pl.vz = 0; pl.onGround = true; pl.cut = false;
    } else {
      if (hitZ > 0) pl.vz = 0;
      pl.onGround = false;
    }
    if (pl.invuln > 0) pl.invuln -= dt;

    const moving = Math.hypot(pl.vx, pl.vy) > 12;
    const anim = !pl.onGround ? (pl.vz > 0 ? 'jump' : 'fall') : moving ? 'walk' : 'idle';
    if (anim !== pl.anim) { pl.anim = anim; pl.animT = 0; }
    pl.animT += dt;

    if (pl.z < -T * 2) fell();
  }

  function updateEnemiesIso(dt) {
    const pl = rt.player, g = P().physics.gravity, game = P().game;
    for (const e of rt.enemies) {
      if (!e.alive) { e.deadT += dt; continue; }
      e.animT += dt;
      const b = e.behavior;
      e.vy = 0;
      if (b === 'stationary') e.vx = 0;
      else if (b === 'patrol' || b === 'fly' || b === 'edge') e.vx = e.dir * e.speed;
      else if (b === 'chase') {
        const dx = pl.x - e.x, dy = pl.y - e.y;
        const dist = Math.hypot(dx, dy);
        if (dist < e.range && dist > 2) {
          e.vx = (dx / dist) * e.speed;
          e.vy = (dy / dist) * e.speed;
          if (!e.flying && e.onGround && isoLedge(e, Math.sign(e.vx), Math.sign(e.vy))) { e.vx = 0; e.vy = 0; }
        } else {
          e.vx = 0;
        }
      }
      if (!e.flying) e.vz = Math.max(e.vz - g * dt, -MAX_FALL);

      const hx = isoMove(e, 'x', e.vx * dt);
      if (hx && b !== 'chase') e.dir = -hx;
      isoMove(e, 'y', e.vy * dt);
      if (!e.flying) {
        const hz = isoMove(e, 'z', e.vz * dt);
        if (hz) e.vz = 0;
        e.onGround = hz < 0;
      }
      if ((b === 'patrol' || b === 'fly') && e.dist > 0) {
        if (e.x < e.originX - e.dist) { e.x = e.originX - e.dist; e.dir = 1; }
        else if (e.x > e.originX + e.dist) { e.x = e.originX + e.dist; e.dir = -1; }
      }
      if (b === 'edge' && e.onGround && isoLedge(e, e.dir, 0)) e.dir *= -1;
      const screenDir = e.vx - e.vy;
      if (Math.abs(screenDir) > 1) e.face = screenDir > 0 ? 1 : -1;
      else if (b === 'stationary' || b === 'chase') e.face = pl.x - pl.y < e.x - e.y ? -1 : 1;
      if (e.z < -T * 2) e.alive = false;

      if (rt.status !== 'playing') continue;
      const hit = { x: e.x + 2, y: e.y + 2, w: e.w - 4, z: e.z, h: e.h - 2 };
      if (!overlap3(pl, hit)) continue;
      const canStomp = game.stomp && e.type !== 'spiky';
      if (canStomp && pl.vz < -30 && pl.prevZ >= e.z + e.h - 8) {
        e.alive = false; e.deadT = 0;
        pl.vz = P().physics.jumpStrength * 0.65;
        pl.jumps = 1; pl.cut = false;
        rt.stomped++;
        PS.Sfx.play('stomp');
        const c = isoCentre(e);
        burst(c.x, c.y, '#ffffff', 10, 90);
      } else {
        hurt(e.x + e.w / 2, e.y + e.w / 2);
      }
    }
  }

  /** Is there nothing to stand on just ahead of this enemy? */
  function isoLedge(e, dirX, dirY) {
    const ax = dirX > 0 ? e.x + e.w + 1 : dirX < 0 ? e.x - 1 : e.x + e.w / 2;
    const ay = dirY > 0 ? e.y + e.w + 1 : dirY < 0 ? e.y - 1 : e.y + e.w / 2;
    return !isoSolid(Math.floor(ax / T), Math.floor(ay / T), Math.floor((e.z - 2) / T));
  }

  /* ============================== Enemy controller ============================== */
  function updateEnemies(dt) {
    const pl = rt.player, g = P().physics.gravity, game = P().game;
    const pcx = pl.x + pl.w / 2, pcy = pl.y + pl.h / 2;
    for (const e of rt.enemies) {
      if (!e.alive) { e.deadT += dt; continue; }
      e.animT += dt;
      const b = e.behavior;
      if (b === 'stationary') e.vx = 0;
      else if (b === 'patrol' || b === 'fly' || b === 'edge') e.vx = e.dir * e.speed;
      else if (b === 'chase') {
        const dx = pcx - (e.x + e.w / 2), dy = pcy - (e.y + e.h / 2);
        const dist = Math.hypot(dx, dy);
        if (dist < e.range && dist > 2) {
          if (Math.abs(dx) > 2) e.dir = Math.sign(dx);
          if (e.flying) { e.vx = (dx / dist) * e.speed; e.vy = (dy / dist) * e.speed; }
          else e.vx = Math.abs(dx) > 2 && !(e.onGround && ledgeAhead(e)) ? e.dir * e.speed : 0;
        } else {
          e.vx = 0;
          if (e.flying) e.vy = 0;
        }
      }
      if (!e.flying) e.vy = Math.min(e.vy + g * dt, MAX_FALL);
      else if (b !== 'chase') e.vy = 0;

      const hx = moveX(e, e.vx * dt);
      if (hx && b !== 'chase') e.dir = -hx;
      const hy = moveY(e, e.vy * dt);
      if (hy > 0) { e.vy = 0; e.onGround = true; } else { if (hy < 0) e.vy = 0; e.onGround = false; }

      if ((b === 'patrol' || b === 'fly') && e.dist > 0) {
        if (e.x < e.originX - e.dist) { e.x = e.originX - e.dist; e.dir = 1; }
        else if (e.x > e.originX + e.dist) { e.x = e.originX + e.dist; e.dir = -1; }
      }
      if (b === 'edge' && e.onGround && ledgeAhead(e)) e.dir *= -1;
      if (Math.abs(e.vx) > 1) e.face = Math.sign(e.vx);
      else if (b === 'stationary' || b === 'chase') e.face = pcx < e.x + e.w / 2 ? -1 : 1;
      if (e.y > rt.h * T + 64) e.alive = false;

      // Player contact
      if (rt.status !== 'playing') continue;
      const hit = { x: e.x + 2, y: e.y + 2, w: e.w - 4, h: e.h - 4 };
      if (!overlap(pl, hit)) continue;
      const canStomp = game.stomp && e.type !== 'spiky';
      if (canStomp && pl.vy > 30 && pl.prevBottom <= e.y + 8) {
        e.alive = false; e.deadT = 0;
        pl.vy = -P().physics.jumpStrength * 0.65;
        pl.jumps = 1; pl.cut = false;
        rt.stomped++;
        PS.Sfx.play('stomp');
        burst(e.x + e.w / 2, e.y + e.h / 2, '#ffffff', 10, 90);
      } else {
        hurt(e.x + e.w / 2);
      }
    }
  }

  function ledgeAhead(e) {
    const aheadX = e.dir > 0 ? e.x + e.w + 1 : e.x - 1;
    const footY = Math.floor((e.y + e.h + 2) / T);
    return !solidAt(Math.floor(aheadX / T), footY);
  }

  /* ============================== Collectibles & goal ============================== */
  function updateItems() {
    const pl = rt.player;
    for (const it of rt.items) {
      if (it.taken || !touches(pl, it.box)) continue;
      it.taken = true;
      rt.collected++;
      rt.score += it.points;
      if (it.life) { rt.lives += it.life; bump('hudLives'); }
      if (it.points) bump('hudScore');
      bump('hudItems');
      PS.Sfx.play(it.sound);
      const at = rt.iso ? PS.Iso.project(it.cx, it.cy, it.z + T / 2) : { x: it.x + T / 2, y: it.y + T / 2 };
      const cx = at.x, cy = at.y;
      burst(cx, cy, it.type === 'heart' ? '#ff4d6d' : it.type === 'gem' ? '#66d9e8' : '#ffd43b', 12, 110);
      const label = [it.points ? `+${it.points}` : '', it.life ? `+${it.life} ♥` : ''].filter(Boolean).join('  ');
      if (label) rt.texts.push({ x: cx, y: cy - 8, text: label, life: 0.9, max: 0.9 });
    }
  }

  function checkGoal() {
    const g = rt.goal;
    if (!g || !touches(rt.player, g.box)) return;
    const rules = P().game;
    if (rules.winCondition === 'all' && rt.collected < rt.totalItems) {
      return showMsg(`Collect every item first: ${rt.totalItems - rt.collected} left`);
    }
    if (rules.winCondition === 'score' && rt.score < rules.requiredScore) {
      return showMsg(`You need ${rules.requiredScore} points to finish (you have ${rt.score})`);
    }
    win();
  }

  /* ============================== Game state ============================== */
  function hurt(fromX, fromY) {
    const pl = rt.player;
    if (pl.invuln > 0 || rt.status !== 'playing') return;
    rt.lives--;
    bump('hudLives');
    rt.shake = 0.25;
    PS.Sfx.play('hurt');
    const c = rt.iso ? isoCentre(pl) : { x: pl.x + pl.w / 2, y: pl.y + pl.h / 2 };
    burst(c.x, c.y, '#ff5c7a', 10, 120);
    if (rt.lives <= 0) return lose();
    pl.invuln = 1.6;
    if (rt.iso) {
      const dx = pl.x + pl.w / 2 - fromX, dy = pl.y + pl.w / 2 - fromY;
      const len = Math.hypot(dx, dy) || 1;
      pl.vx = (dx / len) * 200;
      pl.vy = (dy / len) * 200;
      pl.vz = 280;
      pl.onGround = false;
      pl.cut = false;
      return;
    }
    pl.vx = (pl.x + pl.w / 2 < fromX ? -1 : 1) * 240;
    pl.vy = -280;
    pl.onGround = false;
    pl.cut = false;
  }

  function fell() {
    rt.lives--;
    bump('hudLives');
    PS.Sfx.play('hurt');
    if (rt.lives <= 0) {
      if (rt.iso) rt.hidePlayer = true;
      else { rt.player.y = rt.h * T + 64; rt.player.vy = 0; }
      return lose();
    }
    placeAtSpawn();
    rt.player.invuln = 1.6;
    showMsg('Oops! Back to the start');
  }

  function win() {
    rt.status = 'won';
    PS.Sfx.play('win');
    const g = rt.goal;
    const gp = rt.iso ? PS.Iso.project(g.cx, g.cy, g.z + T / 2) : { x: g.x + T / 2, y: g.y + T / 2 };
    for (let i = 0; i < 50; i++) {
      const colors = ['#ffd43b', '#ff6b81', '#4fe0c4', '#8b7bff', '#ffffff'];
      rt.particles.push({
        x: gp.x, y: gp.y,
        vx: (Math.random() - 0.5) * 360, vy: -Math.random() * 380 - 80,
        life: 1.4, max: 1.4, color: colors[i % colors.length], size: 2 + (i % 2), gravity: 500,
      });
    }
    setTimeout(() => { if (rt && rt.status === 'won') showOverlay('won'); }, 650);
  }

  function lose() {
    rt.status = 'lost';
    PS.Sfx.play('lose');
    setTimeout(() => { if (rt && rt.status === 'lost') showOverlay('lost'); }, 500);
  }

  /* ============================== Effects ============================== */
  function burst(x, y, color, n, speed) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const v = speed * (0.5 + Math.random() * 0.6);
      rt.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 30, life: 0.5, max: 0.5, color, size: 2, gravity: 300 });
    }
  }

  function dust(x, y, n) {
    for (let i = 0; i < n; i++) {
      rt.particles.push({ x: x + (Math.random() - 0.5) * 12, y: y - 1, vx: (Math.random() - 0.5) * 60, vy: -Math.random() * 40, life: 0.35, max: 0.35, color: 'rgba(255,255,255,0.8)', size: 2, gravity: 0 });
    }
  }

  function updateEffects(dt) {
    for (const p of rt.particles) { p.life -= dt; p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    rt.particles = rt.particles.filter((p) => p.life > 0);
    for (const t of rt.texts) { t.life -= dt; t.y -= 30 * dt; }
    rt.texts = rt.texts.filter((t) => t.life > 0);
    if (rt.shake > 0) rt.shake = Math.max(0, rt.shake - dt);
  }

  /* ============================== Camera ============================== */
  function viewScale() {
    const R = PS.Renderer, p = P();
    const W = R.canvas.width, H = R.canvas.height;
    if (rt && rt.iso) {
      const b = PS.Iso.bounds();
      const fit = Math.min(W / Math.min(b.w, 20 * T), H / Math.min(b.h, 12 * T));
      return fit >= 1 ? Math.floor(fit) : fit;
    }
    // Show roughly 20 × 12 tiles (or the whole level if smaller) at a whole-number scale.
    const visW = Math.min(p.width * T, 20 * T), visH = Math.min(p.height * T, 12 * T);
    const fit = Math.min(W / visW, H / visH);
    return fit >= 1 ? Math.floor(fit) : fit;
  }

  function updateCamera(dt, snap) {
    const R = PS.Renderer, p = P(), pl = rt.player, s = rt.scale;
    const vw = R.canvas.width / s, vh = R.canvas.height / s;
    if (rt.iso) {
      const b = PS.Iso.bounds();
      const c = isoCentre(pl);
      let tx = c.x - vw / 2, ty = c.y - vh / 2;
      tx = b.w <= vw ? b.x + (b.w - vw) / 2 : clamp(tx, b.x, b.x + b.w - vw);
      ty = b.h <= vh ? b.y + (b.h - vh) / 2 : clamp(ty, b.y, b.y + b.h - vh);
      if (snap || !p.game.cameraSmoothing) { rt.cam.x = tx; rt.cam.y = ty; return; }
      const k = 1 - Math.exp(-dt * 7);
      rt.cam.x += (tx - rt.cam.x) * k;
      rt.cam.y += (ty - rt.cam.y) * k;
      return;
    }
    const lw = p.width * T, lh = p.height * T;
    rt.cam.look = snap ? 0 : approach(rt.cam.look, clamp(pl.vx * 0.25, -40, 40), 120 * dt);
    let tx = pl.x + pl.w / 2 - vw / 2 + rt.cam.look;
    let ty = pl.y + pl.h / 2 - vh * 0.55;
    tx = lw <= vw ? (lw - vw) / 2 : clamp(tx, 0, lw - vw);
    ty = lh <= vh ? (lh - vh) / 2 : clamp(ty, 0, lh - vh);
    if (snap || !p.game.cameraSmoothing) { rt.cam.x = tx; rt.cam.y = ty; return; }
    const k = 1 - Math.exp(-dt * 7);
    rt.cam.x += (tx - rt.cam.x) * k;
    rt.cam.y += (ty - rt.cam.y) * k;
  }

  /* ============================== Rendering ============================== */
  function render() {
    const R = PS.Renderer, ctx = R.ctx, p = P();
    const W = R.canvas.width, H = R.canvas.height, s = rt.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const sky = p.level.sky;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, sky);
    grad.addColorStop(1, shade(sky, 0.25));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    let camX = rt.cam.x, camY = rt.cam.y;
    if (rt.shake > 0) { camX += (Math.random() - 0.5) * rt.shake * 16; camY += (Math.random() - 0.5) * rt.shake * 16; }
    camX = Math.round(camX * s) / s;
    camY = Math.round(camY * s) / s;

    if (rt.iso) {
      drawIsoWorld(ctx, camX, camY, s, W, H);
    } else {
      // Parallax reference: layers line up at the level's left/bottom edge.
      const vw = W / s, vh = H / s, lw = p.width * T, lh = p.height * T;
      const refX = lw <= vw ? (lw - vw) / 2 : 0;
      const refY = lh <= vh ? (lh - vh) / 2 : lh - vh;

      const drawLayer = (c, layer, a) => {
        if (layer.type !== 'tiles') return drawEntities(c, camX, camY, s);
        const d = PS.Project.layerSpeed(layer), drift = PS.Project.layerDrift(layer);
        const lx = refX + (camX - refX) * d - rt.t * drift, ly = refY + (camY - refY) * d;
        const draw = drift || PS.Project.layerRepeat(layer) ? R.drawTileLayerRepeat : R.drawTileLayer;
        draw(c, layer, Math.round(lx * s) / s, Math.round(ly * s) / s, s, W, H, a);
      };
      const shown = p.layers.filter((l) => l.visible);
      shown.forEach((layer, i) => {
        R.drawWithShadow(ctx, layer, R.shadowCasters(shown, i), W, H, s, layer.type === 'tiles' ? layer.opacity : 1, drawLayer);
      });
      if (!PS.Project.objectsLayer()) drawEntities(ctx, camX, camY, s);
    }

    // Floating score text, always on top
    ctx.font = `800 ${Math.round(10 * s)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of rt.texts) {
      const a = clamp(t.life / t.max * 1.5, 0, 1);
      const x = Math.round((t.x - camX) * s), y = Math.round((t.y - camY) * s);
      ctx.globalAlpha = a;
      ctx.lineWidth = Math.max(2, s * 1.2);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(t.text, x, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(t.text, x, y);
    }
    ctx.globalAlpha = 1;
  }

  function drawEntities(ctx, camX, camY, s) {
    const R = PS.Renderer, p = P(), t = rt.t;
    if (rt.goal) {
      const frames = PS.Assets.goal(rt.goal.type).frames;
      R.drawSprite(ctx, frames[Math.floor(t * 3) % frames.length], rt.goal.x, rt.goal.y, camX, camY, s);
    }
    for (const it of rt.items) {
      if (it.taken) continue;
      const def = PS.Assets.collectible(it.type);
      const tt = t + it.phase;
      const frame = def.frames[Math.floor(tt * 6) % def.frames.length];
      let oy = 0, sx = 1, sy = 1;
      if (it.anim === 'bob') oy = Math.round(Math.sin(tt * 3) * 2);
      else if (it.anim === 'pulse') { sx = sy = 1 + Math.sin(tt * 5) * 0.08; oy = Math.round((1 - sy) * -16); }
      else if (it.anim === 'spin') sx = Math.max(0.12, Math.abs(Math.cos(tt * 3)));
      R.drawSprite(ctx, frame, it.x, it.y + oy, camX, camY, s, false, 1, sx, sy);
    }
    for (const e of rt.enemies) {
      if (!e.alive && e.deadT > 0.35) continue;
      const frames = PS.Assets.enemy(e.type).frames;
      const frame = frames[Math.floor(e.animT * 4) % frames.length];
      const wx = e.x + e.w / 2 - 16;
      const wy = e.flying ? e.y + e.h / 2 - 16 : e.y + e.h - 32;
      if (e.alive) R.drawSprite(ctx, frame, wx, wy, camX, camY, s, e.face < 0);
      else R.drawSprite(ctx, frame, wx, wy, camX, camY, s, e.face < 0, 1 - e.deadT / 0.35, 1.2, 0.35);
    }
    drawPlayer(ctx, camX, camY, s);
    drawParticles(ctx, camX, camY, s);
  }

  function drawParticles(ctx, camX, camY, s) {
    for (const pt of rt.particles) {
      ctx.globalAlpha = clamp(pt.life / pt.max * 1.4, 0, 1);
      ctx.fillStyle = pt.color;
      const size = Math.max(1, Math.round(pt.size * s));
      ctx.fillRect(Math.round((pt.x - camX) * s), Math.round((pt.y - camY) * s), size, size);
    }
    ctx.globalAlpha = 1;
  }

  /** The whole iso scene: blocks and entities sorted by depth, each with its shadow. */
  function drawIsoWorld(ctx, camX, camY, s, W, H) {
    const Iso = PS.Iso, p = P(), t = rt.t, wld = rt.wld;
    const list = [];
    if (rt.goal) {
      const frames = PS.Assets.goal(rt.goal.type).frames;
      list.push(Iso.entity({ cx: rt.goal.cx, cy: rt.goal.cy, z: rt.goal.z, size: 18, frame: frames[Math.floor(t * 3) % frames.length], shadow: p.iso.shadowObjects, wld }));
    }
    for (const it of rt.items) {
      if (it.taken) continue;
      const def = PS.Assets.collectible(it.type);
      const tt = t + it.phase;
      let oy = 0, sx = 1, sy = 1;
      if (it.anim === 'bob') oy = Math.round(Math.sin(tt * 3) * 2);
      else if (it.anim === 'pulse') { sx = sy = 1 + Math.sin(tt * 5) * 0.08; oy = Math.round((1 - sy) * -16); }
      else if (it.anim === 'spin') sx = Math.max(0.12, Math.abs(Math.cos(tt * 3)));
      list.push(Iso.entity({ cx: it.cx, cy: it.cy, z: it.z, size: 10, frame: def.frames[Math.floor(tt * 6) % def.frames.length], oy, sx, sy, shadow: p.iso.shadowObjects, wld }));
    }
    for (const e of rt.enemies) {
      if (!e.alive && e.deadT > 0.35) continue;
      const frames = PS.Assets.enemy(e.type).frames;
      const frame = frames[Math.floor(e.animT * 4) % frames.length];
      const box = { cx: e.x + e.w / 2, cy: e.y + e.w / 2, z: e.z, size: e.w, frame, flip: e.face < 0, wld };
      if (e.alive) list.push(Iso.entity({ ...box, shadow: p.iso.shadowNpc }));
      else list.push(Iso.entity({ ...box, alpha: 1 - e.deadT / 0.35, sx: 1.2, sy: 0.35 }));
    }
    const pl = rt.player;
    if (!rt.hidePlayer && !(pl.invuln > 0 && Math.floor(pl.invuln * 12) % 2)) {
      const { frame, oy } = playerFrame();
      list.push(Iso.entity({ cx: pl.x + pl.w / 2, cy: pl.y + pl.w / 2, z: pl.z, size: pl.w, frame, oy, flip: pl.facing < 0, shadow: p.iso.shadowPlayer, wld }));
    }
    Iso.drawScene(ctx, { camX, camY, s, W, H, wld, entities: list });
    drawParticles(ctx, camX, camY, s);
  }

  function drawPlayer(ctx, camX, camY, s) {
    const pl = rt.player;
    if (rt.status === 'lost' && pl.y > rt.h * T) return;
    if (pl.invuln > 0 && Math.floor(pl.invuln * 12) % 2) return;
    const { frame, oy } = playerFrame();
    PS.Renderer.drawSprite(ctx, frame, pl.x + pl.w / 2 - 16, pl.y + pl.h - 32 + oy, camX, camY, s, pl.facing < 0);
  }

  function playerFrame() {
    const pl = rt.player;
    const ch = PS.Assets.character(P().character);
    const list = ch.frames[pl.anim] || ch.frames.idle;
    let fps = ch.fps;
    if (pl.anim === 'idle') fps = ch.fps * 0.35;
    if (pl.anim === 'walk') fps = ch.fps * clamp(Math.hypot(pl.vx, rt.iso ? pl.vy : 0) / (P().physics.walkSpeed * (rt.iso ? ISO_SPEED : 1)), 0.6, 2);
    const frame = list[Math.floor(pl.animT * fps) % list.length];
    let oy = 0;
    if (ch.fallback) {
      // Custom art without animation frames: a gentle 1px bob, never stretched.
      if (pl.anim === 'walk') oy = Math.floor(pl.animT * 10) % 2 ? -1 : 0;
      else if (pl.anim === 'idle') oy = Math.floor(pl.animT * 2) % 2 ? 1 : 0;
    }
    return { frame, oy };
  }

  function shade(hex, amount) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const f = (c) => Math.round(c + (255 - c) * amount);
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  /* ============================== HUD & overlays ============================== */
  function setHud(id, value) {
    if (hudCache[id] === value) return;
    hudCache[id] = value;
    $('#' + id).textContent = value;
  }

  function updateHud() {
    setHud('hudScore', String(rt.score));
    setHud('hudLives', String(Math.max(0, rt.lives)));
    setHud('hudTime', PS.util.formatTime(rt.time));
    setHud('hudItems', `${rt.collected}/${rt.totalItems}`);
  }

  function bump(id) {
    const pill = $('#' + id) && $('#' + id).parentElement;
    if (!pill) return;
    pill.classList.remove('bump');
    void pill.offsetWidth;
    pill.classList.add('bump');
  }

  function showMsg(text, ms = 1600) {
    const el = $('#gameMsg');
    if (!el.hidden && el.textContent === text) { clearTimeout(msgTimer); msgTimer = setTimeout(() => { el.hidden = true; }, ms); return; }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function showOverlay(kind) {
    const el = PS.util.el;
    const card = $('#overlayCard');
    card.replaceChildren();
    const stats = () => el('div', { class: 'overlay-stats' },
      el('div', null, el('b', { text: String(rt.score) }), el('span', { text: 'Points' })),
      el('div', null, el('b', { text: `${rt.collected}/${rt.totalItems}` }), el('span', { text: 'Items' })),
      el('div', null, el('b', { text: PS.util.formatTime(rt.time) }), el('span', { text: 'Time' })));
    const btn = (label, cls, fn) => el('button', { class: 'btn ' + cls, text: label, onclick: fn });
    if (kind === 'won') {
      card.append(
        el('div', { class: 'ov-emoji', text: '🏆' }),
        el('h2', { text: 'Level complete!' }),
        el('p', { text: rt.stomped ? `Great run! You bounced on ${rt.stomped === 1 ? 'an enemy' : rt.stomped + ' enemies'}.` : 'Great run! You reached the goal.' }),
        stats(),
        el('div', { class: 'actions' }, btn('Return to editor', '', () => Game.stop()), btn('Play again', 'primary', () => Game.restart())));
    } else if (kind === 'lost') {
      card.append(
        el('div', { class: 'ov-emoji', text: '💫' }),
        el('h2', { text: 'Out of lives' }),
        el('p', { text: 'Don’t give up. Try again, or tweak the level in the editor.' }),
        stats(),
        el('div', { class: 'actions' }, btn('Return to editor', '', () => Game.stop()), btn('Try again', 'primary', () => Game.restart())));
    } else {
      card.append(
        el('div', { class: 'ov-emoji', text: '⏸' }),
        el('h2', { text: 'Paused' }),
        el('p', { text: 'Take a breather.' }),
        el('div', { class: 'actions' }, btn('Restart', '', () => Game.restart()), btn('Editor', '', () => Game.stop()), btn('Resume', 'primary', () => Game.togglePause())));
    }
    $('#gameOverlay').hidden = false;
    const primary = card.querySelector('.btn.primary');
    if (primary) primary.focus();
  }

  function hideOverlay() { $('#gameOverlay').hidden = true; }

  /* ============================== Loop ============================== */
  function step(dt) {
    rt.t += dt;
    if (rt.status === 'playing') {
      rt.time += dt;
      if (rt.iso) { updatePlayerIso(dt); updateEnemiesIso(dt); }
      else { updatePlayer(dt); updateEnemies(dt); }
      updateItems();
      checkGoal();
    } else {
      for (const e of rt.enemies) if (!e.alive) e.deadT += dt;
    }
    updateEffects(dt);
    updateCamera(dt, false);
    jumpPressed = false;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;
    if (!paused) {
      acc += dt;
      while (acc >= DT) { step(DT); acc -= DT; }
    }
    render();
    updateHud();
  }

  function resetKeys() {
    keys.left = keys.right = keys.up = keys.down = keys.jump = keys.run = false;
    jumpPressed = false;
  }

  /* ============================== Public API ============================== */
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'jump', KeyW: 'jump', Space: 'jump', ShiftLeft: 'run', ShiftRight: 'run',
  };
  const KEYMAP_ISO = { ...KEYMAP, ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down' };
  const keyFor = (code) => (rt && rt.iso ? KEYMAP_ISO : KEYMAP)[code];

  const Game = {
    get running() { return PS.state.mode === 'play'; },

    /** Check the level before playing. Returns false if it can't be played. */
    validate() {
      const sp = PS.Project.spawn();
      if (!sp) {
        PS.UI.toast('Place a player start first: pick a hero in the Characters panel, then click the map.', 'warn', { duration: 4500 });
        PS.UI.flashSection('secCharacters');
        PS.Tools.setPlaceItem({ kind: 'spawn' });
        return false;
      }
      const p = P();
      const solid = PS.Project.tileLayers().filter((l) => l.solid && l.visible);
      const hasGround = solid.some((l) => PS.Project.layerTileCount(l) > 0);
      if (PS.Iso.active()) {
        if (p.iso.pits && !PS.Iso.world().hasFloor(sp.x, sp.y)) {
          PS.UI.toast('The player start is over a pit. Draw ground under it, or turn off "Empty cells are pits" in Settings.', 'warn', { duration: 5000 });
        } else if (!PS.Project.goal()) {
          PS.UI.toast('No goal yet. You can explore, but there is no way to win. Add one from the Goal panel.', 'info', { duration: 4000 });
        }
      } else if (!hasGround) {
        PS.UI.toast('There is no solid ground yet, so your hero will fall. Draw on a solid layer such as Terrain.', 'warn', { duration: 4500 });
      } else if (solid.some((l) => l.data[sp.y * p.width + sp.x])) {
        PS.UI.toast('The player start is inside solid terrain. Move it to an empty cell.', 'warn', { duration: 4500 });
      } else if (!PS.Project.goal()) {
        PS.UI.toast('No goal yet. You can explore, but there is no way to win. Add one from the Goal panel.', 'info', { duration: 4000 });
      }
      return true;
    },

    start() {
      if (Game.running || !Game.validate()) return;
      PS.Tools.cancel();
      PS.Tools.hover = null;
      PS.state.mode = 'play';
      document.body.classList.add('playing');
      paused = false;
      acc = 0;
      resetKeys();
      for (const k in hudCache) delete hudCache[k];
      build();
      hideOverlay();
      $('#hud').hidden = false;
      $('#welcome').hidden = true;
      $('#emptyHint').hidden = true;
      const hint = $('#controlsHint');
      const kbd = (t) => PS.util.el('kbd', { text: t });
      const row = (keysList, label) => PS.util.el('span', null, keysList.map(kbd), ' ' + label);
      hint.replaceChildren(
        rt.iso ? row(['←', '↑', '↓', '→'], 'move') : row(['←', '→'], 'move'),
        row(['Space'], 'jump (twice to double jump)'), row(['Shift'], 'run'), row(['Esc'], 'editor'));
      hint.hidden = false;
      hint.classList.remove('fade');
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => hint.classList.add('fade'), 4500);
      PS.Sfx.unlock();
      PS.bus.emit('mode');
      last = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
      PS.Renderer.canvas.focus({ preventScroll: true });
    },

    stop() {
      if (!Game.running) return;
      cancelAnimationFrame(raf);
      raf = 0;
      rt = null;
      paused = false;
      resetKeys();
      PS.state.mode = 'edit';
      document.body.classList.remove('playing');
      $('#hud').hidden = true;
      $('#gameMsg').hidden = true;
      $('#controlsHint').hidden = true;
      hideOverlay();
      PS.bus.emit('mode');
      PS.Renderer.request();
    },

    restart() {
      if (!Game.running) return;
      paused = false;
      acc = 0;
      resetKeys();
      build();
      hideOverlay();
      $('#gameMsg').hidden = true;
      PS.bus.emit('mode');
      PS.Renderer.canvas.focus({ preventScroll: true });
    },

    get paused() { return paused; },

    togglePause() {
      if (!Game.running || !rt || rt.status !== 'playing') return;
      paused = !paused;
      resetKeys();
      if (paused) showOverlay('paused');
      else { hideOverlay(); last = performance.now(); PS.Renderer.canvas.focus({ preventScroll: true }); }
      PS.bus.emit('mode');
    },

    onResize() {
      if (!rt) return;
      rt.scale = viewScale();
      updateCamera(0, true);
    },

    /** Returns true when the key was used by the game. */
    keyDown(e) {
      if (e.code === 'Escape') { Game.stop(); return true; }
      if (e.code === 'KeyP') { Game.togglePause(); return true; }
      if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey) { Game.restart(); return true; }
      const k = keyFor(e.code);
      if (!k) return false;
      if (k === 'jump' && !keys.jump && !e.repeat) jumpPressed = true;
      keys[k] = true;
      return true;
    },

    keyUp(e) {
      const k = keyFor(e.code);
      if (!k) return false;
      keys[k] = false;
      return true;
    },

    blur() { resetKeys(); },

    /** Read-only summary of the running game, handy for debugging in the console. */
    inspect() {
      if (!rt) return null;
      const pl = rt.player;
      return {
        status: rt.status, score: rt.score, lives: rt.lives, collected: rt.collected, time: rt.time,
        iso: !!rt.iso,
        player: { x: pl.x, y: pl.y, z: pl.z, vx: pl.vx, vy: pl.vy, vz: pl.vz, onGround: pl.onGround },
        enemies: rt.enemies.map((e) => ({ type: e.type, x: e.x, y: e.y, z: e.z, alive: e.alive })),
      };
    },
  };

  PS.Game = Game;
})(window.PS);
