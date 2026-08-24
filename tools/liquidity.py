#!/usr/bin/env python3
"""Live price, 52-week range and 6-month traded liquidity for one symbol.

The Research tab computes the same figures live under its chart; this prints
them for the author, so the key-data grid in a report matches what the app will
show the day it is written.

    python3 tools/liquidity.py SANSERA          # NSE by default
    python3 tools/liquidity.py PPEL --bse
"""
import argparse, json, time, urllib.parse, urllib.request

try:
    import ssl, certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
    _orig = urllib.request.urlopen
    urllib.request.urlopen = lambda *a, **kw: _orig(*a, **{**kw, "context": _CTX})
except Exception:
    pass

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}
# Yahoo 429s most direct script calls; the app's own worker proxy gets through.
CF_PROXY = "https://damp-bar-b442ok.r24rp9hgxh.workers.dev"


def chart(symbol, rng="1y"):
    yf = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
          f"{urllib.parse.quote(symbol)}?interval=1d&range={rng}")
    for target in (f"{CF_PROXY}?url={urllib.parse.quote(yf, safe='')}", yf):
        try:
            with urllib.request.urlopen(urllib.request.Request(target, headers=UA), timeout=30) as r:
                j = json.loads(r.read())
            res = (j.get("chart") or {}).get("result") or []
            if res:
                return res[0]
        except Exception:
            time.sleep(1)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ticker")
    ap.add_argument("--bse", action="store_true")
    ap.add_argument("--symbol", help="explicit Yahoo symbol, overrides the ticker")
    a = ap.parse_args()

    syms = [a.symbol] if a.symbol else (
        [f"{a.ticker}.BO", f"{a.ticker}.NS"] if a.bse else [f"{a.ticker}.NS", f"{a.ticker}.BO"])
    res = None
    for s in syms:
        res = chart(s)
        if res and res.get("timestamp"):
            sym = s
            break
        res = None
    if not res:
        raise SystemExit(f"no Yahoo history for {syms}")

    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    pts = [(t, c, v) for t, c, v in zip(ts, q.get("close", []), q.get("volume", []))
           if isinstance(c, (int, float)) and c > 0]

    cutoff = time.time() - 183 * 86400
    win = [(t, c, v) for t, c, v in pts if t >= cutoff and isinstance(v, (int, float)) and v > 0]
    partial = len(win) < 100
    if len(win) < 10:
        win = [(t, c, v) for t, c, v in pts if isinstance(v, (int, float)) and v > 0]

    shares = sum(v for _, _, v in win) / len(win)
    turnover = sum(c * v for _, c, v in win) / len(win)
    closes = [c for _, c, _ in pts]
    meta = res.get("meta", {})
    # Yahoo's regularMarketPrice goes stale on some SME symbols while the daily
    # closes stay correct (AIMTRON quoted 545 against a 1,675 last close). Trust
    # the series when the two disagree by more than a quarter.
    last_close = closes[-1] if closes else None
    quote = meta.get("regularMarketPrice")
    price, price_src = quote, "quote"
    if not (isinstance(quote, (int, float)) and quote > 0):
        price, price_src = last_close, "last close"
    elif last_close and abs(quote / last_close - 1) > 0.25:
        price, price_src = last_close, "last close (quote %.2f rejected as stale)" % quote

    span = int((win[-1][0] - win[0][0]) / 86400)
    print(json.dumps({
        "symbol": sym,
        "price": price,
        "price_source": price_src,
        "52w_low": round(min(closes), 2),
        "52w_high": round(max(closes), 2),
        "sessions": len(win),
        "span_days": span,
        "partial_history": partial,
        "avg_daily_shares": round(shares),
        "avg_daily_shares_lakh": round(shares / 1e5, 2),
        "avg_daily_turnover_cr": round(turnover / 1e7, 2),
    }, indent=1))


if __name__ == "__main__":
    main()
