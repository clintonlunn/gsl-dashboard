// Storage in the reservoirs upstream of Great Salt Lake: water held back from the lake.
// Data from sources/reservoirs.py (DATA.sources.reservoirs, HIST.sources.reservoirs).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt, parseDay, fmtDay, addDays } = G;
  const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html';
  const WR = 'https://www.waterrights.utah.gov/dvrtdb/daily-chart.asp';
  const LIHI = 'https://lowimpacthydro.org/wp-content/uploads/2020/09/Cutler-Questionnaire.pdf';
  const SYS_COLOR = { bear: '--bear', weber: '--weber', jordan: '--jordan', import: '--off' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const af = (v) => `${fmtInt(v)} acre-ft`;
  const big = (v) => Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)} million acre-ft` : af(v);
  const roundAf = (v) => Math.abs(v) >= 10000 ? Math.round(v / 1000) * 1000 : Math.abs(v) >= 1000 ? Math.round(v / 100) * 100 : Math.round(v);
  const signed = (v) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtInt(Math.abs(v))}`;
  const pct = (v) => v == null ? '—' : `${Math.round(v)}%`;
  const day = (s) => fmtDay(parseDay(s));
  const span = (a, c) => a === c ? day(a) : `${day(a)}–${day(c)}`;
  const UNITS = 'An acre-foot is a foot of water over an acre, about 326,000 gallons.';
  const srcParts = (extra) => [
    link('NRCS Air and Water Database', AWDB), ' (reservoir storage, element RESC, reported by the Bureau of Reclamation and operators); ',
    link('Utah Division of Water Rights', WR), ' river commissioner records for Bear Lake (station 9460), Cutler (9410) and Porcupine (11297); Cutler capacity from ',
    link("PacifiCorp's 1994 FERC license summary", LIHI), extra || '', '.',
  ];

  document.head.append(el('style', { textContent: `
    .res-list { list-style: none; margin: 0 0 4px; padding: 0; display: grid; gap: 6px; }
    .res-list li { display: grid; gap: 1px; }
    .res-name { display: flex; align-items: center; gap: 6px; font-size: .9rem; color: var(--ink); }
    .res-name .res-bar { margin-left: auto; flex: none; }
    .res-nums { font: 13px var(--mono); color: var(--ink-2); padding-left: 16px; }
    .res-list li.res-total { border-top: 1px solid var(--rule); padding-top: 6px; }
    .res-list li.res-total .res-name { font-weight: 600; }
    .res-list li.res-total .res-nums { color: var(--ink); }
    .res-list li.res-import .res-name { color: var(--ink-2); }
    .res-full { display: inline-flex; align-items: center; gap: 6px; justify-content: flex-end; }
    .res-bar { display: inline-block; width: 64px; height: 8px; border: 1px solid var(--ink-2); position: relative; }
    .res-bar > span { position: absolute; left: 0; top: 0; bottom: 0; }
    .res-key { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; }
    .res-table th, .res-table td { font-size: 13px; padding: 4px 8px; white-space: nowrap; }
    .res-table td { font-family: var(--mono); }
    .res-table td:not(:first-child):not(:nth-child(2)):not(:last-child) { text-align: right; }
    .res-table tbody tr.res-sys-head th { text-align: left; padding-top: 10px; font-weight: 600; color: var(--ink); border-bottom: 1px solid var(--grid-major); }
    .res-notes { font-size: 13px; color: var(--ink-2); margin: 8px 0 0; padding-left: 1.4em; }
    .res-chart { width: 100%; height: 420px; }
    .res-hist details { margin-top: 10px; font-size: .9rem; color: var(--ink-2); }
    .res-hist summary { cursor: pointer; color: var(--ink); min-height: 24px; }
    .res-hist td:not(:first-child), .res-hist th:not(:first-child) { text-align: right; }
  ` }));

  const key = (sys) => { const k = el('span', { className: 'res-key', style: `background:var(${SYS_COLOR[sys]})` }); k.setAttribute('aria-hidden', 'true'); return k; };
  const fullCell = (p, sys) => {
    const bar = el('span', { className: 'res-bar' }, el('span', { style: `width:${Math.min(100, p ?? 0)}%;background:var(${SYS_COLOR[sys] || '--ink-2'})` }));
    bar.setAttribute('aria-hidden', 'true');
    return el('td', {}, el('span', { className: 'res-full' }, bar, pct(p)));
  };

  // ------------------------------------------------------------ At a glance
  G.register({
    id: 'reservoirs', tab: 'glance', order: 45,
    mount(slot) {
      const root = el('div', { className: 'fact', id: 'res-fact' },
        el('h2', { textContent: 'Water held in reservoirs', id: 'res-h' }),
        el('p', { className: 'lead', id: 'res-lead', textContent: '—' }),
        el('div', { id: 'res-vis' }),
        el('p', { className: 'src', id: 'res-note' }),
        el('p', { className: 'src', id: 'res-src' }));
      root.setAttribute('aria-labelledby', 'res-h');
      slot.append(root);
      return root;
    },
    render(d) {
      const lead = document.getElementById('res-lead'), vis = document.getElementById('res-vis'), note = document.getElementById('res-note');
      if (!d || d.error || !d.total) {
        lead.textContent = d?.error || 'Reservoir storage is not available for these dates.';
        lead.classList.toggle('err', !!d?.error);
        vis.replaceChildren(); note.textContent = '';
        cite('res-src', ...srcParts());
        return;
      }
      lead.classList.remove('err');
      const T = d.total, through = T.through || T.oldest;
      const asOf = parseDay(through);
      const usual = T.pct_of_median == null ? '' : Math.abs(T.pct_of_median - 100) < 5 ? ', about usual for the date'
        : `, ${T.pct_of_median}% of usual for ${MONTHS[asOf.getMonth()]} ${asOf.getDate()}`;
      const parts = ['Reservoirs upstream of the lake hold ', b(big(roundAf(T.storage_af))), ', ', b(`${Math.round(T.pct_full)}% full`), `${usual}. `];
      const winFrom = parseDay(d.window.from);
      if (T.change_af == null || T.change_n === 0) {
        parts.push(`There are no new reservoir readings for these dates yet; the latest are from ${day(through)}.`);
      } else {
        const when = `Between ${fmtDay(addDays(winFrom, -1))} and ${day(through)}`;
        const c = roundAf(T.change_af);
        if (Math.abs(T.change_af) < 500) parts.push(`${when} their storage held about steady.`);
        else if (c > 0) parts.push(`${when} they gained `, b(af(c)), ". That water didn't flow on to the lake.");
        else parts.push(`${when} they let out `, b(af(-c)), ' more than flowed in; most released water goes to farms and cities, and only some of it reaches the lake.');
      }
      lead.replaceChildren(...parts);

      const S = d.systems || [];
      // one compact row per river system: name and fill bar, then the numbers in words (narrow column, so no table)
      const item = (s, cls) => {
        const bar = el('span', { className: 'res-bar' }, el('span', { style: `width:${Math.min(100, s.pct_full ?? 0)}%;background:var(${SYS_COLOR[s.system] || '--ink'})` }));
        bar.setAttribute('aria-hidden', 'true');
        const bits = [`${big(roundAf(s.storage_af))}`, `${pct(s.pct_full)} full`];
        if (s.pct_of_median != null) bits.push(`${s.pct_of_median}% of usual`);
        if (s.change_af != null) bits.push(`${signed(roundAf(s.change_af))} acre-ft`);
        return el('li', { className: cls || '' },
          el('span', { className: 'res-name' }, s.system ? key(s.system) : '', s.label, bar),
          el('span', { className: 'res-nums', textContent: bits.join(' · ') }));
      };
      const counted = S.filter(s => s.in_total), other = S.filter(s => !s.in_total);
      const tbl = el('ul', { className: 'res-list' }, ...counted.map(s => item(s)), item({ label: 'All held from the lake', ...T }, 'res-total'),
        ...other.map(s => item({ ...s, label: `${s.label}, not counted` }, 'res-import')));
      tbl.setAttribute('aria-label', `Storage by river system, latest readings through ${day(through)}`);
      vis.replaceChildren(tbl);

      const lag = T.oldest && T.oldest !== through ? ` Most readings run through ${day(through)}; the slowest reservoirs report through ${day(T.oldest)}.` : '';
      const monthly = (d.reservoirs || []).filter(r => r.freq === 'monthly' && r.storage_af != null);
      note.textContent = `${UNITS} "Full" compares storage with each reservoir's capacity. "Of usual" compares it with the middle value for the same date in up to ${d.past_years} earlier years. `
        + `"Change" (+ filling, − drawing down) adds up reservoirs with daily readings over your dates.${lag}`
        + (monthly.length ? ` ${monthly.map(r => r.name).join(', ')} report only at month's end, so they count in storage but not in change.` : '')
        + ' Strawberry Reservoir is in the Colorado River basin; the water it sends through mountain tunnels reaches Utah Lake, so it is shown but not counted as held from the Great Salt Lake.';
      cite('res-src', ...srcParts());
    },
  });

  // ------------------------------------------------------------ Details: every reservoir
  G.register({
    id: 'reservoirs_table', tab: 'details', order: 45,
    mount(slot) {
      const root = el('section', { className: 'section res-detail', id: 'res-detail' },
        el('h2', { id: 'res-detail-h', textContent: 'Each reservoir upstream of the lake' }),
        el('p', { className: 'note', id: 'res-detail-note' }),
        el('div', { id: 'res-detail-table' }),
        el('ol', { className: 'res-notes', id: 'res-detail-fn' }),
        el('p', { className: 'src', id: 'res-detail-src' }));
      root.setAttribute('aria-labelledby', 'res-detail-h');
      slot.append(root);
      return root;
    },
    render(_, D) {
      const d = D?.sources?.reservoirs;
      const note = document.getElementById('res-detail-note'), wrap = document.getElementById('res-detail-table'), fn = document.getElementById('res-detail-fn');
      if (!d || d.error || !d.reservoirs) {
        note.textContent = d?.error || 'Reservoir storage is not available right now.';
        wrap.replaceChildren(); fn.replaceChildren(); cite('res-detail-src', ...srcParts());
        return;
      }
      note.textContent = `Storage at the latest reading on or before ${day(d.window.to)}, in acre-feet. ${UNITS} Change runs from the last reading before ${day(d.window.from)} to that latest reading `
        + `(+ filling, so less water flowing on toward the lake; − drawing down). Usual is the middle value for the same date in earlier years (number of years shown). Reservoirs reading "month end" report only once a month.`;
      const notes = [];
      const sysOrder = (d.systems || []).map(s => s.system);
      const labels = Object.fromEntries((d.systems || []).map(s => [s.system, s.label]));
      const cols = ['Reservoir', 'As of', 'Stored', 'Capacity', 'Full', 'Change', 'Usual', 'Data source'];
      const body = el('tbody');
      for (const sys of sysOrder) {
        body.append(el('tr', { className: 'res-sys-head' }, el('th', { scope: 'colgroup', colSpan: cols.length }, key(sys), labels[sys])));
        for (const r of d.reservoirs.filter(x => x.system === sys)) {
          let mark = '';
          if (r.note) { notes.push(`${r.name}: ${r.note}`); mark = el('sup', { textContent: String(notes.length) }); }
          const has = r.storage_af != null;
          body.append(el('tr', {},
            el('th', { scope: 'row', style: 'text-align:left;font:13px var(--sans);color:var(--ink)' }, r.name, mark),
            el('td', { textContent: has ? `${day(r.as_of)}${r.freq === 'monthly' ? ' (month end)' : ''}` : 'no recent data' }),
            el('td', { textContent: has ? fmtInt(r.storage_af) : '—' }),
            el('td', { textContent: r.capacity_af ? fmtInt(r.capacity_af) : '—' }),
            has ? fullCell(r.pct_full, sys) : el('td', { textContent: '—' }),
            el('td', { textContent: r.change_af == null ? '—' : `${signed(r.change_af)}${r.change_from && r.as_of ? ` (${span(r.change_from, r.as_of)})` : ''}` }),
            el('td', { textContent: r.median_af == null ? '—' : `${fmtInt(r.median_af)} (${r.median_years} yr)` }),
            el('td', {}, link(r.src === 'NRCS AWDB' ? `NRCS ${r.station || ''}`.trim() : `Water Rights ${r.station}`, r.link))));
        }
      }
      wrap.replaceChildren(el('div', { className: 'tablewrap' }, el('table', { className: 'res-table' },
        el('caption', { className: 'sr-only', textContent: 'Storage, capacity, change over the chosen dates and usual storage for each reservoir, in acre-feet, grouped by river system' }),
        el('thead', {}, el('tr', {}, ...cols.map(t => el('th', { scope: 'col', textContent: t })))), body)));
      fn.replaceChildren(...notes.map(t => el('li', { textContent: t })));
      cite('res-detail-src', ...srcParts('. Each source link opens that reservoir\'s record'));
    },
  });

  // ------------------------------------------------------------ History: month-end storage by river system
  G.register({
    id: 'reservoirs_hist', tab: 'history', order: 58,
    mount(slot) {
      const root = el('section', { className: 'section res-hist', id: 'res-hist' },
        el('h2', { id: 'res-hist-h', textContent: 'Water held in upstream reservoirs, month by month' }),
        el('p', { className: 'note', id: 'res-hist-note' }),
        el('div', { className: 'res-chart', id: 'res-hist-chart' }),
        el('div', { id: 'res-hist-table' }),
        el('p', { className: 'src', id: 'res-hist-src' }));
      root.setAttribute('aria-labelledby', 'res-hist-h');
      slot.append(root);
      return root;
    },
    renderHistory(_, H) {
      const h = H?.sources?.reservoirs;
      const note = document.getElementById('res-hist-note');
      if (!h || h.error || !h.months?.length) {
        note.textContent = h?.error || 'Reservoir history is not available right now.';
        G.emptyChart('res-hist-chart', 'No reservoir history.');
        cite('res-hist-src', ...srcParts());
        return;
      }
      const t = h.months.map(m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0); }); // month end
      const counted = h.systems.filter(s => s.in_total), other = h.systems.filter(s => !s.in_total);
      const total = h.months.map((_, i) => counted.reduce((a, s) => a + (s.af[i] ?? 0), 0));
      const cap = counted.reduce((a, s) => a + s.capacity_af, 0);
      const last = h.months.length - 1;
      const iMax = total.indexOf(Math.max(...total)), iMin = total.indexOf(Math.min(...total));
      const mName = (i) => { const d = t[i]; return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
      note.textContent = `Storage at the end of each month in the reservoirs of each river system, stacked so the top edge is the total held back from the Great Salt Lake (combined capacity about ${(cap / 1e6).toFixed(1)} million acre-ft). `
        + `Reservoirs fill with spring snowmelt and drain through summer as water goes to farms and cities. The dashed line is Strawberry Reservoir, which stores Colorado River basin water and isn't in the stack. ${UNITS} Drag the slider to zoom.`;

      const ink = css('--ink'), ink2 = css('--ink-2'), rule = css('--rule');
      const o = G.base();
      o.aria.label = { enabled: true, description: `Stacked area chart of month-end reservoir storage by river system, ${mName(0)} to ${mName(last)}. `
        + `The total held from the lake peaked at ${big(roundAf(total[iMax]))} in ${mName(iMax)} and was lowest at ${big(roundAf(total[iMin]))} in ${mName(iMin)}; at the end of ${mName(last)} it was ${big(roundAf(total[last]))}, `
        + `${Math.round(100 * total[last] / cap)}% of capacity. ${counted.map(s => `${s.label}: ${big(roundAf(s.af[last] ?? 0))}`).join('; ')}. Strawberry Reservoir, shown separately: ${big(roundAf(other[0]?.af[last] ?? 0))}. A table of September-end values follows the chart.` };
      o.aria.decal = { show: true };
      o.grid = { left: 12, right: 16, top: 86, bottom: 64, containLabel: true };
      o.legend = { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, itemWidth: 22, itemHeight: 10 };
      o.yAxis = { ...o.yAxis, name: 'million acre-ft', nameGap: 12, nameTextStyle: { color: ink2, align: 'left', fontSize: 12 },
        axisLabel: { color: ink2, fontSize: 12, formatter: (v) => (v / 1e6).toFixed(1) } };
      o.xAxis = { ...o.xAxis, axisLabel: { color: ink2, hideOverlap: true, fontSize: 12 } };
      o.tooltip = { ...o.tooltip, trigger: 'axis', formatter: (ps) => {
        const i = ps[0]?.dataIndex; if (i == null) return '';
        return [`End of ${mName(i)}`, ...counted.map(s => `${s.label}: <b>${s.af[i] == null ? '—' : fmtInt(s.af[i])}</b>`),
          `Held from the lake: <b>${fmtInt(total[i])}</b> acre-ft (${Math.round(100 * total[i] / cap)}% full)`,
          ...other.map(s => `${s.label}: <b>${s.af[i] == null ? '—' : fmtInt(s.af[i])}</b>`)].join('<br>');
      } };
      const decals = [{ symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 5], rotation: Math.PI / 4 },
        { symbol: 'circle', symbolSize: 0.5, dashArrayX: [[6, 6], [0, 6, 6, 0]], dashArrayY: [6, 0] },
        { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 5], rotation: -Math.PI / 4 }];
      o.series = [
        ...counted.map((s, i) => ({ name: s.label, type: 'line', stack: 'held', showSymbol: false, sampling: 'lttb',
          lineStyle: { width: 1, color: css(SYS_COLOR[s.system]) }, itemStyle: { color: css(SYS_COLOR[s.system]), decal: { ...decals[i % 3], color: 'rgba(0,0,0,.22)' } },
          areaStyle: { color: css(SYS_COLOR[s.system]), opacity: 0.75 }, data: s.af.map((v, j) => [t[j], v]) })),
        ...other.map(s => ({ name: `${s.label}, not stacked`, type: 'line', showSymbol: false, lineStyle: { width: 2, type: 'dashed', color: ink2 }, itemStyle: { color: ink2 },
          data: s.af.map((v, j) => [t[j], v]) })),
      ];
      const start = t[Math.max(0, t.length - 240)];
      o.dataZoom = [{ type: 'inside', startValue: start },
        { type: 'slider', height: 28, bottom: 8, startValue: start, borderColor: rule, textStyle: { color: ink2, fontSize: 12 },
          fillerColor: 'rgba(127,127,127,.18)', labelFormatter: (v) => new Date(v).getFullYear() }];
      G.chart('res-hist-chart').setOption(o, true);

      // end of each September (end of the irrigation season and water year) as a real table
      const sept = h.months.map((m, i) => [m, i]).filter(([m]) => m.endsWith('-09')).reverse();
      document.getElementById('res-hist-table').replaceChildren(el('details', {},
        el('summary', { textContent: `Storage at the end of each September, ${sept[sept.length - 1]?.[0].slice(0, 4)}–${sept[0]?.[0].slice(0, 4)}, in acre-feet` }),
        el('div', { className: 'tablewrap' }, el('table', {},
          el('caption', { textContent: 'September is the end of the water year and of the irrigation season, when reservoirs are usually lowest.' }),
          el('thead', {}, el('tr', {}, ...['Year', ...counted.map(s => s.label), 'Held from the lake', '% full', ...other.map(s => s.label)].map(x => el('th', { scope: 'col', textContent: x })))),
          el('tbody', {}, ...sept.map(([m, i]) => el('tr', {},
            el('td', { textContent: m.slice(0, 4) }),
            ...counted.map(s => el('td', { textContent: s.af[i] == null ? '—' : fmtInt(s.af[i]) })),
            el('td', { textContent: fmtInt(total[i]) }), el('td', { textContent: pct(100 * total[i] / cap) }),
            ...other.map(s => el('td', { textContent: s.af[i] == null ? '—' : fmtInt(s.af[i]) })))))))));
      const partial = counted.filter(s => s.n.some(n => n < s.reservoirs));
      cite('res-hist-src', ...srcParts(`; NRCS month-end values, Cutler from its last daily reading each month`
        + (partial.length ? `. Early years leave out reservoirs whose records start later (${partial.map(s => s.label).join(', ')})` : '')));
    },
  });
})();
