//go:build unix

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigValidation(t *testing.T) {
	base := DefaultConfig()
	base.StateDir = t.TempDir()
	base.Children = []ChildConfig{{Name: "one", Argv: []string{"true"}}}
	for _, tc := range []struct {
		name   string
		mutate func(*Config)
	}{{"non-loopback", func(c *Config) { c.Listen = "0.0.0.0:1" }}, {"duplicate", func(c *Config) { c.Children = append(c.Children, c.Children[0]) }}, {"unknown dependency", func(c *Config) { c.Children[0].DependsOn = []string{"missing"} }}, {"presence attached", func(c *Config) { c.Children[0].Presence = true }}} {
		t.Run(tc.name, func(t *testing.T) {
			c := base
			c.Children = append([]ChildConfig(nil), base.Children...)
			tc.mutate(&c)
			if err := ValidateConfig(c); err == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
}

func TestLoadConfigResolvesPathsAndRejectsUnknown(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.toml")
	text := "state_dir = \"runtime\"\n[[children]]\nname=\"x\"\nargv=[\"true\"]\nworking_dir=\"work\"\n"
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.StateDir != filepath.Join(dir, "runtime") || c.Children[0].WorkingDir != filepath.Join(dir, "work") {
		t.Fatalf("paths not resolved: %+v", c)
	}
	if err := os.WriteFile(path, []byte(text+"mystery=true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = LoadConfig(path); err == nil {
		t.Fatal("unknown key accepted")
	}
}

func TestCanonicalConfigLoads(t *testing.T) {
	c, err := LoadConfig("familiar-server.toml.example")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Children) < 5 {
		t.Fatalf("canonical children=%d, want at least 5", len(c.Children))
	}
	for _, child := range c.Children {
		// LoadConfig may project environment-configured plugins beside the five
		// canonical children. Plugin probe policy belongs to its manifest, not
		// this example-config assertion.
		if strings.HasPrefix(child.Name, "plugin.") {
			continue
		}
		if child.Probe.Type != "none" && child.Probe.FailureThreshold == 0 {
			t.Fatalf("canonical child %s has no probe restart threshold", child.Name)
		}
		if len(child.DependsOn) > 0 && child.DependencyTimeoutPolicy != "fail-child" {
			t.Fatalf("canonical child %s dependency policy=%s", child.Name, child.DependencyTimeoutPolicy)
		}
	}
}

func TestHTTPReadinessStatusAndOperators(t *testing.T) {
	x := fakeChild("worker", "while :; do sleep 1; done")
	s := startSupervisor(t, testConfig(t, x))
	waitFor(t, 500000000, func() bool { return s.Ready() })
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	for _, tc := range []struct {
		path string
		code int
	}{{"/live", 200}, {"/ready", 200}, {"/status", 200}, {"/missing", 404}} {
		resp, err := http.Get(ts.URL + tc.path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.code {
			t.Errorf("%s status=%d", tc.path, resp.StatusCode)
		}
	}
	resp, err := http.Post(ts.URL+"/children/worker/stop", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("stop=%d", resp.StatusCode)
	}
	waitFor(t, 500000000, func() bool { st, _ := s.Child("worker"); return st.State == "stopped" })
	statusResp, err := http.Get(ts.URL + "/status")
	if err != nil {
		t.Fatal(err)
	}
	defer statusResp.Body.Close()
	var doc statusDocument
	if err = json.NewDecoder(statusResp.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	if doc.Ready || len(doc.Children) != 1 {
		t.Fatalf("bad status: %+v", doc)
	}
}
