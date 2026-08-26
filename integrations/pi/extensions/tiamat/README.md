# Tiamat pi provider

This extension discovers model/provider permutations from tiamat-router and exposes them to pi. Configure `[tiamat]` in `familiar.toml`; the bearer token is always read from `token_file`, never placed in Familiar's environment.

## Why there is one pi provider per Tiamat account and wire family

Pi's provider model schema has a display `name`, but no separate upstream/wire model id. Its built-in Anthropic, OpenAI Completions, and OpenAI Responses implementations serialize `model.id` into the request body. An alias such as `claude-sonnet@personal` would therefore reach the upstream and fail.

The extension instead registers IDs such as `tiamat-anthropic-claude-code-personal`, each with the clean upstream model id and a path-scoped base URL. This is more than the three family-only providers suggested by the happy-path design, but preserves duplicate catalog permutations without changing their wire model names. Provider path components are URL encoded.

`custom-provider.md` documents model-level `baseUrl`, `name`, and `id`, but no wire-id mapping. It also documents that `authHeader: true` generates `Authorization: Bearer` and that `apiKey` command values are resolved per request. The extension uses `!cat -- <token_file>` for inference and reads the same file for every catalog GET/HEAD, so token rotation does not require storing a literal secret in settings.

## Refresh and limitations

- Pi's `refreshModels` performs full GET discovery and refreshes the selected provider's models only. It deliberately does not mutate the provider registry from inside the callback: `registerProvider` initiates model refresh, so doing so creates a refresh/re-registration loop and can retain a stale extension context after shutdown.
- While a session is active, jittered HEAD/ETag polling (five minutes by default) owns provider topology, registering newly introduced permutations and removing decommissioned ones. `session_shutdown` clears the timer. A 401 pauses timer network work until a successful manual model refresh.
- Unavailable records are hidden; degraded records remain with `(degraded)` in their display name.
- Catalog `context_window` and `max_output_tokens` metadata becomes pi's `contextWindow` and `maxTokens`. When metadata is omitted, conservative defaults remain (128k context and 16k output). Input is text-only and reasoning is off. Costs are zero because Tiamat owns accounting.
- In UI sessions the extension polls `/tiamat/v1/providers` every five minutes and shows the active Tiamat provider's compact subscription-usage windows in the footer. Usage older than fifteen minutes is marked stale; failures are silent and never affect inference.
- Tiamat's Codex-backed `/responses/v1/responses` adapter rejects the standard `max_output_tokens` field. Pi's `openai-responses` client always emits it, while `openai-codex-responses` targets a different `/codex/responses` path. The extension therefore removes only that field in `before_provider_request`, scoped to `tiamat-responses-*` providers.
- Pi's behavior if the currently selected model disappears is not specified. The extension logs the removal and otherwise leaves pi's behavior untouched.
