"""Plug-in data sources.

Each module in this package is one source and exposes:

    NAME: str                         key under "sources" in the API responses; tables use the prefix f"{NAME}_"
    init(con) -> None                 optional: create tables (`create table if not exists`)
    refresh(con, fetch) -> None       pull new data into its tables; called hourly, so skip work that's already done
    query(con, window) -> dict        JSON-safe data for one window; window = {from_day, to_day (dates), days, resolution}
    history(con) -> dict              optional: long-record data for the Since 1847 period

`con` is an open DuckDB connection; `fetch(url, body=None, timeout=180)` GETs (or POSTs JSON) and returns parsed JSON.
Each source pairs with static/panels/<NAME>.js, which draws it on the page.
"""
import importlib
import pkgutil

ALL = []
for _m in sorted(pkgutil.iter_modules(__path__), key=lambda m: m.name):
    if _m.name.startswith("_"):
        continue
    try:
        ALL.append(importlib.import_module(f"{__name__}.{_m.name}"))
    except Exception as e:  # noqa: BLE001  a broken source must not take the server down
        print(f"source {_m.name} failed to load: {e}", flush=True)
