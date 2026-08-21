package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"familiar.local/tts/internal/service"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func integer(k string, d int) int {
	v, e := strconv.Atoi(env(k, ""))
	if e == nil {
		return v
	}
	return d
}
func duration(k string, d time.Duration) time.Duration {
	v, e := time.ParseDuration(env(k, ""))
	if e == nil {
		return v
	}
	return d
}
func main() {
	var listen string
	c := service.Config{}
	flag.StringVar(&listen, "listen", env("FAMILIAR_TTS_LISTEN", "127.0.0.1:9933"), "proxy listen address")
	flag.StringVar(&c.Upstream, "upstream", env("FAMILIAR_TTS_UPSTREAM", ""), "configured upstream base URL")
	flag.StringVar(&c.Backend, "backend", env("FAMILIAR_TTS_BACKEND", "http://127.0.0.1:19933"), "local backend URL")
	flag.StringVar(&c.BackendCommand, "backend-command", env("FAMILIAR_TTS_BACKEND_COMMAND", "tts-server"), "local backend executable")
	args := env("FAMILIAR_TTS_BACKEND_ARGS", "")
	if args != "" {
		c.BackendArgs = strings.Fields(args)
	}
	flag.StringVar(&c.Model, "model", env("FAMILIAR_TTS_MODEL", ""), "Kokoro model path (defaults under state-dir)")
	flag.StringVar(&c.ModelURL, "model-url", env("FAMILIAR_TTS_MODEL_URL", "https://huggingface.co/mmwillet2/Kokoro_GGUF/resolve/main/Kokoro_espeak_Q8.gguf"), "download URL when model is absent")
	flag.StringVar(&c.Voice, "voice", env("FAMILIAR_TTS_VOICE", ""), "backend default voice")
	flag.StringVar(&c.VoicesSource, "voices-source", env("FAMILIAR_TTS_VOICES_SOURCE", ""), "directory of .pt/.pt.age packs")
	flag.StringVar(&c.StateDir, "state-dir", env("FAMILIAR_TTS_STATE_DIR", "./state"), "private runtime state")
	flag.StringVar(&c.AgeKey, "age-key", env("FAMILIAR_TTS_AGE_KEY", ""), "age identity file")
	flag.StringVar(&c.Baker, "baker", env("FAMILIAR_TTS_BAKER", "familiar-bake-kokoro"), "voice baker executable")
	flag.Parse()
	if c.Model == "" {
		c.Model = c.StateDir + "/models/Kokoro_espeak_Q8.gguf"
	}
	c.MaxBody = int64(integer("FAMILIAR_TTS_MAX_BODY", 1<<20))
	c.MaxInput = integer("FAMILIAR_TTS_MAX_INPUT", 65536)
	c.Concurrency = integer("FAMILIAR_TTS_CONCURRENCY", 4)
	c.StartupTimeout = duration("FAMILIAR_TTS_STARTUP_TIMEOUT", 60*time.Second)
	c.RequestTimeout = duration("FAMILIAR_TTS_REQUEST_TIMEOUT", 5*time.Minute)
	c.ShutdownTimeout = duration("FAMILIAR_TTS_SHUTDOWN_TIMEOUT", 5*time.Second)
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	proxy, err := service.New(c, log)
	if err != nil {
		log.Error("configuration error", "error", err)
		os.Exit(2)
	}
	defer proxy.Close()
	srv := &http.Server{Addr: listen, Handler: proxy.Handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		log.Info("TTS proxy listening", "address", listen)
		if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			log.Error("server failed", "error", e)
			os.Exit(1)
		}
	}()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shut, cancel := context.WithTimeout(context.Background(), c.ShutdownTimeout)
	defer cancel()
	_ = srv.Shutdown(shut)
}
