package cli

import (
	"testing"
	"time"
)

func TestParseInDays(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"11d":   11 * 24 * time.Hour,
		"2d3h":  51 * time.Hour,
		"90m":   90 * time.Minute,
		"1d30m": 24*time.Hour + 30*time.Minute,
	} {
		got, err := parseIn(in)
		if err != nil || got != want {
			t.Errorf("parseIn(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := parseIn("xd"); err == nil {
		t.Error("parseIn(xd) should fail")
	}
}

func TestParseAtCalendarDate(t *testing.T) {
	loc, _ := time.LoadLocation("America/Chicago")
	now := time.Date(2026, 11, 2, 9, 0, 0, 0, loc)
	cases := map[string]time.Time{
		"2026-11-13 09:00": time.Date(2026, 11, 13, 9, 0, 0, 0, loc),
		"2026-11-13T14:30": time.Date(2026, 11, 13, 14, 30, 0, 0, loc),
		"2026-11-13":       time.Date(2026, 11, 13, 9, 0, 0, 0, loc),
	}
	for in, want := range cases {
		got, err := parseAt(in, now)
		if err != nil || !got.Equal(want) {
			t.Errorf("parseAt(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := parseAt("2026-11-01", now); err == nil {
		t.Error("a past date should be refused, not silently rolled")
	}
}
