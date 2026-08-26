//go:build linux

package server

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

func configureChildProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
func signalProcessGroup(cmd *exec.Cmd, force bool) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
}
func exitDescription(state *os.ProcessState) string {
	if state == nil {
		return "unknown"
	}
	s, ok := state.Sys().(syscall.WaitStatus)
	if !ok {
		return state.String()
	}
	if s.Signaled() {
		return fmt.Sprintf("signal %d", s.Signal())
	}
	return fmt.Sprintf("exit code %d", s.ExitStatus())
}
