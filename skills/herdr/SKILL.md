---
name: herdr
description: "Control Herdr, a terminal multiplexer for coding agents. Use only when the user explicitly mentions Herdr or asks to use Herdr to inspect or control panes, tabs, workspaces, commands, or another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work. Requires HERDR_ENV=1."
---

# Herdr

Herdr organizes terminals into workspaces, tabs, and panes, recognizes coding agents running inside panes, and exposes the current session through the `herdr` CLI.

Before issuing any control command, verify that this agent is running inside a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, say that you are not running inside Herdr and stop. Do not inspect or control the focused Herdr session from outside Herdr.

When the check passes, the `herdr` binary in `PATH` talks to the current session. Use it to inspect neighboring work, create terminal layout, run commands, read output, and wait for state changes.

**Dispatching subagents is not this skill's job.** Use the `dispatch` tool, which owns agent orchestration end to end — placement, isolation, waiting, verdicts, cost, and resurrection across restarts. See "Delegating work" below.

## Learn the current CLI

The installed binary is the authority for command syntax. Start with:

```bash
herdr --help
```

Then print the relevant command group by running the group without a subcommand:

```bash
herdr agent
herdr pane
herdr workspace
herdr tab
herdr worktree
herdr terminal
herdr notification
herdr integration
herdr session
```

Do not run bare `herdr` for discovery; it launches or attaches the TUI. Do not probe a mutating nested command by omitting arguments. Commands such as `herdr workspace create` are valid with defaults and will execute.

Most control commands return JSON. Read identifiers and state from those responses instead of predicting them.

## Understand layout, panes, and agents

Choose the primitive that matches the job:

- Workspace, tab, and pane topology organize terminal locations.
- Pane commands control raw terminals, shells, tests, servers, input, and output.
- Agent commands inspect or steer a recognized coding agent occupying a pane.

A pane exists whether or not it contains an agent. Use pane commands for ordinary processes. Use agent commands when Herdr must validate agent identity or interpret `idle`, `working`, `blocked`, `done`, and `unknown` lifecycle states.

Agent commands accept either a unique live agent name or the pane ID currently hosting that agent. They do not accept terminal IDs or bare agent-kind labels.

`idle` means the agent is ready for input and its tab has been seen in the focused Herdr UI. `done` is the same underlying idle state after unseen background work finishes. Focusing the tab or targeting the pane or agent with a focus command marks it seen. CLI reads do not mark it seen. `blocked` means Herdr recognized an approval or question UI. `unknown` means an agent is present but Herdr cannot classify it confidently; it does not prove completion.

## Delegating work

To hand work to a subagent, call the `dispatch` tool. Do not assemble it from `pane split` + `agent start` + `agent prompt --wait`.

`dispatch` returns immediately with a job id and relays the settlement into the conversation when the work lands. `subagent_await` is the join primitive when you genuinely need a result before continuing; `subagent_respond` steers a running child or answers a blocked one; `subagent_status` looks without blocking. Never sleep, poll, or re-read your own prompt while waiting — awaiting costs no tokens, and a hand-rolled wait loop is both expensive and worse.

Jobs land in a workspace keyed by their working directory, with git work isolated in a worktree whose branch is the artifact. They are visible in the sidebar: Kevin can click into a running job, watch it, and steer it himself.

Herdr's own agent surface — `agent start`, `prompt`, `wait`, `read`, `send-keys` — is documented in `reference/agents.md`. Read it when working on the subagent system itself, or when inspecting and rescuing an agent that Kevin started. Do not treat it as a first-class way to dispatch work.

## Use IDs and caller context

Public IDs are opaque stable handles:

- workspace: `w1`
- tab: `w1:t1`
- pane: `w1:p1`

Closed tab and pane IDs are not reused. A pane moved into another workspace receives a new workspace-qualified pane ID. After `pane move`, continue with `.result.move_result.pane.pane_id` or the live agent name. The old value is reported as `.result.move_result.previous_pane_id`; only the moved process's inherited caller context keeps resolving that old ID, so do not use it as a general agent target.

Herdr injects the caller's context into each managed pane:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

Prefer `--current` when a pane command should target the calling pane. Omitting a target may use the UI-focused pane, which can belong to the user or another client.

Discover live state with:

```bash
herdr workspace list
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
herdr pane current --current
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
herdr agent list
```

Creation responses expose the IDs to use next. `workspace create` returns `.result.workspace`, `.result.tab`, and `.result.root_pane`. `tab create` returns `.result.tab` and `.result.root_pane`. `pane split` returns the new pane as `.result.pane`.

## Run an ordinary command in another pane

Create a sibling pane with the same geometry rule, preserve the caller's working directory, and keep user focus unchanged:

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Read the new pane ID from `.result.pane.pane_id`, then run and inspect the command:

```bash
herdr pane run <returned-pane-id> "just test"
herdr pane wait-output <returned-pane-id> --match "test result" --timeout 120000
herdr pane read <returned-pane-id> --source recent-unwrapped --lines 120
```

`pane run` atomically sends command text and Enter. `pane wait-output` searches the selected snapshot immediately, so output that already exists can match. Use `--match <text>` for a literal substring or `--regex <pattern>` for a Rust regular expression. Omitting `--timeout` allows an indefinite wait.

Use the read source that matches the task:

- `visible`: the currently rendered viewport.
- `recent`: recent rendered output, including soft wraps.
- `recent-unwrapped`: recent output with soft wraps joined; prefer it for logs and transcripts.
- `detection`: the plain-text bottom-buffer snapshot used for agent detection.

Use `--format ansi` when colors and terminal styling are evidence. Otherwise use text.

`--lines` asks Herdr for more rows from the pane's available screen and host scrollback. If increasing it does not reveal more of a completed response, the pane is probably running an agent on the terminal's alternate screen. Rows that leave the alternate screen do not enter Herdr's host scrollback, so a larger line count cannot recover them. This is why dispatched subagents report verdicts through the `dispatch` settlement rather than by being scraped.

## Safety and coordination rules

- Use `--no-focus` for background work unless the user asked to switch context.
- Use `--current`, an explicit pane ID, or a unique agent name. Do not rely on another client's focused pane.
- Parse IDs from JSON responses. Do not derive them from sidebar order or examples.
- Do not close workspaces, tabs, panes, or sessions you did not create unless the user explicitly asked.
- Do not hand-manage surfaces owned by `dispatch`. Cancel a job with `subagent_cancel`; closing its workspace or tab out from under it strands the job.
- Never run `herdr server stop` from an active session unless the user explicitly intends to stop the server and its pane processes.
- Never kill the main Herdr process. Use named test sessions for experiments that need an isolated server.
- CLI server errors are JSON on stderr with exit status 1. CLI syntax errors exit with status 2.
