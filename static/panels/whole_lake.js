// The whole lake: north arm vs south arm across the railroad causeway, flow through the breach, and the bay outflows.
// Data from sources/whole_lake.py (DATA.sources.whole_lake for the window, HIST.sources.whole_lake for the long record).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, css, fmtInt, fmt1 } = G;
  const USGS = (id) => `https://waterdata.usgs.gov/monitoring-location/${id}/`;
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const f2 = (v) => v == null ? '—' : nf2.format(v);
  const signed = (v, fmt = f2) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(Math.abs(v))}`;
  const at = (s) => s ? G.fmtDay(G.parseHour(s)) + (s.length > 10 && !s.endsWith('T00:00') ? ' ' + G.parseHour(s).toLocaleTimeString('en-US', { hour: 'numeric' }) : '') : '';
  const T = (s) => G.parseHour(s);
  const srcLinks = (sites) => sites.flatMap((s, i) => [i ? '; ' : '', link(`${s.site_id} ${s.name}`, USGS(s.site_id))]);

  document.head.append(el('style', { textContent: `
    .wl-lead { font-size: 1rem; margin: 0 0 12px; }
    .wl-lead b { font-family: var(--mono); font-weight: 600; }
    .wl-chart { width: 100%; height: 470px; }
    .wl-hist-chart { width: 100%; height: 500px; }
    .wl-key { display: flex; flex-wrap: wrap; gap: 6px 18px; list-style: none; padding: 0; margin: 0 0 8px; font-size: .875rem; color: var(--ink-2); }
    .wl-key i { display: inline-block; width: 22px; height: 0; margin-right: 6px; vertical-align: middle; border-top-width: 2.5px; }
    .wl-read { margin-top: 14px; }
    .wl-read caption { text-align: left; font: 600 .95rem var(--sans); color: var(--ink); padding: 0 0 6px; }
    .wl-read th[scope="row"] { text-align: left; font: inherit; color: var(--ink); white-space: normal; }
    .wl-read td, .wl-read th { font-size: 13px; }
    .wl-read small { display: block; color: var(--ink-2); font: 12px var(--sans); white-space: normal; text-align: left; }
    .wl-prof { margin-top: 10px; font-size: .9rem; color: var(--ink-2); }
    .wl-prof summary { cursor: pointer; color: var(--ink); min-height: 24px; }
    .wl-prof td, .wl-prof th { font-size: 13px; }
    .wl-notes { font-size: .875rem; color: var(--ink-2); margin: 8px 0 0; padding-left: 1.2em; }
  ` }));

  // line styles carry the meaning as well as color (solid / dashed / dotted), echoed in a text key
  const STY = {
    north: { color: () => css('--pen'), type: 'solid', label: 'North arm' },
    south: { color: () => css('--hydro'), type: 'dashed', label: 'South arm' },
    head: { color: () => css('--ink'), type: 'solid', label: 'South minus north' },
    upper: { color: () => css('--healthy'), type: 'solid', label: 'Breach, upper layer' },
    lower: { color: () => css('--weber'), type: 'dashed', label: 'Breach, lower layer' },
    lakeside: { color: () => css('--ink'), type: 'dotted', label: 'Lakeside breach (cfs)' },
    head_cw: { color: () => css('--pen'), type: 'dotted', label: 'South minus north at the causeway' },
  };
  const keyItem = (k, text) => el('li', {}, el('i', { style: `border-top-style:${STY[k].type};border-top-color:${STY[k].color()}` }), text || STY[k].label);
  const line = (name, sty, data, xi, yi, unit, fmt) => ({
    name, type: 'line', xAxisIndex: xi, yAxisIndex: yi, showSymbol: false, connectNulls: false,
    lineStyle: { width: sty.type === 'solid' ? 2 : 2.2, color: sty.color(), type: sty.type }, itemStyle: { color: sty.color() },
    tooltip: { valueFormatter: (v) => v == null ? '—' : `${fmt(v)} ${unit}` }, data,
  });

  // ------------------------------------------------------------ Details: this window
  G.register({
    id: 'whole_lake', tab: 'details', order: 15,
    mount(slot) {
      const root = el('section', { className: 'section', id: 'wl' },
        el('h2', { id: 'wl-h', textContent: 'The whole lake: north arm, bays and the causeway' }),
        el('p', { className: 'note', textContent: 'A solid railroad causeway, built in 1959, cuts the Great Salt Lake in two. Almost all river water enters the south arm, so the north arm '
          + 'gets fresh water only through openings in the causeway. With no rivers of its own it stays much saltier (pink, near saturation) and usually sits lower. '
          + 'Water flows north through the breach because the south arm is higher; heavy north-arm brine can slide back south underneath. '
          + 'Inside the south arm, causeways also wall off Bear River Bay and Farmington Bay, which drain to the main lake under bridges. '
          + 'The lake gauge on the rest of this page (Saltair) shows the south arm only.' }),
        el('p', { className: 'wl-lead', id: 'wl-lead', textContent: '—' }),
        el('ul', { className: 'wl-key', id: 'wl-key' }),
        el('div', { className: 'wl-chart', id: 'wl-chart' }),
        el('div', { id: 'wl-read' }),
        el('ul', { className: 'wl-notes', id: 'wl-notes' }),
        el('p', { className: 'src', id: 'wl-src' }));
      root.setAttribute('aria-labelledby', 'wl-h');
      root.querySelector('#wl-key').setAttribute('aria-hidden', 'true');
      slot.append(root);
      return root;
    },
    render(d) {
      const lead = document.getElementById('wl-lead'), read = document.getElementById('wl-read');
      const notes = document.getElementById('wl-notes'), key = document.getElementById('wl-key');
      if (!d || d.error || !d.levels) {
        lead.textContent = d?.error || 'Whole-lake gauge readings are not available right now.';
        lead.classList.toggle('err', !!d?.error);
        read.replaceChildren(); notes.replaceChildren(); key.replaceChildren();
        G.emptyChart('wl-chart', 'No readings.');
        G.cite('wl-src', 'USGS NWIS, Great Salt Lake gauges.');
        return;
      }
      lead.classList.remove('err');
      const L = d.levels, H = L.head_ft, BB = d.breach_bridge, LK = d.breach_lakeside, F = d.farmington;
      const hourly = d.resolution === 'hourly';

      // ---- plain-language summary
      const parts = [];
      if (H) {
        const side = H.mean > 0.05 ? 'higher' : H.mean < -0.05 ? 'lower' : null;
        parts.push('Over these dates the south arm averaged ', b(`${f2(Math.abs(H.mean))} ft`), side ? ` ${side} than the north arm` : ', about level with the north arm',
          ` (${L.south.name.toLowerCase()} ${f2(L.south.mean)} ft vs ${L.north.name.toLowerCase()} ${f2(L.north.mean)} ft). `);
        if (H.change != null) parts.push('The difference ', H.change > 0.05 ? 'grew' : H.change < -0.05 ? 'shrank' : 'held steady', ` by ${f2(Math.abs(H.change))} ft to `, b(`${f2(H.end)} ft`), ' on the last day. ');
      } else parts.push('No overlapping north and south arm readings for these dates. ');
      if (BB?.available) {
        parts.push('At the causeway bridge breach, water near the surface moved ', b(BB.upper_direction === 'none' ? 'hardly at all' : BB.upper_direction),
          ' and deeper water moved ', b(BB.lower_direction === 'none' ? 'hardly at all' : BB.lower_direction),
          BB.two_way ? '. That is two-way flow: fresher water heading north over salty brine heading south. ' : '. ');
      }
      if (F?.flow) parts.push('Farmington Bay sent ', b(`${fmtInt(F.flow.net_af)} acre-ft`), ' to the main lake. ');
      lead.replaceChildren(...parts);

      // ---- chart: levels on top, breach below
      const S = d.series, t = S.t.map(T);
      const pts = (k) => S[k].map((v, i) => [t[i], v]);
      const hasLk = S.lakeside_cfs.some(v => v != null && v !== 0);
      const hasVel = S.bridge_upper_fps.some(v => v != null) || S.bridge_lower_fps.some(v => v != null);
      key.replaceChildren(keyItem('north', `${L.north.name} (solid)`), keyItem('south', `${L.south.name} (dashed)`),
        ...(hasVel ? [keyItem('upper', `Bridge breach above ~${fmt1(BB.split_elev_ft)} ft (solid)`), keyItem('lower', `below ~${fmt1(BB.split_elev_ft)} ft (dashed)`)] : []),
        ...(hasLk ? [keyItem('lakeside', 'Lakeside breach, cfs (dotted)')] : []));
      const o = G.base();
      const ink2 = css('--ink-2'), rule = css('--rule'), gridc = css('--grid-major');
      const lower = hasVel || hasLk;
      o.grid = lower ? [{ left: 12, right: hasLk ? 12 : 16, top: 28, height: 200, containLabel: true }, { left: 12, right: hasLk ? 12 : 16, top: 286, height: 140, containLabel: true }]
        : [{ left: 12, right: 16, top: 28, bottom: 28, containLabel: true }];
      const xa = (i) => ({ type: 'time', gridIndex: i, axisLine: { lineStyle: { color: rule } }, splitLine: { show: false },
        axisLabel: { color: ink2, hideOverlap: true, fontSize: 12, show: !lower || i === 1 }, axisTick: { show: !lower || i === 1 } });
      const ya = (i, name, fmt, extra = {}) => ({ type: 'value', gridIndex: i, name, nameLocation: 'end', nameTextStyle: { color: ink2, align: 'left', fontSize: 12 },
        axisLabel: { color: ink2, fontSize: 12, formatter: fmt }, splitLine: { lineStyle: { color: gridc } }, ...extra });
      o.xAxis = lower ? [xa(0), xa(1)] : [xa(0)];
      o.yAxis = [ya(0, 'Lake level, ft', (v) => fmt1(v), { scale: true })];
      o.series = [line(L.north.name, STY.north, pts('north_ft'), 0, 0, 'ft', f2), line(L.south.name, STY.south, pts('south_ft'), 0, 0, 'ft', f2)];
      if (hasVel) {
        o.yAxis.push(ya(1, 'Breach velocity, ft/s (+ north)', (v) => fmt1(v)));
        o.series.push(line(`Bridge breach, above ~${fmt1(BB.split_elev_ft)} ft`, STY.upper, pts('bridge_upper_fps'), 1, 1, 'ft/s', f2),
          line(`Bridge breach, below ~${fmt1(BB.split_elev_ft)} ft`, STY.lower, pts('bridge_lower_fps'), 1, 1, 'ft/s', f2));
        o.series[o.series.length - 2].markLine = { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: ink2, width: 1 }, data: [{ yAxis: 0 }] };
      }
      if (hasLk) {
        o.yAxis.push(ya(1, 'Lakeside cfs', (v) => fmtInt(v), { position: 'right', splitLine: { show: false }, nameTextStyle: { color: ink2, align: 'right', fontSize: 12 } }));
        o.series.push(line('Lakeside breach', STY.lakeside, pts('lakeside_cfs'), 1, o.yAxis.length - 1, 'cfs', fmtInt));
      } else if (!hasVel) o.grid[0].bottom = 28;
      o.tooltip = { ...o.tooltip, axisPointer: { type: 'line', link: [{ xAxisIndex: 'all' }], lineStyle: { color: ink2 } } };
      o.dataZoom = [{ type: 'inside', xAxisIndex: lower ? [0, 1] : [0] }];
      o.aria.label = { enabled: true, description:
        `Great Salt Lake north and south arm levels${hourly ? ', hourly' : S.step === 'week' ? ', weekly averages' : ', daily'}, ${d.series.t[0]?.slice(0, 10)} to ${d.series.t[t.length - 1]?.slice(0, 10)}. `
        + `${L.north.name}: ${f2(L.north.min)} to ${f2(L.north.max)} ft, averaging ${f2(L.north.mean)}. ${L.south.name}: ${f2(L.south.min)} to ${f2(L.south.max)} ft, averaging ${f2(L.south.mean)}. `
        + (H ? `South minus north averages ${f2(H.mean)} ft. ` : '')
        + (hasVel ? `Lower panel: water velocity through the causeway bridge breach, positive northward. Above about ${fmt1(BB.split_elev_ft)} ft it averages ${f2(BB.upper_fps)} ft per second; below, ${f2(BB.lower_fps)}. ` : '')
        + (hasLk ? `Lakeside breach discharge averages ${fmt1(LK.mean)} cubic feet per second. ` : '')
        + 'A table of the latest readings follows the chart.' };
      if (!t.length) G.emptyChart('wl-chart', 'No readings for this period.');
      else G.chart('wl-chart').setOption(o, true);

      // ---- readout table (the text version of the chart, plus the bays)
      const row = (name, sub, latest, change, over) => el('tr', {},
        el('th', { scope: 'row' }, name, sub ? el('small', { textContent: sub }) : ''),
        el('td', { textContent: latest }), el('td', { textContent: change }), el('td', { textContent: over }));
      const lv = (x) => x?.latest == null ? ['—', '—', '—'] : [`${f2(x.latest)} ft`, `${signed(x.change)} ft`, `avg ${f2(x.mean)} ft`];
      const rows = [
        row(L.north.name, `USGS ${L.north.site_id}${L.north.latest_at ? ' · ' + at(L.north.latest_at) : ''}`, ...lv(L.north)),
        row(L.south.name, `USGS ${L.south.site_id}${L.south.latest_at ? ' · ' + at(L.south.latest_at) : ''}`, ...lv(L.south)),
        ...(L.north_saline ? [row(L.north_saline.name, `USGS ${L.north_saline.site_id}, out in the north arm`, ...lv(L.north_saline))] : []),
        row('South minus north (head across the causeway)', `Positive: south arm higher, so water is pushed north. Gauges read to ${L.resolution_ft} ft.`,
          H ? `${signed(H.latest)} ft` : '—', H ? `${signed(H.change)} ft` : '—', H ? `avg ${signed(H.mean)} ft` : '—'),
      ];
      if (LK) rows.push(row('Lakeside breach (west end)', `USGS ${LK.site_id} · discharge, positive = south to north · ${LK.readings} of ${LK.expected} ${hourly ? 'hours' : 'days'} reported`,
        `${fmtInt(LK.latest)} cfs`, `${signed(LK.change, fmtInt)} cfs`,
        LK.north_af || LK.south_af ? `${fmtInt(LK.north_af)} acre-ft north, ${fmtInt(LK.south_af)} south` : 'no flow (0 cfs)'));
      if (BB?.available) {
        rows.push(row(`Bridge breach, above ~${fmt1(BB.split_elev_ft)} ft`, `USGS ${BB.site_id} · velocity, positive = north; USGS publishes no discharge here`,
          '—', '—', `avg ${signed(BB.upper_fps)} ft/s (${BB.upper_direction === 'none' ? 'still' : BB.upper_direction})`));
        rows.push(row(`Bridge breach, below ~${fmt1(BB.split_elev_ft)} ft`, `Layers split ${BB.split_is}`,
          '—', '—', `avg ${signed(BB.lower_fps)} ft/s (${BB.lower_direction === 'none' ? 'still' : BB.lower_direction})`));
      } else if (BB?.why) rows.push(row('Bridge breach', `USGS ${BB.site_id}`, '—', '—', BB.why));
      if (F?.flow) rows.push(row('Farmington Bay outflow to the main lake', `USGS ${F.site_id} · ${F.flow.values || ''} discharge${F.flow.hours_reversed ? ` · ran back into the bay for ${fmtInt(F.flow.hours_reversed)} hours` : ''}`,
        `${fmtInt(F.flow.latest)} cfs`, `${signed(F.flow.change, fmtInt)} cfs`, `${fmtInt(F.flow.net_af)} acre-ft (avg ${fmtInt(F.flow.mean)} cfs)`));
      else rows.push(row('Farmington Bay outflow', `USGS ${F.site_id}`, '—', '—', 'no readings'));
      if (F?.conductance_us_cm) rows.push(row('Farmington Bay outflow, specific conductance', 'Saltiness: higher = saltier (seawater is about 50,000 µS/cm). The only continuous salinity reading on the lake.',
        `${fmtInt(F.conductance_us_cm.latest)} µS/cm`, `${signed(F.conductance_us_cm.change, fmtInt)} µS/cm`, `avg ${fmtInt(F.conductance_us_cm.mean)} µS/cm`));
      if (F?.water_temp_c) rows.push(row('Farmington Bay outflow, water temperature', '', `${fmt1(F.water_temp_c.latest)} °C`, `${signed(F.water_temp_c.change, fmt1)} °C`, `avg ${fmt1(F.water_temp_c.mean)} °C`));
      for (const B of d.bear || []) {
        if (B.flow) rows.push(row(B.name, `USGS ${B.site_id} · ${B.flow.values} discharge`, `${fmtInt(B.flow.latest)} cfs`, `${signed(B.flow.change, fmtInt)} cfs`, `${fmtInt(B.flow.net_af)} acre-ft`));
        else if (B.velocity_fps) rows.push(row(B.name, `USGS ${B.site_id} · water velocity, positive = toward the main lake (assumed). ${B.why_no_flow}`,
          `${f2(B.velocity_fps.latest)} ft/s`, `${signed(B.velocity_fps.change)} ft/s`, `avg ${f2(B.velocity_fps.mean)} ft/s`));
        else rows.push(row(B.name, `USGS ${B.site_id}`, '—', '—', 'no readings'));
      }
      const tbl = el('div', { className: 'tablewrap' }, el('table', { className: 'wl-read' },
        el('caption', { textContent: `Readings for ${d.series.t[0]?.slice(0, 10) || 'this period'} to ${d.series.t[t.length - 1]?.slice(0, 10) || ''}: change is the last day against the day before (levels) or the first day (flows)` }),
        el('thead', {}, el('tr', {}, ...['Gauge', 'Latest', 'Change', 'Over the period'].map(s => el('th', { scope: 'col', textContent: s })))),
        el('tbody', {}, ...rows)));
      const prof = BB?.available ? el('details', { className: 'wl-prof' },
        el('summary', { textContent: `Bridge breach velocity by depth (${BB.cells} profiler cells)` }),
        el('div', { className: 'tablewrap' }, el('table', {},
          el('caption', { textContent: 'Average velocity over the period at each cell elevation; positive = moving north. Cells marked "partly" were out of the water much of the time and are left out of the layer averages.' }),
          el('thead', {}, el('tr', {}, ...['Cell elevation (ft)', 'Average (ft/s)', 'Direction', 'Readings'].map(s => el('th', { scope: 'col', textContent: s })))),
          el('tbody', {}, ...BB.profile.map(p => el('tr', {},
            el('td', { textContent: fmt1(p.elev_ft) }), el('td', { textContent: signed(p.mean_fps) }),
            el('td', { textContent: p.mean_fps >= 0.05 ? 'north' : p.mean_fps <= -0.05 ? 'south' : 'still' }),
            el('td', { textContent: `${p.readings}${p.used ? '' : ' (partly)'}` }))))))) : '';
      read.replaceChildren(tbl, prof);

      notes.replaceChildren(...[...(d.notes || []), d.salinity_note,
        'Bear River Bay has no published discharge today, so its outflow can only be shown as water speed, not acre-feet.',
        ...(BB?.note ? [BB.note] : [])].filter(Boolean).map(s => el('li', { textContent: s })));
      G.cite('wl-src', 'USGS NWIS instantaneous and daily values, gauges ', ...srcLinks(d.sites), '. Provisional readings may be revised.');
    },
  });

  // ------------------------------------------------------------ History: north vs south since 1966
  G.register({
    id: 'whole_lake_history', tab: 'history', order: 15,
    mount(slot) {
      const root = el('section', { className: 'section', id: 'wl-hist' },
        el('h2', { id: 'wl-hist-h', textContent: 'North arm vs south arm since 1966' }),
        el('p', { className: 'note', id: 'wl-hist-note' }),
        el('ul', { className: 'wl-key', id: 'wl-hist-key' }),
        el('div', { className: 'wl-hist-chart', id: 'wl-hist-chart' }),
        el('p', { className: 'src', id: 'wl-hist-src' }));
      root.setAttribute('aria-labelledby', 'wl-hist-h');
      root.querySelector('#wl-hist-key').setAttribute('aria-hidden', 'true');
      slot.append(root);
      return root;
    },
    renderHistory(_own, HIST) {
      const h = HIST?.sources?.whole_lake;
      const note = document.getElementById('wl-hist-note');
      if (!h || h.error || !h.weekly?.wk?.length) {
        note.textContent = h?.error || 'North and south arm records are not available right now.';
        G.emptyChart('wl-hist-chart', 'No readings.');
        G.cite('wl-hist-src', 'USGS NWIS daily values.');
        return;
      }
      const W = h.weekly, Sm = h.summary, t = W.wk.map(G.parseDay);
      const yr = (s) => s.slice(0, 4);
      note.replaceChildren('Weekly averages. Top: the south arm (Saltair) and the north arm (near Saline). Bottom: how much higher the south arm sits, which is the push that drives water north through the causeway. ',
        'The biggest gap was ', b(`${f2(Sm.max_head.ft)} ft`), ` (week of ${G.fmtDay(G.parseDay(Sm.max_head.wk), true)}); `,
        'the latest week shows ', b(`${f2(Sm.latest_head.ft)} ft`), '. ',
        'A dotted line shows the same difference measured on both sides of the causeway itself, from 2018. Drag the slider to zoom.');
      document.getElementById('wl-hist-key').replaceChildren(keyItem('south', 'South arm, Saltair (dashed)'), keyItem('north', 'North arm, near Saline (solid)'),
        keyItem('head', 'South minus north (solid)'), keyItem('head_cw', 'South minus north at the causeway, 2018 on (dotted)'));
      const ink2 = css('--ink-2'), rule = css('--rule'), gridc = css('--grid-major');
      const o = G.base();
      const gb = { left: 12, right: 16, containLabel: true };
      o.grid = [{ ...gb, top: 28, height: 230 }, { ...gb, top: 300, height: 120 }];
      const xa = (i) => ({ type: 'time', gridIndex: i, axisLine: { lineStyle: { color: rule } }, splitLine: { show: false },
        axisLabel: { color: ink2, hideOverlap: true, fontSize: 12, show: i === 1 }, axisTick: { show: i === 1 } });
      const ya = (i, name, extra = {}) => ({ type: 'value', gridIndex: i, name, nameLocation: 'end', nameTextStyle: { color: ink2, align: 'left', fontSize: 12 },
        axisLabel: { color: ink2, fontSize: 12, formatter: (v) => i ? fmt1(v) : fmtInt(v) }, splitLine: { lineStyle: { color: gridc } }, ...extra });
      o.xAxis = [xa(0), xa(1)];
      o.yAxis = [ya(0, 'Lake level, ft', { scale: true }), ya(1, 'South minus north, ft')];
      const p = (k) => W[k].map((v, i) => [t[i], v]);
      o.series = [
        line('South arm (Saltair)', STY.south, p('south_ft'), 0, 0, 'ft', f2),
        line('North arm (Saline)', STY.north, p('north_ft'), 0, 0, 'ft', f2),
        { ...line('South minus north', STY.head, p('head_ft'), 1, 1, 'ft', f2),
          markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: ink2, width: 1 }, data: [{ yAxis: 0 }] } },
        line('South minus north, at the causeway', STY.head_cw, p('head_cw_ft'), 1, 1, 'ft', f2),
      ];
      o.series.forEach(s => { s.lineStyle.width = 1.5; });
      o.tooltip = { ...o.tooltip, axisPointer: { type: 'line', link: [{ xAxisIndex: 'all' }], lineStyle: { color: ink2 } } };
      o.dataZoom = [{ type: 'inside', xAxisIndex: [0, 1] }, { type: 'slider', xAxisIndex: [0, 1], height: 28, bottom: 8, borderColor: rule, textStyle: { color: ink2, fontSize: 12 },
        fillerColor: 'rgba(127,127,127,.18)', dataBackground: { lineStyle: { color: ink2 }, areaStyle: { color: css('--grid') } }, labelFormatter: (v) => new Date(v).getFullYear() }];
      const ok = (k) => W[k].filter(v => v != null);
      o.aria.label = { enabled: true, description: `Great Salt Lake south arm (Saltair) and north arm (near Saline) levels, weekly, ${yr(Sm.start)} to ${yr(Sm.end)}. `
        + `South arm from ${f2(Math.min(...ok('south_ft')))} to ${f2(Math.max(...ok('south_ft')))} ft; north arm from ${f2(Math.min(...ok('north_ft')))} to ${f2(Math.max(...ok('north_ft')))} ft. `
        + `Lower panel: south minus north, from ${f2(Sm.min_head.ft)} ft (week of ${Sm.min_head.wk}) to ${f2(Sm.max_head.ft)} ft (week of ${Sm.max_head.wk}); latest ${f2(Sm.latest_head.ft)} ft.` };
      G.chart('wl-hist-chart').setOption(o, true);
      G.cite('wl-hist-src', 'USGS NWIS daily values, gauges ', ...srcLinks(h.sites), '. Levels in feet above NGVD 1929.');
    },
  });
})();
