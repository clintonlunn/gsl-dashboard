// Rain on the lake from weather grids: PRISM daily precipitation averaged over the Great Salt Lake's water surface,
// next to the page's station estimate (middle value of lowland gauges). Data from sources/lake_precip.py
// (DATA.sources.lake_precip).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt, fmtDay, parseDay } = G;
  const PRISM = 'https://prism.oregonstate.edu/';
  const ACIS_GRID = 'https://www.rcc-acis.org/docs_webservices.html';
  const NE_LAKES = 'https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-lakes/';
  const EAST_LON = -112.3; // east of this, gauges sit on the Wasatch Front side of the lake
  const in2 = (v) => `${v.toFixed(2)} in`;
  const day = (s) => fmtDay(parseDay(s));
  const days = (list) => list.length > 3 ? `${list.length} days` : list.map(day).join(' and ');


  const srcParts = (d) => [
    link('PRISM', PRISM), ' daily precipitation (', d?.dataset?.version || 'AN91d, 4 km', '), Oregon State University, via ',
    link('NOAA ACIS GridData', ACIS_GRID), ' (grid 21)',
    ...(d?.days_stand_in ? ['; days PRISM hasn\'t posted yet from the NRCC interpolated grid (ACIS grid 1)'] : []),
    '; lake outline from ', link('Natural Earth 1:10m lakes', NE_LAKES), ' v5.1.2, islands removed',
    d?.mask?.cells ? `, ${d.mask.cells} grid cells` : '', '.',
  ];

  G.register({
    id: 'lake_precip', tab: 'details', order: 25,
    mount(slot) {
      const root = el('section', { className: 'section lake-precip', id: 'lake-precip' },
        el('h2', { id: 'lake-precip-h', textContent: 'Rain on the lake from weather grids' }),
        el('p', { className: 'lead', id: 'lake-precip-lead', textContent: '—' }),
        el('p', { className: 'why', id: 'lake-precip-why' }),
        el('div', { className: 'lake-precip-chart', id: 'lake-precip-chart' }),
        el('p', { className: 'note', id: 'lake-precip-note' }),
        el('p', { className: 'src', id: 'lake-precip-src' }));
      root.setAttribute('aria-labelledby', 'lake-precip-h');
      slot.append(root);
      return root;
    },
    render(d, D) {
      const lead = document.getElementById('lake-precip-lead'), why = document.getElementById('lake-precip-why');
      const note = document.getElementById('lake-precip-note');
      const S = d?.series;
      if (!d || d.error || !S || d.total_in == null) {
        lead.textContent = d?.error || 'Gridded rain for the lake isn\'t available for this period yet.';
        lead.classList.toggle('err', !!d?.error && !d?.series);
        why.textContent = ''; note.textContent = '';
        G.emptyChart('lake-precip-chart', 'No grid rain for this period.');
        cite('lake-precip-src', ...srcParts(d));
        return;
      }
      lead.classList.remove('err');
      const total = d.total_in;
      const missing = S.day.filter((_, i) => S.in[i] == null);
      const standIn = S.day.filter((_, i) => S.grid[i] === 'nrcc');
      const area = D.lake_size?.[0]?.area_acre;

      // the grid figure, then the comparison with the station estimate
      const st = D.rain_lake?.[0];
      const stIn = st?.rain_in;
      lead.replaceChildren('Averaged over the whole lake, weather grids show ', b(in2(total)), ' of rain',
        missing.length ? ` for the ${S.day.length - missing.length} of ${S.day.length} days they cover so far` : ' for this period',
        ...(area ? [', about ', b(`${fmtInt(Math.round(total / 12 * area / 100) * 100)} acre-feet`), ` on the lake's ${fmtInt(area)} acres of water`] : []),
        ...(stIn != null ? ['. The station estimate above is ', b(in2(stIn)), ` (middle value of ${st.stations} lowland gauges)`] : []),
        '.');

      // why they differ: where the counted gauges are, what the grid does between them, and what it doesn't cover yet
      const reasons = [];
      if (stIn != null) {
        const diff = total - stIn, close = Math.abs(diff) <= Math.max(0.05, 0.1 * Math.max(total, stIn));
        const counted = (D.rain_stations || []).filter(r => r.counted);
        const east = counted.filter(r => r.lon > EAST_LON).length;
        const partial = missing.length > 0;
        reasons.push(close ? (partial ? 'So far the two are close.' : 'The two agree closely.')
          : `${partial ? 'So far the grid is' : 'The grid is'} ${in2(Math.abs(diff))} ${diff < 0 ? 'lower' : 'higher'}.`);
        if (partial) reasons.push(`It doesn't have ${days(missing)} yet, which the station estimate includes: PRISM posts each day about a day after it ends.`);
        reasons.push(`Why they can differ: no gauge sits out on the water. ${counted.length ? `${east} of the ${counted.length} counted gauges are on the east side, along the Wasatch Front, and the` : 'The counted gauges are on the shore, and the'} station estimate takes their middle value as if the whole lake got that much.`);
        // typical-year figures: mean 1991-2020 PRISM annual totals of the lake cells west of 112.6 W and east of 112.3 W
        reasons.push('The grid (PRISM) fills in every 4 km square on the lake between gauges, guided by where rain usually falls; in a typical year (1991–2020) it puts about 15 in on the west side of the lake and 21 in on the east bays nearest the mountains.');
      } else if (missing.length) reasons.push(`The grid doesn't have ${days(missing)} yet: PRISM posts each day about a day after it ends.`);
      if (standIn.length) reasons.push(`${days(standIn)} ${standIn.length > 1 ? 'are' : 'is'} from a quicker stand-in grid built only from the same kind of gauge reports, replaced once PRISM posts.`);
      const wet = S.in.reduce((m, v, i) => v != null && (m < 0 || v > S.in[m]) ? i : m, -1);
      if (wet >= 0 && S.in[wet] >= 0.1 && S.max_in[wet] != null) reasons.push(`On the wettest day, ${day(S.day[wet])}, the grid ranges from ${in2(S.min_in[wet])} on one part of the lake to ${in2(S.max_in[wet])} on another.`);
      why.textContent = reasons.join(' ');

      // daily bars (stand-in days hatched) and the running total
      const ink = css('--ink'), ink2 = css('--ink-2'), rain = css('--rain'), rule = css('--rule');
      const hatch = { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 3], rotation: Math.PI / 4, color: rain };
      let run = 0;
      const cum = S.in.map(v => (v == null ? null : +(run += v).toFixed(2)));
      const o = G.base();
      o.aria.label = { enabled: true, description: `Daily rain averaged over the Great Salt Lake from PRISM weather grids, ${day(S.day[0])} to ${day(S.day[S.day.length - 1])}. `
        + S.day.map((t, i) => `${day(t)}: ${S.in[i] == null ? 'not available yet' : in2(S.in[i]) + (S.grid[i] === 'nrcc' ? ' (stand-in grid)' : '')}`).slice(0, 62).join('; ')
        + `${S.day.length > 62 ? '; and more days' : ''}. Running total ${in2(total)}${stIn != null ? `, compared with the station estimate of ${in2(stIn)}` : ''}.` };
      o.grid = { left: 12, right: 16, top: 36, bottom: 28, containLabel: true };
      o.legend = { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, itemWidth: 22, itemHeight: 10,
        data: ['Rain that day (PRISM)', ...(standIn.length ? ['Stand-in grid (NRCC)'] : []), 'Running total'] };
      o.xAxis = { type: 'category', data: S.day.map(day), axisLine: { lineStyle: { color: rule } }, axisTick: { alignWithLabel: true },
        axisLabel: { color: ink2, fontSize: 12, hideOverlap: true } };
      const yMax = Math.max(0.1, ...cum.filter(v => v != null), ...(stIn != null ? [stIn] : []));
      o.yAxis = { type: 'value', min: 0, max: Math.ceil(yMax * 10 * 1.1) / 10,
        axisLabel: { color: ink2, fontSize: 12, formatter: (v) => `${v.toFixed(1)} in` }, splitLine: { lineStyle: { color: css('--grid-major') } } };
      o.tooltip = { ...o.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' },
        formatter: (ps) => {
          const i = ps[0]?.dataIndex; if (i == null) return '';
          if (S.in[i] == null) return `${day(S.day[i])}<br>Not posted yet`;
          return `${day(S.day[i])}<br>Lake average: <b>${in2(S.in[i])}</b>${S.grid[i] === 'nrcc' ? ' (stand-in grid)' : ` (PRISM, ${S.status[i]})`}`
            + `<br>Across the lake: ${in2(S.min_in[i])}–${in2(S.max_in[i])}<br>Running total: <b>${in2(cum[i])}</b>`;
        } };
      const bars = (name, keep, style) => ({ name, type: 'bar', stack: 'day', barMaxWidth: 28, itemStyle: style,
        data: S.in.map((v, i) => (keep(i) ? v : null)) });
      o.series = [
        bars('Rain that day (PRISM)', (i) => S.grid[i] === 'prism', { color: rain }),
        ...(standIn.length ? [bars('Stand-in grid (NRCC)', (i) => S.grid[i] === 'nrcc', { color: 'transparent', borderColor: rain, borderWidth: 1.5, decal: hatch })] : []),
        { name: 'Running total', type: 'line', data: cum, connectNulls: false, symbol: 'circle', symbolSize: 6, showSymbol: S.day.length <= 62,
          lineStyle: { width: 2, color: ink }, itemStyle: { color: ink },
          markLine: stIn != null ? { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: ink2, width: 1.5 },
            label: { formatter: `Station estimate ${in2(stIn)}`, position: 'insideEndTop', color: ink2, fontSize: 12 }, data: [{ yAxis: stIn }] } : undefined },
      ];
      if (missing.length && S.day.length <= 31) o.series[0].markPoint = { silent: true, symbol: 'rect', symbolSize: 1, itemStyle: { color: 'transparent' },
        label: { show: true, color: ink2, fontSize: 12, formatter: 'not yet', position: 'top' },
        data: S.day.map((t, i) => [i, t]).filter(([i]) => S.in[i] == null).map(([i]) => ({ coord: [i, 0] })) };
      G.chart('lake-precip-chart').setOption(o, true);

      // the same numbers as a table for screen readers
      const node = document.getElementById('lake-precip-chart');
      let tbl = node.parentElement.querySelector('table.sr-only');
      if (!tbl) { tbl = el('table', { className: 'sr-only' }); node.after(tbl); }
      tbl.replaceChildren(el('caption', { textContent: 'Daily rain averaged over the lake, from weather grids' }),
        el('thead', {}, el('tr', {}, ...['Day', 'Lake average (in)', 'Lowest to highest on the lake (in)', 'Grid'].map(t => el('th', { scope: 'col', textContent: t })))),
        el('tbody', {}, ...S.day.map((t, i) => el('tr', {}, ...[day(t), S.in[i] == null ? 'not posted yet' : S.in[i].toFixed(2),
          S.in[i] == null ? '' : `${S.min_in[i].toFixed(2)}–${S.max_in[i].toFixed(2)}`,
          S.grid[i] == null ? '' : S.grid[i] === 'nrcc' ? 'NRCC stand-in' : `PRISM, ${S.status[i]}`].map(v => el('td', { textContent: v }))))));

      note.textContent = 'Bars: rain each day averaged over every 4 km grid square on the lake. A grid day is the 24 hours ending 6 AM on that date, the same as the morning gauge readings. '
        + (standIn.length ? 'Hatched bars are the stand-in grid. ' : '') + 'Line: running total for the period; the dashed line is the station estimate. '
        + 'PRISM numbers are early for about 5 days and get revised each month for about six months. The lake outline is a larger, older shoreline than today\'s lake, so it includes some dry lakebed.';
      cite('lake-precip-src', ...srcParts(d));
    },
  });
})();
