"""NWS Colorado Basin River Forecast Center (CBRFC): water supply and river forecasts for Great Salt Lake rivers.

CBRFC forecasts the eastern Great Basin ("Great Salt Lake" area, code SL): Bear, Weber, Provo/Utah Lake and the
Salt Lake City creeks. Three products, all public, no key:

* Official seasonal water supply forecasts (April-July runoff volume, thousand acre-feet), issued on the 1st of
  January-June (published a few days later). One CSV per issue date for the whole area, with the 90/70/50/30/10%
  exceedance volumes, 1991-2020 average and median, and percent of each:
      https://www.cbrfc.noaa.gov/wsup/graph/wsocond_data.py?fdate=YYYY-MM-01&area=SL&otype=csv
  Point names and coordinates come from the same script with otype=js (the CSV splits names on "-").
* Per-point seasonal record for one water year (official issues, daily model guidance (ESP) and the observed
  April-July volume so far), used for the season's final observed volume and for past years:
      https://www.cbrfc.noaa.gov/wsup/graph/esptxt.py?id=GATU1&year=2026&csv=1
* Short-range (about 10-day) deterministic river forecasts, hourly cfs, at the river-mouth points, with the
  historical daily flow percentiles for the same days:
      https://www.cbrfc.noaa.gov/dbdata/station/flowgraph/flowgraph_data_hc.py?id=BCNU1&ptype=1...

Exceedance: a "90%" volume is one the river should beat 9 years in 10 (low end); "10%" is the high end.
Seasonal volumes are natural (unregulated) flows except where CBRFC marks a point regulated (Bear at Stewart Dam).
"""
import datetime as dt
import re
import time
import urllib.request

NAME = "cbrfc"

BASE = "https://www.cbrfc.noaa.gov"
AREA = "SL"  # CBRFC's Great Salt Lake (eastern Great Basin) area
LIVE_SEC = 6 * 3600          # official list, flows, current-season point files: at most every 6 h
OTHER_POINT_SEC = 24 * 3600  # non-key points' observed volumes while the season is still running
HIST_FROM_WY = 2016          # CBRFC's online forecast archive starts with water year 2016
BUDGET_SEC = 60              # cap on new requests per refresh() call (it runs under the server's lock); backfill resumes next call
TIMEOUT = 45

# points the page leads with; first of each river is the headline one
KEY = ["BERU1", "LGNU1", "GATU1", "UTLU1"]
# river-mouth points with short-range flow forecasts: CBRFC id -> (label, river)
FLOW_PTS = {
    "BCNU1": ("Bear River near Corinne", "Bear River"),
    "WWPU1": ("Weber River near Plain City", "Weber River"),
    "JORU1": ("Jordan River at 500 North, Salt Lake City", "Jordan River"),
}
# CBRFC marks these seasonal points "Regulated" (checked point by point on the espgraph page, Oct 2026)
REGULATED = {"STDI1"}
LABELS = {"UTLU1": "Utah Lake inflow (Provo River and other streams)"}
CSV_COLS = ["slot", "area", "sub_area", "fgroup", "id", "river_raw", "loc_raw", "issued", "avg_cond", "med_cond",
            "period", "p90", "p70", "p50", "p30", "p10", "avg", "med", "pct_avg", "pct_med"]
MON = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}


# ---------------------------------------------------------------- tables

def init(con):
    con.execute(f"""
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);
        create table if not exists {NAME}_probe (day date primary key, n integer, checked_at timestamp);
        create table if not exists {NAME}_wso (
            issued date, id varchar, slot integer, sub_area varchar, fgroup varchar, river_raw varchar, loc_raw varchar,
            period varchar, p90 double, p70 double, p50 double, p30 double, p10 double,
            avg double, med double, pct_avg double, pct_med double, primary key (issued, id));
        create table if not exists {NAME}_points (
            id varchar primary key, name_raw varchar, lat double, lng double, fgroup varchar, sub_area varchar);
        create table if not exists {NAME}_season (
            wy integer, id varchar, kind varchar, run_date date,
            p90 double, p70 double, p50 double, p30 double, p10 double, primary key (wy, id, kind, run_date));
        create table if not exists {NAME}_obs (
            wy integer, id varchar, obs_kaf double, obs_date date, final boolean, fetched_at timestamp,
            primary key (wy, id));
        create table if not exists {NAME}_flow_pts (
            id varchar primary key, name varchar, usgs varchar, issued timestamp, lob_ts timestamp, lob_cfs double,
            action_cfs double, flood_cfs double, fetched_at timestamp);
        create table if not exists {NAME}_flow (id varchar, kind varchar, ts timestamp, cfs double,
            primary key (id, kind, ts));""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


# ---------------------------------------------------------------- fetching / parsing

def _text(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def wy_of(d):
    return d.year + 1 if d.month >= 10 else d.year


def wso_url(day, otype="csv"):
    extra = "&skey=id&db=informix" if otype == "js" else ""
    return f"{BASE}/wsup/graph/wsocond_data.py?fdate={day:%Y-%m-%d}&area={AREA}&otype={otype}{extra}"


def esptxt_url(pid, wy):
    return f"{BASE}/wsup/graph/esptxt.py?id={pid}&year={wy}&db=informix&csv=1"


def flow_url(pid):
    return (f"{BASE}/dbdata/station/flowgraph/flowgraph_data_hc.py?id={pid}&ptype=1&show_peaks=0&show_daily=0"
            "&show_stats=1&show_ens=0&show_ens_high=0&zero_flow=1&linear_flow=1&legend=0&popup=0&show_title=0")


def page_links():
    return {
        "map": f"{BASE}/lmap/lmap.php?interface=wsup",
        "list": f"{BASE}/dbdata/station/espgraph/wsolist/wsolist.html",
        "discussion": f"{BASE}/wsup/pub2/discussion/current.pdf",
        "docs": f"{BASE}/wsup/doc/doc.html",
        "river": f"{BASE}/lmap/lmap.php?interface=river",
        "point": f"{BASE}/wsup/graph/espgraph_hc.html?id={{id}}&year={{wy}}",
        "flowpoint": f"{BASE}/dbdata/station/flowgraph/flowgraph_hc.html?id={{id}}&ptype=1",
    }


def parse_wso_csv(text):
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) < 2:
        return []
    out = []
    for l in lines[1:]:
        f = l.split(",")
        if len(f) < len(CSV_COLS):
            continue
        r = dict(zip(CSV_COLS, f))
        for k in ("p90", "p70", "p50", "p30", "p10", "avg", "med", "pct_avg", "pct_med"):
            r[k] = _num(r[k])
        r["slot"] = int(_num(r["slot"]) or 0)
        out.append(r)
    return out


_TOK = re.compile(r"'((?:[^'\\]|\\.)*)'|([^,\s]+)")


def parse_js_arrays(text):
    """`var name=new Array('a',1,...);` -> {name: [str, ...]} (numbers stay strings)."""
    return {m.group(1): [a if b == "" else b for a, b in _TOK.findall(m.group(2))]
            for m in re.finditer(r"var (\w+)=new Array\((.*?)\);", text, re.S)}


def parse_esptxt(text):
    """Per-point season file -> (official rows, latest ESP row, (obs_kaf, obs_date))."""
    official, esp, obs = [], None, (None, None)
    for l in text.replace("<pre>", "").replace("</pre>", "").splitlines():
        f = l.strip().split(",")
        if not re.match(r"\d{4}-\d\d-\d\d$", f[0]):
            continue
        # header: date,max,p10,p30,p50,p70,p90,min,crx,c30,cmp,c70,crn,Obs; rows without an official issue carry
        # only four empty official fields, so Obs is the last field of a 13- or 14-field row
        day = dt.date.fromisoformat(f[0])
        v = [_num(x) for x in f[1:8]] + [None] * (7 - len(f[1:8]))  # max p10 p30 p50 p70 p90 min
        if v[3] is not None:
            esp = {"run_date": day, "p10": v[1], "p30": v[2], "p50": v[3], "p70": v[4], "p90": v[5]}
        if len(f) == 14 and _num(f[10]) is not None:
            c = [_num(x) for x in f[8:13]]  # crx c30 cmp c70 crn
            official.append({"run_date": day, "p10": c[0], "p30": c[1], "p50": c[2], "p70": c[3], "p90": c[4]})
        if len(f) in (13, 14) and _num(f[-1]) is not None:
            obs = (_num(f[-1]), day)
    return official, esp, obs


def period_end(period, wy):
    """'Apr 1-Jul 31' -> date(wy, 7, 31)."""
    m = re.search(r"-\s*([A-Z][a-z]{2})\s+(\d+)", period or "")
    if not m:
        return dt.date(wy, 7, 31)
    mo = MON[m.group(1)]
    return dt.date(wy if mo < 10 else wy - 1, mo, int(m.group(2)))


# ---------------------------------------------------------------- names

QUAL = {"Nr": "near", "At": "at", "Abv": "above", "Blo": "below"}
ABBR = [(r"\bRsvr\b|\bRes\b", "Reservoir"), (r"\bCk\b", "Creek"), (r"\bFk\b", "Fork"), (r"\bDiv\b", "Diversion"),
        (r"\bUp\b", "Upper"), (r"\bUpnl\b", "Upper"), (r"\bPwrplnt\b", "Powerplant"), (r"\bFt\b", "Fort")]


def _expand(s):
    for pat, rep in ABBR:
        s = re.sub(pat, rep, s)
    return s.strip()


def river_name(raw):
    r = _expand(re.sub(r"^Sf\b", "South Fork", raw.strip()))
    return r if re.search(r"(Creek|Fork)$", r) else f"{r} River"


def place_name(raw):
    """'Logan  Nr  State Dam  Abv' or 'Logan; Nr; State Dam; Abv' -> 'near Logan, above State Dam'."""
    parts = [p.strip() for p in re.split(r"\s{2,}|;\s*", raw.strip()) if p.strip()]
    out, i = [], 0
    while i < len(parts):
        if i + 1 < len(parts) and parts[i + 1] in QUAL:
            out.append(f"{QUAL[parts[i + 1]]} {_expand(parts[i])}")
            i += 2
        else:
            out.append(_expand(parts[i]) if parts[i] not in QUAL else QUAL[parts[i]])
            i += 1
    return ", ".join(out)


def label(pid, name_raw, river_raw, loc_raw):
    if pid in LABELS:
        return LABELS[pid]
    if name_raw and " - " in name_raw:
        r, loc = name_raw.split(" - ", 1)
    else:
        r, loc = river_raw, loc_raw
    place = place_name(loc)
    joiner = " " if re.match(r"(near|at|above|below) ", place) else " at "
    return f"{river_name(r)}{joiner}{place}"


# ---------------------------------------------------------------- refresh

def _candidates(today):
    """Official issue dates worth asking about: the 1st of Jan-Jun of this water year and the last one."""
    cwy = wy_of(today)
    return [dt.date(y, m, 1) for y in (cwy - 1, cwy) for m in range(1, 7) if dt.date(y, m, 1) <= today]


def _probe_issues(con, today, deadline):
    have = {r[0]: (r[1], r[2]) for r in con.execute(f"select day, n, checked_at from {NAME}_probe").fetchall()}
    for day in _candidates(today):
        if time.time() > deadline:
            return
        if day in have:
            n, checked = have[day]
            # found, or empty and long past (forecasts are published within days of the issue date)
            if n > 0 or (today - day).days > 20 or (dt.datetime.now() - checked).total_seconds() < LIVE_SEC:
                continue
        rows = parse_wso_csv(_text(wso_url(day)))
        if rows:
            con.execute(f"delete from {NAME}_wso where issued = ?", [day])
            con.executemany(f"insert into {NAME}_wso values ({','.join('?' * 17)})", [
                [day, r["id"], r["slot"], r["sub_area"], r["fgroup"], r["river_raw"], r["loc_raw"], r["period"],
                 r["p90"], r["p70"], r["p50"], r["p30"], r["p10"], r["avg"], r["med"], r["pct_avg"], r["pct_med"]]
                for r in rows])
            js = parse_js_arrays(_text(wso_url(day, "js")))
            ids = js.get("wsupid", [])
            con.executemany(f"insert or replace into {NAME}_points values (?, ?, ?, ?, ?, ?)", [
                [pid, js["wsupname"][i].strip(), _num(js["wsuplatdd"][i]), _num(js["wsuplngdd"][i]),
                 js["wsupfgroupid"][i], js["wsupsubbasin"][i]] for i, pid in enumerate(ids)])
        con.execute(f"insert or replace into {NAME}_probe values (?, ?, ?)", [day, len(rows), dt.datetime.now()])


def _season_jobs(con, today):
    """(id, wy) season files still to pull, most useful first."""
    latest = con.execute(f"select max(issued) from {NAME}_wso").fetchone()[0]
    obs = {(r[0], r[1]): (r[2], r[3]) for r in con.execute(f"select id, wy, final, fetched_at from {NAME}_obs").fetchall()}
    now = dt.datetime.now()
    stale = lambda k, sec: k not in obs or (not obs[k][0] and (now - obs[k][1]).total_seconds() > sec)  # noqa: E731
    jobs = []
    cwy = wy_of(today)
    if today.month in (12, 1, 2, 3, 4, 5, 6, 7, 8):  # model guidance runs from mid-December
        jobs += [(p, cwy) for p in KEY if stale((p, cwy), LIVE_SEC)]
    if latest:
        lwy = wy_of(latest)
        ids = [r[0] for r in con.execute(f"select id from {NAME}_wso where issued = ? order by slot", [latest]).fetchall()]
        ids = [p for p in KEY if p in ids] + [p for p in ids if p not in KEY]
        jobs += [(p, lwy) for p in ids if (p, lwy) not in jobs and stale((p, lwy), LIVE_SEC if p in KEY else OTHER_POINT_SEC)]
        jobs += [(p, y) for y in range(lwy - 1, HIST_FROM_WY - 1, -1) for p in KEY if stale((p, y), OTHER_POINT_SEC)]
    return jobs


def _pull_season(con, pid, wy, today):
    official, esp, (obs_kaf, obs_date) = parse_esptxt(_text(esptxt_url(pid, wy)))
    con.execute(f"delete from {NAME}_season where wy = ? and id = ?", [wy, pid])
    rows = [[wy, pid, "official", r["run_date"], r["p90"], r["p70"], r["p50"], r["p30"], r["p10"]] for r in official]
    if esp:
        rows.append([wy, pid, "esp", esp["run_date"], esp["p90"], esp["p70"], esp["p50"], esp["p30"], esp["p10"]])
    if rows:
        con.executemany(f"insert into {NAME}_season values (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    per = con.execute(f"select period from {NAME}_wso where id = ? order by issued desc limit 1", [pid]).fetchone()
    end = period_end(per[0] if per else None, wy)
    final = (obs_date is not None and obs_date >= end) or today > end + dt.timedelta(days=45)
    con.execute(f"insert or replace into {NAME}_obs values (?, ?, ?, ?, ?, ?)",
                [wy, pid, obs_kaf, obs_date, final, dt.datetime.now()])


def _pull_flow(con, pid, fetch):
    d = fetch(flow_url(pid), timeout=TIMEOUT)
    h = d.get("hcdata") or {}
    ts = lambda s: dt.datetime.fromisoformat(s.replace(" ", "T"))  # noqa: E731  CBRFC times are UTC
    rows = []
    for kind, key, j in (("fc", "forecast_flow", 1), ("obs", "observed_flow", 1),
                         ("p75", "stat_75_50f", 1), ("p50", "stat_75_50f", 2), ("p25", "stat_50_25f", 2)):
        for p in h.get(key) or []:
            if isinstance(p, list) and len(p) > j and p[j] is not None:
                rows.append([pid, kind, ts(p[0]), float(p[j])])
    crit = d.get("critical") or {}
    usgs = re.search(r"monitoring-location/(\d+)", d.get("usgslink") or "")
    con.execute(f"delete from {NAME}_flow where id = ?", [pid])
    if rows:
        con.executemany(f"insert or replace into {NAME}_flow values (?, ?, ?, ?)", rows)
    con.execute(f"insert or replace into {NAME}_flow_pts values (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        pid, FLOW_PTS[pid][0], usgs.group(1) if usgs else None,
        ts(d["fcdate"]) if d.get("fcdate") else None, ts(d["lobdate"]) if d.get("lobdate") else None,
        _num(d.get("lob")), _num(crit.get("actionf")), _num(crit.get("floodf")), dt.datetime.now()])


def refresh(con, fetch):
    """Official list and flows at most every 6 h; season files for past years are backfilled a few per call."""
    init(con)
    t0 = time.time()
    deadline = t0 + BUDGET_SEC
    today = dt.date.today()
    errors = []
    last = _meta(con, "live_at")
    if not last or (dt.datetime.now() - dt.datetime.fromisoformat(last)).total_seconds() >= LIVE_SEC:
        try:
            _probe_issues(con, today, deadline)
        except Exception as e:  # noqa: BLE001
            errors.append(f"water supply list: {e}")
        for pid in FLOW_PTS:
            if time.time() > deadline:
                break
            try:
                _pull_flow(con, pid, fetch)
            except Exception as e:  # noqa: BLE001
                errors.append(f"flow {pid}: {e}")
        if time.time() <= deadline:  # ran out of time: finish the live pull on the next call
            _meta_set(con, "live_at", dt.datetime.now().isoformat(timespec="seconds"))
    for pid, wy in _season_jobs(con, today):
        if time.time() > deadline:
            break
        try:
            _pull_season(con, pid, wy, today)
        except Exception as e:  # noqa: BLE001  one slow point never stops the rest; retried a day later
            errors.append(f"season {pid} {wy}: {e}")
            con.execute(f"insert or ignore into {NAME}_obs values (?, ?, null, null, false, ?)", [wy, pid, dt.datetime.now()])
            con.execute(f"update {NAME}_obs set fetched_at = ? where wy = ? and id = ? and not final", [dt.datetime.now(), wy, pid])
    if errors:
        print(f"source {NAME}: " + "; ".join(errors), flush=True)


# ---------------------------------------------------------------- query

def _iso(v):
    return v.isoformat() if v is not None else None


def _r(v, n=1):
    return None if v is None else round(v, n)


def query(con, window):
    init(con)
    today = dt.date.today()
    cwy = wy_of(today)
    links = page_links()
    latest = con.execute(f"select max(issued) from {NAME}_wso").fetchone()[0]
    out = {"as_of": _meta(con, "live_at"), "water_year": cwy, "links": links, "area": AREA,
           "key_ids": KEY, "units": "KAF", "points": [], "issues": [], "flows": []}
    if latest:
        lwy = wy_of(latest)
        out["latest_issue"] = latest.isoformat()
        out["latest_wy"] = lwy
        out["issues"] = [r[0].isoformat() for r in con.execute(
            f"select distinct issued from {NAME}_wso where issued >= ? order by 1", [dt.date(lwy - 1, 10, 1)]).fetchall()]
        rows = con.execute(f"""
            select w.*, p.name_raw, p.lat, p.lng, o.obs_kaf, o.obs_date, o.final
            from {NAME}_wso w left join {NAME}_points p using (id)
            left join {NAME}_obs o on o.id = w.id and o.wy = ?
            where w.issued = ? order by w.slot""", [lwy, latest]).fetchall()
        cols = [c[0] for c in con.description]
        # how each key point's official forecast moved through the season
        trend = {}
        for pid, day, p90, p50, p10 in con.execute(f"""
                select id, issued, p90, p50, p10 from {NAME}_wso where issued >= ? and id in ({','.join('?' * len(KEY))})
                order by issued""", [dt.date(lwy - 1, 10, 1), *KEY]).fetchall():
            trend.setdefault(pid, []).append({"issued": day.isoformat(), "p50": p50, "p90": p90, "p10": p10})
        for r in rows:
            r = dict(zip(cols, r))
            avg = r["avg"]
            if r["id"] in REGULATED:  # season file's Obs for regulated Stewart Dam (0.0) disagrees with CBRFC's page; skip it
                r["obs_kaf"] = None
            out["points"].append({
                "id": r["id"], "name": label(r["id"], r["name_raw"], r["river_raw"], r["loc_raw"]),
                "river": river_name(r["river_raw"]), "group": r["fgroup"], "key": r["id"] in KEY,
                "product": "Official seasonal water supply forecast", "regulated": r["id"] in REGULATED,
                "period": r["period"], "issued": r["issued"].isoformat(), "wy": lwy,
                "most_probable": r["p50"], "likely_low": r["p90"], "likely_high": r["p10"],
                "p70": r["p70"], "p30": r["p30"], "avg": avg, "median": r["med"],
                "pct_avg": r["pct_avg"], "pct_median": r["pct_med"],
                "observed": r["obs_kaf"], "observed_through": _iso(r["obs_date"]), "observed_final": bool(r["final"]),
                "observed_pct_avg": _r(100 * r["obs_kaf"] / avg, 0) if r["obs_kaf"] is not None and avg else None,
                "lat": r["lat"], "lng": r["lng"], "trend": trend.get(r["id"]),
                "url": links["point"].format(id=r["id"], wy=lwy),
            })
    # model guidance (daily ESP, unofficial) for the current water year, if it has started
    avgs = {p["id"]: p["avg"] for p in out["points"]}
    out["guidance"] = [{"id": pid, "run_date": d.isoformat(), "most_probable": p50, "likely_low": p90, "likely_high": p10,
                        "pct_avg": _r(100 * p50 / avgs[pid], 0) if avgs.get(pid) and p50 is not None else None,
                        "url": links["point"].format(id=pid, wy=cwy)}
                       for pid, d, p90, p50, p10 in con.execute(f"""
                           select id, run_date, p90, p50, p10 from {NAME}_season where wy = ? and kind = 'esp'
                           order by run_date desc""", [cwy]).fetchall()]
    out["status"] = ("official" if latest and wy_of(latest) == cwy else "guidance" if out["guidance"] else "off-season")
    # short-range river forecasts at the mouths, every 3rd hour to keep the payload small
    for pid, name, usgs, issued, lob_ts, lob_cfs, action, flood, fetched in con.execute(
            f"select * from {NAME}_flow_pts order by id").fetchall():
        river = FLOW_PTS.get(pid, (name, None))[1]
        ser = {k: [] for k in ("fc", "obs", "p25", "p50", "p75")}
        for kind, ts, cfs in con.execute(f"select kind, ts, cfs from {NAME}_flow where id = ? order by ts", [pid]).fetchall():
            ser[kind].append((ts, cfs))
        fc = ser["fc"]
        peak = max(fc, key=lambda p: p[1]) if fc else None
        norm = lambda day: next((c for t, c in ser["p50"] if t.date() == day), None)  # noqa: E731
        end_day = fc[-1][0].date() if fc else None
        out["flows"].append({
            "id": pid, "name": name, "river": river, "usgs": usgs, "issued": _iso(issued) and _iso(issued) + "Z",
            "latest": {"ts": _iso(lob_ts) + "Z", "cfs": lob_cfs} if lob_ts else None,
            "peak": {"ts": _iso(peak[0]) + "Z", "cfs": round(peak[1])} if peak else None,
            "end": {"ts": _iso(fc[-1][0]) + "Z", "cfs": round(fc[-1][1])} if fc else None,
            "normal_today": norm(today), "normal_end": norm(end_day) if end_day else None,
            "action_cfs": action, "flood_cfs": flood, "fetched_at": _iso(fetched),
            "url": links["flowpoint"].format(id=pid),
            "forecast": [[_iso(t) + "Z", round(c)] for t, c in fc if t.hour % 3 == 0],
            "observed": [[_iso(t) + "Z", round(c)] for t, c in ser["obs"] if t.hour % 3 == 0],
            # historical daily flow on these dates: [day, low (75% of years beat it), median, high (25% beat it)]
            "normal": [[t.date().isoformat(), lo, mid, hi] for (t, lo), (_, mid), (_, hi)
                       in zip(ser["p75"], ser["p50"], ser["p25"])],
        })
    return out


def history(con):
    """Each key point's April 1 official forecast (and likely range) against what actually ran off, by year."""
    init(con)
    links = page_links()
    names = {r[0]: label(r[0], r[1], "", "") for r in con.execute(f"select id, name_raw from {NAME}_points").fetchall()}
    avgs = dict(con.execute(f"""select id, avg from {NAME}_wso where (id, issued) in
                               (select id, max(issued) from {NAME}_wso group by id)""").fetchall())
    pts = []
    for pid in KEY:
        years = []
        for wy, p90, p50, p10, obs, final in con.execute(f"""
                select o.wy, s.p90, s.p50, s.p10, o.obs_kaf, o.final from {NAME}_obs o
                left join {NAME}_season s on s.wy = o.wy and s.id = o.id and s.kind = 'official'
                     and s.run_date = make_date(o.wy, 4, 1)
                where o.id = ? order by o.wy""", [pid]).fetchall():
            years.append({"wy": wy, "apr1_most_probable": p50, "apr1_likely_low": p90, "apr1_likely_high": p10,
                          "observed": obs, "observed_final": bool(final)})
        if years:
            pts.append({"id": pid, "name": names.get(pid, pid), "avg": avgs.get(pid), "years": years,
                        "url": links["point"].format(id=pid, wy=years[-1]["wy"])})
    return {"points": pts, "links": links, "units": "KAF"}
