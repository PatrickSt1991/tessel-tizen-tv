#!/usr/bin/env bash
# Package the Tessel web app as a .wgt for Samsung Tizen TV.
#
# Output: dist/tessel.wgt
#
# Sign the resulting .wgt with your Samsung distributor cert before installing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/tizen-app"
OUT="${ROOT}/dist/tessel.wgt"

# Use the existing app icon from the native attempt
cp -f "${ROOT}/res/tessel.png" "${SRC}/icon.png"

mkdir -p "${ROOT}/dist"
rm -f "${OUT}"

cd "${SRC}"

# Stage the app files for packaging
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
cp -r config.xml index.html icon.png assets css js i18n "$stage"/
[ -f ko-fi-qr.webp ] && cp -f ko-fi-qr.webp "$stage"/

# The service goes in as one function-wrapped file (Tizen 10 runs it in a shared Node 20)
mkdir -p "$stage/service"
node "${ROOT}/scripts/bundle-service.js" "$stage/service/service.js"

if command -v zip >/dev/null 2>&1; then
    ( cd "$stage" && zip -r -X -q "${OUT}" * )
elif command -v python3 >/dev/null 2>&1; then
    ( cd "$stage" && python3 -m zipfile -c "${OUT}" * )
elif command -v python >/dev/null 2>&1; then
    ( cd "$stage" && python -m zipfile -c "${OUT}" * )
fi

# Quick sanity-check: warn if Debug is still enabled in a "release" build
if grep -q '^    var DEBUG    = true;' js/debug.js 2>/dev/null; then
    echo "  (debug telemetry to 192.168.2.22:9999 is ENABLED — flip the flag in js/debug.js to disable for release)"
fi

ls -lh "${OUT}"
echo ""
echo "Sign and install:"
echo "  sdb connect 192.168.2.23"
echo "  sdb install ${OUT}"
