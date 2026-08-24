package server

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

// PluginManifest is the deliberately small boot-time contribution format.
// Familiar executes no plugin code in-process.
type PluginManifest struct {
	FamiliarAPI int             `toml:"familiar_api"`
	Services    []PluginService `toml:"services"`
	Pi          struct {
		Extensions []string `toml:"extensions"`
	} `toml:"pi"`
	Render PluginRender `toml:"render"`
}
type PluginService struct {
	Name      string            `toml:"name"`
	Argv      []string          `toml:"argv"`
	DependsOn []string          `toml:"depends_on"`
	Env       map[string]string `toml:"env"`
	Required  bool              `toml:"required"`
	Probe     ProbeConfig       `toml:"probe"`
}
type PluginRender struct {
	Target           string `toml:"target"`
	URL              string `toml:"render_url"`
	TTLMillis        int64  `toml:"ttl_ms"`
	InvalidateURLEnv string `toml:"invalidate_url_env"`
}
type RenderConfig struct {
	Plugin string
	URL    string
	Token  string
}

func expandRoot(value, root string) (string, error) {
	expanded := strings.ReplaceAll(value, "${plugin_root}", root)
	if strings.Contains(expanded, "${") {
		return "", fmt.Errorf("only ${plugin_root} expansion is supported")
	}
	return expanded, nil
}

// LoadPlugin appends one trusted source contribution to an existing config.
func LoadPlugin(c *Config, id, root string, environment map[string]string) ([]string, error) {
	if id == "" || !validChildName.MatchString(id) || !filepath.IsAbs(root) {
		return nil, fmt.Errorf("plugin id and absolute root are required")
	}
	manifestPath := filepath.Join(root, "contrib", "familiar", "plugin.toml")
	var manifest PluginManifest
	meta, err := toml.DecodeFile(manifestPath, &manifest)
	if err != nil {
		return nil, fmt.Errorf("plugin %s manifest: %w", id, err)
	}
	if undecoded := meta.Undecoded(); len(undecoded) != 0 {
		return nil, fmt.Errorf("plugin %s manifest: unknown key %s", id, undecoded[0])
	}
	if manifest.FamiliarAPI != 1 {
		return nil, fmt.Errorf("plugin %s requires familiar_api = 1 (got %d)", id, manifest.FamiliarAPI)
	}
	if len(manifest.Services) > 16 || len(manifest.Pi.Extensions) > 16 {
		return nil, fmt.Errorf("plugin %s manifest contribution is too large", id)
	}

	names := make(map[string]string, len(manifest.Services))
	for _, service := range manifest.Services {
		if !validChildName.MatchString(service.Name) {
			return nil, fmt.Errorf("plugin %s service name %q is invalid", id, service.Name)
		}
		if _, exists := names[service.Name]; exists {
			return nil, fmt.Errorf("plugin %s service %q is duplicated", id, service.Name)
		}
		names[service.Name] = "plugin." + id + "." + service.Name
	}
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(tokenBytes)
	callback := "http://" + c.Listen + "/internal/render-invalidate/" + id + "/" + token
	for _, service := range manifest.Services {
		argv := make([]string, len(service.Argv))
		for i, arg := range service.Argv {
			if argv[i], err = expandRoot(arg, root); err != nil {
				return nil, err
			}
		}
		if len(argv) == 0 {
			return nil, fmt.Errorf("plugin %s service %s has empty argv", id, service.Name)
		}
		env := make(map[string]string, len(environment)+len(service.Env)+1)
		for key, value := range environment {
			env[key] = value
		}
		for key, value := range service.Env {
			if env[key], err = expandRoot(value, root); err != nil {
				return nil, err
			}
		}
		if manifest.Render.InvalidateURLEnv != "" {
			env[manifest.Render.InvalidateURLEnv] = callback
		}
		deps := make([]string, len(service.DependsOn))
		for i, dep := range service.DependsOn {
			var ok bool
			if deps[i], ok = names[dep]; !ok {
				return nil, fmt.Errorf("plugin %s service %s has unknown dependency %q", id, service.Name, dep)
			}
		}
		c.Children = append(c.Children, ChildConfig{Name: names[service.Name], Argv: argv, WorkingDir: root, Env: env, Required: false, DependsOn: deps, Probe: service.Probe})
	}
	if manifest.Render.URL != "" {
		if manifest.Render.Target != "left-nav" {
			return nil, fmt.Errorf("plugin %s has unsupported render target %q", id, manifest.Render.Target)
		}
		c.Renders = append(c.Renders, RenderConfig{Plugin: id, URL: manifest.Render.URL, Token: token})
	}
	exts := make([]string, len(manifest.Pi.Extensions))
	for i, extension := range manifest.Pi.Extensions {
		if exts[i], err = expandRoot(extension, root); err != nil {
			return nil, err
		}
		if !filepath.IsAbs(exts[i]) {
			exts[i] = filepath.Join(root, exts[i])
		}
	}
	return exts, nil
}

func pluginEnvironment() map[string]string {
	out := map[string]string{}
	const prefix = "FAMILIAR_PLUGIN_ENV_"
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok && strings.HasPrefix(key, prefix) {
			out[strings.TrimPrefix(key, prefix)] = value
		}
	}
	return out
}
