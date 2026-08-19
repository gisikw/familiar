{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    herdr = {
      url = "github:herdrdev/herdr";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, herdr }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        modelEnv = {
          FAMILIAR_MODEL_FILE = "gemma-4-E4B-it-Q4_K_M.gguf";
          FAMILIAR_MODEL_URL = "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/${modelEnv.FAMILIAR_MODEL_FILE}";
          FAMILIAR_STT_MODEL_FILE = "parakeet-tdt-0.6b-v3-Q8_0.gguf";
          FAMILIAR_STT_MODEL_URL = "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/main/${modelEnv.FAMILIAR_STT_MODEL_FILE}";
          FAMILIAR_TTS_MODEL_FILE = "Kokoro_espeak_Q8.gguf";
          FAMILIAR_TTS_MODEL_URL = "https://huggingface.co/mmwillet2/Kokoro_GGUF/resolve/main/${modelEnv.FAMILIAR_TTS_MODEL_FILE}";
        };
        transcribe-cpp = pkgs.stdenv.mkDerivation {
          pname = "transcribe-cpp";
          version = "unstable-2026-08-16";
          src = pkgs.fetchFromGitHub {
            owner = "handy-computer";
            repo = "transcribe.cpp";
            rev = "856d7c10a1a864b900e066b7c9801edf373f5148";
            sha256 = "1hrc2f1fx58f0hqlyzzp8vbakxm60ywbd87s7c61yd9fpwf1nlkg";
          };
          nativeBuildInputs = with pkgs; [ cmake pkg-config ];
          buildInputs = with pkgs; [ openblas ];
          installPhase = ''
            mkdir -p $out/bin
            cp bin/transcribe-cli $out/bin/
          '';
        };
        tts-cpp = pkgs.stdenv.mkDerivation {
          pname = "tts-cpp";
          version = "unstable-2026-08-16";
          src = pkgs.fetchFromGitHub {
            owner = "mmwillet";
            repo = "TTS.cpp";
            rev = "c04c77ab7575adf48c8af5a16e3bea179cba7dbb";
            fetchSubmodules = true;
            hash = "sha256-hIvYygxIjfC2zh2pLbwZT5YDeBJH4JQJXgMF+Q3pUEA=";
          };
          nativeBuildInputs = with pkgs; [ cmake pkg-config ];
          buildInputs = with pkgs; [ espeak-ng ];
          cmakeFlags = [ "-DTTS_CLI_SDL=OFF" ];
          installPhase = ''
            mkdir -p $out/bin
            cp bin/tts-server $out/bin/
            cp bin/tts-cli $out/bin/ 2>/dev/null || cp bin/cli $out/bin/tts-cli 2>/dev/null || true
          '';
        };
        # Voice baking: gguf+torch env for scripts/bake-kokoro-voices.py,
        # which injects decrypted identity voice packs (identity/voices/kokoro/
        # *.pt.age) into the Kokoro gguf. Runs at runtime (run_tts), not in a
        # derivation: the packs are age-encrypted and the key is runtime
        # state, so a pure build can't decrypt them — and shouldn't, or the
        # voice lands in the world-readable nix store.
        bakePython = pkgs.python3.withPackages (ps: with ps; [ gguf torch ]);
        familiarHerdr = herdr.packages.${system}.default.overrideAttrs (old: {
          patches = (old.patches or [ ]) ++ [ ./patches/herdr-left-nav-pty.patch ];
        });
        piShell = pkgs.mkShell (modelEnv // {
          FAMILIAR_SHELL = "pi";
          FAMILIAR_INTERACTIVE_SHELL = "${pkgs.bashInteractive}/bin/bash";
          PI_PACKAGE_DIR = "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo";
          packages = with pkgs; [ age curl jq sqlite pi-coding-agent familiarHerdr ];
        });
      in
      {
        devShells = {
          default = piShell;
          pi = piShell;
          llama = pkgs.mkShell (modelEnv // {
            FAMILIAR_SHELL = "llama";
            packages = with pkgs; [ llama-cpp ];
          });
          stt = pkgs.mkShell (modelEnv // {
            FAMILIAR_SHELL = "stt";
            packages = with pkgs; [ transcribe-cpp bun ffmpeg curl ];
          });
          tts = pkgs.mkShell (modelEnv // {
            FAMILIAR_SHELL = "tts";
            packages = with pkgs; [ tts-cpp curl age bakePython ];
          });
        };
      }
    );
}
