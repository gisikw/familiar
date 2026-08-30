# Trusted boot-time plugins

Familiar has one reduced host seam, not a plugin platform. Its Golem pure-client contribution is stored at `contrib/familiar` (the fixed API-1 manifest location). A private instance may enroll it from an operator-trusted mutable Familiar checkout:

```toml
[plugins.golem]
path = "/absolute/path/to/familiar"
```

or from an immutable Familiar Git commit:

```toml
[plugins.golem]
git = "https://example.invalid/golem.git"
rev = "0123456789abcdef0123456789abcdef01234567"
```

The forms are mutually exclusive. Git source is fetched to `state/plugins/golem/src`, checked against the exact 40-character SHA, hard-reset detached, and cleaned with `git clean -ffdqx` before any files are consumed. The configured remote URL is checked exactly and cache paths stay inside instance state. Local paths are explicitly mutable and trusted and are not cleaned. `[plugins.golem.env]` is string-only passthrough, and deliberately overrides the plugin's service and Pi environment defaults.

The API-1 manifest is strict and exact: it may contain `[chrome]` (never `[render]`) with only `render_url`, and may contain `[pi] extensions` plus string-only `[pi.env]`. Values are bounded and only `${plugin_root}` is expanded. Pi environment entries are injected into the Presence process, so Golem receives structured CLI argv such as `GOLEM_CLI_ARGV_JSON`; Familiar does not interpret Golem names or commands and never logs these values. Declared services become namespaced, optional children of the existing supervisor. Declared Pi extensions are appended once to Presence settings. With no plugin, Presence and its viewer boot without plugin chrome.

The renderer contract is a bounded JSON envelope with `render_api: 1`, positive `ttl_ms`, `target: "left-nav"`, and a semantic `tree` containing only `branch` and `item` nodes. IDs are unique. Labels and status are plain text. Items may carry `{type:"terminal",socket,session}`; the viewer rechecks the exact same-host tmux target before a writable spawn-first switch. They may also carry `{type:"action",action}` with a bounded token. Familiar namespaces the token, renders the control, and only proxies a POST while that action remains present in the plugin's last validated tree; plugin URLs are not exposed to viewers. Familiar owns all pixels, colors, layout, and input.

Familiar exposes exactly one host-owned aggregate render surface, `GET /v1/render`, and this is the only endpoint the viewer and plugin preparation use (`FAMILIAR_RENDER_URL` is the generic `.../v1/render`). The host composes every enrolled plugin's `left-nav` contribution, in deterministic config order, under a single host tree: each plugin's own tree root is demoted to a `branch`, and every plugin node ID is namespaced `"<plugin>/<id>"` so contributions cannot collide. Terminal activation identifiers (`socket`/`session`) are never namespaced, so the viewer's exact tmux target is preserved. The aggregate exposes one revision/long-poll stream that advances whenever any plugin hub's composed contribution changes; TTL and invalidation remain internal to each hub. With no plugin, or while a plugin has not yet produced a usable render, `/v1/render` still returns a valid (possibly empty) tree and never gates core readiness. Per-plugin `GET /v1/render/{plugin}` is retained only for bounded compatibility/debugging.

Familiar caches plugin renders. For plugins with `[chrome]`, Familiar injects a boot-random, plugin-scoped callback as the host-owned `FAMILIAR_RENDER_INVALIDATE_URL`; operator and manifest environments cannot override it. An empty POST coalesces an immediate refetch and wakes all long-polling viewers. TTL remains fallback. Plugin failure is nonfatal and never gates core readiness. Rollback is a Git revert; there is no legacy-provider flag. The contribution speaks golemd's standalone v1 HTTP contract directly; Golem code is intentionally not vendored here. A Golem checkout is needed only when the explicitly configured fallback child is enabled.
