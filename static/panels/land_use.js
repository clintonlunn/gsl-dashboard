// Crops and how they're watered: DWRe Water-Related Land Use, 2017 on, for the Bear, Weber, Jordan and Utah Lake basins.
// Data from sources/land_use.py (DATA.sources.land_use). Rows are arrays to keep the payload small:
//   trend  [year, basin, utah, method, acres]       irrigated fields only
//   groups [year, basin, utah, lu_group, acres]     every water-related land use class
//   crops  [basin, utah, crop_group, crop, method, acres]   newest year, irrigated fields only
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt } = G;
  const BASIN_TEXT = { 'Bear River': 'Bear River', 'Weber River': 'Weber River', 'Jordan River': 'Jordan River', 'Utah Lake': 'Utah Lake' };
  // sprinklers come in three kinds in the survey; they share a hue family so "sprinkler" reads as one idea
  // the survey splits sprinklers into center pivots and wheel lines only from 2025, so the chart keeps them as one
  const METHODS = [
    { key: 'Flood', label: 'Flood', color: '--hydro', decal: null },
    { key: 'Sprinkler', label: 'Sprinkler (all kinds)', color: '--healthy', decal: 'dots' },
    { key: 'Drip', label: 'Drip', color: '--pen', decal: 'vert' },
    { key: 'Sub-irrigated', label: 'Sub-irrigated (high water table)', color: '--rain', decal: 'horiz' },
  ];
  const COLUMNS = [['Flood', 'Flood'], ['Sprinkler', 'Sprinkler'], ['Pivot', 'Center pivot'], ['Wheel', 'Wheel line'], ['Drip', 'Drip'], ['Sub-irrigated', 'Sub-irr.']];
  const SPRINKLER = new Set(['Sprinkler', 'Pivot', 'Wheel']);
  const GROUPS = [
    ['Active IR', 'Irrigated farmland'], ['SubIRR', 'Sub-irrigated farmland'], ['Dry Ag', 'Dry farmland (no irrigation)'],
    ['Idle/Fallow', 'Idle or fallow farmland'], ['Urban Grass', 'Urban lawns, parks and golf'], ['Urban', 'Other urban land'],
    ['RIP', 'Riparian and wetland'], ['Water', 'Open water'], ['Wet Flats', 'Wet flats'],
  ];
  const pct = (v, t) => !t ? '—' : v > 0 && v / t < 0.005 ? 'under 1%' : `${Math.round((v / t) * 100)}%`;
  const ac = (v) => fmtInt(Math.round(v));
  const round = (v) => v >= 1e4 ? fmtInt(Math.round(v / 1000) * 1000) : fmtInt(Math.round(v / 10) * 10);


  const sel = () => ({ basin: document.getElementById('lu-basin')?.value || '', all: !!document.getElementById('lu-states')?.checked });
  const keep = (basin, utah, s) => (!s.basin || basin === s.basin) && (s.all || utah === 1);
  const where = (s) => {
    const place = s.basin ? `the ${BASIN_TEXT[s.basin]} basin` : 'the Bear, Weber, Jordan and Utah Lake basins';
    const bear = !s.basin || s.basin === 'Bear River';
    if (!bear) return place;
    return s.all ? `${place}, Idaho and Wyoming included` : `the Utah side of ${place}`;
  };

  G.register({
    id: 'land_use', topic: 'farms', view: 'detail', order: 20,
    mount(slot) {
      const basin = el('select', { id: 'lu-basin' },
        el('option', { value: '', textContent: 'All four basins' }),
        ...Object.entries(BASIN_TEXT).map(([k, v]) => el('option', { value: k, textContent: v })));
      const states = el('input', { type: 'checkbox', id: 'lu-states' });
      const root = el('section', { className: 'section lu' },
        el('h2', { id: 'lu-h', textContent: "Crops and how they're watered" }),
        el('p', { className: 'lead', id: 'lu-lead', textContent: '—' }),
        el('div', { className: 'lu-controls' },
          el('label', { htmlFor: 'lu-basin' }, 'Basin ', basin),
          el('label', { htmlFor: 'lu-states' }, states, 'Include Idaho and Wyoming fields in the Bear River basin')),
        el('p', { className: 'note', id: 'lu-note' }),
        el('div', { className: 'chart lu-chart', id: 'lu-chart' }),
        el('div', { className: 'lu-tables', id: 'lu-tables' }),
        el('p', { className: 'src', id: 'lu-src' }));
      root.setAttribute('aria-labelledby', 'lu-h');
      slot.append(root);
      const redraw = () => this.__d && draw(this.__d);
      basin.addEventListener('change', redraw);
      states.addEventListener('change', redraw);
      return root;
    },
    render(d) { this.__d = d; draw(d); },
  });

  function draw(d) {
    const lead = document.getElementById('lu-lead');
    if (!d || d.error) {
      lead.textContent = d?.error || 'Land use figures are not available right now.';
      G.emptyChart('lu-chart', 'No land use survey data.');
      document.getElementById('lu-tables').replaceChildren();
      return;
    }
    const s = sel(), Y = d.years, last = d.latest, first = Y[0];
    // acres by year and method, for what's picked
    const byYM = {};
    for (const [y, basin, utah, m0, a] of d.trend) {
      if (!keep(basin, utah, s)) continue;
      const m = SPRINKLER.has(m0) ? 'Sprinkler' : m0;
      (byYM[y] ||= {})[m] = (byYM[y]?.[m] || 0) + a;
    }
    const tot = (y) => Object.values(byYM[y] || {}).reduce((t, v) => t + v, 0);
    const M = byYM[last] || {}, T = tot(last);
    const spr = M.Sprinkler || 0;
    const crops = {};
    for (const [basin, utah, , crop, m, a] of d.crops) if (keep(basin, utah, s)) { const c = (crops[crop] ||= { total: 0 }); c.total += a; c[m] = (c[m] || 0) + a; }
    const top = Object.entries(crops).sort((x, y) => y[1].total - x[1].total);
    const hay = (crops.Alfalfa?.total || 0) + (crops['Grass Hay']?.total || 0) + (crops.Pasture?.total || 0);

    lead.replaceChildren(`In ${last}, farms ${s.all || (s.basin && s.basin !== 'Bear River') ? 'in' : 'on'} ${where(s)} irrigated about `, b(`${round(T)} acres`), '. ',
      b(pct(M.Flood || 0, T)), ' were flooded, ', b(pct(spr, T)), ' watered by sprinklers (including center pivots and wheel lines), and ',
      b(pct(M.Drip || 0, T)), ' by drip. ',
      ...(top.length ? ['Alfalfa, grass hay and pasture cover ', b(pct(hay, T)), ' of it; the biggest single crop is ', b(top[0][0].toLowerCase()), ` at ${round(top[0][1].total)} acres.`] : []));
    document.getElementById('lu-note').textContent =
      `Irrigated acres each survey year by irrigation method, ${first}–${last}. Sub-irrigated fields get water from a high water table rather than a canal or well. `
      + `Sprinklers are one bar because the survey only splits out center pivots and wheel lines from ${last}; the table shows that split. `
      + 'The state warns that year-to-year changes are not firm trends: the mapping method changes, and the 2024 survey was adjusted when USDA changed its crop map.';

    const paper = css('--paper'), ink = css('--ink'), ink2 = css('--ink-2');
    const decal = (k) => k == null ? { symbol: 'none' } : {
      dots: { symbol: 'circle', symbolSize: 0.6, dashArrayX: [1, 3], dashArrayY: [1, 3], color: paper },
      diag: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: Math.PI / 4, color: paper },
      cross: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: -Math.PI / 4, color: paper },
      vert: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 5], rotation: Math.PI / 2, color: paper },
      horiz: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 5], color: paper },
    }[k];
    const used = METHODS.filter(m => Y.some(y => byYM[y]?.[m.key]));
    const o = G.base();
    o.aria.decal = { show: false };
    o.aria.label = { enabled: true, description: `Stacked bar chart of irrigated acres by irrigation method in ${where(s)}, ${first} to ${last}, from the state's water-related land use survey. `
      + `${last}: ${ac(T)} acres in all; ${used.map(m => `${m.label.toLowerCase()} ${ac(M[m.key] || 0)}`).join(', ')}. `
      + `${first}: ${ac(tot(first))} acres. A table of crops by method follows the chart.` };
    o.legend = { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, itemWidth: 18, itemHeight: 12 };
    o.grid = { ...o.grid, top: 56 };
    o.xAxis = { type: 'category', data: Y.map(String), axisLine: { lineStyle: { color: css('--rule') } }, axisLabel: { color: ink2, fontSize: 12 }, axisTick: { alignWithLabel: true } };
    o.yAxis = { ...o.yAxis, name: 'acres', nameTextStyle: { color: ink2, align: 'left', fontSize: 12 },
      axisLabel: { color: ink2, fontSize: 12, formatter: (v) => v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : v } };
    o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow' }, formatter: (ps) => {
      const y = Y[ps[0]?.dataIndex]; if (y == null) return '';
      return [`${y}: <b>${ac(tot(y))}</b> irrigated acres`, ...ps.filter(p => p.value).reverse().map(p => `${p.marker}${p.seriesName}: <b>${ac(p.value)}</b> (${pct(p.value, tot(y))})`)].join('<br>');
    } };
    o.series = used.map(m => ({ name: m.label, type: 'bar', stack: 'ac', barMaxWidth: 40, data: Y.map(y => Math.round(byYM[y]?.[m.key] || 0)),
      itemStyle: { color: css(m.color), decal: decal(m.decal), borderColor: paper, borderWidth: 0.5 }, emphasis: { focus: 'series' } }));
    G.chart('lu-chart').setOption(o, true);

    // crops by method (newest year), and every land use class then vs the first survey year
    const cols = COLUMNS.filter(([k]) => top.some(([, c]) => c[k]));
    const cropTable = el('div', {}, el('h3', { textContent: `Irrigated crops in ${last}, acres by method` }),
      el('div', { className: 'tablewrap' }, el('table', { className: 'lu-table' },
        el('caption', { className: 'sr-only', textContent: `Irrigated crops in ${where(s)}, ${last}, acres by irrigation method, largest first.` }),
        el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'Crop' }), el('th', { scope: 'col', textContent: 'All' }),
          ...cols.map(([, label]) => el('th', { scope: 'col', textContent: label })))),
        el('tbody', {}, ...top.map(([crop, c]) => el('tr', {}, el('th', { scope: 'row', textContent: crop, style: 'text-align:left;font-weight:500' }),
          el('td', { textContent: ac(c.total) }), ...cols.map(([k]) => el('td', { textContent: c[k] ? ac(c[k]) : '' }))))))));
    const byG = (y) => { const out = {}; for (const [yy, basin, utah, g, a] of d.groups) if (yy === y && keep(basin, utah, s)) out[g] = (out[g] || 0) + a; return out; };
    const G0 = byG(first), G1 = byG(last);
    const names = new Map(GROUPS);
    const gkeys = [...new Set([...Object.keys(G1), ...Object.keys(G0)])].sort((x, y) => (G1[y] || 0) - (G1[x] || 0));
    const landTable = el('div', {}, el('h3', { textContent: `All water-related land, ${first} and ${last}` }),
      el('div', { className: 'tablewrap' }, el('table', { className: 'lu-table' },
        el('caption', { className: 'sr-only', textContent: `Water-related land use in ${where(s)}, acres in ${first} and ${last}.` }),
        el('thead', {}, el('tr', {}, ...['Land use', String(first), String(last), 'Change'].map(t => el('th', { scope: 'col', textContent: t })))),
        el('tbody', {}, ...gkeys.map(g => {
          const a = G0[g] || 0, z = G1[g] || 0, ch = z - a;
          return el('tr', {}, el('th', { scope: 'row', textContent: names.get(g) || g, style: 'text-align:left;font-weight:500' }),
            el('td', { textContent: ac(a) }), el('td', { textContent: ac(z) }), el('td', { textContent: `${ch >= 0 ? '+' : '−'}${ac(Math.abs(ch))}` }));
        })))));
    landTable.append(el('p', { className: 'src', textContent: 'Large swings, like idle and fallow land, can come from drought years as well as from changes in how the survey maps fields, so read the change column as rough. The survey dropped its catch-all "other" class after 2023, so that row is left out.' }));
    document.getElementById('lu-tables').replaceChildren(cropTable, landTable);

    const A = d.about;
    cite('lu-src', A.credit, ', ', link('Water-Related Land Use', A.hub_url), ` survey, ${first}–${last} (`,
      link('newest feature service', A.service_url), '; ', link('UGRC SGID page', A.sgid_url), `), ${A.license}. Acres are summed by the state's server from field polygons; basins are the state's hydrologic basins, not watershed codes.`
      + (d.pulled_at ? ` Pulled ${d.pulled_at.slice(0, 10)}.` : ''));
  }
})();
