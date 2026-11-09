package transcode

import (
	"os/exec"
	"syscall"
)

// dieWithParent has the kernel kill ffmpeg when this server goes away. A
// server that exits or is killed otherwise leaves its ffmpeg running, which on
// a box only wastes CPU until the file ends, but on a phone keeps a hot encode
// going after the user pressed Stop in the Android app. Also covers Android,
// which builds with the linux tag.
func dieWithParent(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
