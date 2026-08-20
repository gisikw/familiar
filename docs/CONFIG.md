# Local configuration

Familiar reads the private repo-local `familiar.toml` before applying defaults
and before its first `nix develop` recursion. Copy the committed schema and
protect it before adding credentials:

```sh
cp familiar.toml.example familiar.toml
chmod 600 familiar.toml
```

`familiar.toml` is gitignored and the loader refuses any mode other than 0600.
The legacy `.env` file is not sourced or otherwise read.

## Environment mapping

TOML leaf paths are joined with `_`, uppercased, and characters other than
ASCII letters, digits, and `_` are normalized to `_`. One `FAMILIAR_` prefix is
added unless the flattened name already starts with it. Examples:

| TOML | Export |
|---|---|
| `accent = "x"` under `[theme]` | `FAMILIAR_THEME_ACCENT=x` |
| `api-key = "x"` under `[web]` | `FAMILIAR_WEB_API_KEY=x` |
| root `familiar_debug_level = "off"` | `FAMILIAR_DEBUG_LEVEL=off` |

Normalization is deterministic but does not split camelCase. Prefer snake_case.
If two TOML paths normalize to the same name, loading fails rather than choosing
one.

Values have these stable environment representations:

- strings: exact TOML string contents, including spaces and newlines;
- booleans: `true` or `false`;
- integers and floats: canonical JSON number text;
- arrays: compact JSON (for example `["one",2,false]`).

Tables are recursively flattened. Other leaf types are rejected. Nix's built-in
TOML parser is used because `nix` is the one runtime installation already
requires before a dev shell exists. Values are transferred with byte-length
framing and Bash assignment, never shell evaluation. Parser diagnostics are
suppressed so malformed files cannot echo credentials.

## Precedence and process lifetime

Precedence, highest first:

1. `FAMILIAR_*` variables present in the ambient process environment;
2. values from `familiar.toml`;
3. defaults in `familiar.sh` and `flake.nix`.

The loader records which variables were truly ambient, exports file values, and
reloads on every recursive entry. Consequently file values survive a dev shell
that sets the same name, while an explicit ambient override remains untouched.
The provenance marker and all loaded values survive `nix develop` and
`/refamiliarize` execs.

A few upstream programs require established non-Familiar names. Familiar maps
`FAMILIAR_PI_TELEMETRY`, `FAMILIAR_PI_OFFLINE`, and
`FAMILIAR_PI_SKIP_VERSION_CHECK` to their `PI_*` counterparts, and maps
`FAMILIAR_ANTHROPIC_BASE_URL`, `FAMILIAR_ANTHROPIC_API_KEY`, and
`FAMILIAR_ANTHROPIC_AUTH_TOKEN` to `ANTHROPIC_*`. An upstream name that was
explicitly ambient is preserved. Local configuration should always use the
generic Familiar names shown in `familiar.toml.example`.

## Changes and failures

After editing, keep mode 0600 and use `/refamiliarize` or stop and rerun
`./familiar.sh`. A cold restart regenerates the unified theme and restarts
services with the new exports. Malformed TOML, unsupported types, normalized-key
collisions, and insecure permissions abort startup with a generic error.

To retire a legacy `.env`, do **not** source it as a migration shortcut. Accept
only plain assignments whose quoting can be decoded without expansion, remove a
single leading `FAMILIAR_` from each key, write the values as TOML strings, then
compare the old and new effective environments without displaying values. Stop
and migrate manually if command substitutions, parameter expansion, shell
commands, or other executable syntax appears.
