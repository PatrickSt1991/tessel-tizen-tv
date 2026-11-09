#!/usr/bin/env bash
# Builds the Go transcode server for Android arm64 as libtessel.so (see
# build-ffmpeg.sh for why an executable wears a .so name).
#
# cgo is on, through the NDK's clang, for one reason: DNS. A pure-Go build
# reads /etc/resolv.conf, which Android doesn't have, so pairing (ntfy.sh) and
# shares named by hostname would fail to resolve. With cgo Go asks bionic's
# resolver, which knows the phone's real DNS servers.
#
# Usage: build-server.sh <ndk-dir> <jniLibs-arm64-dir>
set -euo pipefail

NDK=${1:?ndk dir}
OUT=${2:?output dir}
API=26
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

cd "$HERE/../../transcode-server"
CGO_ENABLED=1 GOOS=android GOARCH=arm64 \
CC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android${API}-clang" \
  go build -trimpath -ldflags="-s -w" -o "$OUT/libtessel.so" .
ls -la "$OUT/libtessel.so"
