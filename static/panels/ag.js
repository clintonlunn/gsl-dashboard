// Farms and water: the rain that fell on the lake this period, measured against farm water in the lake's river basins.
// Data from sources/ag.py (DATA.sources.ag); rain on the lake from the core payload (DATA.rain_lake).
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt } = G;
  const BASIN_TEXT = { 'Bear River': 'Bear', 'Weber River': 'Weber', 'Jordan River': 'Jordan', 'Utah Lake': 'Utah Lake' };
  const ft = (v) => `${v.toFixed(1)} ft`;
  // "27% of" or "4.5 times": a ratio said in words, for sentences
  const times = (r) => r >= 0.995 ? `${r.toFixed(r < 10 ? 1 : 0)} times` : `${Math.max(1, Math.round(r * 100))}% of`;
  const round = (v) => v >= 1e9 ? `${(v / 1e9).toFixed(1)} billion` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} million` : v >= 1e4 ? fmtInt(Math.round(v / 100) * 100) : fmtInt(Math.round(v));
  const maf = (v) => `${(v / 1e6).toFixed(2)} million`;


  // ------------------------------------------------------------ source lines
  const usu = (a) => ['Utah State University, Hill, Barker & Lewis (2011), ', link('UAES Research Report 213, Appendix I', a.url),
    ` (alfalfa, ${a.period}; updates `, link(`Hill ${a.earlier.year}, Report 145`, a.earlier.url), ')'];
  const wrlu = (ac) => ['Utah Division of Water Resources, ', link(`Water-Related Land Use ${ac.survey_years.join(', ')}`, ac.item_url),
    ' (', link('feature service', ac.service_url), ac.snapshot ? `, snapshot from ${ac.pulled_at}` : '', ')'];
  const wb = (bu, lake) => ['Utah Division of Water Resources, ', link('Utah Water Budget', bu.hub_url), ' (', link(bu.service, bu.service_url), `)${lake ? ', Great Salt Lake subarea' : ', Utah side'}, CC BY-SA`];
  const hhSrc = (h) => ['Utah Division of Water Resources, ', link('Residential Water Use (2010)', h.url),
    `: ${h.indoor_gpcd} + ${h.outdoor_gpcd} gal per person per day × ${h.persons} people`];
  const rainSrc = () => ['rain from ', link('NOAA ACIS', 'https://www.rcc-acis.org/'), ' lowland gauges × lake area from ', link('USGS tables', 'https://doi.org/10.5066/P9DGG75W')];

  // the rain figure for this period, or the model's yearly figure when the period is too long for rain counts
  function rainFor(D, d) {
    const r = D.rain_lake?.[0];
    if (r?.rain_af > 0) return { af: r.rain_af, inches: r.rain_in, kind: 'window' };
    if (r?.rain_in === 0) return { af: 0, kind: 'dry' };
    if (d.budget?.gsl_precip_af) return { af: d.budget.gsl_precip_af, kind: 'model', wy: d.budget.water_year };
    return null;
  }
  const whenText = (D) => {
    const w = D.window; if (!w) return 'this period';
    return w.is_default ? 'this week' : `from ${G.fmtDay(G.parseDay(w.from))} to ${G.fmtDay(G.parseDay(w.to))}`;
  };

  // ------------------------------------------------------------ one panel: comparisons, chart, words, caveats
  let LAST = null;
  G.register({
    id: 'ag', tab: 'ag', order: 10,
    mount(slot) {
      document.getElementById('ag-empty')?.remove();
      const sel = el('select', { id: 'ag-basin' },
        el('option', { value: '', textContent: 'All four basins' }),
        ...Object.entries(BASIN_TEXT).map(([v, t]) => el('option', { value: v, textContent: `${t}${t === 'Utah Lake' ? '' : ' River'} basin` })));
      sel.addEventListener('change', () => LAST && drawChart(...LAST));
      const sec = (id, title, ...kids) => {
        const s = el('section', { className: 'section ag', id }, el('h2', { id: `${id}-h`, textContent: title }), ...kids);
        s.setAttribute('aria-labelledby', `${id}-h`);
        return s;
      };
      const root = el('div', { id: 'ag-root' },
        sec('ag-compare', 'The rain on the lake, in farm terms',
          el('p', { className: 'lead', id: 'ag-lead' }),
          el('div', { className: 'ag-cards', id: 'ag-cards' }),
          el('p', { className: 'src', id: 'ag-compare-src' })),
        sec('ag-hist', 'Farm water in the lake\'s river basins, by year',
          el('p', { className: 'note', id: 'ag-hist-note' }),
          el('div', { className: 'ag-controls' }, el('label', { htmlFor: 'ag-basin', textContent: 'Show' }), sel),
          el('div', { className: 'ag-chart', id: 'ag-chart' }),
          el('div', { id: 'ag-hist-table' }),
          el('p', { className: 'src', id: 'ag-hist-src' })),
        sec('ag-words-s', 'Diversion, pumping and depletion: what the words mean',
          el('dl', { className: 'ag-words', id: 'ag-words' })),
        sec('ag-caveats-s', 'What these comparisons can and can\'t tell you',
          el('ul', { className: 'ag-caveats', id: 'ag-caveats' }),
          el('div', { id: 'ag-stations' }),
          el('p', { className: 'src', id: 'ag-caveats-src' })));
      slot.append(root);
      return root;
    },
    render(d, D) {
      const lead = document.getElementById('ag-lead'), cards = document.getElementById('ag-cards');
      if (!d || d.error || !d.refs) {
        lead.textContent = d?.error || 'Farm water figures are not available right now.';
        lead.classList.toggle('err', !!d?.error);
        cards.replaceChildren(); G.emptyChart('ag-chart', 'No farm water figures.');
        return;
      }
      lead.classList.remove('err');
      drawCompare(d, D);
      LAST = [d, D];
      drawChart(d, D);
      drawWords(d);
      drawCaveats(d);
    },
  });
  // the page renders the "ag" tab only when it is shown; if it was opened before this file loaded, ask again
  if (G.isShown('ag')) document.getElementById('tab-ag')?.click();

  function drawCompare(d, D) {
    const A = d.refs.alfalfa, H = d.refs.household, ac = d.acres, bu = d.budget;
    const rain = rainFor(D, d);
    const lead = document.getElementById('ag-lead'), cards = document.getElementById('ag-cards');
    const when = whenText(D);
    const wy = bu ? `water year ${bu.water_year}` : '';
    const latestNote = bu?.latest_available_used ? ', the state model\'s latest year' : '';
    if (!rain || rain.kind === 'dry') {
      lead.replaceChildren(rain?.kind === 'dry'
        ? `No measurable rain fell on the lake ${when}, so there is nothing to compare. The yardsticks below still hold: `
        : 'There is no rain figure for this period. The yardsticks below still hold: ',
        b(`an acre of alfalfa uses about ${ft(A.typical_ft)} of water a season`), `; a Utah household about ${H.af_per_year.toFixed(2)} acre-feet a year.`);
      cards.replaceChildren();
      cite('ag-compare-src', ...usu(A), '; ', ...hhSrc(H), '.');
      return;
    }
    const R = rain.af;
    const acres = R / A.typical_ft, ut = ac.alfalfa.utah_total;
    const pump = bu?.year.pumping.four_basins_af, pumpBWJ = bu?.year.pumping.bear_weber_jordan_af, dep = bu?.year.depletions.four_basins_af;
    const homes = R / H.af_per_year;
    const what = rain.kind === 'model' ? `The rain and snow the state model puts on the lake in ${wy} (${fmtInt(R)} acre-feet; this period is too long for rain-gauge counts)`
      : `The rain that fell on the lake ${when} (${fmtInt(R)} acre-feet${rain.inches != null ? `, about ${rain.inches.toFixed(2)} in` : ''})`;
    lead.replaceChildren(what, ' is about what ', b(`${round(acres)} acres of alfalfa`), ` use in a growing season at ${ft(A.typical_ft)} each`,
      ...(pump ? [', or ', b(`${times(R / pump)} a year of farm groundwater pumping`), ` in the Bear, Weber, Jordan and Utah Lake basins (${wy}${latestNote}).`] : ['.']));

    // a share of a year: "88%" of a year, or "2.9×" a year's worth
    const share = (r, what) => r >= 1 ? [`${r.toFixed(r < 10 ? 1 : 0)}×`, `a year's ${what}`] : [`${Math.max(1, Math.round(r * 100))}%`, `of a year`];
    const card = (lbl, val, unit, say, src, lbl2) => el('div', { className: 'ag-card' },
      el('div', { className: 'lbl', textContent: lbl2 || lbl }),
      el('div', { className: 'val' }, val, el('span', { className: 'unit', textContent: unit })),
      el('div', { className: 'say' }, ...say),
      el('p', { className: 'src' }, 'Source: ', ...src, '.'));
    const list = [
      card('Rain on the lake', fmtInt(R), 'acre-ft',
        [rain.kind === 'model' ? `Rain and snow on the lake in ${wy}, from the state model.` : `Fell straight onto the lake ${when}. 1 acre-foot covers an acre a foot deep: ${round(R * d.refs.gal_per_af)} gallons in all.`],
        rain.kind === 'model' ? wb(bu, true) : rainSrc(), rain.kind === 'model' ? 'Rain and snow on the lake, one year' : null),
      card('Alfalfa for a season', round(acres), 'acres',
        [`At ${ft(A.typical_ft)} of water per acre per season (typical for the basins' farm towns; ${ft(A.range_ft[0])} in high valleys like Woodruff to ${ft(A.range_ft[1])} near Salt Lake City). `,
          ut ? `That's ${times(acres / ut)} the ${fmtInt(ut)} irrigated alfalfa acres on the Utah side of the four basins.` : ''],
        [...usu(A), ut ? ['; acres: ', ...wrlu(ac)] : ''].flat()),
    ];
    if (pump) list.push(card('Farm groundwater pumping', ...share(R / pump, 'pumping'),
      [`Farm wells in the four basins pumped ${fmtInt(pump)} acre-feet in ${wy}`,
        bu.average.pumping.four_basins_af ? ` (${fmtInt(bu.average.pumping.four_basins_af)} a year on average, ${bu.average_years.join('–')}). ` : '. ',
        (bu.year.pumping.by_basin_af['Utah Lake'] > pump / 2 ? 'Most of it is in the Utah Lake basin. ' : ''),
        `In just the Bear, Weber and Jordan basins it was ${fmtInt(pumpBWJ)} acre-feet, so this rain is ${times(R / pumpBWJ)} that.`],
      wb(bu)));
    if (dep) list.push(card('Water crops used up', ...share(R / dep, 'farm use'),
      [`Farms in the four basins used up (depleted) ${fmtInt(dep)} acre-feet in ${wy}, from rivers, canals and wells together. This rain is ${times(R / dep)} that.`],
      wb(bu)));
    list.push(card('Households for a year', round(homes), 'homes',
      [`At ${H.af_per_year.toFixed(2)} acre-feet (${fmtInt(H.gallons_per_day)} gallons a day) per Utah home, indoors and out. Indoors only, the state's water-rights figure is ${H.indoor_only_af} acre-feet, which would make it ${round(R / H.indoor_only_af)} homes.`],
      [...hhSrc(H), '; ', link('Utah Division of Water Rights', H.indoor_only_url)]));
    cards.replaceChildren(...list);
    cite('ag-compare-src', 'Each card names its own source. Groundwater and depletion figures are the Utah side of each basin; Idaho and Wyoming farms in the Bear basin are left out.');
  }

  function drawChart(d, D) {
    const S = d.series, bu = d.budget;
    if (!S || !S.water_years?.length) {
      document.getElementById('ag-hist-note').textContent = d.budget_error || 'Water budget model results are not available right now.';
      G.emptyChart('ag-chart', 'No model results.');
      document.getElementById('ag-hist-table').replaceChildren();
      return;
    }
    const basin = document.getElementById('ag-basin').value;
    const V = basin ? S.by_basin_af[basin] : S.four_basins_af;
    const Y = S.water_years, first = Y[0], last = Y[Y.length - 1];
    const where = basin ? `the ${BASIN_TEXT[basin]}${basin === 'Utah Lake' ? '' : ' River'} basin` : 'the Bear, Weber, Jordan and Utah Lake basins';
    const avg = (a) => a.reduce((s, v) => s + (v || 0), 0) / a.length;
    const rain = rainFor(D, d);
    const rainLine = rain && rain.kind === 'window' && rain.af > 0 ? rain.af : null;
    const P = V.pumping, Dp = V.depletions;
    const pmax = P.indexOf(Math.max(...P)), pmin = P.indexOf(Math.min(...P));
    document.getElementById('ag-hist-note').textContent =
      `Each pair of bars is one water year (October to September, named for the year it ends) in ${where}, Utah side, from the state's water budget model. `
      + `Crops used up about ${maf(avg(Dp))} acre-feet a year on average, ${first}–${last}; farm wells pumped about ${fmtInt(Math.round(avg(P) / 1000) * 1000)}. `
      + (rainLine ? `The dashed line is the rain that fell on the lake in the period you picked (${fmtInt(rainLine)} acre-feet).` : '');
    const ink = css('--ink'), ink2 = css('--ink-2'), paper = css('--paper');
    const o = G.base();
    o.aria.label = { enabled: true, description: `Bar chart of farm water by water year in ${where}, Utah side, ${first} to ${last}, from the Utah Water Budget model. `
      + `Farm depletions (water crops used up) average ${maf(avg(Dp))} acre-feet a year; ${last}: ${fmtInt(Dp[Dp.length - 1])}. `
      + `Farm groundwater pumping averages ${fmtInt(Math.round(avg(P)))} acre-feet a year, lowest ${fmtInt(P[pmin])} in ${Y[pmin]}, highest ${fmtInt(P[pmax])} in ${Y[pmax]}; ${last}: ${fmtInt(P[P.length - 1])}. `
      + (rainLine ? `A dashed reference line marks this period's rain on the lake, ${fmtInt(rainLine)} acre-feet. ` : '') + 'A table of the values follows the chart.' };
    o.aria.decal = { show: false };
    o.legend = { top: 0, left: 0, textStyle: { color: ink, fontSize: 12 }, itemWidth: 22, itemHeight: 12 };
    o.grid = { ...o.grid, top: 60 };
    o.xAxis = { type: 'category', data: Y.map(String), axisLine: { lineStyle: { color: css('--rule') } }, axisLabel: { color: ink2, fontSize: 12, hideOverlap: true }, axisTick: { alignWithLabel: true } };
    o.yAxis = { ...o.yAxis, name: 'acre-feet', nameTextStyle: { color: ink2, align: 'left', fontSize: 12 },
      axisLabel: { color: ink2, fontSize: 12, formatter: (v) => v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : v } };
    o.tooltip = { ...o.tooltip, axisPointer: { type: 'shadow' }, formatter: (ps) => {
      const i = ps[0]?.dataIndex; if (i == null) return '';
      return [`Water year ${Y[i]}`, ...ps.map(p => `${p.marker}${p.seriesName}: <b>${fmtInt(p.value)}</b> ac-ft`),
        ...(rainLine ? [`This period's rain on the lake: <b>${fmtInt(rainLine)}</b> ac-ft`] : [])].join('<br>');
    } };
    o.series = [
      { name: 'Used up by crops (depletion)', type: 'bar', barMaxWidth: 14, data: Dp,
        itemStyle: { color: css('--healthy'), decal: { symbol: 'none' } }, emphasis: { focus: 'series' } },
      { name: 'Pumped from farm wells', type: 'bar', barMaxWidth: 14, data: P,
        itemStyle: { color: css('--pen'), decal: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 4], rotation: Math.PI / 4, color: paper } }, emphasis: { focus: 'series' },
        markLine: rainLine ? { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: css('--rain'), width: 2 },
          label: { color: ink, fontSize: 12, position: 'insideEndTop', backgroundColor: paper, padding: [2, 4], formatter: `Rain on the lake, this period: ${fmtInt(rainLine)} ac-ft` }, data: [{ yAxis: rainLine }] } : undefined },
    ];
    G.chart('ag-chart').setOption(o, true);

    document.getElementById('ag-hist-table').replaceChildren(el('details', {},
      el('summary', { textContent: `Values by water year, ${first}–${last}, in acre-feet` }),
      el('div', { className: 'tablewrap' }, el('table', { className: 'ag-table' },
        el('caption', { textContent: `Farm water in ${where}, Utah side.` }),
        el('thead', {}, el('tr', {}, ...['Water year', 'Used up by crops', 'Taken from rivers and canals', 'Pumped from wells'].map(s => el('th', { scope: 'col', textContent: s })))),
        el('tbody', {}, ...Y.map((_, i) => i).reverse().map(i => el('tr', {},
          el('td', { textContent: String(Y[i]) }),
          ...[Dp[i], V.diversions[i], P[i]].map(v => el('td', { textContent: v == null ? '—' : fmtInt(v) })))))))));
    cite('ag-hist-src', ...wb(bu || S), `, water years ${first}–${last}. Idaho and Wyoming farms in the Bear basin pump about ${fmtInt(Math.round(avg(S.other_states_af.pumping)))} acre-feet a year more (not shown; the state calls those figures less certain). `
      + `All Utah basins together: about ${fmtInt(Math.round(avg(S.statewide_utah_af.pumping) / 1000) * 1000)} acre-feet of farm well pumping a year.`);
  }

  function drawWords(d) {
    const bu = d.budget;
    const y = bu?.year;
    const nums = (k) => y ? ` In ${bu.water_year}, the four basins: ${fmtInt(y[k].four_basins_af)} acre-feet.` : '';
    document.getElementById('ag-words').replaceChildren(
      el('dt', { textContent: 'Diversion' }), el('dd', { textContent: 'Water taken out of a river or reservoir into a canal or pipe to irrigate fields. Much of it is not used up: it soaks into the ground or runs off the field and back to a river downstream.' + nums('diversions') }),
      el('dt', { textContent: 'Pumping' }), el('dd', { textContent: 'Water pulled up from wells, out of the aquifer under the valley. Like a diversion, part of it returns by soaking back down or draining to streams.' + nums('pumping') }),
      el('dt', { textContent: 'Depletion' }), el('dd', { textContent: 'The part that is used up: evaporated or taken up by the crop and breathed out by its leaves, so it never flows back to a river or the lake. This is the number that matters most for the lake.' + nums('depletions') }),
      el('dt', { textContent: 'Acre-foot' }), el('dd', { textContent: `Enough water to cover one acre one foot deep: ${fmtInt(d.refs.gal_per_af)} gallons. An acre of alfalfa uses about ${ft(d.refs.alfalfa.typical_ft)} of water each growing season (${d.refs.alfalfa.typical_ft.toFixed(1)} acre-feet).` }));
  }

  function drawCaveats(d) {
    const A = d.refs.alfalfa, bu = d.budget;
    document.getElementById('ag-caveats').replaceChildren(...[
      'Groundwater pumped for farms is not the same water as rain on the lake. Rain on the lake is in the lake already. Well water comes from aquifers under the valleys, and some of it would have seeped to streams, springs or the lake over months to years. These are size comparisons, not a swap.',
      `Alfalfa water use changes with elevation, weather and how often the field is cut. The ${ft(A.typical_ft)} used here is the middle of ${A.stations.length} long-term weather stations in the four basins (${A.period}); it ranges from ${ft(A.range_ft[0])} in high valleys to ${ft(A.range_ft[1])} on the warm valley floor, and a hot or dry year runs higher. Rain during the season covers part of it; irrigation has to supply about ${ft(A.typical_net_irr_ft)}.`,
      'Rain on the lake is a rough figure: the middle reading of lowland rain gauges spread over the whole lake surface.',
      bu ? `The state water budget model ends at water year ${bu.last_wy}${bu.latest_available_used ? ', so the farm figures are from the latest year it has, not this one' : ''}. Its numbers are modeled from land use, crop water needs and water rights records, not metered at every well.` : 'The state water budget model results are not loaded yet.',
      'Household use is from a 2009 survey of 17 Utah communities. Outdoor watering varies far more than indoor use, so any one home can be well above or below it.',
      'Farm acres are the Utah side of each basin from the state\'s land-use survey; the Bear basin has about as many more irrigated acres again in Idaho and Wyoming.',
    ].map(t => el('li', { textContent: t })));
    const st = A.stations.slice().sort((a, c) => a.elev_ft - c.elev_ft);
    document.getElementById('ag-stations').replaceChildren(el('details', {},
      el('summary', { textContent: `Alfalfa water use at ${st.length} weather stations in the four basins` }),
      el('div', { className: 'tablewrap' }, el('table', { className: 'ag-table' },
        el('caption', { textContent: `${A.crop}. Seasonal water use (ET) and the part irrigation must supply (net irrigation), ${A.period}, in inches.` }),
        el('thead', {}, el('tr', {}, ...['Station', 'Basin', 'Elevation (ft)', 'Water use (in)', 'Net irrigation (in)', 'Report page'].map(s => el('th', { scope: 'col', textContent: s })))),
        el('tbody', {}, ...st.map(s => el('tr', {},
          el('td', { textContent: s.station }), el('td', { textContent: BASIN_TEXT[s.basin] || s.basin }),
          el('td', { textContent: fmtInt(s.elev_ft) }), el('td', { textContent: s.et_in.toFixed(1) }),
          el('td', { textContent: s.net_irr_in.toFixed(1) }), el('td', { textContent: `≈ ${s.page}` }))))))));
    cite('ag-caveats-src', ...usu(A), '. USDA NASS Quick Stats and OpenET would give crop acres and field-by-field water use, but both need an API key.');
  }
})();
