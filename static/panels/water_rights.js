// Water rights on paper: Utah Division of Water Rights points of diversion, one row per right, for the four basins.
// Data from sources/water_rights.py (DATA.sources.water_rights). Rows are arrays:
//   by_basin  [basin, rights, cfs, acft]
//   by_use    [basin, use letter, rights, cfs, acft]   overlapping: a right with several uses counts under each
//   by_decade [basin, decade ('1850') or null, rights, cfs, acft]
//   by_kind   [basin, Surface | Underground | Spring | Other, rights, cfs, acft]
//   biggest   [wrnum, basin, uses, kind, cfs, acft, priority]
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt } = G;
  const BASINS = ['Bear River', 'Weber River', 'Jordan River', 'Utah Lake'];
  const COLOR = { 'Bear River': '--bear', 'Weber River': '--weber', 'Jordan River': '--jordan', 'Utah Lake': '--healthy' };
  const RIGHT = (wr) => `https://waterrights.utah.gov/asp_apps/wrprint/wrprint.asp?wrnum=${encodeURIComponent(wr)}`;
  const af = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(2)} million` : fmtInt(Math.round(v / 1000) * 1000);
  const ac = (v) => fmtInt(Math.round(v));

  document.head.append(el('style', { textContent: `
    .wr .lead { font-size: 1.05rem; color: var(--ink); margin: 4px 0 12px; line-height: 1.5; }
    .wr-controls { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; margin: 0 0 8px; font-size: .875rem; color: var(--ink-2); }
    .wr-controls label { display: inline-flex; gap: 6px; align-items: center; min-height: 24px; }
    .wr-chart { width: 100%; height: 340px; }
    .wr-tables { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr)); gap: 8px 32px; margin-top: 12px; }
    .wr-table th, .wr-table td { font-size: 13px; }
    .wr-table th:first-child, .wr-table td:first-child { text-align: left; }
    .wr-table tbody th { border-bottom: 1px solid var(--grid-major); font: 500 13px var(--sans); color: var(--ink); text-transform: none; letter-spacing: 0; }
    .wr-table th:not(:first-child), .wr-table td:not(:first-child) { text-align: right; }
    .wr-tables > :last-child { grid-column: 1 / -1; }
    .wr-tables > :last-child :is(th, td):nth-child(-n+3) { text-align: left; }
    .wr h3 { font: 600 .95rem var(--sans); margin: 8px 0 4px; }
    .wr-caveats { margin: 6px 0 0; padding-left: 1.1em; font-size: .95rem; color: var(--ink-2); display: grid; gap: 4px; }
  ` }));

  G.register({
    id: 'water_rights', tab: 'ag', order: 30,
    mount(slot) {
      const basin = el('select', { id: 'wr-basin' }, el('option', { value: '', textContent: 'All four basins' }),
        ...BASINS.map(k => el('option', { value: k, textContent: k })));
      const unit = el('select', { id: 'wr-unit' }, el('option', { value: 'acft', textContent: 'Volume (acre-feet a year)' }),
        el('option', { value: 'cfs', textContent: 'Flow (cubic feet per second)' }));
      const root = el('section', { className: 'section wr' },
        el('h2', { id: 'wr-h', textContent: 'Water rights: what the state allows on paper' }),
        el('p', { className: 'lead', id: 'wr-lead', textContent: '—' }),
        el('div', { className: 'wr-controls' }, el('label', { htmlFor: 'wr-basin' }, 'Basin ', basin), el('label', { htmlFor: 'wr-unit' }, 'Measure ', unit)),
        el('p', { className: 'note', id: 'wr-note' }),
        el('div', { className: 'chart wr-chart', id: 'wr-chart' }),
        el('div', { className: 'wr-tables', id: 'wr-tables' }),
        el('h3', { textContent: 'What these numbers are not' }),
        el('ul', { className: 'wr-caveats' },
          el('li', { textContent: 'Not water used. A right is a legal ceiling; many go partly unused in a given year, and in dry years junior rights get cut first.' }),
          el('li', { textContent: 'Not additive across sources. Many rights are supplemental: a well that backs up a canal share is its own right for the same field.' }),
          el('li', { textContent: 'Not complete for old uses. Surface water used before 1903 and groundwater before 1935 show up only if someone filed a claim.' }),
          el('li', { textContent: 'Volume and flow don\'t line up. Some rights list only a flow, some only a volume, so each is summed on its own.' })),
        el('p', { className: 'src', id: 'wr-src' }));
      root.setAttribute('aria-labelledby', 'wr-h');
      slot.append(root);
      const redraw = () => this.__d && draw(this.__d);
      basin.addEventListener('change', redraw);
      unit.addEventListener('change', redraw);
      return root;
    },
    render(d) { this.__d = d; draw(d); },
  });

  function draw(d) {
    const lead = document.getElementById('wr-lead');
    if (!d || d.error) {
      lead.textContent = d?.error || 'Water rights are not available right now.';
      G.emptyChart('wr-chart', 'No water rights data.');
      document.getElementById('wr-tables').replaceChildren();
      return;
    }
    const basin = document.getElementById('wr-basin').value, unit = document.getElementById('wr-unit').value;
    const col = unit === 'cfs' ? 3 : 4; // by_decade rows: [basin, decade, rights, cfs, acft]
    const fmtV = (v) => unit === 'cfs' ? `${ac(v)} cfs` : `${ac(v)} ac-ft`;
    const inB = (r) => !basin || r[0] === basin;
    const place = basin ? `the ${basin} basin` : 'the Bear, Weber, Jordan and Utah Lake basins';
    const B = d.by_basin.filter(inB);
    const n = B.reduce((t, r) => t + r[1], 0), cfs = B.reduce((t, r) => t + r[2], 0), vol = B.reduce((t, r) => t + r[3], 0);
    const irr = d.by_use.filter(r => inB(r) && r[1] === 'I').reduce((t, r) => t + r[4], 0);
    const kinds = {}; for (const r of d.by_kind.filter(inB)) kinds[r[1]] = (kinds[r[1]] || 0) + r[4];
    lead.replaceChildren('The state has approved ', b(`${fmtInt(n)} water rights`), ` in ${place}, allowing up to about `, b(`${af(vol)} acre-feet a year`),
      ' and ', b(`${fmtInt(Math.round(cfs))} cubic feet per second`), '. Rights that include irrigation account for ', b(`${af(irr)} acre-feet`),
      `. Of the total, wells hold ${af(kinds.Underground || 0)} acre-feet and rivers, canals and springs ${af((kinds.Surface || 0) + (kinds.Spring || 0))}. `
      + "These are legal ceilings, not water used; the notes under the tables explain why the totals run high.");
    document.getElementById('wr-note').textContent = 'Rights by the decade of their priority date, stacked by basin. In Utah the oldest right on a stream is filled first, '
      + 'so the tall early bars are the water that keeps flowing in a dry year, and the later ones are first to be cut off. Rights with no usable date on file are left out of the chart.';

    // decades on the x axis, one stack per basin
    // Utah's water records start with settlement in 1847; earlier dates are typos in the records, counted with the undated
    const dated = (r) => r[1] && r[1] >= '1840';
    const decades = [...new Set(d.by_decade.filter(dated).map(r => r[1]))].sort();
    const shown = basin ? [basin] : BASINS;
    const val = (bs, dec) => d.by_decade.filter(r => r[0] === bs && r[1] === dec).reduce((t, r) => t + r[col], 0);
    const undated = d.by_decade.filter(r => inB(r) && !dated(r)).reduce((t, r) => t + r[2], 0);
    const paper = css('--paper'), ink = css('--ink'), ink2 = css('--ink-2');
    const o = G.base();
    o.aria.decal = { show: false };
    const totals = decades.map(dec => shown.reduce((t, bs) => t + val(bs, dec), 0));
    const peak = totals.indexOf(Math.max(...totals));
    o.aria.label = { enabled: true, description: `Stacked bar chart of water rights by priority decade in ${place}, ${decades[0]}s to ${decades.at(-1)}s, measured in ${unit === 'cfs' ? 'cubic feet per second' : 'acre-feet a year'}. `
      + `The largest decade is the ${decades[peak]}s with ${fmtV(totals[peak])}. ${undated ? `${fmtInt(undated)} rights have no priority date and are left out. ` : ''}Tables of rights by use and source follow.` };
    o.legend = shown.length > 1 ? { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, itemWidth: 18, itemHeight: 12 } : undefined;
    o.grid = { ...o.grid, top: shown.length > 1 ? 64 : 36 };
    o.xAxis = { type: 'category', data: decades.map(x => `${x}s`), axisLine: { lineStyle: { color: css('--rule') } }, axisLabel: { color: ink2, fontSize: 12, hideOverlap: true }, axisTick: { alignWithLabel: true } };
    o.yAxis = { ...o.yAxis, name: unit === 'cfs' ? 'cfs' : 'acre-feet a year', nameTextStyle: { color: ink2, align: 'left', fontSize: 12 },
      axisLabel: { color: ink2, fontSize: 12, formatter: (v) => v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : v } };
    o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow' }, formatter: (ps) => {
      const i = ps[0]?.dataIndex; if (i == null) return '';
      return [`Priority ${decades[i]}s: <b>${fmtV(totals[i])}</b>`, ...ps.filter(p => p.value).reverse().map(p => `${p.marker}${p.seriesName}: <b>${fmtV(p.value)}</b>`)].join('<br>');
    } };
    const pat = [{ symbol: 'none' }, { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: Math.PI / 4, color: paper },
      { symbol: 'circle', symbolSize: 0.6, dashArrayX: [1, 3], dashArrayY: [1, 3], color: paper },
      { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 5], color: paper }];
    o.series = shown.map(bs => ({ name: bs, type: 'bar', stack: 'wr', barMaxWidth: 28, data: decades.map(dec => Math.round(val(bs, dec))),
      itemStyle: { color: css(COLOR[bs]), decal: pat[BASINS.indexOf(bs)], borderColor: paper, borderWidth: 0.5 }, emphasis: { focus: 'series' } }));
    G.chart('wr-chart').setOption(o, true);

    // by use (overlapping), by source, and the biggest single rights
    const uses = {}; for (const r of d.by_use.filter(inB)) { const u = (uses[r[1]] ||= [0, 0, 0]); u[0] += r[2]; u[1] += r[3]; u[2] += r[4]; }
    const useRows = Object.entries(uses).sort((x, y) => y[1][2] - x[1][2]);
    const kindRows = {}; for (const r of d.by_kind.filter(inB)) { const k = (kindRows[r[1]] ||= [0, 0, 0]); k[0] += r[2]; k[1] += r[3]; k[2] += r[4]; }
    const table = (title, caption, head, rows) => el('div', {}, el('h3', { textContent: title }),
      el('div', { className: 'tablewrap' }, el('table', { className: 'wr-table' }, el('caption', { className: 'sr-only', textContent: caption }),
        el('thead', {}, el('tr', {}, ...head.map(t => el('th', { scope: 'col', textContent: t })))),
        el('tbody', {}, ...rows.map(cells => el('tr', {}, ...cells.map((c, i) => i === 0
          ? el('th', { scope: 'row', style: 'text-align:left;font-weight:500' }, c) : el('td', {}, c))))))));
    const biggest = d.biggest.filter(r => !basin || r[1] === basin);
    const useName = (u) => u.split('').map(c => d.uses[c] || c).join(', ');
    document.getElementById('wr-tables').replaceChildren(
      table('By use (a right with several uses counts under each)', `Water rights in ${place} by use. Rows overlap.`,
        ['Use', 'Rights', 'cfs', 'Acre-feet'], useRows.map(([u, v]) => [d.uses[u] || u, fmtInt(v[0]), ac(v[1]), ac(v[2])])),
      table('By source', `Water rights in ${place} by source.`, ['Source', 'Rights', 'cfs', 'Acre-feet'],
        Object.entries(kindRows).sort((x, y) => y[1][2] - x[1][2]).map(([k, v]) => [k === 'Underground' ? 'Wells (underground)' : k, fmtInt(v[0]), ac(v[1]), ac(v[2])])),
      table('Largest single rights by volume', `The largest water rights by volume in ${d.biggest.length ? 'the four basins' : place}.`,
        ['Right', 'Basin', 'Uses', 'Priority', 'Acre-feet'],
        biggest.map(r => [link(r[0], RIGHT(r[0])), r[1], useName(r[2]) || '—', r[6] ? `${r[6].slice(0, 4)}` : '—', ac(r[5])])));

    const A = d.about;
    cite('wr-src', A.credit, ', ', link('Points of Diversion', A.item_url), ' (', link('feature service', A.layer_url), ', ', link('field guide', A.docs_url),
      `), rebuilt nightly by the Division. Approved and perfected rights only; each right is counted once even though it repeats on every point where it can divert. Look up any right in the `,
      link('Division\'s records', A.lookup_url), '.' + (d.pulled_at ? ` Pulled ${d.pulled_at.slice(0, 10)}.` : ''));
  }
})();
