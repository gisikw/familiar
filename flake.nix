{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    herdr = {
      url = "github:herdrdev/herdr";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    server = { url = "path:./services/server"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    llm = { url = "path:./services/llm"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    stt = { url = "path:./services/stt"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    tts = { url = "path:./services/tts"; inputs.nixpkgs.follows = "nixpkgs"; };
    gateway-module = { url = "path:./services/gateway"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    desktop = { url = "path:./apps/desktop"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    agents = { url = "path:./agents"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
  };

  outputs = { self, nixpkgs, flake-utils, herdr, server, llm, stt, tts, gateway-module, desktop, agents }:
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
        familiarSplash = pkgs.buildGoModule {
          pname = "familiar-splash";
          version = "0.1.0";
          src = ./scripts/splash;
          vendorHash = null;
        };
        familiarHerdr = herdr.packages.${system}.default.overrideAttrs (old: {
          patches = (old.patches or [ ]) ++ [ ./integrations/pi/patches/herdr-left-nav-pty.patch ];
        });
        piShell = pkgs.mkShell (modelEnv // {
          FAMILIAR_SHELL = "pi";
          FAMILIAR_INTERACTIVE_SHELL = "${pkgs.bashInteractive}/bin/bash";
          # Subagents run as Herdr agents in their own panes/worktrees.
          # The extension refuses to dispatch unless this is "herdr".
          FAMILIAR_SUBAGENT_MODE = "herdr";
          PI_PACKAGE_DIR = "${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo";
          packages = with pkgs; [ age curl jq sqlite pi-coding-agent familiarHerdr familiarSplash librsvg ffmpeg tmux util-linux ];
        });
      in
      {
        packages = rec {
          familiar-server = server.packages.${system}.default;
          familiar-llm = llm.packages.${system}.default;
          familiar-stt = stt.packages.${system}.default;
          familiar-gateway = gateway-module.packages.${system}.default;
          familiar-agents = agents.packages.${system}.cli;
          familiar-agents-service = agents.packages.${system}.service;
          familiar-agents-supervisor = agents.packages.${system}.supervisor;
          default = familiar-server;
        } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          familiar-tts = tts.packages.${system}.default;
          familiar-desktop = desktop.packages.${system}.default;
        };
        checks = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          drop-serve-lifecycle = pkgs.runCommand "drop-serve-lifecycle" {
            nativeBuildInputs = with pkgs; [ bash coreutils gnugrep gawk netcat-openbsd ];
          } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            bash ${self}/test/drop-serve-lifecycle.test.sh ${self}/familiar.sh
            touch $out
          '';
        };
        apps = {
          default = flake-utils.lib.mkApp { drv = server.packages.${system}.default; };
          familiar-server = flake-utils.lib.mkApp { drv = server.packages.${system}.default; };
          familiar-gateway = flake-utils.lib.mkApp { drv = gateway-module.packages.${system}.default; };
          familiar-agents = flake-utils.lib.mkApp { drv = agents.packages.${system}.cli; };
          familiar-agents-service = flake-utils.lib.mkApp { drv = agents.packages.${system}.service; };
          familiar-agents-supervisor = flake-utils.lib.mkApp { drv = agents.packages.${system}.supervisor; };
        } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          familiar-desktop = flake-utils.lib.mkApp { drv = desktop.packages.${system}.default; };
        };
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
          # The Familiar Interface Gateway (./services/gateway): a plain Node
          # service owning ingress/egress and the browser terminal. node-pty
          # ships no Linux prebuild, so its first install needs a native build
          # toolchain. The services pane invokes `npm start` here directly.
          gateway = pkgs.mkShell {
            FAMILIAR_SHELL = "gateway";
            packages = with pkgs; [ nodejs_22 python3 gnumake gcc curl ];
          };
          # The Electron chrome shell under apps/desktop/. It is a DUMB CLIENT: a
          # frameless Electron window that loads the familiar server's served
          # terminal page (FAMILIAR_BASE_URL). No node-pty, no vendored restty,
          # no bundled fonts — the served page owns all of that. Only Electron
          # (pulled from npm) plus a matching Node to drive it is needed; this
          # is the single source of truth for that version.
          client = pkgs.mkShell {
            FAMILIAR_SHELL = "client";
            packages = with pkgs; [ nodejs_22 ];
          };
        };
      }
    );
}
