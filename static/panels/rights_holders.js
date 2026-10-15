// Who holds the water rights: owners from the Division of Water Rights' points of diversion, with a map of the big rights.
// Data rides on the water_rights source (DATA.sources.water_rights). Rows are arrays:
//   holders [owner, org (1/0), basin, rights, cfs, acft, rights shared with other owners, holder type index]
//   by_holder_kind [basin, holder type index, holders, rights, cfs, acft]  shared rights split evenly, so types add up
//   holder_kinds   holder type names, in index order
//   big     [wrnum, basin, uses, cfs, acft, priority year, owners joined by ' | ']
//   points  [lon, lat, index into big]
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt } = G;
  const BASINS = ['Bear River', 'Weber River', 'Jordan River', 'Utah Lake'];
  const RIGHT = (wr) => `https://waterrights.utah.gov/asp_apps/wrprint/wrprint.asp?wrnum=${encodeURIComponent(wr)}`;
  const ac = (v) => fmtInt(Math.round(v));
  const af = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(2)} million` : fmtInt(Math.round(v / 1000) * 1000);
  // fixed colours: the dots sit on satellite imagery in both themes, so they don't follow the page palette
  const USE = [
    { k: 'farm', label: 'Irrigation', color: '#7cc58a', test: (u) => u.includes('I') && !/[MPX]/.test(u) },
    { k: 'city', label: 'Cities and towns (often with irrigation)', color: '#ffd54a', test: (u) => u.includes('M') },
    { k: 'power', label: 'Power plants', color: '#c4b0f0', test: (u) => u.includes('P') },
    { k: 'mine', label: 'Mining and industry', color: '#ff8a3d', test: (u) => u.includes('X') },
    { k: 'other', label: 'Other (stock, wildlife, domestic)', color: '#ffffff', test: () => true },
  ];
  const useOf = (u) => USE.find(x => x.test(u || ''));
  const KEEP = new Set(['USA', 'LLC', 'LC', 'LP', 'LLP', 'INC', 'II', 'III', 'IV', 'UP&L', 'DBA', 'KOA', 'LDS', 'HOA']);
  const SMALL = new Set(['OF', 'AND', 'THE', 'FOR', 'AT', 'IN', 'ON']);
  const BRAND = { PACIFICORP: 'PacifiCorp', MCDONALD: 'McDonald' };
  const nice = (s) => s.split(' ').map((w, i) => BRAND[w] || (KEEP.has(w) ? w : i && SMALL.has(w) ? w.toLowerCase()
    : w.length === 1 ? w : w.charAt(0) + w.slice(1).toLowerCase().replace(/([-/&])(\w)/g, (m, p, c) => p + c.toUpperCase()))).join(' ');

  document.head.append(el('style', { textContent: `
    .rh .lead { font-size: 1.05rem; color: var(--ink); margin: 4px 0 12px; line-height: 1.5; }
    .rh-controls { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; margin: 0 0 8px; font-size: .875rem; color: var(--ink-2); }
    .rh-controls label { display: inline-flex; gap: 6px; align-items: center; min-height: 24px; }
    .rh-controls input[type=search] { font: inherit; color: var(--ink); background: var(--paper); border: 1px solid var(--ink-2); padding: 4px 6px; min-width: 14rem; min-height: 28px; }
    .rh-chart { width: 100%; height: 400px; }
    .rh-map { width: 100%; height: 480px; border: 1px solid var(--rule); background: var(--grid); }
    .rh-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 6px 0 0; padding: 0; list-style: none; font-size: .875rem; color: var(--ink-2); }
    .rh-legend li { display: inline-flex; gap: 6px; align-items: center; }
    .rh-legend i { width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid #0c100f; display: inline-block; }
    .rh-table { table-layout: fixed; width: 100%; min-width: 56rem; }
    .rh-table > thead th:nth-child(1) { width: 2.5rem; } .rh-table > thead th:nth-child(3) { width: 15rem; }
    .rh-table > thead th:nth-child(n+4):nth-child(-n+7) { width: 6.5rem; } .rh-table > thead th:nth-child(n+8) { width: 6.5rem; }
    .rh-table > thead th:nth-child(n+8), .rh-table > tbody > tr > td:nth-child(n+8) { text-align: center; }
    .rh-table th, .rh-table td { font-size: 13px; overflow-wrap: anywhere; }
    .rh-table > * > tr > :nth-child(-n+3) { text-align: left; }
    .rh-table > * > tr > :nth-child(n+4):nth-child(-n+7) { text-align: right; }
    .rh-table tbody th { border-bottom: 1px solid var(--grid-major); font: 500 13px var(--sans); color: var(--ink); text-transform: none; letter-spacing: 0; }
    .rh-table button { font: inherit; font-size: 12px; color: var(--ink); background: none; border: 1px solid var(--ink-2); padding: 2px 8px; min-height: 24px; cursor: pointer; }
    .rh-table button[aria-pressed=true] { background: var(--ink); color: var(--paper); }
    .rh h3 { font: 600 .95rem var(--sans); margin: 12px 0 4px; }
    .rh-caveats { margin: 6px 0 0; padding-left: 1.1em; font-size: .95rem; color: var(--ink-2); display: grid; gap: 4px; }
    .rh-pop a { color: inherit; }
    .rh-table td.rh-more { text-align: left; padding: 8px 0 16px 24px; border-bottom: 1px solid var(--grid-major); }
    .rh-more .sum { margin: 0 0 6px; font: 15px/1.5 var(--sans); color: var(--ink); }
    .rh-more .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: 4px 28px; }
    .rh-more .grid > div { min-width: 0; }
    .rh-table td.rh-more, .rh-more .grid th { white-space: normal; }
    .rh-more .grid th { overflow-wrap: anywhere; }
    .rh-more .grid table { table-layout: fixed; }
    .rh-more .grid :is(th, td):first-child { width: 46%; }
    .rh-more .rights { table-layout: auto; }
    .rh-more h4 { font: 600 .875rem var(--sans); margin: 8px 0 2px; }
    .rh-more table { width: 100%; }
    .rh-more :is(th, td) { font-size: 12.5px; text-align: right; }
    .rh-more :is(th, td):first-child { text-align: left; }
    .rh-more .rights :is(th, td):nth-child(-n+3) { text-align: left; }
    .rh-more .none { color: var(--ink-2); font-size: .9rem; margin: 6px 0 0; }
  ` }));

  let MAP = null, POP = null, FOCUS = null;
  const OPEN = new Set();

  G.register({
    id: 'rights_holders', tab: 'ag', order: 31,
    mount(slot) {
      const basin = el('select', { id: 'rh-basin' }, el('option', { value: '', textContent: 'All four basins' }),
        ...BASINS.map(k => el('option', { value: k, textContent: k })));
      const who = el('select', { id: 'rh-who' }, el('option', { value: '', textContent: 'Everyone' }),
        el('option', { value: 'o1', textContent: 'All organizations' }));
      const q = el('input', { type: 'search', id: 'rh-q', placeholder: 'e.g. canal, Kennecott, Smith', autocomplete: 'off' });
      const root = el('section', { className: 'section rh' },
        el('h2', { id: 'rh-h', textContent: 'Who holds the water rights' }),
        el('p', { className: 'lead', id: 'rh-lead', textContent: '—' }),
        el('div', { className: 'rh-controls' }, el('label', { htmlFor: 'rh-basin' }, 'Basin ', basin), el('label', { htmlFor: 'rh-who' }, 'Holders ', who),
          el('label', { htmlFor: 'rh-q' }, 'Find a name ', q)),
        el('h3', { id: 'rh-kh' }),
        el('p', { className: 'note', id: 'rh-knote' }),
        el('div', { className: 'chart rh-chart', id: 'rh-chart' }),
        el('p', { className: 'note', id: 'rh-mapnote' }),
        el('div', { className: 'rh-map', id: 'rh-map' }),
        el('ul', { className: 'rh-legend', ariaLabel: 'Map colours' }, ...USE.map(u => el('li', {}, el('i', { style: `background:${u.color}` }), u.label))),
        el('h3', { id: 'rh-th' }),
        el('div', { id: 'rh-table' }),
        el('h3', { textContent: 'Reading these numbers' }),
        el('ul', { className: 'rh-caveats' },
          el('li', { textContent: 'Amounts are legal ceilings on paper, not metered use. Nobody reports actual diversions for most of these rights.' }),
          el('li', { textContent: 'A right with several owners counts in full under each of them, so holders overlap and do not add up to the basin total. The "Shared" column counts those rights.' }),
          el('li', { textContent: 'The Bureau of Reclamation and the state Board of Water Resources hold reservoir and project rights whose water is delivered through conservancy districts and canal companies, so the same water often appears under a federal or state owner and a local one.' }),
          el('li', { textContent: 'Canal and irrigation companies are owned by their shareholders, mostly farmers; their rights stand for many farms.' }),
          el('li', { textContent: 'Names are as filed with the state, with common spellings folded together (for example "PacifiCorp dba Utah Power & Light" counts as PacifiCorp). Some holders may still be split across spellings.' })),
        el('p', { className: 'src', id: 'rh-src' }));
      root.setAttribute('aria-labelledby', 'rh-h');
      slot.append(root);
      const redraw = () => { FOCUS = null; this.__d && draw(this.__d); };
      basin.addEventListener('change', redraw);
      who.addEventListener('change', redraw);
      let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(redraw, 200); });
      return root;
    },
    render(_, D) {
      const d = this.__d = D?.sources?.water_rights;
      const who = document.getElementById('rh-who');
      if (d?.holder_kinds && who.options.length < 3) who.append(...d.holder_kinds.map((k, i) => el('option', { value: `k${i}`, textContent: k })));
      draw(d);
    },
  });

  function holderRows(d) {
    const basin = document.getElementById('rh-basin').value, who = document.getElementById('rh-who').value;
    const q = document.getElementById('rh-q').value.trim().toUpperCase();
    const m = new Map();
    for (const [owner, org, bs, n, cfs, acft, shared, kind] of d.holders) {
      if (basin && bs !== basin) continue;
      if (who === 'o1' && !org) continue;
      if (who[0] === 'k' && kind !== +who.slice(1)) continue;
      if (q && !owner.includes(q)) continue;
      const r = m.get(owner) || { owner, org, kind, basins: new Set(), n: 0, cfs: 0, acft: 0, shared: 0 };
      r.basins.add(bs); r.n += n; r.cfs += cfs; r.acft += acft; r.shared += shared;
      m.set(owner, r);
    }
    return [...m.values()].sort((x, y) => y.acft - x.acft);
  }

  function draw(d) {
    const lead = document.getElementById('rh-lead');
    if (!d || d.error || !d.holders?.length) {
      lead.textContent = d?.error || 'Water rights holders are not available right now.';
      document.getElementById('rh-table').replaceChildren();
      document.getElementById('rh-map').hidden = true;
      return;
    }
    const basin = document.getElementById('rh-basin').value;
    const place = basin ? `the ${basin} basin` : 'the four basins';
    const rows = holderRows(d);
    const all = holderRows({ ...d, holders: d.holders.filter(r => !basin || r[2] === basin) });
    const top = all.filter(r => r.org).slice(0, 5);
    lead.replaceChildren(`The largest holders of water rights in ${place} are `,
      ...top.flatMap((r, i) => [b(nice(r.owner)), ` (${af(r.acft)} acre-feet a year)`, i < top.length - 2 ? ', ' : i === top.length - 2 ? ' and ' : '']),
      '. Federal and state owners mostly hold reservoir water that local districts deliver, and canal companies hold water for their shareholders, so the farms behind a canal company show up under its name.');

    const T = document.getElementById('rh-table');
    document.getElementById('rh-th').textContent = rows.length ? `Top ${Math.min(rows.length, 100)} holders by volume in ${place}` : 'No holders match';
    T.replaceChildren(el('div', { className: 'tablewrap' }, el('table', { className: 'rh-table' },
      el('caption', { className: 'sr-only', textContent: `Largest water-right holders in ${place}, by acre-feet a year allowed. Owners on a shared right each count it in full.` }),
      el('thead', {}, el('tr', {}, ...['#', 'Holder', 'Kind', 'Rights', 'Shared', 'cfs', 'Acre-feet', 'Map', 'Breakdown'].map(h => el('th', { scope: 'col', textContent: h })))),
      el('tbody', {}, ...rows.slice(0, 100).flatMap((r, i) => {
        const btn = el('button', { type: 'button', textContent: 'Show' });
        btn.setAttribute('aria-pressed', String(FOCUS === r.owner));
        btn.setAttribute('aria-label', `Show ${nice(r.owner)}'s big rights on the map`);
        btn.addEventListener('click', () => { FOCUS = FOCUS === r.owner ? null : r.owner; draw(d); document.getElementById('rh-map').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
        const more = el('button', { type: 'button', textContent: OPEN.has(r.owner) ? 'Hide' : 'Open' });
        const id = `rh-more-${i}`;
        more.setAttribute('aria-expanded', String(OPEN.has(r.owner)));
        more.setAttribute('aria-controls', id);
        more.setAttribute('aria-label', `Breakdown of ${nice(r.owner)}'s rights`);
        const extra = el('tr', { id, hidden: !OPEN.has(r.owner), className: 'detail-row' }, el('td', { className: 'rh-more', colSpan: 9 }));
        more.addEventListener('click', () => {
          const on = !OPEN.has(r.owner);
          on ? OPEN.add(r.owner) : OPEN.delete(r.owner);
          more.setAttribute('aria-expanded', String(on)); more.textContent = on ? 'Hide' : 'Open';
          extra.hidden = !on;
          if (on) breakdown(extra.firstChild, r, d);
        });
        if (OPEN.has(r.owner)) breakdown(extra.firstChild, r, d);
        return [el('tr', {}, el('td', { textContent: i + 1 }), el('th', { scope: 'row', textContent: nice(r.owner) }),
          el('td', { textContent: d.holder_kinds?.[r.kind] ?? (r.org ? 'Organization' : 'Person or trust') }), el('td', { textContent: fmtInt(r.n) }),
          el('td', { textContent: r.shared ? fmtInt(r.shared) : '—' }), el('td', { textContent: ac(r.cfs) }), el('td', { textContent: ac(r.acft) }), el('td', {}, btn), el('td', {}, more)), extra];
      })))));
    drawKinds(d, place);
    drawMap(d, rows);

    const A = d.about;
    cite('rh-src', A.credit, ', ', link('Points of Diversion', A.item_url), ' (', link('feature service', A.layer_url),
      '), owner field as filed. Holder lists cover the top 100 in each basin; look up anyone else in the ', link('Division\'s records', A.lookup_url), '.'
      + (d.pulled_at ? ` Pulled ${d.pulled_at.slice(0, 10)}.` : ''));
  }

  // one holder, a layer down: what its rights are for, where the water comes from, and the rights themselves
  const UNDER = {
    'USA BUREAU OF RECLAMATION': 'Reclamation sells most of this water by contract to conservancy districts and canal companies; those contracts are not in the state\'s water-rights records.',
    'UTAH BOARD OF WATER RESOURCES': 'The Board holds rights for state-funded reservoir projects and passes the water to local districts and companies.',
  };
  async function breakdown(cell, r, d) {
    const basin = document.getElementById('rh-basin').value;
    cell.replaceChildren(el('p', { className: 'none', textContent: 'Loading this holder\'s rights…' }));
    let X;
    try { X = await G.detail('water_rights'); } catch { cell.replaceChildren(el('p', { className: 'none', textContent: 'Could not load the rights list. Try again in a moment.' })); return; }
    const oi = X.owners.indexOf(r.owner);
    const rights = X.rights.filter(x => x[0] === oi && (!basin || x[2] === basin));
    if (!rights.length) { cell.replaceChildren(el('p', { className: 'none', textContent: 'No rights listed for this holder.' })); return; }
    // rows: [owner, wrnum, basin, uses, kind, source, cfs, acft, priority, owners on the right]
    const tot = rights.reduce((t, x) => t + x[7], 0), cfs = rights.reduce((t, x) => t + x[6], 0);
    const shared = rights.filter(x => x[9] > 1), own = rights.reduce((t, x) => t + x[7] / x[9], 0);
    const years = rights.map(x => x[8]).filter(y => y && y >= '1840').sort();
    const group = (key) => { const m = new Map(); for (const x of rights) for (const k of [].concat(key(x))) { const g = m.get(k) || [0, 0, 0]; g[0]++; g[1] += x[6]; g[2] += x[7]; m.set(k, g); } return [...m].sort((a, c) => c[1][2] - a[1][2]); };
    const share = (v) => tot ? `${Math.round(100 * v / tot)}%` : '—';
    const mini = (title, cap, head, rows) => el('div', {}, el('h4', { textContent: title }),
      el('table', {}, el('caption', { className: 'sr-only', textContent: cap }), el('thead', {}, el('tr', {}, ...head.map(h => el('th', { scope: 'col', textContent: h })))),
        el('tbody', {}, ...rows.map(c => el('tr', {}, el('th', { scope: 'row', textContent: c[0] }), ...c.slice(1).map(v => el('td', { textContent: v })))))));
    const uses = group(x => x[3] ? x[3].split('').map(u => d.uses[u] || u) : ['Not listed']);
    const srcs = group(x => x[5] || 'Not listed');
    const kinds = group(x => /Underground|Well/.test(x[4] || '') ? 'Wells' : ['Surface', 'Point to Point', 'Point of Return', 'Rediversion', 'Drain'].includes(x[4]) ? 'Rivers, streams and drains' : x[4] || 'Other');
    const who = nice(r.owner);
    cell.replaceChildren(
      el('p', { className: 'sum' }, b(who), ` holds ${fmtInt(rights.length)} rights${basin ? ` in the ${basin} basin` : ''}, allowing up to `, b(`${ac(tot)} acre-feet a year`),
        ` (${ac(cfs)} cfs)` + (years.length ? `, with priority dates from ${years[0]} to ${years.at(-1)}` : '') + '. '
        + (shared.length ? `${fmtInt(shared.length)} of them are shared with other owners; split evenly, its part is about ${ac(own)} acre-feet. ` : '')
        + (UNDER[r.owner] || (/CANAL|IRRIG|DITCH|WATER USERS|WATER COMPANY|DISTRIBUTING|RESERVOIR COMPANY/.test(r.owner)
          ? 'Who owns shares in the company, and so which farms get this water, is the company\'s own record and not public.' : ''))),
      el('div', { className: 'grid' },
        mini('What it is for', `${who}'s rights by use. A right with several uses counts under each.`, ['Use', 'Rights', 'Acre-feet', 'Share'],
          uses.map(([k, g]) => [k, fmtInt(g[0]), ac(g[2]), share(g[2])])),
        mini('Rivers or wells', `${who}'s rights by kind of source.`, ['Kind', 'Rights', 'Acre-feet', 'Share'],
          kinds.map(([k, g]) => [k, fmtInt(g[0]), ac(g[2]), share(g[2])])),
        mini(srcs.length > 8 ? 'Largest named sources' : 'Named sources', `${who}'s rights by named source, largest ${Math.min(8, srcs.length)}.`, ['Source', 'Rights', 'Acre-feet', 'Share'],
          srcs.slice(0, 8).map(([k, g]) => [k, fmtInt(g[0]), ac(g[2]), share(g[2])]))),
      el('h4', { textContent: `Rights, largest first` }),
      el('div', { className: 'tablewrap' }, el('table', { className: 'rights' }, el('caption', { className: 'sr-only', textContent: `${who}'s water rights, largest first.` }),
        el('thead', {}, el('tr', {}, ...['Right', 'Source', 'Uses', 'Priority', 'cfs', 'Acre-feet', 'Owners'].map(h => el('th', { scope: 'col', textContent: h })))),
        el('tbody', {}, ...rights.map(x => el('tr', {}, el('th', { scope: 'row' }, link(x[1], RIGHT(x[1]))), el('td', { textContent: x[5] || '—' }),
          el('td', { textContent: x[3] ? x[3].split('').map(u => d.uses[u] || u).join(', ') : '—' }), el('td', { textContent: x[8] || '—' }),
          el('td', { textContent: ac(x[6]) }), el('td', { textContent: ac(x[7]) }), el('td', { textContent: x[9] > 1 ? `shared (${x[9]})` : 'sole' })))))));
  }

  // acre-feet by holder type; click a bar to list that type's holders
  function drawKinds(d, place) {
    if (!d.by_holder_kind) return;
    const basin = document.getElementById('rh-basin').value, who = document.getElementById('rh-who').value;
    const K = d.holder_kinds, t = K.map(() => [0, 0, 0]);
    for (const [bs, k, h, n, , acft] of d.by_holder_kind) if (!basin || bs === basin) { t[k][0] += h; t[k][1] += n; t[k][2] += acft; }
    const total = t.reduce((x, r) => x + r[2], 0);
    const order = K.map((k, i) => i).filter(i => t[i][2] > 0).sort((x, y) => t[y][2] - t[x][2]);
    const pct = (v) => `${(100 * v / total).toFixed(v / total < .01 ? 1 : 0)}%`;
    document.getElementById('rh-kh').textContent = `Who holds the water in ${place}, by kind of holder`;
    document.getElementById('rh-knote').textContent = 'Acre-feet a year allowed, with each shared right split evenly among its owners so the bars add up to the basin total. '
      + 'Click a bar (or use the Holders menu) to list that kind of holder below.';
    const ink = css('--ink'), ink2 = css('--ink-2'), paper = css('--paper');
    const sel = who[0] === 'k' ? +who.slice(1) : null;
    const o = G.base();
    o.aria.decal = { show: false };
    o.aria.label = { enabled: true, description: `Bar chart of water rights by kind of holder in ${place}, ${af(total)} acre-feet a year in all. `
      + order.map(i => `${K[i]}: ${af(t[i][2])} acre-feet, ${pct(t[i][2])}, ${fmtInt(t[i][0])} holders.`).join(' ') };
    o.grid = { left: 8, right: 120, top: 8, bottom: 8, containLabel: true };
    o.xAxis = { type: 'value', show: false };
    o.yAxis = { type: 'category', inverse: true, data: order.map(i => K[i]), axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: ink, fontSize: 13, width: 230, overflow: 'break' } };
    o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => { const r = t[order[p.dataIndex]];
      return `<b>${K[order[p.dataIndex]]}</b><br>${ac(r[2])} acre-feet a year (${pct(r[2])})<br>${fmtInt(r[0])} holders · ${fmtInt(r[1])} rights`; } };
    o.series = [{ type: 'bar', barMaxWidth: 22, cursor: 'pointer',
      data: order.map(i => ({ value: Math.round(t[i][2]), itemStyle: { color: sel == null || sel === i ? css('--hydro') : css('--off') } })),
      label: { show: true, position: 'right', color: ink2, fontSize: 12, formatter: (p) => `${af(p.value)} · ${pct(p.value)}` },
      itemStyle: { borderColor: paper, borderWidth: 0.5 } }];
    const ch = G.chart('rh-chart');
    ch.setOption(o, true);
    ch.off('click');
    ch.on('click', (p) => {
      const sel2 = document.getElementById('rh-who'), v = `k${order[p.dataIndex]}`;
      sel2.value = sel2.value === v ? '' : v;
      sel2.dispatchEvent(new Event('change'));
    });
  }

  function drawMap(d, rows) {
    const holder = document.getElementById('rh-map');
    const basin = document.getElementById('rh-basin').value;
    const F = d.big_floor || { acft: 1000, cfs: 10 };
    const shown = FOCUS ? new Set([FOCUS]) : new Set(rows.map(r => r.owner));
    const filtered = document.getElementById('rh-who').value || document.getElementById('rh-q').value.trim();
    const pick = (r) => (!basin || r[1] === basin) && (!FOCUS && !filtered || r[6].split(' | ').some(o => shown.has(o)));
    const feats = d.points.filter(p => pick(d.big[p[2]])).map(([lon, lat, i]) => {
      const r = d.big[i], u = useOf(r[2]);
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { i, acft: r[4], color: u.color } };
    });
    const nRights = new Set(feats.map(f => f.properties.i)).size;
    document.getElementById('rh-mapnote').textContent = `${fmtInt(nRights)} rights of at least ${fmtInt(F.acft)} acre-feet a year or ${F.cfs} cfs`
      + (FOCUS ? ` held by ${nice(FOCUS)}` : '') + `, one dot per place each can divert (${fmtInt(feats.length)} dots). Bigger dots are bigger rights. `
      + 'Click a dot for its owners. The table below lists the same holders for screen readers and keyboards.';
    if (!window.maplibregl) { holder.hidden = true; return; }
    const data = { type: 'FeatureCollection', features: feats.sort((a, c) => c.properties.acft - a.properties.acft) };
    const fit = () => {
      if (!feats.length) return;
      // 2nd-98th percentile so a few far-off or mistyped points don't zoom the map out
      const q = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
      const xs = feats.map(f => f.geometry.coordinates[0]), ys = feats.map(f => f.geometry.coordinates[1]);
      const lo = feats.length > 20 ? .02 : 0, hi = feats.length > 20 ? .98 : .9999;
      MAP.fitBounds([[q(xs, lo), q(ys, lo)], [q(xs, hi), q(ys, hi)]], { padding: 30, maxZoom: 11, duration: 0 });
    };
    if (!MAP) {
      MAP = new maplibregl.Map({ container: holder, center: [-111.9, 41], zoom: 7, maxZoom: 14, minZoom: 5, dragRotate: false, pitchWithRotate: false,
        cooperativeGestures: true, attributionControl: { compact: false },
        style: { version: 8, sources: {
          s2: { type: 'raster', tileSize: 256, tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'],
            attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless 2024 by EOX</a> (Contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0' },
          places: { type: 'raster', tileSize: 256, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
            attribution: 'Place names: Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community' } },
          layers: [{ id: 's2', type: 'raster', source: 's2', paint: { 'raster-brightness-max': .7 } }, { id: 'places', type: 'raster', source: 'places', paint: { 'raster-opacity': .85 } }] } });
      MAP.touchZoomRotate.disableRotation();
      MAP.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      MAP.getCanvas().setAttribute('aria-label', 'Satellite map of the largest water rights, coloured by use. The holders are listed in the table after the map.');
      MAP.on('click', 'rights', (e) => {
        const r = d.big[e.features[0].properties.i];
        const owners = r[6].split(' | ');
        POP?.remove();
        POP = new maplibregl.Popup({ offset: 8, maxWidth: '320px' }).setLngLat(e.features[0].geometry.coordinates).setDOMContent(el('div', { className: 'rh-pop' },
          el('b', {}, link(`Right ${r[0]}`, RIGHT(r[0]))), el('br'), `${ac(r[4])} ac-ft a year · ${ac(r[3])} cfs`, el('br'),
          `${useOf(r[2]).label}${r[5] ? ` · priority ${r[5]}` : ''}`, el('br'),
          `${owners.length > 1 ? 'Owners' : 'Owner'}: ${owners.slice(0, 6).map(nice).join('; ')}${owners.length > 6 ? `; and ${owners.length - 6} more` : ''}`)).addTo(MAP);
      });
      MAP.on('mouseenter', 'rights', () => { MAP.getCanvas().style.cursor = 'pointer'; });
      MAP.on('mouseleave', 'rights', () => { MAP.getCanvas().style.cursor = ''; });
    }
    const apply = () => {
      if (MAP.getSource('rights')) MAP.getSource('rights').setData(data);
      else {
        MAP.addSource('rights', { type: 'geojson', data });
        MAP.addLayer({ id: 'rights', type: 'circle', source: 'rights', paint: {
          'circle-radius': ['interpolate', ['linear'], ['sqrt', ['get', 'acft']], 30, 3, 100, 6, 300, 13, 600, 20],
          'circle-color': ['get', 'color'], 'circle-opacity': .85, 'circle-stroke-color': '#0c100f', 'circle-stroke-width': 1 } });
      }
      fit();
    };
    MAP.loaded() ? apply() : MAP.once('load', apply);
  }
})();
