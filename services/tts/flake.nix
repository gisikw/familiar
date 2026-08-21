{
  description = "Standalone Familiar TTS proxy and local Kokoro backend";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      each = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = each (pkgs:
        let
          tts-cpp = pkgs.stdenv.mkDerivation {
            pname = "tts-cpp"; version = "unstable-2026-08-16";
            src = pkgs.fetchFromGitHub {
              owner = "mmwillet"; repo = "TTS.cpp";
              rev = "c04c77ab7575adf48c8af5a16e3bea179cba7dbb";
              fetchSubmodules = true;
              hash = "sha256-hIvYygxIjfC2zh2pLbwZT5YDeBJH4JQJXgMF+Q3pUEA=";
            };
            nativeBuildInputs = with pkgs; [ cmake pkg-config ];
            buildInputs = [ pkgs.espeak-ng ];
            cmakeFlags = [ "-DTTS_CLI_SDL=OFF" ];
            installPhase = ''mkdir -p $out/bin; cp bin/tts-server $out/bin/'';
          };
          bakePython = pkgs.python3.withPackages (p: [ p.gguf p.torch ]);
          baker = pkgs.writeShellScriptBin "familiar-bake-kokoro" ''
            exec ${bakePython}/bin/python ${./runtime/bake-kokoro-voices.py} "$@"
          '';
          proxy = pkgs.buildGoModule {
            pname = "familiar-tts"; version = "0.1.0"; src = ./.;
            vendorHash = null;
            subPackages = [ "cmd/familiar-tts" ];
            nativeBuildInputs = [ pkgs.makeWrapper ];
            postInstall = ''
              wrapProgram $out/bin/familiar-tts \
                --prefix PATH : ${pkgs.lib.makeBinPath [ tts-cpp pkgs.age pkgs.coreutils baker ]} \
                --set-default FAMILIAR_TTS_BAKER familiar-bake-kokoro
            '';
          };
        in { default = proxy; familiar-tts = proxy; inherit tts-cpp baker; });
      checks = each (pkgs: { familiar-tts = self.packages.${pkgs.system}.familiar-tts; });
      devShells = each (pkgs: { default = pkgs.mkShell { packages = [ pkgs.go self.packages.${pkgs.system}.tts-cpp pkgs.age self.packages.${pkgs.system}.baker ]; }; });
    };
}
