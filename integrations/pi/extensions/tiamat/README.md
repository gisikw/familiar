# Tiamat pi provider

This extension discovers model/provider permutations from tiamat-router, projects the catalogue to Familiar, and materializes only selected models into Pi. Configure `[tiamat]` in `familiar.toml`; the bearer token is always read from `token_file`, never placed in Familiar's environment.

## Why there is one pi provider per Tiamat account and wire family

Pi's provider model schema has a display `name`, but no separate upstream/wire model id. Its built-in Anthropic, OpenAI Completions, and OpenAI Responses implementations serialize `model.id` into the request body. An alias such as `claude-sonnet@personal` would therefore reach the upstream and fail.

The extension instead registers IDs such as `tiamat-anthropic-claude-code-personal`, each with the clean upstream model id and a path-scoped base URL. This is more than the three family-only providers suggested by the happy-path design, but preserves duplicate catalog permutations without changing their wire model names. Provider path components are URL encoded.

`custom-provider.md` documents model-level `baseUrl`, `name`, and `id`, but no wire-id mapping. It also documents that `authHeader: true` generates `Authorization: Bearer` and that `apiKey` command values are resolved per request. The extension uses `!cat -- <token_file>` for inference and reads the same file for every catalog GET/HEAD, so token rotation does not require storing a literal secret in settings.

## JIT working set, refresh, and pre-resolution bootstrap

- Tiamat's full catalogue is control-plane state and is never registered wholesale in Pi. `TiamatPort.activate(route, model)` resolves the exact catalogue record and wire-family group, stages target plus current, calls `pi.setModel`, and only then prunes to current + previous (at most two exact route/model pairs, even when a provider has more catalogue rows). Models sharing a generated Pi provider stay grouped only when both are the two MRU rows. Failed authentication/selection restores the prior model when possible; if `setModel` throws after mutation, pruning follows the actual resulting model so a live route is never removed.
- Jittered HEAD/ETag polling (five minutes by default) updates picker truth and exact definitions only for currently materialized rows. A removed/unavailable active row becomes disabled in discovery immediately but its last usable registration is retained until a successful switch. Polling never expands the working set. `session_shutdown` clears timers; a catalogue 401 stops catalogue polling for that extension load.
- Available and degraded records remain selectable through the semantic activation port even while absent from Pi. Unavailable records remain in discovery with the router's reason and cannot be activated.
- Catalog `context_window` and `max_output_tokens` metadata becomes pi's `contextWindow` and `maxTokens`. When metadata is omitted, conservative defaults remain (128k context and 16k output). Input is text-only and reasoning is off. Costs are zero because Tiamat owns accounting.
- In UI sessions the extension polls `/tiamat/v1/providers` every five minutes and shows the active Tiamat provider's compact subscription-usage windows in the footer. Usage older than fifteen minutes is marked stale; failures are silent and never affect inference.
- A UI bridge in the same process (familiar-ui) discovers `TiamatPort` by emitting `familiar:tiamat:discover` with `{ accept(port) }`. `providers()` projects only bounded router facts (account, kind/locality, exact model availability/capabilities, usage) plus each row's generated route needed for selection and agent policy. `activate(route, model)` is the sole execution mutation boundary. Account/model-only calls from an older UI are accepted only when they map to exactly one wire family; ambiguity fails closed. `familiar:tiamat:changed` fires after catalogue/usage reconciliation. Tokens, provider configurations, and base URLs never leave the extension.
- **Pre-resolution startup:** Familiar's downstream Pi patch provides only `registerModelBootstrap(handler)`. After factories finish, Pi supplies the exact effective request (explicit CLI, restored session, or configured default), awaits handlers, and flushes queued provider registrations before scope/CLI/session/default resolution. The same runtime factory is used by initial, `/new`, `/resume`, fork/import, RPC, and print/Golemd flows. Exact generated Tiamat routes therefore start on the requested arbitrary catalogue row without a transient fallback. `session_start` repair and `familiar.tiamat.selection.v1` remain migration/outage defenses, not the normal path.
- **CLI contract:** arbitrary JIT selection is exact: use `--provider tiamat-<family>-<encoded-account> --model <wire-id>` (the standard `:<thinking>` shorthand is accepted after an exact full-id attempt), or canonical `--model tiamat-.../<wire-id>`. A bare/fuzzy `--model` carries no provider identity and does not cause Tiamat to register its catalogue; it can match only the bounded models already present for another reason. A request with no identity at all — `--list-models`, or a box with no configured default — materializes exactly one deterministic available row (the first generated route/model in sorted order). Health checks and a default-less Tiamat-only box therefore never see an empty model list, while Pi still never duplicates Tiamat's UI control-plane catalogue.
- **Degradation, not fail-closed:** Pi turns a bootstrap handler error into a startup error diagnostic, which exits pi. An unresolvable row (router outage, retired model, stale persisted default) is therefore logged and skipped rather than thrown: startup falls back to Pi's own resolution, and `session_start` repairs the selection if the catalogue returns. An exact request Pi itself cannot then resolve still fails closed in Pi, with Pi's own message. A host without `registerModelBootstrap` (plain upstream pi, or a worker whose package predates the patch) logs `bootstrapUnavailable` once and keeps the pre-patch `session_start` behaviour instead of failing to load.
- **Bounded-set consequences.** Pi-side lookups that scan the registry see only the working set: `--models`/`enabledModels` scope patterns cannot name a catalogue row that is not materialized (so Ctrl+P cycling covers the working set plus non-Tiamat providers), and zip's summarizer sibling search falls through to the session's current model instead of a cheaper sibling. Both degrade rather than break; naming a route exactly always works.
- Tiamat's Codex-backed `/responses/v1/responses` adapter rejects the standard `max_output_tokens` field. Pi's `openai-responses` client always emits it, while `openai-codex-responses` targets a different `/codex/responses` path. The extension therefore removes only that field in `before_provider_request`, scoped to `tiamat-responses-*` providers.
- If the active catalogue row disappears, discovery reports that truth while execution retains the last definition. A new unavailable/unknown activation is refused.
- A TUI/RPC `/model` selection inside the working set is adopted into the MRU on `model_select`. The adoption a running activation raises through its own `setModel` is ignored, so one atomic swap is never interleaved with a second registry mutation.

## Tests

```sh
nix develop .#agents -c bun test integrations/pi/extensions/tiamat
# real installed patched pi + real extension + stub router on loopback
nix develop .#pi -c "$(ls -d /nix/store/*nodejs*/bin/node | head -1)" test/pi-tiamat-bootstrap.mjs
```

`test/pi-tiamat-bootstrap.mjs` starts a stub router process, then runs the installed
`pi` CLI for: an exact `--provider/--model` arbitrary row, the canonical
`--model route/model` form Golemd dispatches, a configured Tiamat default, a
resumed session whose historical row is outside any MRU, the bounded
`--list-models` seed, a bare pattern that must stay bounded, the no-default seed,
and a router outage that must degrade instead of blocking startup. No model call
is made: the stub refuses inference after the session has already bound a model.
