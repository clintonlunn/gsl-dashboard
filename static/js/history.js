import { base, chart, charts } from './charts.js';
import { setKnobs } from './main.js';
import { renderPanels } from './panels.js';
import { form, fromIn, toIn } from './period.js';
import { STATIC, state } from './state.js';
import { RIVER_COLOR, USGS, cite, css, fmt1, fmtDay, fmtInt, gaugeLinks, isoDay, link, parseDay } from './util.js';

// ---------------------------------------------------------------- history charts
let histZoom = null;
export function drawHistory() {
  if (!state.HIST) return;
  const pts = state.HIST.lake_weekly.map(r => [parseDay(r.wk), r.elev_ft]);
  const [lo, hi] = state.HIST.config.healthy_ft;
  const o = base();
  o.aria.label = { enabled: true, description: `Great Salt Lake level at Saltair since 1847, weekly averages from ${fmt1(Math.min(...pts.map(p => p[1])))} to ${fmt1(Math.max(...pts.map(p => p[1])))} feet. The healthy range is ${lo} to ${hi} feet; the record low is ${state.HIST.config.record_low_ft} feet.` };
  o.grid.bottom = 64;
  o.yAxis = { ...o.yAxis, scale: true, axisLabel: { color: css('--ink-2'), formatter: (v) => fmtInt(v) } };
  o.tooltip.valueFormatter = (v) => `${fmt1(v)} ft`;
  o.dataZoom = [{ type: 'inside' }, { type: 'slider', height: 28, bottom: 8, borderColor: css('--rule'), textStyle: { color: css('--ink-2') },
    fillerColor: 'rgba(127,127,127,.18)', dataBackground: { lineStyle: { color: css('--ink-2') }, areaStyle: { color: css('--grid') } },
    labelFormatter: (v) => new Date(v).getFullYear() }];
  o.series = [{ name: 'Lake level', type: 'line', showSymbol: false, sampling: 'lttb', connectNulls: false, lineStyle: { width: 1.5, color: css('--pen') }, itemStyle: { color: css('--pen') }, data: pts,
    markArea: { silent: true, itemStyle: { color: css('--healthy-fill'), opacity: .8 }, label: { show: true, position: 'insideTopLeft', color: css('--healthy'), formatter: 'Healthy' }, data: [[{ yAxis: lo }, { yAxis: hi }]] },
    markLine: { silent: true, symbol: 'none', lineStyle: { type: 'dashed', color: css('--ink-2') }, label: { color: css('--ink-2'), formatter: 'Record low', position: 'insideEndBottom' }, data: [{ yAxis: state.HIST.config.record_low_ft }] } }];
  const c = chart('chart-history');
  c.setOption(o, true);
  c.off('datazoom');
  c.on('datazoom', () => {
    const z = c.getOption().dataZoom[0];
    const span = pts[pts.length - 1][0] - pts[0][0];
    const a = new Date(+pts[0][0] + span * z.start / 100), e = new Date(+pts[0][0] + span * z.end / 100);
    histZoom = [a < new Date(1847, 9, 18) ? new Date(1847, 9, 18) : a, e > new Date() ? new Date() : e];
    document.getElementById('hist-range').textContent = `Selected: ${fmtDay(histZoom[0], true)} – ${fmtDay(histZoom[1], true)}`;
  });
  const rid = state.HIST.lake_weekly.length ? '10010000' : '';
  cite('src-history', 'USGS daily values, gauge ', link(rid, USGS(rid)), '; healthy range from the ', link('Utah FFSL elevation matrix', 'https://ffsl.utah.gov/wp-content/uploads/Elevation_Matrix_3_1_13Cropped.pdf'), '.');

  const years = [...new Set(state.HIST.annual_inflow.map(r => r.water_year))].sort((a, c2) => a - c2);
  const rivers = ['Bear River', 'Weber River', 'Jordan River'];
  const a = base();
  a.aria.label = { enabled: true, description: `River water reaching the Great Salt Lake each water year from ${years[0]} to ${years[years.length - 1]}, by river, in acre-feet.` };
  a.tooltip = { ...a.tooltip, axisPointer: { type: 'shadow' }, valueFormatter: (v) => v == null ? '—' : `${fmtInt(v)} acre-ft` };
  a.legend = { top: 0, left: 0, textStyle: { color: css('--ink') }, icon: 'rect' };
  a.grid.top = 32; a.grid.bottom = 64;
  a.xAxis = { type: 'category', data: years, axisLabel: { color: css('--ink-2') }, axisLine: { lineStyle: { color: css('--rule') } } };
  a.yAxis = { ...a.yAxis, axisLabel: { color: css('--ink-2'), formatter: (v) => v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : v } };
  a.dataZoom = [{ type: 'inside', startValue: Math.max(0, years.length - 40) }, { type: 'slider', height: 28, bottom: 8, borderColor: css('--rule'), textStyle: { color: css('--ink-2') }, startValue: Math.max(0, years.length - 40) }];
  a.series = rivers.map((rv, i) => ({ name: rv, type: 'bar', stack: 'in', itemStyle: { color: css(RIVER_COLOR[rv]), decal: { symbol: ['rect', 'circle', 'triangle'][i], symbolSize: .6, color: 'rgba(0,0,0,.18)' } },
    data: years.map(y => state.HIST.annual_inflow.find(r => r.water_year === y && r.river === rv)?.acre_ft ?? null) }));
  a.aria.decal = { show: true };
  chart('chart-annual').setOption(a, true);
  cite('src-annual', 'USGS daily values, gauges ', ...gaugeLinks(['10126000', '10141000', '10170500', '10172600']), '.');
  renderPanels(true);
}
document.getElementById('hist-apply').addEventListener('click', () => {
  if (!histZoom) return;
  fromIn.value = isoDay(histZoom[0]); toIn.value = isoDay(histZoom[1]);
  setKnobs({ hist: false }); if (!STATIC) form.requestSubmit();
});
