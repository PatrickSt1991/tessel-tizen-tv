# Playback notes

What to do when a file will not play, or plays with the wrong sound.

## Playing files the TV can't decode (old AVI / WMV / DTS / etc.)

Samsung TVs only decode what's in their hardware decoder — typically
**H.264, HEVC, VP9** for video and **AAC, MP3, AC-3, EAC-3** for audio.
Old AVI / WMV / FLV files (DivX, Xvid, WMV9, etc.) and modern files
with DTS-HD MA or TrueHD audio will fail in AVPlay's `prepareAsync`
even when the network and proxy paths are fully working.

VLC TV can't transcode on the TV itself (the CPU isn't fast enough),
but the existing **Network Stream** view and the **Cast a link from
your phone** flow already let you play streams that a *server* has
transcoded for you. Two practical routes:

### Stream through Plex or Jellyfin (no new setup if you already have one)

Both expose every file in their library as a transcoded HTTP / HLS
stream URL that this TV's AVPlay can decode natively. You just need to
hand the URL to VLC TV.

- **Plex**: in the web UI, right-click an item → *Get Info → View XML*,
  or use the official API:
  ```
  http://<server>:32400/video/:/transcode/universal/start.m3u8?
    path=<plex-id>&X-Plex-Token=<token>
    &mediaIndex=0&directPlay=0&directStream=0
    &videoResolution=1920x1080&audioBoost=100
  ```
- **Jellyfin**: in the web UI, *Play From Beginning → Play with Direct
  Stream*, copy the URL from the dev tools network tab — looks like:
  ```
  http://<server>:8096/Videos/<item-id>/master.m3u8?
    api_key=<key>&AudioCodec=aac&VideoCodec=h264
  ```

Once you have the URL, either type it in **Open Network Stream**, or
paste it from your phone via **Get URL from device**.

### One-shot re-encode with ffmpeg / HandBrake

For files you'll keep on your USB drive or SMB share, a one-time
re-encode to H.264 + AAC lasts forever:

```bash
ffmpeg -i input.avi -c:v libx264 -preset fast -c:a aac -b:a 192k output.mp4
```

For MKVs where only the audio is the problem (DTS, TrueHD), copy the
video untouched and only re-encode audio — quick even on a Raspberry Pi:

```bash
ffmpeg -i input.mkv -c:v copy -c:a ac3 -b:a 640k output.mkv
```

## 5.1 surround reaches the soundbar as stereo

A 5.1 FLAC, AAC or PCM track plays fine and still comes out of the soundbar in
stereo. That's the HDMI link, not the app. ARC and optical carry either LPCM or
an IEC 61937-framed bitstream, and only Dolby Digital and Dolby Digital Plus
have that framing — everything else the TV decodes itself, and plain ARC can
only carry two channels of the resulting LPCM. FLAC has no bitstream form at
all, on any device: an external player that "sends FLAC 5.1 to the soundbar" is
decoding it and sending multichannel LPCM over a link that can carry it.

AVPlay gives an app no channel-layout or passthrough control, so no version of
VLC TV can fix this on the TV. The two things that do work:

- **Let the [transcode server](../vlc-transcode-server/) re-encode it.** Point the
  TV at it with **Settings → Transcode server → Find server on my network** — it
  sweeps your LAN, pairs, and sorts the share settings out between the two ends
  by itself. No pairing code, no internet. Then, in the same menu, set
  **Surround sound** to Dolby Digital Plus 5.1: multichannel tracks get
  re-encoded into something the TV passes straight through, keeping all six
  channels. **Play USB files through the server** does the same for files on a
  USB stick.
- **Re-encode the file once yourself**, if you'd rather not run anything:

  ```bash
  ffmpeg -i input.mkv -c:v copy -c:a eac3 -b:a 768k -ac 6 output.mkv
  ```

Either way it's a lossy re-encode — you keep the channels, not the
bit-exactness. And set the TV's **Sound → Expert Settings → Digital Output
Audio Format** to *Pass-through* / Auto, or it will decode the Dolby stream and
downmix it again on the way out.

In the audio-track picker, a track that will be flattened this way is labelled
**"TV downmixes to stereo"**, so you can tell it apart from one the TV can't
decode at all.
