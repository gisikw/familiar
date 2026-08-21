//go:build !unix

package llm

import (
	"os"
	"os/exec"
)

func configureChildProcess(cmd *exec.Cmd) {}
func terminateProcessGroup(cmd *exec.Cmd, force bool) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	if force {
		_ = cmd.Process.Kill()
		return
	}
	_ = cmd.Process.Signal(os.Interrupt)
}
func processExitStatus(state *os.ProcessState) string {
	if state == nil {
		return "unknown"
	}
	return state.String()
}
