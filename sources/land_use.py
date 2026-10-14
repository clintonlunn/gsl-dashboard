"""Water-related land use: what's grown in the lake's river basins, and how it's watered, year by year.

Utah Division of Water Resources (DWRe) Water-Related Land Use (WRLU) maps every field in the state each year with
its crop (`Description`, grouped as `CropGroup`), irrigation method (`IRR_Method`: Flood, Sprinkler, Pivot, Wheel,
Drip, Sub-irrigated, Dry Crop, None) and land-use class (`LU_Group`: Active IR, SubIRR, Dry Ag, Idle/Fallow, Urban,
Urban Grass, RIP, Water, Wet Flats). Each year is its own public, keyless ArcGIS Online feature service in DWRe's
org; one server-side group-by per year (a few hundred rows) is all this pulls, never polygons.

Basins are DWRe hydrologic basins (Bear River, Weber River, Jordan River, Utah Lake), not HUCs. The Bear basin
includes Idaho and Wyoming fields; rows keep `State` so the page can show the Utah side alone.

DWRe: year-to-year changes "should not be construed to represent definitive trends"; the 2024 survey was adjusted
after USDA changed the Cropland Data Layer method. Licensed CC BY-SA (Utah DNR, for reference use only).
"""
import datetime as dt
import json
import urllib.parse

from . import ag

NAME = "land_use"
SERVICES = ag.SERVICES
# year -> (service, layer); service names and layer ids differ year to year. Newer years are found by ag's search.
YEARS = {
    2017: ("Water_Related_Land_Use_Statewide_2017_1", 0),
    2018: ("Water_Related_Land_Use_Statewide_2018", 0),
    2019: ("WaterRelatedLandUse_2019", 0),
    2020: ("Water_Related_Land_Use_(2020)", 0),
    2021: ("Water_Related_Land_Use_(2021)", 0),
    2022: ("WaterRelatedLandUse_2022", 0),
    2023: ("WaterRelatedLandUse_2023", 1),
    2024: ("WRLU_2024_Publish", 17),
    2025: ("WaterRelatedLandUse_2025", 27),
}
BASINS = ("Bear River", "Weber River", "Jordan River", "Utah Lake")
IRRIGATED = ("Active IR", "SubIRR")
HUB = ag.WRLU_HUB
SGID = "https://gis.utah.gov/products/sgid/planning/water-related-land-use/"
REFRESH_SEC = 7 * 24 * 3600  # surveys come out once a year; the newest one is revised now and then
RETRY_SEC = 24 * 3600


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_acres (year integer, basin varchar, state varchar, lu_group varchar,
            crop_group varchar, crop varchar, method varchar, acres double);
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


def _services(fetch):
    out = dict(YEARS)
    name, layer, _ = ag._latest_wrlu(fetch)
    year = int(name[-4:]) if name[-4:].isdigit() else None
    if year and year not in out:
        out[year] = (name, layer)
    return out


def _pull_year(fetch, service, layer):
    basins = ",".join(f"'{b}'" for b in BASINS)
    r = fetch(f"{SERVICES}/{urllib.parse.quote(service)}/FeatureServer/{layer}/query?" + urllib.parse.urlencode({
        "where": f"Basin IN ({basins})",
        "groupByFieldsForStatistics": "Basin,State,LU_Group,CropGroup,Description,IRR_Method",
        "outStatistics": json.dumps([{"statisticType": "sum", "onStatisticField": "Acres", "outStatisticFieldName": "ac"}]),
        "resultRecordCount": 2000, "f": "json"}), timeout=120)
    if "error" in r:
        raise RuntimeError(f"{service}: {r['error'].get('message') or r['error'].get('details')}")
    if r.get("exceededTransferLimit"):
        raise RuntimeError(f"{service}: more than 2000 groups; page the query")
    return [f["attributes"] for f in r.get("features", []) if f["attributes"].get("ac")]


def refresh(con, fetch):
    init(con)
    now = dt.datetime.now()
    last, tried = _meta(con, "pulled_at"), _meta(con, "tried_at")
    if last and (now - dt.datetime.fromisoformat(last)).total_seconds() < REFRESH_SEC:
        return
    if tried and (now - dt.datetime.fromisoformat(tried)).total_seconds() < RETRY_SEC:
        return
    _meta_set(con, "tried_at", now.isoformat(timespec="seconds"))
    rows, failed = [], []
    services = _services(fetch)
    for year, (service, layer) in sorted(services.items()):
        try:
            for a in _pull_year(fetch, service, layer):
                rows.append((year, a.get("Basin"), a.get("State") or "Unknown", a.get("LU_Group") or "Other",
                             a.get("CropGroup") or None, a.get("Description") or None, a.get("IRR_Method") or "None", a["ac"]))
        except Exception as e:  # noqa: BLE001  one bad year must not drop the others
            failed.append(f"{year}: {e}")
    if failed:
        print(f"source {NAME}: {len(failed)} years failed, e.g. {failed[0][:200]}", flush=True)
    got = {r[0] for r in rows}
    if not got:
        raise RuntimeError(f"{NAME}: no years pulled")
    con.execute("begin")
    try:
        # replace only the years that answered, so a flaky year keeps last week's numbers
        con.execute(f"delete from {NAME}_acres where year in ({','.join(str(y) for y in got)})")
        con.executemany(f"insert into {NAME}_acres values (?, ?, ?, ?, ?, ?, ?, ?)", rows)
        _meta_set(con, "services", json.dumps({str(y): s for y, s in services.items()}))
        _meta_set(con, "pulled_at", dt.datetime.now().isoformat(timespec="seconds"))
        con.execute("commit")
    except Exception:
        con.execute("rollback")
        raise


def query(con, window):
    init(con)
    years = [r[0] for r in con.execute(f"select distinct year from {NAME}_acres order by 1").fetchall()]
    if not years:
        return {"error": "No water-related land use pulled yet."}
    latest = years[-1]
    irr = ",".join(f"'{g}'" for g in IRRIGATED)
    # compact rows (arrays) because every exported period carries this payload; utah = 1 for Utah fields
    trend = con.execute(f"""
        select year, basin, (state = 'Utah')::int, method, round(sum(acres)) from {NAME}_acres
        where lu_group in ({irr}) group by all order by 1, 2, 3, 4""").fetchall()
    # the class is spelled "Wetflats" before 2025; "Other" was dropped after 2023, so it is left out rather than shown vanishing
    groups = con.execute(f"""
        select year, basin, (state = 'Utah')::int, replace(lu_group, 'Wetflats', 'Wet Flats'), round(sum(acres)) from {NAME}_acres
        where lu_group <> 'Other' group by all order by 1, 2, 3, 4""").fetchall()
    crops = con.execute(f"""
        select basin, (state = 'Utah')::int, crop_group, crop, method, round(sum(acres)) from {NAME}_acres
        where year = ? and lu_group in ({irr}) and crop is not null group by all having sum(acres) >= 1 order by 6 desc""",
        [latest]).fetchall()
    services = json.loads(_meta(con, "services") or "{}")
    svc = services.get(str(latest)) or list(YEARS[max(YEARS)])
    return {
        "years": years, "latest": latest, "basins": list(BASINS), "irrigated_groups": list(IRRIGATED),
        "trend": [list(r) for r in trend], "groups": [list(r) for r in groups], "crops": [list(r) for r in crops],
        "pulled_at": _meta(con, "pulled_at"),
        "about": {"hub_url": HUB, "sgid_url": SGID, "service_url": f"{SERVICES}/{svc[0]}/FeatureServer/{svc[1]}",
                  "license": "CC BY-SA", "credit": "Utah Division of Water Resources (DWRe)"},
    }
