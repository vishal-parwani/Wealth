#!/usr/bin/env python3
"""Write the monthly net-worth snapshot without the app being open.

The dashboard saves a snapshot on the 1st of the month, but only if a browser
happens to be open that day. This runs the same calculation server-side on a
schedule, so the history has no holes.

It mirrors getPortfolioValues() in portfolio.js exactly: same price sources,
same fallbacks, same asset keys. Anything it can't price falls back to the
invested amount, as the app does — a snapshot with a stale leg beats no
snapshot at all.

Credentials resolve as in publish-reports.py (--key / $WEALTH_SA_KEY /
$WEALTH_SA_KEY_FILE). Idempotent: a snapshot already saved for the target
month is left alone unless --force is given.

    python3 tools/monthly-snapshot.py --dry-run --email you@example.com
    python3 tools/monthly-snapshot.py --email you@example.com
"""
import argparse, datetime as dt, json, os, time, urllib.parse, urllib.request
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "pubrep", os.path.join(os.path.dirname(os.path.abspath(__file__)), "publish-reports.py"))
pubrep = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pubrep)
request, to_value, from_value = pubrep.request, pubrep.to_value, pubrep.from_value
mint_token, load_key, FS = pubrep.mint_token, pubrep.load_key, pubrep.FS

# Some Python builds (notably python.org on macOS) ship without a CA bundle.
try:
    import ssl, certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
    _orig = urllib.request.urlopen
    urllib.request.urlopen = lambda *a, **kw: _orig(*a, **{**kw, "context": _CTX})
except Exception:
    pass

CF_PROXY = "https://damp-bar-b442ok.r24rp9hgxh.workers.dev"
TV = "https://scanner.tradingview.com/symbol"
TROY = 31.1035
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}

PURITY       = {"24K": 1.0, "22K": 22 / 24, "18K": 18 / 24}
SILVER_PURITY = {"999": 1.0, "950": 0.950, "925": 0.925, "800": 0.800}


def get_json(url, tries=2):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.loads(r.read())
        except Exception:
            if i + 1 < tries:
                time.sleep(1.5)
    return None


def num(v, d=0.0):
    try:
        f = float(v)
        return f if f == f else d           # NaN guard
    except (TypeError, ValueError):
        return d


# ── price sources (same ones the app uses) ───────────────────────────────────

def mf_nav(code):
    d = get_json(f"https://api.mfapi.in/mf/{urllib.parse.quote(str(code))}")
    if not d or d.get("status") != "SUCCESS" or not d.get("data"):
        return None
    return num(d["data"][0].get("nav"), 0) or None


def stock_price(symbol, exchange):
    suffix = ".BO" if exchange == "BSE" else ".NS"
    yf = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
          f"{urllib.parse.quote(symbol)}{suffix}?interval=1d&range=1d")
    d = get_json(f"{CF_PROXY}?url={urllib.parse.quote(yf, safe='')}")
    p = (((d or {}).get("chart") or {}).get("result") or [{}])[0].get("meta", {}).get("regularMarketPrice")
    return num(p, 0) or None


def tv_close(symbol):
    d = get_json(f"{TV}?symbol={urllib.parse.quote(symbol)}&fields=close&no_404=1")
    return num((d or {}).get("close"), 0) or None


def yf_close(ticker):
    yf = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
          f"{urllib.parse.quote(ticker)}?interval=1d&range=5d")
    d = get_json(f"{CF_PROXY}?url={urllib.parse.quote(yf, safe='')}")
    p = (((d or {}).get("chart") or {}).get("result") or [{}])[0].get("meta", {}).get("regularMarketPrice")
    return num(p, 0) or None


def metal_rates(settings):
    """24K gold and 999 silver landed ₹/g — the app's ptLanded() calculation."""
    usd_inr = tv_close("FX_IDC:USDINR") or yf_close("USDINR=X")
    xau     = tv_close("OANDA:XAUUSD")  or yf_close("GC=F")
    xag     = tv_close("TVC:SILVER")    or yf_close("SI=F")
    if not usd_inr:
        return None, None

    duty  = (settings or {}).get("duty") or {}
    gston = (settings or {}).get("gstOn", True)

    def factor(mode):
        d = duty.get(mode) or {}
        customs = 1 + num(d.get("bcd"), 5) / 100 + num(d.get("aidc"), 1) / 100
        gst = (1 + num(d.get("gst"), 3) / 100) if gston else 1
        return customs * gst

    gold   = (xau * usd_inr / TROY) * factor("gold")   if xau else None
    silver = (xag * usd_inr / TROY) * factor("silver") if xag else None
    return gold, silver


# ── valuation — mirrors getPortfolioValues() in portfolio.js ─────────────────

def jewellery_value(j, gold_rate):
    val = 0.0
    g = j.get("gold")
    if g:
        w = num(g.get("weightGrams"))
        f = PURITY.get(g.get("purity"), 22 / 24)
        val += w * f * gold_rate if gold_rate else num(g.get("purchasePrice"))
    for part in ("diamonds", "stones"):
        d = j.get(part)
        if d:
            cur = d.get("currentOverride")
            val += num(cur if cur is not None else d.get("purchasePrice"))
    return val            # making charges never count towards current value


def compute(P, verbose=False):
    gold_rate, silver_rate = metal_rates(P.get("price_settings"))
    if verbose:
        print(f"  gold ₹{gold_rate:,.0f}/g · silver ₹{silver_rate:,.1f}/g"
              if gold_rate and silver_rate else "  metal rates unavailable")

    mf_total = 0.0
    navs = {}
    for h in P.get("mf_holdings", []):
        code = h.get("schemeCode")
        if code and code not in navs:
            navs[code] = mf_nav(code)
        nav = navs.get(code)
        mf_total += num(h.get("units")) * nav if nav else num(h.get("invested"))

    stocks_total = 0.0
    for s in P.get("stocks", []):
        px = stock_price(s.get("symbol", ""), s.get("exchange", "NSE"))
        qty, avg = num(s.get("quantity")), num(s.get("avgPrice"))
        stocks_total += qty * px if px else qty * avg
        time.sleep(0.15)                    # Yahoo rate-limits bursts

    gold_total = 0.0
    for g in P.get("gold", []):
        gold_total += (num(g.get("weightGrams")) * PURITY.get(g.get("purity"), 1) * gold_rate
                       if gold_rate else num(g.get("purchasePrice")))
    for j in P.get("jewellery", []):
        gold_total += jewellery_value(j, gold_rate)

    silver_total = 0.0
    for s in P.get("silver", []):
        silver_total += (num(s.get("weightGrams")) * SILVER_PURITY.get(s.get("purity"), 1) * silver_rate
                         if silver_rate else num(s.get("purchasePrice")))

    re_total = sum(num(r.get("currentValue")) or num(r.get("purchasePrice"))
                   for r in P.get("real_estate", []))
    epf = num((P.get("epf") or {}).get("currentBalance"))
    nps = num((P.get("nps") or {}).get("currentValue"))

    vals = {"mf": mf_total, "stocks": stocks_total, "gold": gold_total,
            "silver": silver_total, "real_estate": re_total, "epf": epf, "nps": nps}
    vals["total"] = sum(vals.values())
    # Never write a snapshot built on nothing — a total of 0 means every source
    # failed, and a zero point would put a false cliff in the chart.
    if vals["total"] <= 0:
        raise SystemExit("every price source failed — refusing to write a zero snapshot")
    return vals


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", help="dashboard doc id (defaults to $WEALTH_EMAIL)")
    ap.add_argument("--key", help="path to service-account JSON")
    ap.add_argument("--project", default="wealth-vishalparwani")
    ap.add_argument("--date", help="snapshot date YYYY-MM-DD (default: today)")
    ap.add_argument("--force", action="store_true", help="overwrite this month's snapshot")
    ap.add_argument("--dry-run", action="store_true", help="compute and print, write nothing")
    a = ap.parse_args()

    email = a.email or os.environ.get("WEALTH_EMAIL") or os.environ.get("CLAUDE_CODE_USER_EMAIL")
    if not email:
        raise SystemExit("Need --email (the dashboards/{email} doc id).")
    day = a.date or dt.date.today().isoformat()

    token = mint_token(load_key(a.key))
    doc_url = (f"{FS}/projects/{a.project}/databases/(default)/documents/"
               f"dashboards/{urllib.parse.quote(email)}")
    doc = request(doc_url, token=token)
    root = {k: from_value(v) for k, v in doc.get("fields", {}).items()}
    # Holdings live under a `portfolio` map; snapshots and price settings sit at
    # the top level of the same document.
    P = dict(root.get("portfolio") or {})
    P["price_settings"] = root.get("price_settings")

    snaps = [s for s in (root.get("snapshots") or []) if isinstance(s, dict) and s.get("date")]
    if any(s["date"][:7] == day[:7] for s in snaps) and not a.force:
        print(f"snapshot for {day[:7]} already saved — nothing to do")
        return

    print(f"valuing {email} as of {day}")
    v = compute(P, verbose=True)
    for k in ("mf", "stocks", "gold", "silver", "real_estate", "epf", "nps"):
        print(f"  {k:12s} ₹{v[k]:,.0f}")
    print(f"  {'TOTAL':12s} ₹{v['total']:,.0f}")

    if a.dry_run:
        print("\ndry run — nothing written")
        return

    snap = {"date": day, **{k: round(v[k]) for k in
                            ("mf", "stocks", "gold", "silver", "real_estate", "epf", "nps", "total")}}
    kept = [s for s in snaps if s["date"] != day and not (a.force and s["date"][:7] == day[:7])]
    kept.append(snap)
    kept.sort(key=lambda s: s["date"])
    kept = kept[-100:]

    payload = json.dumps({"fields": {"snapshots": {"arrayValue": {
        "values": [to_value(s) for s in kept]}}}}).encode()
    # updateMask: the dashboard document holds every holding — a maskless PATCH
    # would replace the lot with just this field.
    request(f"{doc_url}?updateMask.fieldPaths=snapshots",
            data=payload, token=token, method="PATCH")
    print(f"\nsnapshot saved for {day} ({len(kept)} total)")


if __name__ == "__main__":
    main()
