"""Smoke test for an exported copy of the page (server.py --export DIR): serve it, open every tab at desktop and phone
width, and fail on script errors, failed same-site requests, empty tabs or sideways scrolling. Also runs axe-core on
every tab and prints what it finds; serious and critical findings fail the run when AXE_STRICT=1.

    python tests/smoke.py _site

Live feeds (USGS, NWS, radar tiles) come from other sites and can be down; their failures don't fail the test, since
the page is built to carry on without them.
"""
import functools
import http.server
import os
import sys
import threading
import urllib.request

from playwright.sync_api import TimeoutError as PlaywrightTimeout, sync_playwright

AXE = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js"
TABS = ("glance", "water", "history", "ag", "details")
SIZES = {"desktop": (1440, 900), "phone": (390, 844)}


def serve(root):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    handler = functools.partial(Quiet, directory=root)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


def main(root):
    httpd, base = serve(root)
    axe = urllib.request.urlopen(AXE, timeout=30).read().decode()
    problems, axe_bad = [], []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for size, (w, h) in SIZES.items():
            page = browser.new_page(viewport={"width": w, "height": h})
            errors = []
            page.on("pageerror", lambda e: errors.append(f"script error: {e}"))
            page.on("requestfailed", lambda r: r.url.startswith(base) and errors.append(f"request failed: {r.url}"))
            page.on("response", lambda r: r.url.startswith(base) and r.status >= 400 and errors.append(f"HTTP {r.status}: {r.url}"))
            page.goto(base)
            try:
                page.wait_for_function("() => !/^Loading/.test(document.getElementById('answer-h').textContent)", timeout=60000)
            except PlaywrightTimeout:
                problems += [f"{size}: page never finished loading", *(f"{size}: {e}" for e in errors)]
                page.close()
                continue
            for tab in TABS:
                page.click(f"#tab-{tab}")
                page.wait_for_timeout(2500)
                state = page.evaluate("""(tab) => {
                    const panel = document.getElementById(`panel-${tab}`);
                    return { text: panel.innerText.trim().length, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                             failed: /Couldn't load/.test(panel.innerText) };
                }""", tab)
                where = f"{size} {tab}"
                if state["text"] < 200:
                    errors.append(f"{where}: tab is nearly empty ({state['text']} characters)")
                if state["failed"]:
                    errors.append(f"{where}: shows a load error")
                if state["sideways"] > 1:
                    errors.append(f"{where}: page scrolls sideways by {state['sideways']}px")
                if size == "desktop":
                    page.add_script_tag(content=axe)
                    found = page.evaluate("""async (tab) => {
                        const r = await axe.run(`#panel-${tab}`, { resultTypes: ['violations'] });
                        return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, first: v.nodes[0]?.target.join(' ') }));
                    }""", tab)
                    for v in found:
                        line = f"axe {tab}: [{v['impact']}] {v['id']} ×{v['n']}: {v['help']} (e.g. {v['first']})"
                        print(line)
                        if v["impact"] in ("serious", "critical"):
                            axe_bad.append(line)
            problems += [f"{size}: {e}" if not e.startswith(size) else e for e in errors]
            page.close()
        browser.close()
    httpd.shutdown()
    for line in problems:
        print("FAIL", line)
    strict = os.environ.get("AXE_STRICT") == "1"
    if problems or (strict and axe_bad):
        sys.exit(1)
    print(f"ok: {len(TABS)} tabs at {len(SIZES)} sizes; {len(axe_bad)} serious or critical accessibility findings")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "_site")
