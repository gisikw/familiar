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

The forms are mutually exclusive. Git source is fetched to `state/plugins/golem/src` and checked against the exact 40-character SHA. `[plugins.golem.env]` is string-only environment passthrough.

At boot Familiar reads Golem-owned `contrib/familiar/plugin.toml`, requires `familiar_api = 1`, and expands only `${plugin_root}`. Declared services become namespaced, optional children of the existing supervisor. Declared Pi extensions are appended once to Presence settings. With no plugin, Presence and its viewer boot without plugin chrome.

The renderer contract is a bounded JSON envelope with `render_api: 1`, positive `ttl_ms`, `target: "left-nav"`, and a semantic `tree` containing only `branch` and `item` nodes. IDs are unique. Labels and status are plain text. Items may carry `{type:"terminal",socket,session}`; the viewer rechecks the exact same-host tmux target before a writable spawn-first switch. Familiar owns all pixels, colors, layout, and input.

Familiar caches plugin renders. A boot-random scoped callback is passed as `FAMILIAR_RENDER_INVALIDATE_URL`; an empty POST coalesces an immediate refetch and wakes all long-polling viewers. TTL remains fallback. Plugin failure is nonfatal and never gates core readiness. Rollback is a Git revert; there is no legacy-provider flag.
