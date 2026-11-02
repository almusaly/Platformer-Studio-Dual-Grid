/* =====================================================================
   Platformer Studio — shared user-interface helpers
   Toasts, tooltips, confirm dialog, popovers and collapsible sections.
   ===================================================================== */
(function (PS) {
  'use strict';

  const { el, $, $$ } = PS.util;
  const TOAST_ICONS = { info: 'info', success: 'check', warn: 'alert', error: 'alert' };

  let tipTimer = 0, tipTarget = null;
  let openPop = null, popAnchor = null;

  const UI = {
    /* ------------------------------ Toasts ------------------------------ */
    toast(message, type = 'info', { duration = 3200, action = null } = {}) {
      const box = $('#toasts');
      while (box.children.length >= 4) box.firstElementChild.remove();
      const t = el('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
        el('span', { class: 't-icon', html: PS.icon(TOAST_ICONS[type] || 'info', 14) }),
        el('span', { class: 't-text', text: message }));
      let timer = 0;
      const close = () => {
        clearTimeout(timer);
        t.classList.add('leaving');
        setTimeout(() => t.remove(), 250);
      };
      if (action) {
        t.append(el('button', { class: 't-action', text: action.label, onclick: () => { close(); action.fn(); } }));
      }
      box.append(t);
      timer = setTimeout(close, duration + (action ? 2000 : 0));
      t.addEventListener('mouseenter', () => clearTimeout(timer));
      t.addEventListener('mouseleave', () => { timer = setTimeout(close, 1500); });
      return close;
    },

    /* ------------------------------ Confirm ------------------------------ */
    confirm({ title = 'Are you sure?', text = '', ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
      const dlg = $('#confirmDialog');
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      const okBtn = $('#confirmOk');
      okBtn.textContent = ok;
      okBtn.className = 'btn ' + (danger ? 'danger solid' : 'primary');
      $('#confirmCancel').textContent = cancel;
      UI.hideTip();
      return new Promise((resolve) => {
        const done = () => { dlg.removeEventListener('close', done); resolve(dlg.returnValue === 'ok'); };
        dlg.returnValue = 'cancel';
        dlg.addEventListener('close', done);
        dlg.showModal();
        okBtn.focus();
      });
    },

    /* ------------------------------ Popovers ------------------------------ */
    openPopover(pop, anchor) {
      UI.closePopovers();
      pop.hidden = false;
      openPop = pop;
      popAnchor = anchor;
      UI.positionPopover();
      UI.hideTip();
    },

    positionPopover() {
      if (!openPop || !popAnchor) return;
      const a = popAnchor.getBoundingClientRect();
      const w = openPop.offsetWidth;
      const left = Math.min(Math.max(8, a.left + a.width / 2 - w / 2), window.innerWidth - w - 8);
      openPop.style.left = left + 'px';
      openPop.style.top = a.bottom + 8 + 'px';
    },

    closePopovers() {
      if (!openPop) return false;
      openPop.hidden = true;
      openPop = null;
      popAnchor = null;
      return true;
    },

    isPopoverOpen: (pop) => openPop === pop,

    /* ------------------------------ Sections ------------------------------ */
    initSections() {
      for (const panel of $$('.panel[data-section]')) {
        const key = panel.dataset.section;
        if (PS.state.prefs.collapsed[key]) panel.classList.add('collapsed');
        panel.querySelector('.collapse-btn').addEventListener('click', () => {
          const c = panel.classList.toggle('collapsed');
          PS.state.prefs.collapsed[key] = c;
          PS.savePrefs();
        });
      }
    },

    /** Open, scroll to and briefly highlight a sidebar section. */
    flashSection(id) {
      const panel = document.getElementById(id);
      if (!panel) return;
      const side = panel.closest('.sidebar');
      if (side) UI.showSidebar(side.classList.contains('left') ? 'left' : 'right');
      panel.classList.remove('collapsed');
      PS.state.prefs.collapsed[panel.dataset.section] = false;
      panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      panel.classList.remove('flash');
      void panel.offsetWidth;
      panel.classList.add('flash');
    },

    narrow: () => window.matchMedia('(max-width: 900px)').matches,

    showSidebar(side) {
      const b = document.body;
      if (UI.narrow()) {
        b.classList.add(side + '-open');
        b.classList.remove((side === 'left' ? 'right' : 'left') + '-open');
      } else {
        b.classList.remove(side + '-closed');
        PS.state.prefs[side + 'Closed'] = false;
      }
    },

    toggleSidebar(side) {
      const b = document.body;
      if (side === 'right' && PS.state.workspace === 'paint' && !UI.narrow()) {
        if (PS.state.prefs.paintFull) return;
        PS.state.prefs.paintRightOpen = b.classList.toggle('paint-right');
        PS.savePrefs();
        return;
      }
      if (UI.narrow()) {
        const open = b.classList.toggle(side + '-open');
        if (open) b.classList.remove((side === 'left' ? 'right' : 'left') + '-open');
      } else {
        const closed = b.classList.toggle(side + '-closed');
        PS.state.prefs[side + 'Closed'] = closed;
        PS.savePrefs();
      }
    },

    /* ------------------------------ Tooltips ------------------------------ */
    initTooltips() {
      const tip = $('#tooltip');
      document.addEventListener('mouseover', (e) => {
        const t = e.target.closest && e.target.closest('[data-tip]');
        if (t === tipTarget) return;
        UI.hideTip();
        if (!t || PS.Tools.dragging) return;
        tipTarget = t;
        tipTimer = setTimeout(() => {
          if (!document.body.contains(t)) return;
          tip.textContent = t.getAttribute('data-tip');
          tip.hidden = false;
          const r = t.getBoundingClientRect();
          const tw = tip.offsetWidth, th = tip.offsetHeight;
          let top = r.bottom + 8;
          if (top + th > window.innerHeight - 8) top = r.top - th - 8;
          const left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8);
          tip.style.left = left + 'px';
          tip.style.top = top + 'px';
        }, 450);
      });
      document.addEventListener('mousedown', () => UI.hideTip(), true);
      document.addEventListener('scroll', () => UI.hideTip(), true);
      document.addEventListener('mousedown', (e) => {
        if (openPop && !openPop.contains(e.target) && !(popAnchor && popAnchor.contains(e.target))) UI.closePopovers();
      });
      window.addEventListener('resize', () => UI.positionPopover());
    },

    hideTip() {
      clearTimeout(tipTimer);
      tipTarget = null;
      const tip = $('#tooltip');
      if (tip) tip.hidden = true;
    },

    /* ------------------------------ Small builders ------------------------------ */
    switchRow(label, sub, checked, onchange, tip) {
      return el('label', { class: 'switch', 'data-tip': tip || null },
        el('span', { class: 'switch-text' }, el('span', { text: label }), sub ? el('small', { text: sub }) : null),
        el('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }),
        el('span', { class: 'track' }));
    },

    rangeField(label, { min, max, step = 1, value, format = (v) => String(v), onchange, oninput, ends }) {
      const out = el('b', { text: format(value) });
      const input = el('input', {
        type: 'range', min, max, step, value,
        oninput: (e) => { out.textContent = format(Number(e.target.value)); if (oninput) oninput(Number(e.target.value)); },
        onchange: (e) => onchange(Number(e.target.value)),
      });
      return el('label', { class: 'field' },
        el('span', null, label + ' ', out), input,
        ends ? el('div', { class: 'range-ends' }, el('span', { text: ends[0] }), el('span', { text: ends[1] })) : null);
    },

    selectField(label, options, value, onchange, tip) {
      const sel = el('select', { onchange: (e) => onchange(e.target.value) },
        options.map((o) => el('option', { value: o.value, selected: o.value === value, text: o.label })));
      return el('label', { class: 'field', 'data-tip': tip || null }, el('span', { text: label }), sel);
    },

    numberField(label, value, { min, max, step = 1 }, onchange, tip) {
      return el('label', { class: 'field', 'data-tip': tip || null }, el('span', { text: label }),
        el('input', {
          type: 'number', min, max, step, value,
          onchange: (e) => {
            const v = PS.util.int(e.target.value, value, min, max);
            e.target.value = v;
            onchange(v);
          },
        }));
    },

    segmented(options, value, onchange) {
      const box = el('div', { class: 'segmented' });
      for (const o of options) {
        box.append(el('button', {
          class: o.value === value ? 'on' : '', type: 'button', 'data-tip': o.tip || null,
          onclick: () => {
            for (const b of box.children) b.classList.remove('on');
            box.children[options.indexOf(o)].classList.add('on');
            onchange(o.value);
          },
        }, o.icon ? el('span', { 'data-icon': o.icon, 'data-icon-size': 14 }) : null, o.label));
      }
      return box;
    },

    /** A 32×32 canvas sprite shown larger with crisp pixels. */
    spriteThumb(frame, size = 48, cls = 'thumb') {
      const c = el('canvas', { class: cls, width: 32, height: 32 });
      c.style.width = size + 'px';
      c.style.height = size + 'px';
      if (frame) c.getContext('2d').drawImage(frame, 0, 0);
      return c;
    },
  };

  PS.UI = UI;
})(window.PS);
