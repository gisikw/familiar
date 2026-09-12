# Isolated Familiar Agents proofs

These are test fixtures, not production processes. `live-proof.mjs` starts a
fresh named Herdr namespace in a private temporary HOME/XDG tree. It imports
existing Drover Coordinator/local_rpc code and creates two disposable loopback
SSH endpoints with newly generated test-only keys. **No resident Presence/Pi,
Herdr namespace, SSH config, authorized_keys or services are modified.**

The controller is the real Familiar-pinned Pi TUI running the real Agents
extension and existing familiar-ui bridge. `foreground.ts` only supplies test
commands invoking its registered tools; it does not substitute the ledger,
owner, transport, reconciliation or settlement code. The worker is real Pi in a
visible Herdr space. `question.ts` asks a real Pi UI question and uses Herdr's
existing optional blocked event; it is not a Familiar lifecycle detector.

This demonstrates local production-Transport integration, **not O'Brien**. The
fixture deliberately does not exercise outbound reverse-tunnel installation or
Drover serve's OS-account bootstrap checks. Those require the authorized remote
proof with the existing enrolled machine route.

## Fast checks

From the Familiar repository:

```sh
nix develop .#agents -c node --test integrations/pi/extensions/agents/*.node-test.mjs integrations/pi/extensions/imp/*.node-test.mjs
nix develop .#agents -c python integrations/pi/extensions/agents/test_remote.py
nix develop .#agents -c node test/agents/tools.mjs
nix develop .#agents -c bun test integrations/pi/extensions contrib/familiar
nix build --no-link .#checks.x86_64-linux.agents-ledger .#checks.x86_64-linux.pi-invoke-command
```

Node tests use Node's SQLite, not Bun's unrelated SQLite API. The `.node-test.mjs`
name keeps them out of Bun discovery. The normal extension loader itself remains
safe to load under Bun: SQLite is required only when constructing a real ledger.

`tools.mjs` loads the actual Agents and Imp extensions with the pinned Pi loader,
then invokes all thirteen operations through the real private socket against the
real ledger/owner, with offline mocked transport. It verifies that no
`familiar_agents_*` tools are registered, foreground-only ownership, honest Exo
attribution, recovery actions, private rejection, restart/admission idempotency,
typed bounded results, strict request validation, and isolation from a failing
optional projection subscriber. It also proves the Agent availability policy end
to end: an empty policy denies dispatch before any ledger admission, an
unenrolled route/machine cannot be granted, the `familiar.agent-policy.v1`
service reads and compare-and-set mutates the same state as the `policy-show` /
`policy-set` operations behind `imp agent policy`, private mode refuses both, and
the service is removed on shutdown. `policy.node-test.mjs` covers
persistence/restart, deterministic bytes, malformed/unknown-version fail-closed
refusal, revision conflicts, exact route collisions, on/off non-destructiveness,
fallback inheritance by a late node, overrides, bounds, projection privacy and
the dispatch enforcement point. `imp/ingress.node-test.mjs` separately proves
the fixed two-area router, dynamic availability, private lifecycle and wire
bounds. The fast checks do not contact providers or resident services and do
not build/test the obsolete Rust viewer.

The retained live fixture below is opt-in historical candidate material, **not**
a claim that the focused-recovery run executed a real-provider or O'Brien proof.
It includes multiple inference phases; do not run it during bounded review
without separately authorizing that cost/scope. Production profile enrollment
remains an operator action using remote file references, never credential values.

## Live proof

Build the matching familiar-ui Node packages first (`npm ci && npm run build:node`
in its isolated repository). Supply explicit references in a private shell:

```sh
# Paths to isolated repositories; defaults are siblings of Familiar.
export FA_PROOF_DROVER_REPO=/absolute/isolated/drover
export FA_PROOF_UI_REPO=/absolute/isolated/familiar-ui
# Exact existing Herdr 0.9.0 binary. Never select an ambient 0.8 server.
export FA_PROOF_HERDR=/absolute/pinned/herdr-0.9.0/bin/herdr

# Existing authorized worker mechanism: references only, never pasted values.
export FA_PROOF_TIAMAT_URL=https://your-authorized-router
export FA_PROOF_TIAMAT_TOKEN_FILE=/absolute/existing/authorized/token-file
export FA_PROOF_PROVIDER=your-configured-provider-id
export FA_PROOF_MODEL=your-configured-model-id

nix develop .#agents -c bash -c '
  export FA_PROOF_PYTHON=$(command -v python3)
  export FA_PROOF_CONTROLLER_PI=$(command -v pi)
  export FA_PROOF_SCRIPT=$(command -v script)
  export FA_PROOF_SHELL=$(command -v bash)
  export FA_PROOF_SSHD=$(command -v sshd)
  export FA_PROOF_WORKER_PATH="$PATH"
  node test/agents/live-proof.mjs
'
```

The Python interpreter needs aiohttp for the fixture; the declared agents shell
provides it. The worker PATH must contain real Pi, Git, Python, fd/rg and ordinary
shell tools. No profile/auth bundle is copied from the controller. Pi may create
an **empty** auth.json on first birth; non-empty credentials there fail this proof.

The proof fails on persisted/streamed assistant error records even if Pi exits
zero. It verifies:

* real production Drover HTTP/catalog/RPC and pinned SSH jump/node routing;
* named workspace and native Herdr client attach; foreground process is Pi;
* real inference, UI blocking, answer delivery, file edit/test/review;
* foreground command responsiveness and the existing UI bridge projection;
* manual Escape → idle/unsettled, not failure, followed by natural completion;
* SIGKILL of only the isolated foreground Pi, immediate proven-dead lease takeover,
  durable job preservation and no duplicate admission/settlement notification;
* actual Drover control-WebSocket loss, unknown reachability and reconnect;
* a second real dispatch using the generated credential-free Tiamat profile;
* refusal to remove dirty work, explicit operator correction and retryable cleanup.

The printed private root retains `evidence.json`, the ledger, native-attach log,
first-job worktree/session proof and test logs. Disposable SSH private keys and
Drover client token are removed by fixture teardown; all test endpoints and the
named test Herdr are stopped. The generated second-job profile/session history is
intentionally deleted by the retention test. Remove the retained private test
root only after evidence review. Its `.lock` and `.retired.json` files demonstrate
cleanup fencing, not a resident remote service.

## External release gate

Run the authorized O'Brien proof through structured Drover + its native machine
route, with the required existing-method forwards installed by the operator.
Do not silently fall back to local execution or plain admin SSH and call that
cross-host evidence. If the authorized route/configuration is absent, finish
local checks, leave unpushed commits and request a credential-free operator action.
Do not request or embed bearer values, private keys or passwords.
