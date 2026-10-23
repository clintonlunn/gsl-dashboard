// "Right now": the latest 15-minute USGS readings at the river mouths and the lake, and the latest Salt Lake City airport
// observation, fetched by the browser straight from USGS and the NWS so they don't wait for the hourly rebuild
import { state } from './state.js';
import { el, b, link, fmtInt, fmt1, USGS } from './util.js';

const LAKE = '10010000';
const MOUTHS = { '10126000': 'Bear River', '10141000': 'Weber River', '10170500': 'Jordan River', '10172600': 'Jordan River' };
const IV = (ids) => `https://waterservices.usgs.gov/nwis/iv/?${new URLSearchParams({ format: 'json', sites: ids.join(','), parameterCd: '00060,62614', period: 'PT4H', siteStatus: 'all' })}`;
const OBS = 'https://api.weather.gov/stations/KSLC/observations/latest';
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
let timer = null;

// latest value and the one about 3 hours before it, per site
async function gauges() {
  const j = await fetch(IV([LAKE, ...Object.keys(MOUTHS)])).then(r => r.ok ? r.json() : Promise.reject(new Error(`USGS ${r.status}`)));
  const out = {};
  for (const t of j.value.timeSeries) {
    const nd = t.variable.noDataValue, vals = t.values[0].value.filter(v => +v.value !== nd).map(v => ({ v: +v.value, t: new Date(v.dateTime) }));
    if (!vals.length) continue;
    const last = vals.at(-1), back = vals.find(v => last.t - v.t <= 3 * 3600e3) || vals[0];
    out[t.sourceInfo.siteCode[0].value] = { last, back };
  }
  return out;
}

function trend(now, before) {
  if (before == null || !before) return '';
  const r = now / before;
  return r > 1.1 ? `rising, from ${fmtInt(before)} 3 h ago` : r < 0.9 ? `falling, from ${fmtInt(before)} 3 h ago` : 'steady over 3 h';
}
function vsNormal(now, normal) {
  if (!normal) return '';
  const r = now / normal;
  return r >= 0.85 && r < 1.15 ? 'normal' : r < 1 ? `${Math.round(r * 100)}% of normal` : `${r.toFixed(1)}× normal`;
}

const item = (label, val, sub) => el('li', {}, el('span', { className: 'lbl', textContent: label }), el('span', { className: 'val', textContent: val }), el('span', { className: 'sub', textContent: sub }));

export async function drawNow() {
  clearTimeout(timer);
  timer = setTimeout(drawNow, 5 * 60 * 1000);
  const list = document.getElementById('now-list'), when = document.getElementById('now-time');
  const [g, w] = await Promise.allSettled([gauges(), fetch(OBS, { headers: { Accept: 'application/geo+json' } }).then(r => r.ok ? r.json() : Promise.reject(new Error(`NWS ${r.status}`)))]);
  const items = [], times = [];

  if (w.status === 'fulfilled') {
    const p = w.value.properties, mm = p.precipitationLastHour?.value, c = p.temperature?.value;
    times.push(new Date(p.timestamp));
    const rain = mm == null ? 'no rain reported last hour' : mm > 0 ? `${(mm / 25.4).toFixed(2)} in of rain last hour` : 'no rain last hour';
    items.push(item('Salt Lake airport', p.textDescription || '—', `${rain}${c == null ? '' : ` · ${Math.round(c * 9 / 5 + 32)}°F`}`));
  } else items.push(item('Salt Lake airport', '—', 'Weather Service reading unavailable.'));

  if (g.status === 'fulfilled') {
    const G = g.value;
    // normal is the period's baseline (the 14 days before it), so it only means "now" for the default period
    const base = state.DATA?.window?.is_default ? Object.fromEntries((state.DATA.by_site || []).map(s => [s.site_id, s.baseline_cfs])) : {};
    for (const river of [...new Set(Object.values(MOUTHS))]) {
      const ids = Object.keys(MOUTHS).filter(id => MOUTHS[id] === river && G[id]);
      if (!ids.length) { items.push(item(river, '—', 'no reading')); continue; }
      const now = ids.reduce((s, id) => s + G[id].last.v, 0), before = ids.reduce((s, id) => s + G[id].back.v, 0);
      const normal = ids.every(id => base[id]) ? ids.reduce((s, id) => s + base[id], 0) : null;
      ids.forEach(id => times.push(G[id].last.t));
      items.push(item(river, `${fmtInt(now)} cfs`, [trend(now, before), vsNormal(now, normal)].filter(Boolean).join(' · ') + (ids.length > 1 ? ' (both outlets)' : '')));
    }
    if (G[LAKE]) {
      const { last, back } = G[LAKE], d = (last.v - back.v) * 12;
      times.push(last.t);
      items.push(item('Lake level', `${fmt1(last.v)} ft`, Math.abs(d) < 0.5 ? 'steady over 3 h' : `${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)} in over 3 h; wind moves it`));
    }
  } else items.push(item('Rivers and lake', '—', 'USGS readings unavailable.'));

  list.replaceChildren(...items);
  const newest = times.sort((a, c) => c - a)[0];
  when.textContent = newest ? `· ${clock(newest)}` : '';
  document.getElementById('src-now').replaceChildren('Source: USGS 15-minute readings, gauges ',
    ...[LAKE, ...Object.keys(MOUTHS)].flatMap((id, i) => [i ? ', ' : '', link(id, USGS(id))]),
    ' (provisional); Salt Lake City airport (KSLC) observation from the ', link('National Weather Service API', 'https://www.weather.gov/documentation/services-web-api'),
    '. Fetched by your browser every 5 minutes. Normal is the middle flow of the two weeks before the period shown.');
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') drawNow(); });
