/* =====================================================================
   Platformer Studio — settings drawer
   Appearance, level options, game rules and (tucked away) physics.
   ===================================================================== */
(function (PS) {
  'use strict';

  const { el, $ } = PS.util;
  const st = PS.state;
  const UI = () => PS.UI;

  const SHORTCUTS = [
    ['P / E / G', 'Pencil, eraser, fill'],
    ['R / Shift+R', 'Rectangle, filled rectangle'],
    ['V / M / I', 'Select, move, eyedropper'],
    ['[ / ]', 'Previous / next tileset (brush size in Paint)'],
    ['Tab', 'Switch between Build and Paint'],
    ['B / E / G / I', 'In Paint: brush, eraser, fill, pick colour'],
    ['H', 'In Paint: Heal brush, fades the cut between tiles'],
    ['F', 'In Paint: fullscreen painting'],
    ['Wheel on the sheet', 'In Paint: zoom the sheet, Space + drag to move it'],
    ['Space + drag', 'Pan (or middle mouse)'],
    ['Wheel / + / −', 'Zoom, 0 fits to screen'],
    ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
    ['Ctrl+C / X / V', 'Copy, cut, paste tiles'],
    ['Delete', 'Delete selection or object'],
    ['Enter / Esc', 'Play / back to editor'],
  ];

  function changed(redraw) {
    PS.App.documentChanged('meta');
    if (redraw) { PS.Renderer.invalidateAll(); }
    PS.Renderer.request();
  }

  function group(title, icon, ...children) {
    return el('section', { class: 'set-group', dataset: { group: title.toLowerCase() } },
      el('h4', null, el('span', { html: PS.icon(icon, 13) }), title),
      el('div', { class: 'stack' }, children));
  }

  /** Where the sun is on screen, for a compass angle where 0 is the top. */
  const formatSun = (v) => ['Top', 'Upper right', 'Right', 'Lower right', 'Bottom', 'Lower left', 'Left', 'Upper left'][Math.round(v / 45) % 8];

  /** One speed slider for each thing that scrolls separately: a group, or a layer on its own. */
  function parallaxRows() {
    const p = st.project;
    const rows = [];
    const seen = new Set();
    for (const l of [...p.layers].reverse()) {
      if (l.type !== 'tiles' || PS.Project.speedLocked(l)) continue;
      const g = l.groupId ? PS.Project.group(l.groupId) : null;
      const owner = g || l;
      if (seen.has(owner)) continue;
      seen.add(owner);
      const label = g ? `${g.name} (${PS.Project.groupLayers(g.id).map((m) => m.name).join(', ')})` : l.name;
      rows.push(UI().rangeField(label, {
        min: 0.1, max: 1.5, step: 0.05, value: owner.depth,
        format: PS.LayersPanel.formatSpeed, ends: ['Far, moves slowly', 'Near, moves fast'],
        oninput: (v) => { owner.depth = v; },
        onchange: (v) => { owner.depth = v; changed(); PS.LayersPanel.render(); PS.Renderer.previewParallax(); },
      }));
    }
    return rows;
  }

  const Settings = {
    init() {
      $('#settingsClose').addEventListener('click', () => Settings.close());
    },

    get isOpen() { return !$('#settingsDrawer').hidden; },

    toggle() { Settings.isOpen ? Settings.close() : Settings.open(); },

    open(focus) {
      UI().closePopovers();
      Settings.render();
      $('#settingsDrawer').hidden = false;
      if (focus) {
        const g = $(`#settingsBody [data-group="${focus}"]`);
        if (g) { g.scrollIntoView({ block: 'start' }); g.classList.remove('flash'); void g.offsetWidth; g.classList.add('flash'); }
      }
    },

    close() {
      if (!Settings.isOpen) return false;
      $('#settingsDrawer').hidden = true;
      return true;
    },

    render() {
      const p = st.project, prefs = st.prefs;
      const ph = p.physics, g = p.game, lv = p.level;
      const body = $('#settingsBody');

      const scoreField = UI().numberField('Score needed', g.requiredScore, { min: 0, max: 1000000, step: 10 }, (v) => { g.requiredScore = v; changed(); });
      scoreField.hidden = g.winCondition !== 'score';

      const physics = el('details', { class: 'adv' },
        el('summary', null, el('span', { html: PS.icon('chevron', 14) }), 'Movement feel'),
        el('div', { class: 'stack' },
          UI().rangeField('Walking speed', { min: 60, max: 300, step: 10, value: ph.walkSpeed, ends: ['Slow', 'Fast'], onchange: (v) => { ph.walkSpeed = v; if (ph.runSpeed < v) ph.runSpeed = v; changed(); Settings.render(); } }),
          UI().rangeField('Running speed (hold Shift)', { min: 80, max: 500, step: 10, value: ph.runSpeed, ends: ['Slow', 'Fast'], onchange: (v) => { ph.runSpeed = Math.max(v, ph.walkSpeed); changed(); Settings.render(); } }),
          UI().rangeField('Jump strength', { min: 250, max: 800, step: 10, value: ph.jumpStrength, ends: ['Small hops', 'Huge leaps'], onchange: (v) => { ph.jumpStrength = v; changed(); } }),
          UI().rangeField('Gravity', { min: 600, max: 3000, step: 50, value: ph.gravity, ends: ['Floaty', 'Heavy'], onchange: (v) => { ph.gravity = v; changed(); } }),
          UI().switchRow('Double jump', 'Press jump again in the air', ph.doubleJump, (on) => { ph.doubleJump = on; changed(); }),
          el('p', { class: 'hint', text: `With these settings a jump reaches about ${Math.round((ph.jumpStrength * ph.jumpStrength) / (2 * ph.gravity) / 32 * 10) / 10} tiles high.` }),
          el('button', { class: 'btn sm', text: 'Reset movement to defaults', onclick: () => { Object.assign(ph, PS.Project.DEFAULT_PHYSICS); changed(); Settings.render(); } })));

      body.replaceChildren(
        group('Appearance', 'sun',
          el('div', { class: 'field' }, el('span', { text: 'Theme' }),
            UI().segmented([{ value: 'dark', label: 'Dark', icon: 'moon' }, { value: 'light', label: 'Light', icon: 'sun' }], prefs.theme, (v) => PS.App.setTheme(v))),
          UI().rangeField('Transparency checkerboard', {
            min: 0, max: 1, step: 0.1, value: prefs.checker, format: (v) => Math.round(v * 100) + '%', ends: ['Subtle', 'Strong'],
            oninput: (v) => { prefs.checker = v; PS.Renderer.checkerPattern = null; PS.Renderer.request(); },
            onchange: (v) => { prefs.checker = v; PS.savePrefs(); },
          }),
          UI().switchRow('Sound effects', 'Jump, collect and win sounds while playing', prefs.sound, (on) => { prefs.sound = on; PS.savePrefs(); if (on) PS.Sfx.play('coin'); })),

        group('Level', 'image',
          el('div', { class: 'row', style: 'align-items:center' },
            el('div', { class: 'switch-text', style: 'flex:1' }, el('span', { text: 'Sky colour' }), el('small', { class: 'hint', style: 'margin:0', text: 'Shown behind your tiles' })),
            el('input', { type: 'color', value: lv.sky, 'aria-label': 'Sky colour', oninput: (e) => { lv.sky = e.target.value; PS.Renderer.request(); }, onchange: (e) => { lv.sky = e.target.value; changed(); } })),
          UI().switchRow('See-through background', 'Shows a checkerboard in the editor and exports a transparent PNG', lv.transparentSky, (on) => { lv.transparentSky = on; changed(); }),
          UI().switchRow('Connect different tilesets', 'Edges blend where different tilesets touch on the same layer', lv.connectAcross, (on) => { lv.connectAcross = on; changed(true); },
            'Normally each tileset gets its own edges. Turn this on to treat all tilesets on a layer as one connected terrain.'),
          UI().switchRow('Terrain continues past map edges', 'No border edges where ground touches the left, right or bottom of the map', lv.edgeConnect, (on) => { lv.edgeConnect = on; changed(true); })),

        group('Iso view', 'cube',
          el('div', { class: 'field' }, el('span', { text: 'How the level is shown and played' }),
            UI().segmented([{ value: 'side', label: '2D platformer', icon: 'square' }, { value: 'iso', label: 'Isometric', icon: 'cube' }], p.view, (v) => PS.App.setView(v))),
          p.view === 'iso' ? [
            el('p', { class: 'hint', text: 'The player can walk in every direction and jump onto blocks. Things in front of others are drawn in front, and everything collides at its real height.' }),
            UI().switchRow('Block shadows', 'Blocks cast real shadows from the sun onto the ground, other blocks and walls', p.iso.blockShadows, (on) => { p.iso.blockShadows = on; changed(); Settings.render(); }),
            p.iso.blockShadows ? [
              UI().rangeField('Sun direction', {
                min: 0, max: 345, step: 15, value: p.iso.sunAngle, format: formatSun,
                oninput: (v) => { p.iso.sunAngle = v; PS.Renderer.request(); },
                onchange: (v) => { p.iso.sunAngle = v; changed(); },
              }),
              UI().rangeField('Sun height', {
                min: 15, max: 85, step: 5, value: p.iso.sunHeight, format: (v) => v + '°', ends: ['Low, long shadows', 'High, short shadows'],
                oninput: (v) => { p.iso.sunHeight = v; PS.Renderer.request(); },
                onchange: (v) => { p.iso.sunHeight = v; changed(); },
              }),
              UI().rangeField('Shadow darkness', {
                min: 0.1, max: 0.8, step: 0.05, value: p.iso.shadowDarkness, format: (v) => Math.round(v * 100) + '%', ends: ['Light', 'Dark'],
                oninput: (v) => { p.iso.shadowDarkness = v; PS.Renderer.request(); },
                onchange: (v) => { p.iso.shadowDarkness = v; changed(); },
              }),
            ] : null,
            UI().switchRow('Main character shadow', 'A shadow under the player', p.iso.shadowPlayer, (on) => { p.iso.shadowPlayer = on; changed(); }),
            UI().switchRow('NPC shadows', 'Shadows under enemies', p.iso.shadowNpc, (on) => { p.iso.shadowNpc = on; changed(); }),
            UI().switchRow('Object shadows', 'Shadows under collectibles and the goal', p.iso.shadowObjects, (on) => { p.iso.shadowObjects = on; changed(); }),
            UI().switchRow('Empty cells are pits', 'Falling in costs a life. Draw on a flat layer to make ground.', p.iso.pits, (on) => { p.iso.pits = on; changed(); }),
            p.iso.pits ? null : el('div', { class: 'row', style: 'align-items:center' },
              el('div', { class: 'switch-text', style: 'flex:1' }, el('span', { text: 'Ground colour' }), el('small', { class: 'hint', style: 'margin:0', text: 'The base under your tiles' })),
              el('input', { type: 'color', value: p.iso.ground, 'aria-label': 'Ground colour', oninput: (e) => { p.iso.ground = e.target.value; PS.Renderer.request(); }, onchange: (e) => { p.iso.ground = e.target.value; changed(); } })),
          ] : el('p', { class: 'hint', text: 'Switch to Isometric for depth, shadows and movement in every direction. Your level stays safe; you can switch back at any time.' })),

        group('Parallax', 'layers',
          UI().switchRow('Parallax scrolling', 'Layers move at their own speeds as the camera moves', lv.parallax, (on) => { lv.parallax = on; changed(); Settings.render(); PS.LayersPanel.render(); }),
          lv.parallax ? parallaxRows() : null,
          lv.parallax ? el('button', { class: 'btn sm', onclick: () => PS.Renderer.previewParallax() }, el('span', { html: PS.icon('play', 13) }), 'Preview the movement') : null,
          el('p', { class: 'hint', text: p.view === 'iso'
            ? 'Parallax is used in the 2D view. In iso, layers sit at real heights instead.'
            : 'Solid layers and objects always follow the camera, so what you see matches what you can stand on. To move layers together, group them in the Layers panel.' })),

        group('Rules', 'flag',
          UI().numberField('Lives', g.lives, { min: 1, max: 99 }, (v) => { g.lives = v; changed(); }, 'How many hits the player can take'),
          UI().switchRow('Jump on enemies to defeat them', 'Spiky enemies can never be stomped', g.stomp, (on) => { g.stomp = on; changed(); }),
          UI().selectField('How to win', [
            { value: 'goal', label: 'Reach the goal' },
            { value: 'all', label: 'Collect every item, then reach the goal' },
            { value: 'score', label: 'Reach a score, then reach the goal' },
          ], g.winCondition, (v) => { g.winCondition = v; scoreField.hidden = v !== 'score'; changed(); PS.App.refreshProps(); }),
          scoreField,
          UI().switchRow('Smooth camera', 'The camera glides after the player instead of snapping', g.cameraSmoothing, (on) => { g.cameraSmoothing = on; changed(); }),
          physics),

        group('Help', 'info',
          el('details', { class: 'adv' },
            el('summary', null, el('span', { html: PS.icon('chevron', 14) }), 'How automatic tiles work'),
            el('div', { class: 'stack' },
              el('p', { class: 'help-text', text: 'Tilesets use a dual grid. The art is drawn half a tile away from your map grid, so each picture sits on a corner where four map cells meet.' }),
              el('p', { class: 'help-text', text: 'Four cells, each filled or empty, make 16 combinations, so a sheet has just 16 tiles (15 to paint, since one stays empty). That covers every shape, including inside corners and rounded edges.' }),
              el('p', { class: 'help-text', text: 'Painting one tile changes it everywhere it appears on the map.' }))),
          el('details', { class: 'adv' },
            el('summary', null, el('span', { html: PS.icon('chevron', 14) }), 'Keyboard shortcuts'),
            el('div', { class: 'stack', style: 'gap:6px' }, SHORTCUTS.map(([k, d]) => el('div', { style: 'display:flex;justify-content:space-between;gap:10px' },
              el('kbd', { text: k }), el('span', { class: 'help-text', style: 'text-align:right', text: d }))))),
          el('button', { class: 'btn sm', onclick: () => { Settings.close(); PS.App.showWelcome(true); } }, el('span', { html: PS.icon('sparkle', 14) }), 'Show welcome tips')),
      );
      PS.hydrateIcons(body);
    },
  };

  PS.Settings = Settings;
})(window.PS);
