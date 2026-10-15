package decide

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestChoiceSoftmaxOverOptionLogprobs(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		so := body["structured_outputs"].(map[string]any)["choice"].([]any)
		if len(so) != 3 || body["max_tokens"].(float64) != 1 {
			t.Errorf("request not constrained: %v", body)
		}
		w.Write([]byte(`{"choices":[{"message":{"content":"B"},"logprobs":{"content":[{"token":"B","top_logprobs":[
			{"token":"B","logprob":` + f(math.Log(0.6)) + `},{"token":"A","logprob":` + f(math.Log(0.2)) + `},
			{"token":"\"","logprob":-9999},{"token":"C","logprob":` + f(math.Log(0.1)) + `}]}]}}]}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Model: "m", HTTP: srv.Client()}
	i, p, err := c.Choice(context.Background(), "sys", "state", "q?", []string{"a", "b", "c"})
	if err != nil || i != 1 {
		t.Fatalf("i=%d err=%v", i, err)
	}
	if math.Abs(p[1]-0.6/0.9) > 1e-9 || math.Abs(p[0]+p[1]+p[2]-1) > 1e-9 {
		t.Fatalf("probs %v", p)
	}
}

func f(v float64) string { b, _ := json.Marshal(v); return string(b) }

func TestChoiceSystemOne(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/systemone" {
			t.Errorf("path %s", r.URL.Path)
		}
		var body struct {
			State     string `json:"state"`
			Questions map[string]struct {
				Type     string            `json:"type"`
				Criteria map[string]string `json:"criteria"`
			} `json:"questions"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		q := body.Questions["q"]
		if q.Type != "choice" || q.Criteria["B"] != "b" || len(q.Criteria) != 3 || body.State != "sys\n\nstate" {
			t.Errorf("bad request: %+v", body)
		}
		w.Write([]byte(`{"answers":{"q":{"type":"choice","choice":"C","probabilities":{"A":0.1,"B":0.2,"C":0.7}}}}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: "http://unused.invalid", SystemOneURL: srv.URL, HTTP: srv.Client()}
	i, p, err := c.Choice(context.Background(), "sys", "state", "q?", []string{"a", "b", "c"})
	if err != nil || i != 2 || math.Abs(p[2]-0.7) > 1e-9 || c.Calls != 1 {
		t.Fatalf("i=%d p=%v err=%v calls=%d", i, p, err, c.Calls)
	}
}
