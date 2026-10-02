# Identity prompt assembler

`index.ts` replaces Pi's system prompt on every turn. `prompt.ts` is the
assembler; `index.test.ts` pins both the intentional divergences and the
parity-owned structure against the pinned Pi (1.0.0, `nix/patches/pi-coding-agent`).

Kes is Kevin's Familiar. The private identity (`FAMILIAR_IDENTITY_PATH`) is the
first and only identity source; Pi's generic "expert coding assistant" framing
never enters the prompt. Everything affordance-sensitive is rebuilt from
`event.systemPromptOptions` (`BuildSystemPromptOptions`) the way Pi builds it.

## Matrix vs Pi 1.0.0 `buildSystemPrompt`

Since 0.86 Pi renders its default prompt as XML-tagged transcript sections
(`<tools>`, `<rules>`, `<docs>`, `<addendum>`, `<project_context>`, `<skills>`,
`<cwd>`, plus extension `sections`). Familiar keeps its own headings; the
rows below note where 1.0.0 changed shape.

| Section | Pi 1.0.0 | Familiar | Classification |
|---|---|---|---|
| Opening framing | "expert coding assistant operating inside pi…" | private identity markdown | identity divergence: preserve |
| `customPrompt` (SYSTEM.md / `--system-prompt`) | replaces the default prompt | ignored | identity divergence: preserve (identity dir is the declared mechanism; pinned) |
| `selectedTools` / `toolSnippets` | only snippet-bearing selected tools listed; default set `read,bash,edit,write` | same (heading `Available Tools:`) | parity: adopt (default set added) |
| "In addition to the tools above…" | present | omitted | generic prose: reject |
| Cross-tool file-exploration rule | bash/PowerShell variants, only when grep/find/ls absent | bash variant only | adopt (PowerShell is Windows-only, unavailable in the resident) |
| Tool-owned guidelines | `toolGuidelines[name]` for each selected tool in tool order (0.86+; previously flattened into `promptGuidelines`), then extra `promptGuidelines`, exact-string dedupe | same order and dedupe; unselected tools' guidelines excluded | affordance: adopt (without the 1.0 `toolGuidelines` read, every tool-owned guideline would silently disappear) |
| Hand-copied edit/read/write/bash bullets | n/a (tool-owned) | removed in favour of the dynamic tool-owned text | affordance: adopt (also makes the `PI_*` bullet follow `exposeSessionEnvironment`) |
| "Be concise" / "Show file paths clearly" | always appended | omitted | identity dilution: reject (register belongs to the authored identity; pinned) |
| Familiar guidelines (🗣 transcription, mark, handoff) | n/a | kept; the `mark` bullet now only while `mark` is an active tool | Familiar-specific: preserve |
| Pi documentation section | present | omitted | reject (the repository `pi` skill covers it on demand) |
| `appendSystemPrompt` (`APPEND_SYSTEM.md`, `--append-system-prompt`) | `<addendum>` after docs | raw bytes after guidelines | operator-authorized text: adopt; `<addendum>` wrapper not adopted (bytes unchanged by the 1.0 upgrade) |
| `contextFiles` `<project_context>` | after append; 1.0 section bytes (`<project_context>\nProject-specific…` with no padding blank lines) | same bytes, same position | adopt (resident runs `--no-context-files`, so normally empty; never logged) |
| Skills | after project context; `formatSkillsForPrompt(skills, read\|bash)`, omitted with neither | directly after identity; same read-or-bash selection | position: identity-first topology preserved; loader selection: adopt |
| `cwd` | `\` → `/`, `<cwd>` section | same normalization, `Current working directory:` line | adopt (normalization); tag not adopted |
| Extension `sections` (0.86+) | `<name>\ncontent\n</name>` after cwd, empty omitted | same bytes after cwd | affordance: adopt (no resident producer today; built-in mcp, which sets `mcp_servers`, is disabled) |
| Imp / Stuff guidance | n/a | between tools and guidelines, conditional | Familiar-specific: preserve |

## Chaining

`before_agent_start` handlers chain; identity returns a fresh prompt and does
not carry `event.systemPrompt` forward. Since Pi 0.86 a returned `systemPrompt` sets
`forceSystemPrompt`: providers receive it as the leading system prompt for
that run while the transcript keeps recording Pi's structured sections
(mid-conversation prompt-change entries are therefore Pi's, not Familiar's).
That forced prompt applies only to runs started by `prompt()`: runs started by
`sendMessage(..., { triggerTurn: true })` (scheduler wakes, Imp attention,
handoff orientation) never emit `before_agent_start` and would otherwise reach
the provider with Pi's generic default prompt (Pi 0.85.1 kept the last identity
prompt in agent state instead). A `context_with_system` handler therefore
rebuilds the identity prompt from `ctx.getSystemPromptOptions()` for every
request and projects it exactly as Pi projects a forced prompt: one leading
system message with the identity text and the replayed tool declarations, all
other system messages dropped. It degrades to the last good prompt like the
`before_agent_start` handler and leaves requests untouched without an identity.

No resident extension modifies the
prompt before identity: `familiar.sh` writes the settings extension list
sorted (`jq unique`), so footer, handoff, and any plugin /
host-extra paths that sort before the repository path (e.g. `/opt/...`,
`/etc/...`) load first — none of them return a `systemPrompt`. A future
extension that must reach the model before identity should ride
`systemPromptOptions` (tool `promptGuidelines`, `appendSystemPrompt`) or a
returned message, not the chained prompt text. Later handlers still receive
and may extend the identity prompt. Without `FAMILIAR_IDENTITY_PATH` the handler returns nothing
and the chain is untouched. On a transient identity read failure the last
identity-bearing prompt is reused; before any success, Pi's default applies.

## Upgrade checklist

1. Diff `dist/core/system-prompt.js` and `formatSkillsForPrompt` in
   `dist/core/skills.js` between the old and new pin.
2. `nix shell nixpkgs#bun -c bun test integrations/pi/extensions/identity`
   — the parity block runs Pi's real `buildSystemPrompt` on shared fixtures.
3. Classify each new delta in the matrix above before adopting it. Never
   import Pi's generic framing or documentation prose.
