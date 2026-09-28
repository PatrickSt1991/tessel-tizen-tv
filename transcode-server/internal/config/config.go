// Package config holds the server's persisted, web-editable settings.
//
// Everything a non-technical user must set (SMB share + credentials) lives in a
// single JSON file so the web UI can read/write it without anyone touching a
// shell. The file is created on first save; missing/blank fields are fine — the
// server just reports "not configured" until the SMB section is filled in.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// SMB holds the connection details for one share we read media from.
type SMB struct {
	// ID tells the extra shares apart; the first share has none. It is only
	// used by the setup page and /raw: the TV names a share by host and share
	// name, which works for shares typed on the TV as well as copied from here.
	ID        string `json:"id,omitempty"`
	Host      string `json:"host"`      // e.g. "192.168.1.10"
	Port      int    `json:"port"`      // usually 445
	Share     string `json:"share"`     // e.g. "Media"
	User      string `json:"user"`      // empty when Anonymous
	Pass      string `json:"pass"`      // empty when Anonymous
	Domain    string `json:"domain"`    // usually empty
	Anonymous bool   `json:"anonymous"` // guest/null session
}

// LastPair records the most recent successful ntfy publish, so the web UI can
// reassure the user across server restarts that pairing isn't forgotten — the
// SMB form auto-fills from the persisted config but the TV's code isn't
// recoverable from anywhere, which made it feel like the server "forgets"
// after every upgrade.  Knowing the last code + time published is enough to
// confirm the TV-side token is still valid.
type LastPair struct {
	Code string    `json:"code"` // the TV's pairing code we published to
	At   time.Time `json:"at"`   // when the publish succeeded
}

// Config is the whole persisted document.
type Config struct {
	// SMB is the first share. /play?path=… without a host and share reads from
	// it, which is what TVs from before multiple shares send, and it stays in
	// this field so an older server build still finds it after a downgrade.
	SMB SMB `json:"smb"`

	// Extra holds the shares added after the first, for people with more than
	// one NAS or server. Older builds ignore the field.
	Extra []SMB `json:"extra_smb,omitempty"`

	// Encoder lets a user override the auto-detected ffmpeg encoder if the
	// pick misbehaves on their box (e.g. "libx264", "h264_vaapi"). Empty =
	// auto-detect.
	Encoder string `json:"encoder,omitempty"`

	// Surround is the multichannel audio target: "off" (default), "eac3"
	// (Dolby Digital Plus) or "ac3" (Dolby Digital). A TV can only hand a
	// soundbar audio it can bitstream; anything else it decodes and downmixes
	// to stereo on the way out, so 5.1 FLAC/AAC/DTS arrives as 2.0. Setting
	// this re-encodes multichannel tracks into a format that survives the trip.
	// Off by default so an upgrade never starts re-encoding audio that was
	// previously copied untouched.
	Surround string `json:"surround,omitempty"`

	// ShareCredentials lets a paired TV pull the SMB settings below (password
	// included) so the user fills the share in once, here, with a real
	// keyboard — instead of typing six fields on a TV remote and hoping they
	// match. A pointer so an existing config file that predates the field
	// still ends up defaulting to on rather than to Go's zero value; Load
	// normalises it.
	ShareCredentials *bool `json:"share_credentials,omitempty"`

	// LocalRelay allows /play to transcode from a URL the TV hands us instead
	// of only from the SMB share — that's how files on a USB drive plugged
	// into the TV reach this box. The TV serves them from its own background
	// service; we only ever fetch, and only from the LAN address it gives us.
	// Off by default: it widens what a paired TV can ask the box to fetch.
	LocalRelay bool `json:"local_relay,omitempty"`

	// Token is a long random secret minted on first run. The TV receives it
	// during pairing and sends it on /play, so a random LAN device can't drive
	// the transcoder. It rides in URLs the TV builds automatically — no user
	// friction.
	Token string `json:"token,omitempty"`

	// LastPair is the most recent successful publish to ntfy — surfaced in the
	// web UI as "Last paired with code XYZ at HH:MM".  Nil until the first
	// successful Pair button click on the web UI.
	LastPair *LastPair `json:"last_pair,omitempty"`

	path string     // backing file; not serialised
	mu   sync.Mutex // guards Save against concurrent web writes
}

// Set reports whether enough is filled in to attempt a connection.
func (s *SMB) Set() bool { return s.Host != "" && s.Share != "" }

// Configured reports whether any share is set up.
func (c *Config) Configured() bool {
	return len(c.Shares()) > 0
}

// Shares lists the usable shares, the first share first.
func (c *Config) Shares() []SMB {
	var out []SMB
	if c.SMB.Set() {
		out = append(out, c.SMB)
	}
	for _, s := range c.Extra {
		if s.Set() {
			out = append(out, s)
		}
	}
	return out
}

// Share returns the share with the given ID ("" is the first share).
func (c *Config) Share(id string) (SMB, bool) {
	if id == "" {
		return c.SMB, true
	}
	for _, s := range c.Extra {
		if s.ID == id {
			return s, true
		}
	}
	return SMB{}, false
}

// Find returns the ID of the share at host with the given share name. Both
// compare case-insensitively, since SMB share names are, and a host saved with
// IPv6 brackets matches one given without.
func (c *Config) Find(host, share string) (string, bool) {
	for _, s := range c.Shares() {
		if sameHost(s.Host, host) && strings.EqualFold(s.Share, share) {
			return s.ID, true
		}
	}
	return "", false
}

// Reaches reports whether other signs in to the same server as s: host, port
// (blank meaning 445) and user.
func (s *SMB) Reaches(other SMB) bool {
	port := func(p int) int {
		if p == 0 {
			return 445
		}
		return p
	}
	return sameHost(s.Host, other.Host) && port(s.Port) == port(other.Port) && s.User == other.User
}

func sameHost(a, b string) bool {
	return strings.EqualFold(strings.Trim(a, "[]"), strings.Trim(b, "[]"))
}

// NewShareID mints the ID of an extra share.
func NewShareID() string {
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// PutShare stores s under id. "" is the first share, "new" adds a share (as the
// first one when that is empty), anything else replaces that extra share. It
// returns the ID the share ended up with. A blank port becomes 445.
func (c *Config) PutShare(id string, s SMB) (string, error) {
	if s.Port == 0 {
		s.Port = 445
	}
	if s.Set() {
		if other, ok := c.Find(s.Host, s.Share); ok && (id == "new" || other != id) {
			return "", ErrDuplicateShare
		}
	}
	switch {
	case id == "new" && !c.SMB.Set():
		id = ""
		fallthrough
	case id == "":
		s.ID = ""
		c.SMB = s
		return "", nil
	case id == "new":
		s.ID = NewShareID()
		c.Extra = append(c.Extra, s)
		return s.ID, nil
	}
	for i := range c.Extra {
		if c.Extra[i].ID == id {
			s.ID = id
			c.Extra[i] = s
			return id, nil
		}
	}
	return "", ErrUnknownShare
}

// RemoveShare drops a share. Removing the first share empties it rather than
// moving an extra share up: the extra share keeps its ID, and a TV from before
// multiple shares, which only knows the first one, gets "not configured"
// instead of files from a different server.
func (c *Config) RemoveShare(id string) error {
	if id == "" {
		c.SMB = SMB{Port: 445}
		return nil
	}
	for i := range c.Extra {
		if c.Extra[i].ID == id {
			c.Extra = append(c.Extra[:i], c.Extra[i+1:]...)
			return nil
		}
	}
	return ErrUnknownShare
}

var (
	ErrUnknownShare   = errors.New("no such share")
	ErrDuplicateShare = errors.New("that share is already in the list")
)

// EnsureToken mints the pairing secret on first run and persists it.
func (c *Config) EnsureToken() error {
	if c.Token != "" {
		return nil
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	c.Token = hex.EncodeToString(b)
	return c.Save()
}

// Load reads the config file, returning an empty (but usable) Config if it does
// not exist yet. Only a malformed existing file is an error.
func Load(path string) (*Config, error) {
	on := true
	c := &Config{path: path, SMB: SMB{Port: 445}, ShareCredentials: &on}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	c.path = path
	if c.SMB.Port == 0 {
		c.SMB.Port = 445
	}
	if c.ShareCredentials == nil {
		on := true
		c.ShareCredentials = &on
	}
	return c, nil
}

// CanShareCredentials reports whether a paired TV may fetch the SMB settings.
// Absent (an old config, or a hand-written one) means yes — that's the setup
// the feature exists for.
func (c *Config) CanShareCredentials() bool {
	return c.ShareCredentials == nil || *c.ShareCredentials
}

// Save atomically persists the current config to disk.
func (c *Config) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(c.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

// View is the JSON shape sent to the web UI — no mutex, password masked.
type View struct {
	SMB              SMB    `json:"smb"`
	Extra            []SMB  `json:"extra_smb"`
	Encoder          string `json:"encoder,omitempty"`
	Surround         string `json:"surround"`
	LocalRelay       bool   `json:"local_relay"`
	ShareCredentials bool   `json:"share_credentials"`
}

// Redacted returns a lock-free view safe to send to the web UI.
func (c *Config) Redacted() View {
	v := View{
		SMB: c.SMB, Encoder: c.Encoder, Surround: c.Surround,
		LocalRelay: c.LocalRelay, ShareCredentials: c.CanShareCredentials(),
	}
	if v.Surround == "" {
		v.Surround = "off"
	}
	v.SMB.Pass = "" // never leak the stored password
	v.Extra = make([]SMB, len(c.Extra))
	for i, s := range c.Extra {
		s.Pass = ""
		v.Extra[i] = s
	}
	return v
}
