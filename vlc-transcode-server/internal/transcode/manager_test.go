package transcode

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeFFprobe writes a shell script that prints a fixed ffprobe answer and
// appends a line to a counter file every time it runs.
func fakeFFprobe(t *testing.T, video, audio string, chans int) (bin, calls string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake ffprobe is a shell script")
	}
	dir := t.TempDir()
	calls = filepath.Join(dir, "calls")
	out := `{"streams":[{"codec_type":"video","codec_name":"` + video + `"},` +
		`{"codec_type":"audio","codec_name":"` + audio + `","channels":` + strconv.Itoa(chans) + `}],` +
		`"format":{"duration":"60.0"}}`
	bin = filepath.Join(dir, "ffprobe")
	script := "#!/bin/sh\necho x >> '" + calls + "'\necho '" + out + "'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, calls
}

func countCalls(t *testing.T, calls string) int {
	b, err := os.ReadFile(calls)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(b), "x")
}

func newTestManager(t *testing.T, ffprobe string, surround string) *Manager {
	t.Helper()
	m, err := NewManager(&Caps{FFprobe: ffprobe}, t.TempDir(),
		func(p string) string { return "http://127.0.0.1:1/raw?path=" + p },
		func() string { return surround })
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestProbeReportsThePlanPlayWouldUse(t *testing.T) {
	bin, _ := fakeFFprobe(t, "h264", "dts", 6)
	m := newTestManager(t, bin, SurroundOff)
	mi, plan, err := m.Probe(context.Background(), SMBSource("Movies/x.mkv"))
	if err != nil {
		t.Fatal(err)
	}
	if mi.VideoCodec != "h264" || mi.AudioCodec != "dts" || mi.AudioChans != 6 {
		t.Fatalf("media info = %+v", mi)
	}
	if plan.DirectPlayable() {
		t.Fatalf("DTS must go through the server, got %q", plan.Reason)
	}
}

// The TV probes, then /play probes the same file again: the second one must
// not run ffprobe over SMB a second time — until the entry goes stale.
func TestProbeIsCachedPerSource(t *testing.T) {
	bin, calls := fakeFFprobe(t, "h264", "aac", 2)
	m := newTestManager(t, bin, SurroundOff)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		if _, _, err := m.Probe(ctx, SMBSource("Movies/x.mkv")); err != nil {
			t.Fatal(err)
		}
	}
	if n := countCalls(t, calls); n != 1 {
		t.Fatalf("ffprobe ran %d times for one file, want 1", n)
	}

	if _, _, err := m.Probe(ctx, SMBSource("Movies/other.mkv")); err != nil {
		t.Fatal(err)
	}
	if n := countCalls(t, calls); n != 2 {
		t.Fatalf("a different file must be probed on its own, ffprobe ran %d times", n)
	}

	real := nowFn
	defer func() { nowFn = real }()
	nowFn = func() time.Time { return real().Add(probeTTL + time.Second) }
	if _, _, err := m.Probe(ctx, SMBSource("Movies/x.mkv")); err != nil {
		t.Fatal(err)
	}
	if n := countCalls(t, calls); n != 3 {
		t.Fatalf("a stale entry must be probed again, ffprobe ran %d times", n)
	}
}

// The surround setting is read at decision time, not cached with the probe.
func TestProbeFollowsLiveSurroundSetting(t *testing.T) {
	bin, _ := fakeFFprobe(t, "h264", "aac", 6)
	mode := SurroundOff
	m, err := NewManager(&Caps{FFprobe: bin}, t.TempDir(),
		func(p string) string { return p }, func() string { return mode })
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, plan, _ := m.Probe(ctx, SMBSource("x.mkv")); !plan.DirectPlayable() {
		t.Fatalf("5.1 AAC with surround off should play directly: %s", plan.Reason)
	}
	mode = SurroundEAC3
	if _, plan, _ := m.Probe(ctx, SMBSource("x.mkv")); plan.DirectPlayable() {
		t.Fatalf("5.1 AAC with surround on must go through the server: %s", plan.Reason)
	}
}
