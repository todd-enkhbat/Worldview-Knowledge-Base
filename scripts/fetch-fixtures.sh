#!/usr/bin/env bash
# Downloads the CC-BY-4.0 splat fixtures used by the S1 spike, the Phase 2 ingest
# checks and the demo seed. Files land in public/fixtures/ (gitignored).
# URLs are pinned to commits; attribution is in docs/CREDITS.md.
set -euo pipefail

THREE_SHA=286e2d8cba7088982eb9068d4bb8f68e42c3bf67
PC_SHA=fef38e4f622cfbce91b8dee177fe35deb91f55a2
THREE="https://raw.githubusercontent.com/mrdoob/three.js/${THREE_SHA}/examples/models/spz"
PC="https://raw.githubusercontent.com/playcanvas/engine/${PC_SHA}/examples/assets/splats"

DEST="$(cd "$(dirname "$0")/.." && pwd)/public/fixtures"
mkdir -p "$DEST"

fetch() {
  local url="$1" name="$2" size="$3"
  if [[ -f "$DEST/$name" && "$(wc -c <"$DEST/$name" | tr -d ' ')" == "$size" ]]; then
    echo "ok    $name (cached)"
    return
  fi
  echo "fetch $name"
  curl -fL --retry 3 -o "$DEST/$name.part" "$url"
  local got
  got="$(wc -c <"$DEST/$name.part" | tr -d ' ')"
  if [[ "$got" != "$size" ]]; then
    echo "size mismatch for $name: expected $size, got $got" >&2
    rm -f "$DEST/$name.part"
    exit 1
  fi
  mv "$DEST/$name.part" "$DEST/$name"
}

fetch "$THREE/lion.v3.spz" lion.v3.spz 4303196
fetch "$THREE/lion.license.txt" lion.license.txt 283
fetch "$THREE/tomatoes.v4.spz" tomatoes.v4.spz 9360535
fetch "$THREE/tomatoes.license.txt" tomatoes.license.txt 319
fetch "$PC/apartment.sog" apartment.sog 8379050
fetch "$PC/apartment.txt" apartment.license.txt 289
fetch "$PC/knock-community-hall.sog" knock-community-hall.sog 27830709
fetch "$PC/knock-community-hall.txt" knock-community-hall.license.txt 308

(cd "$DEST" && shasum -a 256 *.spz *.sog > SHA256SUMS)
echo "done → $DEST"
