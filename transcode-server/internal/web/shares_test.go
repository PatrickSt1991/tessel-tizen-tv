package web

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PatrickSt1991/tessel-tizen-tv/transcode-server/internal/config"
)

func sharesServer() *Server {
	c := &config.Config{Token: "tok"}
	c.PutShare("new", config.SMB{Host: "nas", Share: "Media"})
	c.PutShare("new", config.SMB{Host: "192.168.1.5", Share: "Films"})
	return New(c, nil, nil, 8200)
}

func TestSourceForPicksTheShareTheTVNames(t *testing.T) {
	s := sharesServer()
	films, _ := s.cfg.Find("192.168.1.5", "Films")
	for _, tc := range []struct{ query, share string }{
		{"path=Movies/x.mkv", ""},                                 // a TV from before multiple shares
		{"path=Movies/x.mkv&host=NAS&share=media", ""},            // the first share, named
		{"path=Movies/x.mkv&host=192.168.1.5&share=Films", films}, // an extra share
	} {
		src, err := s.sourceFor(httptest.NewRequest("GET", "/play?"+tc.query, nil))
		if err != nil {
			t.Fatalf("%s: %v", tc.query, err)
		}
		if src.Share != tc.share || src.SMBPath != "Movies/x.mkv" {
			t.Fatalf("%s: got share %q path %q, want share %q", tc.query, src.Share, src.SMBPath, tc.share)
		}
	}
}

func TestSourceForRefusesAShareThatIsNotSetUp(t *testing.T) {
	_, err := sharesServer().sourceFor(httptest.NewRequest("GET", "/play?path=x.mkv&host=nas&share=Music", nil))
	if err == nil || !strings.Contains(err.Error(), "nas/Music") {
		t.Fatalf("err = %v, want one naming nas/Music", err)
	}
}

func TestRawURLNamesTheShareOnlyWhenItIsNotTheFirst(t *testing.T) {
	s := sharesServer()
	if u := s.RawURL("", "a b.mkv"); strings.Contains(u, "share=") {
		t.Fatalf("first share: %s", u)
	}
	if u := s.RawURL("ab12", "a.mkv"); !strings.HasSuffix(u, "&share=ab12") {
		t.Fatalf("extra share: %s", u)
	}
}

func TestSourceForTellsAnOldTVTheFirstShareIsGone(t *testing.T) {
	s := sharesServer()
	s.cfg.RemoveShare("")
	_, err := s.sourceFor(httptest.NewRequest("GET", "/play?path=x.mkv", nil))
	if err == nil || !strings.Contains(err.Error(), "update the TV app") {
		t.Fatalf("err = %v", err)
	}
}
