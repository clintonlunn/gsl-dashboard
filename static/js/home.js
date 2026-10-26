import { barChart, chart, charts, emptyChart, lineChart } from './charts.js';
import { knobs } from './knobs.js';
import { setKnobs } from './main.js';
import { drawMap } from './map.js';
import { PANELS, renderPanels } from './panels.js';
import { toIn, today } from './period.js';
import { state } from './state.js';
import { ACIS, GAL_PER_AF, POOL_GAL, RIVER_COLOR, USGS, b, cite, css, el, fmt1, fmtDay, fmtInt, gaugeLinks, isoDay, link, parseDay, parseHour, pretty, ratioOf, shortName, timesNormal } from './util.js';

// ---------------------------------------------------------------- water ledger
function renderLedger(D, { rainAf, riverAf, rain, size, lake, wt }) {
  const S = D.sources || {};
  const evap = S.evaporation?.available ? S.evaporation : null;
  const div = S.diversions?.total && !S.diversions.error ? S.diversions.total : null;
  const res = S.reservoirs?.total && !S.reservoirs.error ? S.reservoirs.total : null;
  const area = size?.area_acre;
  const toIn = (af) => area ? af / area * 12 : null;
  const inAf = rainAf + riverAf, outAf = evap?.evap_af ?? null;
  const netAf = outAf == null ? null : inAf - outAf;
  const af = (v) => v == null ? '—' : `${v < 0 ? '−' : '+'}${fmtInt(Math.abs(v))}`;
  const inch = (v) => v == null ? '' : `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(2)} in`;
  const max = Math.max(inAf, outAf || 0, 1);
  const bar = (v) => { const w = el('div', { className: 'lbar' }); w.setAttribute('aria-hidden', 'true'); if (v) { const s = el('span', { className: v > 0 ? 'in' : 'out' }); s.style.width = `${Math.min(50, Math.abs(v) / max * 50)}%`; w.append(s); } return el('td', { className: 'barcell' }, w); };
  const row = (label, note, v, cls = '') => el('tr', { className: cls }, el('th', { scope: 'row' }, label, ...(note ? [el('small', { textContent: note })] : [])), bar(v), el('td', { className: 'num', textContent: af(v) }), el('td', { className: 'num', textContent: inch(v == null ? null : toIn(v)) }));
  const group = (t) => el('tr', { className: 'group' }, el('th', { scope: 'rowgroup', colSpan: 4, textContent: t }));
  const rows = [
    group('Into the lake'),
    row('Rain on the lake', rain ? `middle of ${rain.stations} lowland gauges` : 'not available for this period', rain ? rainAf : null),
    row('Rivers', 'Bear, Weber and Jordan, at their last gauges', riverAf),
    group('Out of the lake'),
    row('Evaporation (estimate)', evap ? `likely ${fmtInt(evap.low_af)}–${fmtInt(evap.high_af)} acre-ft` : 'no estimate for this period', outAf == null ? null : -outAf),
    row('Net change', lake?.change_in != null ? `the lake gauge measured ${lake.change_in > 0 ? '+' : ''}${lake.change_in.toFixed(1)} in, wind included` : 'in minus out', netAf, 'net'),
    group('Kept upstream, never reached the lake'),
    row('Taken by canals', div ? `at least; ${div.reporting} of ${div.expected} canals reported` : 'not available for this period', div ? -div.af : null, 'sub'),
    row('Held back in reservoirs', res ? `${res.pct_full}% full; ${res.change_af >= 0 ? `gained ${fmtInt(res.change_af)}` : `released ${fmtInt(-res.change_af)}`} acre-ft` : 'not available for this period', res ? -res.change_af : null, 'sub'),
  ];
  const tbl = el('table', {}, el('caption', { textContent: `Acre-feet for ${wt.when}. Lake depth spreads each amount over the lake's surface; minus means water that left or never arrived.` }),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, el('span', { className: 'sr-only', textContent: 'Water' })), el('th', { scope: 'col' }, el('span', { className: 'sr-only', textContent: 'Bar' })), el('th', { scope: 'col', textContent: 'Acre-ft' }), el('th', { scope: 'col', textContent: 'Lake depth' }))),
    el('tbody', {}, ...rows));
  document.getElementById('ledger').replaceChildren(el('div', { className: 'tablewrap' }, tbl));
  const lead = document.getElementById('ledger-lead');
  if (netAf != null) lead.replaceChildren(netAf >= 0 ? 'More water came in than evaporated: about ' : 'More water evaporated than came in: about ', b(`${pretty(Math.abs(netAf) * GAL_PER_AF)} gallons`), ` ${netAf >= 0 ? 'gained' : 'lost'}, or ${Math.abs(toIn(netAf) ?? 0).toFixed(1)} in of lake depth.`, ...(div ? [' Upstream, canals took at least another ', b(`${pretty(div.af * GAL_PER_AF)} gallons`), '.'] : []));
  else lead.textContent = 'Inflow for this period; there is no evaporation estimate to set against it.';
  const missed = D.sources?.water_budget?.inflow_summary?.missed_share;
  cite('src-ledger', 'rain from ', ACIS(), '; rivers from USGS gauges; evaporation estimated from ', link('gridMET', 'https://www.climatologylab.org/gridmet.html'), ' reference ET × 0.884 (', link('Mohammed & Tarboton 2012', 'https://doi.org/10.1029/2012WR011908'), '); canals from ', link('Utah Division of Water Rights', 'https://waterrights.utah.gov/'), '; reservoirs from ', link('NRCS AWDB', 'https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html'), ' and Water Rights; lake area from ', link('USGS', 'https://doi.org/10.5066/P9DGG75W'), `. Not counted: groundwater, ungauged creeks${missed ? ` (about ${Math.round(missed * 100)}% of inflow per the state water budget)` : ''}.`);
}

// ---------------------------------------------------------------- home cards
// water in and out come from the page's own numbers; plug-in panels with a card(data, D) -> { val, sub } fill the rest
let cardArgs = null;
export const refreshCards = () => { if (cardArgs) renderCards(...cardArgs); };
function renderCards(D, { gallons, inIn, rain, size }) {
  cardArgs = [D, { gallons, inIn, rain, size }];
  const set = (id, val, sub) => { document.getElementById(`c-${id}`).textContent = val; document.getElementById(`c-${id}-sub`).textContent = sub; };
  const S = D.sources || {}, ev = S.evaporation?.available ? S.evaporation : null;
  const div = S.diversions?.total && !S.diversions.error ? S.diversions.total : null;
  set('in', size ? `+${inIn.toFixed(1)} in` : '—', `${rain ? 'Rain and rivers' : 'Rivers'} added about ${pretty(gallons)} gallons.`);
  set('out', ev ? `−${ev.evap_in.toFixed(1)} in` : '—', (ev ? 'Evaporation, estimated.' : 'No evaporation estimate for this period.') + (div?.af > 0 ? ` Canals took ${pretty(div.af * GAL_PER_AF)} gallons before the lake.` : ''));
  for (const [id, pid] of [['snow', 'snotel'], ['next', 'cbrfc']]) {
    const p = PANELS.find(x => x.id === pid && x.card);
    let c = null;
    try { c = p?.card(S[pid], D); } catch (e) { console.error(`card ${pid}`, e); }
    set(id, c?.val ?? '—', c?.sub ?? 'Not available right now.');
  }
}
// each card picks its topic and moves to the first block that shows
document.querySelectorAll('.card[data-go]').forEach(a => a.addEventListener('click', (e) => {
  e.preventDefault();
  setKnobs({ topic: a.dataset.go, view: knobs.view === 'map' ? 'summary' : knobs.view });
  const first = [...document.querySelectorAll('#stage [data-view]')].find(n => !n.hidden), h = first?.querySelector('h2');
  if (!first) return;
  first.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
}));

// ---------------------------------------------------------------- page
export function windowText(win) {
  const f = parseDay(win.from), t = parseDay(win.to), yrs = f.getFullYear() !== t.getFullYear() || f.getFullYear() !== new Date().getFullYear();
  if (win.is_default) return { lead: `In the last ${win.days} days`, when: `Last ${win.days} days, through ${fmtDay(t)}` };
  if (win.days >= 360) {
    const a = f.getFullYear(), c = t.getFullYear();
    return { lead: a === c ? `In ${a}` : `From ${fmtDay(f, true)} to ${fmtDay(t, true)}`, when: `${fmtDay(f, true)} – ${fmtDay(t, true)}` };
  }
  return win.from === win.to ? { lead: `On ${fmtDay(f, yrs)}`, when: fmtDay(f, yrs) } : { lead: `From ${fmtDay(f, yrs)} to ${fmtDay(t, yrs)}`, when: `${fmtDay(f, yrs)} – ${fmtDay(t, yrs)}` };
}

export function render() {
  const D = state.DATA; if (!D) return;
  const bySite = Object.fromEntries(D.by_site.map(s => [s.site_id, s]));
  const lake = D.lake_change[0]?.end_ft != null ? D.lake_change[0] : null;
  const size = D.lake_size[0], cfg = D.config, win = D.window, inflow = D.inflow[0];
  const daily = win.resolution === 'daily';
  const rain = D.rain_lake[0]?.rain_in != null ? D.rain_lake[0] : null;
  const rainIn = rain?.rain_in ?? 0, rainAf = rain?.rain_af ?? 0;
  const riverAf = Math.max(0, inflow.total_af), excessAf = inflow.excess_af;
  const riverIn = size ? riverAf / size.area_acre * 12 : 0;
  const level = lake?.latest_ft ?? size?.level_ft;
  const wt = windowText(win);
  const terminal = D.by_site.filter(s => s.role === 'terminal');
  const termIds = terminal.map(s => s.site_id);
  const upstream = D.by_site.filter(s => s.role === 'upstream' && s.readings > 0 && ratioOf(s) != null).sort((a, c) => ratioOf(c) - ratioOf(a));
  const lakeId = D.sites.find(s => s.role === 'lake')?.site_id || '10010000';
  const gallons = (rainAf + riverAf) * GAL_PER_AF;

  // headline: inflow for short periods; for long ones the measured change, since evaporation matters more than inflow
  document.getElementById('when').textContent = wt.when;
  const h = document.getElementById('answer-h'), p = document.getElementById('answer-p');
  const num = (t) => el('span', { className: 'num', textContent: t });
  const changeWords = (c) => { const ft = Math.abs(c) / 12; return Math.abs(c) >= 24 ? `${fmt1(ft)} feet` : `${Math.abs(c).toFixed(1)} inches`; };
  if (win.days <= 31 && rainIn >= 0.1) {
    h.replaceChildren(`${wt.lead}, rain and rivers added about `, num(`${(rainIn + riverIn).toFixed(1)} inches`), ' to the Great Salt Lake.');
    const ev = D.sources?.evaporation?.available ? D.sources.evaporation : null;
    if (ev) h.append(' Evaporation took back about ', num(`${ev.evap_in.toFixed(1)} inches`), '.');
    p.replaceChildren('That is about ', b(`${pretty(gallons)} gallons`), ', enough to fill ', b(`${fmtInt(Math.round(gallons / POOL_GAL / 1000) * 1000)} Olympic pools`), '. ');
  } else if (lake?.change_in != null) {
    const c = lake.change_in, steady = Math.abs(c) < 0.5;
    h.replaceChildren(`${wt.lead}, the Great Salt Lake ${steady ? 'held about steady' : c > 0 ? 'rose' : 'fell'}`, ...(steady ? ['.'] : [' about ', num(changeWords(c)), '.']));
    p.replaceChildren(rain && rainIn >= 0.05 ? `Rain on the lake (${rainIn.toFixed(1)} in) and rivers brought in about ` : 'Rivers brought in about ', b(`${pretty(gallons)} gallons`), `, while evaporation takes water out${c < 0 ? ', and it took out more' : ''}. `);
  } else {
    h.replaceChildren(`${wt.lead}, there aren't enough lake readings to say how the level changed.`);
    p.replaceChildren();
  }
  if (size && level != null && level < cfg.healthy_ft[0]) p.append(win.is_default ? 'The lake is still about ' : 'At the end of this period the lake was about ', b(`${(cfg.healthy_ft[0] - level).toFixed(0)} feet`), ' below its healthy level.');
  const conv = ' 1 acre-ft = 325,851 gallons; an Olympic pool holds 2,500 m³ (about 660,000 gallons).';
  cite('src-answer', ...(rain ? ['rain from ', ACIS(), '; '] : []), 'river flow from USGS gauges ', ...gaugeLinks(termIds), '; lake level from USGS gauge ', link(lakeId, USGS(lakeId)), '; lake area and volume from ', link('USGS tables', 'https://doi.org/10.5066/P9DGG75W'), '.' + conv);

  // the ledger: what came in, what went out, and what was kept upstream
  renderLedger(D, { rainAf, riverAf, rain, size, lake, wt });
  renderCards(D, { gallons, inIn: rain ? rainIn + riverIn : riverIn, rain, size });

  // where the water came from
  const parts = [...(rainAf > 0 ? [{ name: 'Rain on the lake', af: rainAf, color: css('--rain') }] : []),
    ...D.by_river.filter(r => r.total_af > 0).map(r => ({ name: r.river, af: r.total_af, color: css(RIVER_COLOR[r.river] || '--off') }))];
  const total = parts.reduce((a, c) => a + c.af, 0);
  const split = document.getElementById('split');
  const pct = (v) => new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 }).format(v);
  if (!total) split.replaceChildren(el('p', { className: 'empty', textContent: 'No rain or river readings for this period.' }));
  else split.replaceChildren(
    el('div', { className: 'split', role: 'img', ariaLabel: parts.map(x => `${x.name} ${pct(x.af / total)}`).join(', ') }, ...parts.map(x => { const s = el('span'); s.style.flex = `${x.af} 0 0`; s.style.background = x.color; return s; })),
    el('ul', { className: 'split-key' }, ...parts.map(x => { const i = el('i'); i.style.background = x.color; return el('li', {}, i, el('span', { textContent: x.name }), el('span', { className: 'v', textContent: `${pct(x.af / total)} · ${pretty(x.af * GAL_PER_AF)} gal` })); })));
  const src = document.getElementById('source-lead');
  const usual = D.usual_rivers?.[0], month = parseDay(win.to).toLocaleString('en-US', { month: 'long' });
  const top = parts.slice().sort((a, c) => c.af - a.af)[0];
  src.replaceChildren(!total ? 'No readings for this period.' : top.name === 'Rain on the lake' ? `Most of it fell straight onto the lake as rain.${usual ? ` The ${usual} is usually the biggest river in ${month}.` : ''}` : `The ${top.name} brought the most.${rain ? '' : win.days > cfg.rain_max_days ? ` Rain isn't counted for periods over ${Math.round(cfg.rain_max_days / 365.25)} years.` : ' Little rain fell on the lake.'}`);
  cite('src-source', ...(rain ? [ACIS(), ' rain reports; '] : []), 'USGS gauges ', ...gaugeLinks(termIds), '; lake area from ', link('USGS tables', 'https://doi.org/10.5066/P9DGG75W'), '.');

  // healthy ruler
  const hl = document.getElementById('health-lead'), ruler = document.getElementById('ruler');
  if (level != null) {
    hl.replaceChildren('Now ', b(`${fmt1(level)} ft`), ` above sea level. Healthy starts at ${fmtInt(cfg.healthy_ft[0])} ft`);
    if (size?.to_healthy_af > 0) hl.append(', about ', b(`${pretty(size.to_healthy_af * GAL_PER_AF)} gallons`), ' away.'); else hl.append('.');
    const [lo, hi] = cfg.healthy_ft, low = cfg.record_low_ft;
    const a = Math.floor(Math.min(low, level) - 1), z = Math.ceil(Math.max(hi, level) + 1);
    const x = (v) => `${(v - a) / (z - a) * 100}%`;
    const at = (cls, v, extra = {}) => { const e = el('span', { className: cls, ...extra }); e.style.left = x(v); return e; };
    const band = at('band', lo); band.style.width = `${(hi - lo) / (z - a) * 100}%`;
    // a label like "4,190" needs about 48px; widen the tick step until they fit the ruler
    const room = (ruler.clientWidth || 600) / 48, step = [2, 4, 5, 10, 20].find(st => (z - a) / st <= room) || 20;
    const ticks = []; for (let v = Math.ceil(a / step) * step; v <= z; v += step) ticks.push(at('tick', v), at('tick-l', v, { textContent: fmtInt(v) }));
    ruler.replaceChildren(el('span', { className: 'axis' }), band, at('band-l', (lo + hi) / 2, { textContent: 'Healthy' }), ...ticks,
      at('low', low), at('low-l', low, { textContent: 'Record low' }), at('now', level), at('now-l', level, { textContent: `Now ${fmt1(level)} ft` }));
    ruler.setAttribute('aria-label', `The lake is at ${fmt1(level)} feet. The healthy range is ${lo} to ${hi} feet. The record low is ${low} feet${cfg.record_low_day ? `, on ${fmtDay(parseDay(cfg.record_low_day), true)}` : ''}.`);
  } else { hl.textContent = 'No lake level readings.'; ruler.replaceChildren(); }
  cite('src-health', 'USGS gauge ', link(lakeId, USGS(lakeId)), '; healthy range from the ', link('Utah FFSL elevation matrix', 'https://ffsl.utah.gov/wp-content/uploads/Elevation_Matrix_3_1_13Cropped.pdf'), ' and ', link('Strike Team', 'https://wilkescenter.utah.edu/great-salt-lake/strike-team/'), '; gallons to healthy from ', link('USGS volume tables', 'https://doi.org/10.5066/P9DGG75W'), '; record low from ', link('USGS', 'https://www.usgs.gov/centers/ut-water/science/great-salt-lake-elevations'), '.');

  // rivers and creeks
  document.getElementById('flow-lead').textContent = daily ? 'Water each river carried to the lake in this period.' : 'Latest flow compared with normal for the two weeks before this period.';
  const fl = document.getElementById('flowlist'); fl.replaceChildren();
  const rows = daily ? terminal.map(s => [s, 'River mouth']) : [...terminal.map(s => [s, 'River mouth']), ...upstream.slice(0, 2).map(s => [s, 'Upstream, running highest'])];
  rows.forEach(([s, sub]) => {
    const r = ratioOf(s);
    const val = daily ? (s.window_af ? `${pretty(s.window_af * GAL_PER_AF)} gal` : 'no data') : s.readings ? timesNormal(s) : 'no data';
    fl.append(el('li', {}, el('span', {}, shortName(s), el('small', { textContent: sub })), el('span', { className: 'x' + (daily || r == null || r < 1.5 ? ' calm' : ''), textContent: val })));
  });
  if (!fl.children.length) fl.append(el('li', { textContent: 'No stream readings for this period.' }));
  cite('src-flow', 'USGS gauges ', ...gaugeLinks(rows.map(([s]) => s.site_id)), '.');

  // just the time when it's from today; the full date otherwise
  const at = D.refreshed_at, sameDay = at && at.slice(0, 10) === isoDay(new Date());
  document.getElementById('asof').textContent = at ? `Updated ${sameDay ? at.slice(11, 16) : at}` : '';

  // lake gauge chart
  if (D.lake_series.length) lineChart('chart-lake-level',
    [{ name: 'Saltair', color: css('--pen'), baseline: D.lake_change[0]?.start_ft, points: D.lake_series.map(r => ({ t: parseHour(r.hour), v: r.elev_ft })) }],
    { fmt: (v) => fmt1(v), axisFmt: (v) => fmt1(v), unit: ' ft', zero: false, zoom: true,
      alt: `Lake level at Saltair, between ${fmt1(Math.min(...D.lake_series.map(r => r.elev_ft)))} and ${fmt1(Math.max(...D.lake_series.map(r => r.elev_ft)))} feet.${lake ? ` It was ${lake.start_ft?.toFixed(2)} feet before the period and ${lake.end_ft.toFixed(2)} feet at its end.` : ''}` });
  else emptyChart('chart-lake-level', 'No lake level readings for this period.');
  cite('src-level', 'USGS gauge ', link(`${lakeId}, Great Salt Lake at Saltair Boat Harbor`, USGS(lakeId)), daily ? ', daily values.' : ', 15-minute readings averaged by hour.');

  // map: lake first, then river mouths, then upstream by how far above normal
  const priority = new Map([[lakeId, 0], ...terminal.map((s, i) => [s.site_id, 1 + i]), ...upstream.map((s, i) => [s.site_id, 10 + i])]);
  drawMap(D.imagery, D.sites, bySite, lake ?? (level != null ? { latest_ft: level } : null), priority);
  cite('src-map', 'gauge list and locations from the ', link('USGS NWIS site service', 'https://waterservices.usgs.gov/nwis/site/?format=rdb&huc=16010204,16020102,16020204&siteType=ST&hasDataTypeCd=iv&siteStatus=active'), ' (lower Bear, Weber and Jordan basins); picture from Copernicus Sentinel-2; place names from Esri.');

  // details: text always, charts only while open
  const set = (id, v) => { document.getElementById(id).textContent = v; };
  set('t-change', lake?.change_in == null ? '—' : (lake.change_in > 0 ? '+' : '') + lake.change_in.toFixed(1));
  set('t-level', level == null ? '—' : level.toFixed(2));
  set('t-rain', rain ? rainIn.toFixed(2) : '—'); set('t-stations', rain ? rain.stations : '0');
  set('t-river', fmtInt(riverAf)); set('t-excess', (excessAf >= 0 ? '+' : '') + fmtInt(excessAf));
  document.getElementById('t-excess-sub').hidden = daily;
  set('t-area', size ? fmtInt(size.area_acre) : '—'); set('t-area-lvl', size ? fmt1(size.level_ft) : '—');
  cite('src-tiles', 'lake change from USGS gauge ', link(lakeId, USGS(lakeId)), ...(rain ? ['; rain from ', ACIS()] : []), '; river water from USGS gauges ', ...gaugeLinks(termIds), '; lake surface from ', link('USGS tables', 'https://doi.org/10.5066/P9DGG75W'), '.');
  document.getElementById('tbl-cap').textContent = `Normal is the middle reading over the ${cfg.baseline_days} days before ${fmtDay(parseDay(win.from), true)}. Water totals cover ${wt.when}.${daily ? ' Long periods use daily values, which only the river mouths have here.' : ''}`;
  const tb = document.querySelector('#site-table tbody'); tb.replaceChildren();
  const f0 = (v) => v == null ? '—' : fmtInt(v);
  for (const s of D.by_site) {
    tb.append(el('tr', {}, el('td', {}, link(s.site_id, USGS(s.site_id))), el('td', { textContent: shortName(s) }), el('td', { textContent: s.role === 'terminal' ? 'River mouth' : 'Upstream' }),
      ...[f0(s.baseline_cfs), f0(s.peak_cfs), f0(s.latest_cfs), f0(s.window_af), s.excess_af == null || daily ? '—' : (s.excess_af >= 0 ? '+' : '') + fmtInt(s.excess_af)].map(t => el('td', { textContent: t }))));
  }
  cite('src-table', link('USGS NWIS', 'https://waterdata.usgs.gov/'), daily ? ' daily values' : ' instantaneous values', '; each site number links to its USGS page.');
  cite('src-rivers', 'USGS gauges ', ...gaugeLinks(termIds), '.');
  cite('src-cum', 'USGS gauges ', ...gaugeLinks(termIds), '.');
  cite('src-rain', ACIS(), ', MultiStnData daily precipitation.');
  if (upstream[0]) cite('src-jump', 'USGS gauge ', link(upstream[0].site_id, USGS(upstream[0].site_id)), '.');
  renderPanels();

  const flow = id => { const rs = D.flow_series.filter(r => r.site_id === id); return { baseline: daily ? null : rs[0]?.baseline_cfs, points: rs.map(r => ({ t: parseHour(r.hour), v: r.cfs })) }; };
  const termColor = { '10126000': css('--bear'), '10141000': css('--weber'), '10170500': css('--jordan'), '10172600': css('--ink') };
  lineChart('chart-rivers', terminal.map(s => ({ name: shortName(s), color: termColor[s.site_id] || css('--off'), ...flow(s.site_id) })),
    { fmt: fmtInt, unit: ' cfs', zoom: true, alt: `Flow at each river mouth. ${terminal.filter(s => s.readings).map(s => `${shortName(s)} peaked at ${fmtInt(s.peak_cfs)} cfs`).join('; ')}.` });
  const jump = upstream[0];
  if (jump && !daily) {
    document.getElementById('jump-note').textContent = `${shortName(jump)} (USGS ${jump.site_id}) is running furthest above its normal flow: ${timesNormal(jump)}.`;
    lineChart('chart-jump', [{ name: shortName(jump), color: css('--pen'), ...flow(jump.site_id) }],
      { fmt: fmtInt, unit: ' cfs', zoom: true, alt: `${shortName(jump)} flow. Normal ${fmtInt(jump.baseline_cfs)} cfs, peak ${fmtInt(jump.peak_cfs)} cfs, now ${fmtInt(jump.latest_cfs)} cfs.` });
  } else { document.getElementById('jump-note').textContent = 'Upstream gauges are only compared for periods up to two months.'; emptyChart('chart-jump', 'Not shown for long periods.'); }
  if (daily) emptyChart('chart-cum', 'Not shown for long periods.');
  else lineChart('chart-cum', [{ name: 'Total', color: css('--pen'), points: D.inflow_cumulative.map(r => ({ t: parseHour(r.hour), v: r.cum_excess_af })) }],
    { fmt: fmtInt, unit: ' acre-ft', alt: `Running total of river water above normal, ending at ${fmtInt(excessAf)} acre-feet.` });
  barChart('chart-rain', D.rain_stations, rain?.rain_in);
}
