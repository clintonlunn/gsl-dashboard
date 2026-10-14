// Groundwater around the lake: how well water levels changed over the past year, and the long record.
// Data from sources/ugs_groundwater.py (DATA.sources.ugs_groundwater, HIST.sources.ugs_groundwater).
// Water levels are USGS field measurements; the UGS Groundwater Data Portal has no recent wells near the lake,
// so the panel says so. Chemistry in the history panel is UGS Open-File Report 699 (STAC item OFR-699).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmt1, fmtInt, parseDay, fmtDay } = G;
  const FALLBACK = {
    usgs_api: 'https://api.waterdata.usgs.gov/ogcapi/v0/collections/field-measurements',
    usgs_docs: 'https://api.waterdata.usgs.gov/docs/ogcapi/',
    ugs_portal: 'https://gwportal.geology.utah.gov',
    stac_item: 'https://maps-assets.geology.utah.gov/warehouse/stac/ugs-publications/OFR/OFR-699/OFR-699.json',
    report: 'https://ugspub.nr.utah.gov/publications/open_file_reports/ofr-699/ofr-699.pdf',
    doi: 'https://doi.org/10.34191/OFR-699', ugs: 'https://geology.utah.gov/',
  };
  const ft = (v) => v == null ? '—' : `${fmt1(Math.abs(v))} ft`;
  const signed = (v) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt1(Math.abs(v))} ft`;
  const day = (iso, y = true) => fmtDay(parseDay(iso), y);
  const depth = (v) => v == null ? '—' : v < 0 ? `${fmt1(-v)} ft above ground` : `${fmt1(v)} ft down`;
  const plural = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;

  document.head.append(el('style', { textContent: `
    .ugs-gw .lead { margin: 4px 0 12px; }
    .ugs-gw .lead b { font-family: var(--mono); font-weight: 600; }
    .ugs-gw table { font-size: 13px; }
    .ugs-gw td, .ugs-gw th { padding: 3px 10px; }
    .ugs-gw td.n, .ugs-gw th.n { text-align: right; font-family: var(--mono); white-space: nowrap; }
    .ugs-gw caption { text-align: left; font-size: .8125rem; color: var(--ink-2); padding-bottom: 4px; }
    .ugs-gw h3 { font: 600 .9375rem var(--sans); margin: 18px 0 4px; }
    .ugs-gw details { margin-top: 10px; font-size: .875rem; color: var(--ink-2); }
    .ugs-gw summary { cursor: pointer; color: var(--ink); min-height: 24px; }
    .ugs-gw small { font-size: 12px; color: var(--ink-2); }
  ` }));

  const sourceParts = (d, L, withChem) => {
    const P = d?.portal;
    const portal = P ? ` Its ${plural(P.wells, 'well')} in this area are geologic-hazard monitoring wells, mostly in landslides on the Wasatch Front benches`
      + (P.last ? `, last read ${day(P.last.day)}` : '') + ', so they are not used here.' : '';
    return [
      'water levels are USGS field measurements of depth to water (parameter 72019) from the ', link('USGS Water Data API', L.usgs_api),
      ' (', link('API docs', L.usgs_docs), '); USGS data are public domain. ',
      'The Utah Geological Survey keeps its own water-level records in the ', link('UGS Groundwater Monitoring Data Portal', L.ugs_portal), '.', portal,
      ...(withChem ? [' Groundwater chemistry: Utah Geological Survey ', link('Open-File Report 699', L.doi), ', Mapping groundwater quality and chemistry adjacent to Great Salt Lake (2019; ',
        link('STAC item', L.stac_item), '), license CC BY 4.0.'] : []),
      ' More at ', link('geology.utah.gov', L.ugs), '.',
    ];
  };

  // ------------------------------------------------------------ Details: the past year
  G.register({
    id: 'ugs_groundwater', tab: 'details', order: 40,
    mount(slot) {
      const root = el('section', { className: 'section ugs-gw' },
        el('h2', { id: 'ugs-gw-h', textContent: 'Groundwater around the lake' }),
        el('p', { className: 'note', textContent: 'Rain and snowmelt that soak into the ground move slowly downhill under the valleys toward the lake. '
          + 'This groundwater feeds the springs and wetlands along the shore, where birds nest and feed, and some seeps straight into the lake from below. '
          + 'When wells near the lake show water levels dropping, less of that water is reaching the shore.' }),
        el('p', { className: 'lead', id: 'ugs-gw-lead', textContent: 'Loading…' }),
        el('div', { className: 'chart', id: 'chart-ugs-gw', role: 'img' }),
        el('p', { className: 'src', id: 'ugs-gw-how' }),
        el('div', { id: 'ugs-gw-wells' }),
        el('p', { className: 'src', id: 'ugs-gw-src' }));
      root.setAttribute('aria-labelledby', 'ugs-gw-h');
      slot.append(root);
      return root;
    },
    render(d) {
      const L = { ...FALLBACK, ...(d?.links || {}) };
      const lead = document.getElementById('ugs-gw-lead'), how = document.getElementById('ugs-gw-how'), wellsBox = document.getElementById('ugs-gw-wells');
      cite('ugs-gw-src', ...sourceParts(d, L, false));
      if (!d || d.error || !d.available) {
        lead.textContent = d?.error ? `Couldn't load the groundwater levels: ${d.error}.` : 'No well measurements from the year before these dates are loaded.';
        lead.classList.toggle('err', !!d?.error);
        how.textContent = ''; wellsBox.replaceChildren();
        G.emptyChart('chart-ugs-gw', 'No groundwater measurements.');
        return;
      }
      lead.classList.remove('err');
      const steady = d.steady_ft;
      const mid = d.median_change_ft;
      const inWin = d.measured_in_window
        ? ` ${plural(d.measured_in_window, 'well')} ${d.measured_in_window === 1 ? 'was' : 'were'} measured during the dates you picked.`
        : ' None were measured during the dates you picked; most of these wells are measured once a year, in late winter.';
      lead.replaceChildren(`Of ${plural(d.wells, 'well')} near the lake measured in the year up to ${day(d.as_of)}, `,
        b(fmtInt(d.falling)), ` had lower water than a year earlier, `, b(fmtInt(d.rising)), ' had higher water, and ', b(fmtInt(d.steady)),
        ` were about the same (within ${fmt1(steady)} ft). For the typical (median) well, water ${mid < 0 ? 'dropped' : mid > 0 ? 'rose' : 'held'} `,
        b(ft(mid)), '.', inWin);

      // every well's change, sorted, as bars: color + pattern + legend name say which way it moved
      const rows = d.changes.slice().sort((a, c) => a[3] - c[3]);
      const groups = [
        { name: 'Lower than a year ago', test: (c) => c < -steady, color: css('--pen'), decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 3], rotation: Math.PI / 4, color: css('--paper') } },
        { name: `About the same (±${fmt1(steady)} ft)`, test: (c) => Math.abs(c) <= steady, color: css('--off'), decal: { symbol: 'circle', symbolSize: 0.6, dashArrayX: [[4, 4]], dashArrayY: [4, 0], color: css('--paper') } },
        { name: 'Higher', test: (c) => c > steady, color: css('--hydro'), decal: null },
      ];
      const o = G.base();
      const lo = rows[0], hi = rows[rows.length - 1];
      o.aria.label = { enabled: true, description: `Bar chart of the change in water level over about a year at each of ${d.wells} wells near the Great Salt Lake, sorted from the biggest drop to the biggest rise. `
        + `${d.falling} wells were lower, ${d.steady} about the same and ${d.rising} higher. The median change was ${signed(mid)}. `
        + `The biggest drop was ${ft(lo[3])} at ${lo[1]} (${lo[2] || ''} County); the biggest rise was ${signed(hi[3])} at ${hi[1]}. The wells with the biggest changes are listed in a table below the chart.` };
      o.grid.top = 40; o.grid.bottom = 24;
      o.legend = { top: 0, left: 0, itemGap: 20, textStyle: { color: css('--ink'), fontSize: 12 }, itemWidth: 18, itemHeight: 12 };
      o.xAxis = { type: 'category', data: rows.map(r => r[0]), axisLabel: { show: false }, axisTick: { show: false },
        axisLine: { lineStyle: { color: css('--rule') } }, name: 'Wells, sorted by change', nameLocation: 'middle', nameGap: 8,
        nameTextStyle: { color: css('--ink-2'), fontSize: 12 } };
      o.yAxis = { ...o.yAxis, axisLabel: { color: css('--ink-2'), fontSize: 12, formatter: (v) => `${v > 0 ? '+' : ''}${v} ft` } };
      o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => {
        const r = rows[p.dataIndex];
        return `<b>${r[1]}</b>${r[2] ? `, ${r[2]} County` : ''}<br>${r[0]}<br>Change in a year: ${signed(r[3])}<br>Water now ${depth(r[4])} (${day(r[5])})`;
      } };
      o.series = groups.map(g => ({
        name: g.name, type: 'bar', stack: 'w', barCategoryGap: '15%', large: false,
        itemStyle: { color: g.color, ...(g.decal ? { decal: g.decal } : {}) },
        data: rows.map(r => g.test(r[3]) ? r[3] : null),
      }));
      G.chart('chart-ugs-gw').setOption(o, true);

      how.textContent = `Each bar is one well: its latest depth-to-water measurement (${day(d.measured_from)} to ${day(d.measured_to)}) compared with the measurement closest to a year before it. `
        + 'Water that is closer to the ground surface counts as higher. USGS measures most of these wells by hand once a year, in February or March, before irrigation pumping starts. '
        + 'A few wells next to the lake are artesian: their water rises above the ground.';

      const N = d.notable;
      const th = (t, n) => el('th', { scope: 'col', className: n ? 'n' : '', textContent: t });
      const tr = (w) => el('tr', {}, el('th', { scope: 'row' }, link(w.name, w.link), el('br'), el('small', { textContent: `${w.id}${w.county ? ' · ' + w.county + ' County' : ''}` })),
        el('td', { className: 'n', textContent: depth(w.dtw_ft) }), el('td', { className: 'n', textContent: day(w.day) }),
        el('td', { className: 'n', textContent: signed(w.change_ft) }));
      const table = (cap, list) => list.length ? el('div', { className: 'tablewrap' }, el('table', {}, el('caption', { textContent: cap }),
        el('thead', {}, el('tr', {}, th('Well'), th('Water level now', true), th('Measured', true), th('Change in a year', true))),
        el('tbody', {}, ...list.map(tr)))) : '';
      wellsBox.replaceChildren(
        el('h3', { textContent: 'Wells that changed the most' }),
        table('Biggest drops (water farther below the ground than a year earlier)', N.fell),
        table('Biggest rises', N.rose),
        el('p', { className: 'src', textContent: 'Wells are named by their location in the Utah land survey grid (township, range, section), as USGS lists them. A single big change can come from pumping nearby.' }));
    },
  });

  // ------------------------------------------------------------ History: yearly change since 1996, and chemistry
  G.register({
    id: 'ugs_groundwater_hist', tab: 'history', order: 75,
    mount(slot) {
      const root = el('section', { className: 'section ugs-gw' },
        el('h2', { id: 'ugs-gw-hist-h', textContent: 'Groundwater levels near the lake since 1996' }),
        el('p', { className: 'note', textContent: 'Groundwater responds to wet and dry years more slowly than the rivers, and to pumping from wells. '
          + 'This follows the same wells, measured each late winter, year after year.' }),
        el('p', { className: 'lead', id: 'ugs-gw-hist-lead', textContent: 'Loading…' }),
        el('div', { className: 'chart tall', id: 'chart-ugs-gw-hist', role: 'img' }),
        el('p', { className: 'src', id: 'ugs-gw-hist-how' }),
        el('details', {}, el('summary', { textContent: 'Show the yearly numbers' }), el('div', { id: 'ugs-gw-hist-table' })),
        el('div', { id: 'ugs-gw-chem' }),
        el('p', { className: 'src', id: 'ugs-gw-hist-src' }));
      root.setAttribute('aria-labelledby', 'ugs-gw-hist-h');
      slot.append(root);
      return root;
    },
    renderHistory(_, HIST) {
      const d = HIST?.sources?.ugs_groundwater;  // the history data is sent under the source name
      const L = { ...FALLBACK, ...(d?.links || {}) };
      const lead = document.getElementById('ugs-gw-hist-lead');
      cite('ugs-gw-hist-src', ...sourceParts(d, L, true));
      if (!d || d.error || !d.available || !d.years?.length) {
        lead.textContent = d?.error ? `Couldn't load the groundwater record: ${d.error}.` : 'The long groundwater record is not loaded yet.';
        lead.classList.toggle('err', !!d?.error);
        G.emptyChart('chart-ugs-gw-hist', 'No groundwater record loaded.');
        return;
      }
      lead.classList.remove('err');
      const Y = d.years, last = Y[Y.length - 1], [b0, b1] = d.base_years;
      const worst = Y.reduce((a, c) => c.change_ft < a.change_ft ? c : a), best = Y.reduce((a, c) => c.change_ft > a.change_ft ? c : a);
      const low = Y.filter(r => r.vs_base_ft != null).reduce((a, c) => c.vs_base_ft < a.vs_base_ft ? c : a);
      lead.replaceChildren(`In ${last.y}, water in the typical long-record well was `, b(ft(last.vs_base_ft)),
        ` ${last.vs_base_ft < 0 ? 'lower' : 'higher'} than in ${b0}–${b1}. It was lowest in ${low.y} (`, b(signed(low.vs_base_ft)), '). ',
        `The biggest one-year drop was in ${worst.y} (`, b(signed(worst.change_ft)), `); the biggest rise in ${best.y} (`, b(signed(best.change_ft)), '). Each late-winter measurement mostly reflects the year before it.');

      const o = G.base();
      o.aria.label = { enabled: true, description: `Chart of groundwater levels in ${d.long_wells} long-record wells near the Great Salt Lake, ${Y[0].y} to ${last.y}. `
        + `Bars show the median change from the year before; a dashed line shows the median level compared with ${b0}–${b1}, which ended at ${signed(last.vs_base_ft)} in ${last.y} and was lowest in ${low.y} at ${signed(low.vs_base_ft)}. `
        + 'The yearly numbers are in a table below the chart.' };
      o.grid.top = 40;
      o.legend = { top: 0, left: 0, itemGap: 20, textStyle: { color: css('--ink'), fontSize: 12 }, itemWidth: 28 };
      o.xAxis = { type: 'category', data: Y.map(r => String(r.y)), axisLabel: { color: css('--ink-2'), fontSize: 12, hideOverlap: true },
        axisLine: { lineStyle: { color: css('--rule') } }, axisTick: { alignWithLabel: true } };
      o.yAxis = { ...o.yAxis, axisLabel: { color: css('--ink-2'), fontSize: 12, formatter: (v) => `${v > 0 ? '+' : ''}${v} ft` } };
      o.tooltip.formatter = (ps) => {
        const r = Y[ps[0].dataIndex];
        return [`<b>${r.y}</b>`, `Change from ${r.y - 1}: ${signed(r.change_ft)} (middle half ${signed(r.q1)} to ${signed(r.q3)}; ${r.n} wells)`,
          `Compared with ${b0}–${b1}: ${signed(r.vs_base_ft)} (${r.n_base} wells)`].join('<br>');
      };
      o.series = [
        { name: 'Change from the year before', type: 'bar', barMaxWidth: 14,
          itemStyle: { color: css('--hydro') }, data: Y.map(r => r.change_ft) },
        { name: `Compared with ${b0}–${b1}`, type: 'line', symbol: 'triangle', symbolSize: 7,
          lineStyle: { type: 'dashed', width: 2, color: css('--pen') }, itemStyle: { color: css('--pen') }, data: Y.map(r => r.vs_base_ft) },
      ];
      G.chart('chart-ugs-gw-hist').setOption(o, true);
      document.getElementById('ugs-gw-hist-how').textContent = `${d.long_wells} USGS wells in the lake's valleys have a late-winter (January–May) depth-to-water measurement in at least ${d.long_years} years since ${b0} and are still measured. `
        + `Each bar is the middle (median) of those wells' change from the year before; the line is the median of each well's level compared with its own ${b0}–${b1} average. Below zero means the water is deeper than it was.`;

      const th = (t, n) => el('th', { scope: 'col', className: n ? 'n' : '', textContent: t });
      document.getElementById('ugs-gw-hist-table').replaceChildren(el('div', { className: 'tablewrap' }, el('table', {},
        el('caption', { textContent: 'Median change in late-winter water level in long-record wells, by year' }),
        el('thead', {}, el('tr', {}, th('Year'), th('Change from year before', true), th('Wells', true), th(`vs ${b0}–${b1}`, true))),
        el('tbody', {}, ...Y.map(r => el('tr', {}, el('th', { scope: 'row', textContent: String(r.y) }),
          ...[signed(r.change_ft), String(r.n), signed(r.vs_base_ft)].map(t => el('td', { className: 'n', textContent: t }))))))));

      const C = d.chem, box = document.getElementById('ugs-gw-chem');
      if (!C) { box.replaceChildren(); return; }
      const yrs = C.areas.flatMap(a => [a.from, a.to]).filter(Boolean).sort();
      const span = yrs.length ? `${yrs[0].slice(0, 4)}–${yrs[yrs.length - 1].slice(0, 4)}` : 'various years';
      const mgl = (v) => v == null ? '—' : `${fmtInt(v)} mg/L`;
      box.replaceChildren(
        el('h3', { textContent: 'How salty the groundwater is around the shore' }),
        el('p', { className: 'src', textContent: 'Total dissolved solids (TDS) is how much salt and other minerals are in the water. Drinking water should have under about 500 mg/L; '
          + 'over 1,000 mg/L tastes salty. The lake itself is over 100,000 mg/L. Fresh groundwater from the mountains comes in on the east shore; the west side is saltier.'
          + (C.within_1km ? ` Wells and springs within 1 km of the shore: median ${mgl(C.within_1km.tds_mgl)} (${C.within_1km.n} sites); farther away: ${mgl(C.farther?.tds_mgl)} (${C.farther?.n} sites).` : '') }),
        el('div', { className: 'tablewrap' }, el('table', {},
          el('caption', { textContent: `Newest sample at each well and spring, by area (UGS Open-File Report 699; samples ${span})` }),
          el('thead', {}, el('tr', {}, th('Area'), th('Sites', true), th('Median TDS', true), th('Share over 1,000 mg/L', true))),
          el('tbody', {}, ...C.areas.map(a => el('tr', {}, el('th', { scope: 'row', textContent: a.area }),
            ...[String(a.n), mgl(a.tds_mgl), `${Math.round(a.share_salty * 100)}%`].map(t => el('td', { className: 'n', textContent: t }))))))));
    },
  });
})();
