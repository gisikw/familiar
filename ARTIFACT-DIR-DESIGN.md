# Subagent Artifact Directory System

## Overview

Familiar's subagent dispatch system now automatically provisions a dedicated directory for each job where substantial non-code artifacts should be written. This eliminates the need to manually specify output directories in every dispatch prompt.

## Design

### Core Invariants

1. **Deterministic paths**: Every job gets a predictable directory `<artifact-root>/<job-id>/`, enabling safe resurrection after restarts
2. **Secure creation**: Directories created with mode 0700 (owner-only), preventing accidental exposure
3. **Path traversal protection**: All paths validated to prevent escape via `..` or absolute paths
4. **Non-fatal errors**: Directory creation failures don't prevent dispatch; fallback paths are provided
5. **Backward compatibility**: Old jobs lacking `artifact_dir` field in their command.json get deterministic fallback on resurrection

### Configuration

**Environment variable**: `FAMILIAR_ARTIFACT_DIR`  
**Default**: `<repo>/state/artifacts`

Example:
```bash
export FAMILIAR_ARTIFACT_DIR=/data/artifacts
familiar.sh  # uses /data/artifacts as root
```

### Data Flow

#### Dispatch

1. User calls `dispatch({ prompt, ... })`
2. Extension generates unique job ID
3. **Before side effects**: `prepareArtifactDir(root, jobId, isNew=true)` creates/verifies directory
4. Artifact path embedded in dispatch command (`command.json`)
5. Mandatory instruction appended to prompt (see Prompt Footer section below)
6. Watcher launches agent with full context
7. Settlement relayed back with `artifact_dir` field populated

#### Resurrection (session_start)

1. Spool scan iterates existing jobs
2. For old jobs without `artifact_dir`: deterministically compute `getArtifactDir(root, id)`
3. Call `prepareArtifactDir(root, id, isNew=false)` to ensure directory exists
4. Update in-memory command for this session
5. Proceed with normal resurrection/relay logic

### Prompt Footer

Every initial dispatch includes a crisp, mandatory instruction appended to the prompt:

```markdown
---
**Artifacts:** Write substantial non-code artifacts — research, design, 
evidence, specs — to this directory (not /tmp or repo root): /exact/path/to/artifact/dir
**Code:** Changes belong in the worktree; they are the primary artifact.
**Verdict:** List any artifact file paths you created.
```

This instruction:
- Is part of the durable spool record (not retracted)
- Includes the exact absolute path
- Is repeated for multi-pass jobs (respond/revive reuse same dir)
- Applies to all agent kinds (pi, deepseek, etc.)

### API Additions

#### DispatchCommand

```typescript
interface DispatchCommand {
  // ... existing fields
  /** Absolute path where the job should write substantial artifacts. */
  artifact_dir: string;
}
```

#### Settlement

```typescript
interface Settlement {
  // ... existing fields
  /** Absolute path to the job's artifact directory. */
  artifact_dir?: string;  // optional to preserve old settlement compat
}
```

#### Tool Returns

**dispatch()** now returns:
```json
{
  "ok": true,
  "id": "sub-20260820-abcd",
  "artifact_dir": "/repo/state/artifacts/sub-20260820-abcd",
  "pass": 1,
  "workspace": "ws-123",
  "workdir": "/path/to/checkout"
}
```

**subagent_await()** now returns:
```json
{
  "id": "sub-20260820-abcd",
  "artifact_dir": "/repo/state/artifacts/sub-20260820-abcd",
  "status": "done",
  "result": "...",
  "usage": { ... }
}
```

**subagent_status()** includes `artifact_dir` in job listing.

**subagent_cancel()** includes `artifact_dir` in response.

#### Relay Format

Settlements are relayed as XML with artifact path:
```
<subagent-settlement id="..." pass="1" status="done">
reason: ...
result: ...
workdir: /path (branch ...)
artifacts: /repo/state/artifacts/sub-20260820-abcd
usage: ...
</subagent-settlement>
```

## Implementation Details

### artifact-dir.ts

Core module providing:
- `validateArtifactPath(root, candidate)`: Security check for path traversal
- `ensureArtifactDir(config)`: Creates or verifies directory with mode 0700
- `getArtifactDir(root, jobId)`: Deterministic fallback path (no I/O)
- `artifactInstruction(dir, kind)`: Generates prompt footer text
- `prepareArtifactDir(root, jobId, isNew)`: Full setup routine

### index.ts Changes

1. Import artifact-dir module
2. Add `ARTIFACT_ROOT` constant (env var with fallback)
3. Add `artifactRootVerified` session state
4. Update `DispatchCommand` interface (add `artifact_dir: string`)
5. Update `Settlement` interface (add `artifact_dir?: string`)
6. Update `verdictFooter()` to include artifact instruction
7. Update `settle()` to include `artifact_dir` in settlement JSON
8. Update `relay()` to include artifacts line in XML
9. In `dispatch()` tool:
   - Call `prepareArtifactDir()` after spool dir created
   - Store result in `command.artifact_dir`
   - Update prompt with artifact instruction
   - Return `artifact_dir` in response
10. In `subagent_await()` tool: include `artifact_dir` in returns
11. In `subagent_status()` tool: include `artifact_dir` in job listings
12. In `subagent_cancel()` tool: include `artifact_dir` in responses
13. In `session_start` handler:
    - Verify/create `ARTIFACT_ROOT` once per session
    - For old jobs, compute and create artifact dirs as fallback
    - Update in-memory commands before resurrection

## Testing

24 unit tests cover:
- Path validation (traversal prevention, nesting, absolute paths)
- Directory creation (permissions, idempotency, parent creation)
- Deterministic paths (consistency, uniqueness)
- Prompt instruction generation
- Integration with old jobs (fallback paths, resurrection)

All tests pass:
```
bun test extensions/subagent/artifact-dir.test.ts
 24 pass, 0 fail
```

## Backward Compatibility

### Old Jobs (Before This Change)

1. Jobs dispatched before `artifact_dir` field existed have only `command.json` without it
2. On resurrection, `session_start` handler detects missing field
3. Calls `getArtifactDir(ARTIFACT_ROOT, id)` → `<root>/<job-id>/`
4. Calls `prepareArtifactDir()` with `isNew=false` to ensure dir exists
5. Command updated in-memory; no write to spool
6. Settlement can still be relayed without `artifact_dir` (field is optional)
7. Parent tool can extract `artifact_dir` from relayed settlement if present

### Schema Evolution

- **DispatchCommand.artifact_dir**: Required (all new dispatches have it)
- **Settlement.artifact_dir**: Optional (old settlements lack it; new ones have it)
- **dispatch() response**: Always includes `artifact_dir`
- **dispatch() tool description**: Updated to mention artifact directory

### Migration Path

No action needed by users. Existing jobs continue to work:
- Already-settled jobs: unchanged (settlements don't need artifact_dir)
- Running jobs: get artifact_dir when resurrected
- New jobs: always get artifact_dir from dispatch time

## Example Usage

```typescript
// Simple research task
const job = dispatch({
  prompt: "Research the history of Lisp. Write findings to artifacts dir.",
  label: "lisp-history"
});

// Returns:
// { ok: true, id: "sub-20260820-xyz1", artifact_dir: "/repo/state/artifacts/sub-20260820-xyz1", ... }

// Job receives mandatory instruction:
// "Write substantial non-code artifacts ... to this directory (not /tmp or repo root): 
//  /repo/state/artifacts/sub-20260820-xyz1"

// Child writes artifacts:
// - /repo/state/artifacts/sub-20260820-xyz1/timeline.md
// - /repo/state/artifacts/sub-20260820-xyz1/bibliography.md

// Verdict includes paths:
// "Completed research. See /repo/state/artifacts/sub-20260820-xyz1/timeline.md and bibliography.md"

// Await retrieves settlement with artifact_dir:
await(subagent_await({ id: "sub-20260820-xyz1" }))
// Returns: { status: "done", artifact_dir: "/repo/state/artifacts/sub-20260820-xyz1", ... }

// Parent can then list or process artifacts:
// const artifacts = fs.readdirSync("/repo/state/artifacts/sub-20260820-xyz1")
```

## Security Considerations

1. **Path traversal**: All paths validated via `validateArtifactPath()` before use
2. **Directory permissions**: Created with `0o700` (owner-only access)
3. **No environment exposure**: Artifact dir path is not exported to child env
4. **Idempotent creation**: Safe to call multiple times; doesn't overwrite or reset
5. **Fallback robustness**: Directory creation errors are logged but non-fatal

## Future Extensions

1. **Quota management**: Track artifact dir sizes per job
2. **Retention policy**: Automatic cleanup of old artifact dirs
3. **Compression**: Archive old artifact dirs after settlement
4. **Indexing**: Build searchable index of artifact contents
5. **familiar.toml integration**: Allow `[artifacts]` section to override root or per-job settings

## Files Changed

- `extensions/subagent/artifact-dir.ts`: New module (191 lines)
- `extensions/subagent/artifact-dir.test.ts`: New tests (335 lines, 24 test cases)
- `extensions/subagent/index.ts`: Updated dispatch system (~50 line changes)
