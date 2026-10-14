"""The whole lake: north arm vs south arm across the railroad causeway, flow through the breach, and the bays.

USGS NWIS gauges (same waterservices IV/DV endpoints as server.py, kept in our own whole_lake_* tables):

    10010024  south arm level at the causeway (62614, since Dec 2018)
    10010027  north arm level at the causeway (62614, since Nov 2018)
    10010100  north arm level near Saline (62614, daily since 1966)
    10010000  south arm level at Saltair (62614) -- also used by the main page; pulled here for the head difference
    10010020  Lakeside breach (west end of the causeway) discharge (00060, since 2008; positive = south to north)
    10010025  bridge breach 6 mi E of Lakeside: no discharge is published, only a profile of north-velocity cells (72254)
    10010060  Bear River Bay outflow at the causeway bridge: velocity (72254); discharge (00060) only 2008-2013
    411403112200801  Bear River Bay outflow at GSL Minerals bridge: velocity (72254, 72322); discharge only 2005-2007
    410401112134801  Farmington Bay outflow at the causeway bridge: discharge, specific conductance, water temperature

Levels are NGVD 1929 feet, reported by USGS to 0.1 ft. Times are local wall-clock, as USGS shows them.
"""
import datetime as dt
import json
import math
import os
import re
import tempfile
import urllib.request

NAME = "whole_lake"

IV = "https://waterservices.usgs.gov/nwis/iv/"
DV = "https://waterservices.usgs.gov/nwis/dv/"
SITES = {  # site -> (short label, role)
    "10010024": ("South arm at the causeway", "south"),
    "10010027": ("North arm at the causeway", "north"),
    "10010100": ("North arm near Saline", "north_saline"),
    "10010000": ("South arm at Saltair", "south_saltair"),
    "10010020": ("Lakeside breach", "breach_lakeside"),
    "10010025": ("Causeway bridge breach", "breach_bridge"),
    "10010060": ("Bear River Bay outflow at causeway bridge", "bear_causeway"),
    "411403112200801": ("Bear River Bay outflow at GSL Minerals bridge", "bear_minerals"),
    "410401112134801": ("Farmington Bay outflow at causeway bridge", "farmington"),
}
FULL_NAMES = {
    "10010024": "GSL S. SIDE OF CAUSEWAY, 6 MILES E OF LAKESIDE, UT",
    "10010027": "GSL N. SIDE OF CAUSEWAY, 6 MILES E OF LAKESIDE, UT",
    "10010100": "GREAT SALT LAKE NEAR SALINE, UT",
    "10010000": "GREAT SALT LAKE AT SALTAIR BOAT HARBOR, UT",
    "10010020": "GSL BREACH AT LAKESIDE, UT",
    "10010025": "GSL BREACH 6 MILES E OF LAKESIDE, UT; S TO N FLOW",
    "10010060": "BEAR R BAY OUTFLOW AT CAUSEWAY BRG NR WARREN, UT",
    "411403112200801": "BEAR RIVER BAY OUTFLOW AT GSL MINERALS CORP BRIDGE",
    "410401112134801": "GSL FARMINGTON BAY OUTFLOW AT CAUSEWAY BRIDGE",
}
IV_PARAMS = "62614,00060,00095,00010,72254,72322"
DV_PARAMS = "62614,00060,00095,00010"
DV_SITES = ["10010024", "10010027", "10010100", "10010000", "10010020", "10010060", "411403112200801", "410401112134801"]
DV_START = "1966-01-01"  # the north arm record (Saline) starts Apr 1966
IV_START = dt.date(2007, 10, 1)  # instantaneous values aren't reliably online before this
IV_FIRST_DAYS = 40  # first refresh pulls this much 15-minute data
IV_BACKFILL_MONTHS = 4  # at most this many months of 15-minute data pulled per page request
IV_REFRESH_SEC = 3600
DV_REFRESH_SEC = 24 * 3600
AF_PER_CFS_HOUR = 1 / 12.1  # 1 cfs for 1 hour = 0.0826 acre-ft (1.9835 per day)
DAILY_SERIES_MAX = 730  # daily windows longer than this send weekly points


# ---------------------------------------------------------------- storage

def init(con):
    con.execute(f"""
        create table if not exists {NAME}_iv (site_id varchar, param varchar, label varchar, ts timestamp, value double,
                                              primary key (site_id, param, label, ts));
        create table if not exists {NAME}_dv (site_id varchar, param varchar, "day" date, value double,
                                              primary key (site_id, param, "day"));
        create table if not exists {NAME}_pulled (kind varchar, chunk varchar, primary key (kind, chunk));
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


def _age_sec(con, k):
    v = _meta(con, k)
    return (dt.datetime.now() - dt.datetime.fromisoformat(v)).total_seconds() if v else float("inf")


def _upsert(con, table, cols, rows):
    if not rows:
        return
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    try:
        con.execute(f"insert or replace into {table} select * from read_json('{f.name}', columns={cols})")
    finally:
        os.unlink(f.name)


IV_COLS = "{site_id: 'VARCHAR', param: 'VARCHAR', label: 'VARCHAR', ts: 'TIMESTAMP', value: 'DOUBLE'}"
DV_COLS = "{site_id: 'VARCHAR', param: 'VARCHAR', day: 'DATE', value: 'DOUBLE'}"


# ---------------------------------------------------------------- fetching

def _fetch(url, body=None, timeout=180):
    """Same as server.fetch, for on-demand backfill from query() (which isn't handed a fetch)."""
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json", "User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _parse(d, daily):
    """USGS WaterML-JSON -> rows. A site can carry several series of one parameter (velocity cells, sensors);
    each is kept apart by its method description. Duplicate keys (the repeated hour at the fall DST change) keep
    the last reading, so one insert never touches a row twice."""
    out = {}
    for t in d["value"]["timeSeries"]:
        site = t["sourceInfo"]["siteCode"][0]["value"]
        param = t["variable"]["variableCode"][0]["value"]
        nodata = t["variable"].get("noDataValue", -999999.0)
        for vals in t["values"]:
            label = (vals.get("method") or [{}])[0].get("methodDescription", "") or ""
            for v in vals["value"]:
                try:
                    val = float(v["value"])
                except (TypeError, ValueError):
                    continue
                if val == nodata or val <= -999990:
                    continue
                if daily:
                    out[(site, param, v["dateTime"][:10])] = {"site_id": site, "param": param, "day": v["dateTime"][:10], "value": val}
                else:
                    ts = v["dateTime"][:19]
                    out[(site, param, label, ts)] = {"site_id": site, "param": param, "label": label, "ts": ts, "value": val}
    return list(out.values())


def _pull_iv(fetch, start, end):
    url = f"{IV}?format=json&sites={','.join(SITES)}&parameterCd={IV_PARAMS}&startDT={start}&endDT={end}"
    return _parse(fetch(url, timeout=300), daily=False)


def _pull_dv(fetch, start, end):
    url = (f"{DV}?format=json&sites={','.join(DV_SITES)}&parameterCd={DV_PARAMS}&statCd=00003"
           f"&startDT={start}&endDT={end}")
    return _parse(fetch(url, timeout=300), daily=True)


def _months(a, b):
    out, d = [], dt.date(a.year, a.month, 1)
    while d <= b:
        nxt = dt.date(d.year + d.month // 12, d.month % 12 + 1, 1)
        out.append((d, nxt))
        d = nxt
    return out


def _ensure_iv(con, fetch, start, end, cap=None):
    """Pull 15-minute data for months in [start, end] not pulled yet; at most `cap` months. Returns months pulled."""
    have = {r[0] for r in con.execute(f"select chunk from {NAME}_pulled where kind = 'iv'").fetchall()}
    todo = [(a, b) for a, b in _months(max(start, IV_START), end) if f"{a:%Y-%m}" not in have]
    done = 0
    for a, b in todo[:cap] if cap else todo:
        _upsert(con, f"{NAME}_iv", IV_COLS, _pull_iv(fetch, a.isoformat(), min(b, dt.date.today() + dt.timedelta(days=1)).isoformat()))
        con.execute(f"insert or replace into {NAME}_pulled values ('iv', ?)", [f"{a:%Y-%m}"])
        done += 1
    return done, len(todo) - done


def refresh(con, fetch):
    """15-minute data at most hourly (last few days re-pulled, provisional readings get revised); daily values at
    most daily (the full record once, then the last 30 days)."""
    init(con)
    today = dt.date.today()
    if _age_sec(con, "dv_pulled_at") >= DV_REFRESH_SEC:
        start = DV_START if not _meta(con, "dv_full") else (today - dt.timedelta(days=30)).isoformat()
        _upsert(con, f"{NAME}_dv", DV_COLS, _pull_dv(fetch, start, today.isoformat()))
        _meta_set(con, "dv_full", "1")
        _meta_set(con, "dv_pulled_at", dt.datetime.now().isoformat(timespec="seconds"))
    if _age_sec(con, "iv_pulled_at") >= IV_REFRESH_SEC:
        last = _meta(con, "iv_last_day")
        if last:
            start = min(dt.date.fromisoformat(last), today) - dt.timedelta(days=2)
            _upsert(con, f"{NAME}_iv", IV_COLS, _pull_iv(fetch, start.isoformat(), (today + dt.timedelta(days=1)).isoformat()))
        else:
            _ensure_iv(con, fetch, today - dt.timedelta(days=IV_FIRST_DAYS), today)
        _meta_set(con, "iv_last_day", today.isoformat())
        _meta_set(con, "iv_pulled_at", dt.datetime.now().isoformat(timespec="seconds"))


# ---------------------------------------------------------------- query helpers

def _r(v, n=2):
    return None if v is None else round(v, n)


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _cell_elev(label):
    m = re.search(r"(4\d{3}(?:\.\d+)?)", label or "")
    return float(m.group(1)) if m else None


def _stats(s, t0, t1, step_h, pre=True):
    """Summary of one {time: value} series over [t0, t1): latest, means of the first and last day, change.
    Change is last day minus the day before the window when that exists (as the main page does for the lake),
    otherwise last day minus first day."""
    w = {k: v for k, v in s.items() if t0 <= k < t1}
    if not w:
        return None
    keys = sorted(w)
    last_t = keys[-1]
    day = dt.timedelta(hours=24)
    first = _mean([w[k] for k in keys if k < t0 + day])
    end = _mean([w[k] for k in keys if k > last_t - day])
    before = _mean([v for k, v in s.items() if t0 - day <= k < t0]) if pre else None
    startv = before if before is not None else first
    return {"latest": w[last_t], "latest_at": last_t.strftime("%Y-%m-%dT%H:%M"), "mean": _mean(w.values()),
            "min": min(w.values()), "max": max(w.values()), "start": startv, "start_is": "day before window" if before is not None else "first day",
            "end": end, "change": None if startv is None or end is None else end - startv,
            "readings": len(w), "expected": max(1, math.ceil((min(t1, dt.datetime.now()) - t0).total_seconds() / 3600 / step_h))}


def _round_stats(st, n):
    if not st:
        return None
    return {k: (_r(v, n) if isinstance(v, float) else v) for k, v in st.items()}


def _flow(s, t0, t1, step_h):
    """Acre-feet moved by a signed cfs series over the window: net, positive-direction and negative-direction."""
    w = [v for k, v in s.items() if t0 <= k < t1]
    if not w:
        return None
    f = step_h * AF_PER_CFS_HOUR
    return {"net_af": round(sum(w) * f), "positive_af": round(sum(v for v in w if v > 0) * f),
            "negative_af": round(-sum(v for v in w if v < 0) * f),
            "hours_positive": sum(step_h for v in w if v > 0), "hours_negative": sum(step_h for v in w if v < 0),
            "hours_zero": sum(step_h for v in w if v == 0)}


def _direction(v, eps, pos, neg):
    if v is None:
        return None
    return "none" if abs(v) < eps else pos if v > 0 else neg


# ---------------------------------------------------------------- query

def query(con, window):
    init(con)
    from_day, to_day, res = window["from_day"], window["to_day"], window["resolution"]
    t0 = dt.datetime.combine(from_day, dt.time())
    t1 = dt.datetime.combine(to_day + dt.timedelta(days=1), dt.time())
    pre0 = t0 - dt.timedelta(days=1)
    notes = []
    hourly = res == "hourly"
    if hourly:
        # backfill on demand: windows of up to 62 days need at most 4 months
        try:
            pulled, left = _ensure_iv(con, _fetch, from_day - dt.timedelta(days=1), to_day, cap=IV_BACKFILL_MONTHS)
            if left:
                notes.append(f"{left} more month(s) of 15-minute data still to pull; reload to fill them in.")
        except Exception as e:  # noqa: BLE001  show what's already stored
            notes.append(f"Couldn't pull 15-minute data from USGS: {e}")
        rows = con.execute(f"""
            select site_id, param, label, date_trunc('hour', ts) hr, avg(value) v from {NAME}_iv
            where ts >= ? and ts < ? group by all""", [pre0, t1]).fetchall()
        step_h = 1
    else:
        rows = con.execute(f"""
            select site_id, param, '' "label", "day"::timestamp hr, value v from {NAME}_dv
            where "day" >= ? and "day" < ?""", [pre0.date(), t1.date()]).fetchall()
        step_h = 24
    if not rows and not con.execute(f"select count(*) from {NAME}_dv").fetchone()[0]:
        return {"error": "No whole-lake gauge data pulled yet."}

    S = {}  # (site, param) -> {time: value}; several labels of one param are kept apart in C
    C = {}  # (site, param, label) -> {time: value}
    for site, param, label, hr, v in rows:
        C.setdefault((site, param, label), {})[hr] = v
    for (site, param, label), s in C.items():
        if param == "72254" or (site == "10010025" and param == "62614"):
            continue  # multi-sensor parameters are handled one by one below
        S.setdefault((site, param), {}).update(s)

    def have(site, param):
        return any(t0 <= k < t1 for k in S.get((site, param), {}))

    # ---- levels: the causeway pair (both sides of the same embankment) when present, else Saline / Saltair
    def overlap(a, b):
        x, y = S.get((a, "62614"), {}), S.get((b, "62614"), {})
        return sum(1 for k in x.keys() & y.keys() if t0 <= k < t1)
    # the causeway pair (both sides of one embankment, 2018 on) unless it covers clearly less of the window
    # than the long-record pair, Saline (north arm, 1966 on) and Saltair (south arm)
    cw, lg = overlap("10010024", "10010027"), overlap("10010000", "10010100")
    north_id, south_id = ("10010027", "10010024") if cw and cw >= 0.9 * lg else ("10010100", "10010000")
    if (north_id, south_id) != ("10010027", "10010024"):
        notes.append("The causeway level gauges (2018 on) don't cover these dates; levels are from Saline (north arm) and Saltair (south arm).")
    north, south = S.get((north_id, "62614"), {}), S.get((south_id, "62614"), {})
    head = {k: south[k] - north[k] for k in south.keys() & north.keys()}
    levels = {
        "north": {"site_id": north_id, "name": SITES[north_id][0], **(_round_stats(_stats(north, t0, t1, step_h), 2) or {})},
        "south": {"site_id": south_id, "name": SITES[south_id][0], **(_round_stats(_stats(south, t0, t1, step_h), 2) or {})},
        "head_ft": _round_stats(_stats(head, t0, t1, step_h), 2),
        "resolution_ft": 0.1,
    }
    other = "10010100" if north_id == "10010027" else None
    if other and have(other, "62614"):
        levels["north_saline"] = {"site_id": other, "name": SITES[other][0], **_round_stats(_stats(S[(other, "62614")], t0, t1, step_h), 2)}
    h = levels["head_ft"]
    if h:
        levels["higher_side"] = _direction(h["mean"], 0.05, "south", "north")

    # ---- the Lakeside breach (west end): published discharge
    lk = S.get(("10010020", "00060"), {})
    lst = _stats(lk, t0, t1, step_h, pre=False)
    breach_lakeside = None
    if lst:
        fl = _flow(lk, t0, t1, step_h)
        breach_lakeside = {"site_id": "10010020", "name": SITES["10010020"][0], **_round_stats(lst, 1),
                           "north_af": fl["positive_af"], "south_af": fl["negative_af"], "net_af": fl["net_af"],
                           "hours_north": fl["hours_positive"], "hours_south": fl["hours_negative"], "hours_zero": fl["hours_zero"],
                           "direction": _direction(lst["mean"], 0.5, "south to north", "north to south"),
                           "sign": "positive = south arm to north arm"}

    # ---- the bridge breach (6 mi E of Lakeside): velocity profile only (hourly windows; not in daily values)
    cells = {}
    for (site, param, label), s in C.items():
        if site == "10010025" and param == "72254":
            e = _cell_elev(label)
            w = {k: v for k, v in s.items() if t0 <= k < t1}
            if e is not None and w:
                cells[e] = w
    breach_bridge = {"site_id": "10010025", "name": SITES["10010025"][0], "available": bool(cells),
                     "sign": "positive = moving north (south arm to north arm)"}
    bu, bl, bm = {}, {}, {}
    if cells:
        # cells that only report now and then (the top one is often out of the water) stay in the profile but not the layers
        most = max(len(c) for c in cells.values())
        steady = sorted(e for e, c in cells.items() if len(c) >= most / 2)
        prof = {e: _mean(cells[e].values()) for e in steady}
        # the layers meet where the window-mean profile changes sign (top moving one way, bottom the other);
        # with no sign change, split halfway up the profiler
        split, cross = (steady[0] + steady[-1]) / 2, None
        for lo_e, hi_e in zip(steady, steady[1:]):
            a, b = prof[lo_e], prof[hi_e]
            if a * b < 0:
                cross = lo_e + (hi_e - lo_e) * abs(a) / (abs(a) + abs(b))
        if cross is not None:
            split = cross
        hours = sorted(set().union(*[cells[e].keys() for e in steady]))
        for k in hours:
            up = [cells[e][k] for e in steady if e >= split and k in cells[e]]
            lo = [cells[e][k] for e in steady if e < split and k in cells[e]]
            if up:
                bu[k] = sum(up) / len(up)
            if lo:
                bl[k] = sum(lo) / len(lo)
            if up or lo:
                bm[k] = (sum(up) + sum(lo)) / (len(up) + len(lo))
        um, lm, mm = _mean(bu.values()), _mean(bl.values()), _mean(bm.values())
        north_cells = [e for e in steady if prof[e] >= 0.05]
        south_cells = [e for e in steady if prof[e] <= -0.05]
        breach_bridge.update({
            "cells": len(cells), "cells_used": len(steady), "split_elev_ft": _r(split, 1),
            "split_is": "where the average velocity changes direction" if cross is not None else "halfway up the profiler",
            "profile": [{"elev_ft": e, "mean_fps": _r(_mean(cells[e].values()), 2), "readings": len(cells[e]), "used": e in steady}
                        for e in sorted(cells, reverse=True)],
            "upper_fps": _r(um, 2), "lower_fps": _r(lm, 2), "mean_fps": _r(mm, 2),
            "upper_direction": _direction(um, 0.05, "north", "south"), "lower_direction": _direction(lm, 0.05, "north", "south"),
            "latest_at": max(bm).strftime("%Y-%m-%dT%H:%M"), "latest_mean_fps": _r(bm[max(bm)], 2),
            "two_way": bool(north_cells and south_cells),
            "north_cells_ft": [min(north_cells), max(north_cells)] if north_cells else None,
            "south_cells_ft": [min(south_cells), max(south_cells)] if south_cells else None,
            "note": "Average of the profiler cells' velocities; USGS publishes no discharge for this breach.",
        })
    elif not hourly:
        breach_bridge["why"] = "The bridge breach only reports 15-minute velocities; pick 62 days or fewer to see them."
    else:
        breach_bridge["why"] = "No velocity readings for these dates (the profiler record starts Oct 2023)."

    # ---- bay outflows to the main lake
    def bay_flow(site):
        ser, step, src = S.get((site, "00060"), {}), step_h, "15-minute" if hourly else "daily"
        st = _stats(ser, t0, t1, step, pre=False)
        if not st and hourly:
            # older discharge (e.g. Bear River Bay 2008-2013) is online only as daily values
            ser = {dt.datetime.combine(d, dt.time()): v for d, v in con.execute(
                f"""select "day", value from {NAME}_dv where site_id = ? and param = '00060' and "day" >= ? and "day" < ?""",
                [site, t0.date(), t1.date()]).fetchall()}
            step, src = 24, "daily"
            st = _stats(ser, t0, t1, step, pre=False)
        if not st:
            return None
        fl = _flow(ser, t0, t1, step)
        return {**_round_stats(st, 1), "values": src, "to_lake_af": fl["positive_af"], "to_bay_af": fl["negative_af"], "net_af": fl["net_af"],
                "hours_reversed": fl["hours_negative"],
                "direction": _direction(st["mean"], 0.5, "into the main lake", "back into the bay")}

    def velocity(site, param="72254"):
        merged = {}
        for (s_, p, _l), s in C.items():
            if s_ == site and p == param:
                for k, v in s.items():
                    merged.setdefault(k, []).append(v)
        ser = {k: sum(v) / len(v) for k, v in merged.items()}
        return ser, _round_stats(_stats(ser, t0, t1, step_h, pre=False), 2)

    fb = "410401112134801"
    farm = {"site_id": fb, "name": SITES[fb][0], "flow": bay_flow(fb),
            "conductance_us_cm": _round_stats(_stats(S.get((fb, "00095"), {}), t0, t1, step_h, pre=False), 0),
            "water_temp_c": _round_stats(_stats(S.get((fb, "00010"), {}), t0, t1, step_h, pre=False), 1)}
    bear = []
    for site in ("10010060", "411403112200801"):
        vs, vst = velocity(site)
        b = {"site_id": site, "name": SITES[site][0], "flow": bay_flow(site), "velocity_fps": vst}
        if site == "411403112200801":
            b["surface_velocity_fps"] = velocity(site, "72322")[1]
        if not b["flow"]:
            b["why_no_flow"] = ("USGS stopped publishing discharge here in Nov 2013; it now reports water velocity only."
                                if site == "10010060" else "USGS published discharge here only in 2005-2007; it now reports water velocity only.")
        if site == "10010060":
            bear_vel = vs
        bear.append(b)

    # ---- window series for the chart (window only; daily windows over two years go weekly)
    keys = sorted({k for s in (north, south, lk, S.get((fb, "00060"), {}), bm, bear_vel) for k in s if t0 <= k < t1})
    weekly = not hourly and window["days"] > DAILY_SERIES_MAX
    if weekly:
        def wk(k):
            return k - dt.timedelta(days=k.weekday())
        groups = {}
        for k in keys:
            groups.setdefault(wk(k), []).append(k)
        tkeys = sorted(groups)

        def col(s, n):
            return [_r(_mean([s.get(k) for k in groups[g]]), n) for g in tkeys]
    else:
        tkeys = keys

        def col(s, n):
            return [_r(s.get(k), n) for k in tkeys]
    fmt = "%Y-%m-%dT%H:00" if hourly else "%Y-%m-%d"
    series = {"t": [k.strftime(fmt) for k in tkeys], "step": "week" if weekly else "hour" if hourly else "day",
              "north_ft": col(north, 2), "south_ft": col(south, 2), "head_ft": col(head, 2),
              "lakeside_cfs": col(lk, 1), "farmington_cfs": col(S.get((fb, "00060"), {}), 1),
              "farmington_us_cm": col(S.get((fb, "00095"), {}), 0),
              "bridge_upper_fps": col(bu, 2), "bridge_lower_fps": col(bl, 2), "bridge_mean_fps": col(bm, 2),
              "bear_causeway_fps": col(bear_vel, 2)}

    used = sorted({north_id, south_id, "10010020", "10010025", fb, "10010060", "411403112200801"} | ({other} if other and "north_saline" in levels else set()))
    return {
        "resolution": res, "levels": levels, "breach_lakeside": breach_lakeside, "breach_bridge": breach_bridge,
        "farmington": farm, "bear": bear, "series": series, "notes": notes,
        "salinity_note": "USGS publishes continuous specific conductance only at the Farmington Bay outflow; the arms' salinity is sampled by hand.",
        "sites": [{"site_id": s, "name": SITES[s][0], "usgs_name": FULL_NAMES[s], "url": f"https://waterdata.usgs.gov/monitoring-location/{s}/"} for s in used],
        "iv_pulled_at": _meta(con, "iv_pulled_at"), "dv_pulled_at": _meta(con, "dv_pulled_at"),
        "units": {"level": "ft NGVD 1929", "flow": "cfs", "volume": "acre-ft", "velocity": "ft/s", "conductance": "µS/cm at 25 °C"},
    }


# ---------------------------------------------------------------- history

def history(con):
    init(con)
    cur = con.execute(f"""
        with d as (select site_id, date_trunc('week', "day") wk, avg(value) v from {NAME}_dv
                   where param = '62614' and site_id in ('10010000', '10010100', '10010024', '10010027') group by all),
             p as (pivot d on site_id in ('10010000', '10010100', '10010024', '10010027') using any_value(v) group by wk)
        select strftime(wk, '%Y-%m-%d') wk, "10010000" saltair, "10010100" saline, "10010024" south_cw, "10010027" north_cw
        from p order by wk""")
    rows = cur.fetchall()
    if not rows:
        return {"error": "No whole-lake gauge data pulled yet."}
    # the north arm record starts in 1966; earlier Saltair weeks add nothing to a north-vs-south chart
    first = next((i for i, r in enumerate(rows) if r[2] is not None or r[4] is not None), 0)
    rows = rows[first:]
    # before 1990 the arms were read about twice a month, so weeks skip; break the line only at real gaps (> 6 weeks)
    gapped = []
    for i, r in enumerate(rows):
        if i and (dt.date.fromisoformat(r[0]) - dt.date.fromisoformat(rows[i - 1][0])).days > 42:
            gapped.append(((dt.date.fromisoformat(rows[i - 1][0]) + dt.timedelta(days=7)).isoformat(), None, None, None, None))
        gapped.append(r)
    rows = gapped
    out = {"wk": [], "south_ft": [], "north_ft": [], "head_ft": [], "south_cw_ft": [], "north_cw_ft": [], "head_cw_ft": []}
    for wk, salt, sal, scw, ncw in rows:
        out["wk"].append(wk)
        out["south_ft"].append(_r(salt, 2))
        out["north_ft"].append(_r(sal, 2))
        out["head_ft"].append(_r(salt - sal, 2) if salt is not None and sal is not None else None)
        out["south_cw_ft"].append(_r(scw, 2))
        out["north_cw_ft"].append(_r(ncw, 2))
        out["head_cw_ft"].append(_r(scw - ncw, 2) if scw is not None and ncw is not None else None)
    heads = [(w, h) for w, h in zip(out["wk"], out["head_ft"]) if h is not None]
    mx = max(heads, key=lambda x: x[1]) if heads else None
    mn = min(heads, key=lambda x: x[1]) if heads else None
    last = heads[-1] if heads else None
    return {"weekly": out,
            "summary": {"start": out["wk"][0], "end": out["wk"][-1],
                        "max_head": {"wk": mx[0], "ft": mx[1]} if mx else None,
                        "min_head": {"wk": mn[0], "ft": mn[1]} if mn else None,
                        "latest_head": {"wk": last[0], "ft": last[1]} if last else None},
            "pairs": {"long": {"south": "10010000", "north": "10010100", "label": "Saltair (south) minus Saline (north)"},
                      "causeway": {"south": "10010024", "north": "10010027", "label": "South side minus north side of the causeway"}},
            "sites": [{"site_id": s, "name": SITES[s][0], "url": f"https://waterdata.usgs.gov/monitoring-location/{s}/"}
                      for s in ("10010000", "10010100", "10010024", "10010027")],
            "dv_pulled_at": _meta(con, "dv_pulled_at")}
