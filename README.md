# Familiar

A portable, personal, persistent, progressively-enhanced agent framework.

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
