# Trusted boot-time plugins

Familiar has one reduced host seam, not a plugin platform. A private instance may enroll Golem from operator-trusted mutable source:

```toml
[plugins.golem]
path = "/absolute/path/to/golem"
```

or from an immutable Git commit:

```toml
[plugins.golem]
git = "https://example.invalid/golem.git"
rev = "0123456789abcdef0123456789abcdef01234567"
```

The forms are mutually exclusive. Git source is fetched to `state/plugins/golem/src`, checked against the exact 40-character SHA, hard-reset detached, and cleaned with `git clean -ffdqx` before any files are consumed. The configured remote URL is checked exactly and cache paths stay inside instance state. Local paths are explicitly mutable and trusted and are not cleaned. `[plugins.golem.env]` is string-only passthrough, and deliberately overrides the plugin's service and Pi environment defaults.

The API-1 manifest is strict and exact: it requires `[chrome]` (never `[render]`) with `render_url`, and may contain `[pi] extensions` plus string-only `[pi.env]`. Values are bounded and only `${plugin_root}` is expanded. Pi environment entries are injected into the Presence process, so Golem receives structured CLI argv such as `GOLEM_CLI_ARGV_JSON`; Familiar does not interpret Golem names or commands and never logs these values. Declared services become namespaced, optional children of the existing supervisor. Declared Pi extensions are appended once to Presence settings. With no plugin, Presence and its viewer boot without plugin chrome.

The renderer contract is a bounded JSON envelope with `render_api: 1`, positive `ttl_ms`, `target: "left-nav"`, and a semantic `tree` containing only `branch` and `item` nodes. IDs are unique. Labels and status are plain text. Items may carry `{type:"terminal",socket,session}`; the viewer rechecks the exact same-host tmux target before a writable spawn-first switch. Familiar owns all pixels, colors, layout, and input.

Familiar caches plugin renders. A boot-random scoped callback is passed as `FAMILIAR_RENDER_INVALIDATE_URL`; an empty POST coalesces an immediate refetch and wakes all long-polling viewers. TTL remains fallback. Plugin failure is nonfatal and never gates core readiness. Rollback is a Git revert; there is no legacy-provider flag. This host branch requires the coordinated Golem follow-up commit `c94845072c4b7297eddc0bf40f902c5759371586` (or a merged equivalent); Golem code is intentionally not vendored here.
