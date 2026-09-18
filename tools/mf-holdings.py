#!/usr/bin/env python3
"""Monthly mutual-fund holdings of one stock, from Trendlyne's disclosure page.

Prints pipe lines in exactly the shape tools/fundtable.py reads on stdin, plus a
summary comment (scheme count, shares, buyers/sellers, net change). Pipe the
lines straight into fundtable to get the report's two HTML blocks:

    python3 tools/mf-holdings.py CRAFTSMAN --month Aug-2026 \\
      | python3 tools/fundtable.py --price 10644 --month "Aug 2026"

Index and arbitrage funds are included (the page's "hide" toggle is client-side).
A scheme whose previous-month holding was zero is marked "new". "No MF holdings"
is a real result for small caps and is reported as such, not as an error.
"""
import argparse, html, json, re, subprocess, sys

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")


def get(url):
    # curl rather than urllib: the python.org build on macOS has no CA bundle.
    return subprocess.run(["curl", "-sS", "-A", UA, "--max-time", "30", url],
                          capture_output=True, text=True).stdout


def cells(row):
    return [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", c))).strip()
            for c in re.findall(r"<t[hd].*?</t[hd]>", row, re.S)]


def num(s):
    s = (s or "").replace(",", "").replace("%", "").strip()
    try:
        return float(s)
    except ValueError:
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("symbol", help="NSE symbol, or BSE code for BSE-only names")
    ap.add_argument("--month", default="latest", help="e.g. Aug-2026 (default: latest)")
    a = ap.parse_args()

    hits = json.loads(get("https://trendlyne.com/equity/api/ac_snames/stock/?term=" + a.symbol) or "[]")
    hit = next((h for h in hits if h.get("value", "").upper() == a.symbol.upper()), hits[0] if hits else None)
    if not hit:
        sys.exit(f"{a.symbol}: not found on Trendlyne")
    parts = hit["pageurl"].rstrip("/").split("/")
    url = (f"https://trendlyne.com/equity/monthly-mutual-fund-share-holding/"
           f"{hit['k']}/{parts[-2]}/{a.month}/{parts[-1]}/")
    page = get(url)

    print(f"# {hit['label']}\n# {url}")
    tables = re.findall(r"<table.*?</table>", page, re.S)
    if not tables:
        print("# NO MF HOLDINGS" if "No MF holdings" in page else "# no table found — check the URL")
        return

    rows = re.findall(r"<tr.*?</tr>", tables[0], re.S)
    months = cells(rows[0])[1:]
    print(f"# columns: {months}")
    out, buyers, sellers, net, total = [], 0, 0, 0.0, 0.0
    for r in rows[2:]:
        c = cells(r)
        if len(c) < 7 or c[0].lower().startswith("total"):
            continue
        name, value_cr, pct, shares, chg = c[0], c[1], c[2], num(c[3]), num(c[4])
        prev = num(c[6])
        if shares > 0 and prev == 0 and chg > 0:
            chg_s = "new"
        else:
            chg_s = f"{chg:+.0f}" if chg else "0"
        buyers += chg > 0
        sellers += chg < 0
        net += chg
        total += shares
        out.append(f"{name} | {shares:.0f} | {pct} | {chg_s} | value_cr={value_cr}")

    held = sum(1 for o in out if num(o.split("|")[1]) > 0)
    print(f"# {held} schemes holding, {total:,.0f} shares; {buyers} bought, {sellers} sold, net {net:+,.0f}")
    for o in out:
        print(o)


if __name__ == "__main__":
    main()
