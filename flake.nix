{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        piShell = pkgs.mkShell {
          FAMILIAR_SHELL = "pi";
          packages = with pkgs; [ age jq sqlite pi-coding-agent tmux ];
        };
      in
      {
        devShells = {
          default = piShell;
          pi = piShell;
          llama = pkgs.mkShell {
            FAMILIAR_SHELL = "llama";
            packages = with pkgs; [ llama-cpp ];
          };
          stt = pkgs.mkShell {
            FAMILIAR_SHELL = "stt";
            packages = [ ];
          };
        };
      }
    );
}
