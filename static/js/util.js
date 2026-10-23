
// ---------------------------------------------------------------- helpers
export const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const fmtInt = (v) => nf0.format(v);
export const fmt1 = (v) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v);
export const parseDay = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const parseHour = (s) => new Date(s.length > 10 ? s : s + 'T00:00');
export const pad = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const fmtDay = (d, withYear) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
const fmtHour = (d) => d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' });
export const GAL_PER_AF = 325851, POOL_GAL = 660430;
export const RIVER_COLOR = { 'Bear River': '--bear', 'Weber River': '--weber', 'Jordan River': '--jordan' };
export const pretty = (n) => n >= 1e12 ? `${(n / 1e12).toFixed(1)} trillion` : n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} billion` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} million` : fmtInt(n);
export const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
export const b = (t) => el('b', { textContent: t });
export const USGS = (id) => `https://waterdata.usgs.gov/monitoring-location/${id}/`;
export const link = (text, href) => el('a', { textContent: text, href });
export const gaugeLinks = (ids) => ids.flatMap((id, i) => [i ? ', ' : '', link(id, USGS(id))]);
export const ACIS = () => link('NOAA ACIS', 'https://www.rcc-acis.org/');
export const cite = (id, ...parts) => { const e = document.getElementById(id); if (e) e.replaceChildren('Source: ', ...parts); };
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bUt\b|\bUtah\b/g, '').trim();
export const shortName = (s) => {
  if (s.role === 'lake') return 'Lake level, Saltair';
  if (s.site_id === '10170500') return 'Jordan River (Surplus Canal)';
  if (s.site_id === '10172600') return 'Jordan River (Cudahy Ln)';
  return titleCase(s.name.replace(/,? (UT|UTAH|ID)$/i, '').replace(/ (NR|NEAR|AB|BL|ABV|AT|@) .*$/i, '')) || s.name;
};
export const ratioOf = (s) => s.latest_cfs != null && s.baseline_cfs > 0 ? s.latest_cfs / s.baseline_cfs : null;
export const timesNormal = (s) => {
  const r = ratioOf(s);
  if (r == null) return 'no data';
  if (r >= 0.85 && r < 1.15) return 'normal';
  return r < 1 ? `${Math.round(r * 100)}% of normal` : `${r.toFixed(r < 10 ? 1 : 0)}× normal`;
};
