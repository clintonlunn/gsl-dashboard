"""Smoke test for an exported copy of the page (server.py --export DIR): serve it, turn the knobs to every topic and
view (and Since 1847) at desktop and phone width, and fail on script errors, failed same-site requests, empty views or
sideways scrolling. Also runs axe-core on every view and prints what it finds; serious and critical findings fail the
run when AXE_STRICT=1.

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
TOPICS = ("lake", "budget", "rivers", "sky", "reservoirs", "ground", "farms")
# (topic, view, since 1847): each topic's summary and detail, the map once, and each topic's long record
KNOBS = [(t, v, False) for t in TOPICS for v in ("summary", "detail")] + [("lake", "map", False)] + [(t, "summary", True) for t in TOPICS]
# farm figures cover recent years only, so the long record has nothing for them by design
EMPTY_OK = {("farms", "summary", True)}
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
            for topic, view, hist in KNOBS:
                page.select_option("#preset", "all" if hist else "7")
                page.click(f"#topic button[value={topic}]")
                page.click(f"#view button[value={view}]")
                page.wait_for_timeout(1500)
                state = page.evaluate("""() => {
                    const stage = document.getElementById('stage');
                    return { text: stage.innerText.trim().length, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                             failed: /Couldn't load/.test(stage.innerText) };
                }""")
                where = f"{size} {topic}/{view}{' since 1847' if hist else ''}"
                if state["text"] < 200 and (topic, view, hist) not in EMPTY_OK:
                    errors.append(f"{where}: view is nearly empty ({state['text']} characters)")
                if state["failed"]:
                    errors.append(f"{where}: shows a load error")
                if state["sideways"] > 1:
                    errors.append(f"{where}: page scrolls sideways by {state['sideways']}px")
                if size == "desktop":
                    page.add_script_tag(content=axe)
                    found = page.evaluate("""async () => {
                        const r = await axe.run('main', { resultTypes: ['violations'] });
                        return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, n: v.nodes.length, first: v.nodes[0]?.target.join(' ') }));
                    }""")
                    for v in found:
                        line = f"axe {where}: [{v['impact']}] {v['id']} ×{v['n']}: {v['help']} (e.g. {v['first']})"
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
    print(f"ok: {len(KNOBS)} knob settings at {len(SIZES)} sizes; {len(axe_bad)} serious or critical accessibility findings")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "_site")
