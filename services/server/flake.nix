{
  description = "Standalone Familiar Server supervisor";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        service = pkgs.buildGoModule {
          pname = "familiar-server";
          version = "0.1.0";
          src = ./.;
          vendorHash = "sha256-hj1rQJED2llW782lPYYWDD1TgNgHPa0z9nUdj4kWryw=";
          subPackages = [ "cmd/familiar-server" ];
          doCheck = true;
          checkPhase = ''
            runHook preCheck
            go test ./...
            runHook postCheck
          '';
          meta = with pkgs.lib; {
            description = "One-for-one supervisor for local Familiar services";
            license = licenses.mit;
            mainProgram = "familiar-server";
            platforms = platforms.unix;
          };
        };
      in {
        packages.default = service;
        apps.default = flake-utils.lib.mkApp { drv = service; };
        checks.default = service;
        devShells.default = pkgs.mkShell { packages = [ pkgs.go ]; };
      });
}
