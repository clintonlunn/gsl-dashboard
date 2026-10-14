"""Utah Geological Survey endpoints, in one place.

UGS is reorganizing its data services, so every UGS address the dashboard uses
lives here. Each can be overridden with an environment variable without editing code,
e.g. UGS_SWB_ASSETS=https://new-host.example python3 server.py
"""
import os


def _url(env, default):
    return os.environ.get(env, default).rstrip("/")


# Soil Water Balance (Modified Utah Basin Model), behind basin.geology.utah.gov
SWB_ASSETS = _url("UGS_SWB_ASSETS", "https://ubm-assets.geology.utah.gov")
SWB_STAC = _url("UGS_SWB_STAC", f"{SWB_ASSETS}/stac")
SWB_ZONAL = _url("UGS_SWB_ZONAL", f"{SWB_ASSETS}/ubm_zonal_stats")
SWB_APP = _url("UGS_SWB_APP", "https://basin.geology.utah.gov")

# Data warehouse STAC behind data.geology.utah.gov/catalog
WAREHOUSE_STAC = _url("UGS_WAREHOUSE_STAC", "https://maps-assets.geology.utah.gov/warehouse/stac")
CATALOG_APP = _url("UGS_CATALOG_APP", "https://data.geology.utah.gov/catalog")

# Publications server
PUBS = _url("UGS_PUBS", "https://ugspub.nr.utah.gov/publications")

HOME = "https://geology.utah.gov"

# Wetlands (used by sources/ugs_wetlands.py)
WAREHOUSE_WETLANDS = _url("UGS_WAREHOUSE_WETLANDS", f"{WAREHOUSE_STAC}/ugs-serving-topics/wetlands")  # STAC collection folder
WAREHOUSE_FEATURES = _url("UGS_WAREHOUSE_FEATURES", "https://ugs-warehouse-features-xedvkyurga-uc.a.run.app")  # OGC API Features
WETLANDS_APP = _url("UGS_WETLANDS_APP", "https://wetlands.geology.utah.gov")  # Utah Wetlands map
WETLANDS_DATA_APP = _url("UGS_WETLANDS_DATA_APP", "https://wetlandsdata.geology.utah.gov")  # Wetland Data Explorer (WetDash)
WETLANDS_DATA_API = _url("UGS_WETLANDS_DATA_API", "https://postgrest-seamlessgeolmap-734948684426.us-central1.run.app")  # its PostgREST API

# Groundwater Monitoring Data Portal (gwportal.geology.utah.gov) and the PostgREST API its page calls
GW_PORTAL = _url("UGS_GW_PORTAL", "https://gwportal.geology.utah.gov")
GW_API = _url("UGS_GW_API", "https://ugs-koop-734948684426.us-west3.run.app")

# Eddy-covariance flux towers on the causeway (AmeriFlux US-UTX south arm, US-UTY north arm). UGS is moving
# these services in house; set UGS_FLUX_API once it's live and the evaporation source can prefer measured values
# over its gridMET estimate. Empty means "not available yet".
FLUX_API = os.environ.get("UGS_FLUX_API", "").rstrip("/")
