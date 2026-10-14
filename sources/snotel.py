"""NRCS SNOTEL snowpack (snow water equivalent, WTEQ) for the mountains that feed the Great Salt Lake.

Stations are every active SNOTEL site in Utah, Idaho and Wyoming whose 12-digit HUC falls in the Bear
(16010101-16010204), Weber (16020101-16020102) or Provo / Utah Lake / Jordan (16020201-16020204) HUC8s.
Data come from the NRCS Air and Water Database REST API (AWDB):
    /services/v1/stations   station list + HUC
    /services/v1/data       daily WTEQ (inches), with centralTendencyType=MEDIAN for the daily median

Basin index, following NRCS practice: % of median = sum of today's SWE / sum of the same stations' median for
the day (stations with both); SWE inches = plain average over reporting stations.
"""
import datetime as dt
import json
import urllib.parse

NAME = "snotel"
API = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1"
STATES = ("UT", "ID", "WY")
BASINS = {  # key -> (label, inclusive HUC8 range)
    "bear": ("Bear River", "16010101", "16010204"),
    "weber": ("Weber River", "16020101", "16020102"),
    "jordan": ("Jordan & Provo rivers", "16020201", "16020204"),
}
HISTORY_START = dt.date(1985, 10, 1)  # water year 1986 onward (~40 years)
RECENT_DAYS = 400                     # re-pulled every refresh, with medians: covers a full year of calendar days
REFRESH_SEC = 6 * 3600
BACKFILL_BATCH = 6                    # ~41 years x 6 stations ~ 2.4 MB per request
RECENT_BATCH = 20
MIN_MEDIAN_IN = 1.0                   # below this basin-average median, "% of median" is meaningless (summer / fall)


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_stations (triplet varchar primary key, name varchar, state varchar, basin varchar,
            huc varchar, elev_ft double, lat double, lon double, begin_day date);
        create table if not exists {NAME}_daily (triplet varchar, day date, swe_in double, primary key (triplet, day));
        create table if not exists {NAME}_median (triplet varchar, mmdd varchar, median_in double, primary key (triplet, mmdd));
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


def _basin(huc):
    h8 = (huc or "")[:8]
    for key, (_, lo, hi) in BASINS.items():
        if len(h8) == 8 and lo <= h8 <= hi:
            return key
    return None


def stations_url(state):
    q = {"stationTriplets": f"*:{state}:SNTL", "elements": "WTEQ", "activeOnly": "true",
         "returnForecastPointMetadata": "false", "returnReservoirMetadata": "false", "returnStationElements": "false"}
    return f"{API}/stations?{urllib.parse.urlencode(q, safe='*:')}"


def _data_url(triplets, begin, end, median):
    q = {"stationTriplets": ",".join(triplets), "elements": "WTEQ", "duration": "DAILY",
         "beginDate": begin.isoformat(), "endDate": end.isoformat()}
    if median:
        q["centralTendencyType"] = "MEDIAN"
    return f"{API}/data?{urllib.parse.urlencode(q, safe='*:,')}"


def _pull_stations(con, fetch):
    rows = []
    for st in STATES:
        for s in fetch(stations_url(st)):
            b = _basin(s.get("huc"))
            if b:
                rows.append((s["stationTriplet"], s.get("name"), s.get("stateCode"), b, s.get("huc"), s.get("elevation"),
                             s.get("latitude"), s.get("longitude"), (s.get("beginDate") or "")[:10] or None))
    if rows:  # replace the list only when the API answered with something
        con.execute(f"delete from {NAME}_stations")
        con.executemany(f"insert into {NAME}_stations values (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    return [r[0] for r in rows]


def _store(con, payload, with_median):
    t, d, v, mt, mk, mv = [], [], [], [], [], []
    for st in payload or []:
        trip = st.get("stationTriplet")
        for el in st.get("data") or []:
            for x in el.get("values") or []:
                day = x.get("date", "")[:10]
                if x.get("value") is not None and x["value"] >= 0:
                    t.append(trip); d.append(day); v.append(float(x["value"]))
                if with_median and x.get("median") is not None:
                    mt.append(trip); mk.append(day[5:10]); mv.append(float(x["median"]))
    if t:
        con.execute(f"""insert or replace into {NAME}_daily
            select unnest(?::varchar[]), unnest(?::varchar[])::date, unnest(?::double[])""", [t, d, v])
    if mt:
        con.execute(f"""insert or replace into {NAME}_median
            select trip, mmdd, any_value(m) from (select unnest(?::varchar[]) trip, unnest(?::varchar[]) mmdd, unnest(?::double[]) m)
            group by all""", [mt, mk, mv])
    return len(t)


def refresh(con, fetch):
    """Every 6 h: refresh the station list, backfill any station not yet pulled since WY1986, re-pull the last ~400 days with medians."""
    init(con)
    last = _meta(con, "pulled_at")
    if last and (dt.datetime.now() - dt.datetime.fromisoformat(last)).total_seconds() < REFRESH_SEC:
        return
    errors = []
    today = dt.date.today()
    triplets = _pull_stations(con, fetch) or [r[0] for r in con.execute(f"select triplet from {NAME}_stations").fetchall()]
    done = set(json.loads(_meta(con, "backfilled") or "[]"))
    todo = [t for t in triplets if t not in done]
    for i in range(0, len(todo), BACKFILL_BATCH):
        chunk = todo[i:i + BACKFILL_BATCH]
        try:
            _store(con, fetch(_data_url(chunk, HISTORY_START, today, False), timeout=300), False)
            done.update(chunk)
            _meta_set(con, "backfilled", json.dumps(sorted(done)))
        except Exception as e:  # noqa: BLE001  retried next refresh
            errors.append(f"backfill {chunk}: {e}")
    recent_ok = True
    for i in range(0, len(triplets), RECENT_BATCH):
        chunk = triplets[i:i + RECENT_BATCH]
        try:
            _store(con, fetch(_data_url(chunk, today - dt.timedelta(days=RECENT_DAYS), today, True)), True)
        except Exception as e:  # noqa: BLE001
            recent_ok = False
            errors.append(f"recent {chunk}: {e}")
    # Feb 29 medians exist only when the recent pull spans a leap day; fall back to Feb 28
    con.execute(f"""insert or ignore into {NAME}_median
        select triplet, '02-29', median_in from {NAME}_median where mmdd = '02-28'""")
    _meta_set(con, "errors", json.dumps(errors))
    if recent_ok and triplets:
        _meta_set(con, "pulled_at", dt.datetime.now().isoformat(timespec="seconds"))
    if errors:
        print(f"source {NAME}: {len(errors)} failed requests, e.g. {errors[0][:200]}", flush=True)


# ---------------------------------------------------------------- query helpers

def _r(v, n=1):
    return None if v is None else round(float(v), n)


def _wy_start(d):
    return dt.date(d.year if d.month >= 10 else d.year - 1, 10, 1)


def _day_index(con, basin, day):
    """Basin index on one day: avg SWE, % of median, avg median, n reporting."""
    return con.execute(f"""
        select avg(d.swe_in), sum(d.swe_in) filter (where m.median_in is not null),
               sum(m.median_in) filter (where d.swe_in is not null), avg(m.median_in), count(d.swe_in)
        from {NAME}_daily d join {NAME}_stations s using (triplet)
        left join {NAME}_median m on m.triplet = d.triplet and m.mmdd = strftime(d.day, '%m-%d')
        where s.basin = ? and d.day = ?""", [basin, day]).fetchone()


def _pct(swe_sum, med_sum, med_avg):
    if med_avg is None or med_avg < MIN_MEDIAN_IN or not med_sum:
        return None
    return _r(100 * swe_sum / med_sum, 0)


def _peak(con, basin, start, end):
    """Highest daily basin-average SWE between start and end, on days most stations reported (avoids jumps from gaps)."""
    r = con.execute(f"""
        with x as (select d.day, avg(d.swe_in) swe, count(*) n from {NAME}_daily d join {NAME}_stations s using (triplet)
                   where s.basin = ? and d.day between ? and ? group by d.day)
        select day, swe from x where n >= 0.8 * (select median(n) from x) order by swe desc, day limit 1""", [basin, start, end]).fetchone()
    return (r[0].isoformat(), _r(r[1])) if r else (None, None)


def query(con, window):
    to_day = window["to_day"]
    if not con.execute(f"select count(*) from {NAME}_daily").fetchone()[0]:
        return {"error": "No SNOTEL snowpack data pulled yet."}
    wy = _wy_start(to_day)
    basins = []
    for key, (label, _, _) in BASINS.items():
        n_sta = con.execute(f"select count(*) from {NAME}_stations where basin = ?", [key]).fetchone()[0]
        # the last day on or before the window's end with at least half the stations reporting (today's reading may lag)
        r = con.execute(f"""select d.day from {NAME}_daily d join {NAME}_stations s using (triplet)
            where s.basin = ? and d.day <= ? and d.day > ? group by d.day having count(*) >= ? order by d.day desc limit 1""",
                        [key, to_day, to_day - dt.timedelta(days=10), max(1, n_sta // 2)]).fetchone()
        if not r:
            basins.append({"basin": key, "label": label, "stations": n_sta, "reporting": 0})
            continue
        day = r[0]
        swe, swe_sum, med_sum, med_avg, n = _day_index(con, key, day)
        pk_day, pk_swe = _peak(con, key, wy, day)
        # last winter, for context when this one hasn't started
        prev = _wy_start(wy - dt.timedelta(days=1))
        lp_day, lp_swe = _peak(con, key, prev, wy - dt.timedelta(days=1))
        a = _day_index(con, key, dt.date(wy.year, 4, 1))
        basins.append({
            "basin": key, "label": label, "as_of": day.isoformat(), "stations": n_sta, "reporting": n,
            "swe_in": _r(swe), "median_in": _r(med_avg), "pct_median": _pct(swe_sum, med_sum, med_avg),
            "off_season": med_avg is None or med_avg < MIN_MEDIAN_IN,
            "peak_in": pk_swe, "peak_day": pk_day,
            "last_wy": {"water_year": wy.year, "peak_in": lp_swe, "peak_day": lp_day,
                        "apr1_in": _r(a[0]), "apr1_pct": _pct(a[1], a[2], a[3])},
        })
    stations = [list(r) for r in con.execute(f"""select triplet, name, basin, round(elev_ft)::int from {NAME}_stations
                                                  order by basin, name""").fetchall()]
    return {"water_year": wy.year + 1, "basins": basins, "stations": stations, "pulled_at": _meta(con, "pulled_at"),
            "min_median_in": MIN_MEDIAN_IN,
            "units": {"swe": "inches of water in the snowpack (snow water equivalent), average over stations",
                      "pct_median": "basin total SWE / same stations' median for that calendar day, %"}}


def history(con):
    if not con.execute(f"select count(*) from {NAME}_daily").fetchone()[0]:
        return {"error": "No SNOTEL snowpack data pulled yet."}
    today = dt.date.today()
    last_wy = today.year if today >= dt.date(today.year, 4, 1) else today.year - 1  # water years whose April 1 has passed
    rows = con.execute(f"""
        with d as (select s.basin, d.day, d.swe_in, m.median_in,
                          year(d.day) + (month(d.day) >= 10)::int wy
                   from {NAME}_daily d join {NAME}_stations s using (triplet)
                   left join {NAME}_median m on m.triplet = d.triplet and m.mmdd = strftime(d.day, '%m-%d')),
             apr as (select basin, wy, avg(swe_in) swe, count(*) n,
                            sum(swe_in) filter (where median_in is not null) / nullif(sum(median_in), 0) * 100 pct
                     from d where month(day) = 4 and day(day) = 1 group by all),
             idx as (select basin, wy, day, avg(swe_in) swe, count(*) n from d group by all),
             pk as (select basin, wy, arg_max(day, swe) filter (where n >= 0.8 * mx) pday, max(swe) filter (where n >= 0.8 * mx) pswe
                    from (select *, median(n) over (partition by basin, wy) mx from idx) group by all)
        select apr.basin, apr.wy, apr.swe, apr.pct, apr.n, pk.pswe, pk.pday
        from apr left join pk using (basin, wy) where apr.wy <= ? order by apr.wy, apr.basin""", [last_wy]).fetchall()
    years = sorted({r[1] for r in rows})
    out = {k: {"label": BASINS[k][0], "apr1_in": [], "apr1_pct": [], "stations": [], "peak_in": [], "peak_day": []} for k in BASINS}
    by = {(r[0], r[1]): r for r in rows}
    for y in years:
        for k in BASINS:
            r = by.get((k, y))
            out[k]["apr1_in"].append(_r(r[2]) if r else None)
            out[k]["apr1_pct"].append(_r(r[3], 0) if r else None)
            out[k]["stations"].append(r[4] if r else 0)
            out[k]["peak_in"].append(_r(r[5]) if r else None)
            out[k]["peak_day"].append(r[6].isoformat()[5:] if r and r[6] else None)
    n_now = {k: v for k, v in con.execute(f"select basin, count(*) from {NAME}_stations group by 1").fetchall()}
    return {"water_years": years, "basins": out, "stations_now": n_now, "pulled_at": _meta(con, "pulled_at"),
            "median_note": "NRCS daily median for each station (the API's centralTendencyType=MEDIAN)",
            "units": {"apr1_in": "inches of water in the snowpack on April 1, average over reporting stations",
                      "apr1_pct": "% of median on April 1 (basin total / same stations' median)",
                      "peak_in": "highest daily basin-average SWE that water year", "peak_day": "MM-DD"}}
