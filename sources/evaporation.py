"""Water leaving the lake by evaporation: an estimate, not a measurement.

No public, keyless feed measures evaporation off the Great Salt Lake itself yet. The Utah Geological Survey
started over-water eddy-covariance towers on the railroad causeway in 2026 (AmeriFlux US-UTX south arm,
US-UTY north arm), but no data has been released, and AmeriFlux downloads need an account. So this source
builds a clearly labeled estimate:

    evaporation (in/day) = gridMET grass reference ET over the lake  x  salinity factor 0.884
    evaporation (acre-ft) = that depth / 12 x lake surface area on that day

* gridMET (Abatzoglou 2013, CC0) daily grass reference evapotranspiration, 4 km grid, 1979 to about 2 days ago,
  read keylessly over OPeNDAP from the Northwest Knowledge Network THREDDS server. We average five grid cells
  over open water (three in the south arm, two in the north arm). The last ~60 days are provisional.
* Salinity factor 0.884 = 1.14 m / 1.29 m, the ratio of salt-water to fresh-water evaporation for the whole lake
  in Mohammed & Tarboton (2012, Water Resources Research 48, W11511, Table 2, water years 1950-2010).
  Salt lowers the vapor pressure at the surface, so brine evaporates less than fresh water.
* Check: over 1980-2025 these gridMET cells average about 50 in/yr of reference ET, which is close to the
  paper's 1.29 m (50.8 in) fresh-water figure, and x 0.884 gives about 44 in/yr. The USGS long-term figure is
  "about 45 in. per year" (2.9 million acre-ft, 1931-76; Arnow 1978, USGS Open-File Report 78-912, p. 13).
* Lake area: the server's lake_area table (USGS 2023 elevation-area-volume table) at that day's daily mean
  level at Saltair (USGS 10010000, from the server's dv table).

Days with no gridMET value (before 1979, or the last couple of days) use the 1980-2025 average for that
calendar date and are counted as "filled".

Uncertainty bands are judgment, not statistics: published long-term figures run 36-50 in/yr, and the paper's
climate-based and mass-balance estimates differ by ~9%. Reference ET follows the weather day to day, while a
lake stores heat and evaporates on a lag, so short windows are rougher.
"""
import datetime as dt
import os
import re
import time
import urllib.request

NAME = "evaporation"

DAP = "http://thredds.northwestknowledge.net:8080/thredds/dodsC/agg_met_pet_1979_CurrentYear_CONUS.nc"
VAR = "daily_mean_reference_evapotranspiration_grass"
GRIDMET = "https://www.climatologylab.org/gridmet.html"
GRIDMET_DOI = "https://doi.org/10.1002/joc.3413"
MT2012 = "https://hydrology.usu.edu/dtarb/Mohammed_Tarboton_2012WR011908.pdf"
MT2012_DOI = "https://doi.org/10.1029/2012WR011908"
ARNOW1978 = "https://pubs.usgs.gov/publication/ofr78912"
ARNOW1978_PDF = "https://pubs.usgs.gov/of/1978/0912/report.pdf"
AMERIFLUX_UTX = "https://ameriflux.lbl.gov/sites/siteinfo/US-UTX"
AREA_TABLE = "https://doi.org/10.5066/P9DGG75W"
LICENSE = "gridMET CC0 1.0"

T0 = dt.date(1979, 1, 1)  # time index 0 of the aggregated file
SCALE = 0.1  # packed UInt16 -> mm
FILL = 32767
# (lat index, lon index) on the gridMET grid: lat = 49.4 - i/24, lon = -124.7667 + j/24. Open water at 4,190 ft.
CELLS = [(203, 297), (199, 296), (205, 299),  # south arm: 40.94,-112.39  41.11,-112.43  40.86,-112.31
         (193, 290), (197, 288)]  # north arm: 41.36,-112.68  41.19,-112.77
I0, I1 = min(c[0] for c in CELLS), max(c[0] for c in CELLS)
J0, J1 = min(c[1] for c in CELLS), max(c[1] for c in CELLS)
CHUNK = 365 * 6  # days per request (~10 s each)
RECENT = 70  # gridMET revises the last ~60 days; re-pull this many
REFRESH_SEC = 86400

SCF = round(1.14 / 1.29, 3)  # Mohammed & Tarboton 2012, Table 2
MM_PER_IN = 25.4
LAKE_SITE, LEVEL_PARAM = "10010000", "62614"
AREA_CSV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ref", "gsl_area_ngvd29.csv")
CLIM_YEARS = (1980, 2025)
DAILY_MAX = 400  # longer windows are sent as monthly totals


def _unc(days):
    return 15 if days >= 365 else 25 if days >= 30 else 35


PUBLISHED = [
    {"what": "USGS water budget, 1931-76", "in_per_yr": 45, "af_per_yr": 2_900_000, "range_af": [2_100_000, 3_900_000],
     "cite": "Arnow (1978), USGS Open-File Report 78-912, p. 13", "url": ARNOW1978},
    {"what": "Climate + salinity model, water years 1950-2010", "in_per_yr": round(1.14 / 0.0254, 1), "af_per_yr": round(4.40e9 / 1233.48),
     "fresh_in_per_yr": round(1.29 / 0.0254, 1), "cite": "Mohammed & Tarboton (2012), Water Resources Research 48, W11511, Table 2",
     "url": MT2012_DOI},
]


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_eto ("day" date primary key, eto_mm double, cells integer);
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);
    """)


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, str(v)])


def _get(url, timeout=180):
    req = urllib.request.Request(url, headers={"User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def _n_days():
    """Length of the time axis, from the dataset's structure description."""
    m = re.search(rf"{VAR}\[day = (\d+)\]", _get(f"{DAP}.dds", 60))
    if not m:
        raise RuntimeError("gridMET .dds has no time dimension")
    return int(m.group(1))


def parse_ascii(txt, t_start):
    """OPeNDAP .ascii body -> {date: (mean mm, cells)} over CELLS. Rows look like '[t][i], v, v, ...'."""
    body = txt.split("---------------------------------------------", 1)[1]
    acc = {}
    want = {}
    for i, j in CELLS:
        want.setdefault(i - I0, []).append(j - J0)
    for m in re.finditer(r"^\[(\d+)\]\[(\d+)\], (.*)$", body, re.M):
        cols = want.get(int(m.group(2)))
        if not cols:
            continue
        row = m.group(3).split(", ")
        for c in cols:
            v = int(row[c])
            if v != FILL:
                acc.setdefault(int(m.group(1)), []).append(v * SCALE)
    return {T0 + dt.timedelta(t_start + t): (sum(v) / len(v), len(v)) for t, v in acc.items()}


def pull(t0, t1):
    url = f"{DAP}.ascii?{VAR}%5B{t0}:{t1}%5D%5B{I0}:{I1}%5D%5B{J0}:{J1}%5D"
    return parse_ascii(_get(url), t0)


def _store(con, rows):
    if rows:
        con.executemany(f"insert or replace into {NAME}_eto values (?, ?, ?)",
                        [(d, round(v, 3), n) for d, (v, n) in sorted(rows.items())])


def refresh(con, fetch=None):
    init(con)
    last = _meta(con, "checked")
    if last and time.time() - float(last) < REFRESH_SEC:
        return
    n = _n_days()
    have = con.execute(f'select max("day") from {NAME}_eto').fetchone()[0]
    start = 0 if have is None else max(0, (have - T0).days + 1 - RECENT)
    for t0 in range(start, n, CHUNK):
        _store(con, pull(t0, min(n - 1, t0 + CHUNK - 1)))
    _set(con, "checked", time.time())
    _set(con, "through", (T0 + dt.timedelta(n - 1)).isoformat())


# ------------------------------------------------------------------ query helpers

def _clim(con):
    """Average reference ET for each calendar day (Feb 29 counts as Feb 28), smoothed over +-15 days, mm/day."""
    acc = {}
    for d, v in con.execute(f'select "day", eto_mm from {NAME}_eto where year("day") between ? and ?', list(CLIM_YEARS)).fetchall():
        acc.setdefault(_doy(d), []).append(v)
    if len(acc) < 365:
        return None
    raw = {k: sum(v) / len(v) for k, v in acc.items()}
    return {k: sum(raw[(k - 1 + o) % 365 + 1] for o in range(-15, 16)) / 31 for k in range(1, 366)}


def _doy(d):
    leap = d.year % 4 == 0 and (d.year % 100 != 0 or d.year % 400 == 0)
    return min(d.timetuple().tm_yday - (1 if leap and d.month > 2 else 0), 365)


def _area_fn(con):
    """level ft -> area acres, from the server's lake_area table (or the ref CSV if it isn't there)."""
    try:
        rows = con.execute("select elev_ngvd29_ft, area_acre from lake_area order by 1").fetchall()
    except Exception:
        rows = con.execute(f"select elev_ngvd29_ft, area_acre from read_csv('{AREA_CSV}') order by 1").fetchall()
    import bisect
    xs = [r[0] for r in rows]

    def area(ft):
        if ft is None:
            return None
        k = bisect.bisect_left(xs, ft)
        k = min(max(k, 0), len(xs) - 1)
        if k > 0 and abs(xs[k - 1] - ft) <= abs(xs[k] - ft):
            k -= 1
        return rows[k][1]
    return area


def _levels(con, a, b):
    """Daily mean lake level, carried forward over gaps; {} if the dv table isn't there."""
    try:
        rows = con.execute("""
            select "day", value from dv where site_id = ? and param = ? and "day" <= ?
              and "day" >= coalesce((select max("day") from dv where site_id = ? and param = ? and "day" <= ?), ?)
            order by 1""", [LAKE_SITE, LEVEL_PARAM, b, LAKE_SITE, LEVEL_PARAM, a, a]).fetchall()
    except Exception:
        return {}
    return dict(rows)


def _series(con, a, b):
    """One row per day: (day, eto_mm, filled, level_ft, area_acre)."""
    clim = _clim(con)
    eto = dict(con.execute(f'select "day", eto_mm from {NAME}_eto where "day" between ? and ?', [a, b]).fetchall())
    lv = _levels(con, a, b)
    area = _area_fn(con)
    out, cur = [], None
    first = min(lv) if lv else None
    if first is not None and first < a:
        cur = lv[first]
    d = a
    while d <= b:
        cur = lv.get(d, cur)
        v = eto.get(d)
        filled = v is None
        if filled:
            v = clim[_doy(d)] if clim else None
        out.append((d, v, filled, cur, area(cur)))
        d += dt.timedelta(1)
    return out


def _sum(rows):
    """-> inches, acre-ft (None if any day lacks a level), days filled."""
    e_in = sum(r[1] for r in rows if r[1] is not None) * SCF / MM_PER_IN
    af = None
    if rows and all(r[4] for r in rows):
        af = sum(r[1] * SCF / MM_PER_IN / 12 * r[4] for r in rows if r[1] is not None)
    return e_in, af, sum(1 for r in rows if r[2])


def _r(v, n=0):
    if v is None:
        return None
    return int(round(v, n)) if n <= 0 else round(v, n)


def _annual(con):
    """Water years (Oct-Sep) fully covered by gridMET."""
    span = con.execute(f'select min("day"), max("day") from {NAME}_eto').fetchone()
    if not span[0]:
        return []
    rows = _series(con, dt.date(span[0].year, 10, 1), span[1])
    by = {}
    for r in rows:
        wy = r[0].year + (1 if r[0].month >= 10 else 0)
        by.setdefault(wy, []).append(r)
    out = []
    for wy, rs in sorted(by.items()):
        complete = len(rs) >= 365 and not any(x[2] for x in rs)
        e_in, af, _ = _sum(rs)
        lv = [x[3] for x in rs if x[3] is not None]
        out.append({"wy": wy, "complete": complete, "eto_in": _r(sum(x[1] for x in rs if x[1] is not None) / MM_PER_IN, 1),
                    "evap_in": _r(e_in, 1), "evap_af": _r(af, -4),
                    "level_ft": _r(sum(lv) / len(lv), 1) if lv else None})
    return out


def _links():
    return {"gridmet": GRIDMET, "gridmet_doi": GRIDMET_DOI, "gridmet_data": DAP + ".html", "mohammed_tarboton_2012": MT2012_DOI,
            "mohammed_tarboton_2012_pdf": MT2012, "arnow_1978": ARNOW1978, "arnow_1978_pdf": ARNOW1978_PDF,
            "ameriflux_causeway": AMERIFLUX_UTX, "area_table": AREA_TABLE}


def query(con, window):
    have = con.execute(f'select count(*), min("day"), max("day") from {NAME}_eto').fetchone()
    if not have[0]:
        return {"available": False}
    a, b = window["from_day"], window["to_day"]
    rows = _series(con, a, b)
    e_in, af, filled = _sum(rows)
    n = len(rows)
    unc = _unc(n)
    lv = [r[3] for r in rows if r[3] is not None]
    ar = [r[4] for r in rows if r[4] is not None]
    # the same dates in an average year (calendar-day average, same areas), for "more or less than usual"
    clim = _clim(con)
    normal_in = sum(clim[_doy(r[0])] for r in rows) * SCF / MM_PER_IN if clim else None
    if n <= DAILY_MAX:
        series = {"step": "day", "rows": [{"day": r[0].isoformat(), "in": _r(r[1] * SCF / MM_PER_IN, 3) if r[1] is not None else None,
                                           "af": _r(r[1] * SCF / MM_PER_IN / 12 * r[4]) if r[1] is not None and r[4] else None,
                                           "usual_in": _r(clim[_doy(r[0])] * SCF / MM_PER_IN, 3) if clim else None,
                                           "filled": r[2]} for r in rows]}
    else:
        by = {}
        for r in rows:
            by.setdefault(r[0].strftime("%Y-%m"), []).append(r)
        series = {"step": "month", "rows": []}
        for k, rs in by.items():
            mi, maf, mf = _sum(rs)
            usual = sum(clim[_doy(r[0])] for r in rs) * SCF / MM_PER_IN if clim else None
            series["rows"].append({"month": k, "in": _r(mi, 2), "af": _r(maf), "usual_in": _r(usual, 2),
                                   "filled_days": mf, "days": len(rs)})
    ann = [y for y in _annual(con) if y["complete"]]
    lt = [y["eto_in"] for y in ann if CLIM_YEARS[0] <= y["wy"] <= CLIM_YEARS[1]]
    return {
        "available": True,
        "estimate": True,
        "method": (f"gridMET daily grass reference evapotranspiration averaged over {len(CELLS)} open-water grid cells, "
                   f"times a salinity factor of {SCF} (Mohammed & Tarboton 2012), times the lake area at each day's level."),
        "salinity_factor": SCF,
        "from": a.isoformat(), "to": b.isoformat(), "days": n,
        "days_measured": n - filled, "days_filled": filled,
        "gridmet_through": have[2].isoformat(), "gridmet_from": have[1].isoformat(),
        "provisional_after": (have[2] - dt.timedelta(60)).isoformat(),
        "evap_in": _r(e_in, 2), "evap_af": _r(af, -2) if af is not None and af >= 1e4 else _r(af),
        "uncertainty_pct": unc,
        "low_in": _r(e_in * (1 - unc / 100), 2), "high_in": _r(e_in * (1 + unc / 100), 2),
        "low_af": _r(af * (1 - unc / 100), -2) if af else None, "high_af": _r(af * (1 + unc / 100), -2) if af else None,
        "per_day_in": _r(e_in / n, 3) if n else None,
        "normal_in": _r(normal_in, 2),
        "level_ft": _r(lv[-1], 2) if lv else None, "area_acre": _r(ar[-1]) if ar else None,
        "mean_area_acre": _r(sum(ar) / len(ar)) if ar else None,
        "series": series,
        "annual": [{"wy": y["wy"], "in": y["evap_in"], "af": y["evap_af"], "level_ft": y["level_ft"]} for y in ann],
        "longterm": {"gridmet_eto_in_per_yr": _r(sum(lt) / len(lt), 1) if lt else None,
                     "estimate_in_per_yr": _r(sum(lt) / len(lt) * SCF, 1) if lt else None,
                     "years": list(CLIM_YEARS), "published": PUBLISHED},
        "links": _links(), "license": LICENSE,
    }


def history(con):
    ann = _annual(con)
    if not ann:
        return {"available": False}
    full = [y for y in ann if y["complete"]]
    return {"available": True, "estimate": True, "salinity_factor": SCF, "years": ann,
            "mean_in": _r(sum(y["evap_in"] for y in full) / len(full), 1) if full else None,
            "mean_af": _r(sum(y["evap_af"] for y in full if y["evap_af"]) / max(1, sum(1 for y in full if y["evap_af"])), -4) if full else None,
            "published": PUBLISHED, "links": _links(), "license": LICENSE}
