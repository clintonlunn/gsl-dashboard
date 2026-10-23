import { load, showError, start } from './main.js';
import { STATIC } from './state.js';
import { addDays, fmtDay, isoDay, parseDay } from './util.js';

// ---------------------------------------------------------------- period controls
export const form = document.getElementById('period'), preset = document.getElementById('preset');
export const fromIn = document.getElementById('from'), toIn = document.getElementById('to');
export const today = () => STATIC ? STATIC.today : isoDay(new Date());
export const daysAgo = (n) => isoDay(addDays(parseDay(today()), -n));
export function syncPreset() {
  const match = [...preset.options].find(o => o.dataset.from === fromIn.value && o.dataset.to === toIn.value);
  preset.value = match ? match.value : STATIC ? '' : 'custom';
}
export function setPresetDates() {
  for (const o of preset.options) if (/^\d+$/.test(o.value)) { o.dataset.from = daysAgo(+o.value - 1); o.dataset.to = today(); }
}
export function addEventPresets(events) {
  [...preset.querySelectorAll('option[data-event]')].forEach(o => o.remove());
  const custom = preset.querySelector('option[value="custom"]');
  for (const e of events.slice(0, 8)) {
    // volunteer gauges report the morning after, so start a day early; end a day late to catch runoff
    const s = parseDay(e.start_day), t = parseDay(e.end_day);
    const from = isoDay(addDays(s, -1)), to = [isoDay(addDays(t, 1)), today()].sort()[0];
    const o = new Option(`Rain around ${fmtDay(s)}${e.end_day !== e.start_day ? '–' + fmtDay(t) : ''} (${e.rain_in.toFixed(1)} in)`, `ev-${e.start_day}`);
    Object.assign(o.dataset, { event: '1', from, to });
    preset.insertBefore(o, custom);
  }
  syncPreset();
}
preset.addEventListener('change', () => {
  const o = preset.selectedOptions[0];
  if (o.dataset.from) { fromIn.value = o.dataset.from; toIn.value = o.dataset.to; form.requestSubmit(); }
});
[fromIn, toIn].forEach(i => i.addEventListener('input', syncPreset));
form.addEventListener('submit', (e) => { e.preventDefault(); load().catch(showError); });
