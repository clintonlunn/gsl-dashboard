import { base, chart, charts, emptyChart, lineChart } from './charts.js';
import { refreshCards, render } from './home.js';
import { btn } from './main.js';
import { STATIC, api, state } from './state.js';
import { GAL_PER_AF, addDays, b, cite, css, el, fmt1, fmtDay, fmtInt, isoDay, link, parseDay, parseHour, pretty } from './util.js';

// ---------------------------------------------------------------- plug-in panels (static/panels/*.js)
// A panel file calls GSL.register({ id, tab: 'glance' | 'water' | 'history' | 'details', order, mount(slot) -> root,
//   render(data, D, root), renderHistory(data, HIST, root), card(data, D) -> { val, sub } }). `data` is DATA.sources[id] (or HIST.sources[id]).
export const PANELS = [];
// panels built on Utah Geological Survey data (ids starting "ugs") get a visible badge on their heading
const panelRoot = (p) => {
  if (p.__root) return p.__root;
  p.__root = p.mount(document.getElementById(`panels-${p.tab}`));
  const h2 = p.id.startsWith('ugs') && p.__root?.querySelector('h2');
  if (h2 && !h2.querySelector('.ugs-badge')) h2.prepend(el('span', { className: 'ugs-badge', textContent: 'UGS data' }), ' ');
  return p.__root;
};
export function renderPanels(which) {
  for (const p of PANELS) {
    if (p.tab !== which && !(which === 'history' && p.renderHistory)) continue;
    try {
      if (which === 'history' && p.renderHistory && state.HIST) p.renderHistory(state.HIST.sources?.[p.id], state.HIST, panelRoot(p));
      else if (which !== 'history' && p.render && state.DATA) p.render(state.DATA.sources?.[p.id], state.DATA, panelRoot(p));
    } catch (e) { console.error(`panel ${p.id}`, e); }
  }
}
// long tables outside the glance view show their first rows and a button for the rest; rendering rebuilds tables, so watch for new ones
const ROWS_SHOWN = 10, ROWS_MIN = 15, expanded = new Set();
function shortenTables() {
  for (const table of document.querySelectorAll('.panel:not(.glance) table')) {
    if (table.closest('.sr-only')) continue; // screen-reader copies of charts stay whole
    // some tables group rows into several tbodies; count them together
    // .detail-row rows open under a row on request and keep their own hidden state
    const rows = [...table.querySelectorAll(':scope > tbody > tr:not(.detail-row)')], tb = table.tBodies[0];
    if (!tb || (table.__first === rows[0] && table.__n === rows.length)) continue;
    table.__first = rows[0]; table.__n = rows.length;
    table.__more?.remove(); table.__more = null;
    if (rows.length < ROWS_MIN) continue;
    const key = table.closest('section')?.querySelector('h2')?.textContent || '';
    const btn = el('button', { type: 'button', className: 'more-rows' });
    btn.setAttribute('aria-controls', [...table.tBodies].map(b => (b.id ||= `rows-${Math.random().toString(36).slice(2, 8)}`)).join(' '));
    const set = (open) => {
      rows.forEach((r, i) => { r.hidden = !open && i >= ROWS_SHOWN; });
      btn.setAttribute('aria-expanded', open);
      btn.textContent = open ? 'Show fewer rows' : `Show all ${rows.length} rows`;
      open ? expanded.add(key) : expanded.delete(key);
    };
    btn.addEventListener('click', () => set(btn.getAttribute('aria-expanded') !== 'true'));
    set(expanded.has(key));
    (table.closest('.tablewrap') || table).after(btn);
    table.__more = btn;
  }
}
// tables of 5+ columns get .stack: on phones the CSS shows each row as a card, labelling every value with its column.
// display: block drops table semantics in some browsers, so the roles are set explicitly.
const PHONE = matchMedia('(max-width: 599px)');
PHONE.addEventListener('change', () => stackTables());
export function stackTables() {
  for (const table of document.querySelectorAll('main table')) {
    if (table.closest('.sr-only')) continue;
    for (const r of table.rows) {
      if (r.__nw) continue;
      r.__nw = true;
      for (const c of r.cells) { const t = c.textContent.trim(); if (t.length <= 16 && /\d/.test(t) && !c.querySelector('table')) c.classList.add('nw'); }
    }
    if (!table.tHead) continue;
    const head = [...table.tHead.rows].at(-1), labels = [];
    for (const c of head?.cells || []) for (let k = 0; k < (c.colSpan || 1); k++) labels.push(c.textContent.trim());
    // 5+ columns always; fewer only when the table still doesn't fit a phone after wrapping
    const tooWide = PHONE.matches && table.offsetWidth > (table.parentElement?.clientWidth ?? innerWidth) + 2;
    if (labels.length < 5 && !tooWide) continue;
    if (!table.classList.contains('stack')) {
      table.classList.add('stack');
      table.setAttribute('role', 'table');
      for (const c of head.cells) c.setAttribute('role', 'columnheader');
      for (const r of table.tHead.rows) r.setAttribute('role', 'row');
    }
    for (const body of [...table.tBodies, table.tFoot].filter(Boolean)) {
      body.setAttribute('role', 'rowgroup');
      for (const r of body.rows) {
        if (r.__stacked) continue;
        r.__stacked = true;
        r.setAttribute('role', 'row');
        let i = 0;
        for (const c of r.cells) {
          if (c.dataset.label == null) c.dataset.label = (c.colSpan || 1) > 1 ? '' : labels[i] ?? '';
          c.setAttribute('role', c.tagName === 'TH' ? 'rowheader' : 'cell');
          i += c.colSpan || 1;
        }
      }
    }
  }
}
let shortenQueued = false;
new MutationObserver(() => { if (!shortenQueued) { shortenQueued = true; requestAnimationFrame(() => { shortenQueued = false; shortenTables(); stackTables(); }); } })
  .observe(document.querySelector('main'), { childList: true, subtree: true });
const DETAIL = {};
window.GSL = {
  register(p) { PANELS.push(p); PANELS.sort((a, c) => (a.order ?? 50) - (c.order ?? 50)); if (state.DATA) { renderPanels('glance'); renderPanels('water'); renderPanels('details'); if (p.card) refreshCards(); } if (state.HIST) renderPanels('history'); },
  css, fmtInt, fmt1, pretty, parseDay, parseHour, isoDay, addDays, fmtDay, el, b, link, cite, chart, emptyChart, base, lineChart,
  GAL_PER_AF, get ugs() { return state.DATA?.config?.ugs || {}; },
  // a source's on-demand extras (sources/<name>.py detail()), fetched once
  detail: (name) => (DETAIL[name] ||= fetch(STATIC ? `data/detail/${name}.json?v=${encodeURIComponent(STATIC.built_at)}` : `/api/detail/${name}`)
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`detail ${r.status}`))).catch(e => { delete DETAIL[name]; throw e; })),
  isShown: (tab) => !document.getElementById(`panel-${tab}`).hidden,
};
api.panels().then(r => r.json()).then(files => files.forEach(f => document.body.append(el('script', { src: `panels/${f}${STATIC ? `?v=${encodeURIComponent(STATIC.built_at)}` : ''}` })))).catch(() => {});
