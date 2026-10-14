"""Utah Geological Survey Soil Water Balance (Modified Utah Basin Model), monthly zonal statistics.

STAC catalog: https://ubm-assets.geology.utah.gov/stac/catalog.json (collection license: "proprietary").
Each region is one Parquet file of monthly totals for an ensemble of model runs ({precip}_{et} members)
plus their mean. We keep the values in DuckDB and only send summaries to the page; raw files aren't served.

Soil saturation is the value at the end of each month. Volumes (m3) are basin totals; mm are
depths averaged over the region.
"""
from . import _ugs
import datetime as dt
import json
import os
import tempfile
import urllib.request

NAME = "ugs_swb"

STAC = _ugs.SWB_STAC
ASSETS = _ugs.SWB_ZONAL
# region -> (label, boundary_type used in the asset path when the STAC item can't be read)
REGIONS = {
    "GSL_Basin": ("Great Salt Lake basin", "Custom_Boundaries"),
    "Upper_Bear": ("Upper Bear River", "HUC6_Basins"),
    "Lower_Bear": ("Lower Bear River", "HUC6_Basins"),
    "Weber": ("Weber River", "HUC6_Basins"),
    "Jordan": ("Jordan River", "HUC6_Basins"),
    "West_Desert": ("West Desert", "HUC6_Basins"),
}
MAIN = "GSL_Basin"
MEAN = "Ensemble_Mean"
REFRESH_SEC = 24 * 3600
M3_PER_AF = 1233.48

COLS = {  # our column -> parquet column
    "precip_mm": "precip_and_snowmelt_input", "irrigation_mm": "irrigation", "aet_mm": "AET",
    "runoff_mm": "Runoff", "recharge_mm": "Recharge", "soil_sat_pct": "Soil_Saturation_Percent_End_Of_Timestep",
    "precip_m3": "precip_and_snowmelt_input_m3", "irrigation_m3": "irrigation_m3", "aet_m3": "AET_m3",
    "runoff_m3": "Runoff_m3", "recharge_m3": "Recharge_m3",
}
SERIES = ["precip", "aet", "runoff", "recharge", "soil_sat"]  # sent to the page, with ensemble min/max
COL = {"precip": "precip_mm", "aet": "aet_mm", "runoff": "runoff_mm", "recharge": "recharge_mm", "soil_sat": "soil_sat_pct"}


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_monthly (
            region varchar, month date, member varchar,
            {", ".join(f"{c} double" for c in COLS)},
            primary key (region, month, member));
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);""")


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _meta_set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, v])


def _href(region, fetch):
    """Parquet URL from the region's STAC item, falling back to the known path layout."""
    try:
        return fetch(f"{STAC}/ubm-zonal-stats/{region}/{region}.json", timeout=60)["assets"]["data"]["href"]
    except Exception:  # noqa: BLE001
        return f"{ASSETS}/boundary_type={REGIONS[region][1]}/region_name={region}/data.parquet"


def _download(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=180) as r, open(path, "wb") as f:
        f.write(r.read())


def refresh(con, fetch):
    """Re-pull every region at most once a day. The files are small (~0.5 MB) and get revised, so we replace them."""
    init(con)
    last = _meta(con, "pulled_at")
    if last and (dt.datetime.now() - dt.datetime.fromisoformat(last)).total_seconds() < REFRESH_SEC:
        return
    errors = {}
    tmpdir = tempfile.mkdtemp(prefix="ugs_swb_")
    try:
        for region in REGIONS:
            path = os.path.join(tmpdir, f"{region}.parquet")
            try:
                _download(_href(region, fetch), path)
                sel = ", ".join(f'"{src}"::double {c}' for c, src in COLS.items())
                con.execute("begin")
                con.execute(f"delete from {NAME}_monthly where region = ?", [region])
                con.execute(f"""insert into {NAME}_monthly
                                select ?, "Date"::date, Ensemble_Member, {sel} from read_parquet(?)""", [region, path])
                con.execute("commit")
            except Exception as e:  # noqa: BLE001  one region failing keeps the others (and its old rows)
                try:
                    con.execute("rollback")
                except Exception:  # noqa: BLE001
                    pass
                errors[region] = str(e)
            finally:
                if os.path.exists(path):
                    os.unlink(path)  # proprietary data: keep only the table, not the file
    finally:
        os.rmdir(tmpdir)
    _meta_set(con, "errors", json.dumps(errors))
    if MAIN not in errors:
        _meta_set(con, "pulled_at", dt.datetime.now().isoformat(timespec="seconds"))
    if errors:
        print(f"source {NAME}: failed regions {errors}", flush=True)


def _r(v, n=1):
    return None if v is None else round(v, n)


def _ensemble(region_sql, extra_where=""):
    """Monthly ensemble mean plus min/max across members, for the SERIES columns."""
    agg = ", ".join(
        f"max({COL[s]}) filter (where member = '{MEAN}') {s}, "
        f"min({COL[s]}) filter (where member <> '{MEAN}') {s}_lo, "
        f"max({COL[s]}) filter (where member <> '{MEAN}') {s}_hi" for s in SERIES)
    return f"""select month, {agg}, count(*) filter (where member <> '{MEAN}') members
               from {NAME}_monthly where region = {region_sql} {extra_where} group by month order by month"""


def _columns(cur):
    """Result as {column: [values]}, months as 'YYYY-MM', values rounded to 0.1."""
    cols = [c[0] for c in cur.description]
    data = cur.fetchall()
    return {c: [(r[i].isoformat()[:7] if c == "month" else r[i] if c == "members" else _r(r[i])) for r in data]
            for i, c in enumerate(cols)}


def query(con, window):
    from_day, to_day = window["from_day"], window["to_day"]
    if not con.execute(f"select count(*) from {NAME}_monthly").fetchone()[0]:
        return {"error": "No soil water balance data pulled yet."}
    # the month shown: the last modelled month that starts on or before the window's end
    # ("usual" = median of the same calendar month in every other year, from the ensemble mean)
    rows = con.execute(f"""
        with m as (select region, month, member, soil_sat_pct from {NAME}_monthly),
             focus as (select region, max(month) "month" from m where member = '{MEAN}' and month <= ? group by region),
             cur as (select f.region, f.month,
                            max(soil_sat_pct) filter (where member = '{MEAN}') now_pct,
                            min(soil_sat_pct) filter (where member <> '{MEAN}') lo_pct,
                            max(soil_sat_pct) filter (where member <> '{MEAN}') hi_pct,
                            count(*) filter (where member <> '{MEAN}') members
                     from focus f join m using (region, month) group by all),
             clim as (select c.region, median(m.soil_sat_pct) usual_pct, count(*) n_years,
                             count(*) filter (where m.soil_sat_pct < c.now_pct) years_drier
                      from cur c join m on m.region = c.region and m.member = '{MEAN}'
                           and month(m.month) = month(c.month) and m.month <> c.month
                      group by c.region)
        select region, month, now_pct, usual_pct, lo_pct, hi_pct, members, n_years, years_drier
        from cur left join clim using (region)""", [to_day]).fetchall()
    regions = {}
    for region, month, now, usual, lo, hi, members, years, drier in rows:
        regions[region] = {"label": REGIONS.get(region, (region,))[0], "month": month.isoformat(),
                           "soil_sat_pct": _r(now), "usual_pct": _r(usual), "ens_min_pct": _r(lo), "ens_max_pct": _r(hi),
                           "members": members, "years_compared": years, "years_drier": drier}
    if MAIN not in regions:
        return {"error": "The window ends before the soil water balance record starts (Jan 2005)."}
    main = regions.pop(MAIN)
    through = con.execute(f"select max(month) from {NAME}_monthly where region = ? and member = ?", [MAIN, MEAN]).fetchone()[0]
    # monthly rows overlapping the window, basin only
    first = dt.date(from_day.year, from_day.month, 1)
    cur = con.execute(_ensemble("?", "and month >= ? and month <= ?"), [MAIN, first, to_day])
    months = _columns(cur)
    return {"basin": {"region": MAIN, **main}, "sub_basins": [{"region": k, **regions[k]} for k in REGIONS if k in regions],
            "months": months, "data_through": through.isoformat(), "pulled_at": _meta(con, "pulled_at"),
            "license": "proprietary", "units": {"depth": "mm of water averaged over the region", "soil_sat": "% of soil water capacity, end of month"}}


def history(con):
    if not con.execute(f"select count(*) from {NAME}_monthly where region = ?", [MAIN]).fetchone()[0]:
        return {"error": "No soil water balance data pulled yet."}
    monthly = _columns(con.execute(_ensemble("?"), [MAIN]))
    # water year = Oct-Sep, named for the year it ends; only years with all 12 months
    m3 = ["precip_m3", "irrigation_m3", "aet_m3", "runoff_m3", "recharge_m3"]
    cur = con.execute(f"""
        select year(month + interval 3 month) water_year, count(*) n_months, {", ".join(f"sum({c}) {c}" for c in m3)}
        from {NAME}_monthly where region = ? and member = ? group by 1 having count(*) = 12 order by 1""", [MAIN, MEAN])
    cols = [c[0] for c in cur.description]
    annual = []
    for r in cur.fetchall():
        d = dict(zip(cols, r))
        row = {"water_year": d["water_year"]}
        for c in m3:
            row[c] = round(d[c])
            row[c.replace("_m3", "_af")] = round(d[c] / M3_PER_AF)
        annual.append(row)
    area = con.execute(f"""select median(precip_m3 / (precip_mm / 1000)) from {NAME}_monthly
                           where region = ? and member = ? and precip_mm > 0""", [MAIN, MEAN]).fetchone()[0]
    return {"region": MAIN, "label": REGIONS[MAIN][0], "monthly": monthly, "annual": annual,
            "area_km2": round(area / 1e6), "af_per_mm": round(area / 1000 / M3_PER_AF),
            "m3_per_af": M3_PER_AF, "license": "proprietary", "pulled_at": _meta(con, "pulled_at")}
