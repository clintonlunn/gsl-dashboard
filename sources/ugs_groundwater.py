"""Groundwater around the Great Salt Lake: are well water levels rising or falling?

Where the numbers come from (checked October 2026):

* Water levels: USGS field measurements of depth to water below land surface (parameter 72019) in wells in a box
  around the lake and its east-shore basins, from the USGS Water Data OGC API
  (https://api.waterdata.usgs.gov/ogcapi/v0/collections/field-measurements). Most of these wells are measured by
  hand once a year, in February or March. The old NWIS gwlevels service this replaces was frozen on 1 Nov 2025 and
  now answers with a redirect.
  The Utah Geological Survey's Groundwater Monitoring Data Portal (gwportal.geology.utah.gov) is the UGS water-level
  archive, but the wells it has near the lake are landslide piezometers in the Wasatch Front foothills, with nothing
  newer than 2024, and the UGS data warehouse STAC has no water-level time series. So the levels are USGS data;
  we only check the UGS portal each day and report what it has in the area, so the page notices if that changes.
* Chemistry: UGS Open-File Report 699, "Mapping groundwater quality and chemistry adjacent to Great Salt Lake"
  (Kirby, Inkenbrandt and Rupke, 2019), GeoParquet asset of STAC item OFR-699 in the UGS data warehouse (CC BY 4.0).
  We keep the newest sample at each well and spring.
"""
from . import _ugs
import datetime as dt
import json
import os
import tempfile
import time
import urllib.parse
import urllib.request

NAME = "ugs_groundwater"

OGC = "https://api.waterdata.usgs.gov/ogcapi/v0"
BBOX = (-113.2, 40.5, -111.75, 41.9)  # the lake, Tooele and Salt Lake valleys, the east shore (Davis/Weber), lower Bear
PARAM = "72019"  # depth to water level, feet below land surface
SITE_URL = "https://waterdata.usgs.gov/monitoring-location/{}/"
USGS_API_DOCS = "https://api.waterdata.usgs.gov/docs/ogcapi/"
USGS_LICENSE = "USGS data are public domain"

OFR = "OFR-699"
STAC_ITEM = f"{_ugs.WAREHOUSE_STAC}/ugs-publications/OFR/{OFR}/{OFR}.json"
CHEM_ASSET = "GSL_GW_Chemistry__Selectchempivot"
CHEM_FALLBACK = f"https://maps-assets.geology.utah.gov/geolmap/vectors/{OFR}/{CHEM_ASSET}.parquet"
REPORT = f"{_ugs.PUBS}/open_file_reports/ofr-699/ofr-699.pdf"
DOI = "https://doi.org/10.34191/OFR-699"
UGS_LICENSE = "CC-BY-4.0"

CHECK_SEC = 86400  # at most daily
FULL_EVERY_SEC = 30 * 86400  # re-pull the whole record monthly; in between only the last two years
RECENT_DAYS = 730
STEADY_FT = 0.5  # changes smaller than this count as "about the same"
LATEST_MAX_DAYS = 400  # a well counts as "recent" if measured within this many days before the window ends
YEAR_TOL_DAYS = 75  # the year-ago reading must be within this many days of a year before the latest
LONG_YEARS = 20  # long-record wells: spring readings in at least this many years since BASE_FROM
BASE_FROM, BASE_TO = 1996, 2000  # history baseline years
NOTABLE = 3  # biggest rises and biggest drops to list


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_levels (site_id varchar, t timestamp, "day" date, dtw_ft double, approved boolean);
        create table if not exists {NAME}_sites (site_id varchar primary key, name varchar, county varchar,
            lat double, lon double, land_ft double, well_depth_ft double);
        create table if not exists {NAME}_chem (station_id varchar, name varchar, kind varchar, area varchar,
            dist_m double, "day" date, tds_mgl double, water_type varchar, lat double, lon double);
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);
    """)


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, str(v)])


def _get(url, timeout=300):
    req = urllib.request.Request(url, headers={"User-Agent": "gsl-dashboard", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _pages(url):
    """Follow an OGC API items listing through its rel=next links."""
    while url:
        page = json.loads(_get(url))
        yield page["features"]
        url = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)


def _items(collection, **params):
    q = {"f": "json", "bbox": ",".join(map(str, BBOX)), "limit": 10000, **params}
    return f"{OGC}/collections/{collection}/items?{urllib.parse.urlencode(q, safe=',/')}"


def _load_csv(con, table, cols, rows, where=None):
    """Replace `table` rows (all, or those matching `where`) with `rows`, in one transaction."""
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
        for row in rows:
            f.write(",".join("" if v is None else str(v).replace(",", " ") for v in row) + "\n")
    spec = ", ".join(f"'{c}': '{t}'" for c, t in cols)
    try:
        con.execute("begin")
        con.execute(f"delete from {table}" + (f" where {where}" if where else ""))
        con.execute(f"insert into {table} select * from read_csv('{f.name}', header=false, nullstr='', columns={{{spec}}})")
        con.execute("commit")
    except Exception:
        con.execute("rollback")
        raise
    finally:
        os.unlink(f.name)


def _pull_levels(con, since=None):
    params = {"parameter_code": PARAM, "skipGeometry": "true",
              "properties": "monitoring_location_id,value,time,approval_status"}
    if since:
        params["time"] = f"{since.isoformat()}T00:00:00Z/.."
    rows = []
    for feats in _pages(_items("field-measurements", **params)):
        for x in feats:
            p = x["properties"]
            if p.get("value") in (None, ""):
                continue  # "NoMeasurement" (dry, frozen, obstructed)
            try:
                v = float(p["value"])
            except ValueError:
                continue
            t = p["time"][:19]
            rows.append((p["monitoring_location_id"], t.replace("T", " "), t[:10], v, p.get("approval_status") == "Approved"))
    if not rows and not since:
        raise RuntimeError("USGS field-measurements returned no groundwater levels")
    cols = [("site_id", "VARCHAR"), ("t", "TIMESTAMP"), ("day", "DATE"), ("dtw_ft", "DOUBLE"), ("approved", "BOOLEAN")]
    _load_csv(con, f"{NAME}_levels", cols, rows, where=f"\"day\" >= DATE '{since.isoformat()}'" if since else None)
    return len(rows)


def _pull_sites(con):
    url = _items("monitoring-locations", site_type_code="GW", agency_code="USGS",
                 properties="monitoring_location_name,altitude,well_constructed_depth,county_name")
    rows = []
    for feats in _pages(url):
        for x in feats:
            p, g = x["properties"], x.get("geometry") or {}
            lon, lat = (g.get("coordinates") or [None, None])[:2]
            rows.append((x["id"], (p.get("monitoring_location_name") or "").strip(), p.get("county_name"), lat, lon,
                         p.get("altitude"), p.get("well_constructed_depth")))
    if rows:
        cols = [("site_id", "VARCHAR"), ("name", "VARCHAR"), ("county", "VARCHAR"), ("lat", "DOUBLE"), ("lon", "DOUBLE"),
                ("land_ft", "DOUBLE"), ("well_depth_ft", "DOUBLE")]
        _load_csv(con, f"{NAME}_sites", cols, rows)


def _pull_chem(con):
    try:
        item = json.loads(_get(STAC_ITEM, 60))
        href = item["assets"][CHEM_ASSET]["href"]
    except Exception:  # noqa: BLE001  STAC moved or renamed: use the address it had when this was written
        href = CHEM_FALLBACK
    with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as f:
        f.write(_get(href, 300))
    try:
        con.execute("begin")
        con.execute(f"delete from {NAME}_chem")
        con.execute(f"""insert into {NAME}_chem
            select StationId, StationName, StationType, LocID, NEAR_DIST, cast(SampleDate as date),
                   coalesce(nullif(TDS, 0), nullif(CalcTDS, 0)), water_type, Lat_Y, Lon_X
            from read_parquet('{f.name}') where IsNewest = 1""")
        con.execute("commit")
    except Exception:
        con.execute("rollback")
        raise
    finally:
        os.unlink(f.name)
    _set(con, "chem_href", href)


def _check_portal(con):
    """What the UGS Groundwater Data Portal has in the same box: wells and their newest logger reading."""
    w, s, e, n = BBOX
    box = f"and=(latitude.gte.{s},latitude.lte.{n},longitude.gte.{w},longitude.lte.{e})"
    for attempt in range(3):  # the Cloud Run API answers PGRST002 while it wakes up
        try:
            wells = json.loads(_get(f"{_ugs.GW_API}/ugs_ngwmn_monitoring_locations?select=altlocationid,locationname,"
                                    f"wlnetworkname&locationtype=eq.Well&{box}", 60))
            break
        except Exception:  # noqa: BLE001
            if attempt == 2:
                raise
            time.sleep(5)
    ids = [str(x["altlocationid"]) for x in wells if x.get("altlocationid") is not None]
    last = None
    if ids:
        r = json.loads(_get(f"{_ugs.GW_API}/reading?select=locationid,readingdate&locationid=in.({','.join(ids)})"
                            "&order=readingdate.desc&limit=1", 60))
        if r:
            name = next((x["locationname"] for x in wells if str(x["altlocationid"]) == str(r[0]["locationid"])), None)
            last = {"day": r[0]["readingdate"][:10], "well": name}
    networks = sorted({x["wlnetworkname"] for x in wells if x.get("wlnetworkname")})
    _set(con, "portal", json.dumps({"wells": len(wells), "with_data": len(ids), "last": last, "networks": networks}))


def refresh(con, fetch=None):
    init(con)
    now = time.time()
    have = con.execute(f"select count(*) from {NAME}_levels").fetchone()[0]
    last = _meta(con, "checked")
    if have and last and now - float(last) < CHECK_SEC:
        return
    full = _meta(con, "full")
    if not have or not full or now - float(full) > FULL_EVERY_SEC:
        _pull_levels(con)
        _pull_sites(con)
        _set(con, "full", now)
    else:
        _pull_levels(con, dt.date.today() - dt.timedelta(days=RECENT_DAYS))
    chem = _meta(con, "chem_checked")
    if not chem or now - float(chem) > FULL_EVERY_SEC:
        try:
            _pull_chem(con)
            _set(con, "chem_checked", now)
        except Exception as e:  # noqa: BLE001  chemistry is a bonus; levels still count
            print(f"{NAME}: chemistry not loaded: {e}", flush=True)
    try:
        _check_portal(con)
    except Exception as e:  # noqa: BLE001
        print(f"{NAME}: UGS portal check failed: {e}", flush=True)
    _set(con, "checked", now)


def _r(v, n=2):
    return None if v is None else round(v, n)


def _links():
    return {"usgs_api": f"{OGC}/collections/field-measurements", "usgs_docs": USGS_API_DOCS,
            "ugs_portal": _ugs.GW_PORTAL, "stac_item": STAC_ITEM, "report": REPORT, "doi": DOI,
            "catalog": _ugs.CATALOG_APP, "ugs": _ugs.HOME + "/"}


def _portal(con):
    p = _meta(con, "portal")
    return json.loads(p) if p else None


# one value per well per day (a few wells are measured twice on a visit)
DAILY = f"""select site_id, "day", avg(dtw_ft) as dtw from {NAME}_levels group by all"""


def query(con, window):
    """Wells measured in the 400 days before the window ends, each compared with its reading about a year earlier.
    Most wells are measured once a year, so a one-week window usually holds few or no new readings."""
    to_day = window["to_day"]
    rows = con.execute(f"""
        with d as ({DAILY}),
        latest as (
            select site_id, max("day") as day1 from d
            where "day" <= ? and "day" > ? - interval {LATEST_MAX_DAYS} day group by site_id),
        cur as (select d.site_id, d."day", d.dtw from d join latest l on d.site_id = l.site_id and d."day" = l.day1),
        prev as (
            select c.site_id, arg_min(d."day", abs(datediff('day', d."day", c."day" - interval 365 day))) as day0,
                   arg_min(d.dtw, abs(datediff('day', d."day", c."day" - interval 365 day))) as dtw0
            from cur c join d on d.site_id = c.site_id
            where d."day" between c."day" - interval {365 + YEAR_TOL_DAYS} day and c."day" - interval {365 - YEAR_TOL_DAYS} day
            group by c.site_id)
        select c.site_id, s.name, s.county, s.lat, s.lon, c."day", c.dtw, p.day0, p.dtw0, p.dtw0 - c.dtw as change
        from cur c join prev p using (site_id) left join {NAME}_sites s using (site_id)
        order by change""", [to_day, to_day]).fetchall()
    measured = con.execute(f"""select count(distinct site_id) from {NAME}_levels where "day" between ? and ?""",
                           [window["from_day"], to_day]).fetchone()[0]
    span = con.execute(f'select min("day"), max("day"), count(distinct site_id) from {NAME}_levels').fetchone()
    base = {"links": _links(), "license": USGS_LICENSE, "ugs_license": UGS_LICENSE, "portal": _portal(con),
            "steady_ft": STEADY_FT, "measured_in_window": measured,
            "record": [span[0].isoformat(), span[1].isoformat()] if span[0] else None}
    if not rows:
        return {"available": False, **base}
    wells = [{"id": r[0], "name": r[1] or r[0], "county": (r[2] or "").replace(" County", "") or None,
              "lat": _r(r[3], 4), "lon": _r(r[4], 4), "day": r[5].isoformat(), "dtw_ft": _r(r[6]),
              "prior_day": r[7].isoformat(), "prior_dtw_ft": _r(r[8]), "change_ft": _r(r[9]),
              "link": SITE_URL.format(r[0])} for r in rows]
    ch = sorted(w["change_ft"] for w in wells)
    mid = len(ch) // 2
    median = ch[mid] if len(ch) % 2 else (ch[mid - 1] + ch[mid]) / 2
    days = sorted(w["day"] for w in wells)
    return {
        "available": True, **base,
        "as_of": to_day.isoformat(),
        "wells": len(wells),
        "rising": sum(c > STEADY_FT for c in ch), "falling": sum(c < -STEADY_FT for c in ch),
        "steady": sum(abs(c) <= STEADY_FT for c in ch),
        "median_change_ft": _r(median),
        "measured_from": days[0], "measured_to": days[-1],
        "notable": {"fell": wells[:NOTABLE], "rose": [w for w in wells[::-1][:NOTABLE] if w["change_ft"] > 0]},
        # every well, for the chart: [id, name, county, change_ft, latest depth to water, latest day]
        "changes": [[w["id"], w["name"], w["county"], w["change_ft"], w["dtw_ft"], w["day"]] for w in wells],
    }


def history(con):
    years = con.execute(f"""
        with d as ({DAILY}),
        spring as (  -- the annual measurement round is in February-March; one value per well per year
            select site_id, year("day") as y, median(dtw) as dtw from d where month("day") between 1 and 5 group by all),
        long as (
            select site_id from spring where y >= {BASE_FROM} group by site_id
            having count(*) >= {LONG_YEARS} and max(y) >= (select max(y) from spring) - 1),
        s as (select * from spring where site_id in (select site_id from long) and y >= {BASE_FROM}),
        chg as (select a.site_id, a.y, b.dtw - a.dtw as change from s a join s b on a.site_id = b.site_id and b.y = a.y - 1),
        base as (select site_id, median(dtw) as dtw from s where y between {BASE_FROM} and {BASE_TO} group by site_id),
        vs as (select s.site_id, s.y, base.dtw - s.dtw as vs from s join base using (site_id))
        select y, median(change), quantile_cont(change, 0.25), quantile_cont(change, 0.75), count(*),
               (select median(vs) from vs where vs.y = chg.y), (select count(*) from vs where vs.y = chg.y)
        from chg group by y order by y""").fetchall()
    nlong = con.execute(f"""
        with spring as (select site_id, year("day") as y from {NAME}_levels where month("day") between 1 and 5 group by all)
        select count(*) from (select site_id from spring where y >= {BASE_FROM} group by site_id
            having count(*) >= {LONG_YEARS} and max(y) >= (select max(y) from spring) - 1)""").fetchone()[0]
    chem = con.execute(f"""
        select area, count(*), median(tds_mgl), avg((tds_mgl >= 1000)::int), min("day"), max("day")
        from {NAME}_chem where tds_mgl > 0 and area is not null group by area order by median(tds_mgl)""").fetchall()
    near = con.execute(f"""
        select dist_m < 1000, count(*), median(tds_mgl) from {NAME}_chem where tds_mgl > 0 group by all""").fetchall()
    out = {"links": _links(), "license": USGS_LICENSE, "ugs_license": UGS_LICENSE, "portal": _portal(con),
           "base_years": [BASE_FROM, BASE_TO], "long_years": LONG_YEARS, "long_wells": nlong}
    if years:
        out["years"] = [{"y": y, "change_ft": _r(m), "q1": _r(a), "q3": _r(b), "n": n, "vs_base_ft": _r(v), "n_base": nb}
                        for y, m, a, b, n, v, nb in years]
    if chem:
        out["chem"] = {
            "areas": [{"area": a, "n": n, "tds_mgl": _r(t, 0), "share_salty": _r(s, 2),
                       "from": f.isoformat() if f else None, "to": z.isoformat() if z else None}
                      for a, n, t, s, f, z in chem],
            "within_1km": next(({"n": n, "tds_mgl": _r(t, 0)} for k, n, t in near if k), None),
            "farther": next(({"n": n, "tds_mgl": _r(t, 0)} for k, n, t in near if k is False), None),
        }
    out["available"] = bool(years or chem)
    return out
