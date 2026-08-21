{
  description = "Familiar shared configuration package";
  inputs = { nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"; flake-utils.url = "github:numtide/flake-utils"; };
  outputs = { nixpkgs, flake-utils, ... }: flake-utils.lib.eachDefaultSystem (system: { devShells.default = nixpkgs.legacyPackages.${system}.mkShell { packages = with nixpkgs.legacyPackages.${system}; [ bun nodePackages.typescript ]; }; });
}
