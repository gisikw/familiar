# Familiar

```text
   ^       ^ 
  / \ :-: / \       
 /-v (o o) v-\ <~.     _____               _ _ _ 
 \ .- \_/ -. /   '    |  ___|_ _ _ __ ___ (_) (_) __ _ _ __ 
  \  /'''\  /   //    | |_ / _` | '_ ` _ \| | | |/ _` | '__|
    |'.'.'\ ___\ \    |  _| (_| | | | | | | | | | (_| | |
     \' ' ' ' ' '/    |_|  \__,_|_| |_| |_|_|_|_|\__,_|_|
      ("|")._\(."
       "" ""   "
```

A portable, personal, progressively-enhanced agent framework.

## Installation

1. **Install Nix** via the [Determinate Nix Installer](https://github.com/DeterminateSystems/nix-installer)
   (flakes enabled by default, clean uninstall path):

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
   ```

2. **Clone this repo** (nix can provide git before the system has it):

   ```bash
   nix shell nixpkgs#git -c git clone git@github.com:gisikw/familiar.git ~/Projects/familiar
   ```

3. **Optionally create private local configuration**
   ```bash
   cp familiar.toml.example familiar.toml
   chmod 600 familiar.toml
   ```
   See [docs/CONFIG.md](docs/CONFIG.md) for mapping and precedence.

4. **Run Familiar**
   ```bash
   ./familiar.sh
   ```

## Privacy

Some components are optionally encrypted at rest using [age](https://github.com/FiloSottile/age).

Edit or create new files via:
   ```bash
   echo "My dog's name is Fido" | ./familiar.sh age ./identity/01-household.md.age
   ./familiar.sh age ./identity/00-private.md.age # opens in $EDITOR, reencrypting on close
   ```

The files are decrypted at runtime. On first use, a key will be generated at
$FAMILIAR_AGE_KEY, which defaults to ./state/age.key.

## Extension layout

Familiar follows pi's directory-entry convention: every extension entrypoint is
`extensions/<extension-name>/index.ts`. Shared implementation remains under
`extensions/lib`, while tests and helpers are colocated beneath extension
subdirectories. Do not add root `extensions/*.ts` or `extensions/*.js` files:
pi 0.84.1 treats every root `.ts`/`.js` file as an extension, whereas it loads
only `index.ts`/`index.js`
(or a declared package entry) from each immediate subdirectory. This keeps Bun-only
tests and support modules outside runtime auto-discovery without a second manifest.

## Quota footer

When pi is logged into `openai-codex`, Familiar shows Codex subscription windows
as explicit used/remaining percentages and reset durations. It uses quota headers
when pi exposes them, otherwise a read-only account-usage GET at most every five
minutes. The extension reads only pi's current OAuth access token/account ID;
pi alone refreshes and writes auth. Last-known values are marked `stale` when the
first-party but semi-private endpoint is unavailable. This is distinct from
request tokens, API RPM/TPM, and generic ChatGPT allowances.

## Primitives

- Work Tracking
- Calendar
- Multimodal access
- Work dispatch
- Persistent identity over time
- Context load / set-down
- Expression surface
- Proactivity
- Long memory / history
- Perception / ingress
- Attention policy / autonomy budget
- Latency tiers
