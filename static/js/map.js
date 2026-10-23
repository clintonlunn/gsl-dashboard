import { load } from './main.js';
import { state } from './state.js';
import { USGS, b, css, el, fmt1, fmtDay, fmtInt, link, pad, parseDay, shortName, timesNormal } from './util.js';

// ---------------------------------------------------------------- map
let MAP = null, POPUP = null;
export function drawMap(img, sites, bySite, lake, priority) {
  const holder = document.getElementById('map');
  const imgNote = document.getElementById('imagery-note');
  if (img) imgNote.replaceChildren('Satellite picture: ', link('Copernicus Sentinel-2', 'https://planetarycomputer.microsoft.com/dataset/sentinel-2-l2a'), `, clearest passes from ${fmtDay(parseDay(img.oldest))} to ${fmtDay(parseDay(img.newest))}, shown when zoomed in; zoomed out shows EOX's 2024 cloud-free mosaic. Both show recent shorelines, not the ones for older periods.`);
  else imgNote.textContent = 'Satellite picture unavailable right now.';
  const features = sites.map(gg => {
    const s = bySite[gg.site_id], isLake = gg.role === 'lake', live = isLake ? !!lake : s && s.readings > 0;
    const name = shortName(gg);
    const value = isLake ? (lake ? `${fmt1(lake.latest_ft)} ft` : 'no reading') : live ? timesNormal(s) : 'no data';
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [gg.lon, gg.lat] }, properties: {
      site_id: gg.site_id, name, value, label: `${name} · ${value}`, kind: isLake ? 'lake' : live ? 'live' : 'off',
      rank: priority.get(gg.site_id) ?? 100,
      detail: isLake ? `USGS ${gg.site_id}` : live ? `USGS ${gg.site_id}<br>Now ${fmtInt(s.latest_cfs)} cfs, normal ${fmtInt(s.baseline_cfs)} cfs` : `USGS ${gg.site_id}<br>No readings this period` } };
  });
  const list = document.getElementById('map-list');
  list.replaceChildren(...features.sort((a, c) => a.properties.rank - c.properties.rank).map(f => el('li', { textContent: `${f.properties.name}: ${f.properties.value}` })));
  if (!window.maplibregl || !sites.length) { holder.hidden = true; return; }
  const data = { type: 'FeatureCollection', features };
  if (!MAP) {
    const padDeg = 0.05;
    const core = sites.filter(s => s.role !== 'upstream');
    const bounds = [[Math.min(...core.map(s => s.lon)) - padDeg, Math.min(...core.map(s => s.lat)) - padDeg], [Math.max(...core.map(s => s.lon)) + padDeg, Math.max(...core.map(s => s.lat)) + padDeg]];
    MAP = new maplibregl.Map({
      container: holder, bounds, fitBoundsOptions: { padding: 30 }, maxZoom: 14, minZoom: 6, dragRotate: false, pitchWithRotate: false,
      cooperativeGestures: true, attributionControl: { compact: matchMedia('(max-width: 599px)').matches },
      style: { version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf', sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': css('--grid') } }] },
    });
    MAP.touchZoomRotate.disableRotation();
    MAP.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // compact credits open on load; keep them folded behind the (i) so they don't cover a phone-sized map
    MAP.once('idle', () => holder.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'));
    MAP.getCanvas().setAttribute('aria-label', 'Satellite map of the gauges. The same gauges are listed for screen readers after the map.');
    MAP.on('click', 'gauges', (e) => {
      const p = e.features[0].properties;
      POPUP?.remove();
      POPUP = new maplibregl.Popup({ closeButton: true, offset: 10 }).setLngLat(e.features[0].geometry.coordinates).setHTML(`<b>${p.name}</b><br>${p.value}<br>${p.detail}`).addTo(MAP);
    });
    MAP.on('mouseenter', 'gauges', () => { MAP.getCanvas().style.cursor = 'pointer'; });
    MAP.on('mouseleave', 'gauges', () => { MAP.getCanvas().style.cursor = ''; });
  }
  const apply = () => {
    if (!MAP.getSource('s2-year')) {
      MAP.addSource('s2-year', { type: 'raster', tileSize: 256, maxzoom: 14,
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'],
        attribution: 'Zoomed-out picture: <a href="https://s2maps.eu">Sentinel-2 cloudless 2024 by EOX</a> (Contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0' });
      MAP.addLayer({ id: 's2-year', type: 'raster', source: 's2-year' });
    }
    if (img && MAP.__tiles !== img.tiles) {
      ['s2'].forEach(id => { if (MAP.getLayer(id)) MAP.removeLayer(id); if (MAP.getSource(id)) MAP.removeSource(id); });
      MAP.addSource('s2', { type: 'raster', tiles: [img.tiles], tileSize: 256, minzoom: 9, maxzoom: 14, attribution: `Contains modified Copernicus Sentinel data ${img.newest.slice(0, 4)}, via Microsoft Planetary Computer` });
      MAP.addLayer({ id: 's2', type: 'raster', source: 's2' }, MAP.getLayer('places') ? 'places' : undefined);
      MAP.__tiles = img.tiles;
    }
    if (!MAP.getSource('places')) {
      MAP.addSource('places', { type: 'raster', tileSize: 256, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Place names: Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community' });
      MAP.addLayer({ id: 'places', type: 'raster', source: 'places', paint: { 'raster-opacity': .85 } });
    }
    if (MAP.getSource('gauges')) { MAP.getSource('gauges').setData(data); return; }
    MAP.addSource('gauges', { type: 'geojson', data });
    MAP.addLayer({ id: 'gauges', type: 'circle', source: 'gauges', paint: {
      'circle-radius': ['case', ['==', ['get', 'kind'], 'lake'], 8, ['<', ['get', 'rank'], 100], 6.5, 5],
      'circle-color': ['match', ['get', 'kind'], 'lake', css('--pen'), 'live', '#11181c', '#f4f6f3'],
      'circle-stroke-color': ['match', ['get', 'kind'], 'off', '#11181c', '#f4f6f3'], 'circle-stroke-width': 2 } });
    // labels collide: lower rank wins; the rest hide until you zoom in
    MAP.addLayer({ id: 'gauge-labels', type: 'symbol', source: 'gauges', layout: {
      // zoomed out: lake, river mouths and the 3 upstream gauges furthest above normal; zoom in for the rest
      'text-field': ['step', ['zoom'], ['case', ['<', ['get', 'rank'], 13], ['get', 'label'], ''], 10, ['get', 'label']], 'text-font': ['Noto Sans Regular'], 'text-size': ['case', ['<', ['get', 'rank'], 10], 13, 12],
      'symbol-sort-key': ['get', 'rank'], 'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 0.9,
      'text-justify': 'auto', 'text-max-width': 14, 'text-optional': true, 'text-padding': 3 },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#0c100f', 'text-halo-width': 2, 'text-halo-blur': .5 } });
  };
  MAP.loaded() ? apply() : MAP.once('load', apply);
  drawWetlands(); drawRadar();
}

// optional layer: UGS wetland plant-survey sites (from the ugs_wetlands source)
function drawWetlands() {
  const sites = state.DATA?.sources?.ugs_wetlands?.sites;
  const on = document.getElementById('show-wetlands').checked;
  if (!MAP || !Array.isArray(sites)) return;
  const go = () => {
    const data = { type: 'FeatureCollection', features: sites.map(s => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { ref: s.cond === 'reference' ? 1 : 0, label: `UGS wetland site ${s.id}: ${s.cond}${s.type ? ', ' + s.type : ''}${s.year ? ', surveyed ' + s.year : ''}${s.native_pct != null ? `, ${Math.round(s.native_pct)}% native plant cover` : ''}` } })) };
    if (!MAP.getSource('wetlands')) {
      MAP.addSource('wetlands', { type: 'geojson', data });
      MAP.addLayer({ id: 'wetlands', type: 'circle', source: 'wetlands', paint: {
        'circle-radius': 4, 'circle-color': ['case', ['==', ['get', 'ref'], 1], css('--healthy'), 'rgba(0,0,0,0)'],
        'circle-stroke-color': css('--healthy'), 'circle-stroke-width': 1.5 } }, MAP.getLayer('gauges') ? 'gauges' : undefined);
      MAP.on('click', 'wetlands', (e) => { POPUP?.remove(); POPUP = new maplibregl.Popup({ offset: 8 }).setLngLat(e.features[0].geometry.coordinates).setText(e.features[0].properties.label).addTo(MAP); });
    } else MAP.getSource('wetlands').setData(data);
    MAP.setLayoutProperty('wetlands', 'visibility', on ? 'visible' : 'none');
  };
  MAP.loaded() ? go() : MAP.once('load', go);
}
document.getElementById('show-wetlands').addEventListener('change', drawWetlands);

// live radar: NWS NEXRAD mosaic tiles from the Iowa Environmental Mesonet, swapped for a new frame every 5 minutes.
// The loop plays the last 3, 12 or 24 hours; each past frame is its own layer, faded in and out so tiles stay loaded.
const RADAR_TILES = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';
const RADAR_PAST = (t) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${t}/{z}/{x}/{y}.png`;
const RADAR_META = 'https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.json';
const RADAR_OPACITY = .6;
// hours -> frame count and minutes between frames; longer loops take bigger steps so a phone loads at most ~48 frames
const SPANS = { 3: { steps: 18, min: 10 }, 12: { steps: 24, min: 30 }, 24: { steps: 48, min: 30 } };
let LOOP_STEPS = 18, LOOP_MIN = 10;
const utcStamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
const clock = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
// long loops reach back into yesterday, so name the day for frames that aren't from today
const frameClock = (d) => d.toDateString() === new Date().toDateString() ? clock(d) : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${clock(d)}`;
const loopBtn = document.getElementById('radar-play'), loopSlider = document.getElementById('radar-slider'), loopSpan = document.getElementById('radar-span');
let radarTimer = null, radarValid = '', loopBuiltFor = '', loopTimer = null;
const frameTime = (i) => new Date(new Date(radarValid).getTime() - (LOOP_STEPS - i) * LOOP_MIN * 60000);
const frameLayers = () => MAP ? MAP.getStyle().layers.filter(l => l.id.startsWith('radar')).map(l => l.id) : [];
function showFrame(i) {
  loopSlider.value = i;
  const t = frameTime(i), latest = i === LOOP_STEPS;
  loopSlider.setAttribute('aria-valuetext', `${frameClock(t)}${latest ? ', latest' : ''}`);
  document.getElementById('radar-time').textContent = radarValid ? `(${frameClock(t)}${latest ? '' : ', replay'})` : '';
  for (const id of frameLayers()) MAP.setPaintProperty(id, 'raster-opacity', id === (latest ? 'radar' : `radar-${i}`) ? RADAR_OPACITY : 0);
}
function buildLoop() {
  const key = `${radarValid}|${loopSpan.value}`;
  if (loopBuiltFor === key || !MAP?.getLayer('radar')) return;
  for (const id of frameLayers()) if (id !== 'radar') { MAP.removeLayer(id); MAP.removeSource(id); }
  for (let i = 0; i < LOOP_STEPS; i++) {
    MAP.addSource(`radar-${i}`, { type: 'raster', tiles: [RADAR_PAST(utcStamp(frameTime(i)))], tileSize: 256, maxzoom: 11 });
    MAP.addLayer({ id: `radar-${i}`, type: 'raster', source: `radar-${i}`, paint: { 'raster-opacity': 0, 'raster-opacity-transition': { duration: 0 }, 'raster-fade-duration': 0 } }, 'radar');
  }
  loopBuiltFor = key;
}
function stopLoop() { clearInterval(loopTimer); loopTimer = null; loopBtn.setAttribute('aria-pressed', 'false'); loopBtn.textContent = 'Play'; }
function playLoop() {
  buildLoop();
  if (+loopSlider.value >= LOOP_STEPS) showFrame(0);
  loopBtn.setAttribute('aria-pressed', 'true'); loopBtn.textContent = 'Pause';
  let hold = 0;
  loopTimer = setInterval(() => {
    const i = +loopSlider.value;
    if (i < LOOP_STEPS) return showFrame(i + 1);
    if (++hold > 3) { hold = 0; showFrame(0); } // linger on the latest frame before starting over
  }, Math.max(200, 9000 / LOOP_STEPS)); // about 9 s a pass whatever the length
}
loopBtn.addEventListener('click', () => loopTimer ? stopLoop() : playLoop());
loopSlider.addEventListener('input', () => { stopLoop(); buildLoop(); showFrame(+loopSlider.value); });
loopSpan.addEventListener('change', () => {
  const playing = !!loopTimer, sp = SPANS[loopSpan.value];
  stopLoop();
  LOOP_STEPS = sp.steps; LOOP_MIN = sp.min;
  loopSlider.max = LOOP_STEPS;
  loopSlider.setAttribute('aria-label', `Radar time, last ${loopSpan.value} hours in ${LOOP_MIN}-minute steps`);
  if (MAP?.getLayer('radar')) showFrame(LOOP_STEPS);
  if (playing) playLoop();
});
async function drawRadar() {
  const on = document.getElementById('show-radar').checked;
  clearTimeout(radarTimer);
  document.getElementById('radar-loop').hidden = !on;
  if (!MAP) return;
  if (!on) { stopLoop(); for (const id of frameLayers()) MAP.setLayoutProperty(id, 'visibility', 'none'); document.getElementById('radar-time').textContent = ''; return; }
  const was = radarValid;
  try { radarValid = (await fetch(RADAR_META, { cache: 'no-store' }).then(r => r.json())).meta.valid; } catch { /* keep the last frame */ }
  const go = () => {
    const tiles = [`${RADAR_TILES}?v=${encodeURIComponent(radarValid)}`];
    if (!MAP.getSource('radar')) {
      MAP.addSource('radar', { type: 'raster', tiles, tileSize: 256, maxzoom: 11, attribution: 'Radar: NWS NEXRAD via <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a>' });
      MAP.addLayer({ id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': RADAR_OPACITY, 'raster-opacity-transition': { duration: 0 }, 'raster-fade-duration': 0 } }, ['wetlands', 'gauges'].find(id => MAP.getLayer(id)));
    } else if (radarValid !== was) MAP.getSource('radar').setTiles(tiles);
    for (const id of frameLayers()) MAP.setLayoutProperty(id, 'visibility', 'visible');
    // a new live frame shifts the whole loop window; rebuild it if it was in use
    if (radarValid !== was && loopBuiltFor) { const playing = !!loopTimer; stopLoop(); buildLoop(); if (playing) playLoop(); }
    if (!loopTimer) showFrame(+loopSlider.value);
  };
  // 'load' may have fired already, so wait for the style, not the first load
  MAP.isStyleLoaded() ? go() : MAP.once('idle', go);
  radarTimer = setTimeout(drawRadar, 5 * 60 * 1000);
}
document.getElementById('show-radar').addEventListener('change', drawRadar);
export const resizeMap = () => MAP?.resize();
