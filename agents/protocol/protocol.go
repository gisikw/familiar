// Package protocol is the canonical wire contract shared by the agent service,
// supervisors, harness adapters, and clients. JSON names are API-stable.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type State string

const (
	Pending    State = "pending"
	Assigned   State = "assigned"
	Starting   State = "starting"
	Running    State = "running"
	Blocked    State = "blocked"
	Cancelling State = "cancelling"
	Done       State = "done"
	Failed     State = "failed"
	Cancelled  State = "cancelled"
	Timeout    State = "timeout"
)

var terminal = map[State]bool{Done: true, Failed: true, Cancelled: true, Timeout: true}

func (s State) Terminal() bool { return terminal[s] }
func (s State) Valid() bool {
	switch s {
	case Pending, Assigned, Starting, Running, Blocked, Cancelling, Done, Failed, Cancelled, Timeout:
		return true
	default:
		return false
	}
}

// CanTransition validates lifecycle ordering only. A terminal transition must
// additionally carry a durable settlement, enforced by ValidateTransition and
// by the service transaction which stores the event and settlement together.
func CanTransition(from, to State, hasSettlement bool) bool {
	if from == to && !to.Terminal() {
		return true // repeated observations are harmless
	}
	if from.Terminal() {
		return from == to && hasSettlement
	}
	if to.Terminal() {
		return hasSettlement
	}
	switch from {
	case Pending:
		return to == Assigned || to == Cancelling
	case Assigned:
		return to == Starting || to == Cancelling
	case Starting:
		return to == Running || to == Blocked || to == Cancelling
	case Running:
		return to == Blocked || to == Cancelling
	case Blocked:
		return to == Running || to == Cancelling
	case Cancelling:
		return false
	default:
		return false
	}
}

func ValidateTransition(from, to State, hasSettlement bool) error {
	if !from.Valid() || !to.Valid() {
		return fmt.Errorf("unknown lifecycle transition %q -> %q", from, to)
	}
	if to.Terminal() && !hasSettlement {
		return errors.New("terminal state requires durable settlement")
	}
	if !CanTransition(from, to, hasSettlement) {
		return fmt.Errorf("illegal lifecycle transition %s -> %s", from, to)
	}
	return nil
}

type HarnessKind string
type IsolationPolicy string

const (
	HarnessPi         HarnessKind     = "pi"
	HarnessClaude     HarnessKind     = "claude"
	HarnessCodex      HarnessKind     = "codex"
	HarnessFake       HarnessKind     = "fake"
	IsolationNone     IsolationPolicy = "none"
	IsolationWorktree IsolationPolicy = "worktree"
)

type ArtifactMetadata struct {
	Directory     string            `json:"directory,omitempty"`
	RetentionDays int               `json:"retention_days,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
}

// Job identity and request fields are immutable after creation. Host, State,
// Question, Settlement, and timestamps are registry-owned reconciliation data.
type Job struct {
	ID              string           `json:"id"`
	IdempotencyKey  string           `json:"idempotency_key"`
	Harness         HarnessKind      `json:"harness"`
	Model           string           `json:"model,omitempty"`
	CWD             string           `json:"cwd"`
	Isolation       IsolationPolicy  `json:"isolation"`
	Prompt          string           `json:"prompt"`
	Artifacts       ArtifactMetadata `json:"artifacts"`
	Host            string           `json:"host"`
	State           State            `json:"state"`
	CancelRequested bool             `json:"cancel_requested,omitempty"`
	Question        *BlockedQuestion `json:"question,omitempty"`
	Settlement      *Settlement      `json:"settlement,omitempty"`
	CreatedAt       time.Time        `json:"created_at"`
	UpdatedAt       time.Time        `json:"updated_at"`
}

type CreateJob struct {
	IdempotencyKey string           `json:"idempotency_key"`
	Harness        HarnessKind      `json:"harness"`
	Model          string           `json:"model,omitempty"`
	CWD            string           `json:"cwd"`
	Isolation      IsolationPolicy  `json:"isolation,omitempty"`
	Prompt         string           `json:"prompt"`
	Artifacts      ArtifactMetadata `json:"artifacts,omitempty"`
	Host           string           `json:"host"`
}

type Assignment struct {
	Job          Job       `json:"job"`
	DesiredState State     `json:"desired_state"`
	LeaseID      string    `json:"lease_id,omitempty"`
	AssignedAt   time.Time `json:"assigned_at,omitempty"`
}

type Progress struct {
	ID      string          `json:"id"`
	JobID   string          `json:"job_id"`
	At      time.Time       `json:"at"`
	Message string          `json:"message,omitempty"`
	Percent *float64        `json:"percent,omitempty"`
	Detail  json.RawMessage `json:"detail,omitempty"` // harness-owned opaque JSON
}

type BlockedQuestion struct {
	ID     string          `json:"id"`
	Prompt string          `json:"prompt"`
	At     time.Time       `json:"at"`
	Detail json.RawMessage `json:"detail,omitempty"`
	Answer *Answer         `json:"answer,omitempty"`
}

type Answer struct {
	IdempotencyKey string          `json:"idempotency_key"`
	QuestionID     string          `json:"question_id"`
	Text           string          `json:"text"`
	At             time.Time       `json:"at,omitempty"`
	Detail         json.RawMessage `json:"detail,omitempty"`
}

type Usage struct {
	InputTokens  int64 `json:"input_tokens,omitempty"`
	OutputTokens int64 `json:"output_tokens,omitempty"`
	CostMicros   int64 `json:"cost_micros,omitempty"`
}

type ArtifactRef struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Digest string `json:"digest,omitempty"`
}

type Settlement struct {
	ID        string          `json:"id"`
	JobID     string          `json:"job_id"`
	Verdict   State           `json:"verdict"`
	Summary   string          `json:"summary,omitempty"`
	Usage     Usage           `json:"usage,omitempty"`
	Artifacts []ArtifactRef   `json:"artifacts,omitempty"`
	Detail    json.RawMessage `json:"detail,omitempty"`
	At        time.Time       `json:"at"`
}

type ObservedEvent struct {
	ID         string           `json:"id"` // delivery idempotency key
	JobID      string           `json:"job_id"`
	State      State            `json:"state,omitempty"`
	Progress   *Progress        `json:"progress,omitempty"`
	Question   *BlockedQuestion `json:"question,omitempty"`
	Settlement *Settlement      `json:"settlement,omitempty"`
	ObservedAt time.Time        `json:"observed_at,omitempty"`
}

type EventBatch struct {
	Host   string          `json:"host"`
	Events []ObservedEvent `json:"events"`
}

type PollRequest struct {
	Known map[string]State `json:"known,omitempty"`
}

type PollResponse struct {
	Assignments []Assignment `json:"assignments"`
	ServerTime  time.Time    `json:"server_time"`
}
