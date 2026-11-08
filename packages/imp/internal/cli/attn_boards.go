package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
)

// writeAttnBoard renders board.view: Kes's queues, in-flight (Running,
// Proving), Kev's Todo and Review, then Icebox/Archived counts and any legacy
// lanes still holding cards.
func writeAttnBoard(w io.Writer, raw json.RawMessage) error {
	var b struct {
		Project string                     `json:"project"`
		Columns map[string]json.RawMessage `json:"columns"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return err
	}
	section := func(name string, col json.RawMessage, collapsed bool) error {
		items, total, _, err := attnList(col)
		if err != nil {
			return err
		}
		fmt.Fprintf(w, "%s (%d)\n", name, total)
		if collapsed {
			return nil
		}
		for i, it := range items {
			if i == 10 {
				fmt.Fprintf(w, "  … and %d more (imp attn card view --view %s --project %s)\n", total-10, strings.ToLower(strings.Fields(name)[0]), b.Project)
				break
			}
			var c attnCard
			if err := json.Unmarshal(it, &c); err != nil {
				return err
			}
			fmt.Fprintln(w, "  "+attnRow(c))
		}
		return nil
	}
	fmt.Fprintf(w, "%s\n", b.Project)
	var q map[string]json.RawMessage
	_ = json.Unmarshal(b.Columns["queue"], &q)
	fmt.Fprintln(w, "— Kes —")
	for _, k := range []string{"just-do-it", "build-but-wait", "help-me-think"} {
		if err := section("Queue "+k, q[k], false); err != nil {
			return err
		}
	}
	for _, k := range []string{"running", "proving"} {
		if err := section(strings.ToUpper(k[:1])+k[1:], b.Columns[k], false); err != nil {
			return err
		}
	}
	fmt.Fprintln(w, "— Kev —")
	for _, k := range []string{"todo", "review"} {
		if err := section(strings.ToUpper(k[:1])+k[1:], b.Columns[k], false); err != nil {
			return err
		}
	}
	for _, k := range []string{"icebox", "archived"} {
		if err := section(strings.ToUpper(k[:1])+k[1:]+" ▸", b.Columns[k], true); err != nil {
			return err
		}
	}
	var legacy map[string]json.RawMessage
	_ = json.Unmarshal(b.Columns["legacy"], &legacy)
	if len(legacy) > 0 {
		fmt.Fprintln(w, "— legacy lanes (until migrated) —")
		keys := []string{}
		for k := range legacy {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if err := section(k, legacy[k], true); err != nil {
				return err
			}
		}
	}
	return nil
}

func writeAttnMigration(w io.Writer, raw json.RawMessage) error {
	var r struct {
		Cards   int            `json:"cards"`
		Moves   map[string]int `json:"moves"`
		Snoozed map[string]int `json:"snoozed"`
		Weeks   []struct {
			Week  int `json:"week"`
			Kevin int `json:"kevin"`
			Kes   int `json:"kes"`
		} `json:"weeks"`
		Token string `json:"token"`
		Ran   bool   `json:"ran"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return err
	}
	verb := "would move"
	if r.Ran {
		verb = "moved"
	}
	fmt.Fprintf(w, "lanes-v3 migration: %s %d cards\n", verb, r.Cards)
	keys := []string{}
	for k := range r.Moves {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(w, "  %-32s %d\n", k, r.Moves[k])
	}
	fmt.Fprintf(w, "snoozed: Kev's %d (wake first), Kes's %d\nwake week  Kev  Kes\n", r.Snoozed["kevin"], r.Snoozed["kes"])
	for _, wk := range r.Weeks {
		fmt.Fprintf(w, "  %4d     %3d  %3d  %s\n", wk.Week, wk.Kevin, wk.Kes, strings.Repeat("▇", wk.Kevin+wk.Kes))
	}
	if !r.Ran {
		fmt.Fprintf(w, "run exactly this plan: imp attn migrate lanes --run --token %s\n", r.Token)
	}
	return nil
}
