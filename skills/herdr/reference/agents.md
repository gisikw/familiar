# Herdr agent orchestration (reference)

**This is reference material, not a first-class affordance.**

Familiar dispatches subagents through the `dispatch` tool, which owns this
machinery: it places jobs in per-directory workspaces, isolates git work in
worktrees, parks the blocking wait in a detached watcher, harvests verdicts and
cost from the child's session transcript, relays settlements into the
conversation, and resurrects children whose panes died in a restart.

Read this file when you are **working on the subagent system itself** and need
to know how Herdr's agent surface behaves underneath. Do not hand-roll agent
orchestration from it as a substitute for `dispatch` — a second path to the same
capability is how the two systems drift apart, and hand-rolled waiting is how a
model ends up reinventing busy-wait.

Legitimate direct uses: inspecting or rescuing an agent Kevin started himself,
debugging a dispatched job's pane, or explicit user instruction to drive the CLI.

---

## Lifecycle states

`idle` means the agent is ready for input and its tab has been seen in the focused Herdr UI. `done` is the same underlying idle state after unseen background work finishes. Focusing the tab or targeting the pane or agent with a focus command marks it seen. CLI reads do not mark it seen. `blocked` means Herdr recognized an approval or question UI. `unknown` means an agent is present but Herdr cannot classify it confidently; it does not prove completion.

Agent commands accept either a unique live agent name or the pane ID currently hosting that agent. They do not accept terminal IDs or bare agent-kind labels. Names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents. A name follows the current pane occupant and is cleared when that agent exits, is released, or is replaced.

## Starting an agent

`agent start` requires an existing available shell pane and never creates, splits, or moves layout. An available shell pane must be at its interactive prompt, with the shell itself in the foreground and no foreground command, editor, or agent running.

```bash
herdr agent start reviewer --kind codex --pane <pane-id>
```

Run `herdr agent` to inspect the installed kind list. Pass native agent arguments only after `--`:

```bash
herdr agent start reviewer --kind pi --pane <pane-id> -- <agent-args...>
```

`agent start` returns only after Herdr detects the expected agent in the same pane and considers it ready for interactive input. It defaults to a 30-second startup timeout.

Argument passthrough is what makes dispatched pi children addressable: `--session-id` with a pre-minted UUID means the child is a session file we can relaunch, not a process we hope survives.

## Prompting and waiting

```bash
herdr agent prompt reviewer "Review the current diff and report only actionable findings." --wait --timeout 120000
```

`agent prompt` atomically submits text and encoded Enter while honoring the pane's live bracketed-paste mode. It rejects an agent already waiting at an approval or question dialog with `agent_blocked` before sending any input. For normal agent work, `--wait` is enough: it waits for the first settled `idle`, `done`, or `blocked` state. Do not repeat those defaults with `--until`.

**Answering a blocked agent needs a different channel.** Because `agent prompt` refuses a blocked target outright, an answer must be typed into the pane instead: `herdr pane send-text <pane> "<answer>"` followed by `herdr pane send-keys <pane> enter`, then `agent wait` for the turn it produces. `agent send-keys` only accepts key names, not arbitrary text, so the pane surface is the one that works. This is what `subagent_respond` does when its target is blocked.

A prompt sent from a non-working state must produce an observed lifecycle change within five seconds. Otherwise Herdr returns `agent_prompt_stalled` instead of waiting indefinitely. This wait tracks lifecycle state, not an individual turn; if the agent is already working, completion of the active turn may satisfy it.

Use `--until` only for a state-specific workflow, such as waiting for an already-running agent to request input:

```bash
herdr agent wait reviewer --until blocked --timeout 120000
```

Without `--until`, standalone `agent wait` uses the same settled-state defaults as `agent prompt --wait`.

**This blocking wait is the primitive `dispatch` builds its return channel from.** Herdr can block until an agent settles but cannot push that transition anywhere, so the subagent extension parks the blocking call in a detached watcher process and turns the result into a settlement. Waiting costs a process, not inference.

## Inspecting and steering

```bash
herdr agent get reviewer
herdr agent read reviewer --source recent-unwrapped --lines 120
herdr agent send-keys reviewer esc
herdr agent send-keys reviewer ctrl+c
```

Herdr validates all keys before writing any bytes. If a wait fails or returns `blocked`, inspect `agent get` and `agent read` before deciding what input to send. Use the pane surface only when raw terminal control is intentional.

Reading an agent hosted on the terminal's alternate screen is lossy: rows that leave the alternate screen do not enter Herdr's host scrollback, so a larger `--lines` cannot recover them. This is why dispatched verdicts are harvested from the session transcript rather than scraped, with the pane tail kept only as a last-resort fallback.

## Topology used by dispatch

- `herdr worktree create --cwd <repo> --branch <name> --no-focus` creates the checkout **and** opens it as its own workspace, returning workspace, tab, root pane, and checkout path together. Isolated jobs use this; the branch is the artifact.
- `herdr worktree open --cwd <repo> --path <checkout>` reopens an existing checkout as a workspace. This is the resurrection path after a restart kills the pane.
- `herdr workspace create --cwd <dir>` plus `herdr tab create --workspace <id>` places non-repo jobs in a per-directory workspace, found-or-created and reused.
- Closing a workspace does **not** remove its worktree from disk; `git worktree remove` is a separate, deliberate act.
