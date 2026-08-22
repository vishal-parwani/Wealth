#!/usr/bin/env python3
"""Turn a pasted fund-holdings table into the two blocks a v2 report needs.

Input on stdin: one scheme per line, pipe-separated, as copied from the
disclosure source —

    Scheme name | shares | % of scheme | change

Change may be a signed number, "0"/"unch", "new", or "-" . Rows with no share
count are treated as exits and listed last. Ranking is by value held, which for
a single stock is the same as ranking by share count — a big fund with a token
position says less than a mid-size fund with conviction.

    python3 tools/fundtable.py --price 10644.5 --month "Jul 2026" < holdings.txt
"""
import argparse, re, sys


def num(s):
    s = (s or "").strip().replace(",", "")
    if s in ("", "-", "—", "0"):
        return 0.0
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else 0.0


def inr(n):
    """Indian digit grouping: 61,91,556."""
    s = f"{int(round(n)):d}"
    if len(s) <= 3:
        return s
    head, tail = s[:-3], s[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts) + "," + tail


def chg_cell(raw):
    t = (raw or "").strip()
    if t.lower() in ("", "-", "—", "0", "unch", "no change"):
        return "<td>unch</td>"
    if t.lower() == "new":
        return '<td class="up">new</td>'
    v = num(t)
    if v > 0:
        return f'<td class="up">+{inr(v)}</td>'
    if v < 0:
        return f'<td class="dn">−{inr(abs(v))}</td>'
    return "<td>unch</td>"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--price", type=float, required=True, help="price per share, for value held")
    ap.add_argument("--month", default="", help="disclosure month, e.g. 'Jul 2026'")
    ap.add_argument("--top", type=int, default=5)
    a = ap.parse_args()

    rows, exits = [], []
    for line in sys.stdin:
        line = line.strip().strip("|")
        if not line or line.lower().startswith(("scheme", "---", "total", "**total")):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 2:
            continue
        name = re.sub(r"\*+", "", parts[0]).strip()
        shares = num(parts[1])
        pct = parts[2].strip() if len(parts) > 2 else ""
        chg = parts[3] if len(parts) > 3 else ""
        (rows if shares > 0 else exits).append({"name": name, "shares": shares, "pct": pct, "chg": chg})

    rows.sort(key=lambda r: -r["shares"])
    total = sum(r["shares"] for r in rows)

    print(f"<!-- {len(rows)} schemes, {inr(total)} shares, "
          f"₹{total * a.price / 1e7:,.0f} cr at ₹{a.price:,.0f} · {a.month} -->\n")

    print("=== TOP %d ===" % a.top)
    for r in rows[:a.top]:
        val = r["shares"] * a.price / 1e7
        p = num(r["pct"])
        aum = inr(val / (p / 100)) if p else "n/a"
        print(f'      <tr><th>{r["name"]}</th><td>CATEGORY</td><td>{inr(r["shares"])}</td>'
              f'<td>{inr(val)}</td><td>{r["pct"]}</td><td>{aum}</td>{chg_cell(r["chg"])}</tr>')

    print("\n=== FULL LIST ===")
    for r in rows:
        print(f'        <tr><th>{r["name"]}</th><td>{inr(r["shares"])}</td>'
              f'<td>{r["pct"]}</td>{chg_cell(r["chg"])}</tr>')
    for r in exits:
        print(f'        <tr><th>{r["name"]}</th><td>exited</td><td>—</td>{chg_cell(r["chg"])}</tr>')


if __name__ == "__main__":
    main()
