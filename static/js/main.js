// Page entry: period form, data loading and tabs. util.js has helpers, state.js the shared data and API, charts.js the
// ECharts wrappers, map.js the map and radar, home.js the first two tabs, history.js the history tab, panels.js the plug-ins.
import { chart, charts, emptyChart, measure } from './charts.js';
import { drawHistory } from './history.js';
import { render, windowText } from './home.js';
import { resizeMap } from './map.js';
import { renderPanels, stackTables } from './panels.js';
import { addEventPresets, daysAgo, form, fromIn, preset, setPresetDates, syncPreset, toIn, today } from './period.js';
import { STATIC, api, state } from './state.js';
import { el, link } from './util.js';

export const status = document.getElementById('status');
// charts measure label widths once (and cache them), so draw only after the web fonts arrive or labels clip; give up after 3 s
const FONTS = Promise.race([Promise.all(['12px "IBM Plex Mono"', '500 12px "IBM Plex Mono"', '13px "IBM Plex Sans"'].map(f => document.fonts.load(f))),
  new Promise(r => setTimeout(r, 3000))]).catch(() => {});
export async function load() {
  const q = new URLSearchParams({ from: fromIn.value, to: toIn.value });
  history.replaceState(null, '', `?${q}${location.hash}`);
  status.textContent = 'Loading data.';
  document.getElementById('answer-h').textContent = 'Loading…';
  const r = await api.data(fromIn.value, toIn.value); const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  await FONTS;
  state.DATA = j; addEventPresets(j.events); render();
  status.textContent = `Showing ${windowText(j.window).when}.`;
}
export function showError(e) {
  document.getElementById('answer-h').replaceChildren(el('span', { className: 'err', textContent: `Couldn't load the gauge data: ${e.message}.` }));
  document.getElementById('answer-p').textContent = STATIC ? 'Pick one of the periods in the list.' : 'Check the dates, or check that the server is running and press Refresh data.';
  status.textContent = 'Loading failed.';
}

setPresetDates();
const qs = new URLSearchParams(location.search);
fromIn.value = qs.get('from') || daysAgo(6); toIn.value = qs.get('to') || today();
fromIn.max = toIn.max = today();
syncPreset();
load().catch(showError);
const loadHistory = () => state.HIST ? Promise.resolve() : api.history().then(r => r.json()).then(j => { state.HIST = j; })
  .catch(() => emptyChart('chart-history', 'Couldn\'t load the history.'));

// tabs: three levels of detail; arrow keys move between them, the choice is kept in the link
const tabs = [...document.querySelectorAll('[role="tab"]')];
export function showTab(tab, focus) {
  tabs.forEach(t => {
    const on = t === tab;
    t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  });
  if (focus) tab.focus();
  const name = tab.id.replace('tab-', '');
  history.replaceState(null, '', `${location.search}${name === 'glance' ? '' : '#' + name}`);
  requestAnimationFrame(stackTables); // tables in a tab that was hidden couldn't be measured
  if (name === 'history') loadHistory().then(() => { drawHistory(); Object.values(charts).forEach(c => c.resize()); });
  if (name === 'details') render();
  if (name === 'ag') renderPanels('ag');
  if (name === 'glance') resizeMap();
  requestAnimationFrame(() => Object.values(charts).forEach(c => c.resize()));
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => showTab(t));
  t.addEventListener('keydown', (e) => {
    const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (k) { e.preventDefault(); showTab(tabs[(i + k + tabs.length) % tabs.length], true); }
    if (e.key === 'Home') { e.preventDefault(); showTab(tabs[0], true); }
    if (e.key === 'End') { e.preventDefault(); showTab(tabs[tabs.length - 1], true); }
  });
});
document.getElementById('sources-btn').addEventListener('click', () => {
  showTab(document.getElementById('tab-details'));
  const f = document.querySelector('footer.sources');
  f.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  f.querySelector('h2').setAttribute('tabindex', '-1'); f.querySelector('h2').focus({ preventScroll: true });
});
export const start = tabs.find(t => `#${t.id.replace('tab-', '')}` === location.hash);
if (start) showTab(start);

// the glance view sizes itself to whatever is left under the header, period bar and tabs
const chrome = () => {
  const top = document.getElementById('panel-glance').getBoundingClientRect().top + window.scrollY;
  // plus whatever sits below main (page padding), so the glance view ends at the bottom of the window
  const tail = document.body.scrollHeight - (document.querySelector('main').getBoundingClientRect().bottom + window.scrollY);
  document.documentElement.style.setProperty('--chrome', `${Math.ceil(top + Math.max(tail, 0))}px`);
  resizeMap();
};
chrome(); addEventListener('resize', chrome);
document.fonts?.ready.then(() => { render(); if (!document.getElementById('panel-history').hidden) drawHistory(); });
export const btn = document.getElementById('refresh');
if (STATIC) {
  // published copy: data rebuilds on a schedule, and only exported periods exist
  btn.hidden = true;
  document.getElementById('hist-apply').hidden = true;
  preset.querySelector('option[value="custom"]').remove();
  form.querySelectorAll('input[type="date"], button[type="submit"]').forEach(x => { x.closest('label')?.setAttribute('hidden', ''); if (x.type === 'submit') x.hidden = true; });
}
btn.addEventListener('click', async () => {
  btn.disabled = true; btn.textContent = 'Refreshing…'; status.textContent = 'Refreshing data.';
  try { const r = await fetch('/api/refresh', { method: 'POST' }); const j = await r.json(); if (!r.ok) throw new Error(j.error); setPresetDates(); await load(); status.textContent = 'Data updated.'; }
  catch (e) { showError(e); }
  finally { btn.disabled = false; btn.textContent = 'Refresh data'; }
});
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => Object.values(charts).forEach(c => c.resize()), 120); }).observe(document.querySelector('.wrap'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { render(); drawHistory(); });
setInterval(() => load().catch(() => {}), 15 * 60 * 1000);
