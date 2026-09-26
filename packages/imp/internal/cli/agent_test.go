package cli

import (
	"reflect"
	"strings"
	"testing"
)

func TestAgentParse(t *testing.T) {
	for _, c := range []struct {
		argv []string
		op   string
		args map[string]any
	}{
		{[]string{"start", "--node", "bandit", "--kind", "claude", "--cwd", "~/src", "do the thing"}, "fleet.start",
			map[string]any{"node": "bandit", "kind": "claude", "cwd": "~/src", "task": "do the thing"}},
		{[]string{"list", "--all"}, "fleet.list", map[string]any{"all": true}},
		{[]string{"read", "a1b2c3", "--lines", "20"}, "fleet.read", map[string]any{"name": "a1b2c3", "lines": 20}},
		{[]string{"prompt", "a1b2c3", "yes, go ahead"}, "fleet.prompt", map[string]any{"name": "a1b2c3", "text": "yes, go ahead"}},
		{[]string{"keys", "a1b2c3", "down", "enter"}, "fleet.keys", map[string]any{"name": "a1b2c3", "keys": []any{"down", "enter"}}},
		{[]string{"close", "a1b2c3"}, "fleet.close", map[string]any{"name": "a1b2c3"}},
	} {
		op, args, _, err := parseAgent(c.argv)
		if err != nil || op != c.op || !reflect.DeepEqual(args, c.args) {
			t.Errorf("%v: %s %#v %v", c.argv, op, args, err)
		}
	}
	for _, bad := range [][]string{{"start"}, {"start", "--bogus", "x", "t"}, {"read"}, {"prompt", "a"}, {"keys", "a"}, {"launch", "x"}, {"read", "a", "--lines", "0"}} {
		if _, _, _, err := parseAgent(bad); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
}

func TestAgentCarriesOrigin(t *testing.T) {
	code, out, stderr := runSchedulerSocket(t, []string{"agent", "prompt", "a1b2c3", "hi"}, func(req serviceRequest) {
		if req.Op != "fleet.prompt" || req.Args["origin"] != "session-a" || req.Args["name"] != "a1b2c3" {
			t.Errorf("request: %#v", req)
		}
	})
	if code != 0 || !strings.Contains(out, "sent") {
		t.Fatalf("code=%d out=%q err=%q", code, out, stderr)
	}
}
