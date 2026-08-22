#!/usr/bin/env python3
"""Everything template v2 needs about one company, in one call.

Combines the Screener tables (financials, balance sheet with cash split out,
five-quarter shareholding), the Yahoo liquidity figures, and the derived ratios
the key-data grid carries — so authoring a report is a research job, not a
fetching job. Broker targets, fund holdings and news still have to be searched.

    python3 tools/report-pack.py CRAFTSMAN
    python3 tools/report-pack.py PPEL --bse --standalone
    python3 tools/report-pack.py SANSERA --peers BHARATFORG,ENDURANCE
"""
import argparse, importlib.util, io, json, os, re, subprocess, sys, contextlib

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"),
                                                  os.path.join(HERE, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run(mod, argv):
    """Call a sibling tool's main() and capture its JSON."""
    buf = io.StringIO()
    old = sys.argv
    sys.argv = ["x"] + argv
    try:
        with contextlib.redirect_stdout(buf):
            mod.main()
    finally:
        sys.argv = old
    return json.loads(buf.getvalue())


def money(s):
    """'₹ 24,193 Cr.' → 24193.0 ; '64.9' → 64.9 ; '-20' → -20.0 ; '' → None.
    Indian digit grouping means commas must be stripped before parsing, not
    treated as separators between two numbers."""
    if s in ("", None):
        return None
    t = str(s).replace(",", "").replace("\u2212", "-")     # minus sign, not hyphen
    m = re.search(r"-?\d+(?:\.\d+)?", t)
    return float(m.group(0)) if m else None


def last(row):
    for v in reversed(row or []):
        if v not in ("", None):
            return v
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ticker")
    ap.add_argument("--bse", action="store_true", help="BSE-listed (Yahoo .BO first)")
    ap.add_argument("--standalone", action="store_true", help="no meaningful consolidation")
    ap.add_argument("--symbol", help="explicit Yahoo symbol")
    ap.add_argument("--screener", help="Screener symbol, if it differs from the ticker")
    ap.add_argument("--peers", help="comma-separated peer symbols to fetch key ratios for")
    a = ap.parse_args()

    sf, lq = load("screener-fetch"), load("liquidity")

    sargv = [a.screener or a.ticker] + (["--standalone"] if a.standalone else [])
    s = run(sf, sargv)

    largv = [a.ticker] + (["--bse"] if a.bse else []) + (["--symbol", a.symbol] if a.symbol else [])
    try:
        liq = run(lq, largv)
    except SystemExit as e:
        liq = {"error": str(e)}

    k = s.get("keydata", {})
    price = liq.get("price") or money(k.get("Current Price"))
    bv = money(k.get("Book Value"))
    bs = s.get("balance_sheet", {}).get("rows", {})
    borrow = money(last(bs.get("Borrowings")))
    cash = money(last(list(s.get("cash_equivalents", {}).values()))) if s.get("cash_equivalents") else None
    equity = (money(last(bs.get("Equity Capital"))) or 0) + (money(last(bs.get("Reserves"))) or 0)

    derived = {
        "price": price,
        "p_bv": round(price / bv, 2) if price and bv else None,
        "net_debt_cr": round(borrow - cash, 0) if borrow is not None and cash is not None else None,
        "gross_debt_cr": borrow,
        "cash_cr": cash,
        "debt_equity": round(borrow / equity, 2) if borrow is not None and equity else None,
        "equity_cr": equity or None,
    }

    out = {"screener": s, "liquidity": liq, "derived": derived}

    if a.peers:
        peers = {}
        for p in [x.strip() for x in a.peers.split(",") if x.strip()]:
            try:
                d = run(sf, [p])
                pk = d.get("keydata", {})
                q = d.get("quarters", {}).get("rows", {})
                peers[p] = {"market_cap": pk.get("Market Cap"), "price": pk.get("Current Price"),
                            "pe": pk.get("Stock P/E"), "book_value": pk.get("Book Value"),
                            "roce": pk.get("ROCE"), "roe": pk.get("ROE"),
                            "div_yield": pk.get("Dividend Yield"),
                            "latest_opm": last(q.get("OPM %")), "latest_sales": last(q.get("Sales"))}
            except Exception as e:
                peers[p] = {"error": str(e)}
        out["peers"] = peers

    json.dump(out, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
