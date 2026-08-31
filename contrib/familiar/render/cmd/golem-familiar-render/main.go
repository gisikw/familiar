package main

import (
	"context"
	render "familiar.local/golem-render"
	"log"
	"net/http"
	"os"
	"os/signal"
)

func main() {
	endpoint := os.Getenv("GOLEM_ENDPOINT")
	if endpoint == "" {
		endpoint = "http://127.0.0.1:7337"
	}
	c, e := render.NewClient(endpoint, os.Getenv("GOLEM_TOKEN"))
	if e != nil {
		log.Fatal(e)
	}
	statePath := os.Getenv("FAMILIAR_RENDER_STATE")
	if statePath == "" {
		statePath = "/var/lib/golem/familiar-render-retired.json"
	}
	s := render.NewPersistent(c, os.Getenv("FAMILIAR_RENDER_INVALIDATE_URL"), statePath)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go s.Run(ctx)
	listen := os.Getenv("GOLEM_RENDER_LISTEN")
	if listen == "" {
		listen = "127.0.0.1:7340"
	}
	server := &http.Server{Addr: listen, Handler: s.Handler()}
	go func() { <-ctx.Done(); server.Shutdown(context.Background()) }()
	if e = server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
