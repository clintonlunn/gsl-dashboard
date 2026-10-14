"""Water diverted from the Bear, Weber and Jordan rivers (and Utah Lake) before it reaches the Great Salt Lake.

Data: Utah Division of Water Rights river-commissioner distribution records (provisional, mean daily cfs).
  Daily CSV:  https://www.waterrights.utah.gov/dvrtdb/DailyCommaData.asp?BYEAR=2025&EYEAR=2026&StationId=1863
              (6 header lines, then "Date,Flow" rows as MM/DD/YYYY,cfs; -9999 = missing; no rows = nothing recorded)
  Locations:  https://services.arcgis.com/ZzrwjTRez6FJiOq4/ArcGIS/rest/services/Measurement_Stations/FeatureServer/0
  Station page: https://waterrights.utah.gov/dvrtDB/app/#/station/{id}/
No auth. robots.txt disallows /cgi-bin (the old dvrtview.exe), so we only use /dvrtdb and the FeatureServer.

The station list below is curated by hand from the Division's distribution systems (survey done Oct 2026):
  kind "diversion"  water leaves the river for use (irrigation, municipal, industrial, storage off-river). Counted.
  kind "wetland"    deliveries to duck clubs / refuges at the lake edge. Much of it evaporates, but it is managed
                    lake-margin habitat and part of it drains to the lake, so it is shown separately and NOT counted.
  kind "bypass"     channels that carry river water on to the lake (Surplus Canal, Goggin Drain). NOT counted.
  kind "reference"  river gauges, for context. NOT counted.
Deduped: a canal's total is used instead of its branches, and turnouts fed from a canal already listed are left out.
"auto" stations are telemetered (scraped or direct datalogger) and usually run 1-3 days behind; "manual" stations are
entered by the commissioner, often weeks or months later, so recent periods undercount until they're filled in.
"""
import datetime as dt
import json
import time
import urllib.request

NAME = "diversions"

CSV = "https://www.waterrights.utah.gov/dvrtdb/DailyCommaData.asp?BYEAR={by}&EYEAR={ey}&StationId={sid}"
LAYER = "https://services.arcgis.com/ZzrwjTRez6FJiOq4/ArcGIS/rest/services/Measurement_Stations/FeatureServer/0"
PAGE = "https://waterrights.utah.gov/dvrtDB/app/#/station/{}/"
FIRST_YEAR = 2010          # backfill floor: a station's first pull takes FIRST_YEAR..now in one request
REFRESH_SEC = 6 * 3600     # then current + previous year, at most every 6 hours
SLEEP = 0.3                # between requests
AF_PER_CFS_DAY = 1.9835
TOP_N = 5
COUNTED = "diversion"

A, M = "auto", "manual"
# (STATION_ID, river, kind, method, short name, why)
STATIONS = [
    # ---- Bear River (LOWER BEAR RIVER system). Bear River Canal Co. takes most of it at Cutler Dam.
    (1863, "Bear", "diversion", A, "West Side Canal (Cutler Dam)", "Bear River Canal Co. west side; largest diversion on the lower Bear"),
    (1862, "Bear", "diversion", A, "Hammond (East Side) Canal (Cutler Dam)", "Bear River Canal Co. east side"),
    (2631, "Bear", "diversion", A, "Blacksmith Fork headgates (Young Ward)", "headgates out of the river"),
    (4221, "Bear", "diversion", M, "Ira Mickelson (BE01)", "pump below Cutler, Corinne"),
    (3922, "Bear", "diversion", A, "Holmgren / Fred Anderson (BE07)", "portable pump, Bear River City"),
    (2571, "Bear", "diversion", M, "Lynn Richards (BE11)", "PTO pump below Cutler"),
    # Cache Valley river pumps above Cutler (each small; ~8,000 acre-ft a year together)
    *[(sid, "Bear", "diversion", A, nm, "Cache Valley river pump") for sid, nm in [
        (1701, "Benson-Bear Lake Irr. Co. (11)"), (1748, "Rich Pump (47)"), (1706, "King Irrigation Co. (12)"),
        (1749, "Bob Munk (50)"), (1690, "Munk Jorgensen Pump Co. (02)"), (1699, "Ballard Pump (10)"),
        (1707, "Spackman-Gibbons (13B)"), (1737, "Bullen Farms (37)"), (1732, "USU (32)"), (1744, "Bullen Farms (43)"),
        (1716, "Smithfield West Bench (18)"), (1698, "John Allen (09)"), (9417, "Todd Ballard (55B)"), (1733, "USU (31)"),
        (1723, "Charles Wood (24)"), (9308, "Spackman-Buttars (13A)"), (1736, "Valjay Rigby (35)"), (1754, "USU (54)"),
        (1768, "Skidmore (T09)"), (1714, "Mike Falslev (16)"), (1693, "Bob Munk (05)"), (1772, "Spackman Brothers (T10)"),
        (1696, "Munk Tarbet Fisher (07)"), (1695, "Thain Dairy (06A)"), (1755, "Todd Ballard (55A)"),
        (1721, "Larry Falslev (22)"), (1711, "Larry Pitcher (14A)"), (1715, "Steven Bodily (17B)"),
        (1734, "Larry Falslev (33)"), (1745, "David Dorius (44CR)"), (1720, "Marchant Pump (21)"),
        (1724, "Willard / Jay Pitcher (25)"), (1704, "Jim Watterson (11C)"), (1774, "Chris Allen (T12)"),
        (1685, "Lee Reese (T04)"), (1719, "Estancia LLC (20)"), (1691, "Paul Cardon (03)"), (1689, "Pitcher Pump (01)"),
        (1697, "Reese-Ballard (08)"), (1692, "West Cache Irr. Co. Pump (04)"), (1700, "Lanny Ballard (10A)"),
        (181, "Paul Cardon (23)"), (1770, "Brayden & Pam Spackman Farm (T09A)"), (1775, "Reed Snyder (T13)")]],
    (1763, "Bear", "diversion", M, "Weeks (44A)", "Cache Valley river pump, manual"),
    # 9305 (08A Reese-Ballard) is in the layer but its station record returns 404: left out.
    (10970, "Bear", "wetland", A, "Bird Refuge L-Line", "Bear River Migratory Bird Refuge"),
    (9821, "Bear", "wetland", M, "Bear River Club (Kendall)", "duck club"),
    (11335, "Bear", "wetland", A, "Chesapeake Duck Club (BE25)", "duck club pump"),
    (10181, "Bear", "reference", A, "Bear River at the state line", "inflow from Idaho"),
    (1901, "Bear", "reference", A, "Bear River below Cutler (Collinston)", "after the Cutler canals"),
    (5259, "Bear", "reference", A, "Bear River near Corinne", "near the mouth (3924 Bird Refuge repeats it)"),

    # ---- Weber River. Gateway Canal is counted at its river diversion (Stoddard, 580), not the tunnel
    # branches (9956 Davis Aqueduct, 9957 Weber Aqueduct), which are the same water split downstream.
    (580, "Weber", "diversion", A, "Gateway Canal (Stoddard Diversion)", "Weber Basin WCD; largest Weber diversion"),
    (518, "Weber", "diversion", A, "Davis & Weber Counties Canal (headworks)", "telemetered, but no data since Feb 2026"),
    (434, "Weber", "diversion", A, "Hooper Canal", ""),
    (9958, "Weber", "diversion", A, "Willard Canal from river (Slaterville)", "fills Willard Bay; Plain City Upper Club (429) and Harold Crane refuge (9657) are turnouts off it"),
    (423, "Weber", "diversion", M, "Wilson Canal", ""),
    (425, "Weber", "diversion", M, "Old Wilson Canal", ""),
    (437, "Weber", "diversion", M, "Warren Irrigation Co.", ""),
    (432, "Weber", "diversion", M, "South Slaterville Canal", ""),
    (2566, "Weber", "diversion", M, "Weber Basin for Layton Canal", "Wilson Lane pump station"),
    (430, "Weber", "diversion", M, "G.S.L. Minerals & Willard Canal", ""),
    (427, "Weber", "diversion", M, "Plain City Canal", "Weber River total since 2013; 10062 also mixes in Ogden River water"),
    (419, "Weber", "diversion", M, "Riverdale Bench Canal", ""),
    (415, "Weber", "diversion", M, "Uintah Central Ditch", ""),
    (417, "Weber", "diversion", M, "Pioneer Ditch", ""),
    (413, "Weber", "diversion", M, "South Weber Canal", ""),
    # upper Weber (Summit and Morgan counties)
    (10547, "Weber", "diversion", A, "North Summit pipeline 24\" (Wanship Dam)", ""),
    (10546, "Weber", "diversion", A, "North Summit pipeline 18\" (Wanship Dam)", ""),
    (268, "Weber", "diversion", A, "East Wanship Ditch", ""),
    (270, "Weber", "diversion", A, "West Wanship Ditch", ""),
    (368, "Weber", "diversion", A, "East Porterville Canal", ""),
    (10574, "Weber", "diversion", A, "West Grade Canal", "Park City area tributary"),
    (10533, "Weber", "diversion", A, "Glenwild Creek diversion", "pump, Park City area tributary"),
    (9909, "Weber", "diversion", A, "Quarry Mountain Ranch HOA", "estimated daily irrigation use"),
    *[(sid, "Weber", "diversion", M, nm, "") for sid, nm in [
        (318, "Henefer Irrigation Co."), (376, "West Richville Canal"), (355, "South Morgan Canal"),
        (399, "Enterprise Field Ditch"), (349, "North Morgan Canal"), (372, "West Porterville Ditch"),
        (351, "Weber Canal in Morgan County"), (402, "Peterson Irr. Co. Anderson-Bowman"), (380, "Littleton-Milton Ditch"),
        (386, "Line Creek Irrigation Co."), (374, "East Richville Canal"), (357, "North Morgan Mill Race Ditch"),
        (370, "Musser Ditch"), (378, "Welch Field Ditch"), (384, "Mecham-Nelson-Madsen Ditch"),
        (332, "Deseret Land and Livestock"), (328, "Stephens Ranch"), (359, "Heiner, Low & Johnson Ditch"),
        (345, "North Round Valley Ditch"), (334, "Little Deseret Ranch"), (336, "Lloyd Toone Ditch"),
        (338, "Thackery-Crouch Ditch"), (324, "Shill and Davis Ditch"), (272, "Albert Gibbons Ditch"),
        (361, "Smith and Pentz Ditch"), (347, "South Round Valley Ditch"), (382, "Mecham-Ekstrom Ditch"),
        (400, "Peterson Irr. Co. (Sanbar SL)"), (330, "Eddington Ditch"), (326, "Anderton Brothers Ditch"),
        (322, "Taylor Ditch"), (343, "Ideal Cement Co."), (342, "Joe Toone Ditch"), (2556, "John Heiner Pump")]],
    # Left out: Mt. Aire splitter branches (2553, 9749, 10016; overlapping), Ogden Bay refuge runs
    # (9826-9828, 9986, 9987; the river's own delivery to Ogden Bay, mostly zero), and the Ogden River system.
    (3482, "Weber", "reference", A, "Weber River near Plain City", "last gauge before the lake (USGS 10141000)"),
    (2404, "Weber", "reference", A, "Weber River at Gateway", "below the Gateway Canal"),

    # ---- Jordan River and Utah Lake. Canals at Jordan Narrows / Turner Dam are counted at their totals.
    (9256, "Jordan", "diversion", A, "Utah & Salt Lake Canal (total)", "10415 (at 9200 W) and 9427 (Daybreak pump) are on this canal: left out"),
    (9274, "Jordan", "diversion", A, "East Jordan Canal (total)", ""),
    (9283, "Jordan", "diversion", A, "North Jordan Canal (total)", ""),
    (6, "Jordan", "diversion", A, "South Jordan Canal (total)", ""),
    (9275, "Jordan", "diversion", A, "Jordan & Salt Lake Canal (SLC)", ""),
    (2726, "Jordan", "diversion", A, "Jordan Valley WCD at the Narrows", "the layer calls it a stream site; treated as JVWCD's diversion (unverified)"),
    (10066, "Jordan", "diversion", A, "Utah Lake Distributing Canal, north branch", "pumped from the Jordan at the Narrows"),
    (10067, "Jordan", "diversion", A, "Utah Lake Distributing Canal, south branch", "pumped from the Jordan at the Narrows"),
    (10203, "Jordan", "diversion", A, "Saratoga Springs pump station", "pumped from Utah Lake"),
    (10087, "Jordan", "diversion", M, "Riverton City 126th South pump", ""),
    (3297, "Jordan", "wetland", A, "State Canal", "duck clubs north of Salt Lake City; New State (11551) appears to carry the same water and is left out"),
    (3251, "Jordan", "wetland", M, "Ambassador Cut", "several water rights and duck clubs"),
    (3913, "Jordan", "bypass", A, "Surplus Canal", "USGS 10170500; Jordan flood bypass that runs to the lake"),
    (5138, "Jordan", "bypass", A, "Goggin Drain", "USGS 10172630; drains to the lake"),
    (8996, "Jordan", "reference", A, "Jordan River at Narrows (Station No. 1)", "flow passing Turner Dam"),
    (11331, "Jordan", "reference", A, "Jordan River at Cudahy Lane", "near the mouth"),
]
RIVERS = ["Bear", "Weber", "Jordan"]
CLEAN = f"""(select d.* from {NAME}_daily d join {NAME}_stations s using (station_id)
             where s.cap_cfs is null or d.cfs <= s.cap_cfs)"""  # daily rows minus glitches


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_daily (station_id integer, day date, cfs double, primary key (station_id, day));
        create table if not exists {NAME}_stations (
            station_id integer primary key, name varchar, river varchar, kind varchar, method varchar, note varchar,
            system_name varchar, site_type varchar, units varchar, lon double, lat double, url varchar,
            cap_cfs double);  -- readings above cap_cfs are treated as glitches
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


def _get_text(url):
    req = urllib.request.Request(url, headers={"User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return r.read().decode("utf-8", "replace")


def parse_csv(text):
    """DailyCommaData.asp body -> (units, [(date, cfs)]). Missing (-9999) and other negative values are dropped."""
    units, rows, body = None, [], False
    for line in text.splitlines():
        p = [x.strip() for x in line.split(",")]
        if not body:
            if p[0] == "Units":
                units = ",".join(p[1:]) or None
            body = p[0] == "Date"
            continue
        if len(p) != 2 or not p[1]:
            continue
        try:
            m, d, y = (int(x) for x in p[0].split("/"))
            v = float(p[1])
        except ValueError:
            continue
        if v >= 0:
            rows.append((dt.date(y, m, d), v))
    return units, rows


def _layer(fetch):
    """Name, system, type, units, location and page URL for our stations from the FeatureServer."""
    ids = ",".join(str(s[0]) for s in STATIONS)
    q = (f"{LAYER}/query?where=STATION_ID+in+({ids})&outFields=STATION_ID,STATION_NAME,SYSTEM_NAME,site_type,"
         f"UNITS_DESC_BASE,URL,longitude,latitude&returnGeometry=false&f=json")
    return {f["attributes"]["STATION_ID"]: f["attributes"] for f in fetch(q, timeout=60).get("features", [])}


def _sync_stations(con, fetch):
    try:
        lay = _layer(fetch)
    except Exception as e:  # noqa: BLE001  the curated list is enough to run on
        print(f"source {NAME}: station layer failed: {e}", flush=True)
        lay = {}
    con.execute(f"delete from {NAME}_stations")
    for sid, river, kind, method, name, note in STATIONS:
        a = lay.get(sid, {})
        con.execute(f"insert into {NAME}_stations values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)",
                    [sid, name, river, kind, method, note or None, (a.get("SYSTEM_NAME") or "").strip() or None,
                     a.get("site_type") or None, a.get("UNITS_DESC_BASE"), a.get("longitude"), a.get("latitude"), PAGE.format(sid)])
    # drop rows for stations no longer on the list
    con.execute(f"delete from {NAME}_daily where station_id not in (select station_id from {NAME}_stations)")


def refresh(con, fetch):
    """Every 6 hours, re-pull each station's current and previous year (records get revised and manual ones filled in late).
    A station's first pull goes back to FIRST_YEAR in the same single request."""
    init(con)
    last = _meta(con, "pulled_at")
    if last and (dt.datetime.now() - dt.datetime.fromisoformat(last)).total_seconds() < REFRESH_SEC:
        return
    _sync_stations(con, fetch)
    full = set(json.loads(_meta(con, "full_ids") or "[]"))
    today = dt.date.today()
    year = today.year
    errors = {}
    for i, (sid, *_rest) in enumerate(STATIONS):
        if i:
            time.sleep(SLEEP)
        by = year - 1 if sid in full else FIRST_YEAR
        try:
            units, rows = parse_csv(_get_text(CSV.format(by=by, ey=year, sid=sid)))
            rows = [r for r in rows if r[0] <= today]  # some pumps are pre-filled with zeros to month end
            if units and "CFS" not in units.upper():
                raise ValueError(f"unexpected units {units!r}")
            con.execute("begin")
            con.execute(f"delete from {NAME}_daily where station_id = ? and day >= ?", [sid, dt.date(by, 1, 1)])
            if rows:
                con.execute(f"insert into {NAME}_daily select ?, unnest(?::date[]), unnest(?::double[])",
                            [sid, [r[0] for r in rows], [r[1] for r in rows]])
            con.execute("commit")
            full.add(sid)
        except Exception as e:  # noqa: BLE001  one station failing keeps the rest (and its old rows)
            try:
                con.execute("rollback")
            except Exception:  # noqa: BLE001
                pass
            errors[sid] = str(e)[:200]
    # glitch filter: a day above 10x the station's 99th-percentile flow (with 100+ flowing days on record) is ignored,
    # e.g. 1,500 cfs one week on a 24-inch pipeline that normally carries 20 (10547, Sep 2026)
    con.execute(f"""update {NAME}_stations s set cap_cfs = greatest(10 * p.p99, 10) from (
                       select station_id, quantile_cont(cfs, 0.99) p99 from {NAME}_daily where cfs > 0
                       group by 1 having count(*) >= 100) p where p.station_id = s.station_id""")
    _meta_set(con, "full_ids", json.dumps(sorted(full)))
    _meta_set(con, "errors", json.dumps(errors))
    if len(errors) < len(STATIONS) / 2:
        _meta_set(con, "pulled_at", dt.datetime.now().isoformat(timespec="seconds"))
    if errors:
        print(f"source {NAME}: {len(errors)} stations failed: {dict(list(errors.items())[:5])}", flush=True)


def _af(cfs_days):
    return None if cfs_days is None else round(cfs_days * AF_PER_CFS_DAY)


def _day(d):
    return d.isoformat() if d else None


def query(con, window):
    from_day, to_day = window["from_day"], window["to_day"]
    if not con.execute(f"select count(*) from {NAME}_daily").fetchone()[0]:
        return {"error": "No diversion records pulled yet."}
    # last_day = last day with flow: some pumps are pre-filled with zeros up to today, so "has a row" isn't "reported"
    rows = con.execute(f"""
        select s.station_id, s.name, s.river, s.kind, s.method, s.url,
               sum(d.cfs) cfs_days, count(d.cfs) n_days, max(d.day) filter (where d.cfs > 0) last_day
        from {NAME}_stations s left join {CLEAN} d on d.station_id = s.station_id and d.day between ? and ?
        where s.kind <> 'reference' group by all""", [from_day, to_day]).fetchall()
    rivers = {r: {"river": r, "af": 0, "reporting": 0, "expected": 0, "manual_missing": 0, "last_day": None,
                  "wetland_af": 0, "bypass_af": 0} for r in RIVERS}
    top = []
    for sid, name, river, kind, method, url, cfs_days, n, last in rows:
        rv = rivers[river]
        if kind == COUNTED:
            rv["expected"] += 1
            if n:
                rv["reporting"] += 1
                rv["af"] += cfs_days * AF_PER_CFS_DAY
                rv["last_day"] = max(filter(None, [rv["last_day"], last]), default=None)
                if cfs_days > 0:
                    top.append({"id": sid, "name": name, "river": river, "method": method, "af": cfs_days * AF_PER_CFS_DAY,
                                "last_day": _day(last), "url": url})
            elif method == M:
                rv["manual_missing"] += 1
        elif n:
            rv[f"{kind}_af"] += cfs_days * AF_PER_CFS_DAY
    out_rivers = []
    for r in RIVERS:
        rv = rivers[r]
        out_rivers.append({**rv, "af": round(rv["af"]), "wetland_af": round(rv["wetland_af"]),
                           "bypass_af": round(rv["bypass_af"]), "last_day": _day(rv["last_day"])})
    total = {k: sum(r[k] for r in out_rivers) for k in ("af", "reporting", "expected", "manual_missing", "wetland_af", "bypass_af")}
    total["last_day"] = max((r["last_day"] for r in out_rivers if r["last_day"]), default=None)
    top.sort(key=lambda t: -t["af"])
    for t in top:
        t["af"] = round(t["af"])
    # what the river gauges carried in the window (context)
    ref = con.execute(f"""
        select s.station_id, s.name, s.river, sum(d.cfs) cfs_days, max(d.day) from {NAME}_stations s
        join {CLEAN} d on d.station_id = s.station_id and d.day between ? and ?
        where s.kind = 'reference' group by all order by s.river, s.station_id""", [from_day, to_day]).fetchall()
    through = con.execute(f"""select max(day) from {NAME}_daily join {NAME}_stations using (station_id)
                              where kind = '{COUNTED}' and cfs > 0""").fetchone()[0]
    return {"rivers": out_rivers, "total": total, "top": top[:TOP_N],
            "reference": [{"id": i, "name": n, "river": r, "af": _af(c), "last_day": _day(l)} for i, n, r, c, l in ref],
            "data_through": _day(through), "pulled_at": _meta(con, "pulled_at"), "provisional": True,
            "units": "acre-ft (mean daily cfs x 1.9835)"}


def history(con):
    """Diverted acre-ft per river by water year (Oct-Sep, named for the year it ends)."""
    rows = con.execute(f"""
        select year(d.day + interval 3 month) wy, s.river, sum(d.cfs) cfs_days, count(distinct d.station_id) stations
        from {CLEAN} d join {NAME}_stations s using (station_id)
        where s.kind = '{COUNTED}' group by all order by 1, 2""").fetchall()
    if not rows:
        return {"error": "No diversion records pulled yet."}
    first = con.execute(f"select min(day) from {NAME}_daily").fetchone()[0]
    today = dt.date.today()
    years = {}
    for wy, river, cfs_days, n in rows:
        y = years.setdefault(wy, {"water_year": wy, "total": 0, "stations": 0,
                                  "partial": dt.date(wy - 1, 10, 1) < first or dt.date(wy, 9, 30) >= today})
        y[river] = round(cfs_days * AF_PER_CFS_DAY)
        y["total"] += y[river]
        y["stations"] += n
    expected = sum(1 for s in STATIONS if s[2] == COUNTED)
    return {"annual": list(years.values()), "rivers": RIVERS, "expected": expected, "first_day": _day(first),
            "pulled_at": _meta(con, "pulled_at"), "provisional": True}
