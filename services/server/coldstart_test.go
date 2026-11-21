//go:build unix

package server

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestFamiliarServerColdStart exercises the real shell entry point while fake
// nix/curl commands stand in for the dev shell, model network, and supervisor.
func TestFamiliarServerColdStart(t *testing.T) {
	models, env := runColdStart(t, "")
	for _, name := range []string{"llm.gguf", "stt.gguf"} {
		if got, err := os.ReadFile(filepath.Join(models, name)); err != nil || string(got) != "fake-model" {
			t.Fatalf("model %s was not atomically provisioned: %q, %v", name, got, err)
		}
	}
	for _, want := range []string{
		"FAMILIAR_MODEL_DIR=" + models,
		"FAMILIAR_MODEL_FILE=llm.gguf",
		"STT_MODEL=" + filepath.Join(models, "stt.gguf"),
		"LLAMA_BASE_URL=http://127.0.0.1:9931",
		"FAMILIAR_STT_URL=http://127.0.0.1:9932",
		"NEED_LLAMA=1",
	} {
		if !strings.Contains(env, want+"\n") {
			t.Errorf("supervisor environment missing %q", want)
		}
	}
}

// With the dev shell's hash-pinned store path, STT uses it and nothing is
// downloaded for STT.
func TestFamiliarServerColdStartNixSTTModel(t *testing.T) {
	pinned := filepath.Join(t.TempDir(), "parakeet.gguf")
	if err := os.WriteFile(pinned, []byte("pinned"), 0600); err != nil {
		t.Fatal(err)
	}
	models, env := runColdStart(t, pinned)
	if _, err := os.Stat(filepath.Join(models, "stt.gguf")); err == nil {
		t.Fatal("stt.gguf was downloaded despite FAMILIAR_STT_MODEL_PATH")
	}
	if !strings.Contains(env, "STT_MODEL="+pinned+"\n") {
		t.Errorf("STT_MODEL is not the pinned path:\n%s", env)
	}
}

func runColdStart(t *testing.T, sttPath string) (models, env string) {
	t.Helper()
	repo, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(repo, "familiar.sh")); err != nil {
		// The nix checkPhase builds services/server in isolation; the repo
		// entry point is not part of that source, so this integration test
		// only runs from a full checkout.
		t.Skipf("familiar.sh not available (isolated build): %v", err)
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	models = filepath.Join(dir, "models")
	record := filepath.Join(dir, "server.env")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	nix := `#!/bin/sh
set -eu
if [ "$1" = develop ]; then
  while [ "$1" != -c ]; do shift; done
  shift
  exec env FAMILIAR_SHELL=pi \
    FAMILIAR_MODEL_FILE=llm.gguf FAMILIAR_MODEL_URL=https://example.invalid/llm \
    FAMILIAR_STT_MODEL_FILE=stt.gguf FAMILIAR_STT_MODEL_URL=https://example.invalid/stt \
    FAMILIAR_STT_MODEL_PATH="${FAMILIAR_TEST_STT_PATH:-}" \
    "$@"
fi
if [ "$1" = run ]; then
  env | sort > "$FAMILIAR_TEST_RECORD"
  exit 0
fi
exit 9
`
	curl := `#!/bin/sh
set -eu
out=
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then out=$2; shift 2; else shift; fi
done
[ -n "$out" ]
printf fake-model > "$out"
`
	for name, body := range map[string]string{"nix": nix, "curl": curl} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	cmd := exec.Command("bash", filepath.Join(repo, "familiar.sh"), "server")
	cmd.Dir = repo
	var cleanEnv []string
	for _, entry := range os.Environ() {
		key := strings.SplitN(entry, "=", 2)[0]
		switch key {
		case "PATH", "FAMILIAR_SHELL", "FAMILIAR_CONFIG_PATH", "FAMILIAR_MODEL_DIR", "FAMILIAR_MODEL_FILE", "FAMILIAR_MODEL_URL", "FAMILIAR_STT_MODEL_FILE", "FAMILIAR_STT_MODEL_URL", "FAMILIAR_STT_MODEL_PATH", "STT_MODEL", "LLAMA_BASE_URL", "FAMILIAR_LLM_UPSTREAM", "FAMILIAR_STT_URL", "STT_UPSTREAM_URL", "FAMILIAR_TTS_URL", "FAMILIAR_TTS_UPSTREAM", "_FAMILIAR_CONFIG_EXPLICIT_ENV", "_FAMILIAR_CONFIG_LOADED_ENV":
			continue
		}
		cleanEnv = append(cleanEnv, entry)
	}
	cmd.Env = append(cleanEnv,
		"PATH="+bin+":"+os.Getenv("PATH"),
		"FAMILIAR_CONFIG_PATH="+filepath.Join(dir, "absent.toml"),
		"FAMILIAR_MODEL_DIR="+models,
		"FAMILIAR_TEST_RECORD="+record,
		"FAMILIAR_TEST_STT_PATH="+sttPath,
		"LLAMA_BASE_URL=http://localhost:9931",
		"FAMILIAR_STT_URL=http://localhost:9932",
		"FAMILIAR_TTS_URL=http://localhost:9933",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("cold start failed: %v\n%s", err, out)
	}
	got, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	return models, string(got)
}
