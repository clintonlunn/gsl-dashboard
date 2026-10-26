// Water leaving the lake by evaporation: an estimate from gridMET reference evapotranspiration, a salinity
// factor and the lake area. Data from sources/evaporation.py (DATA.sources.evaporation).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt, parseDay, fmtDay, addDays } = G;
  const fmt2 = (v) => v == null ? '—' : v.toFixed(Math.abs(v) >= 10 ? 1 : 2);
  const roundAf = (v) => v == null ? '—' : fmtInt(v >= 100000 ? Math.round(v / 10000) * 10000 : v >= 10000 ? Math.round(v / 1000) * 1000 : Math.round(v / 100) * 100);


  const sourceParts = (d) => [
    link('gridMET', d?.links?.gridmet || 'https://www.climatologylab.org/gridmet.html'), ' daily grass reference evapotranspiration (Abatzoglou 2013, CC0',
    d?.gridmet_through ? `; through ${fmtDay(parseDay(d.gridmet_through), true)}, last 60 days provisional` : '', '), times a salt factor of ',
    String(d?.salinity_factor ?? 0.884), ' from ', link('Mohammed & Tarboton (2012)', d?.links?.mohammed_tarboton_2012 || 'https://doi.org/10.1029/2012WR011908'),
    ', times the lake area from the ', link('USGS 2023 elevation-area-volume table', 'https://doi.org/10.5066/P9DGG75W'),
    '. Long-term check: ', link('USGS Open-File Report 78-912', d?.links?.arnow_1978 || 'https://pubs.usgs.gov/publication/ofr78912'),
    ' (Arnow 1978) puts it at about 45 inches a year. Measured over-water data will come from the ',
    link('Utah Flux Network causeway towers', d?.links?.ameriflux_causeway || 'https://ameriflux.lbl.gov/sites/siteinfo/US-UTX'), ' once released.',
  ];

  G.register({
    id: 'evaporation', topic: 'budget', view: 'detail', order: 18,
    mount(slot) {
      const root = el('section', { className: 'section', id: 'evap' },
        el('h2', { id: 'evap-h', textContent: 'Water leaving by evaporation' }),
        el('p', { className: 'note', id: 'evap-lead', textContent: '—' }),
        el('p', { className: 'evap-range', id: 'evap-range' }),
        el('ul', { className: 'evap-balance', id: 'evap-balance' }),
        el('p', { className: 'note', id: 'evap-how', textContent: 'Evaporation is the only way water leaves the Great Salt Lake, and over a year it takes about as much as the rivers and rain bring in. Nobody measures it directly yet, so this is an estimate: how much water the weather could pull from a wet surface each day (sun, heat, wind and dry air), cut by about 12% because salty water evaporates more slowly than fresh water, spread over the lake’s area at that day’s level.' }),
        el('div', { className: 'chart', id: 'evap-chart' }),
        el('h3', { id: 'evap-annual-h', textContent: 'Estimated evaporation each water year' }),
        el('div', { className: 'chart', id: 'evap-annual' }),
        el('div', { id: 'evap-table' }),
        el('p', { className: 'src', id: 'evap-src' }));
      root.setAttribute('aria-labelledby', 'evap-h');
      slot.append(root);
      return root;
    },
    render(d, D) {
      const lead = document.getElementById('evap-lead');
      const range = document.getElementById('evap-range'), bal = document.getElementById('evap-balance');
      if (!d || d.error || !d.available) {
        lead.textContent = d?.error ? `Evaporation estimate unavailable: ${d.error}` : 'The evaporation estimate isn’t ready yet. The server downloads the weather record once, then updates daily.';
        lead.classList.toggle('err', !!d?.error);
        range.replaceChildren(); bal.replaceChildren();
        G.emptyChart('evap-chart', 'No estimate yet.'); G.emptyChart('evap-annual', 'No estimate yet.');
        document.getElementById('evap-table').replaceChildren();
        cite('evap-src', ...sourceParts(d));
        return;
      }
      lead.classList.remove('err');
      const f = parseDay(d.from), t = parseDay(d.to), yrs = f.getFullYear() !== t.getFullYear() || f.getFullYear() !== new Date().getFullYear();
      const when = d.from === d.to ? `on ${fmtDay(f, yrs)}` : `from ${fmtDay(f, yrs)} to ${fmtDay(t, yrs)}`;
      const rel = d.normal_in ? d.evap_in / d.normal_in : null;
      const vsUsual = rel == null ? '' : rel < 0.9 ? `, less than the ${fmt2(d.normal_in)} inches usual for these dates` : rel > 1.1 ? `, more than the ${fmt2(d.normal_in)} inches usual for these dates` : `, about usual for these dates (${fmt2(d.normal_in)} inches)`;
      lead.replaceChildren('An estimated ', b(`${fmt2(d.evap_in)} inches`), ' of water evaporated off the lake ', when,
        ...(d.evap_af != null ? [', about ', b(`${roundAf(d.evap_af)} acre-ft`)] : []), `${vsUsual}.`);
      const filled = d.days_filled ? ` ${d.days_filled} of ${d.days} days have no weather data yet${d.days_filled > 7 ? ' (or are before 1979)' : ''}, so they use the average for that date.` : '';
      range.replaceChildren(`Likely range: `, b(`${fmt2(d.low_in)}–${fmt2(d.high_in)} in`),
        ...(d.low_af != null ? [' (', b(`${roundAf(d.low_af)}–${roundAf(d.high_af)} acre-ft`), ')'] : []),
        `, ±${d.uncertainty_pct}%. That band is a judgment, wider for short periods because a lake stores heat and evaporates on a delay the weather alone doesn’t capture.${filled}`);

      // water in vs. out for the same period, using the page's own river and rain numbers
      const riverAf = Math.max(0, D?.inflow?.[0]?.total_af ?? 0), rainAf = D?.rain_lake?.[0]?.rain_af ?? 0;
      bal.replaceChildren();
      if (d.evap_af != null && D?.inflow?.[0]) {
        const inAf = riverAf + rainAf, net = inAf - d.evap_af;
        bal.append(el('li', {}, 'In (rivers + rain): ', b(`${roundAf(inAf)} acre-ft`)),
          el('li', {}, 'Out (evaporation, est.): ', b(`${roundAf(d.evap_af)} acre-ft`)),
          el('li', {}, 'Difference: ', b(`${net >= 0 ? '+' : '−'}${roundAf(Math.abs(net))} acre-ft`), net >= 0 ? ' (lake should gain)' : ' (lake should lose)'));
        bal.setAttribute('aria-label', 'Rough water balance for this period');
      }

      // per-day (or per-month) chart: bars = estimate, grey bars = filled with the average, dashed line = usual
      const S = d.series, daily = S.step === 'day';
      const pts = S.rows.map(r => ({ t: daily ? parseDay(r.day) : parseDay(`${r.month}-01`), v: r.in, u: r.usual_in, filled: daily ? r.filled : r.filled_days === r.days }));
      const unit = daily ? 'in/day' : 'in/month';
      const o = G.base();
      const total = pts.reduce((s, p) => s + (p.v || 0), 0);
      const peak = pts.reduce((m, p) => (p.v ?? -1) > (m?.v ?? -1) ? p : m, null);
      o.aria.label = { enabled: true, description: `Estimated evaporation ${daily ? 'each day' : 'each month'} ${when}, in inches of lake depth. Total ${fmt2(total)} inches. Highest ${fmt2(peak?.v)} ${unit} ${daily ? 'on' : 'in'} ${peak ? (daily ? fmtDay(peak.t, yrs) : peak.t.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })) : '—'}. The dashed line is the usual amount for each date. ${d.days_filled ? 'Grey bars are days without weather data, filled with the usual amount.' : ''}` };
      o.legend = { top: 0, left: 0, textStyle: { color: css('--ink'), fontSize: 12 }, itemHeight: 8 };
      o.grid.top = 32;
      o.yAxis = { ...o.yAxis, axisLabel: { color: css('--ink-2'), formatter: (v) => `${v.toFixed(daily ? 2 : 1)} in` } };
      o.tooltip.valueFormatter = (v) => v == null ? '—' : `${v.toFixed(daily ? 3 : 2)} in`;
      const barW = Math.max(2, Math.min(14, 600 / pts.length));
      o.series = [
        { name: 'Estimate', type: 'bar', barMaxWidth: barW, itemStyle: { color: css('--hydro'), borderRadius: [4, 4, 0, 0] },
          data: pts.map(p => ({ value: [p.t, p.v], itemStyle: p.filled ? { color: css('--off') } : undefined })) },
        { name: 'Usual for the date', type: 'line', showSymbol: false, lineStyle: { type: 'dashed', width: 2, color: css('--ink-2') }, itemStyle: { color: css('--ink-2') },
          data: pts.map(p => [p.t, p.u]) },
      ];
      if (daily) o.xAxis = { ...o.xAxis, min: f, max: addDays(t, 1) };
      o.dataZoom = pts.length > 60 ? [{ type: 'inside' }] : [];
      G.chart('evap-chart').setOption(o, true);

      // water years
      const A = d.annual || [];
      if (!A.length) { G.emptyChart('evap-annual', 'No complete water years yet.'); document.getElementById('evap-table').replaceChildren(); }
      else {
        const usgs = d.longterm?.published?.[0]?.in_per_yr ?? 45;
        const lo = A.reduce((m, y) => y.in < m.in ? y : m), hi = A.reduce((m, y) => y.in > m.in ? y : m);
        const a = G.base();
        a.aria.label = { enabled: true, description: `Estimated evaporation each water year (October to September) from ${A[0].wy} to ${A[A.length - 1].wy}, in inches. Lowest ${lo.in} inches in ${lo.wy}, highest ${hi.in} inches in ${hi.wy}. The dashed line is the USGS long-term figure of ${usgs} inches a year. A table with acre-feet follows the chart.` };
        a.xAxis = { type: 'category', data: A.map(y => String(y.wy)), axisLine: { lineStyle: { color: css('--rule') } }, axisLabel: { color: css('--ink-2'), hideOverlap: true }, axisTick: { show: false } };
        a.yAxis = { ...a.yAxis, min: 0, axisLabel: { color: css('--ink-2'), formatter: (v) => `${v} in` } };
        a.grid.top = 24;
        a.tooltip.valueFormatter = (v) => `${v} in`;
        a.series = [{ name: 'Estimated evaporation', type: 'bar', barMaxWidth: 14, itemStyle: { color: css('--hydro'), borderRadius: [4, 4, 0, 0] }, data: A.map(y => y.in),
          markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: css('--ink'), width: 1.5 },
            label: { color: css('--ink'), fontSize: 12, formatter: `USGS 1931–76: ${usgs} in`, position: 'insideEndTop' }, data: [{ yAxis: usgs }] } }];
        G.chart('evap-annual').setOption(a, true);
        const tbl = el('details', {}, el('summary', { textContent: 'Water-year table' }),
          el('div', { className: 'tablewrap' }, el('table', {},
            el('caption', { textContent: 'Estimated evaporation by water year (October–September)' }),
            el('thead', {}, el('tr', {}, ...['Water year', 'Inches', 'Acre-ft', 'Average level (ft)'].map(x => el('th', { scope: 'col', textContent: x })))),
            el('tbody', {}, ...A.slice().reverse().map(y => el('tr', {},
              el('th', { scope: 'row', textContent: String(y.wy), style: 'text-align:left;font:inherit;color:var(--ink)' }),
              el('td', { textContent: String(y.in) }), el('td', { textContent: y.af == null ? '—' : fmtInt(y.af) }),
              el('td', { textContent: y.level_ft == null ? '—' : y.level_ft.toFixed(1) })))))));
        document.getElementById('evap-table').replaceChildren(tbl);
      }
      cite('evap-src', ...sourceParts(d));
    },
  });
})();
