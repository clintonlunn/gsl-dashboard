// The three knobs: topic (what about the lake), period (from the period form, or "Since 1847" for the long record)
// and view (summary, map or detail). Every block in #stage carries data-topic and data-view; the knobs decide which show.
// data-view="period" blocks belong to the chosen dates and hide for the long record; data-topic="all" shows for every topic.
export const TOPICS = { lake: 'Lake', budget: 'Water budget', rivers: 'Rivers', sky: 'Rain and snow', reservoirs: 'Reservoirs', ground: 'Ground and wetlands', farms: 'Farms' };
export const VIEWS = { summary: 'Summary', map: 'Map', detail: 'Detail' };
export const knobs = { topic: 'lake', view: 'summary', hist: false };

export function fits(n) {
  const v = n.dataset.view;
  if (v === 'period') return !knobs.hist;
  if (!n.dataset.topic.split(' ').some(t => t === 'all' || t === knobs.topic)) return false;
  if (knobs.view === 'map') return v === 'map';
  return knobs.hist ? v === 'history' : v === knobs.view;
}
export function showKnobs() {
  for (const [id, on] of [['topic', knobs.topic], ['view', knobs.view]])
    for (const b of document.querySelectorAll(`#${id} button`)) b.setAttribute('aria-pressed', b.value === on);
  for (const n of document.querySelectorAll('main [data-view]')) n.hidden = !fits(n);
  const facts = document.getElementById('stage-facts');
  facts.hidden = ![...facts.children].some(c => !c.hidden);
  const shown = [...document.querySelectorAll('#stage [data-view]')].some(n => !n.hidden);
  const empty = document.getElementById('stage-empty');
  empty.hidden = shown;
  empty.textContent = shown ? '' : knobs.hist
    ? `${TOPICS[knobs.topic]} records don't go back that far. Pick a shorter period.`
    : `Nothing for ${TOPICS[knobs.topic].toLowerCase()} in the ${VIEWS[knobs.view].toLowerCase()} view. Try ${knobs.view === 'detail' ? 'Summary' : 'Detail'}.`;
}
// the link keeps the dates and all three knobs, so any view can be shared
export function knobQuery(from, to) {
  const q = new URLSearchParams({ from, to });
  if (knobs.topic !== 'lake') q.set('topic', knobs.topic);
  if (knobs.view !== 'summary') q.set('view', knobs.view);
  if (knobs.hist) q.set('period', 'all');
  return `?${q}`;
}
// old links pointed at tabs (#water, #history...); send them to the nearest knob settings
const OLD_TABS = { glance: {}, water: { topic: 'budget' }, history: { hist: true }, ag: { topic: 'farms' }, details: { view: 'detail' } };
export function readKnobs(qs, hash) {
  Object.assign(knobs, OLD_TABS[hash.slice(1)] || {});
  if (qs.get('topic') in TOPICS) knobs.topic = qs.get('topic');
  if (qs.get('view') in VIEWS) knobs.view = qs.get('view');
  if (qs.get('period') === 'all') knobs.hist = true;
}
