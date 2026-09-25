package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/PatrickSt1991/tessel-tizen-tv/transcode-server/internal/config"
	"github.com/PatrickSt1991/tessel-tizen-tv/transcode-server/internal/transcode"
)

func probeServer(t *testing.T, ffprobeJSON string) http.Handler {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake ffprobe is a shell script")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "ffprobe")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\necho '"+ffprobeJSON+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	s := New(&config.Config{Token: "tok"}, nil, nil, 8200)
	mgr, err := transcode.NewManager(&transcode.Caps{FFprobe: bin}, filepath.Join(dir, "work"), s.RawURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	s.SetManager(mgr)
	return s.Handler()
}

func get(h http.Handler, url string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, url, nil))
	return rec
}

func TestProbeSaysDirectForARemuxOnlyFile(t *testing.T) {
	h := probeServer(t, `{"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"aac","channels":2}],"format":{}}`)
	rec := get(h, "/api/probe?path=Movies/x.mkv&token=tok")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Direct bool   `json:"direct"`
		Reason string `json:"reason"`
		Video  string `json:"video"`
		Audio  string `json:"audio"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Direct || body.Video != "h264" || body.Audio != "aac" || body.Reason == "" {
		t.Fatalf("unexpected answer %+v", body)
	}
}

func TestProbeSendsDTSThroughTheServer(t *testing.T) {
	h := probeServer(t, `{"streams":[{"codec_type":"video","codec_name":"h264"},{"codec_type":"audio","codec_name":"dts","channels":6}],"format":{}}`)
	rec := get(h, "/api/probe?path=Movies/x.mkv&token=tok")
	var body struct{ Direct bool }
	json.Unmarshal(rec.Body.Bytes(), &body)
	if rec.Code != http.StatusOK || body.Direct {
		t.Fatalf("status %d direct=%v: %s", rec.Code, body.Direct, rec.Body.String())
	}
}

func TestProbeNeedsTokenAndPath(t *testing.T) {
	h := probeServer(t, `{"streams":[],"format":{}}`)
	if rec := get(h, "/api/probe?path=x.mkv"); rec.Code != http.StatusForbidden {
		t.Errorf("no token: status %d, want 403", rec.Code)
	}
	if rec := get(h, "/api/probe?token=tok"); rec.Code != http.StatusBadRequest {
		t.Errorf("no path: status %d, want 400", rec.Code)
	}
}
