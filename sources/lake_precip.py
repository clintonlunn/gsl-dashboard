"""Rain on the lake from weather grids: daily gridded precipitation averaged over the Great Salt Lake's water surface.

Data: PRISM AN daily precipitation, 4 km (1/24 degree), served by NOAA ACIS GridData as grid 21
(https://data.rcc-acis.org/GridData). PRISM interpolates gauge reports onto a grid using its 1991-2020 climate
normals to shape how rain varies across the landscape (Daly et al. 2021); a "PRISM day" is the 24 hours ending at
12:00 UTC (6 AM MDT) and carries that day's date, the same morning-reading convention as the volunteer gauges.
PRISM posts a day about 24 hours after it ends, updates it at 5 days and again at each monthly update (about the
15th) for six months, after which it's final. The newest day or two, which PRISM hasn't posted yet, are filled
from ACIS grid 1 (NRCC interpolated, same 1/24 degree grid, built only from ACIS station reports) and marked so.

Lake mask: grid cells whose centres fall inside the Natural Earth 1:10m lake outline for Great Salt Lake
(ne_10m_lakes v5.1.2, ne_id 1159126421, https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/
geojson/ne_10m_lakes.geojson), simplified here to ~400 m with Antelope, Fremont and Carrington islands cut out.
That outline covers about 4,100 km2 (1.0 million acres, roughly the lake at 4,200 ft), so at today's lower levels
it also takes in exposed lakebed around the edges; 252 PRISM cells fall inside it. ACIS itself can only average
over fixed areas (counties, HUC8 basins...), and the Great Salt Lake HUC8 basin includes a lot of land, so we pull
the small grid around the lake and average the masked cells here.

Tables: lake_precip_daily (one row per day per grid, the lake mean), lake_precip_monthly (PRISM monthly lake means
for the water-year history), lake_precip_pulled (which old months are already cached), lake_precip_meta.
"""
import datetime as dt
import json
import urllib.request

NAME = "lake_precip"

ACIS = "https://data.rcc-acis.org/GridData"
BBOX = "-113.1,40.65,-111.85,41.7"  # just around the outline below
PRISM, NRCC = "21", "1"
GRIDS = {PRISM: "prism", NRCC: "nrcc"}
PRISM_START = dt.date(1981, 1, 1)
REFRESH_SEC = 24 * 3600  # recent days at most once a day
HISTORY_REFRESH_SEC = 30 * 24 * 3600  # monthly totals for the history at most once a month
REVISE_DAYS = 45  # PRISM revises a day at +5 days and at the next monthly update; re-pull these each refresh
NRCC_DAYS = 10  # fill-in grid only for days PRISM hasn't posted yet
MAX_DAYS = 731  # longest window worked out (two years); longer windows get no grid series
MIN_COVER = 0.9  # a day counts only if at least this share of the lake's cells have a value
FINAL_DAYS = 183  # about six months: PRISM's last monthly update
NORMAL_YEARS = (1991, 2020)  # water years for the "normal" in the history

# Great Salt Lake outline (lon, lat), from Natural Earth ne_10m_lakes v5.1.2 (ne_id 1159126421), Douglas-Peucker
# simplified at 0.004 degrees and rounded to 0.001. First ring is the shore, the rest are islands.
RINGS = [
    [
        (-111.95, 40.978), (-111.931, 40.961), (-111.945, 40.947), (-112.024, 40.91), (-112.065, 40.904),
        (-112.12, 40.876), (-112.133, 40.857), (-112.136, 40.816), (-112.184, 40.774), (-112.34, 40.689),
        (-112.367, 40.689), (-112.395, 40.699), (-112.402, 40.706), (-112.394, 40.716), (-112.405, 40.741),
        (-112.406, 40.772), (-112.445, 40.808), (-112.446, 40.856), (-112.484, 40.946), (-112.52, 40.909),
        (-112.531, 40.86), (-112.547, 40.835), (-112.554, 40.829), (-112.562, 40.832), (-112.595, 40.88),
        (-112.634, 40.904), (-112.631, 40.941), (-112.659, 40.939), (-112.684, 40.965), (-112.744, 40.996),
        (-112.752, 41.004), (-112.751, 41.012), (-112.736, 41.032), (-112.776, 41.04), (-112.774, 41.049),
        (-112.756, 41.054), (-112.76, 41.085), (-112.769, 41.096), (-112.768, 41.117), (-112.78, 41.142),
        (-112.78, 41.168), (-112.772, 41.19), (-112.818, 41.228), (-112.843, 41.271), (-112.894, 41.301),
        (-112.916, 41.326), (-112.923, 41.327), (-112.972, 41.303), (-112.969, 41.271), (-113.007, 41.275),
        (-113.016, 41.282), (-113.015, 41.294), (-112.997, 41.326), (-112.942, 41.333), (-112.952, 41.381),
        (-112.997, 41.455), (-113.024, 41.523), (-113.002, 41.521), (-112.999, 41.534), (-112.98, 41.54),
        (-112.978, 41.568), (-113.016, 41.587), (-113.025, 41.605), (-113.011, 41.615), (-112.977, 41.616),
        (-112.937, 41.631), (-112.902, 41.628), (-112.858, 41.636), (-112.825, 41.658), (-112.823, 41.671),
        (-112.811, 41.677), (-112.775, 41.681), (-112.729, 41.662), (-112.7, 41.635), (-112.708, 41.581),
        (-112.74, 41.558), (-112.745, 41.546), (-112.724, 41.502), (-112.706, 41.494), (-112.677, 41.458),
        (-112.637, 41.435), (-112.597, 41.424), (-112.589, 41.426), (-112.581, 41.439), (-112.552, 41.437),
        (-112.516, 41.419), (-112.503, 41.346), (-112.473, 41.323), (-112.482, 41.276), (-112.472, 41.238),
        (-112.46, 41.224), (-112.43, 41.207), (-112.412, 41.207), (-112.397, 41.218), (-112.346, 41.232),
        (-112.346, 41.267), (-112.361, 41.274), (-112.383, 41.331), (-112.4, 41.348), (-112.383, 41.373),
        (-112.385, 41.393), (-112.406, 41.409), (-112.397, 41.454), (-112.361, 41.462), (-112.342, 41.449),
        (-112.326, 41.45), (-112.313, 41.46), (-112.285, 41.448), (-112.269, 41.423), (-112.294, 41.42),
        (-112.277, 41.388), (-112.269, 41.385), (-112.245, 41.389), (-112.222, 41.382), (-112.179, 41.389),
        (-112.143, 41.412), (-112.066, 41.41), (-112.052, 41.38), (-112.055, 41.371), (-112.098, 41.336),
        (-112.127, 41.341), (-112.133, 41.353), (-112.154, 41.328), (-112.204, 41.345), (-112.253, 41.348),
        (-112.292, 41.319), (-112.325, 41.271), (-112.257, 41.265), (-112.251, 41.237), (-112.194, 41.193),
        (-112.179, 41.149), (-112.141, 41.126), (-112.122, 41.082), (-112.104, 41.061), (-111.998, 41.026),
        (-111.966, 41.002), (-111.95, 40.978),
    ],
    [
        (-112.533, 41.006), (-112.52, 41.014), (-112.529, 41.036), (-112.555, 41.03), (-112.554, 41.01),
        (-112.54, 40.991), (-112.533, 41.006),
    ],
    [
        (-112.314, 41.138), (-112.315, 41.159), (-112.343, 41.187), (-112.358, 41.189), (-112.388, 41.179),
        (-112.36, 41.169), (-112.314, 41.138),
    ],
    [
        (-112.167, 40.917), (-112.169, 40.931), (-112.162, 40.955), (-112.166, 40.976), (-112.192, 41.014),
        (-112.194, 41.043), (-112.207, 41.06), (-112.235, 41.075), (-112.248, 41.074), (-112.253, 41.071),
        (-112.25, 41.058), (-112.271, 41.052), (-112.265, 41.039), (-112.245, 41.037), (-112.236, 41.022),
        (-112.248, 41.006), (-112.248, 40.965), (-112.177, 40.873), (-112.167, 40.917),
    ],
]
OUTLINE_KM2 = 4106  # area of the rings above (outer minus islands)


# ---------------------------------------------------------------- helpers

def _fetch(body, timeout=180):
    req = urllib.request.Request(ACIS, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.load(r)
    if "error" in d:
        raise RuntimeError(f"ACIS: {d['error']}")
    return d


def _inside(x, y, ring):
    c = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            c = not c
    return c


def _mask(meta):
    """(row, col) of the grid cells whose centres are on the lake."""
    lat, lon = meta["lat"], meta["lon"]
    return [(i, j) for i in range(len(lat)) for j in range(len(lat[i]))
            if _inside(lon[i][j], lat[i][j], RINGS[0]) and not any(_inside(lon[i][j], lat[i][j], h) for h in RINGS[1:])]


def _reduce(grid, cells):
    """Lake mean, min, max and cell count for one grid (values < -900 are missing), or None if too few cells."""
    v = [grid[i][j] for i, j in cells if grid[i][j] is not None and grid[i][j] > -900]
    if not cells or len(v) < MIN_COVER * len(cells):
        return None
    return sum(v) / len(v), min(v), max(v), len(v)


def _pull_days(grid, start, end):
    """Lake means for each day from start to end (inclusive) from one ACIS grid."""
    d = _fetch({"bbox": BBOX, "sdate": start.isoformat(), "edate": end.isoformat(), "grid": grid,
                "elems": [{"name": "pcpn"}], "meta": "ll"}, timeout=300)
    cells = _mask(d["meta"])
    rows = []
    for day, g in d.get("data", []):
        r = _reduce(g, cells)
        if r:
            rows.append((day, GRIDS[grid], *r))
    return rows, len(cells)


def _store_days(con, rows):
    now = dt.datetime.now().replace(microsecond=0)
    if rows:
        con.executemany(f"insert or replace into {NAME}_daily values (?, ?, ?, ?, ?, ?, ?)", [(*r, now) for r in rows])


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, str(v)])


def _age_sec(con, k):
    t = _meta(con, k)
    return (dt.datetime.now() - dt.datetime.fromisoformat(t)).total_seconds() if t else float("inf")


def _months(a, b):
    out, d = [], dt.date(a.year, a.month, 1)
    while d <= b:
        nxt = dt.date(d.year + d.month // 12, d.month % 12 + 1, 1)
        out.append((d, nxt - dt.timedelta(days=1)))
        d = nxt
    return out


# ---------------------------------------------------------------- contract

def init(con):
    con.execute(f"""
        create table if not exists {NAME}_daily (day date, grid varchar, mean_in double, min_in double, max_in double,
                                                 cells integer, pulled_at timestamp, primary key (day, grid));
        create table if not exists {NAME}_monthly (month date primary key, mean_in double, cells integer);
        create table if not exists {NAME}_pulled (chunk varchar primary key, pulled_at timestamp);
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def refresh(con, fetch=None):
    """Once a day: re-pull the last REVISE_DAYS of PRISM and fill in the newest days from NRCC.
    Once a month: re-pull PRISM monthly totals for the water-year history."""
    init(con)
    today = dt.date.today()
    if _age_sec(con, "refreshed_at") >= REFRESH_SEC:
        rows, cells = _pull_days(PRISM, today - dt.timedelta(days=REVISE_DAYS), today)
        nrcc, _ = _pull_days(NRCC, today - dt.timedelta(days=NRCC_DAYS), today)
        con.execute("begin")
        _store_days(con, rows + nrcc)
        # NRCC rows are only stand-ins; drop them once PRISM has the day
        con.execute(f"""delete from {NAME}_daily where grid = 'nrcc'
                        and day in (select day from {NAME}_daily where grid = 'prism')""")
        con.execute("commit")
        _meta_set(con, "cells", cells)
        _meta_set(con, "refreshed_at", dt.datetime.now().isoformat(timespec="seconds"))
    if _age_sec(con, "history_at") >= HISTORY_REFRESH_SEC:
        last = dt.date(today.year, today.month, 1) - dt.timedelta(days=1)  # through last complete month
        d = _fetch({"bbox": BBOX, "sdate": "1981-10", "edate": f"{last:%Y-%m}", "grid": PRISM, "meta": "ll",
                    "elems": [{"name": "pcpn", "interval": "mly", "duration": "mly", "reduce": "sum"}]}, timeout=300)
        cells = _mask(d["meta"])
        rows = []
        for m, g in d.get("data", []):
            r = _reduce(g, cells)
            if r:
                rows.append((f"{m}-01", r[0], r[3]))
        con.execute("begin")
        con.execute(f"delete from {NAME}_monthly")
        con.executemany(f"insert into {NAME}_monthly values (?, ?, ?)", rows)
        con.execute("commit")
        _meta_set(con, "history_at", dt.datetime.now().isoformat(timespec="seconds"))


def _backfill(con, a, b):
    """Pull PRISM for months in [a, b] older than the revision window that haven't been cached yet.
    Recent days come only from refresh(), so a page load never re-asks for days PRISM hasn't posted."""
    cutoff = dt.date.today() - dt.timedelta(days=REVISE_DAYS)
    have = {r[0] for r in con.execute(f"select chunk from {NAME}_pulled").fetchall()}
    todo = [(s, e) for s, e in _months(max(a, PRISM_START), min(b, cutoff)) if f"{s:%Y-%m}" not in have]
    # one request per run of consecutive months
    spans = []
    for s, e in todo:
        if spans and spans[-1][1] + dt.timedelta(days=1) == s:
            spans[-1][1] = e
        else:
            spans.append([s, e])
    for s, e in spans:
        rows, _ = _pull_days(PRISM, s, min(e, cutoff))
        _store_days(con, rows)
        now = dt.datetime.now().replace(microsecond=0)
        con.executemany(f"insert or replace into {NAME}_pulled values (?, ?)",
                        [(f"{m:%Y-%m}", now) for m, me in _months(s, e) if me <= cutoff])
    return len(spans)


def _status(day, today):
    age = (today - day).days
    return "early" if age <= 5 else "provisional" if age <= FINAL_DAYS else "final"


def query(con, window):
    from_day, to_day, days = window["from_day"], window["to_day"], window["days"]
    out = {
        "dataset": {"name": "PRISM AN daily precipitation", "version": "AN91d (ppt version D2), 4 km",
                    "via": "NOAA ACIS GridData grid 21", "fill_in": "NRCC interpolated grid (ACIS grid 1)",
                    "day": "24 hours ending 6 AM MDT (12:00 UTC) on the date shown",
                    "latency": "posted about a day after the day ends; revised at 5 days and monthly for ~6 months"},
        "mask": {"source": "Natural Earth 1:10m lakes v5.1.2, Great Salt Lake (islands removed)",
                 "area_km2": OUTLINE_KM2, "cells": int(_meta(con, "cells") or 0) or None},
        "window": {"from": from_day.isoformat(), "to": to_day.isoformat(), "days": days},
        "refreshed_at": _meta(con, "refreshed_at"),
    }
    if days > MAX_DAYS:
        return {**out, "error": f"Grid rain on the lake is only worked out for periods up to {MAX_DAYS // 365} years."}
    if to_day < PRISM_START:
        return {**out, "error": "PRISM daily grids start in 1981."}
    try:
        _backfill(con, from_day, to_day)
    except Exception as e:  # noqa: BLE001  serve what's cached
        out["backfill_error"] = str(e)
    rows = con.execute(f"""
        select day, arg_min(grid, case grid when 'prism' then 0 else 1 end) grid,
               arg_min(mean_in, case grid when 'prism' then 0 else 1 end) mean_in,
               arg_min(min_in, case grid when 'prism' then 0 else 1 end) min_in,
               arg_min(max_in, case grid when 'prism' then 0 else 1 end) max_in
        from {NAME}_daily where day between ? and ? group by day order by day""", [from_day, to_day]).fetchall()
    have = {r[0]: r for r in rows}
    today = dt.date.today()
    series = {"day": [], "in": [], "grid": [], "min_in": [], "max_in": [], "status": []}
    d = from_day
    while d <= to_day:
        r = have.get(d)
        series["day"].append(d.isoformat())
        series["in"].append(round(r[2], 3) if r else None)
        series["grid"].append(r[1] if r else None)
        series["min_in"].append(round(r[3], 2) if r else None)
        series["max_in"].append(round(r[4], 2) if r else None)
        series["status"].append((_status(d, today) if r[1] == "prism" else "stand-in") if r else None)
        d += dt.timedelta(days=1)
    got = [v for v in series["in"] if v is not None]
    prism_days = [series["day"][i] for i, g in enumerate(series["grid"]) if g == "prism"]
    latest = con.execute(f"select max(day) from {NAME}_daily where grid = 'prism'").fetchone()[0]
    out.update({
        "series": series,
        "total_in": round(sum(got), 2) if got else None,
        "prism_total_in": round(sum(v for v, g in zip(series["in"], series["grid"]) if g == "prism"), 2) if prism_days else None,
        "days_with_data": len(got), "days_prism": len(prism_days),
        "days_stand_in": series["grid"].count("nrcc"),
        "days_missing": series["in"].count(None),
        "latest_prism_day": latest.isoformat() if latest else None,
    })
    return out


def history(con):
    """PRISM precipitation on the lake by water year (Oct-Sep, named for the year it ends), complete years only."""
    rows = con.execute(f"""
        select year(month + interval 3 month) wy, sum(mean_in) total_in, count(*) n
        from {NAME}_monthly group by 1 having count(*) = 12 order by 1""").fetchall()
    if not rows:
        return {"error": "No PRISM monthly totals pulled yet."}
    normal = [t for wy, t, _ in rows if NORMAL_YEARS[0] <= wy <= NORMAL_YEARS[1]]
    return {
        "dataset": "PRISM AN monthly precipitation (sum of daily grids) via NOAA ACIS GridData grid 21",
        "mask": "Natural Earth 1:10m lakes v5.1.2, Great Salt Lake (islands removed)",
        "water_years": [{"water_year": wy, "total_in": round(t, 2)} for wy, t, _ in rows],
        "normal_in": round(sum(normal) / len(normal), 2) if len(normal) == NORMAL_YEARS[1] - NORMAL_YEARS[0] + 1 else None,
        "normal_years": list(NORMAL_YEARS),
        "pulled_at": _meta(con, "history_at"),
    }
