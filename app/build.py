#!/usr/bin/env python3
"""Build the offline BLS cards app.

Reads ../cards/cards.he-IL.json, checks it, and writes a ready-to-host app to dist/:
the cards are embedded in index.html so they are available with no network, and a
service worker caches the app after the first visit.

Usage:  python3 app/build.py
No third-party packages are needed. The card content is never modified.
"""
import datetime
import hashlib
import json
import pathlib
import shutil
import sys

APP = pathlib.Path(__file__).resolve().parent
PROJECT = APP.parent
CARDS_FILE = PROJECT / "cards" / "cards.he-IL.json"
CASES_FILE = PROJECT / "cases" / "cases.he-IL.json"  # optional, supplied by the organisation
SRC = APP / "src"
DIST = APP / "dist"

# Stable IDs that other parts of the app link to (see cards/README.md).
REQUIRED_IDS = ["newborn-resuscitation", "cpr-aed", "major-trauma", "anaphylaxis"]
KNOWN_STATUS = {"approved", "review_required"}


def check(data):
    errors, warnings = [], []
    cards = data.get("cards")
    if not isinstance(cards, list) or not cards:
        return ["'cards' must be a non-empty list"], warnings
    seen = set()
    for i, c in enumerate(cards):
        where = f"card #{i + 1} ({c.get('id', '?')})"
        for key in ("id", "title", "group", "sections", "editorial_status", "operational_status"):
            if key not in c:
                errors.append(f"{where}: missing '{key}'")
        cid = c.get("id")
        if cid in seen:
            errors.append(f"{where}: duplicate id")
        seen.add(cid)
        for key in ("editorial_status", "operational_status"):
            if key in c and c[key] not in KNOWN_STATUS:
                warnings.append(f"{where}: unknown {key} '{c[key]}' (shown as-is, never as verified)")
        for j, s in enumerate(c.get("sections") or []):
            if not isinstance(s.get("items"), list) or not all(isinstance(t, str) for t in s["items"]):
                errors.append(f"{where}: section {j + 1} items must be a list of strings")
            if not s.get("title"):
                errors.append(f"{where}: section {j + 1} has no title")
    for rid in REQUIRED_IDS:
        if rid not in seen:
            errors.append(f"required stable id missing: {rid}")
    return errors, warnings


def main():
    raw = CARDS_FILE.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    errors, warnings = check(data)
    for w in warnings:
        print("warning:", w)
    if errors:
        for e in errors:
            print("error:", e, file=sys.stderr)
        sys.exit(1)

    template = (SRC / "index.html").read_text(encoding="utf-8")
    sw = (SRC / "sw.js").read_text(encoding="utf-8")
    extract_js = (SRC / "extract.js").read_text(encoding="utf-8")
    if "</script" in extract_js.lower():
        sys.exit("error: extract.js must not contain '</script'")
    cases_raw = CASES_FILE.read_bytes() if CASES_FILE.exists() else b"null"
    cases = json.loads(cases_raw.decode("utf-8"))
    case_list = cases.get("cases", []) if isinstance(cases, dict) else (cases or [])
    for i, c in enumerate(case_list):
        if not isinstance(c, dict) or not c.get("id") or not c.get("title"):
            sys.exit(f"error: case #{i + 1} needs 'id' and 'title'")
    build_id = hashlib.sha256(raw + cases_raw + template.encode() + sw.encode() + extract_js.encode()).hexdigest()[:10]
    built = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")

    # Same data, same order; '<', '>' and '&' escaped so the JSON is safe inside <script>.
    embedded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    embedded = embedded.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    cases_embedded = json.dumps(cases, ensure_ascii=False, separators=(",", ":"))
    cases_embedded = cases_embedded.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")

    DIST.mkdir(exist_ok=True)
    (DIST / "icons").mkdir(exist_ok=True)
    html = (template.replace("__CARDS_JSON__", embedded)
            .replace("__CASES_JSON__", cases_embedded)
            .replace("/*__EXTRACT_JS__*/", extract_js)
            .replace("__BUILD_ID__", build_id)
            .replace("__BUILD_DATE__", built))
    (DIST / "index.html").write_text(html, encoding="utf-8")
    (DIST / "sw.js").write_text(sw.replace("__BUILD_ID__", build_id), encoding="utf-8")
    shutil.copyfile(SRC / "manifest.webmanifest", DIST / "manifest.webmanifest")
    shutil.copyfile(CARDS_FILE, DIST / "cards.he-IL.json")
    for icon in (SRC / "icons").glob("*.png"):
        shutil.copyfile(icon, DIST / "icons" / icon.name)

    statuses = {}
    for c in data["cards"]:
        statuses[c["operational_status"]] = statuses.get(c["operational_status"], 0) + 1
    print(f"built {DIST} · {len(data['cards'])} cards · {len(case_list)} cases · build {build_id} · operational: {statuses}")


if __name__ == "__main__":
    main()
