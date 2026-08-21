# @familiar/config

Canonical typed model and Bun TOML loader for `familiar.toml`, including the documented `[server]` and `[agents]` launch settings. It validates documented tables, applies defaults, then applies `FAMILIAR_*` environment overrides. Ambient variables win; `[familiar]` does not double the prefix. Files default to optional but, when present, must be mode `0600`.

```ts
const { config, environment } = await loadConfig("familiar.toml");
console.log(redactConfig(config));
```

The loader does not mutate `process.env`; `environment` is the validated snapshot a later consumer can export. Current shell/Nix consumers can migrate table-by-table without changing their existing loader first.

## Errors and secrets

Errors name paths but never values. Claude credential forms are mutually exclusive and credential JSON shape is checked. `redactConfig` recursively replaces token/key/credential fields before logging.

Run `bun test` and `bun run typecheck`.
