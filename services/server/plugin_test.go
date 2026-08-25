package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeManifest(t *testing.T, text string) string {
	t.Helper()
	root := t.TempDir()
	p := filepath.Join(root, "contrib/familiar")
	if err := os.MkdirAll(p, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p, "plugin.toml"), []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	return root
}
func TestLoadPluginCompilesOptionalNamespacedServicesAndExtensionOnce(t *testing.T) {
	root := writeManifest(t, `familiar_api=1
[[services]]
name="service"
argv=["run","${plugin_root}/bin"]
required=true
[[services]]
name="render"
argv=["run"]
depends_on=["service"]
[pi]
extensions=["${plugin_root}/contrib/familiar/pi"]
[chrome]
render_url="http://127.0.0.1:7340/v1/render"
[pi.env]
GOLEM_CLI_ARGV_JSON="[\"golem\",\"--root\",\"${plugin_root}\"]"
`)
	c := DefaultConfig()
	c.Children = append(c.Children, ChildConfig{Name: "presence", Presence: true})
	exts, err := LoadPlugin(&c, "golem", root, map[string]string{"GOLEM_DB": "/state/db", "GOLEM_CLI_ARGV_JSON": "instance"})
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Children) != 3 || c.Children[1].Name != "plugin.golem.service" || c.Children[1].Required {
		t.Fatalf("children=%+v", c.Children)
	}
	if got := c.Children[2].DependsOn; len(got) != 1 || got[0] != "plugin.golem.service" {
		t.Fatal(got)
	}
	if c.Children[0].Env["GOLEM_CLI_ARGV_JSON"] != "instance" {
		t.Fatalf("instance env did not win: %+v", c.Children[0].Env)
	}
	if len(exts) != 1 || exts[0] != filepath.Join(root, "contrib/familiar/pi") {
		t.Fatal(exts)
	}
	if !strings.Contains(c.Children[1].Argv[1], root) || c.Children[1].Env["GOLEM_DB"] != "/state/db" || c.Children[1].Env["FAMILIAR_RENDER_INVALIDATE_URL"] == "" {
		t.Fatal(c.Children[0])
	}
	if len(c.Renders) != 1 || c.Renders[0].URL != "http://127.0.0.1:7340/v1/render" {
		t.Fatalf("renders=%+v", c.Renders)
	}
}
func TestLoadPluginHostOwnedCallbackCannotBeOverridden(t *testing.T) {
	root := writeManifest(t, `familiar_api=1
[[services]]
name="service"
argv=["run"]
[services.env]
FAMILIAR_RENDER_INVALIDATE_URL="plugin"
[chrome]
render_url="http://127.0.0.1:7340/v1/render"
`)
	c := DefaultConfig()
	_, err := LoadPlugin(&c, "golem", root, map[string]string{"FAMILIAR_RENDER_INVALIDATE_URL": "operator"})
	if err != nil {
		t.Fatal(err)
	}
	callback := c.Children[0].Env["FAMILIAR_RENDER_INVALIDATE_URL"]
	if callback == "" || callback == "operator" || callback == "plugin" || !strings.Contains(callback, "/internal/render-invalidate/golem/") {
		t.Fatalf("callback=%q", callback)
	}
}

func TestLoadPluginWithoutChromeHasNoCallback(t *testing.T) {
	root := writeManifest(t, `familiar_api=1
[[services]]
name="service"
argv=["run"]
`)
	c := DefaultConfig()
	if _, err := LoadPlugin(&c, "plain", root, map[string]string{"FAMILIAR_RENDER_INVALIDATE_URL": "operator"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Children[0].Env["FAMILIAR_RENDER_INVALIDATE_URL"]; ok || len(c.Renders) != 0 {
		t.Fatalf("children=%+v renders=%+v", c.Children, c.Renders)
	}
}

func TestBundledGolemClientManifestLoads(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	c := DefaultConfig()
	c.Children = append(c.Children, ChildConfig{Name: "presence", Presence: true})
	exts, err := LoadPlugin(&c, "golem", root, map[string]string{"GOLEM_ENDPOINT": "unix:///tmp/golemd.sock"})
	if err != nil {
		t.Fatal(err)
	}
	if len(exts) != 1 || !strings.HasSuffix(exts[0], "contrib/familiar/pi/agents") || len(c.Renders) != 1 || len(c.Children) != 3 {
		t.Fatalf("extensions=%v renders=%v children=%v", exts, c.Renders, c.Children)
	}
	if c.Children[0].Env["GOLEM_ENDPOINT"] != "unix:///tmp/golemd.sock" || c.Children[2].Env["GOLEM_ENDPOINT"] != "unix:///tmp/golemd.sock" {
		t.Fatalf("operator endpoint did not reach presence and render: %+v %+v", c.Children[0].Env, c.Children[2].Env)
	}
}

func TestLoadPluginRejectsAPIMismatchAndUnknownExpansion(t *testing.T) {
	for _, text := range []string{`familiar_api=2
[chrome]`, `familiar_api=1
[[services]]
name="x"
argv=["${other}"]`, `familiar_api=1
[render]
render_url="x"`} {
		c := DefaultConfig()
		if _, err := LoadPlugin(&c, "golem", writeManifest(t, text), nil); err == nil {
			t.Fatal("accepted invalid manifest")
		}
	}
}
