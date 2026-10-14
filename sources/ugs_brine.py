"""How salty the lake is: Utah Geological Survey Great Salt Lake brine sampling, 1966-2011.

Source: UGS Open-File Report 596, "Great Salt Lake brine chemistry database, 1966-2011" (Rupke & McDonald,
2012), Appendix A spreadsheet, found through the UGS data warehouse STAC catalog
(https://maps-assets.geology.utah.gov/warehouse/stac/catalog.json, item OFR-596 in collection OFR).
One sheet per sampling site; each row is one depth in a profile on one date, with brine density, major ions
and salinity as weight percent total dissolved solids (WT%-TDS).

The causeway (1959) splits the lake. Sites are grouped into the north arm (Gunnison Bay, cut off from the rivers)
and the south arm (Gilbert Bay, which gets most river water). Bear River Bay, causeway-breach and
borderline sites are kept in the table as arm 'other' but left out of the arm averages.
"""
from . import _ugs
import datetime as dt
import os
import tempfile
import time
import urllib.request

from . import _xls

NAME = "ugs_brine"

XLS_URL = f"{_ugs.PUBS}/open_file_reports/OFR-596/AppA.xls"
REPORT_URL = f"{_ugs.PUBS}/open_file_reports/OFR-596/OFR-596.pdf"
STAC_ITEM = f"{_ugs.WAREHOUSE_STAC}/ugs-publications/OFR/OFR-596/OFR-596.json"
STAC_COLLECTION = f"{_ugs.WAREHOUSE_STAC}/ugs-publications/OFR/collection.json"
CATALOG_APP = _ugs.CATALOG_APP
UGS = _ugs.HOME + "/"
LICENSE = "CC-BY-4.0"

CHECK_SEC = 86400  # the file is a 2012 archive; look for a new copy at most daily
SHALLOW_FT = 10  # upper brine only; the south arm has a denser deep layer below ~20 ft
MAX_PCT = 30  # salt saturates near 27%; higher values are entry errors

NORTH = {"LVG1", "LVG2", "LVG3", "LVG4", "LVG5", "RD1", "RD2", "RD3", "RD4", "NML", "SJ-1"}
SOUTH = {"AS1", "AS2", "AS3", "AS4", "AS5", "AC1", "AC2", "AC3", "AC4", "FB1", "FB2", "FB3", "FB4",
         "RT1", "RT2", "RT4", "SS", "MI", "HI", "SI", "NLI", "NLN"}

COLS = {"DATE": "day", "DEPTH-FT": "depth_ft", "WT%-TDS": "wt_pct_tds", "TDS (g/L)": "tds_gl",
        "LAB-DEN (g/cm3)": "lab_den", "FIELD-DEN (g/cm3)": "field_den", "LK-ELEV (feet)": "lake_elev_ft"}


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_samples (site varchar, arm varchar, lat double, lon double, "day" date,
            depth_ft double, wt_pct_tds double, tds_gl double, density double, lake_elev_ft double);
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);
    """)


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, str(v)])


def _num(v):
    if isinstance(v, float):
        return v
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def parse(data):
    """Workbook bytes -> list of sample tuples matching the samples table."""
    book = _xls.read_xls(data)
    coords = {}
    for (r, c), v in book.get("Sample Site Coordinates", {}).items():
        if c == 0 and r >= 4 and isinstance(v, str):
            cells = book["Sample Site Coordinates"]
            lon, lat = _num(cells.get((r, 3))), _num(cells.get((r, 4)))  # NAD83
            coords[v.strip()] = (lat, lon)
    rows = []
    for sheet, cells in book.items():
        if sheet == "Sample Site Coordinates" or not cells:
            continue
        ncol = max(c for _, c in cells) + 1
        head = {" ".join(str(cells.get((0, c)) or "").split()): c for c in range(ncol)}
        idx = {key: head.get(name) for name, key in COLS.items()}
        if idx["day"] is None or idx["wt_pct_tds"] is None:
            continue  # density-only sheets (RT3, IS1, causeway sites) have no salinity column
        site = sheet.strip()
        arm = "north" if site in NORTH else "south" if site in SOUTH else "other"
        lat, lon = coords.get(site, (None, None))
        for r in range(1, max(r for r, _ in cells) + 1):
            g = {k: (_num(cells.get((r, c))) if c is not None else None) for k, c in idx.items()}
            if g["day"] is None or g["wt_pct_tds"] is None:
                continue
            day = dt.date(1899, 12, 30) + dt.timedelta(days=int(g["day"]))
            rows.append((site, arm, lat, lon, day.isoformat(), g["depth_ft"], g["wt_pct_tds"], g["tds_gl"],
                         g["lab_den"] if g["lab_den"] is not None else g["field_den"], g["lake_elev_ft"]))
    return rows


def _head(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return f"{r.headers.get('Last-Modified')}|{r.headers.get('Content-Length')}"


def refresh(con, fetch=None):
    init(con)
    last = _meta(con, "checked")
    have = con.execute(f"select count(*) from {NAME}_samples").fetchone()[0]
    if have and last and time.time() - float(last) < CHECK_SEC:
        return
    stamp = _head(XLS_URL)
    if have and stamp == _meta(con, "stamp"):
        _set(con, "checked", time.time())
        return
    req = urllib.request.Request(XLS_URL, headers={"User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=300) as r:
        rows = parse(r.read())
    if not rows:
        raise RuntimeError("OFR-596 workbook parsed to zero samples")
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
        for row in rows:
            f.write(",".join("" if v is None else str(v) for v in row) + "\n")
    try:
        con.execute("begin")
        con.execute(f"delete from {NAME}_samples")
        con.execute(f"""insert into {NAME}_samples select * from read_csv('{f.name}', header=false, nullstr='',
            columns={{'site':'VARCHAR','arm':'VARCHAR','lat':'DOUBLE','lon':'DOUBLE','day':'DATE','depth_ft':'DOUBLE',
                      'wt_pct_tds':'DOUBLE','tds_gl':'DOUBLE','density':'DOUBLE','lake_elev_ft':'DOUBLE'}})""")
        con.execute("commit")
    except Exception:
        con.execute("rollback")
        raise
    finally:
        os.unlink(f.name)
    _set(con, "stamp", stamp)
    _set(con, "checked", time.time())


# one value per arm per sampling date (median of the upper-brine samples across that arm's sites), so heavily
# sampled years don't count more
PER_DATE = f"""
    select arm, "day", median(wt_pct_tds) as pct, count(distinct site) as sites, median(lake_elev_ft) as lake_ft
    from {NAME}_samples
    where arm in ('north', 'south') and depth_ft is not null and depth_ft <= {SHALLOW_FT}
      and wt_pct_tds > 0 and wt_pct_tds <= {MAX_PCT}
    group by all
"""


def _r(v, n=1):
    return None if v is None else round(v, n)


def query(con, window):
    """The record ends in 2011, so the window only matters if it reaches back that far."""
    span = con.execute(f'select min("day"), max("day"), count(*) from ({PER_DATE})').fetchone()
    if not span[2]:
        return {"available": False}
    rows = con.execute(f"""select arm, median(pct), count(*) from ({PER_DATE}) where "day" between ? and ? group by arm""",
                       [window["from_day"], window["to_day"]]).fetchall()
    return {"available": True, "record": [span[0].isoformat(), span[1].isoformat()],
            "in_window": {a: {"pct": _r(p), "dates": n} for a, p, n in rows}}


def history(con):
    yrs = con.execute(f"""
        select year("day") as y, arm, median(pct), min(pct), max(pct), count(*), median(lake_ft)
        from ({PER_DATE}) group by all order by y, arm
    """).fetchall()
    if not yrs:
        return {"available": False}
    by = {}
    for y, arm, med, lo, hi, n, lk in yrs:
        d = by.setdefault(y, {"y": y})
        d[arm] = _r(med)
        d[f"{arm}_lo"], d[f"{arm}_hi"], d[f"{arm}_n"] = _r(lo), _r(hi), n
        if arm == "south" and lk is not None:
            d["lake_ft"] = _r(lk)
    years = [by[y] for y in sorted(by)]

    def extreme(arm, fn):
        pts = [(r[arm], r["y"]) for r in years if r.get(arm) is not None]
        v, y = fn(pts)
        return {"pct": v, "year": y}

    totals = con.execute(f"""
        select count(*), count(distinct site), min("day"), max("day") from {NAME}_samples
        where arm in ('north', 'south') and depth_ft <= {SHALLOW_FT} and wt_pct_tds > 0 and wt_pct_tds <= {MAX_PCT}
    """).fetchone()
    return {
        "available": True,
        "years": years,
        "south_low": extreme("south", min), "south_high": extreme("south", max),
        "north_low": extreme("north", min), "north_high": extreme("north", max),
        "samples": totals[0], "sites": totals[1], "first_day": totals[2].isoformat(), "last_day": totals[3].isoformat(),
        "shallow_ft": SHALLOW_FT,
        "links": {"stac_item": STAC_ITEM, "stac_collection": STAC_COLLECTION, "catalog": CATALOG_APP,
                  "report": REPORT_URL, "data": XLS_URL, "ugs": UGS},
        "license": LICENSE,
    }
