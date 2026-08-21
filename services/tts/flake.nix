{
  description = "Standalone Familiar TTS proxy and local Kokoro backends";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      each = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = each (pkgs:
        let
          linux = pkgs.stdenv.hostPlatform.isLinux;
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
            meta = { description = "TTS.cpp server"; homepage = "https://github.com/mmwillet/TTS.cpp"; license = pkgs.lib.licenses.mit; platforms = pkgs.lib.platforms.linux; };
          };
          bakePython = pkgs.python3.withPackages (p: [ p.gguf p.torch ]);
          baker = pkgs.writeShellApplication {
            name = "familiar-bake-kokoro";
            runtimeInputs = [ bakePython ];
            text = ''exec ${bakePython}/bin/python ${./runtime/bake-kokoro-voices.py} "$@"'';
            meta = { description = "Optional Kokoro custom voice GGUF baker"; license = pkgs.lib.licenses.mit; platforms = pkgs.lib.platforms.linux; };
          };
          kokoroPython = pkgs.python3.withPackages (p: [ p.kokoro p.soundfile ]);
          kokoroBackend = pkgs.writeShellApplication {
            name = "familiar-kokoro-server";
            text = ''exec ${kokoroPython}/bin/python ${./runtime/kokoro-server.py} "$@"'';
            meta = { description = "OpenAI-compatible adapter for hexgrad Kokoro"; license = pkgs.lib.licenses.mit; platforms = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ]; };
          };
          mkProxy = { name, path, platforms, defaults ? "", withBaker ? false }: pkgs.buildGoModule {
            pname = name; version = "0.3.0"; src = ./.;
            vendorHash = null; subPackages = [ "cmd/familiar-tts" ];
            nativeBuildInputs = [ pkgs.makeWrapper ];
            postInstall = ''
              wrapProgram $out/bin/familiar-tts \
                --prefix PATH : ${pkgs.lib.makeBinPath (path ++ [ pkgs.age pkgs.coreutils ] ++ pkgs.lib.optional withBaker baker)} \
                ${defaults} \
                ${pkgs.lib.optionalString withBaker "--set-default FAMILIAR_TTS_BAKER familiar-bake-kokoro"}
            '';
            meta = { description = "Local stable Familiar TTS HTTP proxy"; homepage = "https://github.com/familiar/familiar"; license = pkgs.lib.licenses.mit; mainProgram = "familiar-tts"; inherit platforms; };
          };
          proxy = mkProxy { name = "familiar-tts"; path = [ tts-cpp ]; platforms = pkgs.lib.platforms.linux; };
          withBaker = mkProxy { name = "familiar-tts-with-voice-baker"; path = [ tts-cpp ]; platforms = pkgs.lib.platforms.linux; withBaker = true; };
          kokoroProxy = mkProxy {
            name = "familiar-tts-kokoro"; path = [ kokoroBackend ];
            platforms = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
            defaults = "--set-default FAMILIAR_TTS_LOCAL_BACKEND kokoro --set-default FAMILIAR_TTS_BACKEND_COMMAND familiar-kokoro-server";
          };
        in {
          familiar-tts-kokoro = kokoroProxy;
          kokoro-backend = kokoroBackend;
        } // pkgs.lib.optionalAttrs linux {
          default = proxy; familiar-tts = proxy;
          familiar-tts-with-voice-baker = withBaker;
          inherit tts-cpp baker;
        });
      checks = each (pkgs: {
        familiar-tts-kokoro = self.packages.${pkgs.system}.familiar-tts-kokoro;
      } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        familiar-tts = self.packages.${pkgs.system}.familiar-tts;
        familiar-tts-with-voice-baker = self.packages.${pkgs.system}.familiar-tts-with-voice-baker;
      });
      devShells = each (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.go self.packages.${pkgs.system}.kokoro-backend pkgs.age ]; };
      } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
        voices = pkgs.mkShell { packages = [ pkgs.go self.packages.${pkgs.system}.baker ]; };
      });
    };
}
