// NWS Colorado Basin River Forecast Center: what forecasters expect the rivers to bring the lake.
// Seasonal April–July volume forecasts (January–June), early model guidance (December–), and ~10-day river
// forecasts at the river mouths. Data from sources/cbrfc.py (DATA.sources.cbrfc, HIST.sources.cbrfc).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt } = G;
  const CB = 'https://www.cbrfc.noaa.gov/';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const RIVER_VAR = { 'Bear River': '--bear', 'Weber River': '--weber', 'Jordan River': '--jordan' };
  const day = (iso) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (iso, year = true) => day(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
  const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' });
  const fmtWeekday = (iso) => new Date(iso).toLocaleDateString('en-US', { weekday: 'long' });
  const kaf = (v) => v == null ? '—' : v >= 100 ? fmtInt(v) : v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2);
  const pct = (v) => v == null ? '—' : `${Math.round(v)}%`;
  const cfs = (v) => v == null ? '—' : fmtInt(Math.round(v));
  const short = (name) => name.replace(/ (near|at|above|below) .*$/, '');
  const period = (p, wy) => {
    const m = /^(\w{3})\w* \d+-(\w{3})\w* \d+$/.exec(p || '');
    const full = (s) => MONTHS.find(n => n.startsWith(s)) || s;
    return m ? `${full(m[1])}–${full(m[2])} ${wy}` : `${p} ${wy}`;
  };
  const midMonth = (d) => `${d.getDate() <= 10 ? 'early' : d.getDate() <= 20 ? 'mid' : 'late'}-${MONTHS[d.getMonth()]}`;
  const vsNormal = (v, normal) => {
    if (v == null || !normal) return '';
    const r = v / normal;
    return r >= 0.85 && r < 1.15 ? 'about normal' : r < 1 ? `${Math.round(r * 100)}% of normal` : `${r.toFixed(r < 10 ? 1 : 0)}× normal`;
  };

  document.head.append(el('style', { textContent: `
    .cbrfc-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: .875rem; color: var(--ink-2); }
    .cbrfc-list b { color: var(--ink); font-family: var(--mono); font-weight: 600; }
    .cbrfc-list .nm { color: var(--ink); }
    .cbrfc-sub { font: 600 .8125rem var(--sans); color: var(--ink-2); margin: 12px 0 4px; }
    .cbrfc-tbl td:nth-child(2), .cbrfc-tbl th:nth-child(2), .cbrfc-tbl td:nth-child(3), .cbrfc-tbl th:nth-child(3) { text-align: right; }
    .cbrfc-tbl th[scope=row] { text-align: left; font: inherit; color: var(--ink); white-space: normal; min-width: 14rem; }
    .cbrfc-tbl td.l, .cbrfc-tbl th.l { text-align: left; }
    .cbrfc-tbl tr.key th[scope=row] { font-weight: 600; }
    .cbrfc-flow-chart { width: 100%; height: 300px; }
    .cbrfc-hist-chart { width: 100%; height: 320px; }
    .cbrfc-hist details { margin-top: 10px; font-size: .9rem; color: var(--ink-2); }
    .cbrfc-hist summary { cursor: pointer; color: var(--ink); min-height: 24px; }
    .cbrfc-hist label { font-size: .875rem; color: var(--ink-2); }
    .cbrfc-hist select { font: .875rem var(--sans); min-height: 32px; margin-left: 6px; }
  ` }));

  const srcParts = (d, { flows = true, seasonal = true } = {}) => {
    const L = d?.links || {};
    const parts = ['NWS ', link('Colorado Basin River Forecast Center', CB)];
    if (seasonal) {
      parts.push(', ', link('official water supply forecasts', L.list || CB), ' (', link('map', L.map || CB), ', ',
        link('discussion', L.discussion || CB), ')');
      if (d?.latest_issue) parts.push(`, last issued ${fmtDate(d.latest_issue)}`);
    }
    if (flows && d?.flows?.length) {
      parts.push(seasonal ? '; ' : ', ', 'river forecasts for ');
      d.flows.forEach((f, i) => parts.push(i ? (i === d.flows.length - 1 ? ' and ' : ', ') : '', link(short(f.name), f.url)));
      if (d.flows[0].issued) parts.push(`, issued ${fmtWhen(d.flows[0].issued)}`);
    }
    parts.push('.');
    return parts;
  };

  // one sentence about a river-mouth forecast: where it is now and where forecasters expect it to go
  function flowSentence(f, { lead = false } = {}) {
    if (!f.latest || !f.end) return null;
    const now = f.latest.cfs, end = f.end.cfs, pk = f.peak;
    const rises = pk && pk.cfs > now * 1.1 && pk.ts > f.latest.ts && pk.ts < f.end.ts;
    const name = lead ? `the ${f.name}` : f.name;
    const norm = vsNormal(rises ? pk.cfs : end, rises ? f.normal_today : f.normal_end);
    const tail = norm ? `, ${norm} for ${midMonth(new Date(rises ? pk.ts : f.end.ts))}` : '';
    if (rises) return [`${lead ? 'Forecasters expect ' : ''}${name} to rise from `, b(`${cfs(now)} cfs`), ' to about ', b(`${cfs(pk.cfs)} cfs`), ` by ${fmtWeekday(pk.ts)}, then ease to ${cfs(end)}${tail}.`];
    if (end < now * 0.9) return [`${lead ? 'Forecasters expect ' : ''}${name} to drop from `, b(`${cfs(now)} cfs`), ' to about ', b(`${cfs(end)} cfs`), ` by ${fmtDate(f.end.ts, false)}${tail}.`];
    return [`${lead ? 'Forecasters expect ' : ''}${name} to hold near `, b(`${cfs(end)} cfs`), ` through ${fmtDate(f.end.ts, false)}${tail}.`];
  }

  const keyPoints = (d) => (d.key_ids || []).map(id => d.points.find(p => p.id === id)).filter(Boolean);

  // ------------------------------------------------------------ At a glance
  G.register({
    id: 'cbrfc', tab: 'glance', order: 55,
    mount(slot) {
      const root = el('div', { className: 'fact', id: 'cbrfc-fact' },
        el('h2', { id: 'cbrfc-h', textContent: 'What forecasters expect' }),
        el('p', { className: 'lead', id: 'cbrfc-lead', textContent: '—' }),
        el('div', { id: 'cbrfc-vis' }),
        el('p', { className: 'src', id: 'cbrfc-src' }));
      root.setAttribute('aria-labelledby', 'cbrfc-h');
      slot.append(root);
      return root;
    },
    render(d) {
      const lead = document.getElementById('cbrfc-lead'), vis = document.getElementById('cbrfc-vis');
      if (!d || d.error || (!d.points?.length && !d.flows?.length)) {
        lead.textContent = d?.error ? `River forecasts are unavailable: ${d.error}` : 'River forecasts have not been downloaded yet.';
        lead.classList.toggle('err', !!d?.error);
        vis.replaceChildren();
        cite('cbrfc-src', ...srcParts(d));
        return;
      }
      lead.classList.remove('err');
      const keys = keyPoints(d);
      const bear = keys.find(p => p.river === 'Bear River') || keys[0];
      const blocks = [];

      if (d.status === 'official' && bear) {
        lead.replaceChildren(`Forecasters expect the ${short(bear.name)} to bring `, b(pct(bear.pct_avg)), ` of its usual ${period(bear.period, bear.wy)} flow (forecast of ${fmtDate(bear.issued)}).`);
        blocks.push(el('ul', { className: 'cbrfc-list' }, ...keys.map(p => el('li', {},
          el('span', { className: 'nm', textContent: `${p.name}: ` }), b(`${kaf(p.most_probable)} thousand acre-ft`), ` most likely, ${pct(p.pct_avg)} of usual; likely range ${kaf(p.likely_low)}–${kaf(p.likely_high)}.`))));
      } else if (d.status === 'guidance' && d.guidance.length) {
        const g = d.guidance.map(x => ({ ...x, p: d.points.find(p => p.id === x.id) })).filter(x => x.p);
        const gb = g.find(x => x.p.river === 'Bear River') || g[0];
        lead.replaceChildren(`No official forecast yet for ${d.water_year}. Early computer-model guidance points to the ${short(gb.p.name)} bringing about `, b(pct(gb.pct_avg)), ` of its usual April–July flow. Expect this to change a lot until the snowpack builds.`);
        blocks.push(el('ul', { className: 'cbrfc-list' }, ...g.map(x => el('li', {},
          el('span', { className: 'nm', textContent: `${x.p.name}: ` }), b(`${kaf(x.most_probable)} thousand acre-ft`), ` (${pct(x.pct_avg)} of usual), model run of ${fmtDate(x.run_date, false)}.`))));
      } else {
        const fb = d.flows.find(f => f.river === 'Bear River') || d.flows[0];
        const s = fb && flowSentence(fb, { lead: true });
        lead.replaceChildren(...(s || ['No short-range river forecast right now.']),
          ` Seasonal snowmelt forecasts for ${d.water_year} begin with the January 1 issue.`);
      }

      const flows = d.flows.filter(f => f.latest && f.end);
      if (flows.length && d.status !== 'off-season') blocks.push(el('p', { className: 'cbrfc-sub', textContent: 'Next 10 days at the river mouths' }));
      if (flows.length) blocks.push(el('ul', { className: 'cbrfc-list' }, ...flows.map(f => {
        const pk = f.peak && f.peak.cfs > f.latest.cfs * 1.1 && f.peak.ts > f.latest.ts ? f.peak : null;
        return el('li', {}, el('span', { className: 'nm', textContent: `${short(f.name)}: ` }), b(`${cfs(f.latest.cfs)} cfs`), ' now',
          ...(pk ? [', peak about ', b(cfs(pk.cfs)), ` ${fmtWeekday(pk.ts)}`] : []), ', ', b(cfs(f.end.cfs)), ` by ${fmtDate(f.end.ts, false)}`,
          f.normal_today ? ` (normal now ${cfs(f.normal_today)}).` : '.');
      })));

      // off-season: how last spring turned out against the forecast
      if (d.status !== 'official' && keys.length && keys.some(p => p.observed != null)) {
        const wy = keys[0].wy;
        blocks.push(el('p', { className: 'cbrfc-sub', textContent: `How ${period(keys[0].period, wy)} turned out` }));
        blocks.push(el('ul', { className: 'cbrfc-list' }, ...keys.filter(p => p.observed != null).map(p => el('li', {},
          el('span', { className: 'nm', textContent: `${p.name}: ` }), b(`${kaf(p.observed)} thousand acre-ft`), `, ${pct(p.observed_pct_avg)} of usual`,
          `${p.observed_final ? '' : ' so far'} (${fmtDate(p.issued, false)} forecast: ${kaf(p.most_probable)}).`))));
      }
      vis.replaceChildren(...blocks);
      cite('cbrfc-src', ...srcParts(d), ' Volumes are natural flow (before reservoirs and diversions); "likely range" is the 90%–10% exceedance span, an 8-in-10 chance.');
    },
  });

  // ------------------------------------------------------------ Details: every forecast point, and the 10-day flows
  G.register({
    id: 'cbrfc', tab: 'details', order: 55,
    mount(slot) {
      const root = el('section', { className: 'section', id: 'cbrfc-details' },
        el('h2', { id: 'cbrfc-d-h', textContent: 'River Forecast Center: seasonal and 10-day forecasts' }),
        el('p', { className: 'note', id: 'cbrfc-d-note' }),
        el('div', { id: 'cbrfc-d-table' }),
        el('h3', { className: 'cbrfc-sub', id: 'cbrfc-d-flow-h', textContent: 'Next 10 days at the river mouths' }),
        el('div', { className: 'cbrfc-flow-chart', id: 'cbrfc-flow-chart' }),
        el('div', { id: 'cbrfc-d-flows' }),
        el('p', { className: 'src', id: 'cbrfc-d-src' }));
      root.setAttribute('aria-labelledby', 'cbrfc-d-h');
      slot.append(root);
      return root;
    },
    render(d) {
      const note = document.getElementById('cbrfc-d-note'), tbox = document.getElementById('cbrfc-d-table');
      if (!d || d.error) {
        note.textContent = d?.error || 'River forecasts are not available right now.';
        tbox.replaceChildren(); document.getElementById('cbrfc-d-flows').replaceChildren();
        G.emptyChart('cbrfc-flow-chart', 'No river forecast.');
        cite('cbrfc-d-src', ...srcParts(d));
        return;
      }
      const P = d.points || [];
      const wy = P[0]?.wy;
      note.textContent = (d.status === 'official' ? '' : `Seasonal forecasts for ${d.water_year} start in January; the table shows the last ones issued, for ${wy}, next to what actually ran off. `)
        + 'Each seasonal forecast is the volume of water expected to pass the point from April through July, in thousand acre-feet (1 thousand acre-ft is about 326 million gallons). '
        + '"Most likely" is the middle forecast (a 50% chance of more). "Likely range" runs from the 90% to the 10% exceedance forecast: an 8-in-10 chance the real volume lands inside it. '
        + '"Usual" is the 1991–2020 average. Volumes are natural flow, before upstream reservoirs and diversions, except at Stewart Dam (regulated). Bold rows are the points summarized on the first tab.';
      tbox.replaceChildren(P.length ? el('div', { className: 'tablewrap' }, el('table', { className: 'cbrfc-tbl' },
        el('caption', { textContent: `${P.length} CBRFC forecast points in the Great Salt Lake basin, forecast of ${fmtDate(P[0].issued)}${d.issues?.length > 1 ? ` (issued ${d.issues.length} times that season)` : ''}. Each name links to its CBRFC page.` }),
        el('thead', {}, el('tr', {}, ...['Forecast point', 'Most likely', '% of usual', 'Likely range', 'Usual', 'What ran off', 'Ran off, % of usual', 'CBRFC id'].map((t, i) =>
          el('th', { scope: 'col', className: i >= 7 ? 'l' : '', textContent: t })))),
        el('tbody', {}, ...P.map(p => {
          const tr = el('tr', { className: p.key ? 'key' : '' },
            el('th', { scope: 'row' }, link(p.name, p.url), p.regulated ? ' (regulated)' : ''),
            el('td', { textContent: kaf(p.most_probable) }),
            el('td', { textContent: pct(p.pct_avg) }),
            el('td', { textContent: `${kaf(p.likely_low)}–${kaf(p.likely_high)}` }),
            el('td', { textContent: kaf(p.avg) }),
            el('td', { textContent: p.observed == null ? '—' : `${kaf(p.observed)}${p.observed_final ? '' : ' so far'}` }),
            el('td', { textContent: pct(p.observed_pct_avg) }),
            el('td', { className: 'l', textContent: p.id }));
          return tr;
        })),
        el('tfoot', {}, el('tr', {}, el('td', { colSpan: 8, className: 'l', style: 'white-space:normal;color:var(--ink-2);font:.8125rem var(--sans)',
          textContent: `All volumes in thousand acre-feet for ${period(P[0].period, wy)}. "What ran off" is CBRFC's observed natural-flow volume; points without one had no observed series in CBRFC's season file.` }))))) : el('p', { className: 'empty', textContent: 'No seasonal forecasts downloaded yet.' }));

      // 10-day flows: chart + table
      const F = (d.flows || []).filter(f => f.forecast?.length);
      if (!F.length) G.emptyChart('cbrfc-flow-chart', 'No river forecast right now.');
      else {
        const o = G.base();
        const series = [];
        F.forEach(f => {
          const color = css(RIVER_VAR[f.river] || '--hydro');
          const nm = short(f.name);
          series.push({ name: `${nm}, measured`, type: 'line', showSymbol: false, lineStyle: { width: 2, color }, itemStyle: { color },
            data: f.observed.map(([t, v]) => [new Date(t), v]) });
          series.push({ name: `${nm}, forecast`, type: 'line', showSymbol: false, lineStyle: { width: 2, color, type: 'dashed' }, itemStyle: { color },
            data: f.forecast.map(([t, v]) => [new Date(t), v]) });
          series.push({ name: `${nm}, normal (median)`, type: 'line', showSymbol: false, lineStyle: { width: 1, color, type: 'dotted', opacity: .8 }, itemStyle: { color },
            data: f.normal.map(([t, , m]) => [day(t).getTime() + 12 * 3600e3, m]) });
        });
        o.series = series;
        o.legend = { top: 0, left: 0, textStyle: { color: css('--ink'), fontSize: 12 }, itemWidth: 22, itemHeight: 8 };
        o.grid.top = 64;
        o.yAxis = { ...o.yAxis, name: 'cfs', nameTextStyle: { color: css('--ink-2'), fontSize: 12 }, axisLabel: { color: css('--ink-2'), formatter: (v) => fmtInt(v) } };
        o.tooltip.valueFormatter = (v) => v == null ? '—' : `${cfs(v)} cfs`;
        o.aria.label = { enabled: true, description: `River flow at the river mouths: the last 10 days measured (solid), CBRFC's forecast for the next 10 days (dashed), and the historical median for each date (dotted). `
          + F.map(f => `${f.name}: ${cfs(f.latest?.cfs)} cfs now, forecast ${cfs(f.end?.cfs)} cfs by ${fmtDate(f.end.ts, false)}, peak ${cfs(f.peak?.cfs)} cfs; median for today ${cfs(f.normal_today)} cfs.`).join(' ')
          + ' A table with the same numbers follows.' };
        G.chart('cbrfc-flow-chart').setOption(o, true);
      }
      document.getElementById('cbrfc-d-flows').replaceChildren(F.length ? el('div', { className: 'tablewrap' }, el('table', { className: 'cbrfc-tbl' },
        el('caption', { textContent: `CBRFC short-range river forecasts, issued ${F[0].issued ? fmtWhen(F[0].issued) : '—'} (your local time). Flows in cubic feet per second.` }),
        el('thead', {}, el('tr', {}, ...['River point', 'Now', 'Peak in forecast', 'End of forecast', 'Normal now (median)', 'Usual range now', 'Flood flow', 'USGS gauge'].map((t, i) =>
          el('th', { scope: 'col', className: i >= 7 ? 'l' : '', textContent: t })))),
        el('tbody', {}, ...F.map(f => {
          const n0 = f.normal.find(r => r[0] === new Date().toLocaleDateString('en-CA')) || f.normal[Math.floor(f.normal.length / 2)];
          return el('tr', {},
            el('th', { scope: 'row' }, link(f.name, f.url)),
            el('td', { textContent: cfs(f.latest?.cfs) }),
            el('td', { textContent: f.peak ? `${cfs(f.peak.cfs)}, ${fmtWhen(f.peak.ts)}` : '—' }),
            el('td', { textContent: f.end ? `${cfs(f.end.cfs)}, ${fmtDate(f.end.ts, false)}` : '—' }),
            el('td', { textContent: cfs(f.normal_today) }),
            el('td', { textContent: n0 ? `${cfs(n0[1])}–${cfs(n0[3])}` : '—' }),
            el('td', { textContent: cfs(f.flood_cfs) }),
            el('td', { className: 'l' }, f.usgs ? link(f.usgs, `https://waterdata.usgs.gov/monitoring-location/${f.usgs}/`) : '—'));
        })),
        el('tfoot', {}, el('tr', {}, el('td', { colSpan: 8, className: 'l', style: 'white-space:normal;color:var(--ink-2);font:.8125rem var(--sans)',
          textContent: '"Usual range" is the middle half of past years for this date (between the 75% and 25% exceedance flows). Forecasts further out are less certain; CBRFC labels the later days an outlook.' }))))) : '');
      cite('cbrfc-d-src', ...srcParts(d));
    },
  });

  // ------------------------------------------------------------ History: April 1 forecast vs what came
  let histPick = null;
  G.register({
    id: 'cbrfc', tab: 'history', order: 65,
    mount(slot) {
      const sel = el('select', { id: 'cbrfc-hist-pick' });
      const root = el('section', { className: 'section cbrfc-hist', id: 'cbrfc-hist' },
        el('h2', { id: 'cbrfc-hist-h', textContent: 'Snowmelt forecasts against what came' }),
        el('p', { className: 'note', id: 'cbrfc-hist-note' }),
        el('label', {}, 'Forecast point', sel),
        el('div', { className: 'cbrfc-hist-chart', id: 'cbrfc-hist-chart' }),
        el('div', { id: 'cbrfc-hist-table' }),
        el('p', { className: 'src', id: 'cbrfc-hist-src' }));
      root.setAttribute('aria-labelledby', 'cbrfc-hist-h');
      slot.append(root);
      return root;
    },
    renderHistory(h) {
      const note = document.getElementById('cbrfc-hist-note');
      const P = (h?.points || []).filter(p => p.years.length);
      const sel = document.getElementById('cbrfc-hist-pick');
      if (!P.length || h.error) {
        note.textContent = h?.error || 'Past forecasts are still downloading from CBRFC (a few each hour).';
        G.emptyChart('cbrfc-hist-chart', 'No past forecasts yet.');
        document.getElementById('cbrfc-hist-table').replaceChildren();
        cite('cbrfc-hist-src', ...srcParts(h, { flows: false, seasonal: false }), '');
        return;
      }
      if (!histPick || !P.some(p => p.id === histPick)) histPick = (P.find(p => p.id === 'GATU1') || P[0]).id;
      sel.replaceChildren(...P.map(p => el('option', { value: p.id, textContent: p.name, selected: p.id === histPick })));
      sel.onchange = () => { histPick = sel.value; this.renderHistory(h); };
      const p = P.find(x => x.id === histPick);
      const Y = p.years;
      note.textContent = `Each April 1, CBRFC forecasts how much water will pass the point from April through July. The bar is the April 1 likely range (an 8-in-10 chance), the diamond the most likely value, and the dot what actually ran off. `
        + `The dashed line is the 1991–2020 average${p.avg ? ` (${kaf(p.avg)} thousand acre-ft)` : ''}. Natural flow, in thousand acre-feet.`;
      const ink = css('--ink'), ink2 = css('--ink-2'), pen = css('--pen'), hydro = css('--hydro');
      const o = G.base();
      const cats = Y.map(y => String(y.wy));
      o.xAxis = { type: 'category', data: cats, axisLine: { lineStyle: { color: css('--rule') } }, axisLabel: { color: ink2, fontSize: 12 } };
      o.yAxis = { ...o.yAxis, name: 'thousand acre-ft', nameTextStyle: { color: ink2, fontSize: 12, align: 'left' }, axisLabel: { color: ink2, formatter: (v) => fmtInt(v) } };
      o.grid.top = 56;
      o.legend = { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, data: ['April 1 likely range', 'April 1 most likely', 'What ran off'] };
      o.tooltip = { ...o.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps) => {
        const y = Y[ps[0].dataIndex];
        return [`Water year ${y.wy}`, `April 1 most likely: <b>${kaf(y.apr1_most_probable)}</b>`, `Likely range: ${kaf(y.apr1_likely_low)}–${kaf(y.apr1_likely_high)}`,
          `What ran off: <b>${kaf(y.observed)}</b>${y.observed_final ? '' : ' (so far)'}`].join('<br>');
      } };
      o.series = [
        { name: '_base', type: 'bar', stack: 'r', silent: true, itemStyle: { color: 'transparent' }, tooltip: { show: false }, data: Y.map(y => y.apr1_likely_low) },
        { name: 'April 1 likely range', type: 'bar', stack: 'r', barMaxWidth: 26, itemStyle: { color: css('--hydro-fill'), borderColor: hydro, borderWidth: 1 },
          data: Y.map(y => y.apr1_likely_high == null || y.apr1_likely_low == null ? null : y.apr1_likely_high - y.apr1_likely_low),
          markLine: p.avg ? { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: ink2 }, label: { color: ink2, formatter: 'Average', position: 'insideEndTop' }, data: [{ yAxis: p.avg }] } : undefined },
        { name: 'April 1 most likely', type: 'scatter', symbol: 'diamond', symbolSize: 12, itemStyle: { color: hydro, borderColor: ink, borderWidth: 1 }, z: 4, data: Y.map(y => y.apr1_most_probable) },
        { name: 'What ran off', type: 'scatter', symbol: 'circle', symbolSize: 10, itemStyle: { color: pen, borderColor: ink, borderWidth: 1 }, z: 5, data: Y.map(y => y.observed) },
      ];
      const inside = Y.filter(y => y.observed != null && y.apr1_likely_low != null && y.observed >= y.apr1_likely_low && y.observed <= y.apr1_likely_high).length;
      const judged = Y.filter(y => y.observed != null && y.apr1_likely_low != null).length;
      o.aria.label = { enabled: true, description: `${p.name}: April 1 forecasts of April–July runoff against what actually ran off, water years ${Y[0].wy}–${Y[Y.length - 1].wy}. `
        + `In ${inside} of ${judged} years the real volume landed inside the April 1 likely range. A table of every year follows the chart.` };
      o.aria.decal = { show: false };
      G.chart('cbrfc-hist-chart').setOption(o, true);
      document.getElementById('cbrfc-hist-table').replaceChildren(el('details', {},
        el('summary', { textContent: `Every year, ${p.name} (in ${inside} of ${judged} years the real volume landed inside the likely range)` }),
        el('div', { className: 'tablewrap' }, el('table', { className: 'cbrfc-tbl' },
          el('caption', { textContent: 'April–July natural flow, thousand acre-feet' }),
          el('thead', {}, el('tr', {}, ...['Water year', 'April 1 most likely', 'April 1 likely range', 'What ran off'].map(t => el('th', { scope: 'col', textContent: t })))),
          el('tbody', {}, ...Y.slice().reverse().map(y => el('tr', {},
            el('td', { textContent: String(y.wy) }), el('td', { textContent: kaf(y.apr1_most_probable) }),
            el('td', { textContent: y.apr1_likely_low == null ? '—' : `${kaf(y.apr1_likely_low)}–${kaf(y.apr1_likely_high)}` }),
            el('td', { textContent: y.observed == null ? '—' : `${kaf(y.observed)}${y.observed_final ? '' : ' so far'}` }))))))));
      cite('cbrfc-hist-src', 'NWS ', link('Colorado Basin River Forecast Center', CB), ', ', link(`season record for ${p.id}`, p.url),
        ' (official April 1 forecasts and observed April–July volume, ', link('archive', h.links?.list || CB), ').');
    },
  });
})();
