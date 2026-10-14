"""Wetlands on the Great Salt Lake's edge: Utah Geological Survey wetland surveys and mapping.

All data come from the UGS data warehouse STAC collection "wetlands"
(https://maps-assets.geology.utah.gov/warehouse/stac/ugs-serving-topics/wetlands/collection.json, CC-BY-4.0),
read as GeoParquet. Each item's data link is taken from its STAC item, so a move in the warehouse is followed.

- wetlands_assessment_study_results: one row per survey stratum of the UGS random-sample condition surveys
  (Weber 2014, Jordan 2015-16, Bear River 2018, Central Basin 2019-20). We keep the strata named "Great Salt Lake",
  the wetlands ringing the lake. Fields: sites_surveyed; pct_{very_high,high,medium,low}_condition (share of
  surveyed sites in each overall-condition class); pct_{absent,low,med,high,very_high}_overall_stress (share by
  overall human stress); mean_overall_condition (1-5 rapid-assessment score, 5 = least altered); top_stressors and
  top_noxious_weeds (text, share of sites where seen). Counts of sites are pct x sites_surveyed, rounded.
- wetlands_assessment_projects: survey years and report link for each project.
- wetlands_plants_site: one row per site visit with vegetation data. vegetationcondition is
  "High Quality Reference" / "Not Reference" / "Not Evaluated" (whether the plant community is a least-disturbed
  reference); relnativecover = % of plant cover that is native; cwmeanc = cover-weighted mean coefficient of
  conservatism (0-10, higher = plants that need undisturbed sites). Sites marked privacystatus "Confidential" are
  counted but never sent to the page with coordinates.
- wetlands_wetdash_siteattributes (+ related water/soil/inverts tables): the sampling sites behind the Wetland Data
  Explorer (WetDash, https://wetlandsdata.geology.utah.gov), one row per sampling event, with how many water
  chemistry, soil and invertebrate records each has.
- wetlands_wetlandsoutline: the statewide wetland map (1.9 GB, 426k polygons). We read only acres, wetland_type and
  the bbox columns over HTTP (DuckDB httpfs range reads, ~15 MB), never the geometry. Polygons are assigned to the
  GSL area by the centre of their bounding box. Skipped if httpfs can't be loaded.

The surveys are historical (2011-2022), so the dashboard's date window only changes the "surveyed in this window" count.
"""
import json
import os
import tempfile
import time
import urllib.request

from . import _ugs

NAME = "ugs_wetlands"
LICENSE = "CC-BY-4.0"
CHECK_SEC = 7 * 86400  # warehouse tables change rarely; check at most weekly

# Great Salt Lake area (lon/lat, WGS84)
BBOX = (-113.2, 40.6, -111.8, 41.8)
STRATUM = "Great Salt Lake"
MAX_SITES = 300

COLL = _ugs.WAREHOUSE_WETLANDS
ITEMS = ["wetlands_assessment_study_results", "wetlands_assessment_projects", "wetlands_plants_site",
         "wetlands_wetdash_siteattributes", "wetlands_wetlandsoutline"]
PARQUET = "https://maps-assets.geology.utah.gov/warehouse/geoparquet"  # fallback when an item can't be read


def _item_url(i):
    return f"{COLL}/{i}/{i}.json"


def init(con):
    con.execute(f"""
        create table if not exists {NAME}_strata (project varchar, stratum varchar, years varchar, report varchar,
            sites integer, no_access integer, no_target integer, mean_condition double, mean_stress double,
            c_very_high double, c_high double, c_medium double, c_low double,
            s_absent double, s_low double, s_medium double, s_high double, s_very_high double,
            top_stressors varchar, top_weeds varchar, pct_marsh double, pct_mudflat double, pct_playa double,
            pct_aquatic_bed double, pct_saline_meadow double, pct_fresh_meadow double);
        create table if not exists {NAME}_sites (site varchar, project varchar, "day" date, lat double, lon double,
            shared boolean, condition varchar, wetland_type varchar, hgm varchar, native_pct double, mean_c double,
            watershed varchar, owner varchar);
        create table if not exists {NAME}_samples (siteid varchar, name varchar, project varchar, "day" date,
            lat double, lon double, wet_type varchar, n_water integer, n_soil integer, n_inverts integer);
        create table if not exists {NAME}_acres (wetland_type varchar, polygons integer, acres double);
        create table if not exists {NAME}_meta (k varchar primary key, v varchar);
    """)


def _meta(con, k):
    r = con.execute(f"select v from {NAME}_meta where k = ?", [k]).fetchone()
    return r[0] if r else None


def _set(con, k, v):
    con.execute(f"insert or replace into {NAME}_meta values (?, ?)", [k, str(v)])


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def _download(url, tmp):
    path = os.path.join(tmp, url.rsplit("/", 1)[-1])
    req = urllib.request.Request(url, headers={"User-Agent": "gsl-dashboard"})
    with urllib.request.urlopen(req, timeout=300) as r, open(path, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    return path


def _items(fetch):
    """STAC item id -> (content hash, asset hrefs)."""
    out = {}
    for i in ITEMS:
        try:
            it = (fetch or _get_json)(_item_url(i))
            out[i] = (it["properties"].get("ugs:content_hash", ""), {k: a["href"] for k, a in it["assets"].items()})
        except Exception:  # noqa: BLE001  fall back to the warehouse's usual layout
            out[i] = ("", {"data": f"{PARQUET}/{i}/{i}.parquet"})
    return out


def _in_box(x, y):
    w, s, e, n = BBOX
    return f"{x} between {w} and {e} and {y} between {s} and {n}"


def _load(con, items, tmp):
    def local(i, key="data"):
        return _download(items[i][1][key], tmp)

    res, proj, plants = local("wetlands_assessment_study_results"), local("wetlands_assessment_projects"), local("wetlands_plants_site")
    wd = items["wetlands_wetdash_siteattributes"][1]
    base = wd["data"].rsplit("/", 1)[0]
    attrs = local("wetlands_wetdash_siteattributes")
    rel = {k: _download(wd.get(f"wetlands_wetdash_{k}", f"{base}/related/wetlands_wetdash_{k}.parquet"), tmp)
           for k in ("water", "soil", "inverts")}

    con.execute("begin")
    try:
        for t in ("strata", "sites", "samples"):
            con.execute(f"delete from {NAME}_{t}")
        con.execute(f"""insert into {NAME}_strata
            select r.project, r.stratum_name, p.years, trim(p.projectreport, chr(13) || chr(10) || ' '), r.sites_surveyed, r.sites_no_access,
                r.sites_no_target_wetland, r.mean_overall_condition, r.mean_overall_stress,
                r.pct_very_high_condition, r.pct_high_condition, r.pct_medium_condition, r.pct_low_condition,
                r.pct_absent_overall_stress, r.pct_low_overall_stress, r.pct_med_overall_stress,
                r.pct_high_overall_stress, r.pct_very_high_overall_stress, r.top_stressors, r.top_noxious_weeds,
                r.marsh, r.basin_mudflat, r.basin_playa, r.aquatic_bed, r.basin_saline_meadow, r.basin_fresh_meadow
            from read_parquet(?) r left join read_parquet(?) p using (project)
            where r.stratum_name = ?""", [res, proj, STRATUM])
        con.execute(f"""insert into {NAME}_sites
            select sitecode, project, (surveydate at time zone 'UTC')::date, round(bbox_ymin, 5), round(bbox_xmin, 5),
                privacystatus = 'Shared', vegetationcondition, wetlandtype, nullif(hgm_class, 'No Data'),
                relnativecover, cwmeanc, watershed, owner
            from read_parquet(?) where {_in_box('bbox_xmin', 'bbox_ymin')}""", [plants])
        con.execute(f"""insert into {NAME}_samples
            with w as (select siteid, count(*) n from read_parquet(?) group by 1),
                 s as (select siteid, count(*) n from read_parquet(?) group by 1),
                 v as (select siteid, count(*) n from read_parquet(?) group by 1)
            select a.siteid, a.name, a.project, a."date", a.latitude, a.longitude, a.wet_type,
                coalesce(w.n, 0), coalesce(s.n, 0), coalesce(v.n, 0)
            from read_parquet(?) a left join w using (siteid) left join s using (siteid) left join v using (siteid)
            where {_in_box('a.longitude', 'a.latitude')}""", [rel["water"], rel["soil"], rel["inverts"], attrs])
        if not con.execute(f"select count(*) from {NAME}_strata").fetchone()[0]:
            raise RuntimeError(f"no '{STRATUM}' strata in wetlands_assessment_study_results")
        con.execute("commit")
    except Exception:
        con.execute("rollback")
        raise


def _load_acres(con, href):
    """Mapped wetland acres by type, read column-wise over HTTP; never downloads the geometry."""
    try:
        con.execute("load httpfs")
    except Exception:  # noqa: BLE001  first run on this machine
        con.execute("install httpfs; load httpfs")
    rows = con.execute(f"""
        select wetland_type, count(*), sum(acres) from read_parquet(?)
        where {_in_box('(bbox_xmin + bbox_xmax) / 2', '(bbox_ymin + bbox_ymax) / 2')} group by 1""", [href]).fetchall()
    if rows:
        con.execute(f"delete from {NAME}_acres")
        con.executemany(f"insert into {NAME}_acres values (?, ?, ?)", rows)


def refresh(con, fetch=None):
    init(con)
    have = con.execute(f"select count(*) from {NAME}_strata").fetchone()[0]
    last = _meta(con, "checked")
    if have and last and time.time() - float(last) < CHECK_SEC:
        return
    items = _items(fetch)
    stamp = "|".join(items[i][0] for i in ITEMS[:4])
    if not (have and stamp and stamp == _meta(con, "stamp")):
        with tempfile.TemporaryDirectory() as tmp:
            _load(con, items, tmp)
        _set(con, "stamp", stamp)
    outline = items["wetlands_wetlandsoutline"]
    have_acres = con.execute(f"select count(*) from {NAME}_acres").fetchone()[0]
    if not (have_acres and outline[0] and outline[0] == _meta(con, "acres_stamp")):
        try:
            _load_acres(con, outline[1]["data"])
            _set(con, "acres_stamp", outline[0])
        except Exception as e:  # noqa: BLE001  acreage is extra; keep the rest
            print(f"source {NAME}: wetland acreage skipped: {e}", flush=True)
    _set(con, "checked", time.time())


def _r(v, n=1):
    return None if v is None else round(v, n)


CONDITION = [("very_high", "Very high"), ("high", "High"), ("medium", "Medium"), ("low", "Low")]
COND = {"High Quality Reference": "reference", "Not Reference": "not reference", "Not Evaluated": "not evaluated"}
STRESS = [("absent", "Absent"), ("low", "Low"), ("medium", "Medium"), ("high", "High"), ("very_high", "Very high")]


def query(con, window):
    try:
        strata = con.execute(f"select * from {NAME}_strata order by years").fetchall()
    except Exception:  # noqa: BLE001  table not created yet
        return {"available": False}
    if not strata:
        return {"available": False}
    cols = [d[0] for d in con.description]
    strata = [dict(zip(cols, r)) for r in strata]

    def counts(prefix, levels):
        return [{"key": k, "label": lab, "sites": sum(round((s[f"{prefix}_{k}"] or 0) * s["sites"] / 100) for s in strata)}
                for k, lab in levels]

    total = sum(s["sites"] for s in strata)
    mean_cond = sum(s["mean_condition"] * s["sites"] for s in strata) / total

    sv = con.execute(f"""select count(*), count(*) filter (where shared), min(year("day")), max(year("day")),
            count(distinct project), count(*) filter ("day" between ? and ?) from {NAME}_sites""",
                     [window["from_day"], window["to_day"]]).fetchone()
    by_cond = con.execute(f"select condition, count(*) from {NAME}_sites group by 1 order by 2 desc").fetchall()
    years = [r[0] for r in con.execute(f'select distinct year("day") from {NAME}_sites order by 1').fetchall()]
    sites = con.execute(f"""select site, lat, lon, condition, wetland_type, year("day"), round(native_pct)::int from {NAME}_sites where shared and lat is not null
            order by "day" desc, site limit {MAX_SITES}""").fetchall()
    notable = con.execute(f"""select site, year("day"), wetland_type, watershed, owner, round(native_pct)::int, round(mean_c, 1)
            from {NAME}_sites where shared and condition = 'High Quality Reference' and native_pct is not null
            order by native_pct desc, mean_c desc limit 8""").fetchall()
    wd = con.execute(f"""select count(*), count(distinct (lat, lon)), min("day"), max("day"), count(distinct project),
            sum(n_water), sum(n_soil), sum(n_inverts), count(*) filter ("day" between ? and ?) from {NAME}_samples""",
                     [window["from_day"], window["to_day"]]).fetchone()
    acres = con.execute(f"select wetland_type, polygons, acres from {NAME}_acres order by acres desc").fetchall()

    W = _ugs.WAREHOUSE_WETLANDS
    return {
        "available": True,
        "bbox": list(BBOX),
        "assessment": {
            "strata": [{"project": s["project"], "years": s["years"], "report": s["report"], "sites": s["sites"],
                        "mean_condition": _r(s["mean_condition"]),
                        "pct_high_stress": _r((s["s_high"] or 0) + (s["s_very_high"] or 0)),
                        "pct_high_condition": _r((s["c_high"] or 0) + (s["c_very_high"] or 0)),
                        "top_stressors": s["top_stressors"], "top_weeds": s["top_weeds"]} for s in strata],
            "sites": total,
            "mean_condition": _r(mean_cond),
            "condition": counts("c", CONDITION),
            "stress": counts("s", STRESS),
        },
        "surveys": {"visits": sv[0], "shared": sv[1], "first_year": sv[2], "last_year": sv[3], "projects": sv[4],
                    "in_window": sv[5], "years": years, "by_condition": [{"label": c, "sites": n} for c, n in by_cond]},
        "notable": [{"site": r[0], "year": r[1], "type": r[2], "watershed": r[3], "owner": r[4], "native_pct": r[5],
                     "mean_c": r[6]} for r in notable],
        # for the main map: shared (non-confidential) vegetation survey sites in the GSL area
        "sites": [{"id": r[0], "lat": r[1], "lon": r[2], "cond": COND.get(r[3], r[3]), "type": r[4], "year": r[5],
                   "native_pct": r[6]} for r in sites],
        "wetdash": {"events": wd[0], "locations": wd[1], "first_day": wd[2] and wd[2].isoformat(),
                    "last_day": wd[3] and wd[3].isoformat(), "projects": wd[4], "water": wd[5], "soil": wd[6],
                    "inverts": wd[7], "in_window": wd[8]} if wd[0] else None,
        "acres": [{"type": t, "polygons": n, "acres": round(a)} for t, n, a in acres],
        "links": {
            "collection": f"{W}/collection.json",
            "study_results": _item_url("wetlands_assessment_study_results"),
            "plants_site": _item_url("wetlands_plants_site"),
            "wetdash": _item_url("wetlands_wetdash_siteattributes"),
            "outline": _item_url("wetlands_wetlandsoutline"),
            "features": f"{_ugs.WAREHOUSE_FEATURES}/collections/wetlands_assessment_study_results",
            "data_app": _ugs.WETLANDS_DATA_APP + "/",
            "map_app": _ugs.WETLANDS_APP + "/",
            "catalog": _ugs.CATALOG_APP,
            "ugs": _ugs.HOME + "/water/wetlands/",
        },
        "license": LICENSE,
    }
