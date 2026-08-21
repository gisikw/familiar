{
  description = "Standalone Familiar delegated-agent system";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        build = name: subPackages: pkgs.buildGoModule {
          pname = name;
          version = "0.1.0";
          src = ./.;
          inherit subPackages;
          vendorHash = "sha256-dsmRXd5moOA08U2Hbi9Z3Hy1inZFiDOD9AMS56uk+8g=";
          doCheck = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          meta = with pkgs.lib; { license = licenses.mit; platforms = platforms.unix; };
        };
        cli = build "familiar-agents" [ "./cmd/familiar-agents" ];
        service = build "familiar-agents-service" [ "./cmd/familiar-agents-service" ];
        supervisor = (build "familiar-agents-supervisor" [ "./cmd/familiar-agents-supervisor" ]).overrideAttrs (old: {
          postInstall = (old.postInstall or "") + ''
            wrapProgram $out/bin/familiar-agents-supervisor --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.tmux pkgs.git pkgs.bash ]}
          '';
        });
      in {
        packages = { inherit cli service supervisor; default = cli; };
        apps.default = { type = "app"; program = "${cli}/bin/familiar-agents"; meta.description = "Control Familiar delegated agents"; };
        checks = { inherit cli service supervisor; };
        devShells.default = pkgs.mkShell { packages = [ pkgs.go pkgs.tmux pkgs.git ]; };
      });
}
