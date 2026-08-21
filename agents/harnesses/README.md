# Harnesses

The interface in `harness.go` covers start, prompt, observe, answer, cancel, resume, and settlement collection. The supervisor supplies runtime callbacks and remains the sole process/tmux authority.

`pi` is implemented against pi's JSON print mode and explicit session JSONL. Claude and Codex are intentionally minimal configurable-command adapters and infer only process exit/transcript presence; unsupported native operations return `ErrUnsupported`. No adapter binary is required for unit tests.
