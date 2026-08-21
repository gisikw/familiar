{
  description = "Standalone Familiar LLM proxy";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        service = pkgs.buildGoModule {
          pname = "familiar-llm";
          version = "0.1.0";
          src = ./.;
          vendorHash = null;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          doCheck = true;
          postInstall = ''
            wrapProgram $out/bin/familiar-llm \
              --set-default FAMILIAR_LLAMA_SERVER ${pkgs.llama-cpp}/bin/llama-server
          '';
          meta = with pkgs.lib; {
            description = "Stable loopback LLM proxy with lazy llama.cpp supervision";
            license = licenses.mit;
            mainProgram = "familiar-llm";
            platforms = platforms.unix;
          };
        };
      in {
        packages.default = service;
        apps.default = {
          type = "app";
          program = "${service}/bin/familiar-llm";
          meta.description = "Run the Familiar LLM proxy";
        };
        checks.default = service;
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.go pkgs.llama-cpp ];
          FAMILIAR_LLAMA_SERVER = "${pkgs.llama-cpp}/bin/llama-server";
        };
      });
}
