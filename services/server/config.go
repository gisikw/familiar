package server

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Duration is a TOML string duration (for example "10s").
type Duration time.Duration

func (d *Duration) UnmarshalText(text []byte) error {
	v, err := time.ParseDuration(string(text))
	if err != nil {
		return err
	}
	*d = Duration(v)
	return nil
}
func (d Duration) Value() time.Duration { return time.Duration(d) }

type Config struct {
	Listen            string         `toml:"listen"`
	StateDir          string         `toml:"state_dir"`
	ShutdownGrace     Duration       `toml:"shutdown_grace"`
	ReadHeaderTimeout Duration       `toml:"read_header_timeout"`
	TeardownPresence  bool           `toml:"teardown_presence"`
	LogMaxBytes       int64          `toml:"log_max_bytes"`
	Children          []ChildConfig  `toml:"children"`
	Renders           []RenderConfig `toml:"-"`
}

type ChildConfig struct {
	Name                    string            `toml:"name"`
	Argv                    []string          `toml:"argv"`
	WorkingDir              string            `toml:"working_dir"`
	Env                     map[string]string `toml:"env"`
	Required                bool              `toml:"required"`
	Presence                bool              `toml:"presence"`
	Detached                bool              `toml:"detached"`
	StopArgv                []string          `toml:"stop_argv"`
	DependsOn               []string          `toml:"depends_on"`
	DependencyTimeout       Duration          `toml:"dependency_timeout"`
	DependencyTimeoutPolicy string            `toml:"dependency_timeout_policy"`
	Probe                   ProbeConfig       `toml:"probe"`
	Restart                 RestartConfig     `toml:"restart"`
}

type ProbeConfig struct {
	Type             string   `toml:"type"`
	URL              string   `toml:"url"`
	Argv             []string `toml:"argv"`
	Interval         Duration `toml:"interval"`
	Timeout          Duration `toml:"timeout"`
	SuccessThreshold int      `toml:"success_threshold"`
	FailureThreshold int      `toml:"failure_threshold"`
}

type RestartConfig struct {
	Policy         string   `toml:"policy"` // always, on-failure, never
	InitialBackoff Duration `toml:"initial_backoff"`
	MaxBackoff     Duration `toml:"max_backoff"`
	Jitter         float64  `toml:"jitter"`
	MaxRestarts    int      `toml:"max_restarts"`
	Window         Duration `toml:"window"`
}

func DefaultConfig() Config {
	return Config{Listen: "127.0.0.1:9940", StateDir: "./state/server", ShutdownGrace: Duration(10 * time.Second), ReadHeaderTimeout: Duration(5 * time.Second), LogMaxBytes: 8 << 20}
}

func LoadConfig(path string) (Config, error) {
	c := DefaultConfig()
	if path == "" {
		return c, fmt.Errorf("--config is required")
	}
	meta, err := toml.DecodeFile(path, &c)
	if err != nil {
		return c, err
	}
	if undecoded := meta.Undecoded(); len(undecoded) != 0 {
		return c, fmt.Errorf("unknown configuration key %s", undecoded[0])
	}
	if !filepath.IsAbs(c.StateDir) {
		base, err := filepath.Abs(filepath.Dir(path))
		if err != nil {
			return c, err
		}
		c.StateDir = filepath.Join(base, c.StateDir)
	}
	for i := range c.Children {
		if c.Children[i].WorkingDir != "" && !filepath.IsAbs(c.Children[i].WorkingDir) {
			c.Children[i].WorkingDir = filepath.Join(filepath.Dir(path), c.Children[i].WorkingDir)
		}
		applyChildDefaults(&c.Children[i])
	}
	if root := os.Getenv("FAMILIAR_PLUGIN_ROOT"); root != "" {
		if _, err := LoadPlugin(&c, os.Getenv("FAMILIAR_PLUGIN_ID"), root, pluginEnvironment()); err != nil {
			return c, err
		}
		for i := range c.Children {
			applyChildDefaults(&c.Children[i])
		}
	}
	return c, ValidateConfig(c)
}

func applyChildDefaults(c *ChildConfig) {
	if c.DependencyTimeout == 0 {
		c.DependencyTimeout = Duration(30 * time.Second)
	}
	if c.DependencyTimeoutPolicy == "" {
		c.DependencyTimeoutPolicy = "fail-child"
	}
	if c.Probe.Type == "" {
		c.Probe.Type = "none"
	}
	if c.Probe.Interval == 0 {
		c.Probe.Interval = Duration(time.Second)
	}
	if c.Probe.Timeout == 0 {
		c.Probe.Timeout = Duration(2 * time.Second)
	}
	if c.Probe.SuccessThreshold == 0 {
		c.Probe.SuccessThreshold = 1
	}
	if c.Restart.Policy == "" {
		c.Restart.Policy = "on-failure"
	}
	if c.Restart.InitialBackoff == 0 {
		c.Restart.InitialBackoff = Duration(250 * time.Millisecond)
	}
	if c.Restart.MaxBackoff == 0 {
		c.Restart.MaxBackoff = Duration(30 * time.Second)
	}
	if c.Restart.MaxRestarts == 0 {
		c.Restart.MaxRestarts = 5
	}
	if c.Restart.Window == 0 {
		c.Restart.Window = Duration(time.Minute)
	}
}

var validChildName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

func ValidateConfig(c Config) error {
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("listen address must be loopback")
	}
	if c.StateDir == "" || c.ShutdownGrace.Value() <= 0 || c.ReadHeaderTimeout.Value() <= 0 || c.LogMaxBytes < 1024 {
		return fmt.Errorf("state_dir, positive timeouts, and log_max_bytes >= 1024 are required")
	}
	names := map[string]bool{}
	for i := range c.Children {
		x := &c.Children[i]
		applyChildDefaults(x)
		if !validChildName.MatchString(x.Name) || names[x.Name] {
			return fmt.Errorf("child name %q is invalid or duplicated", x.Name)
		}
		names[x.Name] = true
		if len(x.Argv) == 0 {
			return fmt.Errorf("child %s has empty argv", x.Name)
		}
		for key := range x.Env {
			if key == "" || strings.ContainsAny(key, "=\x00") {
				return fmt.Errorf("child %s has invalid environment key", x.Name)
			}
		}
		if x.Presence && !x.Detached {
			return fmt.Errorf("presence child %s must use detached=true so its session can outlive the supervisor", x.Name)
		}
		if x.DependencyTimeoutPolicy != "fail-child" && x.DependencyTimeoutPolicy != "start-degraded" {
			return fmt.Errorf("child %s: invalid dependency timeout policy", x.Name)
		}
		if x.Probe.Type != "none" && x.Probe.Type != "http" && x.Probe.Type != "exec" {
			return fmt.Errorf("child %s: invalid probe type", x.Name)
		}
		if x.Probe.Type == "http" && x.Probe.URL == "" || x.Probe.Type == "exec" && len(x.Probe.Argv) == 0 {
			return fmt.Errorf("child %s: incomplete probe", x.Name)
		}
		if x.Probe.SuccessThreshold < 1 || x.Probe.FailureThreshold < 0 {
			return fmt.Errorf("child %s: invalid probe thresholds", x.Name)
		}
		r := x.Restart
		if r.Policy != "always" && r.Policy != "on-failure" && r.Policy != "never" {
			return fmt.Errorf("child %s: invalid restart policy", x.Name)
		}
		if r.InitialBackoff.Value() <= 0 || r.MaxBackoff.Value() < r.InitialBackoff.Value() || r.Jitter < 0 || r.Jitter > 1 || r.MaxRestarts < 1 || r.Window.Value() <= 0 {
			return fmt.Errorf("child %s: invalid restart bounds", x.Name)
		}
	}
	for _, x := range c.Children {
		for _, d := range x.DependsOn {
			if d == x.Name || !names[d] {
				return fmt.Errorf("child %s: unknown/self dependency %q", x.Name, d)
			}
		}
	}
	if hasCycle(c.Children) {
		return fmt.Errorf("dependency graph contains a cycle")
	}
	renders := map[string]bool{}
	for _, render := range c.Renders {
		if !validChildName.MatchString(render.Plugin) || renders[render.Plugin] || !validRenderURL(render.URL) || render.Token == "" {
			return fmt.Errorf("invalid or duplicated render contribution %q", render.Plugin)
		}
		renders[render.Plugin] = true
	}
	return nil
}

func hasCycle(cs []ChildConfig) bool {
	deps := map[string][]string{}
	for _, c := range cs {
		deps[c.Name] = c.DependsOn
	}
	mark := map[string]int{}
	var visit func(string) bool
	visit = func(n string) bool {
		if mark[n] == 1 {
			return true
		}
		if mark[n] == 2 {
			return false
		}
		mark[n] = 1
		for _, d := range deps[n] {
			if visit(d) {
				return true
			}
		}
		mark[n] = 2
		return false
	}
	for n := range deps {
		if visit(n) {
			return true
		}
	}
	return false
}

func configFromEnv(path string) string {
	if path != "" {
		return path
	}
	return os.Getenv("FAMILIAR_SERVER_CONFIG")
}
