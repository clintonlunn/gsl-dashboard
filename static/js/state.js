// shared page state: the period's data and the history, filled in by main.js and history.js
export const state = { DATA: null, HIST: null };
// the GitHub Pages copy has no server: the export step writes the same JSON under data/ and inlines GSL_STATIC
export const STATIC = window.GSL_STATIC || null;
export const api = {
  panels: () => fetch(STATIC ? 'data/panels.json' : '/api/panels'),
  history: () => fetch(STATIC ? 'data/history.json' : '/api/history'),
  data: (from, to) => {
    if (!STATIC) return fetch(`/api/data?${new URLSearchParams({ from, to })}`);
    const w = STATIC.windows.find(x => x.from === from && x.to === to);
    if (!w) return Promise.resolve(new Response(JSON.stringify({ error: 'This published copy only has the preset periods. Run the dashboard locally for other dates' }), { status: 404 }));
    return fetch(w.file);
  },
};
