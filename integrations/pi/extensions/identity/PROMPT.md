# Identity prompt assembler

`index.ts` replaces Pi's system prompt on every turn. `prompt.ts` is the
assembler; `index.test.ts` pins both the intentional divergences and the
parity-owned structure against the pinned Pi (0.85.1, `nix/patches/pi-coding-agent`).

Kes is Kevin's Familiar. The private identity (`FAMILIAR_IDENTITY_PATH`) is the
first and only identity source; Pi's generic "expert coding assistant" framing
never enters the prompt. Everything affordance-sensitive is rebuilt from
`event.systemPromptOptions` (`BuildSystemPromptOptions`) the way Pi builds it.

## Matrix vs Pi 0.85.1 `buildSystemPrompt`

| Section | Pi 0.85.1 | Familiar | Classification |
|---|---|---|---|
| Opening framing | "expert coding assistant operating inside pi…" | private identity markdown | identity divergence: preserve |
| `customPrompt` (SYSTEM.md / `--system-prompt`) | replaces the default prompt | ignored | identity divergence: preserve (identity dir is the declared mechanism; pinned) |
| `selectedTools` / `toolSnippets` | only snippet-bearing selected tools listed; default set `read,bash,edit,write` | same (heading `Available Tools:`) | parity: adopt (default set added) |
| "In addition to the tools above…" | present | omitted | generic prose: reject |
| Cross-tool file-exploration rule | bash/PowerShell variants, only when grep/find/ls absent | bash variant only | adopt (PowerShell is Windows-only, unavailable in the resident) |
| Tool-owned `promptGuidelines` | appended in tool order, exact-string dedupe | same; previously **dropped** (Familiar's wake/worklist guidelines never reached the model) | affordance: adopt |
| Hand-copied edit/read/write/bash bullets | n/a (tool-owned) | removed in favour of the dynamic tool-owned text | affordance: adopt (also makes the `PI_*` bullet follow `exposeSessionEnvironment`) |
| "Be concise" / "Show file paths clearly" | always appended | omitted | identity dilution: reject (register belongs to the authored identity; pinned) |
| Familiar guidelines (🗣 transcription, mark, handoff) | n/a | kept; the `mark` bullet now only while `mark` is an active tool | Familiar-specific: preserve |
| Pi documentation section | present | omitted | reject (the repository `pi` skill covers it on demand) |
| `appendSystemPrompt` (`APPEND_SYSTEM.md`, `--append-system-prompt`) | after guidelines | after guidelines; previously dropped | operator-authorized text: adopt |
| `contextFiles` `<project_context>` | after append | same bytes, same position; previously dropped | adopt (resident runs `--no-context-files`, so normally empty; never logged) |
| Skills | after project context; `formatSkillsForPrompt(skills, read\|bash)`, omitted with neither | directly after identity; same read-or-bash selection | position: identity-first topology preserved; loader selection: adopt |
| `cwd` | `\` → `/`, last line | same | adopt |
| Imp / Stuff guidance | n/a | between tools and guidelines, conditional | Familiar-specific: preserve |

## Chaining

`before_agent_start` handlers chain; identity returns a fresh prompt and does
not carry `event.systemPrompt` forward. No resident extension modifies the
prompt before identity: `familiar.sh` writes the settings extension list
sorted (`jq unique`), so agents, footer, handoff, and any plugin /
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
2. `nix develop .#agents -c bash -c 'cd integrations/pi/extensions && bun test identity'`
   — the parity block runs Pi's real `buildSystemPrompt` on shared fixtures.
3. Classify each new delta in the matrix above before adopting it. Never
   import Pi's generic framing or documentation prose.
