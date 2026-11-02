/* =====================================================================
   Platformer Studio — right sidebar: contextual properties
   Shows only what matters for the current selection or tool.
   ===================================================================== */
(function (PS) {
  'use strict';

  const { el, $ } = PS.util;
  const st = PS.state;
  const UI = () => PS.UI;
  const openDetails = { enemy: false, item: false };

  const objChange = (label, fn) => {
    PS.History.change(label, fn, 'objects');
    Panel.render();
    PS.Renderer.request();
  };

  function header(frame, title, sub) {
    return el('div', { class: 'obj-header' },
      UI().spriteThumb(frame, 48, 'checker-bg'),
      el('div', null, el('div', { class: 'obj-title', text: title }), el('div', { class: 'obj-sub', text: sub })));
  }

  function deleteButton(o, label) {
    return el('button', { class: 'btn danger block', onclick: () => PS.Tools.deleteObject(o.id), 'data-tip': 'Delete (Del key)' },
      el('span', { html: PS.icon('trash', 14) }), label);
  }

  function details(key, title, children) {
    const d = el('details', { class: 'adv', open: openDetails[key] || null },
      el('summary', null, el('span', { html: PS.icon('chevron', 14) }), title),
      el('div', { class: 'stack' }, children));
    d.addEventListener('toggle', () => { openDetails[key] = d.open; });
    return d;
  }

  const where = (o) => `Column ${o.x + 1}, row ${o.y + 1}`;

  /* ------------------------------ Object editors ------------------------------ */
  function spawnEditor(o) {
    const p = st.project;
    const ch = PS.Assets.character(p.character);
    return [
      header(ch.frames.idle[0], 'Player start', where(o)),
      el('div', { class: 'stack' },
        UI().selectField('Character', PS.Assets.characterList().map((c) => ({ value: c.key, label: c.name })), p.character, (v) => {
          objChange('Change character', () => { p.character = v; });
          PS.AssetsPanel.renderCharacters();
        }),
        el('p', { class: 'hint', text: 'The hero appears here when you press Play. Drag it to move it. Movement feel can be tuned in Settings.' }),
        deleteButton(o, 'Remove player start')),
    ];
  }

  function goalEditor(o) {
    const g = st.project.game;
    const rule = g.winCondition === 'all' ? 'Collect every item, then reach the goal.'
      : g.winCondition === 'score' ? `Reach ${g.requiredScore} points, then reach the goal.` : 'Reach the goal to win.';
    return [
      header(PS.Assets.goal(o.type).frames[0], 'Goal', where(o)),
      el('div', { class: 'stack' },
        el('div', { class: 'field' }, el('span', { text: 'Look' }),
          UI().segmented(PS.Assets.goalList().map((d) => ({ value: d.key, label: d.name })), o.type, (v) => objChange('Change goal look', () => { o.type = v; }))),
        el('div', { class: 'behavior-desc', text: rule }),
        el('button', { class: 'btn sm', onclick: () => PS.Settings.open('rules') }, el('span', { html: PS.icon('flag', 14) }), 'Change winning rules'),
        deleteButton(o, 'Remove goal')),
    ];
  }

  function enemyEditor(o) {
    const pr = o.props;
    const b = pr.behavior;
    const beh = PS.Project.ENEMY_BEHAVIORS.find((x) => x.key === b);
    const fine = [];
    if (b !== 'stationary') {
      fine.push(UI().rangeField('Speed', { min: 1, max: 10, value: pr.speed, ends: ['Slow', 'Fast'], onchange: (v) => objChange('Change enemy speed', () => { pr.speed = v; }) }));
    }
    if (b === 'patrol' || b === 'fly') {
      fine.push(UI().rangeField('Patrol distance', {
        min: 0, max: 20, value: pr.distance, format: (v) => (v ? `${v} ${v === 1 ? 'tile' : 'tiles'} each way` : 'until a wall'),
        onchange: (v) => objChange('Change patrol distance', () => { pr.distance = v; }),
      }));
    }
    if (b === 'patrol' || b === 'fly' || b === 'edge') {
      fine.push(el('div', { class: 'field' }, el('span', { text: 'Starts moving' }),
        UI().segmented([{ value: -1, label: '← Left' }, { value: 1, label: 'Right →' }], pr.dir, (v) => objChange('Change direction', () => { pr.dir = v; }))));
    }
    if (b === 'chase') {
      fine.push(UI().rangeField('Notices the player within', {
        min: 1, max: 20, value: pr.range, format: (v) => `${v} tiles`,
        onchange: (v) => objChange('Change detection range', () => { pr.range = v; }),
      }));
    }
    return [
      header(PS.Assets.enemy(o.type).frames[0], PS.Assets.enemy(o.type).name, where(o)),
      el('div', { class: 'stack' },
        UI().selectField('Enemy type', PS.Assets.enemyList().map((e) => ({ value: e.key, label: e.name })), o.type, (v) => objChange('Change enemy type', () => { o.type = v; })),
        UI().selectField('Behaviour', PS.Project.ENEMY_BEHAVIORS.map((x) => ({ value: x.key, label: x.name })), b, (v) => objChange('Change behaviour', () => { pr.behavior = v; })),
        el('div', { class: 'behavior-desc', text: beh ? beh.desc : '' }),
        o.type === 'spiky' ? el('p', { class: 'hint warn', text: 'Spiky can’t be defeated by jumping on it.' }) : null,
        fine.length ? details('enemy', 'Fine-tune movement', fine) : null,
        deleteButton(o, 'Delete enemy')),
    ];
  }

  function itemEditor(o) {
    const pr = o.props;
    const def = PS.Assets.collectible(o.type);
    return [
      header(def.frames[0], def.name, where(o)),
      el('div', { class: 'stack' },
        UI().selectField('Item', PS.Assets.collectibleList().map((c) => ({ value: c.key, label: c.name })), o.type, (v) => {
          const nd = PS.Assets.collectible(v);
          objChange('Change item', () => { o.type = v; pr.points = nd.points; pr.anim = nd.anim; pr.sound = nd.sound; });
        }),
        def.life ? el('div', { class: 'behavior-desc', text: 'Gives the player one extra life.' }) : null,
        UI().numberField(def.life ? 'Bonus points' : 'Points', pr.points, { min: 0, max: 100000 }, (v) => objChange('Change points', () => { pr.points = v; }), 'Added to the score when collected'),
        details('item', 'Animation & sound', [
          UI().selectField('Animation', [
            { value: 'none', label: 'None' }, { value: 'bob', label: 'Float up and down' },
            { value: 'spin', label: 'Spin' }, { value: 'pulse', label: 'Pulse' },
          ], pr.anim, (v) => objChange('Change animation', () => { pr.anim = v; })),
          el('div', { class: 'row' },
            UI().selectField('Sound', PS.Sfx.NAMES.map((s) => ({ value: s.key, label: s.name })), pr.sound, (v) => { objChange('Change sound', () => { pr.sound = v; }); PS.Sfx.play(v); }),
            el('button', { class: 'icon-btn', 'data-tip': 'Preview sound', 'aria-label': 'Preview sound', html: PS.icon('volume', 16), onclick: () => PS.Sfx.play(pr.sound) })),
        ]),
        deleteButton(o, 'Delete item')),
    ];
  }

  /* ------------------------------ Other contexts ------------------------------ */
  function selectionEditor(sel) {
    const layer = PS.Project.activeTileLayer();
    const T = PS.Tools;
    const btn = (icon, label, fn, tip) => el('button', { class: 'btn sm', onclick: fn, 'data-tip': tip }, el('span', { html: PS.icon(icon, 14) }), label);
    return [
      el('div', { class: 'stack' },
        el('div', { class: 'behavior-desc', text: `${sel.w} × ${sel.h} tiles selected${layer ? ` on “${layer.name}”` : ''}. Drag inside it to move the tiles.` }),
        el('div', { class: 'btn-row' },
          btn('copy', 'Copy', () => T.copy(), 'Copy (Ctrl+C)'),
          btn('cut', 'Cut', () => T.cut(), 'Cut (Ctrl+X)'),
          btn('dup', 'Paste', () => T.paste(), 'Paste at the mouse or selection (Ctrl+V)')),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn sm danger', onclick: () => T.clearSelection(), 'data-tip': 'Delete tiles (Del)' }, el('span', { html: PS.icon('trash', 14) }), 'Clear'),
          btn('x', 'Deselect', () => T.deselect(), 'Deselect (Esc)'))),
    ];
  }

  function placeInfo(item) {
    let frame, name, text;
    if (item.kind === 'spawn') {
      const ch = PS.Assets.character(st.project.character);
      frame = ch.frames.idle[0]; name = ch.name || 'Player';
      text = PS.Project.spawn() ? 'Click the map to move the player start.' : 'Click the map to set where the player starts.';
    } else if (item.kind === 'goal') {
      frame = PS.Assets.goal(item.type).frames[0]; name = PS.Assets.goal(item.type).name;
      text = PS.Project.goal() ? 'Click the map to move the goal. There is one goal per level.' : 'Click the map to place the goal.';
    } else if (item.kind === 'enemy') {
      const e = PS.Assets.enemy(item.type);
      frame = e.frames[0]; name = e.name;
      text = 'Click empty cells to place. Click one you placed to change its behaviour. Right-click removes.';
    } else {
      const c = PS.Assets.collectible(item.type);
      frame = c.frames[0]; name = c.name;
      text = `Worth ${c.life ? '+1 life' : c.points + ' points'}. Click empty cells to place as many as you like. Right-click removes.`;
    }
    return [header(frame, name, 'Placing'), el('p', { class: 'hint', text })];
  }

  function checklist() {
    const p = st.project;
    const solid = PS.Project.tileLayers().some((l) => l.solid && PS.Project.layerTileCount(l) > 0);
    const items = p.objects.filter((o) => o.kind === 'collectible').length;
    const enemies = p.objects.filter((o) => o.kind === 'enemy').length;
    const steps = [
      { done: solid, label: 'Draw some solid ground', go: () => { PS.UI.flashSection('secTilesets'); PS.Tools.setTool('pencil'); } },
      { done: !!PS.Project.spawn(), label: 'Place the player start', go: () => { PS.UI.flashSection('secCharacters'); PS.Tools.setPlaceItem({ kind: 'spawn' }); } },
      { done: items > 0, label: 'Add collectibles', optional: true, go: () => { PS.UI.flashSection('secCollectibles'); PS.Tools.setPlaceItem({ kind: 'collectible', type: 'coin' }); } },
      { done: enemies > 0, label: 'Add enemies', optional: true, go: () => { PS.UI.flashSection('secEnemies'); PS.Tools.setPlaceItem({ kind: 'enemy', type: 'slime' }); } },
      { done: !!PS.Project.goal(), label: 'Set a goal', go: () => { PS.UI.flashSection('secGoal'); PS.Tools.setPlaceItem({ kind: 'goal', type: 'flag' }); } },
    ];
    const allDone = steps.every((s) => s.done || s.optional);
    return [
      el('div', { class: 'props-empty' },
        el('div', { class: 'big-icon', html: PS.icon(allDone ? 'play' : 'pointer', 20) }),
        el('strong', { text: allDone ? 'Ready to play!' : 'Level checklist' }),
        el('span', { text: allDone ? 'Press Play or Enter to test your level.' : 'Click any step to jump to it. Click objects on the map to edit them.' })),
      el('div', { class: 'stack', style: 'gap:4px;margin-top:10px' }, steps.map((s) => el('button', {
        class: 'btn sm', style: 'justify-content:flex-start;' + (s.done ? 'opacity:.7' : ''), onclick: s.go,
      }, el('span', { html: PS.icon(s.done ? 'check' : 'target', 14), style: s.done ? 'color:var(--success)' : '' }), s.label + (s.optional ? ' (optional)' : '')))),
      el('p', { class: 'hint', style: 'text-align:center', text: `${PS.util.plural(PS.Project.totalTiles(), 'tile')} · ${PS.util.plural(items, 'item')} · ${enemies} ${enemies === 1 ? 'enemy' : 'enemies'}` }),
    ];
  }

  /* ------------------------------ Panel ------------------------------ */
  const Panel = {
    render() {
      const box = $('#props');
      const title = $('#propsTitle');
      const o = st.selectedObjectId ? PS.Project.object(st.selectedObjectId) : null;
      if (!o && st.selectedObjectId) st.selectedObjectId = 0;
      let content, t = 'Properties';
      if (o) {
        if (o.kind === 'spawn') content = spawnEditor(o);
        else if (o.kind === 'goal') content = goalEditor(o);
        else if (o.kind === 'enemy') content = enemyEditor(o);
        else content = itemEditor(o);
        t = 'Selected';
      } else if (st.selection) {
        content = selectionEditor(st.selection);
        t = 'Selection';
      } else if (st.tool === 'place' && st.placeItem) {
        content = placeInfo(st.placeItem);
        t = 'Placing';
      } else {
        content = checklist();
        t = 'Your level';
      }
      title.textContent = t;
      box.replaceChildren(...content);
      PS.hydrateIcons(box);
    },
  };

  PS.PropsPanel = Panel;
})(window.PS);
