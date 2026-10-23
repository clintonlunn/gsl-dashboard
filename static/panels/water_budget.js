// Utah Division of Water Resources' Utah Water Budget model: where the water of the lake's river basins is used up
// (History tab), and which inflows to the lake our gauges miss (Details tab).
// Data from sources/water_budget.py (HIST.sources.water_budget, DATA.sources.water_budget).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, link, cite, css, fmtInt } = G;
  const HUB = 'https://dwre-utahdnr.opendata.arcgis.com/pages/water-budget';
  const SECTOR_TEXT = {
    Agriculture: 'Agriculture (crops)', 'M&I': 'Cities and industry', Mineral: 'Mineral extraction',
    'Sub-irrigated': 'Sub-irrigated fields', Incidental: 'Canal-side plants',
  };
  const BASIN_TEXT = { 'Bear River': 'Bear', 'Weber River': 'Weber', 'Jordan River': 'Jordan', 'Utah Lake': 'Utah Lake' };
  const maf = (v) => `${(v / 1e6).toFixed(2)} million`;
  const srcParts = (d, extra, flows) => [
    'Utah Division of Water Resources, ', link('Utah Water Budget', d?.hub_url || HUB),
    d?.service_url ? [' (', link(`${d.service}`, d.service_url), flows && d.flows_url ? [', ', link('QXFlowLines', d.flows_url)] : '', ')'] : '',
    extra || '', '. Shared under CC BY-SA by the Utah Department of Natural Resources.',
  ].flat(2);


  // fill color and pattern per sector, so the bars don't rely on color alone
  const look = () => {
    const p = css('--paper');
    return {
      Agriculture: { color: css('--healthy'), decal: { symbol: 'none' } },
      'M&I': { color: css('--pen'), decal: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: Math.PI / 4, color: p } },
      Mineral: { color: css('--weber'), decal: { symbol: 'circle', symbolSize: 0.6, dashArrayX: [[6, 6]], dashArrayY: [6, 0], color: p } },
      'Sub-irrigated': { color: css('--hydro'), decal: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 5], rotation: 0, color: p } },
      Incidental: { color: css('--off'), decal: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4, color: p } },
    };
  };

  // ------------------------------------------------------------ History: where the basin's water goes
  let H = null;
  G.register({
    id: 'water_budget', tab: 'history', order: 50,
    mount(slot) {
      const sel = el('select', { id: 'wb-basin' },
        el('option', { value: '', textContent: 'All four basins' }),
        ...Object.entries(BASIN_TEXT).map(([v, t]) => el('option', { value: v, textContent: `${t}${t === 'Utah Lake' ? '' : ' River'} basin` })));
      sel.addEventListener('change', () => H && draw(H));
      const root = el('section', { className: 'section wb-hist', id: 'wb-hist' },
        el('h2', { id: 'wb-hist-h', textContent: "Where the basin's water goes" }),
        el('p', { className: 'note', id: 'wb-hist-note' }),
        el('div', { className: 'wb-controls' }, el('label', { htmlFor: 'wb-basin', textContent: 'Show' }), sel),
        el('div', { className: 'wb-chart', id: 'wb-hist-chart' }),
        el('h3', { className: 'wb-sub', id: 'wb-precip-h', textContent: 'Precipitation falling on the lake' }),
        el('p', { className: 'note', id: 'wb-precip-note' }),
        el('div', { className: 'wb-chart small', id: 'wb-precip-chart' }),
        el('div', { id: 'wb-hist-table' }),
        el('p', { className: 'src', id: 'wb-hist-src' }));
      root.setAttribute('aria-labelledby', 'wb-hist-h');
      slot.append(root);
      return root;
    },
    renderHistory(h) {
      const note = document.getElementById('wb-hist-note');
      if (!h || h.error || !h.water_years?.length) {
        H = null;
        note.textContent = h?.error || 'Water budget model results are not available right now.';
        note.classList.toggle('err', !!h?.error);
        G.emptyChart('wb-hist-chart', 'No model results.');
        G.emptyChart('wb-precip-chart', 'No model results.');
        document.getElementById('wb-precip-note').textContent = '';
        document.getElementById('wb-hist-table').replaceChildren();
        cite('wb-hist-src', ...srcParts(h));
        return;
      }
      note.classList.remove('err');
      H = h; draw(h);
    },
  });

  function draw(h) {
    const basin = document.getElementById('wb-basin').value;
    const S = basin ? h.by_basin_af[basin] : h.combined_af;
    const Y = h.water_years, first = Y[0], last = Y[Y.length - 1], n = Y.length;
    const where = basin ? `the ${basin} basin` : 'the Bear, Weber, Jordan and Utah Lake basins';
    const total = Y.map((_, i) => h.sectors.reduce((s, k) => s + (S[k][i] || 0), 0));
    const avg = (a) => a.reduce((s, v) => s + (v || 0), 0) / a.length;
    const share = (k) => Math.round(100 * S[k].reduce((s, v) => s + (v || 0), 0) / total.reduce((s, v) => s + v, 0));
    const other = basin ? h.other_states_af?.[basin] : null;
    const otherText = !basin && h.other_states_af?.['Bear River']
      ? ` Idaho and Wyoming use about ${maf(avg(h.other_states_af['Bear River']))} acre-feet more a year upstream in the Bear basin; those are left out because the state says they are less certain.`
      : other ? ` Idaho and Wyoming use about ${maf(avg(other))} acre-feet more a year upstream; left out because the state says those numbers are less certain.` : '';
    document.getElementById('wb-hist-note').textContent =
      `Depletions are water used up, mostly by crops, that doesn't flow back to rivers or the lake. `
      + `Each bar is one water year (October to September, named for the year it ends) in ${where}, Utah side only, from the state's water budget model. `
      + `Agriculture is ${share('Agriculture')}% of it over ${first}–${last}, cities and industry ${share('M&I')}%.${otherText} `
      + `The model has no figure for evaporation from the lake itself, the lake's biggest loss.`;

    const ink = css('--ink'), ink2 = css('--ink-2'), L = look();
    const o = G.base();
    const maxI = total.indexOf(Math.max(...total)), minI = total.indexOf(Math.min(...total));
    o.aria.label = { enabled: true, description: `Stacked bars of water depletions by use in ${where}, water years ${first} to ${last}, from the Utah Water Budget model. `
      + `Totals average ${maf(avg(total))} acre-feet a year, from ${maf(total[minI])} in ${Y[minI]} to ${maf(total[maxI])} in ${Y[maxI]}; ${last}: ${maf(total[n - 1])}. `
      + `Agriculture is ${share('Agriculture')}% and cities and industry ${share('M&I')}% of the total. A table of the values follows the charts.` };
    o.aria.decal = { show: false };
    o.legend = { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, itemWidth: 22, itemHeight: 12 };
    o.grid = { ...o.grid, top: 56 };
    o.xAxis = { type: 'category', data: Y.map(String), axisLine: { lineStyle: { color: css('--rule') } }, axisLabel: { color: ink2, fontSize: 12, hideOverlap: true }, axisTick: { alignWithLabel: true } };
    o.yAxis = { ...o.yAxis, name: 'million acre-feet', nameTextStyle: { color: ink2, align: 'left', fontSize: 12 },
      axisLabel: { color: ink2, fontSize: 12, formatter: (v) => (v / 1e6).toFixed(1) } };
    o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow' }, formatter: (ps) => {
      const i = ps[0]?.dataIndex; if (i == null) return '';
      return [`Water year ${Y[i]}`, ...ps.slice().reverse().map(p => `${p.marker}${p.seriesName}: <b>${fmtInt(p.value)}</b> ac-ft`), `Total: <b>${fmtInt(total[i])}</b> ac-ft`].join('<br>');
    } };
    o.series = h.sectors.map(k => ({ name: SECTOR_TEXT[k] || k, type: 'bar', stack: 'dep', barMaxWidth: 22, data: S[k],
      itemStyle: { color: L[k].color, decal: L[k].decal, borderColor: css('--paper'), borderWidth: 0.5 }, emphasis: { focus: 'series' } }));
    G.chart('wb-hist-chart').setOption(o, true);

    // precipitation on the lake: one series, own scale
    const P = h.gsl_precip_af, pv = P.filter(v => v != null);
    const pmax = P.indexOf(Math.max(...pv)), pmin = P.indexOf(Math.min(...pv));
    document.getElementById('wb-precip-note').textContent = `Rain and snow the model puts on the Great Salt Lake subarea each water year: about ${maf(avg(pv))} acre-feet on average, `
      + `${maf(P[pmin])} in ${Y[pmin]} to ${maf(P[pmax])} in ${Y[pmax]}. It goes straight into the lake; evaporation takes it and more back out, but the model doesn't estimate that.`;
    const q = G.base();
    q.aria.label = { enabled: true, description: `Precipitation on the Great Salt Lake subarea by water year, ${first} to ${last}, from the Utah Water Budget model: average ${maf(avg(pv))} acre-feet, lowest ${maf(P[pmin])} in ${Y[pmin]}, highest ${maf(P[pmax])} in ${Y[pmax]}, ${last}: ${maf(P[n - 1])}.` };
    q.xAxis = { ...o.xAxis };
    q.yAxis = { ...o.yAxis, min: 0 };
    q.grid = { ...q.grid, top: 28 };
    q.tooltip = { ...q.tooltip, valueFormatter: (v) => v == null ? '—' : `${fmtInt(v)} ac-ft` };
    q.series = [{ name: 'Precipitation on the lake', type: 'line', data: P, symbol: 'circle', symbolSize: 5, lineStyle: { width: 2, color: css('--rain') }, itemStyle: { color: css('--rain') } }];
    G.chart('wb-precip-chart').setOption(q, true);

    // the numbers as a real table
    document.getElementById('wb-hist-table').replaceChildren(el('details', {},
      el('summary', { textContent: `Values by water year, ${first}–${last}, in acre-feet` }),
      el('div', { className: 'tablewrap' }, el('table', {},
        el('caption', { textContent: `Depletions in ${where} (Utah side), and precipitation on the Great Salt Lake subarea.` }),
        el('thead', {}, el('tr', {}, ...['Water year', ...h.sectors.map(k => SECTOR_TEXT[k] || k), 'Total used up', 'Precipitation on lake'].map(s => el('th', { scope: 'col', textContent: s })))),
        el('tbody', {}, ...Y.map((y, i) => i).reverse().map(i => el('tr', {},
          el('td', { textContent: String(Y[i]) }),
          ...[...h.sectors.map(k => S[k][i]), total[i], P[i]].map(v => el('td', { textContent: v == null ? '—' : fmtInt(v) })))))))));
    cite('wb-hist-src', ...srcParts(h, `, water years ${first}–${last}, model run ${h.service.replace('WB_Summary', '')} (yymmdd)`));
  }

  // ------------------------------------------------------------ Details: inflows our gauges don't see
  G.register({
    id: 'water_budget_gaps', tab: 'details', order: 20,
    mount(slot) {
      const root = el('section', { className: 'section wb-gaps', id: 'wb-gaps' },
        el('h2', { id: 'wb-gaps-h', textContent: "Inflows our gauges don't see" }),
        el('p', { className: 'note', id: 'wb-gaps-note' }),
        el('div', { className: 'tablewrap', id: 'wb-gaps-table' }),
        el('p', { className: 'note', id: 'wb-gaps-year' }),
        el('p', { className: 'src', id: 'wb-gaps-src' }));
      root.setAttribute('aria-labelledby', 'wb-gaps-h');
      slot.append(root);
      return root;
    },
    render(_, D) {
      const d = D?.sources?.water_budget;
      const note = document.getElementById('wb-gaps-note'), tbl = document.getElementById('wb-gaps-table'), yr = document.getElementById('wb-gaps-year');
      if (!d || d.error || !d.inflows?.length) {
        note.textContent = d?.error || 'Water budget model results are not available right now.';
        note.classList.toggle('err', !!d?.error);
        tbl.replaceChildren(); yr.textContent = '';
        cite('wb-gaps-src', ...srcParts(d));
        return;
      }
      note.classList.remove('err');
      const I = d.inflow_summary, rows = d.inflows.filter(r => r.role === 'to_lake' && r.por_annual_af > 0)
        .sort((a, c) => c.por_annual_af - a.por_annual_af);
      const zero = d.inflows.filter(r => r.role === 'to_lake' && r.flowtype === 'Groundwater' && !r.por_annual_af);
      const weber = d.inflows.find(r => r.gauges?.includes('10141000') && r.role === 'to_lake');
      const below = weber && I.weber_gauge_por_af ? weber.por_annual_af - I.weber_gauge_por_af : null;
      note.textContent = `The state's water budget model traces every stream, canal and return flow into the Great Salt Lake. `
        + `Our gauges cover the three big rivers; the rest reaches the lake without passing one. `
        + `About ${Math.round(I.missed_share * 100)}% of the lake's long-term modeled surface inflow (${fmtInt(I.missed_por_af)} of ${fmtInt(I.to_lake_por_af)} acre-feet a year) comes in through lines the dashboard doesn't measure`
        + (below > 0 ? `, plus about ${fmtInt(below)} acre-feet a year of Weber return flows that join below the Plain City gauge.` : '.');
      tbl.replaceChildren(el('table', {},
        el('caption', { textContent: 'Flows into the lake in the state model, long-term average (period of record) per water year' }),
        el('thead', {}, el('tr', {}, ...['Inflow', 'Average ac-ft/yr', 'On this dashboard?'].map(s => el('th', { scope: 'col', textContent: s })))),
        el('tbody', {}, ...rows.map(r => el('tr', {},
          el('td', { textContent: r.description }, ...(r.note ? [el('br'), el('span', { className: 'src', textContent: r.note })] : [])),
          el('td', { textContent: fmtInt(r.por_annual_af) }),
          el('td', { className: r.measured ? 'sees' : 'miss' }, r.measured ? `Yes, gauge${r.gauges.length > 1 ? 's' : ''} ` : 'No',
            ...(r.measured ? r.gauges.flatMap((g, i) => [i ? ', ' : '', link(g, `https://waterdata.usgs.gov/monitoring-location/${g}/`)]) : []))))),
        el('tfoot', {}, el('tr', {},
          el('td', { textContent: 'Not measured here' }), el('td', { textContent: fmtInt(I.missed_por_af) }),
          el('td', { textContent: `${Math.round(I.missed_share * 100)}% of ${fmtInt(I.to_lake_por_af)}` })))));
      const y = d.years?.[0];
      yr.textContent = (zero.length ? `Groundwater flowing into the lake is not estimated in the model (its ${zero.length} groundwater lines are 0), and neither is evaporation from the lake. ` : 'Evaporation from the lake is not in the model. ')
        + (y ? `${d.latest_available_used ? `The model's latest year is water year ${y.water_year} (this period isn't covered yet)` : `Water year ${y.water_year}`}: `
          + `${fmtInt(y.gsl_precip_af)} acre-feet of precipitation on the lake, and ${fmtInt(y.depletions_af.total)} acre-feet used up in the Bear, Weber, Jordan and Utah Lake basins on the Utah side.` : '');
      cite('wb-gaps-src', ...srcParts(d, ': flow schematic, long-term averages for the Great Salt Lake subarea', true));
    },
  });
})();
