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
target="left-nav"
render_url="http://127.0.0.1:7340/v1/render"
invalidate_url_env="FAMILIAR_RENDER_INVALIDATE_URL"
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
