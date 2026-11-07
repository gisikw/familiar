package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// imp host deploy: ask a fortress host to build main for a deploy, the way
// Kev approves it. The host (fortress-approve 0.7+) builds main's head (or
// --commit, a commit on main) as an ordinary request on its page; Kev
// approves it with his passkey, on the page or from the approval card in the
// chat (which can approve while it still builds). Asking deploys nothing.
//
// The shape follows imp host run: submit, print the page and a line the card
// reads, push Kev's phone, start a watcher outside this Pi, then block a
// while. Whoever claims the delivered marker first reports it, once.

var hostCommitRe = regexp.MustCompile(`^[0-9a-f]{40}$`)

// How long a blocking deploy waits for Kev before handing over to the
// watcher, and how long after his approval for the switch to settle.
var hostDeployWait = 5 * time.Minute
var hostDeploySettleWait = 7 * time.Minute

// hostDeployView is the host's view of one deploy request (deploys.go there).
type hostDeployView struct {
	Host   string `json:"host"`
	Deploy struct {
		ID         string    `json:"id"`
		Reason     string    `json:"reason"`
		Commit     string    `json:"commit"`
		Subject    string    `json:"subject"`
		CVEs       []string  `json:"cves"`
		Created    time.Time `json:"created"`
		State      string    `json:"state"`
		Note       string    `json:"note"`
		Settled    bool      `json:"settled"`
		Approvable string    `json:"approvable"`
		Code       string    `json:"code"`
		Diff       string    `json:"diff"`
		BuildLog   string    `json:"buildLog"`
		Health     string    `json:"health"`
		Healthy    string    `json:"healthy"`
		Deployed   string    `json:"deployed"`
	} `json:"deploy"`
}

func short(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}

func (h hostCtx) fetchDeploy(host, id string) (hostDeployView, error) {
	var v hostDeployView
	raw, e := h.call("deploy-status", host, id)
	if e != nil {
		return v, e
	}
	if e := json.Unmarshal(raw, &v); e != nil || v.Deploy.ID == "" {
		return v, fmt.Errorf("unreadable answer from %s: %.200s", host, raw)
	}
	return v, nil
}

func (h hostCtx) deploy(host, reason, commit string, async bool) int {
	args := []string{"deploy", host}
	if commit != "" {
		args = append(args, "--commit", commit)
	}
	raw, e := h.call(append(args, reason)...)
	if e != nil {
		return branchError(h.errw, e)
	}
	var sub struct{ ID, Commit, Subject, Page, URL string }
	if e := json.Unmarshal(raw, &sub); e != nil || !hostRunIDRe.MatchString(sub.ID) || !hostCommitRe.MatchString(sub.Commit) {
		return branchError(h.errw, fmt.Errorf("unreadable answer from %s: %.200s", host, raw))
	}
	url := sub.URL
	if url == "" {
		url = sub.Page
	}
	key := "deploy-" + sub.ID
	h.saveDeploy(host, sub.ID, url, nil)
	fmt.Fprintln(h.out, url)
	fmt.Fprintf(h.out, "%s deploy %s · commit %s · %s\n", host, sub.ID, short(sub.Commit), clip(sub.Subject, 120))
	var discard bytes.Buffer
	push := fmt.Sprintf("%s\n%s %s\n%s", clip(reason, 160), short(sub.Commit), clip(sub.Subject, 100), url)
	pushArgs := []string{"push", "--title", host + " deploy request", "--url", url, push}
	code := Main(pushArgs, strings.NewReader(""), &discard, &discard, h.getenv)
	if code != 0 {
		discard.Reset()
		code = Main(append(pushArgs[:3:3], push), strings.NewReader(""), &discard, &discard, h.getenv)
	}
	if code != 0 {
		fmt.Fprintf(h.errw, "imp: phone push failed: %s", discard.String())
	} else {
		fmt.Fprintln(h.out, "pushed to Kev's phone")
	}
	if !async {
		h.touchLease(host, key)
	}
	if code := h.startWatchCmd("_watch-deploy", key, host, sub.ID, url, hostTarget(h.getenv, "")); code != 0 {
		fmt.Fprintf(h.errw, "imp: the deploy is requested, but no watcher: check it with imp host deploy-result %s %s\n", host, sub.ID)
		if async {
			return code
		}
	}
	if async {
		return 0
	}
	return h.blockDeploy(host, sub.ID, url)
}

func (h hostCtx) blockDeploy(host, id, url string) int {
	key := "deploy-" + id
	defer removeLease(h, host, key)
	fmt.Fprintf(h.out, "building; waiting up to %s for Kev's passkey…\n", hostDeployWait)
	start := hostNow()
	var approvedAt time.Time
	last := ""
	for {
		h.touchLease(host, key)
		v, e := h.fetchDeploy(host, id)
		if e == nil {
			st := v.Deploy.State
			if st != last {
				last = st
				h.saveDeploy(host, id, url, &v)
			}
			if v.Deploy.Settled {
				if !h.claim(host, key) {
					fmt.Fprintf(h.out, "%s (the watcher already delivered it)\n", h.deploySummary(host, v))
					return 0
				}
				io.WriteString(h.out, "\n"+h.deployReport(host, v, url))
				return 0
			}
			if approvedAt.IsZero() && (st == "deploying" || strings.Contains(v.Deploy.Note, "approved")) {
				approvedAt = hostNow()
				fmt.Fprintln(h.out, "approved; waiting for it to deploy…")
			}
		}
		now := hostNow()
		if (approvedAt.IsZero() && now.Sub(start) >= hostDeployWait) || (!approvedAt.IsZero() && now.Sub(approvedAt) >= hostDeploySettleWait) {
			st := last
			if st == "" {
				st = "unknown (the host didn't answer)"
			}
			fmt.Fprintf(h.out, "still %s after %s: %s\nThe watcher has it; you'll be notified when it settles.\n", st, now.Sub(start).Round(time.Second), url)
			return 0
		}
		hostSleep(hostBlockPoll)
	}
}

// watchDeploy polls until the deploy settles (or the host forgets it: a
// request nobody approved is pruned after a day), then notifies once.
func (h hostCtx) watchDeploy(host, id, url, target string) int {
	key := "deploy-" + id
	deadline := hostNow().Add(25 * time.Hour)
	last, failing := "", 0
	for {
		v, e := h.fetchDeploy(host, id)
		switch {
		case e != nil:
			failing++
			fmt.Fprintf(h.errw, "poll %s deploy %s: %v\n", host, id, e)
			if strings.Contains(e.Error(), "no such deploy") {
				if !h.leaseFresh(host, key) && h.claim(host, key) {
					h.notify(target, host, key, fmt.Sprintf("%s deploy %s expired: never approved, and the host has forgotten it", host, id), "")
				}
				return 1
			}
		default:
			failing = 0
			if !v.Deploy.Created.IsZero() {
				deadline = v.Deploy.Created.Add(24*time.Hour + 30*time.Minute)
			}
			if v.Deploy.State != last {
				last = v.Deploy.State
				h.saveDeploy(host, id, url, &v)
				blocked := h.leaseFresh(host, key)
				if blocked {
					last = ""
				}
				switch {
				case v.Deploy.Settled && !blocked:
					if h.claim(host, key) {
						h.notify(target, host, key, h.deploySummary(host, v), h.deployReport(host, v, url))
					}
					return 0
				}
			}
		}
		if hostNow().After(deadline) {
			why := "the host never said it settled"
			if failing > 0 {
				why = fmt.Sprintf("the last %d polls failed", failing)
			}
			h.notify(target, host, key, fmt.Sprintf("%s deploy %s: stopped watching after 24h (%s); imp host deploy-result %s %s", host, id, why, host, id), "")
			return 1
		}
		hostSleep(hostPoll)
	}
}

func (h hostCtx) deploySummary(host string, v hostDeployView) string {
	d := v.Deploy
	s := fmt.Sprintf("%s deploy %s %s", host, d.ID, d.State)
	if d.State == "deployed" && d.Healthy != "" {
		s += ", healthy " + d.Healthy
	}
	if d.Reason != "" {
		s += ": " + clip(d.Reason, 120)
	}
	return s
}

func (h hostCtx) deployReport(host string, v hostDeployView, url string) string {
	d := v.Deploy
	var b strings.Builder
	b.WriteString(h.deploySummary(host, v) + "\n")
	fmt.Fprintf(&b, "commit: %s %s\n", short(d.Commit), d.Subject)
	if d.Note != "" {
		fmt.Fprintf(&b, "note: %s\n", d.Note)
	}
	if d.Code != "" {
		fmt.Fprintf(&b, "check code: %s\n", d.Code)
	}
	if d.Deployed != "" && d.Deployed != d.Commit {
		fmt.Fprintf(&b, "deployed there now: %s\n", short(d.Deployed))
	}
	if url != "" {
		fmt.Fprintf(&b, "page: %s\n", url)
	}
	if d.Health != "" {
		b.WriteString("\nhealth" + trimOutput(d.Health, 40, 4000))
	}
	if d.BuildLog != "" {
		b.WriteString("\nbuild log" + trimOutput(d.BuildLog, 40, 4000))
	}
	if d.Diff != "" && !d.Settled {
		b.WriteString("\ndiff" + trimOutput(d.Diff, 40, 4000))
	}
	return b.String()
}

// saveDeploy keeps the request's folder: the page URL and the latest view.
func (h hostCtx) saveDeploy(host, id, url string, v *hostDeployView) {
	dir := h.dir(host, "deploy-"+id)
	if os.MkdirAll(dir, 0o755) != nil {
		return
	}
	if url != "" {
		_ = os.WriteFile(filepath.Join(dir, "url"), []byte(url+"\n"), 0o644)
	}
	if v == nil {
		return
	}
	if b, e := json.MarshalIndent(v, "", "  "); e == nil {
		_ = os.WriteFile(filepath.Join(dir, "deploy.json"), append(b, '\n'), 0o600)
	}
}

func removeLease(h hostCtx, host, key string) {
	_ = os.Remove(filepath.Join(h.dir(host, key), "blocking"))
}
