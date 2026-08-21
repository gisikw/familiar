package server

import (
	"os"
	"path/filepath"
	"sync"
)

// rollingLog retains at most two bounded files: name.log and name.log.1.
type rollingLog struct {
	mu   sync.Mutex
	path string
	max  int64
	file *os.File
	size int64
}

func openRollingLog(dir, name string, max int64) (*rollingLog, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	_ = os.Chmod(dir, 0700)
	p := filepath.Join(dir, name+".log")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	st, _ := f.Stat()
	return &rollingLog{path: p, max: max, file: f, size: st.Size()}, nil
}
func (l *rollingLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	original := len(p)
	if int64(len(p)) > l.max {
		p = p[len(p)-int(l.max):]
	}
	if l.size+int64(len(p)) > l.max {
		_ = l.file.Close()
		_ = os.Remove(l.path + ".1")
		_ = os.Rename(l.path, l.path+".1")
		f, e := os.OpenFile(l.path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if e != nil {
			return 0, e
		}
		l.file = f
		l.size = 0
	}
	n, e := l.file.Write(p)
	l.size += int64(n)
	if e == nil {
		return original, nil
	}
	return n, e
}
func (l *rollingLog) Close() error { l.mu.Lock(); defer l.mu.Unlock(); return l.file.Close() }
