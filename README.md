# Tessel

A media player for Samsung Tizen TVs. Network streams, USB drives
and SMB shares, with a remote-friendly UI and hardware-accelerated playback
through Samsung's AVPlay.


## Features

- **Plays almost anything the TV can decode** — H.264 / HEVC / VP9, AAC / MP3 / AC3 / EAC3, HLS / DASH / RTSP / RTMP
- **USB, internal storage and SMB shares** — browse and stream from a NAS, Windows or Samba
- **Cast a URL from your phone** — scan a QR once, paste a link, it plays. No account, no app
- **Subtitles that actually show** — SRT / VTT / ASS / SAMI sidecars and embedded MP4 / MKV tracks, painted by the app with adjustable size, font, position and background
- **Every embedded track selectable**, even past the TV demuxer's 32-track limit
- **Resume or start over** — a half-watched file asks *Continue* or *Start from the beginning*; number keys jump by tenths
- **Transcode server** for files the TV can't decode (DivX, DTS, TrueHD) and for real 5.1 to a soundbar — see [transcode-server](transcode-server/)
- **Full remote support** — D-pad, media keys, aspect ratio, speed, repeat, shuffle, recent history

## Install

1. **Developer Mode** on the TV: Apps → press `1 2 3 4 5` → Developer Mode **ON** → enter your PC's IP → reboot.
2. **Easy:** install [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung/releases/latest), pick the *Tizen Community* channel and choose **Tessel**. It signs and sideloads for you.
3. **Manual:** download `tessel.wgt` from [Releases](https://github.com/PatrickSt1991/tessel-tizen-tv/releases), re-sign it with your own distributor certificate in Tizen Studio, then:

   ```bash
   sdb connect <tv-ip>
   sdb install tessel.wgt
   ```

Works on Tizen TVs from 2017 onward. SMB shares need Tizen 4.0+ (2018 sets and later). Tested on a 2019 RU7020 and a 2023 S90C.

## Docs

- [Playback notes](docs/PLAYBACK-NOTES.md) — files the TV can't decode, 5.1 that comes out as stereo, and what to do about it
- [Transcode server](transcode-server/README.md) — Docker or native binaries, pairing, surround, hardware acceleration
- [Cast from another device](docs/SEND-URL-FROM-DEVICE.md) — how the phone-to-TV link works and how to host your own page
- [Reading the app's log](docs/DEBUG-LOG.md) — DevTools via Apps2Samsung, SMB trail, remote log capture
- [Why a web app and not native](docs/WHY-WEB-APP.md)

## Building

```bash
bash tizen-app/build.sh      # unsigned .wgt in dist/
```

GitHub Actions builds and publishes a release on every merge to `main`.

## Support

If Tessel is useful to you, consider a coffee: [ko-fi.com/M4M71JOT9R](https://ko-fi.com/M4M71JOT9R)

## Acknowledgments

Built on Samsung's AVPlay API.

Tessel was called **VLC TV** before version 1.7.0. It is an independent project, not affiliated with or endorsed by VideoLAN, and it doesn't use libVLC. VLC is a trademark of VideoLAN.

MIT licensed — see [LICENSE](LICENSE).
