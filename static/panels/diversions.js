// Water diverted from the Bear, Weber and Jordan before it reaches the lake (sources/diversions.py).
(() => {
  const G = window.GSL;
  const { el, b, link, pretty, fmtInt, fmtDay, parseDay, css } = G;
  const LAYER = 'https://services.arcgis.com/ZzrwjTRez6FJiOq4/ArcGIS/rest/services/Measurement_Stations/FeatureServer/0';
  const DIST = 'https://waterrights.utah.gov/distinfo/default.asp';
  const RIVERS = { Bear: 'Bear River', Weber: 'Weber River', Jordan: 'Jordan River' };
  const COLOR = { Bear: '--bear', Weber: '--weber', Jordan: '--jordan' };
  const gal = (af) => `${pretty(af * G.GAL_PER_AF)} gal`;
  const day = (s, withYear) => s ? fmtDay(parseDay(s), withYear) : '—';
  const source = () => el('p', { className: 'src' }, 'Source: ', link('Utah Division of Water Rights distribution records', DIST),
    ' (daily canal flows) and its ', link('measurement station layer', LAYER),
    '. Values are provisional, and some stations are read by hand and entered weeks later.');
  const errorText = (data) => data?.error || 'Diversion records are not available.';

  // ---- glance: one fact
  G.register({
    id: 'diversions', tab: 'water', order: 30,
    mount(slot) {
      const root = el('div', { className: 'fact' });
      root.append(el('h2', { textContent: 'Water taken before the lake' }), el('p', { className: 'lead' }),
        el('ul', { className: 'flowlist' }), el('p', { className: 'src' }), source());
      slot.append(root);
      return root;
    },
    render(data, D, root) {
      const [, lead, list, note] = root.children;
      list.replaceChildren();
      if (!data || data.error) { lead.textContent = errorText(data); note.textContent = ''; return; }
      const t = data.total;
      if (t.af > 0) lead.replaceChildren('Canals took about ', b(gal(t.af)), ' from the Bear, Weber and Jordan in this period. That water never reached the lake.');
      else lead.textContent = t.reporting ? 'Canal records show no water taken from the Bear, Weber or Jordan in this period.' : 'No canal records for this period yet.';
      for (const r of data.rivers) {
        list.append(el('li', {},
          el('span', {}, RIVERS[r.river], el('small', { textContent: `${r.reporting} of ${r.expected} canals reporting` })),
          el('span', { className: 'x calm' }, r.af > 0 ? gal(r.af) : r.reporting ? 'none' : 'no data', el('small', { textContent: r.af > 0 ? `${fmtInt(r.af)} acre-ft` : '' }))));
      }
      const parts = [];
      if (t.last_day && D.window && t.last_day < D.window.to) parts.push(`Records run through ${day(t.last_day)}.`);
      if (t.manual_missing) parts.push(`${t.manual_missing} hand-read canals haven't been entered for this period, so the real total is higher.`);
      note.textContent = parts.join(' ');
    },
  });

  // ---- details: biggest diversions
  G.register({
    id: 'diversions_detail', tab: 'details', order: 30,
    mount(slot) {
      const root = el('section', { className: 'section' });
      root.setAttribute('aria-labelledby', 'div-top-h');
      const table = el('table');
      table.append(el('caption'), el('thead', {}, el('tr', {}, ...['Station', 'Canal', 'River', 'Water (acre-ft)', 'Gallons', 'Last reported']
        .map(h => el('th', { scope: 'col', textContent: h })))), el('tbody'));
      root.append(el('h2', { id: 'div-top-h', textContent: 'Biggest diversions before the lake' }),
        el('div', { className: 'tablewrap' }, table), el('p', { className: 'note' }), source());
      slot.append(root);
      return root;
    },
    render(_data, D, root) {
      const data = D.sources?.diversions;
      const caption = root.querySelector('caption'), tb = root.querySelector('tbody'), note = root.querySelector('p.note');
      tb.replaceChildren();
      if (!data || data.error) { caption.textContent = errorText(data); note.textContent = ''; return; }
      caption.textContent = `The ${data.top.length} canals that took the most water in this period, of ${data.total.expected} tracked. Each station number links to its Water Rights page.`;
      for (const s of data.top) {
        tb.append(el('tr', {}, el('td', {}, link(String(s.id), s.url)), el('td', { textContent: s.name + (s.method === 'manual' ? ' (hand-read)' : '') }),
          el('td', { textContent: RIVERS[s.river] }), el('td', { textContent: fmtInt(s.af) }), el('td', { textContent: pretty(s.af * G.GAL_PER_AF) }),
          el('td', { textContent: day(s.last_day, true) })));
      }
      if (!data.top.length) tb.append(el('tr', {}, el('td', { colSpan: 6, textContent: 'No canal took water in this period.' })));
      const t = data.total;
      note.textContent = `Not counted as taken: ${fmtInt(t.bypass_af)} acre-ft through the Surplus Canal and Goggin Drain, which carry Jordan River water on to the lake, `
        + `and ${fmtInt(t.wetland_af)} acre-ft delivered to duck clubs and bird refuges at the lake's edge. `
        + 'A canal is counted once, at its river headgate; branches and turnouts off canals already counted are left out.';
    },
  });

  // ---- history: water-year totals
  G.register({
    id: 'diversions', tab: 'history', order: 30,
    mount(slot) {
      const root = el('section', { className: 'section' });
      root.setAttribute('aria-labelledby', 'div-hist-h');
      root.append(el('h2', { id: 'div-hist-h', textContent: 'Water taken by canals each year' }),
        el('p', { className: 'note', textContent: 'Water diverted from the Bear, Weber and Jordan (and Utah Lake) by the canals and pumps the Division of Water Rights tracks, by water year (October through September). Years not yet complete are left out. Recent years can still rise as hand-read records are entered.' }),
        el('div', { className: 'chart tall', id: 'chart-diversions-annual' }), source());
      slot.append(root);
      return root;
    },
    renderHistory(data) {
      const id = 'chart-diversions-annual';
      const rows = (data?.annual || []).filter(r => !r.partial);
      if (!rows.length) return G.emptyChart(id, data?.error || 'No complete water years yet.');
      const rivers = data.rivers;
      const max = rows.reduce((m, r) => r.total > m.total ? r : m), min = rows.reduce((m, r) => r.total < m.total ? r : m);
      const o = G.base();
      o.aria.label = { enabled: true, description: `Water taken by canals each water year from ${rows[0].water_year} to ${rows[rows.length - 1].water_year}, stacked by river in acre-feet. `
        + `The most was ${fmtInt(max.total)} acre-feet in ${max.water_year}, the least ${fmtInt(min.total)} in ${min.water_year}. `
        + `Latest year ${rows[rows.length - 1].water_year}: ${rivers.map(r => `${RIVERS[r]} ${fmtInt(rows[rows.length - 1][r] || 0)}`).join(', ')}.` };
      o.aria.decal = { show: true };
      o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow' }, valueFormatter: (v) => v == null ? '—' : `${fmtInt(v)} acre-ft` };
      o.legend = { top: 0, left: 0, textStyle: { color: css('--ink'), fontSize: 12 }, icon: 'rect' };
      o.grid.top = 32;
      o.xAxis = { type: 'category', data: rows.map(r => r.water_year), axisLabel: { color: css('--ink-2'), fontSize: 12 }, axisLine: { lineStyle: { color: css('--rule') } } };
      o.yAxis = { ...o.yAxis, axisLabel: { color: css('--ink-2'), fontSize: 12, formatter: (v) => v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : v } };
      o.series = rivers.map((r, i) => ({ name: RIVERS[r], type: 'bar', stack: 'div',
        itemStyle: { color: css(COLOR[r]), decal: { symbol: ['rect', 'circle', 'triangle'][i % 3], symbolSize: .6, color: 'rgba(0,0,0,.18)' } },
        data: rows.map(y => y[r] ?? null) }));
      G.chart(id).setOption(o, true);
    },
  });
})();
