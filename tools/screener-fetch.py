#!/usr/bin/env python3
"""Pull one company's Screener page and print its tables as JSON.

Used when refreshing a research report into template v2 — quarterly results,
annual P&L, balance sheet, ratios and the shareholding series all come from
here rather than from search snippets, which only ever carry headline figures.

    python3 tools/screener-fetch.py SANSERA
    python3 tools/screener-fetch.py SANSERA --standalone --raw shareholding

Screener answers plain HTTP with a browser user-agent. Consolidated numbers are
the default; --standalone for companies with no subsidiaries worth consolidating.
"""
import argparse, json, re, sys, urllib.request, urllib.parse, html as htmllib

try:
    import ssl, certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
    _orig = urllib.request.urlopen
    urllib.request.urlopen = lambda *a, **kw: _orig(*a, **{**kw, "context": _CTX})
except Exception:
    pass

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}
TAG = re.compile(r"<[^>]+>")


def text(s):
    return htmllib.unescape(TAG.sub(" ", s)).replace("\xa0", " ").strip()


def clean(s):
    return re.sub(r"\s+", " ", text(s)).strip()


def fetch(symbol, standalone=False):
    path = "" if standalone else "consolidated/"
    url = f"https://www.screener.in/company/{urllib.parse.quote(symbol)}/{path}"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode("utf-8", "replace"), url


def section(doc, sec_id):
    """The HTML of <section id="…"> … up to the next <section."""
    m = re.search(rf'<section[^>]*id="{re.escape(sec_id)}"', doc)
    if not m:
        return ""
    start = m.start()
    nxt = doc.find("<section", m.end())
    return doc[start: nxt if nxt > 0 else len(doc)]


def parse_table(chunk):
    """First <table> in `chunk` → {"columns": [...], "rows": {label: [cells]}}."""
    t = re.search(r"<table[^>]*>(.*?)</table>", chunk, re.S)
    if not t:
        return None
    body = t.group(1)
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", body, re.S)
    if not rows:
        return None
    header = [clean(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", rows[0], re.S)]
    out, order = {}, []
    for r in rows[1:]:
        cells = [clean(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", r, re.S)]
        if not cells or not cells[0]:
            continue
        label = cells[0].rstrip("+").strip()
        if label in out:                      # Screener repeats some labels
            label += " (2)"
        out[label] = cells[1:]
        order.append(label)
    return {"columns": header[1:], "rows": out, "order": order}


def parse_ratios(doc):
    """The top ratio strip: Market Cap, Current Price, P/E, Book Value, …"""
    top = doc[: doc.find('id="analysis"') if 'id="analysis"' in doc else 20000]
    out = {}
    for li in re.findall(r"<li[^>]*>(.*?)</li>", top, re.S):
        name = re.search(r'class="name"[^>]*>(.*?)</span>', li, re.S)
        # Take the value to the end of the <li>, not to the first </span>:
        # High / Low nests two <span class="number"> and would truncate to the high.
        val  = re.search(r'class="(?:nowrap )?value"[^>]*>(.*)$', li, re.S)
        if name and val:
            out[clean(name.group(1)).rstrip(":")] = clean(val.group(1))
    return out


def company_id(doc):
    m = re.search(r'data-company-id="(\d+)"', doc)
    return m.group(1) if m else None


def schedule(cid, parent, section="balance-sheet", consolidated=True):
    """Screener expands a balance-sheet line via its own JSON endpoint. This is
    the only way to get Cash Equivalents, which the summary table folds into
    "Other Assets" — and without cash there is no net debt figure."""
    if not cid:
        return {}
    url = (f"https://www.screener.in/api/company/{cid}/schedules/"
           f"?parent={urllib.parse.quote(parent)}&section={section}"
           f"&consolidated={'' if consolidated else 'false'}")
    req = urllib.request.Request(url, headers={**UA, "X-Requested-With": "XMLHttpRequest"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except Exception:
        return {}


def parse_about(doc):
    m = re.search(r'class="company-profile".*?<p[^>]*>(.*?)</p>', doc, re.S)
    return clean(m.group(1)) if m else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbol")
    ap.add_argument("--standalone", action="store_true")
    ap.add_argument("--raw", help="dump one section's plain text instead of JSON")
    ap.add_argument("--schedule", help="expand one balance-sheet line, e.g. 'Other Assets'")
    a = ap.parse_args()

    doc, url = fetch(a.symbol, a.standalone)
    if a.schedule:
        json.dump(schedule(company_id(doc), a.schedule, consolidated=not a.standalone),
                  sys.stdout, indent=1)
        print()
        return
    if a.raw:
        print(re.sub(r"\n{3,}", "\n\n", text(section(doc, a.raw))))
        return

    data = {
        "symbol": a.symbol,
        "url": url,
        "basis": "standalone" if a.standalone else "consolidated",
        "about": parse_about(doc),
        "keydata": parse_ratios(doc),
    }
    cid = company_id(doc)
    # Cash and borrowings, so net debt is a filed figure rather than a guess
    other = schedule(cid, "Other Assets", consolidated=not a.standalone)
    if other.get("Cash Equivalents"):
        data["cash_equivalents"] = other["Cash Equivalents"]
    for k in ("Inventories", "Trade receivables"):
        if other.get(k):
            data.setdefault("working_capital", {})[k] = other[k]
    # "ratios" is both the top strip (keydata, above) and a section table —
    # keep them apart or the section silently overwrites the strip.
    for sec, key in (("quarters", "quarters"), ("profit-loss", "annual"),
                     ("balance-sheet", "balance_sheet"), ("cash-flow", "cash_flow"),
                     ("ratios", "ratio_table"), ("shareholding", "shareholding"),
                     ("peers", "peers")):
        tbl = parse_table(section(doc, sec))
        if tbl:
            data[key] = tbl
    json.dump(data, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
