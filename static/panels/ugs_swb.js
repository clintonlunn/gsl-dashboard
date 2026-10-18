// Utah Geological Survey Soil Water Balance (Modified Utah Basin Model): how wet the ground is, and the basin's
// monthly water balance since 2005. Data from sources/ugs_swb.py (DATA.sources.ugs_swb, HIST.sources.ugs_swb).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt, fmt1 } = G;
  // addresses follow sources/_ugs.py via DATA.config.ugs; defaults are today's hosts
  const ugsURL = (k, d) => (window.GSL?.ugs || {})[k] || d;
  let STAC = 'https://ubm-assets.geology.utah.gov/stac/catalog.json';
  let UGS = 'https://geology.utah.gov/';
  const syncUGS = () => { STAC = ugsURL('swb_stac', 'https://ubm-assets.geology.utah.gov/stac') + '/catalog.json'; UGS = ugsURL('home', 'https://geology.utah.gov') + '/'; };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthOf = (iso) => { const [y, m] = iso.split('-').map(Number); return { y, m, name: MONTHS[m - 1], date: new Date(y, m - 1, 1) }; };
  const pct = (v) => `${Math.round(v)}%`;
  const srcParts = (extra) => (syncUGS(), [
    'Utah Geological Survey, ', link('Soil Water Balance (Modified Utah Basin Model) STAC catalog', STAC), ' (',
    link('geology.utah.gov', UGS), ')', extra || '', '. License listed as proprietary: figures are summarized here; the raw files are not redistributed.',
  ]);

  // panel-only styles; colors are the page's CSS tokens so light and dark both work
  document.head.append(el('style', { textContent: `
    .ugs-swb-bars { display: grid; gap: 10px; margin: 0 0 4px; font: 13px var(--mono); color: var(--ink-2); }
    .ugs-swb-row { display: grid; grid-template-columns: 7.5rem 1fr; gap: 10px; align-items: center; }
    .ugs-swb-track { position: relative; height: 20px; border-left: 1px solid var(--rule); }
    .ugs-swb-fill { position: absolute; left: 0; top: 3px; height: 14px; }
    .ugs-swb-fill.now { background: var(--hydro); }
    .ugs-swb-fill.usual { background: repeating-linear-gradient(45deg, var(--off) 0 2px, transparent 2px 5px); border: 1.5px solid var(--off); box-sizing: border-box; }
    .ugs-swb-range { position: absolute; top: 9px; height: 0; border-top: 2px solid var(--ink); }
    .ugs-swb-range::before, .ugs-swb-range::after { content: ''; position: absolute; top: -6px; height: 10px; border-left: 2px solid var(--ink); }
    .ugs-swb-range::before { left: 0; } .ugs-swb-range::after { right: 0; }
    .ugs-swb-val { position: absolute; top: 1px; font-size: 12px; color: var(--ink-2); white-space: nowrap; }
    .ugs-swb-scale { display: flex; justify-content: space-between; margin-left: calc(7.5rem + 10px); font-size: 12px; }
    .ugs-swb-subs { margin-top: 12px; }
    .ugs-swb-subs th, .ugs-swb-subs td { font-size: 13px; padding: 4px 8px; }
    .ugs-swb-subs td:not(:first-child), .ugs-swb-subs th:not(:first-child) { text-align: right; }
    .ugs-swb-chart { width: 100%; height: 590px; }
    .ugs-swb-hist details { margin-top: 10px; font-size: .9rem; color: var(--ink-2); }
    .ugs-swb-hist summary { cursor: pointer; color: var(--ink); min-height: 24px; }
    .ugs-swb-hist td:not(:first-child), .ugs-swb-hist th:not(:first-child) { text-align: right; }
  ` }));

  // ------------------------------------------------------------ At a glance: how wet the ground is
  G.register({
    id: 'ugs_swb', tab: 'glance', order: 40,
    mount(slot) {
      const root = el('div', { className: 'fact', id: 'ugs-swb-fact' },
        el('h2', { textContent: 'How wet the ground is', id: 'ugs-swb-h' }),
        el('p', { className: 'lead', id: 'ugs-swb-lead', textContent: '—' }),
        el('div', { id: 'ugs-swb-vis' }),
        el('p', { className: 'src', id: 'ugs-swb-note' }),
        el('p', { className: 'src', id: 'ugs-swb-src' }));
      root.setAttribute('aria-labelledby', 'ugs-swb-h');
      slot.append(root);
      return root;
    },
    render(d) {
      const lead = document.getElementById('ugs-swb-lead'), vis = document.getElementById('ugs-swb-vis');
      const note = document.getElementById('ugs-swb-note');
      if (!d || d.error || !d.basin) {
        lead.textContent = d?.error || 'Soil moisture model results are not available right now.';
        lead.classList.toggle('err', !!d?.error);
        vis.replaceChildren(); note.textContent = '';
        cite('ugs-swb-src', ...srcParts());
        return;
      }
      lead.classList.remove('err');
      const B = d.basin, m = monthOf(B.month);
      const diff = B.soil_sat_pct - B.usual_pct;
      const rel = Math.abs(diff) < 1.5 ? 'close to' : diff < 0 ? 'below' : 'above';
      const why = rel === 'below' ? 'Dry ground soaks up rain and snowmelt before it can reach rivers and the lake.'
        : rel === 'above' ? 'Wet ground lets more rain and snowmelt run off to rivers and the lake.'
        : 'Rain and snowmelt should reach rivers about as usual.';
      const rank = B.years_drier === 0 ? ` That's the driest ${m.name} in the model record, which starts in 2005.`
        : B.years_drier === B.years_compared ? ` That's the wettest ${m.name} in the model record, which starts in 2005.` : '';
      lead.replaceChildren('Soils across the Great Salt Lake basin were ', b(pct(B.soil_sat_pct)), ` saturated at the end of ${m.name} ${m.y}, ${rel} the usual `,
        b(pct(B.usual_pct)), ` for ${m.name}. ${why}${rank}`);

      // now vs usual, with the spread across model runs on the "now" bar
      const max = Math.min(100, Math.max(10, Math.ceil((Math.max(B.ens_max_pct ?? 0, B.soil_sat_pct, B.usual_pct) * 1.35) / 10) * 10));
      const x = (v) => `${(v / max) * 100}%`;
      const row = (label, cls, v, range) => el('div', { className: 'ugs-swb-row' },
        el('span', {}, `${label} `, el('b', { textContent: pct(v), style: 'color:var(--ink)' })),
        el('div', { className: 'ugs-swb-track' },
          el('span', { className: `ugs-swb-fill ${cls}`, style: `width:${x(v)}` }),
          ...(range ? [el('span', { className: 'ugs-swb-range', style: `left:${x(range[0])};width:${x(range[1] - range[0])}` }),
            el('span', { className: 'ugs-swb-val', style: `left:calc(${x(range[1])} + 6px)`, textContent: `runs ${pct(range[0])}–${pct(range[1])}` })] : [])));
      const hasRange = B.ens_min_pct != null && B.ens_max_pct != null;
      const bars = el('div', { className: 'ugs-swb-bars' },
        row(`${m.name.slice(0, 3)} ${m.y}`, 'now', B.soil_sat_pct, hasRange ? [B.ens_min_pct, B.ens_max_pct] : null),
        row(`Usual ${m.name.slice(0, 3)}`, 'usual', B.usual_pct));
      bars.setAttribute('role', 'img');
      // on narrow screens the range label can run past the track; drop it below the range instead (to its left it hit the value)
      requestAnimationFrame(() => bars.querySelectorAll('.ugs-swb-val').forEach(v => {
        // measured only when shown; a hidden tab reports 0 widths, so phones always take the lower spot
        const track = v.parentElement.getBoundingClientRect();
        if (hasRange && (matchMedia('(max-width: 599px)').matches || v.getBoundingClientRect().right > track.right)) {
          v.style.left = `${(B.ens_min_pct / max) * 100}%`; v.style.top = '18px';
          v.parentElement.style.marginBottom = '18px';
        }
      }));
      bars.setAttribute('aria-label', `Bar chart: soil ${pct(B.soil_sat_pct)} saturated at the end of ${m.name} ${m.y} (solid bar), versus a usual ${pct(B.usual_pct)} (striped bar, the middle value of ${B.years_compared} other years).`
        + (hasRange ? ` The ${B.members} model runs range from ${pct(B.ens_min_pct)} to ${pct(B.ens_max_pct)}.` : ''));
      const scale = el('div', { className: 'ugs-swb-scale' }, el('span', { textContent: '0%' }), el('span', { textContent: `${max}% saturated` }));
      scale.setAttribute('aria-hidden', 'true');

      const trend = (s) => {
        const [sym, words] = s.soil_sat_pct < s.usual_pct - 1.5 ? ['▼', 'below usual'] : s.soil_sat_pct > s.usual_pct + 1.5 ? ['▲', 'above usual'] : ['≈', 'close to usual'];
        const i = el('span', { textContent: sym }); i.setAttribute('aria-hidden', 'true');
        return el('span', {}, i, el('span', { className: 'sr-only', textContent: words }));
      };
      const subs = (d.sub_basins || []).filter(s => s.soil_sat_pct != null);
      const tbl = subs.length ? el('div', { className: 'tablewrap' }, el('table', { className: 'ugs-swb-subs' },
        el('caption', { textContent: `Each river basin, end of ${m.name} ${m.y}` }),
        el('thead', {}, el('tr', {}, ...['Basin', 'Now', 'Usual', 'Model range'].map(t => el('th', { scope: 'col', textContent: t })))),
        el('tbody', {}, ...subs.map(s => el('tr', {},
          el('th', { scope: 'row', textContent: s.label, style: 'text-align:left;font:inherit;color:var(--ink)' }),
          el('td', {}, `${pct(s.soil_sat_pct)} `, trend(s)),
          el('td', { textContent: pct(s.usual_pct) }),
          el('td', { textContent: s.ens_min_pct == null ? '—' : `${pct(s.ens_min_pct)}–${pct(s.ens_max_pct)}` })))))) : '';
      vis.replaceChildren(bars, scale, tbl);

      const lag = d.months?.month?.length ? '' : ` Model results run about a month behind: the latest is ${m.name} ${m.y}, so it doesn't cover the dates you picked.`;
      note.textContent = `"Saturated" means how full the soil is compared with the most water it can hold (100%). The line on the top bar spans the lowest and highest of ${B.members} model runs that use different rain and plant-water-use estimates; the bar is their average. "Usual" is the middle value for ${m.name} in ${B.years_compared} other years since 2005. ▼ below usual, ▲ above, ≈ close.${lag}`;
      cite('ugs-swb-src', ...srcParts(`, zonal statistics through ${MONTHS[monthOf(d.data_through).m - 1]} ${monthOf(d.data_through).y}`));
    },
  });

  // ------------------------------------------------------------ History: basin water balance since 2005
  G.register({
    id: 'ugs_swb', tab: 'history', order: 60,
    mount(slot) {
      const root = el('section', { className: 'section ugs-swb-hist', id: 'ugs-swb-hist' },
        el('h2', { id: 'ugs-swb-hist-h', textContent: 'Basin water balance since 2005' }),
        el('p', { className: 'note', id: 'ugs-swb-hist-note' }),
        el('div', { className: 'ugs-swb-chart', id: 'ugs-swb-hist-chart' }),
        el('div', { id: 'ugs-swb-hist-table' }),
        el('p', { className: 'src', id: 'ugs-swb-hist-src' }));
      root.setAttribute('aria-labelledby', 'ugs-swb-hist-h');
      slot.append(root);
      return root;
    },
    renderHistory(h) {
      const note = document.getElementById('ugs-swb-hist-note');
      if (!h || h.error || !h.monthly?.month?.length) {
        note.textContent = h?.error || 'Soil water balance results are not available right now.';
        G.emptyChart('ugs-swb-hist-chart', 'No model results.');
        cite('ugs-swb-hist-src', ...srcParts());
        return;
      }
      const M = h.monthly, t = M.month.map(s => monthOf(s).date);
      note.textContent = `Monthly totals for the Great Salt Lake basin from the state's soil water model, in millimeters of water spread evenly over the basin `
        + `(about ${fmtInt(h.area_km2)} km²; 1 mm over the whole basin is about ${fmtInt(h.af_per_mm)} acre-feet). `
        + `Top: rain and snowmelt soaking in, and evapotranspiration (water plants use and the ground gives back to the air). `
        + `Middle: runoff, water that flows off toward streams, and recharge, water that sinks below the roots toward groundwater. `
        + `Bottom: how full the soil is at the end of each month (100% = as wet as it can hold). Shaded bands show the lowest to highest of the model runs. Drag the slider to zoom.`;

      const ink = css('--ink'), ink2 = css('--ink-2'), rule = css('--rule'), gridc = css('--grid-major');
      const C = { precip: css('--hydro'), aet: css('--pen'), runoff: css('--weber'), recharge: css('--healthy'), sat: css('--ink') };
      const o = G.base();
      const last = M.month.length - 1, lm = monthOf(M.month[last]);
      const mean = (a) => a.reduce((s, v) => s + (v ?? 0), 0) / a.length;
      const satMin = Math.min(...M.soil_sat), satMax = Math.max(...M.soil_sat);
      o.aria.label = { enabled: true, description: `Monthly water balance of the Great Salt Lake basin, ${M.month[0]} to ${M.month[last]}, from the Utah Geological Survey soil water model (ensemble average). `
        + `Rain and snowmelt input averages ${fmt1(mean(M.precip))} mm a month and evapotranspiration ${fmt1(mean(M.aet))} mm; runoff averages ${fmt1(mean(M.runoff))} mm and recharge ${fmt1(mean(M.recharge))} mm. `
        + `Soil saturation ranges from ${pct(satMin)} to ${pct(satMax)}; at the end of ${lm.name} ${lm.y} it was ${pct(M.soil_sat[last])}. A table of yearly totals follows the chart.` };
      o.aria.decal = { show: false };
      o.legend = { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, itemWidth: 22, itemHeight: 10,
        data: ['Rain + snowmelt in', 'Evapotranspiration', 'Runoff', 'Recharge', 'Soil saturation', 'Range across model runs'] };
      const gridBase = { left: 12, right: 16, containLabel: true };
      o.grid = [{ ...gridBase, top: 56, height: 150 }, { ...gridBase, top: 250, height: 120 }, { ...gridBase, top: 414, height: 110 }];
      const xa = (i) => ({ type: 'time', gridIndex: i, axisLine: { lineStyle: { color: rule } }, splitLine: { show: false },
        axisLabel: { color: ink2, hideOverlap: true, show: i === 2, fontSize: 12 }, axisTick: { show: i === 2 } });
      o.xAxis = [xa(0), xa(1), xa(2)];
      const ya = (i, name, fmt) => ({ type: 'value', gridIndex: i, name, nameLocation: 'end', nameTextStyle: { color: ink2, align: 'left', fontSize: 12 },
        axisLabel: { color: ink2, fontSize: 12, formatter: fmt }, splitLine: { lineStyle: { color: gridc } } });
      o.yAxis = [ya(0, 'mm per month', (v) => fmtInt(v)), ya(1, 'mm per month', (v) => fmtInt(v)), ya(2, '% saturated', (v) => `${v}%`)];
      o.yAxis[2].max = 100; o.yAxis[2].min = 0;
      o.tooltip = { ...o.tooltip, trigger: 'axis', axisPointer: { type: 'line', link: [{ xAxisIndex: 'all' }], lineStyle: { color: ink2 } },
        formatter: (ps) => {
          const i = ps[0]?.dataIndex; if (i == null) return '';
          const m = monthOf(M.month[i]);
          const r = (lbl, k, u) => `${lbl}: <b>${M[k][i] == null ? '—' : fmt1(M[k][i])}${u}</b> <span style="opacity:.75">(${fmt1(M[k + '_lo'][i])}–${fmt1(M[k + '_hi'][i])})</span>`;
          return [`${m.name} ${m.y} · ${M.members[i]} model runs`, r('Rain + snowmelt in', 'precip', ' mm'), r('Evapotranspiration', 'aet', ' mm'),
            r('Runoff', 'runoff', ' mm'), r('Recharge', 'recharge', ' mm'), r('Soil saturation', 'soil_sat', '%'), '<span style="opacity:.75">(lowest–highest model run)</span>'].join('<br>');
        } };
      const pts = (k) => M[k].map((v, i) => [t[i], v]);
      const line = (name, k, color, type, i, width = 1.6) => ({ name, type: 'line', xAxisIndex: i, yAxisIndex: i, showSymbol: false, z: 3,
        lineStyle: { width, color, type }, itemStyle: { color }, data: pts(k) });
      // band = invisible lower edge + stacked (hi - lo) area, hatched so it isn't color-only
      const band = (k, i, color) => [
        { name: `_${k}_lo`, type: 'line', xAxisIndex: i, yAxisIndex: i, stack: `band-${k}`, symbol: 'none', silent: true, lineStyle: { opacity: 0 }, tooltip: { show: false },
          data: M[k + '_lo'].map((v, j) => [t[j], v]) },
        { name: 'Range across model runs', type: 'line', xAxisIndex: i, yAxisIndex: i, stack: `band-${k}`, symbol: 'none', silent: true, lineStyle: { opacity: 0 }, itemStyle: { color: gridc, decal: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: Math.PI / 4, color: ink2 } },
          areaStyle: { color, opacity: 0.45 },
          tooltip: { show: false }, data: M[k + '_hi'].map((v, j) => [t[j], v == null || M[k + '_lo'][j] == null ? null : v - M[k + '_lo'][j]]) },
      ];
      o.series = [
        ...band('aet', 0, gridc), ...band('soil_sat', 2, gridc),
        line('Rain + snowmelt in', 'precip', C.precip, 'solid', 0),
        line('Evapotranspiration', 'aet', C.aet, 'dashed', 0),
        line('Runoff', 'runoff', C.runoff, 'solid', 1),
        line('Recharge', 'recharge', C.recharge, 'dashed', 1),
        line('Soil saturation', 'soil_sat', C.sat, 'solid', 2, 1.8),
      ];
      const startIdx = Math.max(0, M.month.length - 120);
      o.dataZoom = [{ type: 'inside', xAxisIndex: [0, 1, 2], startValue: t[startIdx] },
        { type: 'slider', xAxisIndex: [0, 1, 2], height: 28, bottom: 8, startValue: t[startIdx], borderColor: rule, textStyle: { color: ink2, fontSize: 12 },
          fillerColor: 'rgba(127,127,127,.18)', dataBackground: { lineStyle: { color: ink2 }, areaStyle: { color: css('--grid') } },
          labelFormatter: (v) => new Date(v).getFullYear() }];
      G.chart('ugs-swb-hist-chart').setOption(o, true);

      // yearly totals as a real table: the text version of the chart, in acre-feet
      const A = h.annual || [];
      const maf = (v) => (v / 1e6).toFixed(2);
      document.getElementById('ugs-swb-hist-table').replaceChildren(A.length ? el('details', {},
        el('summary', { textContent: `Basin totals by water year (October–September), ${A[0].water_year}–${A[A.length - 1].water_year}, in million acre-feet` }),
        el('div', { className: 'tablewrap' }, el('table', {},
          el('caption', { textContent: `Great Salt Lake basin, model ensemble average. 1 acre-foot = ${h.m3_per_af} m³ (about 326,000 gallons). Water year is named for the year it ends.` }),
          el('thead', {}, el('tr', {}, ...['Water year', 'Rain + snowmelt in', 'Irrigation', 'Evapotranspiration', 'Runoff', 'Recharge'].map(s => el('th', { scope: 'col', textContent: s })))),
          el('tbody', {}, ...A.slice().reverse().map(r => el('tr', {},
            el('td', { textContent: String(r.water_year) }),
            ...['precip_af', 'irrigation_af', 'aet_af', 'runoff_af', 'recharge_af'].map(k => el('td', { textContent: maf(r[k]) })))))))) : '');
      cite('ugs-swb-hist-src', ...srcParts(`, Great Salt Lake basin zonal statistics, ${M.month[0]} to ${M.month[last]}; lines are the ensemble average, bands the lowest and highest of up to ${Math.max(...M.members)} runs`));
    },
  });
})();
