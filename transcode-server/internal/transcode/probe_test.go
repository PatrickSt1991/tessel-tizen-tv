package transcode

import "testing"

func TestParseProbeIgnoresCoverArt(t *testing.T) {
	cases := []struct {
		name, json string
		video      string
	}{
		{"flac with cover art",
			`{"streams":[{"codec_type":"audio","codec_name":"flac","channels":2},` +
				`{"codec_type":"video","codec_name":"png","disposition":{"attached_pic":1}}],"format":{"duration":"120.0"}}`,
			""},
		{"mp3 with cover art first",
			`{"streams":[{"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}},` +
				`{"codec_type":"audio","codec_name":"mp3","channels":2}],"format":{}}`,
			""},
		{"mkv with poster attachment keeps the real video",
			`{"streams":[{"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}},` +
				`{"codec_type":"video","codec_name":"hevc"},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{}}`,
			"hevc"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mi, err := parseProbe([]byte(c.json))
			if err != nil {
				t.Fatal(err)
			}
			if mi.VideoCodec != c.video {
				t.Fatalf("VideoCodec = %q, want %q", mi.VideoCodec, c.video)
			}
		})
	}
}

func TestMP3WithCoverArtPlaysDirect(t *testing.T) {
	mi, err := parseProbe([]byte(`{"streams":[{"codec_type":"audio","codec_name":"mp3","channels":2},` +
		`{"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}}],"format":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	if p := Decide(mi, SurroundOff); !p.DirectPlayable() {
		t.Fatalf("mp3 with cover art should play direct, got %q", p.Reason)
	}
}
