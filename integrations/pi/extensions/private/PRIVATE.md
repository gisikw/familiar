# /private — sealed conversations with a local model

`/private` is a conversation mode with two properties and a short list of things
it deliberately does not promise.

1. **Nothing said in private reaches a third-party model provider.**
2. **Nothing said in private is written anywhere in plaintext.**

Everything below is either how those hold, or where they stop.

---

## The shape of it

A private conversation is not a Pi conversation. It never becomes a Pi message.

```
Kevin types in the modal console
        │
        │  (never enters submitPrompt, so no `input` event, no firehose,
        │   no relay, no worklist, no handoff, no compaction, no context)
        ▼
extension builds messages from its own decrypted memory
        │
        ▼
one POST → tiamat-router → provider attested locality=local
        │      X-Tiamat-Require-Locality: local
        │      no tools · no stream · no retry · no fallback · no capture
        ▼
reply rendered inside the modal only
        │
        ▼
both halves sealed with age → appended to the SAME session .jsonl
                              as opaque `custom` entries
```

The session archive stays a single archive. There is no second file, no fork, no
parallel store to keep in sync. A private compartment is a run of sealed
`custom` entries inside the ordinary transcript, and Pi excludes `custom`
entries from model context by construction — so no compaction, branch summary,
handoff, or upstream request can walk into them.

### Why input goes through a modal instead of the `input` hook

Pi's `input` event fans out to every loaded extension in load order, and while
the first handler to return `handled` short-circuits the rest, that is a
*load-order* guarantee. Depending on it would make privacy a function of how
`settings.json` happens to be sorted.

A modal `ctx.ui.custom()` component reads keystrokes directly. Text typed into
it never reaches `submitPrompt` at all, so there is no event to fan out and no
ordering to get right. This is also why private mode requires an attached
terminal: in RPC or print mode there is no such input path, so there is no
private mode. `/private` refuses rather than falling back to the shared one.

### Why private plaintext is never in the transcript

Sealed entries always render as `🔒 sealed private entry #n`, even while
unlocked. Rendering plaintext inline would put it into terminal scrollback,
which lives in the tmux server and is replayed to every viewer that attaches
afterwards — including browser viewers on other devices. `:history` inside the
modal is the only way to read a compartment on screen, and it disappears with
the modal.

---

## Local-only routing

Locality is decided by **provider identity**, never by model name. A model
called `qwen3.8-27b` served by OpenRouter is a third party. A model called
`claude-opus` served from a box in the basement is not.

Two independent, fail-closed checks:

- **Client.** `/private` reads the authenticated `/tiamat/v1/providers` surface
  and requires `locality: "local"`. Absent, unknown, or differently-cased values
  are remote. A configured preference (`FAMILIAR_PRIVATE_PROVIDER`) can narrow
  the local set; it can never promote a remote provider.
- **Router.** Every private request carries `X-Tiamat-Require-Locality: local`.
  The router refuses with `403` before resolving credentials or contacting any
  upstream if the named provider is not local, and refuses with `400` for any
  value it does not implement. Per the router's no-failover invariant there is
  no substitution and no retry.

The router also suppresses its own request/response capture for any request
carrying a locality requirement, and makes that decision before the body reaches
the capture recorder. The ledger still records one row; ledger rows carry no
content.

Absent from the private path entirely: streaming, retries, embeddings,
moderation, summarisation helpers, title generation, and any second provider.

### Tools

There are none. Not a curated subset — none.

The request carries no `tools`, `tool_choice`, `functions`, or `function_call`,
and `assertNoToolSurface` throws if anything ever tries to add one. A private
turn cannot read a file, run a command, search the web, dispatch a Golem job,
touch the worklist or Plate, or reach the network. Mediating a tool surface
would mean arguing about which capabilities can be trusted with sealed content;
refusing all of them removes the argument and the exfiltration path together.

---

## Encryption at rest

| Concern | Choice |
|---|---|
| Message sealing | `age` (X25519 + ChaCha20-Poly1305), via the `age` binary |
| Identity wrapping | scrypt (N=2¹⁷, r=8, p=1) + AES-256-GCM, via Node/OpenSSL |
| Novel cryptography | none |

Each sealed record is:

```json
{"v":1,"compartment":"<uuid>","seq":3,"bucket":1024,"ct":"<base64 age>"}
```

Role, text, timestamp, and the model that produced it live *inside* the sealed
payload. Payloads are length-prefixed and padded to 1 KiB buckets, so ciphertext
length reveals a bucket rather than a message length, and a user turn is
indistinguishable from an assistant turn.

**Sealing needs only the public recipient.** The compartment can be written
while locked, so a crash or an idle auto-lock mid-conversation cannot lose the
turn that was in flight. Reading requires the identity.

**No transient plaintext.** Plaintext is passed to `age` on a pipe and lives
only in process memory and inside the modal. Opening staged *ciphertext* to a
0600 temp file (because `age` cannot take both its identity and its input on
stdin) and removes it before returning. Nothing plaintext is ever written to a
session file, a log, an argument vector, or a temp file.

**Logging.** The extension logs structural facts only — `unlocked`,
`turnFailed`, `compartmentClosed`, counts. No value derived from private
plaintext is ever passed to a logger, including error text produced while
handling it.

### Key management

`$FAMILIAR_PRIVATE_DIR/keyring.json` (0600, in a 0700 directory, gitignored)
holds the public recipient in the clear and the identity wrapped under Kevin's
passphrase. There is no escrow and no recovery.

`crypto.scrypt`'s asynchronous form is not reproducible on every runtime this
code can load into — bun 1.3 returns different results for identical inputs at
these cost parameters. The code therefore uses `scryptSync` and runs a cheap
determinism self-test once per process, so a broken runtime KDF fails loudly
instead of being reported as a wrong passphrase for a passphrase typed
correctly.

---

## Continuity with Exo

Kevin wanted continuity. The honest version is asymmetric, because the risk is.

**Public → private is free.** On entry, the extension renders the last ~12 turns
of ordinary context locally and seals them into the compartment as a
`public-context-import`. The private model gets them. Since that model is local,
this discloses nothing to anyone.

**Private → public costs an explicit decision.** On exit the ordinary session
receives exactly one fixed-template custom message: that a private conversation
happened, when, how many entries, and an instruction not to speculate. No
content, no model involvement.

**Declassification is the only channel for meaning.** `:declassify` asks the
local model for a draft. **That draft is still private** — it is sealed like
everything else and shown only in the modal. Summarisation is not anonymisation.
It becomes public only after Kevin reads that exact literal text and confirms.
What lands in the ordinary session is a `custom_message`, never an assistant
message, carrying:

```
[declassified from a private conversation — drafted by <provider>/<model>
 (local), reviewed and approved verbatim by Kevin at <ts>. This is not Exo's
 recollection and carries no assistant assent.]
```

Transcript provenance must not forge assistant assent. Exo did not say it; a
local model drafted it and Kevin approved it, and the record says so.

---

## Commands

| Command | Effect |
|---|---|
| `/private setup` | Generate an identity, wrap it under a new passphrase |
| `/private` | Unlock if needed, then open the modal console |
| `/private unlock` / `lock` | Load or drop the identity from memory |
| `/private status` | Keyring, lock state, compartment count, live local-provider attestation |
| `/private export <path>` | Write decrypted content to a 0600 file, behind a loud confirm |
| `/private forget` | Tombstone every compartment in this session |
| `/private destroy-key` | Crypto-erasure: make every sealed record everywhere unreadable |
| `:help` `:history` `:declassify` `:exit` | Inside the modal |

**Lock/unlock.** Restart always comes back locked. Idle auto-lock after
`FAMILIAR_PRIVATE_IDLE_MS` (default 15 minutes), suspended while the modal is
open. Locking drops the identity; sealing still works.

**Key loss.** Sealed content is gone. Permanently. This is stated at setup.

**Deletion.** Two levels, because they guarantee different things. `forget`
appends a tombstone and no display path will open those records again, but the
ciphertext remains in the append-only file. `destroy-key` deletes the identity,
which makes every sealed record in every session archive permanently unreadable
in one action. Crypto-erasure is the only deletion primitive here that is honest
about what it guarantees; rewriting append-only Pi session files in place is
not attempted.

**Multi-device.** Private mode is bound to one attached terminal. Before the
first sealed entry the extension opens a `familiar-ui/transcript-visibility`
private span, so browser and iOS clients project nothing from the compartment;
the span is opened first and closed last, so a crash leaves it open and
familiar-ui treats it as private on replay. Other devices may see that a private
conversation is happening. They cannot see into it and cannot type into it.

**Fork / background workstreams.** Sealed entries carry a compartment UUID and
are read only by that UUID, so a fork or a background workstream that inherits
the archive inherits ciphertext and a compartment it has no key to. Nothing
special is needed because nothing private is ever in context to be inherited.

---

## Threat model

### Protected

- **Accidental upstream-provider disclosure.** Private content is never in Pi's
  model context, so no ordinary request, compaction, branch summary, handoff, or
  Golem prompt can carry it. Private requests reach exactly one provider the
  router attests local, and the router refuses before contacting upstream
  otherwise.
- **Plaintext at rest in normal state and backups.** Session archives, the
  keyring, logs, traces, worklists, browser storage, and Electron/iOS caches
  hold ciphertext or nothing. A backup of the whole state directory yields
  ciphertext plus a passphrase-wrapped key.
- **Router-side content retention.** Capture is suppressed for locality
  requests. The ledger retains counts and outcomes, never content.
- **Casual filesystem recovery.** `grep`/`find` over the worktrees and generated
  test state recovers nothing; a test asserts this against synthetic canaries in
  UTF-8, base64, and hex.
- **Cross-compartment and cross-room leakage.** Compartments are isolated by
  UUID; the router requires a bearer token on every request and a locality
  header is not an auth bypass.
- **Wrong-key reads.** A different identity cannot open a compartment. A keyring
  cannot be spliced onto another public key (the recipient is authenticated as
  AAD).

### Not protected

Stated plainly, because a private mode that overclaims is worse than none.

- **A compromised running host, or root.** Root can read the pi process's
  memory, attach to the tmux server, replace the extension, or log keystrokes.
- **The pi process's own memory** while unlocked, including the decrypted
  identity and the active conversation.
- **The local model's process and its logs.** If llama.cpp is configured to log
  prompts, prompts are on disk in plaintext. That is the operator's
  configuration, outside this code's control.
- **Terminal scrollback and tmux history** for the modal's *current* frame while
  it is on screen. The modal is redrawn rather than scrolled, so content does not
  accumulate in history, but a screen recording or a shoulder still works.
- **Anyone with the passphrase.** There is no second factor.
- **A compromised browser endpoint** — which is exactly why private mode refuses
  to run there at all, rather than trying to be safe there.
- **Traffic analysis.** Timing, turn counts, and bucketed sizes are visible to
  anyone who can see the session file or the network path to the router.
- **Transport beyond the router.** "Local" means operator-owned inference with
  no third-party egress. The hop from Familiar to the router is TLS with a
  bearer token; the router's own host is trusted.
- **Compromise of the router itself.**

---

## Configuration

| Variable | Meaning |
|---|---|
| `FAMILIAR_PRIVATE_DIR` | Keyring directory (default `$STATE_DIR/private`, 0700) |
| `FAMILIAR_PRIVATE_PROVIDER` | Optional `provider` or `provider/model` preference; narrows the local set only |
| `FAMILIAR_PRIVATE_IDLE_MS` | Idle auto-lock, default 900000 |
| `FAMILIAR_TIAMAT_URL`, `FAMILIAR_TIAMAT_TOKEN_FILE` | Shared with the `tiamat` extension |
| `FAMILIAR_AGE_BIN`, `FAMILIAR_AGE_KEYGEN_BIN` | Override the `age` binaries |

Requires `age` and `age-keygen` on PATH (already in Familiar's `piShell`), and a
router provider declared `locality: "local"`.

## Tests

`nix shell nixpkgs#bun nixpkgs#age -c bun test private/` from
`integrations/pi/extensions`, or `./familiar.sh test --all`.

Every fixture is synthetic. No test touches a real conversation, a real session
file, or a real credential; the canaries exist so a filesystem scan can prove a
negative.
