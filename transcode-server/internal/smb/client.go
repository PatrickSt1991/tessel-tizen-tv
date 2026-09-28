// Package smb wraps go-smb2 with the few operations this server needs: list a
// server's shares and a folder (for the web UI's "find shares" and "test
// browse") and open a file as a seekable reader (so ffmpeg/HTTP can range-read
// it). A single share is mounted and kept open;
// if the session drops we transparently re-dial on the next call.
package smb

import (
	"context"
	"fmt"
	"io"
	"net"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hirochachacha/go-smb2"

	"github.com/PatrickSt1991/tessel-tizen-tv/transcode-server/internal/config"
)

// Entry is one item in a folder listing.
type Entry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// File is a seekable handle to one SMB file plus its size.
type File struct {
	*smb2.File
	Size int64
}

// Client holds the live session/mount and re-dials on demand.
type Client struct {
	cfg *config.SMB

	mu      sync.Mutex
	conn    net.Conn
	session *smb2.Session
	share   *smb2.Share
}

// New returns a client bound to the given SMB settings. Nothing connects until
// the first call.
func New(cfg *config.SMB) *Client { return &Client{cfg: cfg} }

// normalise converts an incoming "/Movies/x.mkv" into the backslash-free,
// leading-slash-free form go-smb2 expects, and blocks ".." traversal so a
// crafted path can't escape the share.
func normalise(p string) (string, error) {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "/")
	clean := path.Clean("/" + p)
	if strings.Contains(clean, "..") {
		return "", fmt.Errorf("invalid path")
	}
	return strings.TrimPrefix(clean, "/"), nil
}

// dial opens a TCP connection and signs in; the caller mounts what it needs.
func dial(cfg *config.SMB) (net.Conn, *smb2.Session, error) {
	port := cfg.Port
	if port == 0 {
		port = 445
	}
	d := net.Dialer{Timeout: 10 * time.Second}
	// JoinHostPort brackets a bare IPv6 address; one saved with brackets
	// already is unwrapped first so it isn't bracketed twice.
	addr := net.JoinHostPort(strings.Trim(cfg.Host, "[]"), fmt.Sprint(port))
	conn, err := d.Dial("tcp", addr)
	if err != nil {
		return nil, nil, fmt.Errorf("dial %s: %w", cfg.Host, err)
	}
	init := &smb2.NTLMInitiator{Domain: cfg.Domain}
	if !cfg.Anonymous {
		init.User = cfg.User
		init.Password = cfg.Pass
	} else {
		// A guest/null session: many NAS boxes accept an empty user.
		init.User = cfg.User // often "" or "Guest"
	}
	dialer := &smb2.Dialer{Initiator: init}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	sess, err := dialer.DialContext(ctx, conn)
	if err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("smb auth: %w", err)
	}
	return conn, sess, nil
}

// ListShares asks a server which shares it offers, so the setup page can offer
// a pick list instead of making the user guess the name. It dials on its own
// connection with the settings given — the form's, which may not be saved yet —
// and leaves the client's mount alone. Hidden and administrative shares (IPC$,
// C$, ADMIN$, print$ …) are left out: nobody keeps films there.
func ListShares(cfg *config.SMB) ([]string, error) {
	if cfg.Host == "" {
		return nil, fmt.Errorf("SMB host not set")
	}
	conn, sess, err := dial(cfg)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	defer sess.Logoff()
	names, err := sess.ListSharenames()
	if err != nil {
		return nil, fmt.Errorf("list shares: %w", err)
	}
	return visibleShares(names), nil
}

// visibleShares drops the $-suffixed shares and sorts the rest by name.
func visibleShares(names []string) []string {
	out := make([]string, 0, len(names))
	for _, n := range names {
		if n != "" && !strings.HasSuffix(n, "$") {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i]) < strings.ToLower(out[j]) })
	return out
}

// ensure (re)establishes the mount if needed. Caller holds c.mu.
func (c *Client) ensure() error {
	if c.share != nil {
		return nil
	}
	if c.cfg.Host == "" || c.cfg.Share == "" {
		return fmt.Errorf("SMB not configured")
	}
	conn, sess, err := dial(c.cfg)
	if err != nil {
		return err
	}
	share, err := sess.Mount(c.cfg.Share)
	if err != nil {
		sess.Logoff()
		conn.Close()
		return fmt.Errorf("mount %q: %w", c.cfg.Share, err)
	}
	c.conn, c.session, c.share = conn, sess, share
	return nil
}

// reset tears the session down so the next call re-dials. Caller holds c.mu.
func (c *Client) reset() {
	if c.share != nil {
		c.share.Umount()
	}
	if c.session != nil {
		c.session.Logoff()
	}
	if c.conn != nil {
		c.conn.Close()
	}
	c.share, c.session, c.conn = nil, nil, nil
}

// Probe forces a connect (used by the web UI's "Test connection" button).
func (c *Client) Probe() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reset() // always test fresh credentials
	return c.ensure()
}

// List returns the entries of a folder ("" or "/" = share root).
func (c *Client) List(p string) ([]Entry, error) {
	rel, err := normalise(p)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(); err != nil {
		return nil, err
	}
	dir := rel
	if dir == "" {
		dir = "."
	}
	infos, err := c.share.ReadDir(dir)
	if err != nil {
		c.reset() // drop a possibly-stale session
		return nil, err
	}
	out := make([]Entry, 0, len(infos))
	for _, fi := range infos {
		out = append(out, Entry{Name: fi.Name(), IsDir: fi.IsDir(), Size: fi.Size()})
	}
	return out, nil
}

// Open returns a seekable handle to a file. The caller must Close it.
func (c *Client) Open(p string) (*File, error) {
	rel, err := normalise(p)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(); err != nil {
		return nil, err
	}
	f, err := c.share.Open(rel)
	if err != nil {
		c.reset()
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if fi.IsDir() {
		f.Close()
		return nil, fmt.Errorf("%s is a directory", p)
	}
	return &File{File: f, Size: fi.Size()}, nil
}

// ensure *smb2.File satisfies io.ReadSeeker for http.ServeContent.
var _ io.ReadSeeker = (*smb2.File)(nil)
