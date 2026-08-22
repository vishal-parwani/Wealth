#!/usr/bin/env python3
"""One-time backfill of the tracking baseline on existing research reports.

The Research tab measures a name's move from the day it was first added to the
dashboard, not from the day its report was written. Reports imported before
that existed carry no such date — but Firestore stamps every document with a
`createTime` that survives later overwrites, so the first-added date can be
recovered rather than guessed.

For each report missing the fields, this writes:
  trackedFrom  — the document's Firestore createTime
  trackPrice   — the closing price on that date (Yahoo daily history, first
                 session on or after trackedFrom); falls back to the report's
                 own gen price when history doesn't reach back that far.

Idempotent: a report that already has both fields is left alone (--force
re-derives them). Credentials resolve exactly as in publish-reports.py.

    python3 tools/backfill-tracking.py --dry-run --email you@example.com
    python3 tools/backfill-tracking.py --email you@example.com
"""
import argparse, json, os, sys, time, urllib.parse, urllib.request, datetime as dt

# publish-reports.py has a hyphen in its name, so it is imported by path
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "pubrep", os.path.join(os.path.dirname(os.path.abspath(__file__)), "publish-reports.py"))
pubrep = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pubrep)

request, to_value, from_value = pubrep.request, pubrep.to_value, pubrep.from_value
mint_token, load_key, FS = pubrep.mint_token, pubrep.load_key, pubrep.FS

# This Mac's python.org build ships without a CA bundle, so urllib fails its TLS
# handshake unless pointed at certifi's. Harmless where the system store works.
try:
    import ssl, certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
    _orig_urlopen = urllib.request.urlopen
    urllib.request.urlopen = lambda *a, **kw: _orig_urlopen(*a, **{**kw, "context": _SSL})
except Exception:
    pass

YF = "https://query1.finance.yahoo.com/v8/finance/chart/"
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}


# Yahoo answers 429 to most direct calls from a script; the app's own Cloudflare
# worker proxies them successfully, so reuse it and fall back to direct.
CF_PROXY = "https://damp-bar-b442ok.r24rp9hgxh.workers.dev"


def yahoo_closes(symbol, start_ts):
    """Daily closes from `start_ts` (unix) to now: [(unix, close)] or []."""
    url = (f"{YF}{urllib.parse.quote(symbol)}"
           f"?interval=1d&period1={int(start_ts)}&period2={int(time.time())}")
    j = None
    for target in (f"{CF_PROXY}?url={urllib.parse.quote(url, safe='')}", url):
        try:
            req = urllib.request.Request(target, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.loads(r.read())
            break
        except Exception:
            continue
    if j is None:
        return []
    res = (j.get("chart") or {}).get("result") or []
    if not res:
        return []
    ts = res[0].get("timestamp") or []
    cl = ((res[0].get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    # `> 0`, not just "not None" — Yahoo intermittently returns a zero close
    return [(t, c) for t, c in zip(ts, cl) if isinstance(c, (int, float)) and c > 0]


def nav_on(scheme, day):
    """AMFI NAV on/after `day` (a date) for a fund scheme code, or None."""
    try:
        with urllib.request.urlopen(
                f"https://api.mfapi.in/mf/{urllib.parse.quote(str(scheme))}", timeout=30) as r:
            data = json.loads(r.read()).get("data") or []
    except Exception:
        return None
    best = None
    for row in data:                       # newest first, DD-MM-YYYY
        try:
            d = dt.datetime.strptime(row["date"], "%d-%m-%Y").date()
            v = float(row["nav"])
        except Exception:
            continue
        if v > 0 and d >= day and (best is None or d < best[0]):
            best = (d, v)
    return best[1] if best else None


def price_on(rec, day):
    """Closing price/NAV on the first session on or after `day`."""
    if rec.get("type") == "fund":
        return nav_on(rec.get("scheme"), day) if rec.get("scheme") else None
    ov = rec.get("priceOverride") or {}
    ticker, exch = rec.get("ticker", ""), rec.get("exchange", "NSE")
    syms = [ov["symbol"]] if ov.get("symbol") else (
        [f"{ticker}.BO", f"{ticker}.NS"] if exch == "BSE" else [f"{ticker}.NS", f"{ticker}.BO"])
    start = int(dt.datetime.combine(day, dt.time()).timestamp()) - 5 * 86400
    for sym in syms:
        pts = yahoo_closes(sym, start)
        for t, c in pts:
            if dt.date.fromtimestamp(t) >= day:
                return c
        time.sleep(0.4)          # Yahoo 429s under load
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", help="dashboard doc id (defaults to $CLAUDE_CODE_USER_EMAIL)")
    ap.add_argument("--key", help="path to service-account JSON")
    ap.add_argument("--project", default="wealth-vishalparwani")
    ap.add_argument("--force", action="store_true", help="re-derive even if already set")
    ap.add_argument("--dry-run", action="store_true", help="show what would change")
    a = ap.parse_args()

    email = a.email or os.environ.get("CLAUDE_CODE_USER_EMAIL")
    if not email:
        raise SystemExit("Need --email (the dashboards/{email} doc id).")

    token = mint_token(load_key(a.key))
    base = f"{FS}/projects/{a.project}/databases/(default)/documents"
    coll = f"{base}/dashboards/{urllib.parse.quote(email)}/reports"

    docs, page = [], None
    while True:
        url = coll + "?pageSize=100" + (f"&pageToken={page}" if page else "")
        j = request(url, token=token)
        docs += j.get("documents", [])
        page = j.get("nextPageToken")
        if not page:
            break
    print(f"{len(docs)} report(s) in Firestore\n")

    changed = skipped = 0
    for d in sorted(docs, key=lambda x: x["name"]):
        did = d["name"].rsplit("/", 1)[-1]
        f = d.get("fields", {})
        rec = {k: from_value(v) for k, v in f.items() if k != "html"}
        has = rec.get("trackedFrom") and rec.get("trackPrice")
        if has and not a.force:
            skipped += 1
            continue

        created = d.get("createTime")          # survives later overwrites
        if not created:
            print(f"  {did:14s} no createTime — skipped")
            skipped += 1
            continue
        day = dt.datetime.strptime(created[:10], "%Y-%m-%d").date()
        px = price_on(rec, day)
        src = "market"
        if px is None:
            px = rec.get("genPrice")
            src = "gen price (no history that far back)"
        print(f"  {did:14s} tracked from {day}  ₹{px:,.2f}  · {src}")

        if not a.dry_run:
            payload = json.dumps({"fields": {
                "trackedFrom": to_value(created),
                "trackPrice":  to_value(float(px)),
            }}).encode()
            # updateMask so only these two fields are touched — a maskless PATCH
            # would wipe the report HTML and everything else on the document.
            mask = "updateMask.fieldPaths=trackedFrom&updateMask.fieldPaths=trackPrice"
            request(f"{coll}/{did}?{mask}", data=payload, token=token, method="PATCH")
        changed += 1

    verb = "would update" if a.dry_run else "updated"
    print(f"\n{verb} {changed}, left alone {skipped}")


if __name__ == "__main__":
    main()
