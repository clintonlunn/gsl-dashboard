// Where the water goes: the water used up each year in the lake's four river basins, by use, before it can reach
// the lake. A short Farms-tab summary of the Utah Water Budget model; the History tab has the year-by-year bars.
// Data rides on the water_budget source (DATA.sources.water_budget.recent):
//   water_years      [first, last] averaged
//   by_basin         [basin, utah (1/0), sector, acre-ft a year]
//   mineral_lake_af  mineral extraction on the whole lake, acre-ft a year
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt } = G;
  const BASINS = ['Bear River', 'Weber River', 'Jordan River', 'Utah Lake'];
  const USES = [
    { k: 'Agriculture', label: 'Irrigated crops', farm: true },
    { k: 'Sub-irrigated', label: 'Wet meadows and pasture', farm: true },
    { k: 'M&I', label: 'Cities, homes and industry' },
    { k: 'Mineral', label: 'Mineral ponds on the lake' },
    { k: 'Incidental', label: 'Plants along canals' },
  ];
  const HUB = 'https://dwre-utahdnr.opendata.arcgis.com/pages/water-budget';
  const STUDY = 'https://doi.org/10.1038/ngeo3052';
  const af = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(2)} million` : fmtInt(Math.round(v / 1000) * 1000);

  G.register({
    id: 'water_use', tab: 'ag', order: 5,
    mount(slot) {
      const basin = el('select', { id: 'wu-basin' }, el('option', { value: '', textContent: 'All four basins' }),
        ...BASINS.map(k => el('option', { value: k, textContent: k })));
      const utah = el('input', { type: 'checkbox', id: 'wu-utah' });
      const root = el('section', { className: 'section wu' },
        el('h2', { id: 'wu-h', textContent: 'Where the water goes' }),
        el('p', { className: 'lead', id: 'wu-lead', textContent: '—' }),
        el('div', { className: 'wu-controls' },
          el('label', { htmlFor: 'wu-basin' }, 'Basin ', basin),
          el('label', { htmlFor: 'wu-utah' }, utah, 'Utah only (leave out Idaho and Wyoming)')),
        el('p', { className: 'note', textContent: 'Acre-feet a year. Green bars are farm uses.' }),
        el('div', { className: 'chart wu-chart', id: 'wu-chart' }),
        el('div', { id: 'wu-table' }),
        el('details', {}, el('summary', { textContent: 'What this counts' }),
          el('ul', { className: 'wu-notes' },
            el('li', { textContent: '"Used up" means water that evaporates or goes into plants and doesn\'t flow back to a river. Water a farm or city takes and returns downstream isn\'t counted.' }),
            el('li', { textContent: 'Wet meadows and pasture are fields watered by a high water table along the rivers, mostly hay and grazing.' }),
            el('li', { textContent: 'Mineral ponds pump lake water into shallow ponds to dry it for salt, potash and magnesium. With all four basins picked this is every pond on the lake, west side included.' }),
            el('li', { textContent: 'Reservoir evaporation and evaporation from the lake itself aren\'t in the state\'s model.' }),
            el('li', { textContent: 'The state says its Idaho and Wyoming figures are less certain and not approved by those states.' }))),
        el('p', { className: 'src', id: 'wu-src' }));
      root.setAttribute('aria-labelledby', 'wu-h');
      slot.append(root);
      const redraw = () => this.__d && draw(this.__d);
      basin.addEventListener('change', redraw);
      utah.addEventListener('change', redraw);
      return root;
    },
    render(_, D) { this.__d = D?.sources?.water_budget; draw(this.__d); },
  });

  function draw(d) {
    const lead = document.getElementById('wu-lead'), R = d?.recent;
    if (!R?.by_basin?.length) {
      lead.textContent = d?.error || 'Water use figures are not available right now.';
      G.emptyChart('wu-chart', 'No water budget data.');
      document.getElementById('wu-table').replaceChildren();
      return;
    }
    const basin = document.getElementById('wu-basin').value, utahOnly = document.getElementById('wu-utah').checked;
    const sum = (bs) => {
      const t = Object.fromEntries(USES.map(u => [u.k, 0]));
      for (const [b0, ut, k, v] of R.by_basin) if ((!bs || b0 === bs) && (ut || !utahOnly)) t[k] += v;
      if (!bs && R.mineral_lake_af != null) t.Mineral = R.mineral_lake_af;
      return t;
    };
    const t = sum(basin), total = USES.reduce((s, u) => s + t[u.k], 0);
    const pct = (v) => !total ? '—' : v > 0 && v / total < 0.01 ? 'under 1%' : `${Math.round(100 * v / total)}%`;
    const farms = USES.filter(u => u.farm).reduce((s, u) => s + t[u.k], 0);
    const [y0, y1] = R.water_years;
    const place = basin ? `the ${basin} basin` : 'the four river basins that feed the lake';
    const states = utahOnly ? ' (Utah side only)' : basin === 'Bear River' || !basin ? ' (Idaho and Wyoming included)' : '';
    lead.replaceChildren(`In an average year (${y0}–${y1}), about `, b(`${af(total)} acre-feet`), ` of water is used up in ${place}${states}, so it never reaches the lake. `,
      'Farms use ', b(pct(farms)), ', cities, homes and industry ', b(pct(t['M&I'])), ...(t.Mineral ? [', mineral ponds ', b(pct(t.Mineral))] : []), '. ',
      ...(!basin ? ['Studies estimate this kind of use has ', link('lowered the lake about 11 feet', STUDY), ' from where it would be.'] : []));

    const order = USES.filter(u => t[u.k] > 0).sort((x, y) => t[y.k] - t[x.k]);
    const ink = css('--ink'), ink2 = css('--ink-2'), paper = css('--paper');
    const holder = document.getElementById('wu-chart');
    const narrow = holder.clientWidth < 560;
    holder.style.height = `${order.length * (narrow ? 46 : 33) + 16}px`;
    const o = G.base();
    o.aria.decal = { show: false };
    o.aria.label = { enabled: true, description: `Bar chart of water used up a year in ${place}${states}, averaged over water years ${y0} to ${y1}, from the Utah Water Budget model: `
      + `${af(total)} acre-feet in all. ` + order.map(u => `${u.label}: ${af(t[u.k])} acre-feet, ${pct(t[u.k])}.`).join(' ') + ' A table by basin follows the chart.' };
    o.grid = narrow ? { left: 0, right: 124, top: 18, bottom: 4, containLabel: false } : { left: 8, right: 136, top: 8, bottom: 8, containLabel: true };
    o.xAxis = { type: 'value', show: false };
    o.yAxis = { type: 'category', inverse: true, data: order.map(u => u.label), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: narrow ? { inside: true, align: 'left', verticalAlign: 'bottom', padding: [0, 0, 14, 0], color: ink, fontSize: 13, fontFamily: css('--sans') }
        : { color: ink, fontSize: 13, fontFamily: css('--sans'), width: 230, overflow: 'break' } };
    o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => `<b>${order[p.dataIndex].label}</b><br>${fmtInt(p.value)} acre-feet a year (${pct(p.value)})` };
    o.series = [{ type: 'bar', barMaxWidth: narrow ? 14 : 22,
      data: order.map(u => ({ value: Math.round(t[u.k]), itemStyle: { color: css(u.farm ? '--healthy' : '--hydro') } })),
      label: { show: true, position: 'right', color: ink2, fontSize: 12, formatter: (p) => `${narrow && p.value >= 1e6 ? `${(p.value / 1e6).toFixed(2)}M` : af(p.value)} · ${pct(p.value)}` },
      itemStyle: { borderColor: paper, borderWidth: 0.5 } }];
    const ch = G.chart('wu-chart');
    ch.resize();
    ch.setOption(o, true);

    // the same numbers by basin, so the chart isn't the only way in
    const cols = USES.filter(u => BASINS.some(bs => sum(bs)[u.k] > 0));
    const rows = BASINS.map(bs => [bs, sum(bs)]);
    document.getElementById('wu-table').replaceChildren(el('details', {}, el('summary', { textContent: 'By basin' }), el('div', { className: 'tablewrap' }, el('table', { className: 'wu-table' },
      el('caption', { textContent: `Acre-feet used up a year by basin, ${y0}–${y1} average${utahOnly ? ', Utah side only' : ''}. Mineral ponds on the lake's west side aren't in any of these basins.` }),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col', textContent: 'Basin' }), ...cols.map(u => el('th', { scope: 'col', textContent: u.label })), el('th', { scope: 'col', textContent: 'Total' }))),
      el('tbody', {}, ...rows.map(([bs, r]) => el('tr', {}, el('th', { scope: 'row', textContent: bs }),
        ...cols.map(u => el('td', { textContent: r[u.k] ? fmtInt(Math.round(r[u.k] / 1000) * 1000) : '—' })),
        el('td', { textContent: fmtInt(Math.round(cols.reduce((s, u) => s + r[u.k], 0) / 1000) * 1000) }))))))));

    cite('wu-src', 'Utah Division of Water Resources, ', link('Utah Water Budget', d.hub_url || HUB),
      ...(d.service_url ? [' (', link(d.service, d.service_url), ')'] : []), `, water years ${y0}–${y1}, CC BY-SA. Lake decline: `,
      link('Wurtsbaugh et al. 2017, Nature Geoscience', STUDY), '. Year-by-year bars are on the History tab.');
  }
})();
