package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFillAskForkTargetsUsesLineageRoot(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(filepath.Join(state, "forks", "child"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "forks", "child", "fork.json"), []byte(`{"parentSessionId":"primary"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"FAMILIAR_INSTANCE_ID": "child", "FAMILIAR_STATE_DIR": state}
	getenv := func(k string) string { return env[k] }
	args := map[string]any{"actions": []any{
		map[string]any{"key": "go", "fork": map[string]any{"task": "x"}},
		map[string]any{"key": "set", "fork": map[string]any{"task": "y", "target": "instance:other"}},
		map[string]any{"key": "plain"},
	}}
	if err := fillAskForkTargets(args, getenv); err != nil {
		t.Fatal(err)
	}
	acts := args["actions"].([]any)
	if got := acts[0].(map[string]any)["fork"].(map[string]any)["target"]; got != "instance:primary" {
		t.Fatalf("filled target %v", got)
	}
	if got := acts[1].(map[string]any)["fork"].(map[string]any)["target"]; got != "instance:other" {
		t.Fatalf("explicit target overwritten: %v", got)
	}
	if _, has := acts[2].(map[string]any)["fork"]; has {
		t.Fatal("fork added to a plain action")
	}
	if err := fillAskForkTargets(map[string]any{"actions": []any{map[string]any{"fork": map[string]any{"task": "x"}}}}, func(string) string { return "" }); err == nil {
		t.Fatal("want an error without an instance")
	}
}
