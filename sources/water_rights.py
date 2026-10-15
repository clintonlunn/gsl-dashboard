"""Water rights in the lake's river basins: how much water the state has allowed people to divert, for what, and since when.

Utah Division of Water Rights publishes every point of diversion (POD) as a public, keyless ArcGIS Online layer,
rebuilt nightly (Utah_Points_of_Diversion; fields documented at waterrights.utah.gov/gisinfo/wrpod.htm). A right's
flow (CFS) and volume (ACFT) are repeated on every one of its PODs, so summing POD rows overstates totals 10-70x.
This pulls one row per right instead: the server groups PODs by right number and returns max(CFS), max(ACFT),
the earliest priority date and the POD count; a right listed under more than one use/status keeps the row with
the largest amount.

Rights are filed by water-right area, the prefix of the right number (e.g. 35-831 is area 35). Areas here:
    Bear River 21, 23, 25, 29 · Weber River 31, 35 · Jordan River 57, 59 · Utah Lake 51, 53, 54, 55
Only approved (A) and perfected (P) rights count; terminated and unapproved ones are left out.

Owners come from the same layer (OWNER, one row per POD and owner) and are public record. A right with several
owners counts in full under each, so owner totals overlap. Map points are kept only for the big rights
(BIG_ACFT acre-feet or BIG_CFS cfs and up), which hold most of the volume.

Rights are a paper ceiling, not use: many are supplemental (a well backing up a canal share), many list several
uses, and rights in use before 1903 (surface) or 1935 (groundwater) appear only if a claim was filed.
"""
import datetime as dt
import json
import re
import urllib.parse

NAME = "water_rights"
LAYER = "https://services.arcgis.com/ZzrwjTRez6FJiOq4/arcgis/rest/services/Utah_Points_of_Diversion/FeatureServer/0"
ITEM = "https://www.arcgis.com/home/item.html?id=7bf556ebe3bc4362ab07d8945332c940"
DOCS = "https://waterrights.utah.gov/gisinfo/wrpod.htm"
AREAS = {
    "21": "Bear River", "23": "Bear River", "25": "Bear River", "29": "Bear River",
    "31": "Weber River", "35": "Weber River",
    "57": "Jordan River", "59": "Jordan River",
    "51": "Utah Lake", "53": "Utah Lake", "54": "Utah Lake", "55": "Utah Lake",
}
USES = {"I": "Irrigation", "S": "Stock", "D": "Domestic", "M": "Municipal", "O": "Other", "P": "Power", "X": "Mining"}
PAGE = 2000  # the layer caps results at 2000 rows a page
BIG_ACFT, BIG_CFS = 1000, 10
TOP_OWNERS = 100  # per basin and overall
# name spellings vary across filings; these fold the common abbreviations so one holder adds up as one
ABBREV = {"CO": "COMPANY", "CORP": "CORPORATION", "DIST": "DISTRICT", "ASSN": "ASSOCIATION", "ASSOC": "ASSOCIATION",
          "IRR": "IRRIGATION", "INCORPORATED": "INC", "L L C": "LLC", "L L P": "LLP", "L C": "LC", "DEPT": "DEPARTMENT", "RES": "RESERVOIR"}
ORG = re.compile(r"\b(COMPANY|COMPANIES|ASSOCIATES|INC|LLC|LC|LP|LLP|LTD|CORPORATION|DISTRICT|CITY|TOWN|COUNTY|STATE|USA|UNITED STATES|BUREAU|"
                 r"DEPARTMENT|DIVISION|IRRIGATION|CANAL|DITCH|RESERVOIR|WATER|WATERWORKS|ASSOCIATION|CHURCH|UNIVERSITY|SCHOOL|"
                 r"BOARD|AUTHORITY|SERVICE|PARTNERSHIP|RANCH|RANCHES|FARMS|FARM|DAIRY|CATTLE|LIVESTOCK|LAND|ESTATES|"
                 r"SUBDIVISION|HOMEOWNERS|POWER|ENERGY|MINING|MINES|COPPER|PACIFICORP|KENNECOTT|SOCIETY|CLUB|PROPERTIES|"
                 r"INVESTMENTS|HOLDINGS|ENTERPRISES|DEVELOPMENT|PARTNERS|BANK|RAILROAD|INDUSTRIES|CONSERVANCY|IMPROVEMENT|"
                 r"METROPOLITAN|MUNICIPAL|FEDERAL|COMMISSION|SPECIAL SERVICE|SEWER)\b")
REFRESH_SEC = 7 * 24 * 3600
RETRY_SEC = 24 * 3600


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_rights (wrnum varchar primary key, area varchar, basin varchar, uses varchar,
            status varchar, kind varchar, cfs double, acft double, priority varchar, pods integer);
        create table if not exists {NAME}_owners (wrnum varchar, owner varchar, org boolean);
        create table if not exists {NAME}_points (wrnum varchar, lon double, lat double);
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


def _where():
    return "(" + " OR ".join(f"WRNUM LIKE '{a}-%'" for a in AREAS) + ") AND SUMMARY_ST IN ('A','P')"


def _paged(fetch, params, what):
    offset = 0
    while True:
        r = fetch(f"{LAYER}/query?" + urllib.parse.urlencode({**params, "resultOffset": offset, "resultRecordCount": PAGE, "f": "json"}), timeout=120)
        if "error" in r:
            raise RuntimeError(f"{what}: {r['error'].get('message') or r['error'].get('details')}")
        feats = r.get("features", [])
        yield from feats
        if len(feats) < PAGE and not r.get("exceededTransferLimit"):
            return
        offset += len(feats)


# (pattern, replacement) applied in order after the abbreviations; folds the big holders' many spellings
FOLD = [
    (r" (DBA|--) .*$| A UTAH (LIMITED LIABILITY|NON ?PROFIT|) ?(COMPANY|CORPORATION).*$| A BODY CORPORATE.*$", ""),
    (r"^(UNITED STATES OF AMERICA|UNITED STATES|U S A) ", "USA "), (r"^(UNITED STATES OF AMERICA|U S A)$", "USA"),
    (r"^STATE OF UTAH ", "UTAH "), (r"^(UTAH )?DEPARTMENT OF NATURAL RESOURCES ", "UTAH "),
    (r"^(DEPARTMENT OF NATURAL RESOURCES )?DIVISION OF WILDLIFE", "UTAH DIVISION OF WILDLIFE"),
    (r"^BOARD OF WATER RESOURCES$", "UTAH BOARD OF WATER RESOURCES"),
    (r"^USA (DEPARTMENT OF (THE )?INTERIOR )?BUREAU OF RECLAMATION.*$", "USA BUREAU OF RECLAMATION"),
    (r"^USA FISH (AND )?WILDLIFE SERVICES?$", "USA FISH AND WILDLIFE SERVICE"),
    (r"^(DEPARTMENT OF PUBLIC UTILITIES )?SALT LAKE CITY( MUNICIPAL)?( CORPORATION)?( -)?( DEPT?A?RTMENT OF PUBLIC UTILITIES)?$", "SALT LAKE CITY CORPORATION"),
    (r"^WEBER BASIN CONSERVANCY", "WEBER BASIN WATER CONSERVANCY"),
]


def owner_name(raw):
    s = re.sub(r"\s+(C/O|ATTN|%).*$", "", (raw or "").upper())
    s = re.sub(r"[.,;:'\"]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^THE ", "", s)
    s = " " + s + " "
    for k, v in ABBREV.items():
        s = s.replace(f" {k} ", f" {v} ")
    s = re.sub(r"\s+", " ", s).strip()
    if ORG.search(s):  # "&" and "and" mix in company names; people keep theirs as filed
        s = s.replace(" & ", " AND ")
    for pat, rep in FOLD:
        s = re.sub(pat, rep, s).strip()
    return s or "UNKNOWN"


def _owners(fetch):
    out = set()
    for f in _paged(fetch, {"where": _where(), "groupByFieldsForStatistics": "WRNUM,OWNER", "orderByFields": "WRNUM,OWNER",
                            "outStatistics": json.dumps([{"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "n"}])}, "owners"):
        a = f["attributes"]
        if a.get("WRNUM"):
            name = owner_name(a.get("OWNER"))
            out.add((a["WRNUM"], name, bool(ORG.search(name))))
    return out


def _points(fetch):
    out = set()
    for f in _paged(fetch, {"where": f"{_where()} AND (ACFT >= {BIG_ACFT} OR CFS >= {BIG_CFS})", "outFields": "WRNUM",
                            "returnGeometry": "true", "outSR": 4326, "orderByFields": "OBJECTID"}, "points"):
        g = f.get("geometry") or {}
        if f["attributes"].get("WRNUM") and g.get("x") is not None:
            out.add((f["attributes"]["WRNUM"], round(g["x"], 4), round(g["y"], 4)))
    return out


def _pages(fetch):
    areas = " OR ".join(f"WRNUM LIKE '{a}-%'" for a in AREAS)
    stats = json.dumps([
        {"statisticType": "max", "onStatisticField": "CFS", "outStatisticFieldName": "cfs"},
        {"statisticType": "max", "onStatisticField": "ACFT", "outStatisticFieldName": "acft"},
        {"statisticType": "min", "onStatisticField": "PRIORITY", "outStatisticFieldName": "prio"},
        {"statisticType": "count", "onStatisticField": "OBJECTID", "outStatisticFieldName": "npod"}])
    offset = 0
    while True:
        r = fetch(f"{LAYER}/query?" + urllib.parse.urlencode({
            "where": f"({areas}) AND SUMMARY_ST IN ('A','P')",
            "groupByFieldsForStatistics": "WRNUM,USES,SUMMARY_ST,TYPE", "outStatistics": stats,
            "orderByFields": "WRNUM", "resultOffset": offset, "resultRecordCount": PAGE, "f": "json"}), timeout=120)
        if "error" in r:
            raise RuntimeError(f"PODs: {r['error'].get('message') or r['error'].get('details')}")
        feats = r.get("features", [])
        yield [f["attributes"] for f in feats]
        if len(feats) < PAGE:
            return
        offset += len(feats)


def refresh(con, fetch):
    init(con)
    now = dt.datetime.now()
    last, tried = _meta(con, "pulled_at"), _meta(con, "tried_at")
    if last and (now - dt.datetime.fromisoformat(last)).total_seconds() < REFRESH_SEC:
        return
    if tried and (now - dt.datetime.fromisoformat(tried)).total_seconds() < RETRY_SEC:
        return
    _meta_set(con, "tried_at", now.isoformat(timespec="seconds"))
    best, kinds, prios = {}, {}, {}
    for page in _pages(fetch):
        for a in page:
            wr = a.get("WRNUM") or ""
            area = wr.split("-")[0]
            if area not in AREAS:
                continue
            cfs, acft = a.get("cfs") or 0, a.get("acft") or 0
            # each POD type (surface, underground...) is its own group; keep the type with the most PODs
            k = kinds.setdefault(wr, {})
            k[a.get("TYPE") or "Unknown"] = k.get(a.get("TYPE") or "Unknown", 0) + (a.get("npod") or 0)
            if a.get("prio") and (wr not in prios or a["prio"] < prios[wr]):
                prios[wr] = a["prio"]  # earliest priority across a right's groups
            old = best.get(wr)
            if old is None or cfs + acft > old[6] + old[7]:
                best[wr] = (wr, area, AREAS[area], a.get("USES") or "", a.get("SUMMARY_ST"), None, cfs, acft)
    if len(best) < 1000:
        raise RuntimeError(f"{NAME}: only {len(best)} rights came back")
    owners, points = _owners(fetch), _points(fetch)
    rows = [r[:5] + (max(kinds[r[0]], key=kinds[r[0]].get),) + r[6:8] + (prios.get(r[0]), sum(kinds[r[0]].values()))
            for r in best.values()]
    con.execute("begin")
    try:
        con.execute(f"delete from {NAME}_rights")
        con.executemany(f"insert into {NAME}_rights values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
        con.execute(f"delete from {NAME}_owners")
        con.executemany(f"insert into {NAME}_owners values (?, ?, ?)", sorted(owners))
        con.execute(f"delete from {NAME}_points")
        con.executemany(f"insert into {NAME}_points values (?, ?, ?)", sorted(points))
        _meta_set(con, "pulled_at", dt.datetime.now().isoformat(timespec="seconds"))
        con.execute("commit")
    except Exception:
        con.execute("rollback")
        raise


def query(con, window):
    init(con)
    n = con.execute(f"select count(*) from {NAME}_rights").fetchone()[0]
    if not n:
        return {"error": "No water rights pulled yet."}
    T = f"{NAME}_rights"
    by_basin = con.execute(f"""
        select basin, count(*), round(sum(cfs)), round(sum(acft)) from {T} group by 1 order by 1""").fetchall()
    # a right with several uses counts under each, so these rows overlap
    by_use = con.execute(f"""
        select basin, u, count(*), round(sum(cfs)), round(sum(acft))
        from (select *, unnest(regexp_split_to_array(uses, '')) as u from {T} where uses <> '') group by 1, 2 order by 1, 2""").fetchall()
    by_decade = con.execute(f"""
        select basin, case when priority is null or length(priority) < 4 then null else substr(priority, 1, 3) || '0' end as dec,
            count(*), round(sum(cfs)), round(sum(acft))
        from {T} group by 1, 2 order by 1, 2""").fetchall()
    by_kind = con.execute(f"""
        select basin, case when kind = 'Underground' then 'Underground' when kind in ('Surface', 'Point to Point', 'Rediversion', 'Drain')
            then 'Surface' when kind = 'Spring' then 'Spring' else 'Other' end, count(*), round(sum(cfs)), round(sum(acft))
        from {T} group by 1, 2 order by 1, 2""").fetchall()
    biggest = con.execute(f"""
        select wrnum, basin, uses, kind, cfs, acft, priority from {T} order by acft desc limit 10""").fetchall()
    # holders: full amount of every right they're on (alone or jointly), per basin; top holders of each basin and overall
    O = f"{NAME}_owners"
    holders = con.execute(f"""
        with per as (
            select o.owner, o.org, r.basin, r.wrnum, r.cfs, r.acft, (select count(*) from {O} x where x.wrnum = r.wrnum) as n
            from {O} o join {T} r using (wrnum)),
        hb as (select owner, any_value(org) org, basin, count(*) rights, round(sum(cfs)) cfs, round(sum(acft)) acft,
                   count(*) filter (where n > 1) shared from per group by owner, basin),
        top as (select owner from (select owner, row_number() over (partition by basin order by acft desc) k from hb) where k <= {TOP_OWNERS}
                union select owner from (select owner from hb group by owner order by sum(acft) desc limit {TOP_OWNERS}))
        select owner, org::int, basin, rights, cfs, acft, shared from hb where owner in (select owner from top) order by acft desc""").fetchall()
    # big rights for the map: [wrnum, basin, uses, cfs, acft, priority year, owners] and their points [lon, lat, right index]
    big = con.execute(f"""
        select r.wrnum, r.basin, r.uses, r.cfs, r.acft, substr(r.priority, 1, 4),
            (select string_agg(owner, ' | ' order by owner) from {O} o where o.wrnum = r.wrnum)
        from {T} r where r.wrnum in (select wrnum from {NAME}_points) order by r.acft desc""").fetchall()
    idx = {r[0]: i for i, r in enumerate(big)}
    points = [[lon, lat, idx[w]] for w, lon, lat in con.execute(f"select wrnum, lon, lat from {NAME}_points").fetchall() if w in idx]
    return {
        "rights": n, "areas": AREAS, "uses": USES,
        "holders": [list(r) for r in holders], "big": [list(r) for r in big], "points": points,
        "big_floor": {"acft": BIG_ACFT, "cfs": BIG_CFS},
        "by_basin": [list(r) for r in by_basin], "by_use": [list(r) for r in by_use],
        "by_decade": [list(r) for r in by_decade], "by_kind": [list(r) for r in by_kind],
        "biggest": [list(r) for r in biggest],
        "pulled_at": _meta(con, "pulled_at"),
        "about": {"layer_url": LAYER, "item_url": ITEM, "docs_url": DOCS, "lookup_url": "https://waterrights.utah.gov/wrinfo/query.asp",
                  "credit": "Utah Division of Water Rights"},
    }
