package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadKeepsASingleShareConfigAsTheFirstShare(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	legacy := `{"smb":{"host":"nas","port":445,"share":"Media","user":"tv","pass":"pw"},"token":"tok"}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	shares := c.Shares()
	if len(shares) != 1 || shares[0].ID != "" || shares[0].Share != "Media" {
		t.Fatalf("Shares() = %+v, want the one legacy share with no ID", shares)
	}
	if id, ok := c.Find("NAS", "media"); !ok || id != "" {
		t.Fatalf("Find(NAS, media) = %q, %v; want the first share", id, ok)
	}
}

func TestSaveKeepsTheFirstShareWhereOlderBuildsReadIt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	c, _ := Load(path)
	if _, err := c.PutShare("new", SMB{Host: "nas", Share: "Media"}); err != nil {
		t.Fatal(err)
	}
	id, err := c.PutShare("new", SMB{Host: "10.0.0.2", Share: "Films"})
	if err != nil || id == "" {
		t.Fatalf("second share: id %q, err %v", id, err)
	}
	if err := c.Save(); err != nil {
		t.Fatal(err)
	}
	var onDisk struct {
		SMB   SMB   `json:"smb"`
		Extra []SMB `json:"extra_smb"`
	}
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &onDisk); err != nil {
		t.Fatal(err)
	}
	if onDisk.SMB.Share != "Media" || onDisk.SMB.Port != 445 {
		t.Fatalf("smb = %+v, want the first share with the default port", onDisk.SMB)
	}
	if len(onDisk.Extra) != 1 || onDisk.Extra[0].ID != id || onDisk.Extra[0].Share != "Films" {
		t.Fatalf("extra_smb = %+v", onDisk.Extra)
	}
}

func TestPutShareRejectsASecondCopyOfTheSameShare(t *testing.T) {
	c := &Config{}
	c.PutShare("new", SMB{Host: "nas", Share: "Media"})
	id, _ := c.PutShare("new", SMB{Host: "nas", Share: "Films"})
	if _, err := c.PutShare("new", SMB{Host: "[NAS]", Share: "MEDIA"}); err != ErrDuplicateShare {
		t.Fatalf("adding nas/Media again: err %v, want ErrDuplicateShare", err)
	}
	if _, err := c.PutShare(id, SMB{Host: "nas", Share: "Media"}); err != ErrDuplicateShare {
		t.Fatalf("renaming the extra share onto the first: err %v, want ErrDuplicateShare", err)
	}
	if _, err := c.PutShare(id, SMB{Host: "nas", Share: "Films", User: "tv"}); err != nil {
		t.Fatalf("re-saving a share under its own ID: %v", err)
	}
	if _, err := c.PutShare("nope", SMB{Host: "x", Share: "y"}); err != ErrUnknownShare {
		t.Fatalf("unknown ID: err %v, want ErrUnknownShare", err)
	}
}

func TestRemovingTheFirstShareDoesNotPromoteAnother(t *testing.T) {
	c := &Config{}
	c.PutShare("new", SMB{Host: "nas", Share: "Media"})
	id, _ := c.PutShare("new", SMB{Host: "nas", Share: "Films"})
	if err := c.RemoveShare(""); err != nil {
		t.Fatal(err)
	}
	if c.SMB.Set() {
		t.Fatalf("first share still set: %+v", c.SMB)
	}
	if got, ok := c.Find("nas", "Films"); !ok || got != id {
		t.Fatalf("the extra share lost its ID: %q, %v", got, ok)
	}
	if !c.Configured() {
		t.Fatal("a box with only an extra share left should still count as configured")
	}
	// The next share added fills the empty first slot.
	if got, _ := c.PutShare("new", SMB{Host: "nas", Share: "Music"}); got != "" {
		t.Fatalf("new share went to %q, want the empty first slot", got)
	}
}

func TestReachesTellsServersOnOneHostApartByPort(t *testing.T) {
	a := SMB{Host: "127.0.0.1", Port: 1445, User: "tv"}
	b := SMB{Host: "127.0.0.1", Port: 2445, User: "tv"}
	if a.Reaches(b) {
		t.Fatal("two ports on one host counted as the same server")
	}
	if !(&SMB{Host: "[::1]", User: "tv"}).Reaches(SMB{Host: "::1", Port: 445, User: "tv"}) {
		t.Fatal("a blank port should mean 445, and brackets shouldn't matter")
	}
}
