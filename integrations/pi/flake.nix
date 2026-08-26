{
  description = "Familiar pi adapters and extensions";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          PI_PACKAGE_DIR = "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo";
          packages = with pkgs; [ bun pi-coding-agent ];
        };
      });
}
