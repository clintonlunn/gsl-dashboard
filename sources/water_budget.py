"""Utah Division of Water Resources (DWRe) Utah Water Budget model: annual results by subarea, water years 1989-.

Public, keyless ArcGIS Online feature services from DWRe's open data hub
(https://dwre-utahdnr.opendata.arcgis.com/pages/water-budget), org ZzrwjTRez6FJiOq4:

* WB_Summary<yymmdd>/FeatureServer/0: one row per basin, subarea, state, variable and water year (Oct-Sep), in ac-ft.
  Each model run is published under a new dated name, so we look for the newest one and fall back to the
  2025 release (WB_Summary251119, water years 1989-2024).
* QXFlowLines/FeatureServer/0: the model's flow schematic. Each line has period-of-record ("PoR") and
  "current water year" ("CWY") monthly and annual ac-ft. It is not a time series. We keep the lines that
  flow into the Great Salt Lake subarea (00-06-01), plus the Weber gauge line in East Shore (02-01-09).

The model has no evaporation term for the lake itself, and it has no lake groundwater inflow (those lines are 0).

States: depletions are split by state (Utah, Idaho, Wyoming). There are no 'All' rows for them; 'All' only
appears for Yield, which is per subarea. So the sector totals below are Utah rows, as the state publishes them.
The Idaho and Wyoming depletions upstream in the Bear (and a little of the Weber) also reduce what reaches the
lake. They are sent separately because the README says they are less accurate and not approved by those states.
"""
import datetime as dt
import json
import os
import tempfile
import urllib.parse

NAME = "water_budget"

ORG = "ZzrwjTRez6FJiOq4"
SERVICES = f"https://services.arcgis.com/{ORG}/arcgis/rest/services"
FALLBACK = "WB_Summary251119"
FLOWS = f"{SERVICES}/QXFlowLines/FeatureServer/0"
HUB = "https://dwre-utahdnr.opendata.arcgis.com/pages/water-budget"
SEARCH = "https://www.arcgis.com/sharing/rest/search"
REFRESH_SEC = 7 * 24 * 3600
RETRY_SEC = 24 * 3600
PAGE = 1000  # the services' maxRecordCount

GSL_SUBAREA = "00-06-01"
BASINS = {"01": "Bear River", "02": "Weber River", "03": "Jordan River", "04": "Utah Lake"}  # subarea prefix
SECTORS = {  # label -> model variable
    "Agriculture": "Agriculture Depletions",
    "M&I": "M&I Depletions",
    "Mineral": "Mineral Depletions",
    "Sub-irrigated": "Sub-Irrigated Surface Depletions",
    "Incidental": "Incidental Depletions",
}

# Flow lines in the Great Salt Lake subarea. role: 'to_lake' = water reaching the lake (count these once),
# 'part' = an upstream piece of a to_lake line, 'loss' = riparian use along the way.
# gauges = the dashboard's USGS gauges that measure it (server.RIVERS).
LINES = {
    "Bear River Flow to the Great Salt Lake": ("to_lake", ["10126000"], "Bear River near Corinne"),
    "Jordan River Flows to Great Salt Lake": ("to_lake", ["10170500", "10172600"],
                                              "Model uses Jordan at 1700 South (10171000) plus the Surplus Canal; "
                                              "the dashboard uses Cudahy Lane (10172600) plus the Surplus Canal"),
    "Flows to Great Salt Lake from Davis and Weber Counties": ("to_lake", ["10141000"],
                                                               "Weber River outflow; the Plain City gauge sees most of it, "
                                                               "not return flows that join below the gauge"),
    "Willard Bay Spills": ("to_lake", [], "Willard Bay Reservoir releases straight to the bay"),
    "East Shore M & I Return Flow": ("to_lake", [], "Treated municipal and industrial water returned along the east shore"),
    "Tooele Valley Outflow": ("to_lake", [], None),
    "Skull Valley Outflow": ("to_lake", [], None),
    "Park Valley Outflow": ("to_lake", [], None),
    "Curlew Valley Outflow": ("to_lake", [], None),
    "Hansel Valley Outflow": ("to_lake", [], None),
    "Promontory Point Outflow": ("to_lake", [], None),
    "Groundwater Inflow from South Great Salt Lake Basin": ("to_lake", [], "Not estimated: 0 in the model"),
    "Groundwater to Stansbury Island": ("to_lake", [], "Not estimated: 0 in the model"),
    "Return Flow from Great Salt Lake Minerals": ("to_lake", [], None),
    "Return Flow from Stansbury Island": ("to_lake", [], None),
    "Bear River at Corrinne, 10126000": ("part", ["10126000"], None),
    "Bear River After Riparian Use": ("part", ["10126000"], None),
    "East Shore Outflow": ("part", ["10141000"], None),
    "Jordan River, 10171000": ("part", ["10172600"], None),
    "Surplus Canal, 10170500": ("part", ["10170500"], None),
    "Combined Jordan River Flows": ("part", ["10170500", "10172600"], None),
}
WEBER_GAUGE_LINE = ("02-01-09", "Gauged Flows of the Weber River (10141000)")


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_annual (
            subarea varchar, subarea_name varchar, basin varchar, state varchar, variable varchar,
            water_year integer, acre_ft double, primary key (subarea, state, variable, water_year));
        create table if not exists {NAME}_gsl_inflows (
            subarea varchar, qx_number integer, description varchar, flowtype varchar,
            por_annual_af double, cwy_annual_af double, primary key (subarea, qx_number));
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


def _q(url, **params):
    return f"{url}/query?" + urllib.parse.urlencode({"f": "json", "returnGeometry": "false", **params})


def _latest_service(fetch):
    """Newest public WB_Summary* feature service in the DWRe org; the fallback if the search fails."""
    try:
        r = fetch(f"{SEARCH}?" + urllib.parse.urlencode({
            "q": f'title:"WB_Summary" orgid:{ORG} type:"Feature Service"', "sortField": "modified",
            "sortOrder": "desc", "num": 20, "f": "json"}), timeout=60)
        names = [i["title"] for i in r.get("results", [])
                 if i.get("access") == "public" and i["title"].startswith("WB_Summary") and i["title"][10:].isdigit()]
        return max(names, key=lambda n: n[10:]) if names else FALLBACK  # yymmdd sorts by date
    except Exception:  # noqa: BLE001
        return FALLBACK


def _pages(fetch, url, where, fields, order):
    out, offset = [], 0
    while True:
        r = fetch(_q(url, where=where, outFields=fields, orderByFields=order,
                     resultOffset=offset, resultRecordCount=PAGE), timeout=120)
        if "error" in r:
            raise RuntimeError(r["error"].get("message", "query failed"))
        feats = [f["attributes"] for f in r.get("features", [])]
        out += feats
        if not feats or not (r.get("exceededTransferLimit") or len(feats) == PAGE):
            return out
        offset += len(feats)


def _insert(con, table, cols, rows):
    """Land rows as NDJSON and let DuckDB read them (much faster than executemany)."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        for r in rows:
            f.write(json.dumps(dict(zip(cols, r))) + "\n")
    try:
        types = ", ".join(f"{c}: '{t}'" for c, t in _TYPES[table].items())
        con.execute(f"insert or replace into {table} select * from read_json(?, columns={{{types}}})", [f.name])
    finally:
        os.unlink(f.name)


_TYPES = {
    f"{NAME}_annual": {"subarea": "VARCHAR", "subarea_name": "VARCHAR", "basin": "VARCHAR", "state": "VARCHAR",
                       "variable": "VARCHAR", "water_year": "INTEGER", "acre_ft": "DOUBLE"},
    f"{NAME}_gsl_inflows": {"subarea": "VARCHAR", "qx_number": "INTEGER", "description": "VARCHAR",
                            "flowtype": "VARCHAR", "por_annual_af": "DOUBLE", "cwy_annual_af": "DOUBLE"},
}


def refresh(con, fetch):
    """Pull at most weekly. The model runs once a year, so the whole table is replaced when it's pulled."""
    init(con)
    last = _meta(con, "pulled_at")
    tried = _meta(con, "tried_at")  # after a failed pull, wait a day rather than retrying every hour
    now = dt.datetime.now()
    if last and (now - dt.datetime.fromisoformat(last)).total_seconds() < REFRESH_SEC:
        return
    if tried and (now - dt.datetime.fromisoformat(tried)).total_seconds() < RETRY_SEC:
        return
    _meta_set(con, "tried_at", now.isoformat(timespec="seconds"))
    service = _latest_service(fetch)
    url = f"{SERVICES}/{service}/FeatureServer/0"
    want = fetch(_q(url, where="1=1", returnCountOnly="true"), timeout=60)["count"]
    raw = _pages(fetch, url, "1=1", "Basin,Subarea,SubareaName,State,Variable,Year,Value,Unit", "ObjectId")
    if len(raw) != want:
        raise RuntimeError(f"{service}: got {len(raw)} of {want} rows")
    units = {r["Unit"] for r in raw}
    if units - {"ac-ft"}:
        raise RuntimeError(f"{service}: unexpected units {units}")
    annual = [((r["Subarea"] or "").strip(), (r["SubareaName"] or "").strip(), (r["Basin"] or "").strip(),
               (r["State"] or "").strip(),  # State values are space-padded in the source
               (r["Variable"] or "").strip(), r["Year"], r["Value"]) for r in raw if r["Value"] is not None]
    lines = _pages(fetch, FLOWS,
                   f"SUBAREA = '{GSL_SUBAREA}' OR (SUBAREA = '{WEBER_GAUGE_LINE[0]}' AND QXDESCRIBE = '{WEBER_GAUGE_LINE[1]}')",
                   "SUBAREA,QXNUMBER,QXDESCRIBE,FLOWTYPE,QmANN,QANNwy", "OBJECTID_1")
    inflows = [(r["SUBAREA"], r["QXNUMBER"], (r["QXDESCRIBE"] or "").strip(), r["FLOWTYPE"], r["QmANN"], r["QANNwy"])
               for r in lines if r["QXNUMBER"] is not None]
    con.execute("begin")
    try:
        con.execute(f"delete from {NAME}_annual")
        _insert(con, f"{NAME}_annual", list(_TYPES[f"{NAME}_annual"]), annual)
        if inflows:
            con.execute(f"delete from {NAME}_gsl_inflows")
            _insert(con, f"{NAME}_gsl_inflows", list(_TYPES[f"{NAME}_gsl_inflows"]), inflows)
        _meta_set(con, "service", service)
        _meta_set(con, "pulled_at", dt.datetime.now().isoformat(timespec="seconds"))
        con.execute("commit")
    except Exception:
        con.execute("rollback")
        raise


# ---------------------------------------------------------------- reading

def _water_year(d):
    return d.year + 1 if d.month >= 10 else d.year


def _basin_sql():
    return "case " + " ".join(f"when subarea like '{p}-%' then '{n}'" for p, n in BASINS.items()) + " end"


def _depletions(con, years):
    """{year: {basin: {sector: af}}} for Utah rows, and {year: {basin: af}} for Idaho + Wyoming rows."""
    var_to_sector = {v: s for s, v in SECTORS.items()}
    rows = con.execute(f"""
        select water_year, {_basin_sql()} b, variable, state = 'Utah' ut, sum(acre_ft)
        from {NAME}_annual
        where variable in ({",".join("?" * len(SECTORS))}) and water_year in ({",".join("?" * len(years))})
          and ({" or ".join(f"subarea like '{p}-%'" for p in BASINS)})
        group by all""", list(SECTORS.values()) + list(years)).fetchall()
    ut = {y: {b: {s: 0.0 for s in SECTORS} for b in BASINS.values()} for y in years}
    other = {y: {b: 0.0 for b in BASINS.values()} for y in years}
    for y, b, var, is_ut, v in rows:
        if is_ut:
            ut[y][b][var_to_sector[var]] += v
        else:
            other[y][b] += v
    return ut, other


def _precip(con, years):
    return dict(con.execute(f"""select water_year, sum(acre_ft) from {NAME}_annual
                                where subarea = ? and variable = 'Precipitation' and water_year in ({",".join("?" * len(years))})
                                group by 1""", [GSL_SUBAREA] + list(years)).fetchall())


def _mineral_all(con, years):
    """Mineral depletions everywhere: the README says these are all Great Salt Lake mineral extraction."""
    return dict(con.execute(f"""select water_year, sum(acre_ft) from {NAME}_annual
                                where variable = 'Mineral Depletions' and water_year in ({",".join("?" * len(years))})
                                group by 1""", list(years)).fetchall())


def _af(v):
    return None if v is None else round(v)


def _inflows(con):
    rows = con.execute(f"""select subarea, qx_number, description, flowtype, por_annual_af, cwy_annual_af
                           from {NAME}_gsl_inflows order by subarea desc, qx_number""").fetchall()
    out, weber_gauge = [], None
    for sub, n, desc, ftype, por, cwy in rows:
        if (sub, desc) == WEBER_GAUGE_LINE:
            weber_gauge = por
            continue
        role, gauges, note = LINES.get(desc, ("loss" if ftype == "Incidental Loss" else "other", [], None))
        out.append({"qx": n, "description": desc, "flowtype": ftype, "role": role, "por_annual_af": _af(por),
                    "cwy_annual_af": _af(cwy), "measured": bool(gauges), "gauges": gauges, "note": note})
    to_lake = [r for r in out if r["role"] == "to_lake"]
    total = sum(r["por_annual_af"] or 0 for r in to_lake)
    missed = sum(r["por_annual_af"] or 0 for r in to_lake if not r["measured"])
    summary = {
        "to_lake_por_af": total, "measured_lines_por_af": total - missed, "missed_por_af": missed,
        "missed_share": round(missed / total, 4) if total else None,
        # the Weber line is counted as measured, but the gauge itself only sees this much of it
        "weber_gauge_por_af": _af(weber_gauge),
    }
    return out, summary


def _about(con):
    service = _meta(con, "service") or FALLBACK
    first, last = con.execute(f"select min(water_year), max(water_year) from {NAME}_annual").fetchone()
    return {
        "service": service, "service_url": f"{SERVICES}/{service}/FeatureServer/0", "flows_url": FLOWS, "hub_url": HUB,
        "license": "CC BY-SA (Utah Department of Natural Resources)", "pulled_at": _meta(con, "pulled_at"),
        "first_wy": first, "last_wy": last, "units": "acre-feet per water year (Oct 1-Sep 30)",
        "basins": list(BASINS.values()), "sectors": list(SECTORS),
        "state_note": ("Sector depletions are Utah rows. The model has no 'All' rows for depletions (only for Yield), "
                       "so Idaho and Wyoming depletions in the same basins are given separately as other_states_af."),
        "no_lake_evaporation": True,
    }


def query(con, window):
    if not con.execute(f"select count(*) from {NAME}_annual").fetchone()[0]:
        return {"error": "Water budget data not pulled yet."}
    about = _about(con)
    wanted = list(range(_water_year(window["from_day"]), _water_year(window["to_day"]) + 1))
    have = {y for (y,) in con.execute(f"select distinct water_year from {NAME}_annual").fetchall()}
    years = [y for y in wanted if y in have]
    latest_used = False
    if not years and wanted[0] > about["last_wy"]:
        years, latest_used = [about["last_wy"]], True
    out = {**about, "requested_water_years": [wanted[0], wanted[-1]], "water_years": years,
           "latest_available_used": latest_used, "years": []}
    if years:
        ut, other = _depletions(con, years)
        precip, mineral = _precip(con, years), _mineral_all(con, years)
        for y in years:
            sectors = {s: _af(sum(ut[y][b][s] for b in BASINS.values())) for s in SECTORS}
            out["years"].append({
                "water_year": y, "gsl_precip_af": _af(precip.get(y)),
                "depletions_af": {**sectors, "total": sum(sectors.values())},
                "by_basin_af": {b: _af(sum(ut[y][b].values())) for b in BASINS.values()},
                "other_states_af": {b: _af(v) for b, v in other[y].items() if v},
                "gsl_mineral_extraction_af": _af(mineral.get(y)),
            })
    out["inflows"], out["inflow_summary"] = _inflows(con)
    out["recent"] = _recent(con, about["last_wy"])
    return out


RECENT_YEARS = 5


def _recent(con, last):
    """Average depletions a year over the newest few water years, for the Farms tab's "where the water goes".

    by_basin: [basin, utah (1/0), sector, af]. Idaho and Wyoming rows are split by sector here too (the History tab
    only sends their totals). mineral_lake_af is mineral extraction everywhere, i.e. all the lake's evaporation ponds,
    including the west-side ones the model books under the West Desert basin.
    """
    years = list(range(last - RECENT_YEARS + 1, last + 1))
    var_to_sector = {v: s for s, v in SECTORS.items()}
    rows = con.execute(f"""
        select {_basin_sql()} b, (state = 'Utah')::int ut, variable, sum(acre_ft) / {len(years)}
        from {NAME}_annual
        where variable in ({",".join("?" * len(SECTORS))}) and water_year in ({",".join("?" * len(years))})
          and ({" or ".join(f"subarea like '{p}-%'" for p in BASINS)})
        group by all having sum(acre_ft) > 0 order by 1, 2 desc, 3""", list(SECTORS.values()) + years).fetchall()
    mineral = _mineral_all(con, years)
    return {
        "water_years": [years[0], years[-1]],
        "by_basin": [[b, ut, var_to_sector[v], _af(af)] for b, ut, v, af in rows],
        "mineral_lake_af": _af(sum(mineral.values()) / len(years)) if mineral else None,
    }


def history(con):
    if not con.execute(f"select count(*) from {NAME}_annual").fetchone()[0]:
        return {"error": "Water budget data not pulled yet."}
    about = _about(con)
    years = list(range(about["first_wy"], about["last_wy"] + 1))
    ut, other = _depletions(con, years)
    precip = _precip(con, years)
    return {
        **about, "water_years": years,
        "gsl_precip_af": [_af(precip.get(y)) for y in years],
        "combined_af": {s: [_af(sum(ut[y][b][s] for b in BASINS.values())) for y in years] for s in SECTORS},
        "by_basin_af": {b: {s: [_af(ut[y][b][s]) for y in years] for s in SECTORS} for b in BASINS.values()},
        "other_states_af": {b: [_af(other[y][b]) for y in years] for b in BASINS.values()
                            if any(other[y][b] for y in years)},
    }
