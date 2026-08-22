{
  description = "Temporary tmux-backed Familiar Presence Runtime adapter";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      eachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = eachSystem (pkgs: {
        default = pkgs.writeShellApplication {
          name = "familiar-presence";
          runtimeInputs = [ pkgs.bash pkgs.coreutils pkgs.librsvg pkgs.tmux pkgs.util-linux ];
          text = ''
            export FAMILIAR_PRESENCE_CONFIG=${./tmux.conf}
            export FAMILIAR_SIDEBAR_SCRIPT=${./sidebar.sh}
            export FAMILIAR_SIDEBAR_MARK=${../../assets/familiar-mark.svg}
            export FAMILIAR_SIDEBAR_MARK_PNG=${../../assets/familiar-mark.png}
            exec bash ${./presence.sh} "$@"
          '';
        };
      });
      checks = eachSystem (pkgs: {
        adapter = pkgs.runCommand "familiar-presence-check" {
          nativeBuildInputs = [ pkgs.bash pkgs.coreutils pkgs.tmux pkgs.util-linux ];
        } ''
          export HOME=$TMPDIR/home
          export PRESENCE=${./presence.sh}
          export FAMILIAR_PRESENCE_CONFIG=${./tmux.conf}
          export SKIP_BROWSER_CONTRACT=1
          mkdir -p "$HOME"
          bash ${./test.sh}
          touch $out
        '';
      });
      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.tmux pkgs.util-linux pkgs.shellcheck ]; };
      });
    };
}
