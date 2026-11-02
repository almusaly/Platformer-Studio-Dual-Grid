/* =====================================================================
   Platformer Studio — right sidebar: layer manager UI
   The list shows the top layer first (like most art apps); the project
   stores layers bottom-to-top. Grouped layers sit together under a header
   and share one scroll speed, so they move together. Dragging the header
   moves the whole group in the list.
   ===================================================================== */
(function (PS) {
  'use strict';

  const { el, $ } = PS.util;
  const st = PS.state;
  const UI = () => PS.UI;
  let dragId = 0;
  let dragGroupId = 0;

  function setActive(id) {
    if (st.activeLayerId === id) return;
    st.activeLayerId = id;
    Panel.render();
    PS.Renderer.request();
    PS.App.updateStatus();
  }

  function metaChanged() {
    PS.App.documentChanged('meta');
    Panel.render();
    PS.Renderer.request();
  }

  /** Rename a layer or a group. */
  function startRename(row, layer) {
    const name = row.querySelector('.lname');
    const input = el('input', { class: 'lname-input', value: layer.name, maxlength: 30, 'aria-label': 'Layer name' });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = PS.util.cleanName(input.value, layer.name, 30);
      if (save && v !== layer.name) PS.History.change('Rename layer', () => { layer.name = v; }, 'layers');
      Panel.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    name.replaceWith(input);
    input.focus();
    input.select();
  }

  /** Move a layer next to another one. `join` overrides the group it ends up in. */
  function reorder(dragged, target, above, join) {
    if (dragged === target) return;
    PS.History.change('Reorder layers', () => {
      const p = st.project;
      const d = PS.Project.layer(dragged);
      const rest = p.layers.filter((l) => l.id !== dragged);
      const t = rest.findIndex((l) => l.id === target);
      if (!d || t < 0) return false;
      rest.splice(above ? t + 1 : t, 0, d);
      const sameGroup = join === undefined || d.type !== 'tiles' || d.groupId === join;
      if (sameGroup && rest.every((l, i) => l === p.layers[i])) return false;
      p.layers = rest;
      // Dropping next to a grouped layer joins its group; next to an ungrouped one leaves it.
      if (d.type === 'tiles') {
        const t2 = PS.Project.layer(target);
        d.groupId = join !== undefined ? join : t2 ? t2.groupId : 0;
      }
      PS.Project.tidyGroups();
    }, 'layers');
    Panel.render();
  }

  /** Drop a layer on a group's header: above it, just inside it, or below it when it is collapsed. */
  function dropLayerOnHeader(id, g, above) {
    const others = PS.Project.groupLayers(g.id).filter((l) => l.id !== id);
    if (!others.length) return;
    const top = others[others.length - 1];
    if (above) reorder(id, top.id, true, 0);
    else if (g.collapsed) reorder(id, others[0].id, false, 0);
    else reorder(id, top.id, true, g.id);
  }

  function reorderGroup(id, target, above) {
    PS.History.change('Reorder layers', () => PS.Project.placeGroup(id, target, above), 'layers');
    Panel.render();
  }

  function moveGroupBy(g, delta) {
    PS.History.change(delta > 0 ? 'Move group up' : 'Move group down', () => PS.Project.moveGroup(g.id, delta), 'layers');
    Panel.render();
  }

  function clearDropMarks() {
    for (const r of $('#layerList').querySelectorAll('.drop-before, .drop-after')) r.classList.remove('drop-before', 'drop-after');
  }

  /** A group lands outside any other group, so mark that whole group's top or bottom edge. */
  function markDrop(row, targetGroup, above) {
    clearDropMarks();
    let mark = row;
    if (dragGroupId && targetGroup) {
      const rows = $('#layerList').querySelectorAll(`[data-group="${targetGroup}"]`);
      mark = above ? rows[0] : rows[rows.length - 1];
    }
    mark.classList.add(above ? 'drop-before' : 'drop-after');
  }

  /** Let a list row accept dragged layers and groups. `onDrop` gets (layerId, groupId, above). */
  function acceptDrops(row, targetGroup, onDrop) {
    const isAbove = (e) => {
      const r = row.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    };
    row.addEventListener('dragover', (e) => {
      if (!dragId && !dragGroupId) return;
      if (dragGroupId && dragGroupId === targetGroup) return;
      e.preventDefault();
      markDrop(row, targetGroup, isAbove(e));
    });
    row.addEventListener('dragleave', clearDropMarks);
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = dragId;
      const groupId = dragGroupId;
      dragId = 0;
      dragGroupId = 0;
      if (id || groupId) onDrop(id, groupId, isAbove(e));
    });
  }

  function changeGroup(layer, value) {
    PS.History.change(value ? 'Group layers' : 'Remove layer from group', () => {
      if (!value) {
        layer.groupId = 0;
      } else if (value.startsWith('g')) {
        const g = PS.Project.group(Number(value.slice(1)));
        if (!g) return false;
        layer.groupId = g.id;
      } else {
        const other = PS.Project.layer(Number(value.slice(1)));
        if (!other) return false;
        layer.groupId = 0;
        PS.Project.groupWith(layer, other);
      }
      PS.Project.tidyGroups();
    }, 'layers');
    Panel.render();
    PS.Renderer.invalidateAll();
    if (PS.Settings.isOpen) PS.Settings.render();
  }

  function ungroup(g) {
    PS.History.change(`Ungroup “${g.name}”`, () => {
      for (const l of PS.Project.groupLayers(g.id)) { l.groupId = 0; l.depth = g.depth; l.drift = g.drift; l.repeat = g.repeat; }
      PS.Project.tidyGroups();
    }, 'layers');
    Panel.render();
    if (PS.Settings.isOpen) PS.Settings.render();
  }

  function groupHeader(g) {
    const members = PS.Project.groupLayers(g.id);
    const allHidden = members.every((l) => !l.visible);
    const locked = members.some((l) => PS.Project.speedLocked(l));
    const layers = st.project.layers;
    const row = el('li', {
      class: 'layer-row group-row' + (allHidden ? ' hidden-layer' : ''),
      draggable: true, dataset: { group: g.id },
      onclick: () => setActive(members[0].id),
      ondblclick: () => startRename(row, g),
    },
      el('span', { class: 'grip', html: PS.icon('grip', 14), 'data-tip': 'Drag to move the whole group' }),
      el('button', {
        class: 'icon-btn group-chev' + (g.collapsed ? ' closed' : ''), 'data-tip': g.collapsed ? 'Show the layers in this group' : 'Hide the layers in this group', 'aria-label': 'Toggle group',
        html: PS.icon('chevron', 14),
        onclick: (e) => { e.stopPropagation(); g.collapsed = !g.collapsed; metaChanged(); },
      }),
      el('button', {
        class: 'icon-btn' + (allHidden ? ' off' : ''), 'data-tip': allHidden ? 'Show group' : 'Hide group',
        'aria-label': allHidden ? 'Show group' : 'Hide group', html: PS.icon(allHidden ? 'eyeOff' : 'eye', 15),
        onclick: (e) => { e.stopPropagation(); for (const l of members) l.visible = allHidden; metaChanged(); PS.Renderer.invalidateAll(); },
      }),
      el('span', { class: 'lname', text: g.name, 'data-tip': 'Double-click to rename' }),
      el('span', { class: 'tag speed', text: locked ? '1×' : `${g.depth.toFixed(2)}×`, 'data-tip': 'These layers move together at this speed' }),
      el('button', {
        class: 'icon-btn', 'data-tip': 'Move group up (draw in front)', 'aria-label': 'Move group up', html: PS.icon('up', 14),
        disabled: layers[layers.length - 1].groupId === g.id,
        onclick: (e) => { e.stopPropagation(); moveGroupBy(g, 1); },
      }),
      el('button', {
        class: 'icon-btn', 'data-tip': 'Move group down (draw behind)', 'aria-label': 'Move group down', html: PS.icon('down', 14),
        disabled: layers[0].groupId === g.id,
        onclick: (e) => { e.stopPropagation(); moveGroupBy(g, -1); },
      }),
      el('button', {
        class: 'icon-btn', 'data-tip': 'Ungroup: the layers keep their settings but move separately', 'aria-label': 'Ungroup', html: PS.icon('unlink', 14),
        onclick: (e) => { e.stopPropagation(); ungroup(g); },
      }));

    row.addEventListener('dragstart', (e) => {
      dragGroupId = g.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', g.name);
    });
    row.addEventListener('dragend', () => { dragGroupId = 0; Panel.renderList(); });
    acceptDrops(row, g.id, (id, groupId, above) => {
      if (groupId) reorderGroup(groupId, members[0].id, above);
      else dropLayerOnHeader(id, g, above);
    });
    return row;
  }

  function formatSpeed(v) {
    return (v < 0.97 ? 'far' : v > 1.03 ? 'near' : 'with camera') + ` (${v.toFixed(2)}×)`;
  }

  /** Scroll speed, drift and repeat, for a layer or the group it belongs to. */
  function parallaxControls(layer) {
    const p = st.project;
    const locked = PS.Project.speedLocked(layer);
    const g = layer.groupId ? PS.Project.group(layer.groupId) : null;
    const owner = g || layer;
    const others = p.layers.filter((l) => l !== layer && l.type === 'tiles' && !l.groupId);
    const options = [
      { value: '', label: 'Moves on its own' },
      ...p.groups.map((x) => ({ value: 'g' + x.id, label: `In group: ${x.name}` })),
      ...others.map((l) => ({ value: 'l' + l.id, label: `Group with: ${l.name}` })),
    ];
    const notice = !p.level.parallax
      ? 'Parallax is turned off for this level. Turn it on in Settings.'
      : p.view === 'iso'
        ? 'Parallax is used in the 2D view. In iso, layers sit at real heights instead.'
        : null;
    return el('details', { class: 'adv', open: true },
      el('summary', null, el('span', { html: PS.icon('chevron', 14) }), 'Movement'),
      el('div', { class: 'stack' },
        options.length > 1 ? UI().selectField('Moves with', options, g ? 'g' + g.id : '', (v) => changeGroup(layer, v), 'Grouped layers share one speed, so they stay together') : null,
        locked
          ? el('p', { class: 'hint', text: g ? 'This group has a solid layer, so it follows the camera exactly. What you see always matches what you can stand on.' : 'Solid layers follow the camera exactly, so what you see always matches what you can stand on.' })
          : el('div', { class: 'stack' },
            liveRange(owner, 'depth', 'Speed', {
              min: 0.1, max: 1.5, step: 0.05, format: formatSpeed, ends: ['Far, moves slowly', 'Near, moves fast'], preview: true,
            }),
            liveRange(owner, 'drift', 'Drift by itself', {
              min: -60, max: 60, step: 2, format: (v) => (v ? `${Math.abs(v)} px/s ${v < 0 ? 'left' : 'right'}` : 'off'), ends: ['Left', 'Right'], preview: true,
            }),
            UI().switchRow('Repeat sideways', 'The layer wraps around, so it never runs out', owner.repeat, (on) => {
              PS.History.change('Change layer repeat', () => { owner.repeat = on; }, 'layers');
              Panel.renderProps();
            }),
            el('button', { class: 'btn sm', onclick: () => PS.Renderer.previewParallax() }, el('span', { html: PS.icon('play', 13) }), 'Preview the movement')),
        notice ? el('p', { class: 'hint', text: notice }) : null));
  }

  /** The shadow a layer casts on the visible layers below it. */
  function shadowControls(layer) {
    const p = st.project;
    const below = p.layers.slice(0, p.layers.indexOf(layer)).reverse().filter((l) => l.visible).slice(0, layer.shadowReach);
    const offset = (v) => `${v} px`;
    const originalColor = layer.shadowColor;
    const notice = p.view === 'iso'
      ? 'Layer shadows are used in the 2D view. In iso, shadows sit under characters and objects instead.'
      : below.length ? `Falls only on ${below.map((l) => `“${l.name}”`).join(', ')}, and only where there are pixels.` : 'There is no visible layer below for this shadow to fall on.';
    return el('details', { class: 'adv', open: true },
      el('summary', null, el('span', { html: PS.icon('chevron', 14) }), 'Shadow'),
      el('div', { class: 'stack' },
        UI().switchRow('Cast a shadow', 'Onto the layers below', layer.shadowOn, (on) => {
          PS.History.change(on ? 'Turn layer shadow on' : 'Turn layer shadow off', () => { layer.shadowOn = on; }, 'layers');
          Panel.renderProps();
        }),
        layer.shadowOn ? el('div', { class: 'stack' },
          UI().numberField('Layers it reaches', layer.shadowReach, { min: 1, max: PS.LIMITS.maxLayers - 1 }, (v) => {
            PS.History.change('Change layer shadow reach', () => { layer.shadowReach = v; }, 'layers');
            Panel.renderProps();
          }, 'How many visible layers below this one catch the shadow'),
          el('div', { class: 'row', style: 'align-items:center' },
            el('div', { class: 'switch-text', style: 'flex:1' }, el('span', { text: 'Colour' })),
            el('input', {
              type: 'color', value: layer.shadowColor, 'aria-label': 'Shadow colour',
              oninput: (e) => { layer.shadowColor = e.target.value; PS.Renderer.request(); },
              onchange: (e) => {
                const v = e.target.value;
                layer.shadowColor = originalColor;
                PS.History.change('Change layer shadow colour', () => { layer.shadowColor = v; }, 'layers');
                Panel.renderProps();
              },
            })),
          liveRange(layer, 'shadowOpacity', 'Shadow strength', { min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + '%' }),
          liveRange(layer, 'shadowX', 'Sideways', { min: -32, max: 32, step: 1, format: offset, ends: ['Left', 'Right'] }),
          liveRange(layer, 'shadowY', 'Up and down', { min: -32, max: 32, step: 1, format: offset, ends: ['Up', 'Down'] }),
          liveRange(layer, 'shadowBlur', 'Softness', { min: 0, max: 16, step: 1, format: (v) => (v ? `${v} px` : 'crisp') })) : null,
        el('p', { class: 'hint', text: notice })));
  }

  /** Height controls shown in the iso view. */
  function isoControls(layer) {
    return el('details', { class: 'adv', open: true },
      el('summary', null, el('span', { html: PS.icon('chevron', 14) }), 'Height (iso)'),
      el('div', { class: 'stack' },
        liveRange(layer, 'elev', 'Starts at level', {
          min: 0, max: 8, step: 1, format: (v) => (v ? `${v} up` : 'ground'), redraw: true,
        }),
        layer.solid ? liveRange(layer, 'blocks', 'Block height', {
          min: 1, max: 4, step: 1, format: (v) => PS.util.plural(v, 'tile'), redraw: true,
        }) : null,
        el('p', { class: 'hint', text: layer.solid ? 'Solid tiles become blocks the player can jump onto.' : 'Flat layer: a surface to walk on or a decoration. It does not block anything.' })));
  }

  function addLayer() {
    const p = st.project;
    if (p.layers.length >= PS.LIMITS.maxLayers) return UI().toast(`You can have up to ${PS.LIMITS.maxLayers} layers.`, 'warn');
    const active = PS.Project.activeLayer();
    const at = active ? p.layers.indexOf(active) + 1 : p.layers.length;
    let n = p.layers.length + 1;
    while (p.layers.some((l) => l.name === `Layer ${n}`)) n++;
    let layer = null;
    PS.History.change('Add layer', () => { layer = PS.Project.addLayer(`Layer ${n}`, at); });
    st.activeLayerId = layer.id;
    Panel.render();
  }

  function duplicateLayer(layer) {
    if (st.project.layers.length >= PS.LIMITS.maxLayers) return UI().toast(`You can have up to ${PS.LIMITS.maxLayers} layers.`, 'warn');
    let copy = null;
    PS.History.change('Duplicate layer', () => { copy = PS.Project.duplicateLayer(layer.id); return copy ? undefined : false; });
    if (copy) { st.activeLayerId = copy.id; Panel.render(); }
  }

  function deleteLayer(layer) {
    const p = st.project;
    const i = p.layers.indexOf(layer);
    PS.History.change(`Delete layer “${layer.name}”`, () => PS.Project.removeLayer(layer.id));
    const next = p.layers[Math.min(i, p.layers.length - 1)] || p.layers[0];
    st.activeLayerId = next ? next.id : 0;
    Panel.render();
    UI().toast(`Deleted layer “${layer.name}”`, 'info', { action: { label: 'Undo', fn: () => PS.History.undo() } });
  }

  function moveBy(layer, delta) {
    const i = st.project.layers.indexOf(layer);
    const to = i + delta;
    if (to < 0 || to >= st.project.layers.length) return;
    PS.History.change(delta > 0 ? 'Move layer up' : 'Move layer down', () => PS.Project.moveLayer(layer.id, to), 'layers');
    Panel.render();
  }

  /** Slider that previews live, then records one undo step when released. */
  function liveRange(layer, key, label, opts) {
    const original = layer[key];
    return UI().rangeField(label, {
      ...opts,
      value: original,
      oninput: (v) => { layer[key] = v; PS.Renderer.request(); },
      onchange: (v) => {
        layer[key] = original;
        PS.History.change(`Change layer ${label.toLowerCase()}`, () => { layer[key] = v; }, 'layers');
        Panel.render();
        if (opts.preview) PS.Renderer.previewParallax();
        if (PS.Settings.isOpen) PS.Settings.render();
      },
    });
  }

  const Panel = {
    formatSpeed,

    init() {
      $('#btnAddLayer').addEventListener('click', (e) => { e.stopPropagation(); addLayer(); });
      const hl = $('#btnHighlightLayer');
      hl.classList.toggle('on', st.prefs.highlightLayer);
      hl.addEventListener('click', (e) => {
        e.stopPropagation();
        st.prefs.highlightLayer = !st.prefs.highlightLayer;
        hl.classList.toggle('on', st.prefs.highlightLayer);
        PS.savePrefs();
        PS.Renderer.request();
      });
    },

    render() {
      Panel.renderList();
      Panel.renderProps();
    },

    renderList() {
      const p = st.project;
      const list = $('#layerList');
      const rows = [];
      let lastGroup = 0;
      for (const layer of [...p.layers].reverse()) {
        const g = layer.groupId ? PS.Project.group(layer.groupId) : null;
        if (g && g.id !== lastGroup) rows.push(groupHeader(g));
        lastGroup = g ? g.id : 0;
        if (g && g.collapsed) continue;
        rows.push(buildRow(layer, !!g));
      }
      list.replaceChildren(...rows);

      function buildRow(layer, grouped) {
        const isObj = layer.type === 'objects';
        const row = el('li', {
          class: 'layer-row' + (grouped ? ' grouped' : '') + (layer.id === st.activeLayerId ? ' active' : '') + (layer.visible ? '' : ' hidden-layer'),
          draggable: true, dataset: grouped ? { id: layer.id, group: layer.groupId } : { id: layer.id },
          onclick: () => setActive(layer.id),
          ondblclick: () => startRename(row, layer),
        },
          el('span', { class: 'grip', html: PS.icon('grip', 14), 'data-tip': 'Drag to reorder' }),
          el('button', {
            class: 'icon-btn' + (layer.visible ? '' : ' off'), 'data-tip': layer.visible ? 'Hide layer' : 'Show layer',
            'aria-label': layer.visible ? 'Hide layer' : 'Show layer', html: PS.icon(layer.visible ? 'eye' : 'eyeOff', 15),
            onclick: (e) => { e.stopPropagation(); layer.visible = !layer.visible; metaChanged(); PS.Renderer.invalidateAll(); },
          }),
          el('button', {
            class: 'icon-btn' + (layer.locked ? ' lock-on' : ' off'), 'data-tip': layer.locked ? 'Unlock layer' : 'Lock layer to prevent changes',
            'aria-label': layer.locked ? 'Unlock layer' : 'Lock layer', html: PS.icon(layer.locked ? 'lock' : 'unlock', 15),
            onclick: (e) => { e.stopPropagation(); layer.locked = !layer.locked; metaChanged(); },
          }),
          el('span', { class: 'kind', html: PS.icon(isObj ? 'ghost' : 'tiles', 14), 'data-tip': isObj ? 'Game objects layer' : 'Tile layer' }),
          el('span', { class: 'lname', text: layer.name, 'data-tip': 'Double-click to rename' }),
          layer.solid ? el('span', { class: 'tag', text: 'Solid', 'data-tip': 'The player and enemies collide with this layer' }) : null);

        row.addEventListener('dragstart', (e) => {
          dragId = layer.id;
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(layer.id));
        });
        row.addEventListener('dragend', () => { dragId = 0; Panel.renderList(); });
        acceptDrops(row, grouped ? layer.groupId : 0, (id, groupId, above) => {
          if (groupId) reorderGroup(groupId, layer.id, above);
          else reorder(id, layer.id, above);
        });
        return row;
      }
    },

    renderProps() {
      const box = $('#layerProps');
      const layer = PS.Project.activeLayer();
      if (!layer) { box.replaceChildren(); return; }
      const p = st.project;
      const i = p.layers.indexOf(layer);
      const isObj = layer.type === 'objects';
      const iconBtn = (icon, tip, fn, disabled, danger) => el('button', {
        class: 'icon-btn' + (danger ? ' danger' : ''), 'data-tip': tip, 'aria-label': tip, disabled, html: PS.icon(icon, 16), onclick: fn,
      });

      box.replaceChildren(el('div', { class: 'layer-props' },
        liveRange(layer, 'opacity', 'Opacity', { min: 0, max: 1, step: 0.05, format: (v) => Math.round(v * 100) + '%' }),
        isObj
          ? el('p', { class: 'hint', text: 'Holds the player start, enemies, collectibles and the goal. Move it to change what draws in front.' })
          : UI().switchRow('Solid', 'Player and enemies stand on it and bump into it', layer.solid, (on) => {
            PS.History.change(on ? 'Make layer solid' : 'Make layer non-solid', () => { layer.solid = on; }, 'layers');
            Panel.render();
            if (PS.Settings.isOpen) PS.Settings.render();
          }, 'Solid layers block movement. Turn off for scenery like clouds and plants.'),
        shadowControls(layer),
        isObj ? null : parallaxControls(layer),
        isObj || p.view !== 'iso' ? null : isoControls(layer),
        el('div', { class: 'layer-actions' },
          iconBtn('up', 'Move layer up (draw in front)', () => moveBy(layer, 1), i >= p.layers.length - 1),
          iconBtn('down', 'Move layer down (draw behind)', () => moveBy(layer, -1), i <= 0),
          iconBtn('dup', isObj ? 'The objects layer cannot be duplicated' : 'Duplicate layer', () => duplicateLayer(layer), isObj),
          iconBtn('trash', isObj ? 'The objects layer cannot be deleted' : 'Delete layer', () => deleteLayer(layer), isObj, true))));
    },
  };

  PS.LayersPanel = Panel;
})(window.PS);
