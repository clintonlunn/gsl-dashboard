"""Farms and water: puts rain on the lake next to farm water use in the lake's river basins.

The page combines these figures with the window's rain on the lake (DATA.rain_lake), which only the core
server computes. This source sends the yardsticks:

* Alfalfa water use per acre per season: Utah Agricultural Experiment Station Research Report 213
  (Hill, Barker and Lewis 2011, "Crop and Wetland Consumptive Use and Open Water Surface Evaporation for Utah",
  Appendix I, NWS stations, 1971-2008 averages). It updates Hill (1994), "Consumptive Use of Irrigated Crops in
  Utah" (UAES Research Report 145). Values are typed in below from the PDF; they are long-term averages.
* Irrigated alfalfa acres: Utah Division of Water Resources (DWRe) Water-Related Land Use, a public, keyless
  ArcGIS Online feature service in org ZzrwjTRez6FJiOq4 (WaterRelatedLandUse_<year>). Pulled weekly as sums by
  basin, state and irrigation method; a snapshot taken 2026-10-14 (2025 survey) is used until the first pull.
* Household use: DWRe "Residential Water Use" (2010 report on a 2009 study) for indoor + outdoor use per person
  and people per household; Utah Division of Water Rights' 0.45 ac-ft/yr indoor-only planning figure.
* Farm groundwater pumping, surface diversions and depletions: read from the water_budget source's table
  (Utah Water Budget model, Utah rows; Idaho and Wyoming kept separate as that source does).

USDA NASS Quick Stats needs an API key (a keyless request returns 401), and so does OpenET (403
"Not authenticated"), so neither is used.
"""
import datetime as dt
import json
import urllib.parse

NAME = "ag"

ORG = "ZzrwjTRez6FJiOq4"
SERVICES = f"https://services.arcgis.com/{ORG}/arcgis/rest/services"
SEARCH = "https://www.arcgis.com/sharing/rest/search"
WRLU_FALLBACK = ("WaterRelatedLandUse_2025", 27, "24256414cf6c47b19f7b8df88f76858c")  # service, layer, item id
WRLU_HUB = "https://dwre-utahdnr.opendata.arcgis.com/pages/water-related-land-use"
ITEM_PAGE = "https://www.arcgis.com/home/item.html?id="
REFRESH_SEC = 7 * 24 * 3600
RETRY_SEC = 24 * 3600

WB = "water_budget_annual"  # the water_budget source's table
BASINS = {"01": "Bear River", "02": "Weber River", "03": "Jordan River", "04": "Utah Lake"}  # subarea prefix
AG_VARS = {"pumping": "Agriculture GW Pumping", "diversions": "Agriculture Surface Diversions",
           "depletions": "Agriculture Depletions"}

# ------------------------------------------------------------------ reference figures (typed in, cited)

ALFALFA_REPORT = {
    "title": "Crop and Wetland Consumptive Use and Open Water Surface Evaporation for Utah, Appendix I: "
             "Updated Consumptive Use Estimates at NWS Stations",
    "authors": "Robert W. Hill, J. Burdette Barker and Clayton S. Lewis",
    "publisher": "Utah Agricultural Experiment Station, Utah State University (Research Report 213), "
                 "for Utah DNR Divisions of Water Resources and Water Rights",
    "year": 2011,
    "url": "https://extension.usu.edu/irrigation/files/Appendix_I_ET_NWS_Stations.pdf",
    "index_url": "https://extension.usu.edu/irrigation/crop-water-use.php",
    "earlier": {"title": "Consumptive Use of Irrigated Crops in Utah (Research Report 145)", "author": "Robert W. Hill",
                "year": 1994, "url": "https://extension.usu.edu/irrigation/files/Consumptive_Use_in_Utah_Hill_1994.pdf"},
    "crop": "Alfalfa (Beef): the longer interval between cuttings; 'Alfalfa (Dairy)' is cut more often and uses a little less",
    "period": "1971-2008 average",
    "measure": "ET = seasonal crop water use (evapotranspiration). Net irrigation = ET minus 80% of the rain in "
               "the growing months, i.e. what irrigation has to supply.",
}
# NWS station, basin, elevation ft, alfalfa (beef) seasonal ET inches, net irrigation inches, PDF page (approx.)
ALFALFA_STATIONS = [
    ("Corinne", "Bear River", 4230, 32.08, 25.37, 64),
    ("Brigham City", "Bear River", 4230, 33.71, 26.90, 36),
    ("Tremonton", "Bear River", 4310, 33.79, 27.38, 282),
    ("Cutler Dam", "Bear River", 4290, 31.76, 24.40, 68),
    ("Logan 5 SW Exp. Farm", "Bear River", 4490, 29.36, 22.74, 168),
    ("Logan Radio KVNU", "Bear River", 4470, 31.81, 25.09, 170),
    ("Trenton", "Bear River", 4455, 32.44, 25.78, 284),
    ("Richmond", "Bear River", 4680, 32.46, 25.20, 244),
    ("Laketown", "Bear River", 5980, 25.02, 20.78, 160),
    ("Randolph", "Bear River", 6270, 19.77, 15.63, 240),
    ("Woodruff", "Bear River", 6315, 19.33, 16.13, 302),
    ("Ogden Sugar Factory", "Weber River", 4280, 35.49, 27.87, 214),
    ("Riverdale", "Weber River", 4400, 32.55, 25.08, 246),
    ("Huntsville Monastery", "Weber River", 5140, 31.02, 24.49, 138),
    ("Morgan", "Weber River", 5090, 28.27, 21.70, 192),
    ("Coalville", "Weber River", 5550, 21.10, 16.34, 60),
    ("Salt Lake City Intl. Airport", "Jordan River", 4225, 36.21, 28.97, 254),
    ("Draper Point of the Mountain", "Jordan River", 4500, 35.90, 30.04, 80),
    ("Utah Lake Lehi", "Utah Lake", 4497, 31.56, 26.43, 288),
    ("Provo BYU", "Utah Lake", 4570, 31.23, 24.55, 238),
    ("Spanish Fork Power House", "Utah Lake", 4720, 31.41, 23.72, 266),
    ("Elberta", "Utah Lake", 4690, 31.70, 27.58, 88),
    ("Heber", "Utah Lake", 5630, 23.63, 19.42, 130),
]

HOUSEHOLD = {
    "indoor_gpcd": 62, "outdoor_gpcd": 134, "persons": 2.93,
    "source": "Utah Division of Water Resources, Residential Water Use (Nov. 3, 2010; 2009 study of 17 communities)",
    "url": "https://water.utah.gov/wp-content/uploads/2019/08/2009-Residential-Water-Use.pdf",
    "note": "Surveyed homes averaged 62 gallons per person per day indoors and about 134 outdoors, with 2.93 people per home.",
    "indoor_only_af": 0.45,
    "indoor_only_source": "Utah Division of Water Rights, History of Diversion and Depletion Quantities (rev. Feb. 7, 2014): "
                          "full-time residence 0.45 ac-ft/yr (400 gal/day), indoor domestic use",
    "indoor_only_url": "https://waterrights.utah.gov/wrinfo/policy/divdep/divdephistory.asp",
}
GAL_PER_AF = 325851

# WRLU 2025 irrigated alfalfa acres (not 'Dry Crop', not 'Sub-irrigated'), pulled 2026-10-14; used until the first refresh
SNAPSHOT_ALFALFA = {("Bear River", "Utah"): 83295, ("Bear River", "Idaho"): 93700, ("Bear River", "Wyoming"): 6818,
                    ("Weber River", "Utah"): 14013, ("Jordan River", "Utah"): 622, ("Utah Lake", "Utah"): 25876}
SNAPSHOT_SURVEY = "2025"


def _median(xs):
    s = sorted(xs)
    n = len(s)
    return (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2) if n else None


def _household_af():
    return (HOUSEHOLD["indoor_gpcd"] + HOUSEHOLD["outdoor_gpcd"]) * HOUSEHOLD["persons"] * 365 / GAL_PER_AF


# ------------------------------------------------------------------ tables

def init(con):
    con.execute(f"""
        create table if not exists {NAME}_wrlu (
            basin varchar, state varchar, irr_method varchar, crop varchar, acres double,
            primary key (basin, state, irr_method, crop));
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


def _has(con, table):
    return bool(con.execute("select count(*) from information_schema.tables where table_name = ?", [table]).fetchone()[0])


def _latest_wrlu(fetch):
    """Newest public WaterRelatedLandUse_<year> feature service: (name, layer id, item id); the 2025 one if the search fails."""
    try:
        r = fetch(f"{SEARCH}?" + urllib.parse.urlencode({
            "q": f'title:"WaterRelatedLandUse_" orgid:{ORG} type:"Feature Service"', "num": 50, "f": "json"}), timeout=60)
        items = sorted((i for i in r.get("results", []) if i.get("access") == "public"
                        and i["title"].startswith("WaterRelatedLandUse_") and i["title"][20:].isdigit()
                        and len(i["title"][20:]) == 4), key=lambda i: (i["title"][20:], i.get("modified", 0)))
        for item in reversed(items):
            layers = fetch(f"{SERVICES}/{item['title']}/FeatureServer?f=json", timeout=60).get("layers") or []
            if layers:
                return item["title"], layers[0]["id"], item["id"]
    except Exception:  # noqa: BLE001
        pass
    return WRLU_FALLBACK


def refresh(con, fetch):
    """Weekly: irrigated acres by crop group in the four basins, summed on the server (a few dozen rows)."""
    init(con)
    now = dt.datetime.now()
    last, tried = _meta(con, "pulled_at"), _meta(con, "tried_at")
    if last and (now - dt.datetime.fromisoformat(last)).total_seconds() < REFRESH_SEC:
        return
    if tried and (now - dt.datetime.fromisoformat(tried)).total_seconds() < RETRY_SEC:
        return
    _meta_set(con, "tried_at", now.isoformat(timespec="seconds"))
    service, layer, item = _latest_wrlu(fetch)
    url = f"{SERVICES}/{service}/FeatureServer/{layer}/query"
    basins = ",".join(f"'{b}'" for b in BASINS.values())
    stats = json.dumps([{"statisticType": "sum", "onStatisticField": "Acres", "outStatisticFieldName": "ac"}])
    rows = []
    for crop, where in (("Alfalfa", "Description = 'Alfalfa'"), ("All farmland", "Landuse = 'Agricultural'")):
        r = fetch(f"{url}?" + urllib.parse.urlencode({
            "where": f"Basin IN ({basins}) AND {where}", "groupByFieldsForStatistics": "Basin,State,IRR_Method",
            "outStatistics": stats, "f": "json"}), timeout=120)
        if "error" in r:
            raise RuntimeError(f"{service}: {r['error'].get('message') or r['error'].get('details')}")
        for f in r.get("features", []):
            a = f["attributes"]
            if a.get("ac"):
                rows.append((a.get("Basin"), a.get("State") or "Unknown", a.get("IRR_Method") or "None", crop, a["ac"]))
    if not any(r[3] == "Alfalfa" for r in rows):
        raise RuntimeError(f"{service}: no alfalfa rows")
    survey = fetch(f"{url}?" + urllib.parse.urlencode({
        "where": f"Basin IN ({basins})", "groupByFieldsForStatistics": "SURV_YEAR", "outStatistics": stats, "f": "json"}),
        timeout=120)
    years = sorted({str(f["attributes"].get("SURV_YEAR")) for f in survey.get("features", []) if f["attributes"].get("SURV_YEAR")})
    con.execute("begin")
    try:
        con.execute(f"delete from {NAME}_wrlu")
        con.executemany(f"insert or replace into {NAME}_wrlu values (?, ?, ?, ?, ?)", rows)
        _meta_set(con, "wrlu_service", service)
        _meta_set(con, "wrlu_layer", str(layer))
        _meta_set(con, "wrlu_item", item)
        _meta_set(con, "wrlu_survey_years", ",".join(years))
        _meta_set(con, "pulled_at", dt.datetime.now().isoformat(timespec="seconds"))
        con.execute("commit")
    except Exception:
        con.execute("rollback")
        raise


# ------------------------------------------------------------------ reading

def _irrigated(method):
    return method not in ("Dry Crop", "Sub-irrigated", "None")


def _acres(con):
    """Irrigated acres per basin/state for alfalfa and all farmland, from the table or the snapshot."""
    service = _meta(con, "wrlu_service") if _has(con, f"{NAME}_wrlu") else None
    out = {"alfalfa": {}, "farmland": {}}
    if service:
        for basin, state, method, crop, ac in con.execute(f"select * from {NAME}_wrlu").fetchall():
            if not _irrigated(method) or basin not in BASINS.values():
                continue
            key = "alfalfa" if crop == "Alfalfa" else "farmland"
            out[key].setdefault(basin, {}).setdefault(state, 0.0)
            out[key][basin][state] += ac
        layer, item = _meta(con, "wrlu_layer"), _meta(con, "wrlu_item") or WRLU_FALLBACK[2]
        about = {"service": service, "survey_years": (_meta(con, "wrlu_survey_years") or "").split(","),
                 "pulled_at": _meta(con, "pulled_at"), "snapshot": False}
    else:
        for (basin, state), ac in SNAPSHOT_ALFALFA.items():
            out["alfalfa"].setdefault(basin, {})[state] = ac
        service, layer, item = WRLU_FALLBACK
        about = {"service": service, "survey_years": [SNAPSHOT_SURVEY], "pulled_at": "2026-10-14", "snapshot": True}
    about["service_url"] = f"{SERVICES}/{service}/FeatureServer/{layer}"
    about["hub_url"], about["item_url"] = WRLU_HUB, ITEM_PAGE + item
    about["irrigated_rule"] = "every irrigation method except 'Dry Crop' and 'Sub-irrigated'"

    def pack(d):
        by_basin = {b: {s: round(v) for s, v in d.get(b, {}).items()} for b in BASINS.values() if b in d}
        utah = sum(v.get("Utah", 0) for v in by_basin.values())
        return {"by_basin": by_basin, "utah_total": utah,
                "other_states_total": sum(sum(x for s, x in v.items() if s != "Utah") for v in by_basin.values())}
    return {**about, "alfalfa": pack(out["alfalfa"]), "farmland": pack(out["farmland"]) if out["farmland"] else None}


def _basin_sql():
    return "case " + " ".join(f"when subarea like '{p}-%' then '{n}'" for p, n in BASINS.items()) + " end"


def _budget(con):
    """{var: {water_year: {basin: af}}} for Utah rows in the four basins, plus other states and all-Utah totals."""
    if not _has(con, WB) or not con.execute(f"select count(*) from {WB}").fetchone()[0]:
        return None
    names = list(AG_VARS.values())
    ph = ",".join("?" * len(names))
    in_basins = " or ".join(f"subarea like '{p}-%'" for p in BASINS)
    rows = con.execute(f"""
        select variable, water_year, {_basin_sql()} b, state = 'Utah' ut, sum(acre_ft)
        from {WB} where variable in ({ph}) and ({in_basins}) group by all""", names).fetchall()
    statewide = con.execute(f"""select variable, water_year, sum(acre_ft) from {WB}
                                where variable in ({ph}) and state = 'Utah' group by all""", names).fetchall()
    years = sorted({r[1] for r in rows})
    var_key = {v: k for k, v in AG_VARS.items()}
    ut = {k: {y: {b: 0.0 for b in BASINS.values()} for y in years} for k in AG_VARS}
    other = {k: {y: {b: 0.0 for b in BASINS.values()} for y in years} for k in AG_VARS}
    for var, y, b, is_ut, v in rows:
        (ut if is_ut else other)[var_key[var]][y][b] += v or 0
    state = {k: {y: 0.0 for y in years} for k in AG_VARS}
    for var, y, v in statewide:
        if y in state[var_key[var]]:
            state[var_key[var]][y] = v or 0
    service = con.execute("select v from water_budget_meta where k = 'service'").fetchone() if _has(con, "water_budget_meta") else None
    return {"years": years, "ut": ut, "other": other, "statewide": state, "service": service[0] if service else None}


def _r(v):
    return None if v is None else round(v)


def _water_year(d):
    return d.year + 1 if d.month >= 10 else d.year


def _wb_about(B):
    svc = B["service"] or "WB_Summary251119"
    return {"service": svc, "service_url": f"{SERVICES}/{svc}/FeatureServer/0",
            "hub_url": "https://dwre-utahdnr.opendata.arcgis.com/pages/water-budget",
            "license": "CC BY-SA (Utah Department of Natural Resources)",
            "first_wy": B["years"][0], "last_wy": B["years"][-1],
            "note": "Utah side only; Idaho and Wyoming farm use in the Bear basin is listed separately (other_states_af), "
                    "as the model's README calls it less certain."}


def _refs():
    st = [{"station": n, "basin": b, "elev_ft": e, "et_in": et, "net_irr_in": net, "page": p}
          for n, b, e, et, net, p in ALFALFA_STATIONS]
    valley = [s for s in st if s["elev_ft"] < 5000]
    med_et = _median([s["et_in"] for s in st])
    hh = _household_af()
    return {
        "alfalfa": {
            **ALFALFA_REPORT, "stations": st,
            "typical_ft": round(med_et / 12, 2), "typical_in": round(med_et, 1),
            "typical_rule": f"median of the {len(st)} NWS stations in the Bear, Weber, Jordan and Utah Lake basins listed below",
            "valley_median_ft": round(_median([s["et_in"] for s in valley]) / 12, 2),
            "range_ft": [round(min(s["et_in"] for s in st) / 12, 2), round(max(s["et_in"] for s in st) / 12, 2)],
            "typical_net_irr_ft": round(_median([s["net_irr_in"] for s in st]) / 12, 2),
        },
        "household": {**HOUSEHOLD, "af_per_year": round(hh, 3), "gallons_per_day": round(hh * GAL_PER_AF / 365)},
        "gal_per_af": GAL_PER_AF,
        "unavailable": {"usda_nass_quickstats": "needs an API key (keyless request returns HTTP 401)",
                        "openet": "needs an API key (keyless request returns HTTP 403)"},
    }


def query(con, window):
    out = {"refs": _refs(), "acres": _acres(con)}
    B = _budget(con)
    if not B or not B["years"]:
        out["budget_error"] = "Water budget data not pulled yet."
        return out
    want = _water_year(window["to_day"])
    y = want if want in B["years"] else B["years"][-1]
    n = len(B["years"])
    recent = [yy for yy in B["years"] if yy > B["years"][-1] - 10]

    def tot(k, yy):
        return sum(B["ut"][k][yy].values())
    out["budget"] = {
        **_wb_about(B), "water_year": y, "requested_water_year": want, "latest_available_used": y != want,
        "year": {k: {"four_basins_af": _r(tot(k, y)),
                     "by_basin_af": {b: _r(v) for b, v in B["ut"][k][y].items()},
                     "bear_weber_jordan_af": _r(sum(v for b, v in B["ut"][k][y].items() if b != "Utah Lake")),
                     "other_states_af": _r(sum(B["other"][k][y].values())),
                     "statewide_utah_af": _r(B["statewide"][k][y])} for k in AG_VARS},
        "average": {k: {"four_basins_af": _r(sum(tot(k, yy) for yy in B["years"]) / n),
                        "last10_four_basins_af": _r(sum(tot(k, yy) for yy in recent) / len(recent)),
                        "bear_weber_jordan_af": _r(sum(sum(v for b, v in B["ut"][k][yy].items() if b != "Utah Lake")
                                                       for yy in B["years"]) / n)} for k in AG_VARS},
        "average_years": [B["years"][0], B["years"][-1]], "last10_years": [recent[0], recent[-1]],
    }
    # annual rain + snow the model puts on the lake, a fallback when the window has no rain figure
    p = con.execute(f"select sum(acre_ft) from {WB} where subarea = '00-06-01' and variable = 'Precipitation' and water_year = ?", [y]).fetchone()
    out["budget"]["gsl_precip_af"] = _r(p[0]) if p else None
    out["series"] = _series(B)  # the Farms summary draws its chart from the window payload; /api/history isn't loaded there
    return out


def _series(B):
    Y = B["years"]
    return {
        **_wb_about(B), "water_years": Y,
        "four_basins_af": {k: [_r(sum(B["ut"][k][y].values())) for y in Y] for k in AG_VARS},
        "by_basin_af": {b: {k: [_r(B["ut"][k][y][b]) for y in Y] for k in AG_VARS} for b in BASINS.values()},
        "other_states_af": {k: [_r(sum(B["other"][k][y].values())) for y in Y] for k in AG_VARS},
        "statewide_utah_af": {k: [_r(B["statewide"][k][y]) for y in Y] for k in AG_VARS},
    }


def history(con):
    B = _budget(con)
    if not B or not B["years"]:
        return {"error": "Water budget data not pulled yet."}
    return _series(B)
