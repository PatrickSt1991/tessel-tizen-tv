#!/usr/bin/env bash
# Package Tessel Lite (the URL-only player for 2015 to 2017 sets) as a .wgt.
#
# Output: dist/tessel-lite.wgt
#
# Sign the resulting .wgt with your Samsung distributor cert before installing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/tizen-lite"
OUT="${ROOT}/dist/tessel-lite.wgt"

mkdir -p "${ROOT}/dist"
rm -f "${OUT}"

cd "${SRC}"
if command -v zip >/dev/null 2>&1; then
    zip -r -X -q "${OUT}" config.xml index.html icon.png css js
else
    python3 -m zipfile -c "${OUT}" config.xml index.html icon.png css js
fi

ls -lh "${OUT}"
