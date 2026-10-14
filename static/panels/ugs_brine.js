// How salty the lake is: Utah Geological Survey brine sampling, north and south arm, 1966-2011.
// Data from sources/ugs_brine.py (HIST.sources.ugs_brine), which reads UGS Open-File Report 596.
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmt1 } = G;
  const OCEAN_PCT = 3.5;
  const pct = (v) => v == null ? '—' : `${fmt1(v)}%`;
  const times = (v) => Math.round(v / OCEAN_PCT);

  document.head.append(el('style', { textContent: `
    .ugs-brine details { margin-top: 10px; font-size: .9rem; color: var(--ink-2); }
    .ugs-brine summary { cursor: pointer; color: var(--ink); min-height: 24px; }
    .ugs-brine table { font-size: 13px; }
    .ugs-brine td, .ugs-brine th { padding: 3px 10px; }
    .ugs-brine td:not(:first-child), .ugs-brine th:not(:first-child) { text-align: right; }
    .ugs-brine .lead { margin: 4px 0 12px; }
    .ugs-brine .lead b { font-family: var(--mono); font-weight: 600; }
  ` }));

  G.register({
    id: 'ugs_brine', tab: 'history', order: 70,
    mount(slot) {
      const root = el('section', { className: 'section ugs-brine' },
        el('h2', { id: 'ugs-brine-h', textContent: 'How salty the lake has been, 1966–2011' }),
        el('p', { className: 'note', textContent: 'Salt decides what can live in the lake: the brine shrimp and brine flies that feed millions of migrating birds need water that is salty, but not too salty. A railroad causeway built in 1959 splits the lake, so the north arm, cut off from the rivers, is far saltier than the south arm.' }),
        el('p', { className: 'lead', id: 'ugs-brine-lead', textContent: 'Loading…' }),
        el('div', { className: 'chart tall', id: 'chart-ugs-brine', role: 'img' }),
        el('p', { className: 'src', id: 'ugs-brine-how' }),
        el('details', {}, el('summary', { textContent: 'Show the yearly numbers' }), el('div', { id: 'ugs-brine-table' })),
        el('p', { className: 'src', id: 'ugs-brine-src' }));
      root.setAttribute('aria-labelledby', 'ugs-brine-h');
      slot.append(root);
      return root;
    },
    renderHistory(d) {
      const lead = document.getElementById('ugs-brine-lead');
      const L = d?.links || {
        stac_item: 'https://maps-assets.geology.utah.gov/warehouse/stac/ugs-publications/OFR/OFR-596/OFR-596.json',
        stac_collection: 'https://maps-assets.geology.utah.gov/warehouse/stac/ugs-publications/OFR/collection.json',
        report: 'https://ugspub.nr.utah.gov/publications/open_file_reports/OFR-596/OFR-596.pdf', ugs: 'https://geology.utah.gov/',
      };
      cite('ugs-brine-src', 'Utah Geological Survey, ', link('Open-File Report 596, Great Salt Lake brine chemistry database, 1966–2011', L.report),
        ' (', link('STAC item', L.stac_item), ' in the ', link('UGS publications collection', L.stac_collection), '; ',
        link('geology.utah.gov', L.ugs), '). License CC BY 4.0.');
      if (!d || d.error || !d.available) {
        lead.textContent = d?.error ? `Couldn't load the brine samples: ${d.error}.` : 'The brine sample record is not loaded yet.';
        lead.classList.toggle('err', !!d?.error);
        G.emptyChart('chart-ugs-brine', 'No brine samples loaded.');
        return;
      }
      lead.classList.remove('err');
      const Y = d.years, sL = d.south_low, sH = d.south_high, nL = d.north_low, nH = d.north_high;
      lead.replaceChildren('The south arm, where people sail and brine shrimp are harvested, ranged from ', b(pct(sL.pct)),
        ` salt in ${sL.year}, after record floods filled the lake, to `, b(pct(sH.pct)), ` in ${sH.year}, when the lake was low. `,
        'The north arm stayed between ', b(pct(nL.pct)), ' and ', b(pct(nH.pct)),
        `, up to about ${times(nH.pct)} times saltier than the ocean (about ${OCEAN_PCT}%). When more river water reaches the lake, it rises and gets fresher.`);
      document.getElementById('ugs-brine-how').textContent = `Each point is the middle (median) salinity of water samples from the top ${d.shallow_ft} feet, `
        + `first across sampling sites on each date, then across dates in the year: ${d.samples.toLocaleString('en-US')} samples at ${d.sites} sites. `
        + 'Salinity is percent salt by weight. Gaps mean no samples that year. UGS stopped adding to this archive in 2011.';

      const ink = css('--ink'), ink2 = css('--ink-2');
      const series = [
        { key: 'north', name: 'North arm (cut off from rivers)', color: css('--pen'), symbol: 'circle', type: 'solid' },
        { key: 'south', name: 'South arm (fed by rivers)', color: css('--hydro'), symbol: 'triangle', type: 'dashed' },
      ];
      const o = G.base();
      const first = Y[0].y, last = Y[Y.length - 1].y;
      o.aria.label = { enabled: true, description: `Line chart of Great Salt Lake salinity by year from ${first} to ${last}. `
        + `North arm: ${pct(nL.pct)} (${nL.year}) to ${pct(nH.pct)} (${nH.year}). South arm: ${pct(sL.pct)} (${sL.year}) to ${pct(sH.pct)} (${sH.year}). `
        + `Both arms were freshest in the mid-1980s, when the lake was highest. A dashed reference line marks ocean salinity, about ${OCEAN_PCT}%. `
        + 'The yearly numbers are in the table below the chart.' };
      o.grid.top = 36; o.grid.right = 24;
      o.legend = { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, itemWidth: 28 };
      o.xAxis = { ...o.xAxis, type: 'value', min: first, max: last, interval: 5, axisLabel: { color: ink2, formatter: (v) => String(v) } };
      o.yAxis = { ...o.yAxis, min: 0, max: 30, interval: 5,
        axisLabel: { color: ink2, formatter: (v) => `${v}%` } };
      const byYear = new Map(Y.map(r => [r.y, r]));
      o.tooltip.formatter = (ps) => {
        const r = byYear.get(ps[0].value[0]);
        if (!r) return '';
        const line = (k, label) => r[k] == null ? `${label}: no samples` : `${label}: ${pct(r[k])} (${r[`${k}_n`]} sampling date${r[`${k}_n`] === 1 ? '' : 's'})`;
        return [`<b>${r.y}</b>`, line('north', 'North arm'), line('south', 'South arm'), r.lake_ft ? `Lake level: ${fmt1(r.lake_ft)} ft` : ''].filter(Boolean).join('<br>');
      };
      o.series = series.map((s, i) => ({
        name: s.name, type: 'line', connectNulls: false, symbol: s.symbol, symbolSize: 7, showSymbol: true,
        lineStyle: { width: 2, color: s.color, type: s.type }, itemStyle: { color: s.color },
        data: Y.map(r => [r.y, r[s.key] ?? null]),
        markLine: i === 1 ? { silent: true, symbol: 'none', lineStyle: { type: 'dotted', color: ink2, width: 1.5 },
          label: { color: ink2, fontSize: 12, formatter: `Ocean ≈ ${OCEAN_PCT}%`, position: 'insideEndTop' }, data: [{ yAxis: OCEAN_PCT }] } : undefined,
      }));
      G.chart('chart-ugs-brine').setOption(o, true);

      const th = (t) => el('th', { scope: 'col', textContent: t });
      document.getElementById('ugs-brine-table').replaceChildren(el('table', {},
        el('caption', { textContent: `Median salinity (percent salt by weight) of the top ${d.shallow_ft} feet of water, by year, with the south arm lake level` }),
        el('thead', {}, el('tr', {}, th('Year'), th('North arm'), th('South arm'), th('Lake level (ft)'))),
        el('tbody', {}, ...Y.map(r => el('tr', {}, el('th', { scope: 'row', textContent: String(r.y) }),
          ...[pct(r.north), pct(r.south), r.lake_ft ? fmt1(r.lake_ft) : '—'].map(t => el('td', { textContent: t })))))));
    },
  });
})();
