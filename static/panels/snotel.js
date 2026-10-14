// NRCS SNOTEL snowpack (snow water equivalent) in the Bear, Weber and Jordan/Provo mountains.
// Data from sources/snotel.py (DATA.sources.snotel, HIST.sources.snotel).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmt1, parseDay } = G;
  const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html';
  const SNOTEL = 'https://www.nrcs.usda.gov/wps/portal/wcc/home/aboutUs/monitoringPrograms/automatedSnowMonitoring/';
  const SITE = (trip) => `https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=${trip.split(':')[0]}`;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const BASIN_COLOR = { bear: '--bear', weber: '--weber', jordan: '--jordan' };
  const inch = (v) => v == null ? '—' : `${fmt1(v)} in`;
  const pct = (v) => v == null ? '—' : `${Math.round(v)}%`;
  const when = (iso) => { const d = parseDay(iso), n = d.getDate(); return `${n <= 10 ? 'early ' : n <= 20 ? 'mid-' : 'late '}${MONTHS[d.getMonth()]}`; };
  const short = (iso) => G.fmtDay(parseDay(iso));
  const outlook = (p) => p < 70 ? 'well below normal' : p < 90 ? 'below normal' : p <= 110 ? 'near normal' : p <= 130 ? 'above normal' : 'well above normal';
  const srcParts = (stations) => [
    'USDA NRCS ', link('SNOTEL', SNOTEL), ' snow water equivalent, daily values and daily medians from the ',
    link('Air and Water Database (AWDB) REST API', AWDB),
    ...(stations ? [`; ${stations} active stations in Utah and Idaho whose watershed code (HUC) is in the Bear, Weber or Jordan/Provo basins.`] : ['.']),
  ];

  document.head.append(el('style', { textContent: `
    .snotel-tbl th, .snotel-tbl td { font-size: 13px; padding: 4px 8px; }
    .snotel-tbl td, .snotel-tbl thead th:not(:first-child) { text-align: right; }
    .snotel-tbl tbody th { text-align: left; font: 500 13px var(--sans); color: var(--ink); white-space: nowrap; }
    .snotel-tbl td { font-family: var(--mono); white-space: nowrap; }
    .snotel-tbl thead th { font-size: 12px; font-weight: 500; vertical-align: bottom; }
    .snotel-key { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: baseline; }
    .snotel-fact details, .snotel-hist details { margin-top: 8px; font-size: .8125rem; color: var(--ink-2); }
    .snotel-fact summary, .snotel-hist summary { cursor: pointer; color: var(--ink); min-height: 24px; }
    .snotel-fact details ul { columns: 2 12rem; margin: 6px 0 0; padding-left: 1.1rem; }
    .snotel-chart { width: 100%; height: 400px; }
    .snotel-toggle { display: flex; gap: 16px; flex-wrap: wrap; margin: 8px 0; font-size: .875rem; border: 0; padding: 0; }
    .snotel-toggle label { display: inline-flex; gap: 6px; align-items: center; min-height: 24px; cursor: pointer; }
    .snotel-hist td, .snotel-hist thead th:not(:first-child) { text-align: right; }
  ` }));

  const keySwatch = (k) => { const s = el('span', { className: 'snotel-key', style: `background:var(${BASIN_COLOR[k]})` }); s.setAttribute('aria-hidden', 'true'); return s; };

  // ------------------------------------------------------------ At a glance
  G.register({
    id: 'snotel', tab: 'glance', order: 50,
    mount(slot) {
      const root = el('div', { className: 'fact snotel-fact', id: 'snotel-fact' },
        el('h2', { id: 'snotel-h', textContent: 'Snow in the mountains' }),
        el('p', { className: 'lead', id: 'snotel-lead', textContent: '—' }),
        el('div', { id: 'snotel-vis' }),
        el('p', { className: 'src', id: 'snotel-note' }),
        el('p', { className: 'src', id: 'snotel-src' }));
      root.setAttribute('aria-labelledby', 'snotel-h');
      slot.append(root);
      return root;
    },
    render(d, D) {
      const lead = document.getElementById('snotel-lead'), vis = document.getElementById('snotel-vis'), note = document.getElementById('snotel-note');
      const live = (d?.basins || []).filter(x => x.reporting);
      if (!d || d.error || !live.length) {
        lead.textContent = d?.error || 'Snowpack readings are not available for the dates you picked.';
        lead.classList.toggle('err', !!d?.error);
        vis.replaceChildren(); note.textContent = '';
        cite('snotel-src', ...srcParts());
        return;
      }
      lead.classList.remove('err');
      const asOf = live.map(x => x.as_of).sort().pop();
      const off = live.every(x => x.off_season);
      const withPct = live.filter(x => x.pct_median != null);
      const L = live[0].last_wy;

      if (off) {
        const lastPcts = live.map(x => x.last_wy.apr1_pct).filter(v => v != null);
        const lastAvg = lastPcts.length ? lastPcts.reduce((s, v) => s + v, 0) / lastPcts.length : null;
        const snowNow = Math.max(...live.map(x => x.swe_in ?? 0));
        const m = parseDay(asOf).getMonth() + 1;
        const next = m >= 10 || m <= 2 ? 'Snow usually starts building in November.' : 'Snow usually starts building again in November.';
        lead.replaceChildren(`It's ${when(asOf)}, between snow seasons: the snow sensors show ${snowNow < 0.5 ? 'essentially no snow' : `only ${inch(snowNow)} of water in the snow`}, which is normal for this time of year, so a "percent of normal" would mean little. ${next}`,
          ...(lastAvg != null ? [` Last winter (water year ${L.water_year}), snowpack on April 1 was `, b(pct(lastAvg)), ` of normal.`] : []));
      } else if (withPct.length) {
        const avg = withPct.reduce((s, x) => s + x.pct_median, 0) / withPct.length;
        const flow = avg < 90 ? 'spring river flow into the lake will likely be below normal' : avg > 110 ? 'spring river flow into the lake will likely be above normal' : 'spring river flow into the lake should be near normal';
        lead.replaceChildren('Mountain snowpack is ', b(pct(avg)), ` of normal for ${when(asOf)}, so ${flow}.`
          + (withPct.length < live.length ? ' (Some basins have too little snow on average for this date to compare.)' : ''));
      } else {
        lead.textContent = `It's ${when(asOf)} and the normal snowpack for this date is still small, so a percent of normal would be misleading.`;
      }

      // per-basin readout
      const row = (x) => off
        ? [inch(x.swe_in), x.last_wy.peak_in == null ? '—' : `${inch(x.last_wy.peak_in)}, ${short(x.last_wy.peak_day)}`, pct(x.last_wy.apr1_pct)]
        : [inch(x.swe_in), x.pct_median == null ? 'too early' : pct(x.pct_median), x.peak_in == null ? '—' : `${inch(x.peak_in)}, ${short(x.peak_day)}`];
      const head = off ? ['Basin', 'Now', `${L.water_year} peak`, `Apr 1 ${L.water_year}`]
        : ['Basin', 'Now', 'Of normal', 'Peak so far'];
      const SHORT = { bear: 'Bear', weber: 'Weber', jordan: 'Jordan/Provo' };
      vis.replaceChildren(el('div', { className: 'tablewrap' }, el('table', { className: 'snotel-tbl' },
        el('caption', { textContent: `Each river basin, ${G.fmtDay(parseDay(asOf), true)}: inches of water in the snow`
          + (off ? `; last winter's peak and its April 1 percent of normal` : '; percent of normal for the date; highest so far this water year') }),
        el('thead', {}, el('tr', {}, ...head.map(t => el('th', { scope: 'col', textContent: t })))),
        el('tbody', {}, ...live.map(x => el('tr', {}, el('th', { scope: 'row' }, keySwatch(x.basin), SHORT[x.basin]), ...row(x).map(t => el('td', { textContent: t })))))),
      ), el('p', { className: 'src', textContent: `Stations reporting: ${live.map(x => `${SHORT[x.basin]} ${x.reporting} of ${x.stations}`).join(', ')}.` }),
      el('details', {}, el('summary', { textContent: `Stations used (${d.stations.length})` }),
        el('ul', {}, ...d.stations.map(([trip, name, basin, elev]) => el('li', {}, link(name, SITE(trip)), ` · ${basin === 'jordan' ? 'Jordan/Provo' : basin[0].toUpperCase() + basin.slice(1)} · ${G.fmtInt(elev)} ft`)))));

      const lag = D?.window?.to && asOf < D.window.to ? ` The latest complete reading is from ${G.fmtDay(parseDay(asOf), true)}.` : '';
      note.textContent = `"Snow water" (snow water equivalent) is the depth of water, in inches, you would get by melting the snow at a station; the basin figure is the average over its stations. `
        + `"% of normal" compares the basin's stations with their NRCS median for the same calendar day (the middle value of past years), and is left out when the median is under ${d.min_median_in} inch. `
        + `Water year ${d.water_year} runs October ${d.water_year - 1} to September ${d.water_year}. Most of the water reaching the lake each year starts as this snow.${lag}`;
      cite('snotel-src', ...srcParts(d.stations.length));
    },
  });

  // ------------------------------------------------------------ History: April 1 snowpack each year
  let metric = 'pct';
  G.register({
    id: 'snotel_hist', tab: 'history', order: 55,
    mount(slot) {
      const tog = el('fieldset', { className: 'snotel-toggle' }, el('legend', { className: 'sr-only', textContent: 'Show snowpack as' }),
        ...[['pct', 'Percent of normal'], ['in', 'Inches of water']].map(([v, t]) => el('label', {},
          el('input', { type: 'radio', name: 'snotel-metric', value: v, checked: v === metric, onchange: () => { metric = v; draw(); } }), t)));
      const root = el('section', { className: 'section snotel-hist', id: 'snotel-hist' },
        el('h2', { id: 'snotel-hist-h', textContent: 'Mountain snowpack each spring' }),
        el('p', { className: 'note', id: 'snotel-hist-note' }),
        tog,
        el('div', { className: 'snotel-chart', id: 'snotel-hist-chart' }),
        el('div', { id: 'snotel-hist-table' }),
        el('p', { className: 'src', id: 'snotel-hist-src' }));
      root.setAttribute('aria-labelledby', 'snotel-hist-h');
      slot.append(root);
      return root;
    },
    renderHistory(_, HIST) { last = HIST?.sources?.snotel; draw(); },
  });
  let last = null;

  const DECALS = {
    bear: null,
    weber: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 3], rotation: Math.PI / 4 },
    jordan: { symbol: 'circle', symbolSize: 0.7, dashArrayX: [[3, 3], [0, 3, 3, 0]], dashArrayY: [3, 0] },
  };
  const PATTERN_WORD = { bear: 'solid', weber: 'striped', jordan: 'dotted' };

  function draw() {
    const h = last, note = document.getElementById('snotel-hist-note');
    if (!note) return;
    if (!h || h.error || !h.water_years?.length) {
      note.textContent = h?.error || 'Snowpack history is not available right now.';
      G.emptyChart('snotel-hist-chart', 'No snowpack history.');
      document.getElementById('snotel-hist-table').replaceChildren();
      cite('snotel-hist-src', ...srcParts());
      return;
    }
    const Y = h.water_years, keys = Object.keys(h.basins), field = metric === 'pct' ? 'apr1_pct' : 'apr1_in';
    const fmt = metric === 'pct' ? pct : inch;
    note.textContent = `Snow piled up in the Bear, Weber and Jordan/Provo mountains on April 1, about when the snowpack usually peaks, for each water year (October to September, named for the year it ends). `
      + `When it melts in spring this snow feeds the rivers that supply most of the Great Salt Lake's new water, so a small snowpack usually means the lake drops more that year. `
      + `"Percent of normal" compares each basin's stations with their NRCS median for April 1 (100% = a typical year); "inches of water" is the depth of water from melting the snow, averaged over the stations. `
      + `Fewer stations reported in the early years. Bars: Bear solid, Weber striped, Jordan/Provo dotted. Drag the slider to zoom.`;

    const ink = css('--ink'), ink2 = css('--ink-2');
    const o = G.base();
    const latest = Y.length - 1;
    const lowest = (k) => { let i = -1; h.basins[k][field].forEach((v, j) => { if (v != null && (i < 0 || v < h.basins[k][field][i])) i = j; }); return i; };
    o.aria.label = { enabled: true, description: `Bar chart of April 1 mountain snowpack, ${metric === 'pct' ? 'as percent of normal' : 'in inches of water'}, for water years ${Y[0]} to ${Y[latest]}, three bars per year (Bear, Weber, Jordan/Provo basins). `
      + keys.map(k => { const B = h.basins[k], i = lowest(k); const w = (v) => metric === 'pct' ? `${pct(v)} of normal` : v == null ? 'no reading' : `${fmt1(v)} inches`;
        return `${B.label}: ${w(B[field][latest])} in ${Y[latest]}` + (i === latest ? `, the lowest since ${Y[0]}.` : `; lowest was ${w(B[field][i])} in ${Y[i]}.`); }).join(' ')
      + ' A table of every year follows the chart.' };
    o.legend = { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, itemWidth: 22, itemHeight: 12 };
    o.grid = { left: 12, right: metric === 'pct' ? 64 : 16, top: 60, bottom: 64, containLabel: true };
    o.xAxis = { type: 'category', data: Y.map(String), axisLine: { lineStyle: { color: css('--rule') } }, axisLabel: { color: ink2, fontSize: 12, hideOverlap: true }, axisTick: { alignWithLabel: true } };
    o.yAxis = { type: 'value', name: metric === 'pct' ? '% of normal, April 1' : 'inches of water, April 1', nameTextStyle: { color: ink2, align: 'left', fontSize: 12 },
      axisLabel: { color: ink2, fontSize: 12, formatter: (v) => metric === 'pct' ? `${v}%` : `${v}` }, splitLine: { lineStyle: { color: css('--grid-major') } } };
    o.tooltip = { ...o.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: (ps) => {
      const i = ps[0]?.dataIndex; if (i == null) return '';
      return [`Water year ${Y[i]} · April 1`, ...keys.map(k => { const B = h.basins[k];
        return `${B.label} (${PATTERN_WORD[k]}): <b>${pct(B.apr1_pct[i])}</b> of normal, ${inch(B.apr1_in[i])} · peak ${inch(B.peak_in[i])}${B.peak_day[i] ? ` on ${MONTHS[+B.peak_day[i].slice(0, 2) - 1].slice(0, 3)} ${+B.peak_day[i].slice(3)}` : ''} · ${B.stations[i]} stations`; })].join('<br>');
    } };
    o.series = keys.map((k, n) => {
      const color = css(BASIN_COLOR[k]);
      return { name: h.basins[k].label, type: 'bar', barGap: '10%', barCategoryGap: '25%', data: h.basins[k][field],
        itemStyle: { color, borderColor: color, decal: DECALS[k] ? { ...DECALS[k], color: css('--paper') } : undefined },
        markLine: n === 0 && metric === 'pct' ? { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: ink, width: 1.5 },
          label: { color: ink, fontSize: 12, position: 'end', formatter: 'normal\n(100%)' }, data: [{ yAxis: 100 }] } : undefined };
    });
    const start = Math.max(0, Y.length - 20);
    o.dataZoom = [{ type: 'inside', startValue: start }, { type: 'slider', height: 28, bottom: 8, startValue: start, borderColor: css('--rule'),
      textStyle: { color: ink2, fontSize: 12 }, fillerColor: 'rgba(127,127,127,.18)', dataBackground: { lineStyle: { color: ink2 }, areaStyle: { color: css('--grid') } } }];
    G.chart('snotel-hist-chart').setOption(o, true);

    document.getElementById('snotel-hist-table').replaceChildren(el('details', {},
      el('summary', { textContent: `April 1 snowpack by water year, ${Y[0]}–${Y[latest]}` }),
      el('div', { className: 'tablewrap' }, el('table', {},
        el('caption', { textContent: 'Percent of normal, then inches of water, on April 1; number of stations reporting in brackets.' }),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'Water year' }), ...keys.map(k => el('th', { scope: 'col', textContent: h.basins[k].label })))),
        el('tbody', {}, ...Y.map((y, i) => i).reverse().map(i => el('tr', {}, el('td', { textContent: String(Y[i]) }),
          ...keys.map(k => { const B = h.basins[k]; return el('td', { textContent: `${pct(B.apr1_pct[i])} · ${inch(B.apr1_in[i])} (${B.stations[i]})` }); }))))))));
    const n = Object.values(h.stations_now || {}).reduce((s, v) => s + v, 0);
    cite('snotel-hist-src', ...srcParts(n || null));
  }
})();
