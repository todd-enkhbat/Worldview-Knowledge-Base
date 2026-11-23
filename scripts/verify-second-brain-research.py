#!/usr/bin/env python3
"""Verify downloaded bytes, inert reuse copies and pinned source links, without imports from upstream."""
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/research/second-brains/2026-11-23"
DOCS = ROOT / "docs/research/second-brains/2026-11-23"


def main():
    manifest = json.loads((DATA / "manifest.json").read_text())
    errors, checked = [], []
    pins = {}
    for source in manifest["sources"]:
        if source["status"] != "downloaded":
            errors.append(f"Not downloaded: {source['name']}")
            continue
        path = ROOT / source["path"]
        if source["name"] == "llm-wiki":
            if sha256((path / "llm-wiki.md").read_bytes()).hexdigest() != source["sha256"]:
                errors.append("Changed gist bytes")
            checked.append({"name": source["name"], "files": 1, "bytes": source["bytes"]})
            continue
        head = subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
        if head != source["commit"]:
            errors.append(f"Changed HEAD: {source['name']}")
        pins[(source["repository"], source["commit"])] = path
        inv_file = ROOT / source["inventory"]
        if sha256(inv_file.read_bytes()).hexdigest() != source["inventorySha256"]:
            errors.append(f"Changed inventory: {source['name']}")
        inventory = json.loads(inv_file.read_text())
        size = 0
        for item in inventory:
            file = path / item["path"]
            if item["kind"] == "unfetched-submodule-or-missing":
                continue
            data = os.fsencode(os.readlink(file)) if item["kind"] == "symlink" else file.read_bytes()
            size += len(data)
            if len(data) != item["bytes"] or sha256(data).hexdigest() != item["sha256"]:
                errors.append(f"Changed source bytes: {source['name']}/{item['path']}")
        if len(inventory) != source["files"] or size != source["bytes"]:
            errors.append(f"Changed source totals: {source['name']}")
        checked.append({"name": source["name"], "files": len(inventory), "bytes": size})
    kit = DOCS / "reuse-kit"
    kit_entries = json.loads((kit / "manifest.json").read_text())["files"]
    for item in kit_entries:
        data = (kit / item["kitPath"]).read_bytes()
        original = (DATA / "sources" / item["project"] / item["upstreamPath"]).read_bytes()
        if data != original or sha256(data).hexdigest() != item["sha256"]:
            errors.append(f"Changed reuse reference: {item['kitPath']}")
    checked_urls = set()
    for report in DOCS.glob("*.md"):
        for url in re.findall(r"https://github\.com/[^\s)<>]+", report.read_text()):
            parsed = urlparse(url)
            parts = unquote(parsed.path).strip("/").split("/")
            if len(parts) < 4 or parts[2] not in ("blob", "tree") or not re.fullmatch(r"[a-f0-9]{40}", parts[3]):
                continue
            key = ("/".join(parts[:2]), parts[3])
            if key not in pins:
                errors.append(f"Unpinned source link in {report.name}: {url}")
                continue
            file = pins[key].joinpath(*parts[4:])
            if not file.exists():
                errors.append(f"Missing source target in {report.name}: {url}")
            line = re.fullmatch(r"L(\d+)(?:-L\d+)?", parsed.fragment)
            if line and file.is_file() and int(line[1]) > len(file.read_text().splitlines()):
                errors.append(f"Out-of-range source line in {report.name}: {url}")
            checked_urls.add(url)
    if json.loads((DOCS / "source-manifest.json").read_text()) != manifest:
        errors.append("Portable manifest differs from local download manifest")
    result = {"verifiedAtUtc": datetime.now(timezone.utc).isoformat(), "scope": "Source integrity and reference targets, not upstream runtime tests or model-quality evaluation.",
              "projects": checked, "projectCount": len(checked), "sourceFiles": sum(s["files"] for s in checked),
              "sourceBytes": sum(s["bytes"] for s in checked), "reuseFiles": len(kit_entries),
              "pinnedCodeLinks": len(checked_urls), "errors": errors, "passed": not errors}
    (DOCS / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    raise SystemExit(int(bool(errors)))


if __name__ == "__main__":
    main()
