//go:build !linux

package transcode

import "os/exec"

// dieWithParent is Linux/Android only; elsewhere ffmpeg ends with its input.
func dieWithParent(cmd *exec.Cmd) {}
