//go:build linux

package llm

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

func configureChildProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}

func terminateProcessGroup(cmd *exec.Cmd, force bool) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
}

func processExitStatus(state *os.ProcessState) string {
	if state == nil {
		return "unknown"
	}
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok {
		return state.String()
	}
	if status.Signaled() {
		return fmt.Sprintf("signal %d", status.Signal())
	}
	return fmt.Sprintf("exit code %d", status.ExitStatus())
}
