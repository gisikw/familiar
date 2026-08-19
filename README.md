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

3. **Run Familiar**
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
