#!/usr/bin/env python3
"""Great Salt Lake water check.

Pulls USGS NWIS gauge readings and NOAA ACIS rain totals into a local DuckDB
file, works out river inflow, rain on the lake and lake level change for any
date window in SQL, and serves a d3 + MapLibre page at http://127.0.0.1:8765.

    python3 server.py
    GET /api/data?from=2026-10-10&to=2026-10-13    one window (hourly up to 62 days, daily beyond)
    GET /api/history                               lake level since 1847, river inflow by water year
"""
import argparse
import datetime as dt
import gzip
import json
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import duckdb

import sources
import sources._ugs

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("GSL_DB", os.path.join(HERE, "gsl.duckdb"))
STATIC = os.path.join(HERE, "static")
AREA_CSV = os.path.join(HERE, "ref", "gsl_area_ngvd29.csv")

# Where to look. Gauges are discovered from USGS each refresh; the roles below are
# fixed because they follow from how the rivers are plumbed.
HUCS = ["16010204", "16020102", "16020204"]  # lower Bear, lower Weber, lower Jordan basins
LAKE_SITE = "10010000"  # GSL at Saltair Boat Harbor, south arm level (NGVD 1929), daily since 1847
# Last flow gauge on each river before the lake; everything upstream drains through them.
RIVERS = {
    "10126000": "Bear River",    # near Corinne
    "10141000": "Weber River",   # near Plain City
    "10170500": "Jordan River",  # Surplus Canal, which carries most Jordan water to the lake
    "10172600": "Jordan River",  # Jordan River at Cudahy Lane
}
RAIN_BBOX = "-113.2,40.6,-111.85,41.85"
VALLEY_MAX_FT = 4500  # rain stations below this sit near lake level and count toward rain on the lake

# Reference levels, ft NGVD 1929
HEALTHY_FT = (4198, 4205)  # Utah FFSL elevation matrix healthy band (Strike Team target, 2024 Strategic Plan)
RECORD_LOW_FT = 4188.5  # south arm, Nov 7 2022 (USGS)

DEFAULT_DAYS = 7
BASELINE_DAYS = 14  # "normal" = median of the 14 days before the window starts
HOURLY_MAX_DAYS = 62  # longer windows use USGS daily values
IV_START = dt.date(2007, 10, 1)  # instantaneous values aren't reliably online before this
HISTORY_START = "1847-01-01"
RAIN_MAX_DAYS = 7305  # rain on the lake is only worked out for windows up to 20 years
EVENT_LOOKBACK_DAYS = 120
EVENT_RAIN_IN = 0.25
REFRESH_SEC = 3600

# Satellite background: clearest Sentinel-2 scenes from the last month, least cloudy on top
IMAGERY_BBOX = [-112.9, 40.45, -111.4, 42.1]
IMAGERY_DAYS = 30
IMAGERY_MAX_CLOUD = 15
IMAGERY_REFRESH_SEC = 6 * 3600
PC = "https://planetarycomputer.microsoft.com/api"

lock = threading.Lock()


# ---------------------------------------------------------------- fetching

def fetch(url, body=None, timeout=180):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", "User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_rdb(url):
    req = urllib.request.Request(url, headers={"User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=60) as r:
        lines = [l for l in r.read().decode().splitlines() if l and not l.startswith("#")]
    if not lines:
        return []
    head = lines[0].split("\t")
    return [dict(zip(head, l.split("\t"))) for l in lines[2:]]


def pull_sites():
    """Active stream gauges reporting flow in the three river basins, plus the lake gauge."""
    found = []
    for huc in HUCS:
        q = urllib.parse.urlencode({"format": "rdb", "huc": huc, "siteType": "ST", "hasDataTypeCd": "iv",
                                    "siteStatus": "active", "parameterCd": "00060"})
        found += fetch_rdb(f"https://waterservices.usgs.gov/nwis/site/?{q}")
    found += fetch_rdb(f"https://waterservices.usgs.gov/nwis/site/?format=rdb&sites={LAKE_SITE}")
    rows = {}
    for r in found:
        sid = r["site_no"]
        role = "lake" if sid == LAKE_SITE else "terminal" if sid in RIVERS else "upstream"
        rows[sid] = {"site_id": sid, "name": r["station_nm"], "lat": float(r["dec_lat_va"]),
                     "lon": float(r["dec_long_va"]), "role": role, "river": RIVERS.get(sid)}
    return list(rows.values())


def parse_usgs(d, daily):
    rows = []
    for t in d["value"]["timeSeries"]:
        site = t["sourceInfo"]["siteCode"][0]["value"]
        param = t["variable"]["variableCode"][0]["value"]
        for v in t["values"][0]["value"]:
            val = float(v["value"])
            if val > -999:
                # keep local wall-clock time, as USGS displays it
                key = {"day": v["dateTime"][:10]} if daily else {"ts": v["dateTime"][:19]}
                rows.append({"site_id": site, "param": param, **key, "value": val})
    return rows


def pull_iv(site_ids, start, end):
    url = (f"https://waterservices.usgs.gov/nwis/iv/?format=json&sites={','.join(site_ids)}"
           f"&parameterCd=00060,62614&startDT={start}&endDT={end}")
    return parse_usgs(fetch(url), daily=False)


def pull_dv(site_ids, start, end):
    url = (f"https://waterservices.usgs.gov/nwis/dv/?format=json&sites={','.join(site_ids)}"
           f"&parameterCd=00060,62614&statCd=00003&startDT={start}&endDT={end}")
    return parse_usgs(fetch(url, timeout=300), daily=True)


def pull_rain(start, end):
    d = fetch("https://data.rcc-acis.org/MultiStnData", {
        "bbox": RAIN_BBOX, "sdate": start, "edate": end,
        "elems": [{"name": "pcpn"}], "meta": ["name", "sids", "ll", "elev"]})
    s0 = dt.date.fromisoformat(start)
    rows = []
    for s in d.get("data", []):
        m = s["meta"]
        if "ll" not in m:
            continue
        for i, (v,) in enumerate(s["data"]):
            val, flag = None, None
            if v == "T":
                val, flag = 0.0, "trace"
            elif v == "M":
                flag = "missing"
            elif v == "S":
                flag = "in next report"
            elif v.endswith("A"):
                val, flag = float(v[:-1]), "multi-day total"
            else:
                val = float(v)
            if flag == "missing":
                continue  # absent rows count as missing; keeps long histories small
            rows.append({"sid": m["sids"][0].split()[0], "day": (s0 + dt.timedelta(i)).isoformat(),
                         "station": m["name"].title(), "lat": m["ll"][1], "lon": m["ll"][0],
                         "elev_ft": m.get("elev"), "pcpn_in": val, "flag": flag})
    return rows


def pull_imagery():
    """Register a least-cloudy-first Sentinel-2 mosaic and return its tile URL and date span."""
    end = dt.datetime.now(dt.timezone.utc)
    start = end - dt.timedelta(days=IMAGERY_DAYS)
    span = [f"{start:%Y-%m-%dT%H:%M:%SZ}", f"{end:%Y-%m-%dT%H:%M:%SZ}"]
    w, s, e, n = IMAGERY_BBOX
    filt = {"op": "and", "args": [
        {"op": "s_intersects", "args": [{"property": "geometry"},
                                        {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}]},
        {"op": "anyinteracts", "args": [{"property": "datetime"}, {"interval": span}]},
        {"op": "<", "args": [{"property": "eo:cloud_cover"}, IMAGERY_MAX_CLOUD]}]}
    reg = fetch(f"{PC}/data/v1/mosaic/register", {"collections": ["sentinel-2-l2a"], "filter-lang": "cql2-json",
                                                  "filter": filt, "sortby": [{"field": "eo:cloud_cover", "direction": "asc"}]})
    scenes = fetch(f"{PC}/stac/v1/search", {"collections": ["sentinel-2-l2a"], "bbox": IMAGERY_BBOX, "datetime": "/".join(span),
                                           "query": {"eo:cloud_cover": {"lt": IMAGERY_MAX_CLOUD}}, "limit": 200,
                                           "fields": {"include": ["properties.datetime"], "exclude": ["assets", "links", "geometry"]}})
    days = sorted({f["properties"]["datetime"][:10] for f in scenes.get("features", [])})
    if not days:
        return None
    return {"tiles": f"{PC}/data/v1/mosaic/{reg['searchid']}/tiles/WebMercatorQuad/{{z}}/{{x}}/{{y}}@1x"
                     "?collection=sentinel-2-l2a&assets=visual&nodata=0&format=png",
            "newest": days[-1], "oldest": days[0], "scenes": len(scenes["features"])}


# ---------------------------------------------------------------- storage

SCHEMA = """
create table if not exists sites (site_id varchar primary key, name varchar, lat double, lon double, role varchar, river varchar);
create table if not exists iv (site_id varchar, param varchar, ts timestamp, value double, primary key (site_id, param, ts));
create table if not exists dv (site_id varchar, param varchar, "day" date, value double, primary key (site_id, param, "day"));
create table if not exists rain (sid varchar, "day" date, station varchar, lat double, lon double, elev_ft double,
                                 pcpn_in double, flag varchar, primary key (sid, "day"));
create table if not exists pulled (kind varchar, chunk varchar, primary key (kind, chunk));
create table if not exists meta (k varchar primary key, v varchar);
"""
COLS = {
    "sites": "{site_id: 'VARCHAR', name: 'VARCHAR', lat: 'DOUBLE', lon: 'DOUBLE', role: 'VARCHAR', river: 'VARCHAR'}",
    "iv": "{site_id: 'VARCHAR', param: 'VARCHAR', ts: 'TIMESTAMP', value: 'DOUBLE'}",
    "dv": "{site_id: 'VARCHAR', param: 'VARCHAR', day: 'DATE', value: 'DOUBLE'}",
    "rain": ("{sid: 'VARCHAR', day: 'DATE', station: 'VARCHAR', lat: 'DOUBLE', lon: 'DOUBLE', "
             "elev_ft: 'DOUBLE', pcpn_in: 'DOUBLE', flag: 'VARCHAR'}"),
}


def upsert(con, table, rows):
    if not rows:
        return
    # land rows as NDJSON and let DuckDB read them
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    try:
        con.execute(f"insert or replace into {table} select * from read_json('{f.name}', columns={COLS[table]})")
    finally:
        os.unlink(f.name)


def meta_get(con, k):
    r = con.execute("select v from meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def meta_set(con, k, v):
    con.execute("insert or replace into meta values (?, ?)", [k, v])


def init_db():
    with duckdb.connect(DB_PATH) as con:
        con.execute(SCHEMA)
        con.execute(f"create or replace table lake_area as select * from read_csv('{AREA_CSV}')")
        for src in sources.ALL:
            if hasattr(src, "init"):
                src.init(con)


def months(a, b):
    out, d = [], dt.date(a.year, a.month, 1)
    while d <= b:
        nxt = dt.date(d.year + d.month // 12, d.month % 12 + 1, 1)
        out.append((d, min(nxt - dt.timedelta(days=1), b)))
        d = nxt
    return out


def ensure_iv(con, start, end):
    """Pull 15-minute readings for any month in [start, end] not pulled yet."""
    sites = [r[0] for r in con.execute("select site_id from sites").fetchall()]
    have = {r[0] for r in con.execute("select chunk from pulled where kind = 'iv'").fetchall()}
    for a, b in months(max(start, IV_START), end):
        key = f"{a:%Y-%m}"
        if key in have:
            continue
        upsert(con, "iv", pull_iv(sites, a.isoformat(), dt.date(a.year + a.month // 12, a.month % 12 + 1, 1).isoformat()))
        con.execute("insert or replace into pulled values ('iv', ?)", [key])


def ensure_rain(con, start, end):
    """Pull daily rain for any year in [start, end] not pulled yet."""
    have = {r[0] for r in con.execute("select chunk from pulled where kind = 'rain'").fetchall()}
    for y in range(start.year, end.year + 1):
        if str(y) in have:
            continue
        upsert(con, "rain", pull_rain(f"{y}-01-01", min(dt.date(y, 12, 31), dt.date.today()).isoformat()))
        con.execute("insert or replace into pulled values ('rain', ?)", [str(y)])


def missing(con, kind, start, end):
    """True when [start, end] needs chunks of `kind` that aren't pulled yet."""
    have = {r[0] for r in con.execute("select chunk from pulled where kind = ?", [kind]).fetchall()}
    want = [f"{a:%Y-%m}" for a, _ in months(max(start, IV_START), end)] if kind == "iv" else [str(y) for y in range(start.year, end.year + 1)]
    return any(w not in have for w in want)


def ensure_dv(con, site_ids):
    """Pull the full daily record once for each site."""
    have = {r[0] for r in con.execute("select chunk from pulled where kind = 'dv'").fetchall()}
    todo = [s for s in site_ids if s not in have]
    for i in range(0, len(todo), 10):
        batch = todo[i:i + 10]
        upsert(con, "dv", pull_dv(batch, HISTORY_START, dt.date.today().isoformat()))
        for s in batch:
            con.execute("insert or replace into pulled values ('dv', ?)", [s])


def refresh():
    """Rediscover gauges, pull anything new, re-pull the last few days (provisional readings get revised)."""
    today = dt.date.today()
    sites = pull_sites()
    with lock, duckdb.connect(DB_PATH) as con:
        con.execute("delete from sites")
        upsert(con, "sites", sites)
        last = meta_get(con, "last_pull_day")
        recent = min(dt.date.fromisoformat(last), today) - dt.timedelta(days=2) if last else today - dt.timedelta(days=3)
        ensure_iv(con, today - dt.timedelta(days=EVENT_LOOKBACK_DAYS + BASELINE_DAYS), today)
        ensure_rain(con, today - dt.timedelta(days=EVENT_LOOKBACK_DAYS + BASELINE_DAYS), today)
        # re-pull the last few days in place (readings get revised); chunk bookkeeping stays as is
        ids = [r[0] for r in con.execute("select site_id from sites").fetchall()]
        upsert(con, "iv", pull_iv(ids, recent.isoformat(), (today + dt.timedelta(days=1)).isoformat()))
        upsert(con, "rain", pull_rain(recent.isoformat(), today.isoformat()))
        ensure_dv(con, [s["site_id"] for s in sites if s["role"] in ("terminal", "lake")])
        ids = [s["site_id"] for s in sites if s["role"] in ("terminal", "lake")]
        upsert(con, "dv", pull_dv(ids, (today - dt.timedelta(days=30)).isoformat(), today.isoformat()))
        meta_set(con, "last_pull_day", today.isoformat())
        meta_set(con, "refreshed_at", dt.datetime.now().strftime("%Y-%m-%d %H:%M"))
        # plug-in sources (sources/*.py); one failing never stops the rest
        for src in sources.ALL:
            try:
                src.refresh(con, fetch)
            except Exception as e:  # noqa: BLE001
                print(f"source {src.NAME} refresh failed: {e}", flush=True)
        img = json.loads(meta_get(con, "imagery") or "{}")
        if time.time() - img.get("fetched", 0) > IMAGERY_REFRESH_SEC:
            try:
                new = pull_imagery()
                if new:
                    meta_set(con, "imagery", json.dumps({**new, "fetched": time.time()}))
            except Exception as e:  # noqa: BLE001  imagery is decoration; keep the old mosaic if PC is down
                print(f"imagery refresh failed: {e}", flush=True)
    print(f"refreshed {len(sites)} gauges from {recent}", flush=True)


# ---------------------------------------------------------------- queries

FLOW_SRC = {
    "hourly": """select site_id, date_trunc('hour', ts) hr, avg(value) cfs
                 from iv where param = '00060' and ts >= $base_from and ts < $to group by all""",
    "daily": """select site_id, "day"::timestamp hr, value cfs
                from dv where param = '00060' and "day" >= $base_from::date and "day" < $to::date""",
}
LAKE_SRC = {
    "hourly": """select date_trunc('hour', ts) hr, avg(value) elev_ft
                 from iv where site_id = $lake and param = '62614' and ts >= $base_from and ts < $to group by 1""",
    "daily": """select "day"::timestamp hr, value elev_ft
                from dv where site_id = $lake and param = '62614' and "day" >= $base_from::date and "day" < $to::date""",
}


def window_sql(res):
    return {
        "sites": "select * from sites order by role, site_id",
        # every flow gauge with its normal (median over the baseline window); af per reading = cfs x hours / 12.1
        "flow_series": f"""
            with h as ({FLOW_SRC[res]}),
                 b as (select site_id, median(cfs) baseline_cfs from h where hr >= $base_from and hr < $from group by all)
            select site_id, strftime(hr, '%Y-%m-%dT%H:00') "hour", round(cfs, 1) cfs, round(baseline_cfs, 1) baseline_cfs,
                   round(cfs * $step_af, 3) flow_af, round((cfs - baseline_cfs) * $step_af, 3) excess_af, hr >= $from in_window
            from h left join b using (site_id) order by site_id, hr""",
        "by_site": """
            select s.site_id, s.name, s.role, s.river, s.lat, s.lon,
                   round(any_value(f.baseline_cfs), 1) baseline_cfs,
                   round(max(f.cfs) filter (where f.in_window), 1) peak_cfs,
                   round(arg_max(f.cfs, f."hour") filter (where f.in_window), 1) latest_cfs,
                   round(sum(f.flow_af) filter (where f.in_window)) window_af,
                   round(sum(f.excess_af) filter (where f.in_window)) excess_af,
                   count(f.cfs) filter (where f.in_window) readings
            from sites s left join flow_series f using (site_id)
            where s.role <> 'lake' group by all order by s.role, s.site_id""",
        "by_river": """
            select river, sum(window_af) total_af, sum(excess_af) excess_af, count(*) filter (where readings > 0) gauges
            from by_site where role = 'terminal' group by river order by total_af desc nulls last""",
        "inflow": """
            select coalesce(sum(window_af), 0) total_af, coalesce(sum(excess_af), 0) excess_af,
                   count(*) filter (where readings > 0) gauges, count(*) expected
            from by_site where role = 'terminal'""",
        "inflow_cumulative": """
            select "hour", round(sum(sum(excess_af)) over (order by "hour")) cum_excess_af
            from flow_series where in_window and site_id in (select site_id from sites where role = 'terminal')
            group by 1 order by 1""",
        "lake_series": f"""
            select strftime(hr, '%Y-%m-%dT%H:00') "hour", round(elev_ft, 2) elev_ft from ({LAKE_SRC[res]}) order by hr""",
        # level change: mean of the day before the window vs the window's last day, which smooths out wind
        "lake_change": """
            with h as (select strptime("hour", '%Y-%m-%dT%H:%M') hr, elev_ft from lake_series),
                 pre as (select avg(elev_ft) v, count(*) n from h where hr >= $from - interval 24 hour and hr < $from),
                 fin as (select avg(elev_ft) v, count(*) n from h
                         where hr > (select max(hr) from h) - interval 24 hour and hr >= $from)
            select round(pre.v, 2) start_ft, round(fin.v, 2) end_ft,
                   (select elev_ft from h order by hr desc limit 1) latest_ft,
                   round((fin.v - pre.v) * 12, 1) change_in, pre.n start_n, fin.n end_n
            from pre, fin""",
        # lake area and volume at the window's ending level, from the USGS 2023 elevation-area-volume table
        "lake_size": """
            with lvl as (select coalesce((select end_ft from lake_change),
                                         (select elev_ft from lake_series order by "hour" desc limit 1)) ft),
                 cur as (select a.* from lake_area a, lvl order by abs(a.elev_ngvd29_ft - lvl.ft) limit 1),
                 healthy as (select volume_acreft from lake_area order by abs(elev_ngvd29_ft - $healthy_low) limit 1)
            select cur.elev_ngvd29_ft level_ft, cur.area_acre, cur.volume_acreft,
                   greatest(healthy.volume_acreft - cur.volume_acreft, 0) to_healthy_af
            from cur, healthy""",
        "rain_stations": """
            -- stop at the last day anyone has reported, so not-yet-filed reports don't count as missing
            with last as (select max("day") d from rain),
                 span as (select greatest(least($to_day, (select d from last)) - $from_day + 1, 1) n),
                 w as (select * from rain where "day" >= $from_day and "day" <= least($rain_to, (select d from last)))
            select station, sid, any_value(lat) lat, any_value(lon) lon, any_value(elev_ft) elev_ft,
                   round(coalesce(sum(pcpn_in), 0), 2) total_in, count(pcpn_in) reports, (select n from span) days_expected,
                   (any_value(elev_ft) < $valley and count(pcpn_in) >= greatest((select n from span) - 1, ceil((select n from span) * 0.9))) counted
            from w group by station, sid order by total_in desc""",
        "rain_lake": """
            select round(median(total_in), 2) rain_in,
                   round(median(total_in) / 12 * (select area_acre from lake_size)) rain_af, count(*) stations
            from rain_stations where counted""",
        # rainy spells: days where the lowland median reaches the threshold, grouped when consecutive
        "events": """
            with d as (select "day", median(pcpn_in) med from rain
                       where elev_ft < $valley and pcpn_in is not null and "day" >= current_date - $lookback::int group by 1),
                 wet as (select "day", med, "day" - (row_number() over (order by "day"))::int grp from d where med >= $event_in)
            select min("day") start_day, max("day") end_day, round(sum(med), 2) rain_in
            from wet group by grp order by start_day desc""",
    }


HISTORY_SQL = {
    "lake_weekly": """
        select strftime(date_trunc('week', "day"), '%Y-%m-%d') wk, round(avg(value), 2) elev_ft, count(*) n
        from dv where site_id = $lake and param = '62614' group by 1 order by 1""",
    # water year runs Oct 1 to Sep 30 and is named for the year it ends in; skip years with big gaps
    "annual_inflow": """
        select year("day" + interval 3 month) water_year, s.river, round(sum(value) * 1.9835) acre_ft, count(*) "days"
        from dv join sites s using (site_id)
        where param = '00060' and s.role = 'terminal'
        group by all having count(*) >= 330 * count(distinct site_id) order by 1, 2""",
}


def run(con, queries, params):
    out = {}
    for name, sql in queries.items():
        used = {k: v for k, v in params.items() if re.search(rf"\${k}\b", sql)}
        # each result becomes a temp table so later queries can build on it
        con.execute(f"create or replace temp table {name} as {sql}", used)
        rel = con.execute(f"select * from {name}")
        cols = [c[0] for c in rel.description]
        out[name] = [dict(zip(cols, r)) for r in rel.fetchall()]
    return out


def parse_window(qs):
    today = dt.date.today()
    try:
        to_day = dt.date.fromisoformat(qs["to"][0]) if qs.get("to") else today
        from_day = dt.date.fromisoformat(qs["from"][0]) if qs.get("from") else to_day - dt.timedelta(days=DEFAULT_DAYS - 1)
    except ValueError as e:
        raise ValueError("Dates must look like 2026-10-10") from e
    to_day = min(to_day, today)
    if from_day > to_day:
        raise ValueError("The start date is after the end date")
    if from_day < dt.date(1847, 10, 18):
        raise ValueError("The lake record starts Oct 18, 1847")
    return from_day, to_day


def query_window(from_day, to_day):
    days = (to_day - from_day).days + 1
    base_from = from_day - dt.timedelta(days=BASELINE_DAYS)
    res = "hourly" if days <= HOURLY_MAX_DAYS and base_from >= IV_START else "daily"
    # reads never wait on a refresh; only a backfill takes the write lock
    with duckdb.connect(DB_PATH) as con:
        need_iv = res == "hourly" and missing(con, "iv", base_from, to_day)
        need_rain = days <= RAIN_MAX_DAYS and missing(con, "rain", from_day, to_day)
    if need_iv or need_rain:
        with lock, duckdb.connect(DB_PATH) as con:
            if need_iv:
                ensure_iv(con, base_from, to_day)
            if need_rain:
                ensure_rain(con, from_day, to_day)
    midnight = lambda d: dt.datetime.combine(d, dt.time())  # noqa: E731
    params = {
        "from": midnight(from_day), "to": midnight(to_day + dt.timedelta(days=1)), "base_from": midnight(base_from),
        "from_day": from_day, "to_day": to_day, "lake": LAKE_SITE, "valley": VALLEY_MAX_FT,
        "healthy_low": HEALTHY_FT[0], "lookback": EVENT_LOOKBACK_DAYS, "event_in": EVENT_RAIN_IN,
        "step_af": (1 if res == "hourly" else 24) / 12.1,
        # a window too long for rain gets an empty rain range
        "rain_to": to_day if days <= RAIN_MAX_DAYS else from_day - dt.timedelta(days=1),
    }
    with duckdb.connect(DB_PATH) as con:
        out = run(con, window_sql(res), params)
    # send full series only for the river mouths and the three upstream gauges furthest above normal
    ratio = lambda s: (s["latest_cfs"] or 0) / s["baseline_cfs"] if s["baseline_cfs"] else 0  # noqa: E731
    up = sorted((s for s in out["by_site"] if s["role"] == "upstream" and s["readings"]), key=ratio, reverse=True)[:3]
    keep = {s["site_id"] for s in out["by_site"] if s["role"] == "terminal"} | {s["site_id"] for s in up}
    out["flow_series"] = [r for r in out["flow_series"] if r["site_id"] in keep]
    with duckdb.connect(DB_PATH) as con:
        out["refreshed_at"] = meta_get(con, "refreshed_at")
        img = meta_get(con, "imagery")
        out["imagery"] = json.loads(img) if img else None
        out["sources"] = {}
        for src in sources.ALL:
            try:
                out["sources"][src.NAME] = src.query(con, {"from_day": from_day, "to_day": to_day, "days": days, "resolution": res})
            except Exception as e:  # noqa: BLE001
                out["sources"][src.NAME] = {"error": str(e)}
    out["window"] = {"from": from_day.isoformat(), "to": to_day.isoformat(), "days": days, "resolution": res,
                     "is_default": to_day == dt.date.today() and days == DEFAULT_DAYS}
    out["config"] = {"baseline_days": BASELINE_DAYS, "default_days": DEFAULT_DAYS, "healthy_ft": HEALTHY_FT,
                     "record_low_ft": RECORD_LOW_FT, "valley_max_ft": VALLEY_MAX_FT, "event_rain_in": EVENT_RAIN_IN,
                     "hourly_max_days": HOURLY_MAX_DAYS, "rain_max_days": RAIN_MAX_DAYS,
                     # UGS addresses come from sources/_ugs.py so the page follows any override
                     "ugs": {"swb_stac": sources._ugs.SWB_STAC, "swb_app": sources._ugs.SWB_APP,
                             "warehouse_stac": sources._ugs.WAREHOUSE_STAC, "catalog_app": sources._ugs.CATALOG_APP,
                             "pubs": sources._ugs.PUBS, "home": sources._ugs.HOME}}
    return out


def query_history():
    with duckdb.connect(DB_PATH) as con:
        out = run(con, HISTORY_SQL, {"lake": LAKE_SITE})
        out["sources"] = {}
        for src in sources.ALL:
            if hasattr(src, "history"):
                try:
                    out["sources"][src.NAME] = src.history(con)
                except Exception as e:  # noqa: BLE001
                    out["sources"][src.NAME] = {"error": str(e)}
    out["config"] = {"healthy_ft": HEALTHY_FT, "record_low_ft": RECORD_LOW_FT}
    return out


# ---------------------------------------------------------------- server

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, default=str, separators=(",", ":")).encode()
        gz = "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024
        if gz:
            body = gzip.compress(body, 6)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        if gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        try:
            if url.path == "/api/data":
                return self.send_json(query_window(*parse_window(urllib.parse.parse_qs(url.query))))
            if url.path == "/api/history":
                return self.send_json(query_history())
            if url.path == "/api/panels":
                return self.send_json(sorted(f for f in os.listdir(os.path.join(STATIC, "panels")) if f.endswith(".js")))
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self.send_json({"error": str(e)}, 500)
        self.path = url.path
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/refresh":
            try:
                refresh()
                return self.send_json({"ok": True})
            except Exception as e:  # noqa: BLE001
                return self.send_json({"error": str(e)}, 502)
        self.send_error(404)

    def log_message(self, fmt, *args):
        if "/api/" not in self.path:
            super().log_message(fmt, *args)


def refresher():
    # first pull right away (sources can take a minute), then hourly; the page serves whatever is stored meanwhile
    while True:
        try:
            refresh()
        except Exception as e:  # noqa: BLE001
            print(f"refresh failed: {e}", flush=True)
        time.sleep(REFRESH_SEC)


def dump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, default=str, separators=(",", ":"))


def export(out_dir):
    """Write a server-free copy of the page for GitHub Pages: the static files plus one JSON per preset period."""
    refresh()
    today = dt.date.today()
    shutil.rmtree(out_dir, ignore_errors=True)
    shutil.copytree(STATIC, out_dir)
    data = os.path.join(out_dir, "data")
    panels = sorted(f for f in os.listdir(os.path.join(STATIC, "panels")) if f.endswith(".js"))
    dump(os.path.join(data, "panels.json"), panels)
    dump(os.path.join(data, "history.json"), query_history())
    # the page's presets: last 7/30/365/3652 days, plus the rain events it lists (a day either side, capped at today)
    wanted = [(today - dt.timedelta(days=n - 1), today) for n in (7, 30, 365, 3652)]
    first = query_window(*wanted[0])
    for e in first.get("events", [])[:8]:
        s, t = dt.date.fromisoformat(str(e["start_day"])[:10]), dt.date.fromisoformat(str(e["end_day"])[:10])
        wanted.append((s - dt.timedelta(days=1), min(t + dt.timedelta(days=1), today)))
    windows = []
    for a, b in dict.fromkeys(wanted):
        out = first if (a, b) == wanted[0] else query_window(a, b)
        rel = f"data/window/{a}_{b}.json"
        dump(os.path.join(out_dir, rel), out)
        windows.append({"from": a.isoformat(), "to": b.isoformat(), "file": rel})
        print(f"exported {rel}", flush=True)
    manifest = {"today": today.isoformat(), "built_at": dt.datetime.now().isoformat(timespec="minutes"), "windows": windows}
    index = os.path.join(out_dir, "index.html")
    with open(index) as f:
        html = f.read()
    tag = f"<script>window.GSL_STATIC = {json.dumps(manifest)};</script>"
    with open(index, "w") as f:
        f.write(html.replace("</head>", f"{tag}\n</head>", 1))
    open(os.path.join(out_dir, ".nojekyll"), "w").close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--export", metavar="DIR", help="write a static copy for GitHub Pages to DIR and exit")
    args = ap.parse_args()
    init_db()
    if args.export:
        return export(args.export)
    threading.Thread(target=refresher, daemon=True).start()
    print(f"serving http://{args.host}:{args.port}", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
