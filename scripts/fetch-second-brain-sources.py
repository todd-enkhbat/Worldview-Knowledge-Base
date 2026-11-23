#!/usr/bin/env python3
"""Download pinned research sources without installing or executing their software.

Run from any directory. Copies live under ignored data/research; the manifest and
per-file SHA-256 inventories make the exact material inspected reproducible.
Existing checkouts are recorded, never pulled, reset or overwritten.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "data/research/second-brains/2026-11-23"
REPOS = {
    "gbrain": ("garrytan/gbrain", "47512aa50fa2be1ab3af55bf60c242a11be76392"),
    "claude-mem": ("thedotmack/claude-mem", "29bc1cdf32aca60b3bfeec3b718d4ed6614b4f97"),
    "agent-second-brain": ("smixs/agent-second-brain", "7828ed62cf76aae87bee7f2660468ab88495cf3d"),
    "supermemory": ("supermemoryai/supermemory", "fa2af930dd78ba5504d7f35875d57f62084fdb5a"),
    "basic-memory": ("basicmachines-co/basic-memory", "506305b856967da1799f530502b6d9b7e6bd9610"),
    "qmd": ("tobi/qmd", "8be0c42395c02ff73bce6d6c2e67d7905b0a771c"),
    "obsidian-skills": ("obsidianmd/obsidian-skills", "b110b2f8e9eb1f287892f937050dfd40af862cbb"),
}
ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_LFS_SKIP_SMUDGE": "1"}


def git(*args, cwd=None):
    return subprocess.run(
        ["git", "-c", "core.hooksPath=/dev/null", *args], cwd=cwd, env=ENV,
        check=True, capture_output=True, timeout=600,
    ).stdout


def inventory(path):
    files = []
    for raw in git("ls-files", "-z", cwd=path).split(b"\0"):
        if not raw:
            continue
        name = os.fsdecode(raw)
        file = path / name
        if file.is_symlink():
            data = os.fsencode(os.readlink(file))
            kind = "symlink"
        elif file.is_file():
            data = file.read_bytes()
            kind = "file"
        else:
            files.append({"path": name, "kind": "unfetched-submodule-or-missing"})
            continue
        files.append({"path": name, "kind": kind, "bytes": len(data), "sha256": sha256(data).hexdigest()})
    return files


def download_repo(name, repository, pinned_commit):
    path = DEST / "sources" / name
    url = f"https://github.com/{repository}.git"
    if not path.exists():
        git("clone", "--depth", "1", "--no-tags", "--no-checkout", "--filter=blob:none", url, str(path))
        if git("rev-parse", "HEAD", cwd=path).decode().strip() != pinned_commit:
            git("fetch", "--depth", "1", "origin", pinned_commit, cwd=path)
        git("checkout", "--detach", pinned_commit, cwd=path)
    if git("remote", "get-url", "origin", cwd=path).decode().strip() != url:
        raise ValueError(f"Unexpected existing origin in {path}; left untouched")
    commit = git("rev-parse", "HEAD", cwd=path).decode().strip()
    if commit != pinned_commit:
        raise ValueError(f"Existing checkout differs from the research pin in {path}; left untouched")
    git("diff", "--quiet", "HEAD", "--", cwd=path)
    files = inventory(path)
    inv_path = DEST / "inventories" / f"{name}.json"
    inv_path.write_text(json.dumps(files, indent=2) + "\n")
    git("fsck", "--connectivity-only", "--no-reflogs", cwd=path)
    return {"name": name, "repository": repository, "url": url.removesuffix(".git"),
            "commit": commit, "path": str(path.relative_to(ROOT)),
            "files": len(files), "bytes": sum(item.get("bytes", 0) for item in files),
            "inventory": str(inv_path.relative_to(ROOT)),
            "inventorySha256": sha256(inv_path.read_bytes()).hexdigest(),
            "rootNotices": [item for item in files if "/" not in item["path"] and item["path"].lower().startswith(("license", "copying", "notice"))],
            "status": "downloaded", "gitConnectivityVerified": True}


def download_gist():
    gist_id = "442a6bf555914893e9891c11519de94f"
    revision = "ac46de1ad27f92b28ac95459c782c07f6b8c964a"
    url = f"https://gist.githubusercontent.com/karpathy/{gist_id}/raw/{revision}/llm-wiki.md"
    request = urllib.request.Request(url, headers={"User-Agent": "Worldview-Source-Research"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    path = DEST / "sources/llm-wiki"
    path.mkdir(exist_ok=True)
    file = path / "llm-wiki.md"
    if file.exists() and file.read_bytes() != data:
        raise ValueError("Existing gist differs; left untouched")
    file.write_bytes(data)
    return {"name": "llm-wiki", "url": f"https://gist.github.com/karpathy/{gist_id}",
            "rawUrl": url, "revision": revision, "path": str(path.relative_to(ROOT)),
            "files": 1, "bytes": len(data), "sha256": sha256(data).hexdigest(),
            "status": "downloaded", "license": "No license grant found in the gist; do not treat public visibility as permission to copy."}


def main():
    (DEST / "sources").mkdir(parents=True, exist_ok=True)
    (DEST / "inventories").mkdir(exist_ok=True)
    results = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = {pool.submit(download_repo, name, *pin): name for name, pin in REPOS.items()}
        jobs[pool.submit(download_gist)] = "llm-wiki"
        for job in as_completed(jobs):
            name = jobs[job]
            try:
                result = job.result()
            except Exception as error:
                result = {"name": name, "status": "failed", "error": str(error)}
            results.append(result)
            print(json.dumps(result), flush=True)
    manifest = {"schemaVersion": 1, "recordedAtUtc": datetime.now(timezone.utc).isoformat(),
                "execution": "Downloaded/read only; no dependency installation, application start, skills installation, or model download.",
                "scope": "Shallow source checkouts at explicit pinned commits; Git LFS payloads and submodules are not fetched.",
                "sources": sorted(results, key=lambda item: item["name"])}
    (DEST / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    raise SystemExit(int(any(item["status"] != "downloaded" for item in results)))


if __name__ == "__main__":
    main()
