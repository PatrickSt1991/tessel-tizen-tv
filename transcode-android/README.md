# Tessel Transcode for Android

The [transcode server](../transcode-server/) as an Android app, so a phone or
tablet can do the work a box would. For using it, see
[Run it on an Android phone](../transcode-server/README.md#run-it-on-an-android-phone).
This file is about how it's put together.

## How it works

The app doesn't reimplement anything. It ships three executables in
`jniLibs/arm64-v8a/`:

| File | What it is |
|---|---|
| `libtessel.so` | the Go server from `transcode-server/`, built for `android/arm64` |
| `libffmpeg.so` | ffmpeg 7.1 with x264 and MediaCodec |
| `libffprobe.so` | ffprobe from the same build |

They're executables, not libraries. Since Android 10 an app can't execute files
it wrote itself; the files the installer unpacks into `nativeLibraryDir` are the
exception, and the installer only unpacks `lib*.so`. Hence the names, and
`useLegacyPackaging` / `extractNativeLibs` so they land on disk as real files.

`TranscodeService` is a foreground service (type `specialUse`) that starts
`libtessel.so` with:

| Env | Value |
|---|---|
| `DATA_DIR` | the app's files dir (`config.json`, pairing token) |
| `WORK_DIR` | `cache/hls` (segments) |
| `FFMPEG`, `FFPROBE` | the two bundled executables |
| `TESSEL_NAME` | the phone's model, shown on the TV |
| `TESSEL_EXIT_WITH_PARENT` | `1`: the server exits when the app process dies, so port 8200 is free for the next start |

It holds a partial wake lock and a Wi-Fi lock while running, restarts the
server with backoff if it exits, and keeps the last 400 log lines for the
**Log** button. `MainActivity` shows the status and the address, and the
server's own setup page in a WebView on `127.0.0.1:8200`.

The Go server is built with cgo through the NDK. Pure Go would read
`/etc/resolv.conf` for DNS, which Android doesn't have, and pairing via ntfy.sh
would fail to resolve.

## Building

CI does it: `.github/workflows/transcode-android.yml` builds ffmpeg (cached),
the server and the APK on every PR that touches `transcode-android/` or
`transcode-server/`, and attaches the APK to the release on `transcode-v*`
tags.

Locally, with the NDK r27c and JDK 17:

```bash
JNI=transcode-android/app/src/main/jniLibs/arm64-v8a
transcode-android/scripts/build-ffmpeg.sh "$NDK" "$JNI"   # ~10 min, needs nasm, pkg-config, a host gcc
transcode-android/scripts/build-server.sh "$NDK" "$JNI"
gradle -p transcode-android assembleRelease                 # Gradle 8.11
```

## Signing

Android only installs an update over an installed copy when both are signed
with the same key, so releases use one fixed key from these repository
secrets:

| Secret | |
|---|---|
| `ANDROID_KEYSTORE_B64` | the `.jks` file, base64 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

Without them the APK is signed with a debug key: fine for testing, but every
build machine has a different one.

## Licence

The bundled ffmpeg is built with `--enable-gpl` and x264, so it's GPL. It is
built from the unmodified ffmpeg release tarball and x264's `stable` branch by
`scripts/build-ffmpeg.sh`, which is the complete recipe.
