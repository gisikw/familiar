//go:build !unix

package server

import (
	"os"
	"os/exec"
)

func configureChildProcess(cmd *exec.Cmd) {}
func signalProcessGroup(cmd *exec.Cmd, force bool) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if force {
		_ = cmd.Process.Kill()
	} else {
		_ = cmd.Process.Signal(os.Interrupt)
	}
}
func exitDescription(state *os.ProcessState) string {
	if state == nil {
		return "unknown"
	}
	return state.String()
}
