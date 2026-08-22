#!/usr/bin/env python3
"""Emit the template-v2 <head> (styles included) with this report's meta filled.

Keeps every report on one stylesheet: change _TEMPLATE-v2.html and the next
refresh picks it up, rather than 40 divergent copies of the same CSS.

    python3 tools/v2-head.py --ticker CRAFTSMAN --name "Craftsman Automation Limited" \
        --sector "Auto Ancillary / Precision Components" --rating Hold \
        --price 10644 --date 2026-08-23 [--exchange NSE] [--risk high] [--gaps]
"""
import argparse, os

TPL = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "Stock Reports", "_TEMPLATE-v2.html")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticker", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--sector", required=True)
    ap.add_argument("--rating", required=True, choices=["Buy", "Hold", "Sell"])
    ap.add_argument("--price", required=True)
    ap.add_argument("--date", required=True)
    ap.add_argument("--exchange", default="NSE")
    ap.add_argument("--risk", choices=["high"], help="omit for ordinary risk")
    ap.add_argument("--gaps", action="store_true", help="report has unverified figures")
    a = ap.parse_args()

    head = open(TPL, encoding="utf-8").read()
    head = head[: head.index("<body>")]
    subs = [
        ("<title>COMPANY NAME (NSE: TICKER) | Stock Research</title>",
         f"<title>{a.name} ({a.exchange}: {a.ticker}) | Stock Research</title>"),
        ('<meta name="ticker"    content="TICKER">',
         f'<meta name="ticker"    content="{a.ticker}">'),
        ('<meta name="exchange"  content="NSE">',
         f'<meta name="exchange"  content="{a.exchange}">'),
        ('<meta name="name"      content="Company Name Limited">',
         f'<meta name="name"      content="{a.name}">'),
        ('<meta name="sector"    content="Sector / Sub-sector">',
         f'<meta name="sector"    content="{a.sector}">'),
        ('<meta name="rating"    content="Hold">',
         f'<meta name="rating"    content="{a.rating}">'),
        ('<meta name="generated" content="2026-08-17">',
         f'<meta name="generated" content="{a.date}">'),
        ('<meta name="price"     content="0.00">',
         f'<meta name="price"     content="{a.price}">'),
        ('<meta name="hasgaps"   content="true">',
         f'<meta name="hasgaps"   content="{"true" if a.gaps else "false"}">'),
    ]
    for old, new in subs:
        assert old in head, f"template no longer contains: {old}"
        head = head.replace(old, new, 1)
    # risk is its own axis — the tag is present only when it is high
    head = head.replace('<meta name="risk"      content="high">\n',
                        '<meta name="risk"      content="high">\n' if a.risk else "")
    print(head, end="")


if __name__ == "__main__":
    main()
