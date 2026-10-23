// Wetlands on the Great Salt Lake's edge: Utah Geological Survey wetland condition surveys, vegetation survey sites,
// Wetland Data Explorer (WetDash) sampling and mapped wetland acres. Data from sources/ugs_wetlands.py
// (DATA.sources.ugs_wetlands). `d.sites` holds non-confidential survey points (lat/lon + condition) for a map layer.
(() => {
  const G = window.GSL;
  if (!G) return;
  const { el, b, link, cite, css, fmtInt } = G;
  const pctOf = (n, t) => t ? Math.round(100 * n / t) : 0;
  const AREA = { 'Weber URAP': 'Weber River delta', 'Jordan URAP': 'Jordan River and Farmington Bay',
    'Bear River URAP': 'Bear River Bay', 'Central Basin': 'West and south shores (Central Basin)' };
  const COND_TEXT = { very_high: 'very high', high: 'high', medium: 'medium', low: 'low', absent: 'absent' };
  // a different fill pattern per level, so bars aren't told apart by color alone
  const DECALS = ['none', 'diamond', 'circle', 'rect', 'triangle'];
  const firstItem = (s) => (s || '').split(';')[0].replace(/^Hydrology: /, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  const pctIn = (s) => ((s || '').split(';')[0].match(/\(([\d.]+)%\)/) || [])[1];


  function bars(id, rows, color, title) {
    const paper = css('--paper');
    const total = rows.reduce((s, r) => s + r.sites, 0);
    const ink = css('--ink'), ink2 = css('--ink-2');
    const o = G.base();
    o.aria = { enabled: true, decal: { show: true },
      label: { enabled: true, description: `${title}: bar chart of ${total} surveyed sites. `
        + rows.map(r => `${r.label}: ${r.sites} site${r.sites === 1 ? '' : 's'} (${pctOf(r.sites, total)}%)`).join('; ') + '. The same numbers are in the summary above.' } };
    o.grid = { left: 8, right: 64, top: 4, bottom: 4, containLabel: true };
    o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => `${p.name}: ${p.value} of ${total} sites (${pctOf(p.value, total)}%)` };
    o.xAxis = { type: 'value', show: false, max: Math.max(...rows.map(r => r.sites)) || 1 };
    o.yAxis = { type: 'category', inverse: true, data: rows.map(r => r.label), axisTick: { show: false },
      axisLine: { lineStyle: { color: css('--rule') } }, axisLabel: { color: ink, fontSize: 12 } };
    o.series = [{ type: 'bar', barWidth: 16,
      data: rows.map((r, i) => ({ value: r.sites, itemStyle: { color, decal: { symbol: DECALS[i % DECALS.length], color: paper, symbolSize: 0.5 } } })),
      label: { show: true, position: 'right', color: ink2, fontSize: 12, fontFamily: 'IBM Plex Mono',
        formatter: (p) => `${p.value} (${pctOf(p.value, total)}%)` } }];
    G.chart(id).setOption(o, true);
  }

  const th = (t, n) => el('th', { scope: 'col', textContent: t, className: n ? 'n' : '' });
  const td = (t, n) => el('td', { textContent: t ?? '—', className: n ? 'n' : '' });

  G.register({
    id: 'ugs_wetlands', tab: 'details', order: 45,
    mount(slot) {
      const root = el('section', { className: 'section ugs-wet', id: 'ugs-wet' },
        el('h2', { id: 'ugs-wet-h', textContent: 'Wetlands on the lake\'s edge' }),
        el('p', { className: 'note', textContent: 'The marshes, wet meadows and mudflats around the Great Salt Lake feed and shelter millions of migrating birds each year. '
          + 'They live on fresh water: river inflow from the Bear, Weber and Jordan rivers, and groundwater seeping up along the shore. '
          + 'When less river water reaches the lake, these wetlands shrink or turn salty first. Utah Geological Survey crews survey randomly chosen wetland sites to see how healthy they are and what is stressing them.' }),
        el('p', { className: 'lead', id: 'ugs-wet-lead', textContent: 'Loading…' }),
        el('div', { className: 'charts' },
          el('div', {}, el('h3', { id: 'ugs-wet-c-h', textContent: 'Wetland condition (surveyed sites)' }), el('div', { className: 'chart', id: 'chart-ugs-wet-cond', role: 'img' })),
          el('div', {}, el('h3', { id: 'ugs-wet-s-h', textContent: 'Human stress on those sites' }), el('div', { className: 'chart', id: 'chart-ugs-wet-stress', role: 'img' }))),
        el('ul', { className: 'facts', id: 'ugs-wet-facts' }),
        el('h3', { className: 't', textContent: 'Survey areas around the lake' }),
        el('div', { className: 'tablewrap', id: 'ugs-wet-strata' }),
        el('h3', { className: 't', textContent: 'Notable sites: least-disturbed plant communities' }),
        el('div', { className: 'tablewrap', id: 'ugs-wet-notable' }),
        el('p', { className: 'src', id: 'ugs-wet-how' }),
        el('p', { className: 'src', id: 'ugs-wet-src' }));
      root.setAttribute('aria-labelledby', 'ugs-wet-h');
      slot.append(root);
      return root;
    },
    render(d) {
      const lead = document.getElementById('ugs-wet-lead');
      const L = d?.links || { collection: 'https://maps-assets.geology.utah.gov/warehouse/stac/ugs-serving-topics/wetlands/collection.json',
        data_app: 'https://wetlandsdata.geology.utah.gov/', map_app: 'https://wetlands.geology.utah.gov/', ugs: 'https://geology.utah.gov/water/wetlands/' };
      cite('ugs-wet-src', 'Utah Geological Survey wetlands data warehouse, ', link('STAC collection "wetlands"', L.collection),
        ...(L.study_results ? [' (', link('assessment study results', L.study_results), ', ', link('plant survey sites', L.plants_site), ', ',
          link('WetDash sampling sites', L.wetdash), ', ', link('wetland mapping', L.outline), ')'] : []),
        '; apps: ', link('Wetland Data Explorer (WetDash)', L.data_app), ', ', link('Utah Wetlands map', L.map_app), '; ',
        link('UGS wetlands program', L.ugs), '. License CC BY 4.0.');
      const ids = ['ugs-wet-facts', 'ugs-wet-strata', 'ugs-wet-notable', 'ugs-wet-how'];
      if (!d || d.error || !d.available) {
        lead.textContent = d?.error ? `Couldn't load the wetland surveys: ${d.error}.` : 'The wetland survey data is not loaded yet.';
        lead.classList.toggle('err', !!d?.error);
        ids.forEach(i => document.getElementById(i).replaceChildren());
        G.emptyChart('chart-ugs-wet-cond', 'No wetland surveys loaded.');
        G.emptyChart('chart-ugs-wet-stress', 'No wetland surveys loaded.');
        return;
      }
      lead.classList.remove('err');
      const A = d.assessment, n = A.sites;
      const sum = (rows, keys) => rows.filter(r => keys.includes(r.key)).reduce((s, r) => s + r.sites, 0);
      const good = sum(A.condition, ['very_high', 'high']), hiStress = sum(A.stress, ['high', 'very_high']);
      const yrs = A.strata.flatMap(s => String(s.years).match(/\d{4}/g) || []).map(Number);
      const years = yrs.length ? `${Math.min(...yrs)}–${Math.max(...yrs)}` : 'various years';
      const weeds = A.strata.map(s => s.top_weeds || '');
      const phrag = weeds.filter(w => /^Phragmites/.test(w)).length;
      lead.replaceChildren('Of ', b(String(n)), ` wetland sites UGS surveyed around the lake (${years}), `, b(`${good} (${pctOf(good, n)}%)`),
        ' were in high or very high condition, yet ', b(`${hiStress} (${pctOf(hiStress, n)}%)`),
        ' were under high or very high human stress, mostly changes to their water: diking, canals, stormwater and farm runoff. ',
        ...(phrag ? [`Invasive common reed (Phragmites) was the most widespread weed in ${phrag} of ${A.strata.length} survey areas.`] : []));

      bars('chart-ugs-wet-cond', A.condition, css('--healthy'), 'Wetland condition');
      bars('chart-ugs-wet-stress', A.stress, css('--pen'), 'Human stress');

      const facts = [];
      const S = d.surveys;
      if (S?.visits) {
        const ref = (S.by_condition.find(c => c.label === 'High Quality Reference') || {}).sites || 0;
        facts.push(el('li', {}, 'Plant surveys: ', b(fmtInt(S.visits)), ` site visits from ${S.first_year} to ${S.last_year} (${S.projects} projects); `,
          b(String(ref)), ' had plant communities good enough to serve as least-disturbed reference sites.'));
      }
      const W = d.wetdash;
      if (W) facts.push(el('li', {}, 'Wetland Data Explorer (WetDash): ', b(fmtInt(W.events)), ` sampling visits at ${fmtInt(W.locations)} places, ${W.first_day.slice(0, 4)}–${W.last_day.slice(0, 4)}, with `,
        b(fmtInt(W.water)), ' water chemistry, ', b(fmtInt(W.soil)), ' soil and ', b(fmtInt(W.inverts)), ' aquatic invertebrate records.'));
      const ac = (d.acres || []).filter(r => r.type !== 'Lake');
      if (ac.length) {
        const tot = ac.reduce((s, r) => s + r.acres, 0);
        facts.push(el('li', {}, 'Mapped wetlands in the area: about ', b(`${fmtInt(Math.round(tot / 100) * 100)} acres`), ' (not counting the lake itself): ',
          ac.slice(0, 4).map(r => `${r.type.replace('Freshwater ', '').toLowerCase()} ${fmtInt(Math.round(r.acres / 100) * 100)}`).join(', '), ' acres.'));
      }
      if (S && !S.in_window && !(W && W.in_window)) facts.push(el('li', {}, 'No surveys fall in the dates you picked; these are the most recent results UGS has published.'));
      document.getElementById('ugs-wet-facts').replaceChildren(...facts);

      document.getElementById('ugs-wet-strata').replaceChildren(el('table', {},
        el('caption', { textContent: 'Each row is one survey of randomly chosen sites. Condition and stress are the share of surveyed sites rated high or very high.' }),
        el('thead', {}, el('tr', {}, th('Area'), th('Years'), th('Sites', 1), th('Good condition', 1), th('High stress', 1), th('Most common stressor'))),
        el('tbody', {}, ...A.strata.map(s => el('tr', {},
          el('th', { scope: 'row' }, s.report ? link(AREA[s.project] || s.project, s.report) : (AREA[s.project] || s.project)),
          td(s.years), td(String(s.sites), 1), td(`${Math.round(s.pct_high_condition)}%`, 1), td(`${Math.round(s.pct_high_stress)}%`, 1),
          td(`${firstItem(s.top_stressors)}${pctIn(s.top_stressors) ? ` (${Math.round(pctIn(s.top_stressors))}% of sites)` : ''}`))))));

      const N = d.notable || [];
      document.getElementById('ugs-wet-notable').replaceChildren(N.length ? el('table', {},
        el('caption', { textContent: 'Reference-quality sites with the most native plant cover. Plant score: average sensitivity of the plants present, 0–10; higher means plants that need undisturbed ground.' }),
        el('thead', {}, el('tr', {}, th('Site'), th('Year', 1), th('Wetland type'), th('Watershed'), th('Land owner'), th('Native cover', 1), th('Plant score', 1))),
        el('tbody', {}, ...N.map(r => el('tr', {}, el('th', { scope: 'row', textContent: r.site }), td(String(r.year), 1), td(r.type), td(r.watershed),
          td(r.owner), td(r.native_pct == null ? '—' : `${r.native_pct}%`, 1), td(r.mean_c == null ? '—' : r.mean_c.toFixed(1), 1))))) : '');

      document.getElementById('ugs-wet-how').textContent = 'Site counts per category are UGS\'s published percentages times the sites surveyed, rounded. '
        + 'Survey areas are the strata UGS named "Great Salt Lake" in its Weber, Jordan, Bear River and Central Basin assessments; '
        + 'plant survey sites and acres are those within about lon −113.2 to −111.8, lat 40.6 to 41.8. Confidential sites are counted but not mapped.';
    },
  });
})();
