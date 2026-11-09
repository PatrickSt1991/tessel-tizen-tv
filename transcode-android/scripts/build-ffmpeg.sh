#!/usr/bin/env bash
# Cross-compiles ffmpeg + ffprobe for Android arm64 with the NDK, and drops
# them into the app's jniLibs as libffmpeg.so / libffprobe.so.
#
# Why the .so names: since Android 10 an app may not execute files it wrote to
# its own data directory. Files the installer unpacked into nativeLibraryDir
# are the exception, and the installer only unpacks lib*.so from jniLibs. They
# are still ordinary PIE executables; only the name is borrowed.
#
# Static x264 is built in so the server keeps its software fallback for phones
# whose hardware encoder refuses the job. The hardware path is h264_mediacodec,
# which talks to the NDK MediaCodec API directly (no Java VM needed).
#
# The lavfi input device stays in: the server probes each hardware encoder by
# encoding one frame from "-f lavfi -i color=...", and without it every probe
# fails and the phone silently falls back to software x264.
#
# Usage: build-ffmpeg.sh <ndk-dir> <jniLibs-arm64-dir>
set -euo pipefail

NDK=${1:?ndk dir}
OUT=${2:?output dir}
API=26
FFMPEG_VERSION=${FFMPEG_VERSION:-7.1.1}
X264_REF=${X264_REF:-stable}   # branch or commit on code.videolan.org

WORK=${WORK:-$PWD/.ffmpeg-build}
mkdir -p "$WORK" "$OUT"
OUT=$(cd "$OUT" && pwd)
cd "$WORK"

TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
CC="$TC/bin/aarch64-linux-android${API}-clang"
CXX="$TC/bin/aarch64-linux-android${API}-clang++"
SYSROOT="$TC/sysroot"
PREFIX="$WORK/prefix"
JOBS=$(nproc)

# ── x264 (static) ───────────────────────────────────────────────────────────
if [ ! -f "$PREFIX/lib/libx264.a" ]; then
  rm -rf x264
  curl -fsSL --retry 5 --retry-all-errors -o x264.tar.bz2 \
    "https://code.videolan.org/videolan/x264/-/archive/${X264_REF}/x264-${X264_REF}.tar.bz2"
  mkdir x264 && tar -xjf x264.tar.bz2 -C x264 --strip-components=1
  (
    cd x264
    # x264 derives $CC from --cross-prefix (llvm-gcc does not exist) unless
    # CC is set, so hand it the API-levelled clang; ar/ranlib/strip do come
    # from the llvm- prefix.
    CC="$CC" ./configure \
      --prefix="$PREFIX" \
      --host=aarch64-linux-android \
      --cross-prefix="$TC/bin/llvm-" \
      --sysroot="$SYSROOT" \
      --enable-static --enable-pic \
      --disable-cli --disable-opencl
    make -j"$JOBS"
    make install
  )
fi

# ── ffmpeg ──────────────────────────────────────────────────────────────────
rm -rf ffmpeg
# GitHub's mirror of the release tag: same source as ffmpeg.org's tarball, and
# far more reliable from CI runners. With GH_TOKEN set (CI) it goes through the
# API authenticated, which doesn't hit the anonymous download throttling.
if [ -n "${GH_TOKEN:-}" ]; then
  curl -fsSL --retry 5 --retry-all-errors -o ffmpeg.tar.gz \
    -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/FFmpeg/FFmpeg/tarball/n${FFMPEG_VERSION}"
else
  curl -fsSL --retry 5 --retry-all-errors -o ffmpeg.tar.gz \
    "https://github.com/FFmpeg/FFmpeg/archive/refs/tags/n${FFMPEG_VERSION}.tar.gz"
fi
mkdir ffmpeg && tar -xzf ffmpeg.tar.gz -C ffmpeg --strip-components=1
cd ffmpeg
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" \
./configure \
  --target-os=android \
  --arch=aarch64 --cpu=armv8-a \
  --enable-cross-compile \
  --cc="$CC" --cxx="$CXX" \
  --nm="$TC/bin/llvm-nm" --ar="$TC/bin/llvm-ar" \
  --ranlib="$TC/bin/llvm-ranlib" --strip="$TC/bin/llvm-strip" \
  --sysroot="$SYSROOT" \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags="-I$PREFIX/include -fPIC" \
  --extra-ldflags="-L$PREFIX/lib -pie" \
  --enable-pic \
  --enable-static --disable-shared \
  --enable-gpl --enable-libx264 \
  --enable-jni --enable-mediacodec \
  --disable-doc --disable-ffplay --disable-debug \
  --disable-postproc \
  --disable-indevs --enable-indev=lavfi --disable-outdevs \
  --disable-vulkan --disable-autodetect --enable-zlib
make -j"$JOBS"

"$TC/bin/llvm-strip" ffmpeg ffprobe
cp ffmpeg  "$OUT/libffmpeg.so"
cp ffprobe "$OUT/libffprobe.so"
ls -la "$OUT"
