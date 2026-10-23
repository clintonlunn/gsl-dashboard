import { state } from './state.js';
import { addDays, css, el, fmtInt, parseDay } from './util.js';

// ---------------------------------------------------------------- echarts
export const charts = {};
// a top-left legend wraps on narrow charts; push the plot down by the extra rows so the legend doesn't sit on it
export const measure = document.createElement('canvas').getContext('2d');
function fitLegend(opt, width) {
  const L = opt.legend;
  if (!L || Array.isArray(L) || L.show === false || L.type === 'scroll' || L.orient === 'vertical' || !opt.grid || typeof opt.grid.top !== 'number') return opt;
  const names = (L.data || [].concat(opt.series || []).map(x => x?.name)).map(n => typeof n === 'object' ? n?.name : n).filter(Boolean);
  const fs = L.textStyle?.fontSize || 12;
  measure.font = `${fs}px "IBM Plex Mono", monospace`;
  const gap = L.itemGap ?? 10, icon = (L.itemWidth ?? 25) + 5, avail = width - (typeof L.left === 'number' ? L.left : 0) - 8;
  let rows = 1, x = 0;
  for (const n of new Set(names)) {
    const w = icon + measure.measureText(String(n)).width;
    if (x && x + w > avail) { rows++; x = 0; }
    x += w + gap;
  }
  if (rows > 1) opt.grid = { ...opt.grid, top: opt.grid.top + (rows - 1) * (Math.max(L.itemHeight ?? 14, fs * 1.3) + gap) };
  return opt;
}
// containLabel sizes the axes with the axis label's own font, not the global textStyle, so labels drawn in Plex Mono
// overran the edge; name the font on every axis label
function axisFonts(opt) {
  for (const k of ['xAxis', 'yAxis']) {
    if (!opt[k]) continue;
    const axes = [].concat(opt[k]).map(a => a && a.axisLabel?.fontFamily == null ? { ...a, axisLabel: { ...(a.axisLabel || {}), fontFamily: opt.textStyle?.fontFamily || 'IBM Plex Mono' } } : a);
    opt[k] = Array.isArray(opt[k]) ? axes : axes[0];
  }
  return opt;
}
export function chart(id) {
  const node = document.getElementById(id);
  if (!charts[id]) {
    const inst = charts[id] = echarts.init(node, null, { renderer: 'svg' });
    const set = inst.setOption.bind(inst);
    inst.setOption = (opt, ...rest) => set(opt ? fitLegend(axisFonts(opt), node.clientWidth || inst.getWidth()) : opt, ...rest);
  }
  return charts[id];
}
export function emptyChart(id, text) {
  chart(id).setOption({ title: { text, left: 'center', top: 'middle', textStyle: { color: css('--ink-2'), fontSize: 14, fontWeight: 400, fontFamily: 'IBM Plex Sans' } }, series: [] }, true);
}
export const base = () => {
  const ink2 = css('--ink-2'), grid = css('--grid-major');
  return {
    aria: { enabled: true, decal: { show: false } },
    animation: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    textStyle: { fontFamily: 'IBM Plex Mono', fontSize: 12, color: ink2 },
    grid: { left: 12, right: 16, top: 16, bottom: 28, containLabel: true },
    tooltip: { trigger: 'axis', backgroundColor: css('--paper'), borderColor: css('--ink'), borderWidth: 1, borderRadius: 0,
      textStyle: { color: css('--ink'), fontFamily: 'IBM Plex Mono', fontSize: 12 }, axisPointer: { type: 'line', lineStyle: { color: ink2 } } },
    xAxis: { type: 'time', axisLine: { lineStyle: { color: css('--rule') } }, axisLabel: { color: ink2, hideOverlap: true }, splitLine: { show: false } },
    yAxis: { type: 'value', axisLabel: { color: ink2 }, splitLine: { lineStyle: { color: grid } } },
  };
};
export function lineChart(id, series, opts) {
  const live = series.filter(s => s.points.length);
  if (!live.length) return emptyChart(id, 'No readings for this period.');
  const win = state.DATA.window;
  const o = base();
  o.aria.label = { enabled: true, description: opts.alt };
  o.yAxis = { ...o.yAxis, scale: opts.zero === false, axisLabel: { color: css('--ink-2'), formatter: opts.axisFmt || ((v) => fmtInt(v)) } };
  o.tooltip.valueFormatter = (v) => v == null ? '—' : `${opts.fmt(v)}${opts.unit}`;
  o.legend = live.length > 1 ? { top: 0, left: 0, textStyle: { color: css('--ink') }, icon: 'rect', itemHeight: 3 } : undefined;
  if (o.legend) o.grid.top = 32;
  o.dataZoom = opts.zoom ? [{ type: 'inside' }] : [];
  o.series = live.map((s, i) => ({
    name: s.name, type: 'line', showSymbol: false, sampling: 'lttb', lineStyle: { width: 2, color: s.color }, itemStyle: { color: s.color },
    data: s.points.map(p => [p.t, p.v]),
    markLine: s.baseline != null ? { silent: true, symbol: 'none', label: { show: false }, lineStyle: { type: 'dashed', color: s.color, width: 1.5 }, data: [{ yAxis: s.baseline }] } : undefined,
    markArea: i === 0 ? { silent: true, itemStyle: { color: css('--grid'), opacity: .6 }, data: [[{ xAxis: parseDay(win.from) }, { xAxis: addDays(parseDay(win.to), 1) }]] } : undefined,
  }));
  chart(id).setOption(o, true);
}

export function barChart(id, rows, median) {
  const node = document.getElementById(id);
  if (!rows.length) { node.style.height = '120px'; return emptyChart(id, 'No rain reports for this period.'); }
  node.style.height = `${rows.length * 22 + 60}px`;
  const o = base();
  const counted = rows.filter(r => r.counted).length;
  o.aria.label = { enabled: true, description: `Rain at ${rows.length} stations, from ${rows[rows.length - 1].total_in.toFixed(2)} to ${rows[0].total_in.toFixed(2)} inches. ${counted} lowland stations count toward the lake estimate${median != null ? `; their middle value is ${median.toFixed(2)} inches` : ''}. A table of every station follows.` };
  o.tooltip = { ...o.tooltip, trigger: 'item', formatter: (p) => { const r = rows[p.dataIndex]; return `${r.station}<br>${r.total_in.toFixed(2)} in · ${r.elev_ft == null ? '' : fmtInt(r.elev_ft) + ' ft'}<br>${r.counted ? 'Counted' : 'Not counted'}`; } };
  o.xAxis = { type: 'value', axisLabel: { color: css('--ink-2'), formatter: (v) => `${v} in` }, splitLine: { lineStyle: { color: css('--grid-major') } } };
  // value labels sit right of the bars; on a phone long station names are cut short (the tooltip and table have them whole)
  o.grid = { ...o.grid, right: 44 };
  const narrow = node.clientWidth < 560;
  o.yAxis = { type: 'category', inverse: true, data: rows.map(r => r.station), axisTick: { show: false }, axisLine: { lineStyle: { color: css('--rule') } },
    axisLabel: { color: css('--ink-2'), fontSize: 12, ...(narrow ? { width: 140, overflow: 'truncate' } : {}) } };
  o.series = [{ type: 'bar', barMaxWidth: 16, label: { show: true, position: 'right', color: css('--ink'), formatter: (p) => p.value.toFixed(2) },
    data: rows.map(r => ({ value: r.total_in, itemStyle: r.counted ? { color: css('--pen') }
      : { color: 'transparent', borderColor: css('--off'), borderWidth: 1.5, decal: { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [2, 3], rotation: Math.PI / 4, color: css('--off') } } })),
    markLine: median != null ? { silent: true, symbol: 'none', label: { show: false }, lineStyle: { type: 'dashed', color: css('--ink'), width: 1.5 }, data: [{ xAxis: median }] } : undefined }];
  chart(id).setOption(o, true);
  // a real table for screen readers
  let tbl = node.parentElement.querySelector('table.sr-only');
  if (!tbl) { tbl = el('table', { className: 'sr-only' }); node.after(tbl); }
  tbl.replaceChildren(el('caption', { textContent: 'Rain by station' }),
    el('thead', {}, el('tr', {}, ...['Station', 'Rain (in)', 'Elevation (ft)', 'Counted'].map(t => el('th', { scope: 'col', textContent: t })))),
    el('tbody', {}, ...rows.map(r => el('tr', {}, ...[r.station, r.total_in.toFixed(2), r.elev_ft == null ? '' : fmtInt(r.elev_ft), r.counted ? 'Yes' : 'No'].map(t => el('td', { textContent: t }))))));
}
