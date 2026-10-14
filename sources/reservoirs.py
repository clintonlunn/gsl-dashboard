"""Storage in the reservoirs upstream of Great Salt Lake: water held back from the lake.

Sources (all keyless):
  * NRCS Air and Water Database (AWDB) REST API, element RESC (reservoir storage, acre-feet), daily and monthly
    (end-of-month), stations "<id>:<state>:BOR". https://wcc.sc.egov.usda.gov/awdbRestApi/
    Capacities come from the same API's station metadata (reservoirMetadata.capacity).
  * Utah Division of Water Rights river-commissioner records (daily storage, acre-feet), JSON from
    https://www.waterrights.utah.gov/dvrtdb/daily-chart.asp?station_id=<id>&f=json — used for Cutler (9410, not in
    AWDB), Porcupine (11297, AWDB is monthly only) and Bear Lake (9460, AWDB is monthly only).
    Bear Lake's Water Rights figures sit ~120,000 acre-ft above NRCS's (a different zero), so each day is shifted by
    (Water Rights - NRCS) at the latest month-end before it, keeping the NRCS basis and its 1,302,000 acre-ft capacity.
  * Cutler capacity 13,200 acre-ft (total storage at 4,407.5 ft): PacifiCorp's LIHI questionnaire, citing the 1994
    FERC license. https://lowimpacthydro.org/wp-content/uploads/2020/09/Cutler-Questionnaire.pdf

USBR RISE (https://data.usbr.gov/rise/api/) carries the same BOR numbers on the same dates and no sooner, and lacks
Bear Lake, Woodruff Narrows and Cutler, so it isn't pulled. (AWDB's Report Generator CSV labels each day one day
later than the AWDB API and RISE; we follow the API.)

Strawberry Reservoir is in the Colorado River basin; water it sends west through the Strawberry tunnels reaches
Utah Lake. It is reported on its own and left out of the "held from the lake" totals.
"""
import datetime as dt
import json
import time

NAME = "reservoirs"
REFRESH_SEC = 6 * 3600
DAILY_START = "1996-10-01"     # 30 water years of daily storage (~11 k rows a reservoir)
MONTHLY_START = DAILY_START
PAST_YEARS = 30                # "usual" = median of the same date in up to this many earlier years
MIN_YEARS = 5
STALE_DAYS = 45                # a daily reading older than this (before the window end) isn't shown as current
AWDB = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1"
WR = "https://www.waterrights.utah.gov/dvrtdb/daily-chart.asp"
LIHI = "https://lowimpacthydro.org/wp-content/uploads/2020/09/Cutler-Questionnaire.pdf"

SYSTEMS = [  # key, label, counted in "held from the lake"
    ("bear", "Bear River", True),
    ("weber", "Weber & Ogden rivers", True),
    ("jordan", "Provo & Jordan rivers", True),
    ("import", "Strawberry (Colorado River basin)", False),
]
# id, name, system, AWDB triplet (monthly, capacity, and daily unless wr given), Water Rights daily station, capacity
# fallback (acre-ft), smooth (trailing 7-day median, for gauges that wind sets up)
RES = [
    ("bear_lake", "Bear Lake", "bear", "10055500:ID:BOR", "9460", 1302000, False),
    ("woodruff_narrows", "Woodruff Narrows", "bear", "10020200:WY:BOR", None, 57300, False),
    ("woodruff_creek", "Woodruff Creek", "bear", "10UTWOOD:UT:BOR", None, 4000, False),
    ("porcupine", "Porcupine", "bear", "10105200:UT:BOR", "11297", 11300, False),
    ("hyrum", "Hyrum", "bear", "10107000:UT:BOR", None, 15300, False),
    ("newton", "Newton", "bear", "09UTNEWT:UT:BOR", None, 5374, False),
    ("cutler", "Cutler", "bear", None, "9410", 13200, False),
    ("smith_morehouse", "Smith & Morehouse", "weber", "10128000:UT:BOR", None, 8100, False),
    ("rockport", "Rockport", "weber", "10129400:UT:BOR", None, 60900, False),
    ("echo", "Echo", "weber", "10131500:UT:BOR", None, 73900, False),
    ("lost_creek", "Lost Creek", "weber", "10132490:UT:BOR", None, 22500, False),
    ("east_canyon", "East Canyon", "weber", "10134000:UT:BOR", None, 49500, False),
    ("causey", "Causey", "weber", "10137290:UT:BOR", None, 7100, False),
    ("pineview", "Pineview", "weber", "10139000:UT:BOR", None, 110100, False),
    ("willard_bay", "Willard Bay", "weber", "10140800:UT:BOR", None, 215000, False),
    ("trial", "Trial Lake", "jordan", "09UTTRLK:UT:BOR", None, 1928, False),
    ("washington", "Washington Lake", "jordan", "09UTWASH:UT:BOR", None, 2705, False),
    ("jordanelle", "Jordanelle", "jordan", "10155050:UT:BOR", None, 314000, False),
    ("deer_creek", "Deer Creek", "jordan", "09UT06JJ:UT:BOR", None, 149700, False),
    ("utah_lake", "Utah Lake", "jordan", "10166500:UT:BOR", None, 870900, True),
    ("strawberry", "Strawberry", "import", "09282500:UT:BOR", None, 1105900, False),
]
# AWDB stations that only report monthly; they get no daily pull
# (Montpelier, 10069500:ID:BOR, stopped reporting in April 2025 and is left out.)
MONTHLY_ONLY = {"woodruff_narrows", "woodruff_creek", "newton", "trial", "washington"}
NOTES = {
    "bear_lake": "Daily from Utah Water Rights, shifted to the NRCS basis; capacity is usable storage above 5,902 ft.",
    "cutler": "Capacity from the 1994 FERC license (PacifiCorp LIHI questionnaire).",
    "utah_lake": "Natural lake used as a reservoir; wind piles water at the gauge, so daily values are a 7-day median. Capacity is storage at compromise level.",
    "willard_bay": "Off-river bay filled by canal from the Weber River.",
    "strawberry": "Colorado River basin; not counted as held from Great Salt Lake.",
    "porcupine": "Daily from Utah Water Rights since 2025; earlier years use NRCS month-end values.",
}
BY_ID = {r[0]: r for r in RES}
SYS_LABEL = {k: lab for k, lab, _ in SYSTEMS}
SYS_COUNTED = {k: c for k, _, c in SYSTEMS}


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_raw (src varchar, station varchar, "day" date, af double,
                                               primary key (src, station, "day"));
        create table if not exists {NAME}_monthly_raw (station varchar, "month" date, af double,
                                                       primary key (station, "month"));
        create table if not exists {NAME}_daily (res_id varchar, "day" date, af double, primary key (res_id, "day"));
        create table if not exists {NAME}_capacity (res_id varchar primary key, capacity_af double, src varchar);
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


def _get(fetch, url, timeout=240):
    """AWDB now and then answers 403 or times out; one retry."""
    try:
        return fetch(url, timeout=timeout)
    except Exception:  # noqa: BLE001
        time.sleep(3)
        return fetch(url, timeout=timeout)


def _put_raw(con, src, station, days, vals):
    if days:
        con.execute(f"""insert or replace into {NAME}_raw
                        select ?, ?, unnest(?::date[]), unnest(?::double[])""", [src, station, days, vals])


def _since(con, where, params, default, back_days):
    r = con.execute(f'select max("day") from {NAME}_raw where {where}', params).fetchone()[0]
    return default if r is None else (r - dt.timedelta(days=back_days)).isoformat()


def _pull_awdb(con, fetch, today):
    triplets = [r[3] for r in RES if r[3]]
    daily = [r[3] for r in RES if r[3] and not r[4] and r[0] not in MONTHLY_ONLY]
    # capacity from station metadata
    st = _get(fetch, f"{AWDB}/stations?stationTriplets={','.join(triplets)}&returnReservoirMetadata=true&activeOnly=false")
    cap = {s["stationTriplet"]: (s.get("reservoirMetadata") or {}).get("capacity") for s in st}
    for rid, _, _, trip, _, fallback, _ in RES:
        c = cap.get(trip) if trip else None
        con.execute(f"insert or replace into {NAME}_capacity values (?, ?, ?)",
                    [rid, c or fallback, "NRCS AWDB station metadata" if c else ("FERC license via LIHI" if rid == "cutler" else "published")])
    # daily, re-pulling the last 60 days for revisions
    since = _since(con, "src = 'awdb'", [], DAILY_START, 60)
    d = _get(fetch, f"{AWDB}/data?stationTriplets={','.join(daily)}&elements=RESC&duration=DAILY"
                    f"&beginDate={since}&endDate={today}", timeout=300)
    for s in d:
        for e in s.get("data", []):
            v = [x for x in e.get("values", []) if x.get("value") is not None]
            _put_raw(con, "awdb", s["stationTriplet"], [x["date"][:10] for x in v], [float(x["value"]) for x in v])
    # monthly (end of month)
    r = con.execute(f'select max("month") from {NAME}_monthly_raw').fetchone()[0]
    since = MONTHLY_START if r is None else (r - dt.timedelta(days=400)).isoformat()
    m = _get(fetch, f"{AWDB}/data?stationTriplets={','.join(triplets)}&elements=RESC&duration=MONTHLY"
                    f"&beginDate={since}&endDate={today}", timeout=300)
    for s in m:
        for e in s.get("data", []):
            v = [x for x in e.get("values", []) if x.get("value") is not None]
            if v:
                con.execute(f"""insert or replace into {NAME}_monthly_raw
                                select ?, unnest(?::date[]), unnest(?::double[])""",
                            [s["stationTriplet"], [f"{x['year']}-{x['month']:02d}-01" for x in v], [float(x["value"]) for x in v]])


def _pull_wr(con, fetch, today, station):
    since = _since(con, "src = 'wr' and station = ?", [station], None, 60)
    q = f"&begin_date={since}&end_date={today}" if since else ""
    d = _get(fetch, f"{WR}?station_id={station}{q}&f=json", timeout=180)
    days, vals = [], []
    for x in d.get("data", []):
        try:
            v = float(x["value"])
        except (KeyError, TypeError, ValueError):
            continue
        days.append(x["date"][:10]); vals.append(v)
    _put_raw(con, "wr", station, days, vals)


def _rebuild_daily(con):
    """Clean daily table: map stations to reservoirs, put Bear Lake on the NRCS basis, drop spikes, smooth Utah Lake."""
    m = [(rid, "awdb" if (trip and not wr) else "wr", trip if (trip and not wr) else wr, trip, 1 if smooth else 0)
         for rid, _, _, trip, wr, _, smooth in RES if rid not in MONTHLY_ONLY]
    con.execute(f"""
        create or replace temp table _rmap as select * from (values {", ".join("(?, ?, ?, ?, ?)" for _ in m)})
            t(res_id, src, station, triplet, smooth)""", [v for row in m for v in row])
    con.execute(f"""
        create or replace table {NAME}_daily as
        with raw as (
            select m.res_id, m.triplet, m.smooth, m.src, r."day", r.af,
                   median(r.af) over (partition by m.res_id order by r."day"
                                      range between interval 3 days preceding and interval 3 days following) mid
            from {NAME}_raw r join _rmap m using (src, station) where r.af > 0),
        -- Bear Lake: Water Rights minus NRCS at each NRCS month-end
        offs as (
            select raw.res_id, raw."day", raw.mid - mo.af shift
            from raw join {NAME}_monthly_raw mo on mo.station = raw.triplet and last_day(mo."month") = raw."day"
            where raw.src = 'wr' and raw.res_id = 'bear_lake'),
        first_off as (select res_id, arg_min(shift, "day") shift from offs group by res_id),
        shifted as (
            select raw.res_id, raw.smooth, raw."day",
                   raw.af - coalesce(o.shift, f.shift, 0) af, raw.mid - coalesce(o.shift, f.shift, 0) mid
            from raw asof left join offs o on raw.res_id = o.res_id and raw."day" >= o."day"
                     left join first_off f on raw.res_id = f.res_id),
        clean as (
            select s.* from shifted s join {NAME}_capacity c using (res_id)
            where abs(s.af - s.mid) <= greatest(0.05 * c.capacity_af, 2000))
        select res_id, "day",
               case when smooth = 1 then median(af) over (partition by res_id order by "day"
                                                          range between interval 6 days preceding and current row)
                    else af end af
        from clean order by res_id, "day" """)


def refresh(con, fetch):
    init(con)
    last = _meta(con, "pulled_at")
    if last and (dt.datetime.now() - dt.datetime.fromisoformat(last)).total_seconds() < REFRESH_SEC:
        return
    today = dt.date.today().isoformat()
    errors = {}
    try:
        _pull_awdb(con, fetch, today)
    except Exception as e:  # noqa: BLE001  keep old rows; try the other source
        errors["awdb"] = str(e)
    for st in sorted({r[4] for r in RES if r[4]}):
        try:
            _pull_wr(con, fetch, today, st)
        except Exception as e:  # noqa: BLE001
            errors[f"wr {st}"] = str(e)
    if con.execute(f"select count(*) from {NAME}_capacity").fetchone()[0]:
        _rebuild_daily(con)
    _meta_set(con, "errors", json.dumps(errors))
    if not errors:
        _meta_set(con, "pulled_at", dt.datetime.now().isoformat(timespec="seconds"))
    else:
        print(f"source {NAME}: {errors}", flush=True)


# ---------------------------------------------------------------- query

def _r(v):
    return None if v is None else int(round(v))


def _link(rid):
    _, _, _, trip, wr, _, _ = BY_ID[rid]
    if wr:
        return f"{WR}?station_id={wr}"
    return ("https://wcc.sc.egov.usda.gov/reportGenerator/view/customSingleStationReport/"
            f"{'monthly' if rid in MONTHLY_ONLY else 'daily'}/{trip}%7Cid=%22%22%7Cname/-30,0/RESC::value")


def _same_day(day, year):
    try:
        return day.replace(year=year)
    except ValueError:  # Feb 29
        return day.replace(year=year, day=28)


class _Store:
    """Everything query() needs, read once (a few hundred kB) into dicts."""

    def __init__(self, con):
        self.daily = {}
        for rid, day, af in con.execute(f'select res_id, "day", af from {NAME}_daily').fetchall():
            self.daily.setdefault(rid, {})[day] = af
        self.monthly = {}
        trip_to_id = {r[3]: r[0] for r in RES if r[3]}
        for st, month, af in con.execute(f'select station, "month", af from {NAME}_monthly_raw').fetchall():
            if st in trip_to_id:
                self.monthly.setdefault(trip_to_id[st], {})[month] = af
        self.cap = dict(con.execute(f"select res_id, capacity_af from {NAME}_capacity").fetchall())

    def daily_asof(self, rid, day, max_back):
        d = self.daily.get(rid, {})
        for i in range(max_back + 1):
            x = day - dt.timedelta(days=i)
            if x in d:
                return x, d[x]
        return None, None

    def month_asof(self, rid, day, max_back_months=2):
        """Latest month-end value on or before `day` (month-ends, dated as the last day)."""
        m = self.monthly.get(rid, {})
        first = dt.date(day.year, day.month, 1)
        for i in range(max_back_months + 1):
            y, mo = divmod(first.month - 1 - i, 12)
            key = dt.date(first.year + y, mo + 1, 1)
            end = dt.date(key.year + key.month // 12, key.month % 12 + 1, 1) - dt.timedelta(days=1)
            if end <= day and key in m:
                return end, m[key]
        return None, None

    def value_on(self, rid, day):
        """For past years: the daily value on that date, else the month-end value before it."""
        v = self.daily.get(rid, {}).get(day)
        if v is not None:
            return v
        return self.month_asof(rid, day, 1)[1]

    def current(self, rid, day):
        """(date, acre-ft, monthly?) — daily where we have it, else NRCS month-end (e.g. Bear Lake before 2007)."""
        if rid not in MONTHLY_ONLY:
            d, v = self.daily_asof(rid, day, STALE_DAYS)
            if v is not None:
                return d, v, False
        d, v = self.month_asof(rid, day)
        return d, v, True


def _median(vals):
    s = sorted(vals)
    n = len(s)
    return None if not n else s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def query(con, window):
    from_day, to_day = window["from_day"], window["to_day"]
    if isinstance(from_day, str):
        from_day, to_day = dt.date.fromisoformat(from_day), dt.date.fromisoformat(to_day)
    if not con.execute(f"select count(*) from {NAME}_daily").fetchone()[0]:
        return {"error": "No reservoir storage pulled yet."}
    S = _Store(con)
    before = from_day - dt.timedelta(days=1)
    rows, now_day = [], {}
    for rid, name, sys_, trip, wr, _, _ in RES:
        day, af, monthly = S.current(rid, to_day)
        if af is None:
            rows.append({"id": rid, "name": name, "system": sys_, "storage_af": None, "link": _link(rid)})
            continue
        now_day[rid] = day
        cap = S.cap.get(rid)
        if monthly:
            d0, a0 = S.month_asof(rid, before, 1)
        else:
            d0, a0 = S.daily_asof(rid, before, 10)
        change = af - a0 if a0 is not None and d0 < day else None
        past = [v for y in range(day.year - PAST_YEARS, day.year)
                if (v := S.value_on(rid, _same_day(day, y))) is not None]
        med = _median(past) if len(past) >= MIN_YEARS else None
        rows.append({
            "id": rid, "name": name, "system": sys_, "storage_af": _r(af), "as_of": day.isoformat(),
            "capacity_af": _r(cap), "pct_full": None if not cap else round(100 * af / cap, 1),
            "change_af": _r(change), "change_from": d0.isoformat() if change is not None else None,
            "median_af": _r(med), "median_years": len(past) if med is not None else None,
            "freq": "monthly" if monthly else "daily",
            "src": "Utah Division of Water Rights" if wr else "NRCS AWDB",
            "station": wr if wr else trip, "link": _link(rid), "note": NOTES.get(rid)})

    def summarize(keys):
        live = [r for r in rows if r["system"] in keys and r["storage_af"] is not None]
        if not live:
            return None
        st = sum(r["storage_af"] for r in live)
        cap = sum(r["capacity_af"] or 0 for r in live)
        ch = [r for r in live if r["change_af"] is not None]
        # usual: median over past years of the summed storage, each reservoir on its own as-of date
        # usual: each reservoir's own same-date median, summed over the reservoirs that have one
        # (Newton, Trial and Washington have only a few years online), compared with those reservoirs' storage
        wm = [r for r in live if r.get("median_af") is not None]
        med = sum(r["median_af"] for r in wm) if wm else None
        st_m = sum(r["storage_af"] for r in wm)
        days = sorted(now_day[r["id"]] for r in live if r["freq"] == "daily")
        return {"storage_af": st, "capacity_af": cap, "pct_full": round(100 * st / cap, 1) if cap else None,
                "change_af": sum(r["change_af"] for r in ch) if ch else None, "change_n": len(ch),
                "median_af": med, "median_n": len(wm), "storage_with_median_af": st_m,
                "pct_of_median": round(100 * st_m / med) if med else None, "n": len(live),
                "through": days[-1].isoformat() if days else None, "oldest": days[0].isoformat() if days else None}

    systems = []
    for k, lab, counted in SYSTEMS:
        s = summarize({k})
        if s:
            systems.append({"system": k, "label": lab, "in_total": counted, **s})
    total = summarize({k for k, _, c in SYSTEMS if c})
    return {
        "window": {"from": from_day.isoformat(), "to": to_day.isoformat()},
        "total": total, "systems": systems,
        # per-reservoir rows without the bulky repeated fields when absent
        "reservoirs": [{k: v for k, v in r.items() if v is not None} for r in rows],
        "past_years": PAST_YEARS,
        "pulled_at": _meta(con, "pulled_at"),
        "errors": json.loads(_meta(con, "errors") or "{}") or None,
        "sources": {"awdb": "https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html",
                    "wr": "https://www.waterrights.utah.gov/dvrtdb/daily-chart.asp", "cutler_capacity": LIHI},
    }


def history(con):
    """Month-end storage per river system: NRCS AWDB month-end values, plus Cutler's last daily value each month."""
    if not con.execute(f"select count(*) from {NAME}_monthly_raw").fetchone()[0]:
        return {"error": "No reservoir storage pulled yet."}
    trip = {r[3]: r[0] for r in RES if r[3]}
    rows = con.execute(f'select station, "month", af from {NAME}_monthly_raw where "month" >= ?', [DAILY_START]).fetchall()
    data = {}
    for st, month, af in rows:
        if st in trip:
            data.setdefault(month, {})[trip[st]] = af
    for rid in [r[0] for r in RES if not r[3]]:
        for month, af in con.execute(f"""select date_trunc('month', "day")::date, arg_max(af, "day") from {NAME}_daily
                                         where res_id = ? and "day" >= ? group by 1""", [rid, DAILY_START]).fetchall():
            if month in data:  # only months NRCS has closed out
                data[month][rid] = af
    months = sorted(data)
    out = {"months": [m.isoformat()[:7] for m in months], "systems": [], "past_years": PAST_YEARS}
    caps = dict(con.execute(f"select res_id, capacity_af from {NAME}_capacity").fetchall())
    for k, lab, counted in SYSTEMS:
        ids = [r[0] for r in RES if r[2] == k]
        out["systems"].append({
            "system": k, "label": lab, "in_total": counted, "capacity_af": _r(sum(caps.get(i, 0) for i in ids)),
            "reservoirs": len(ids),
            "af": [_r(sum(data[m].get(i, 0) for i in ids)) if any(i in data[m] for i in ids) else None for m in months],
            "n": [sum(i in data[m] for i in ids) for m in months]})
    return out
