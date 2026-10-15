// Package decide is a System-One-style decision client over a local
// OpenAI-compatible server (vLLM / llama.cpp on the fleet). A choice is one
// forward pass: the options are single letters, output is constrained to them,
// and the answer's confidence is the softmax over their logprobs. Values are
// extracted with grammar-constrained JSON. No conversation content leaves the
// configured endpoint, which must be fleet-local.
package decide

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strings"
	"time"
)

type Client struct {
	BaseURL string // e.g. https://llama.gisi.network
	Model   string
	HTTP    *http.Client
	// SystemOneURL, when set, routes Choice to a native decision model's
	// /v1/systemone endpoint (e.g. https://decider.gisi.network). Extract and
	// Object still generate text, so they stay on BaseURL.
	SystemOneURL string
	// Calls counts round trips, for replay reports.
	Calls int
}

func FromEnv() (*Client, error) {
	base := os.Getenv("FAMILIAR_L1_DECIDER_URL")
	if base == "" {
		base = os.Getenv("FAMILIAR_LLAMA_BASE_URL")
	}
	if base == "" {
		base = os.Getenv("LLAMA_BASE_URL")
	}
	if base == "" {
		return nil, errors.New("no decider endpoint: set FAMILIAR_L1_DECIDER_URL (fleet-local only)")
	}
	model := os.Getenv("FAMILIAR_L1_DECIDER_MODEL")
	if model == "" {
		model = "qwen3.8-27b"
	}
	return &Client{
		BaseURL:      strings.TrimRight(base, "/"),
		Model:        model,
		HTTP:         &http.Client{Timeout: 60 * time.Second},
		SystemOneURL: strings.TrimRight(os.Getenv("FAMILIAR_L1_SYSTEMONE_URL"), "/"),
	}, nil
}

// choiceSystemOne asks a native decision model. Options are keyed by letter
// with the option text as the description, so long option strings stay
// descriptions rather than labels. The system prompt is prepended to the
// state: /v1/systemone has no system role.
func (c *Client) choiceSystemOne(ctx context.Context, system, state, question string, options []string) (int, []float64, error) {
	criteria := map[string]string{}
	for i, o := range options {
		criteria[string(letters[i])] = o
	}
	body, _ := json.Marshal(map[string]any{
		"state": system + "\n\n" + state,
		"questions": map[string]any{
			"q": map[string]any{"type": "choice", "instructions": question, "criteria": criteria},
		},
	})
	hr, err := http.NewRequestWithContext(ctx, "POST", c.SystemOneURL+"/v1/systemone", bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	hr.Header.Set("content-type", "application/json")
	c.Calls++
	res, err := c.HTTP.Do(hr)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	var out struct {
		Answers map[string]struct {
			Probabilities map[string]float64 `json:"probabilities"`
		} `json:"answers"`
		Error any `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return 0, nil, fmt.Errorf("systemone: %s: %w", res.Status, err)
	}
	a, ok := out.Answers["q"]
	if res.StatusCode != 200 || !ok {
		return 0, nil, fmt.Errorf("systemone: %s %v", res.Status, out.Error)
	}
	probs := make([]float64, len(options))
	best := 0
	for i := range options {
		probs[i] = a.Probabilities[string(letters[i])]
		if probs[i] > probs[best] {
			best = i
		}
	}
	return best, probs, nil
}

type msg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type req struct {
	Model       string         `json:"model"`
	Messages    []msg          `json:"messages"`
	MaxTokens   int            `json:"max_tokens"`
	Temperature float64        `json:"temperature"`
	Logprobs    bool           `json:"logprobs,omitempty"`
	TopLogprobs int            `json:"top_logprobs,omitempty"`
	Structured  map[string]any `json:"structured_outputs,omitempty"`
	ChatKwargs  map[string]any `json:"chat_template_kwargs,omitempty"`
}

type resp struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		Logprobs struct {
			Content []struct {
				Token       string `json:"token"`
				TopLogprobs []struct {
					Token   string  `json:"token"`
					Logprob float64 `json:"logprob"`
				} `json:"top_logprobs"`
			} `json:"content"`
		} `json:"logprobs"`
	} `json:"choices"`
	Error any `json:"error"`
}

func (c *Client) call(ctx context.Context, r req) (*resp, error) {
	r.Model = c.Model
	r.ChatKwargs = map[string]any{"enable_thinking": false}
	body, _ := json.Marshal(r)
	hr, err := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	hr.Header.Set("content-type", "application/json")
	c.Calls++
	res, err := c.HTTP.Do(hr)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out resp
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decider: %s: %w", res.Status, err)
	}
	if res.StatusCode != 200 || len(out.Choices) == 0 {
		return nil, fmt.Errorf("decider: %s %v", res.Status, out.Error)
	}
	return &out, nil
}

const letters = "ABCDEFGHIJKLMNOP"

// Choice asks question over state with the given options. It returns the
// winning option index and the probability distribution over all options.
func (c *Client) Choice(ctx context.Context, system, state, question string, options []string) (int, []float64, error) {
	if len(options) < 2 || len(options) > len(letters) {
		return 0, nil, errors.New("decide: 2..16 options")
	}
	if c.SystemOneURL != "" {
		return c.choiceSystemOne(ctx, system, state, question, options)
	}
	var b strings.Builder
	b.WriteString(state)
	b.WriteString("\n\nQuestion: ")
	b.WriteString(question)
	b.WriteString("\n")
	allowed := make([]string, len(options))
	for i, o := range options {
		allowed[i] = string(letters[i])
		fmt.Fprintf(&b, "%c) %s\n", letters[i], o)
	}
	b.WriteString("Answer with the letter only.")
	r, err := c.call(ctx, req{
		Messages:    []msg{{"system", system}, {"user", b.String()}},
		MaxTokens:   1,
		Temperature: 0,
		Logprobs:    true,
		TopLogprobs: min(20, len(options)+4),
		Structured:  map[string]any{"choice": allowed},
	})
	if err != nil {
		return 0, nil, err
	}
	lp := map[string]float64{}
	if lc := r.Choices[0].Logprobs.Content; len(lc) > 0 {
		for _, t := range lc[0].TopLogprobs {
			tok := strings.TrimSpace(t.Token)
			if _, ok := lp[tok]; !ok {
				lp[tok] = t.Logprob
			}
		}
	}
	probs := make([]float64, len(options))
	var z float64
	for i, a := range allowed {
		if v, ok := lp[a]; ok {
			probs[i] = math.Exp(v)
			z += probs[i]
		}
	}
	if z == 0 { // no logprobs returned: trust the constrained answer, low confidence
		ans := strings.TrimSpace(r.Choices[0].Message.Content)
		for i, a := range allowed {
			if a == ans {
				probs[i] = 0.5
				return i, probs, nil
			}
		}
		return 0, probs, errors.New("decide: unparseable answer")
	}
	best := 0
	for i := range probs {
		probs[i] /= z
		if probs[i] > probs[best] {
			best = i
		}
	}
	return best, probs, nil
}

// Extract returns a short string value using constrained JSON.
func (c *Client) Extract(ctx context.Context, system, prompt string, maxLen int) (string, error) {
	schema := map[string]any{
		"type":                 "object",
		"properties":           map[string]any{"value": map[string]any{"type": "string", "maxLength": maxLen}},
		"required":             []string{"value"},
		"additionalProperties": false,
	}
	r, err := c.call(ctx, req{
		Messages:    []msg{{"system", system}, {"user", prompt}},
		MaxTokens:   maxLen + 40,
		Temperature: 0,
		Structured:  map[string]any{"json": schema},
	})
	if err != nil {
		return "", err
	}
	var v struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal([]byte(r.Choices[0].Message.Content), &v); err != nil {
		return "", fmt.Errorf("decide: extract: %w", err)
	}
	return strings.TrimSpace(v.Value), nil
}

// Object returns a JSON object constrained by schema.
func (c *Client) Object(ctx context.Context, system, prompt string, schema map[string]any, maxTokens int) (map[string]any, error) {
	r, err := c.call(ctx, req{
		Messages:    []msg{{"system", system}, {"user", prompt}},
		MaxTokens:   maxTokens,
		Temperature: 0,
		Structured:  map[string]any{"json": schema},
	})
	if err != nil {
		return nil, err
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(r.Choices[0].Message.Content), &v); err != nil {
		return nil, fmt.Errorf("decide: object: %w", err)
	}
	return v, nil
}
