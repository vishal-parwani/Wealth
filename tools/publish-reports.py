#!/usr/bin/env python3
"""Publish authored stock/fund reports to Firestore.

Committing a report to this repo does NOT make it appear in the app — the app
reads reports from Firestore at dashboards/{email}/reports/{ticker}. This script
does that upload.

Credentials (never in this repo). Resolution order, matching CLAUDE.md:
  1. --key <path>
  2. $WEALTH_SA_KEY            — raw JSON of the service-account key
  3. $WEALTH_SA_KEY_FILE       — path to the key file
  4. /sessions/*/mnt/AI Oversight/Automations/wealth-service-account.json

Usage:
    python3 tools/publish-reports.py --dry-run "Stock Reports"/stock-*.html
    python3 tools/publish-reports.py --email you@example.com "Stock Reports"/stock-zentec-*.html

--dry-run parses and reports what would be written and needs no credentials.

Existing personalNote and priceOverride are read back and preserved, exactly as
srImportReport() does in the app — a blind overwrite would destroy notes the
owner typed in the UI.
"""
import argparse, glob, html as htmllib, json, os, re, sys, time, urllib.request, urllib.parse

TOKEN_URL = "https://oauth2.googleapis.com/token"
FS = "https://firestore.googleapis.com/v1"
SCOPE = "https://www.googleapis.com/auth/datastore"


# ── report parsing ───────────────────────────────────────────────────────────

META = re.compile(r'<meta\s+name="([\w-]+)"\s+content="([^"]*)"', re.I)

def parse_report(path):
    src = open(path, encoding="utf-8").read()
    meta = {k.lower(): htmllib.unescape(v) for k, v in META.findall(src)}
    for req in ("ticker", "name", "generated", "price"):
        if not meta.get(req):
            raise ValueError(f"{os.path.basename(path)}: missing <meta name=\"{req}\">")
    rating = meta.get("rating", "")
    if rating not in ("Buy", "Hold", "Sell"):
        raise ValueError(f"{os.path.basename(path)}: rating must be Buy/Hold/Sell, got {rating!r}")

    rec = {
        "type":        meta.get("type", "stock"),
        "ticker":      meta["ticker"],
        "exchange":    meta.get("exchange", "NSE"),
        "name":        meta["name"],
        "sector":      meta.get("sector", ""),
        "rating":      rating,
        "generatedAt": meta["generated"],
        "genPrice":    float(meta["price"]),
        "hasGaps":     meta.get("hasgaps", "").lower() == "true",
        "html":        src,
    }
    if meta.get("risk"):
        rec["risk"] = meta["risk"]
    if meta.get("scheme"):
        rec["scheme"] = meta["scheme"]
    return meta["ticker"].lower(), rec


# ── Firestore REST plumbing ──────────────────────────────────────────────────

def to_value(v):
    if isinstance(v, bool):  return {"booleanValue": v}
    if isinstance(v, (int, float)): return {"doubleValue": float(v)}
    if v is None:            return {"nullValue": None}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: to_value(x) for k, x in v.items()}}}
    return {"stringValue": str(v)}

def from_value(v):
    if "stringValue"  in v: return v["stringValue"]
    if "booleanValue" in v: return v["booleanValue"]
    if "doubleValue"  in v: return v["doubleValue"]
    if "integerValue" in v: return int(v["integerValue"])
    if "nullValue"    in v: return None
    if "mapValue"     in v:
        return {k: from_value(x) for k, x in v["mapValue"].get("fields", {}).items()}
    return None

def request(url, data=None, token=None, method=None):
    req = urllib.request.Request(url, data=data, method=method)
    if token: req.add_header("Authorization", "Bearer " + token)
    if data:  req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        raise SystemExit(f"HTTP {e.code} from {urllib.parse.urlparse(url).path}\n{body}")


def mint_token(key):
    """Self-signed JWT -> OAuth access token (jwt-bearer grant)."""
    import base64
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=")

    now = int(time.time())
    claims = {"iss": key["client_email"], "scope": SCOPE, "aud": TOKEN_URL,
              "iat": now, "exp": now + 3600}
    signing_input = (b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode()) + b"." +
                     b64(json.dumps(claims).encode()))
    pk = serialization.load_pem_private_key(key["private_key"].encode(), password=None)
    assertion = signing_input + b"." + b64(
        pk.sign(signing_input, padding.PKCS1v15(), hashes.SHA256()))

    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion.decode()}).encode()
    return request(TOKEN_URL, data=body)["access_token"]


def load_key(explicit):
    if explicit:
        return json.load(open(explicit))
    if os.environ.get("WEALTH_SA_KEY"):
        return json.loads(os.environ["WEALTH_SA_KEY"])
    if os.environ.get("WEALTH_SA_KEY_FILE"):
        return json.load(open(os.environ["WEALTH_SA_KEY_FILE"]))
    for p in glob.glob("/sessions/*/mnt/AI Oversight/Automations/wealth-service-account.json"):
        return json.load(open(p))
    raise SystemExit(
        "No service-account key found.\n"
        "  Provide one with --key <path>, or set WEALTH_SA_KEY (raw JSON) /\n"
        "  WEALTH_SA_KEY_FILE (path). The key is never stored in this repo.")


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--email", help="dashboard doc id (defaults to $CLAUDE_CODE_USER_EMAIL)")
    ap.add_argument("--key", help="path to service-account JSON")
    ap.add_argument("--project", default="wealth-vishalparwani")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse and report only; no credentials needed")
    a = ap.parse_args()

    paths = [p for pat in a.files for p in sorted(glob.glob(pat))] or a.files
    parsed = []
    for p in paths:
        tk, rec = parse_report(p)
        parsed.append((p, tk, rec))
        stale = "" if not rec["hasGaps"] else "  [hasGaps]"
        print(f"  {tk:12s} {rec['rating']:5s} ₹{rec['genPrice']:<10.2f} "
              f"{rec['generatedAt']}  {len(rec['html'])//1024}KB{stale}")

    ids = [t for _, t, _ in parsed]
    dupes = {t for t in ids if ids.count(t) > 1}
    if dupes:
        raise SystemExit(f"Duplicate doc ids in this batch: {sorted(dupes)} — "
                         "they would overwrite each other.")

    if a.dry_run:
        print(f"\ndry run — {len(parsed)} report(s) parsed, nothing written.")
        return

    email = a.email or os.environ.get("CLAUDE_CODE_USER_EMAIL")
    if not email:
        raise SystemExit("Need --email (the dashboards/{email} doc id).")

    token = mint_token(load_key(a.key))
    base = f"{FS}/projects/{a.project}/databases/(default)/documents"
    coll = f"{base}/dashboards/{urllib.parse.quote(email)}/reports"

    for _, tk, rec in parsed:
        url = f"{coll}/{tk}"
        # Preserve owner-entered fields, exactly as srImportReport does.
        keep = {"personalNote": "", "priceOverride": None}
        try:
            cur = request(url, token=token)
            for k in keep:
                if k in cur.get("fields", {}):
                    keep[k] = from_value(cur["fields"][k])
            existed = True
        except SystemExit:
            existed = False

        doc = {**rec, **keep, "importedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        payload = json.dumps({"fields": {k: to_value(v) for k, v in doc.items()}}).encode()
        request(url, data=payload, token=token, method="PATCH")
        note = "replaced" if existed else "created"
        if existed and keep["personalNote"]:
            note += ", note preserved"
        print(f"  {tk:12s} {note}")

    print(f"\npublished {len(parsed)} report(s) to dashboards/{email}/reports")


if __name__ == "__main__":
    main()
