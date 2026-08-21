package supervisor

import (
	"familiar.dev/agents/protocol"
	"testing"
)

func TestDiff(t *testing.T) {
	desired := []protocol.Assignment{{Job: protocol.Job{ID: "new", State: protocol.Assigned}}, {Job: protocol.Job{ID: "stop", State: protocol.Cancelling, CancelRequested: true}, DesiredState: protocol.Cancelling}}
	local := map[string]Worker{"stop": {Job: protocol.Job{ID: "stop"}}, "revoked": {Job: protocol.Job{ID: "revoked"}}}
	a := Diff(desired, local)
	seen := map[ActionKind]int{}
	for _, x := range a {
		seen[x.Kind]++
	}
	if seen[Start] != 1 || seen[Cancel] != 1 || seen[Forget] != 1 {
		t.Fatalf("actions %#v", a)
	}
}
