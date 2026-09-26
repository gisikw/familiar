{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # Exact herdr-nix commit packaging upstream's v0.9.1 release binaries.
    herdr.url = "github:herdrdev/herdr-nix/2bcfa02424385730d0c65cfa8cd355bb3afecef8";
    server = { url = "path:./services/server"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    llm = { url = "path:./services/llm"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    stt = { url = "path:./services/stt"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    tts = { url = "path:./services/tts"; inputs.nixpkgs.follows = "nixpkgs"; };
    gateway-module = { url = "path:./services/gateway"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    viewer = { url = "path:./services/viewer"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
    desktop = { url = "path:./apps/desktop"; inputs.nixpkgs.follows = "nixpkgs"; inputs.flake-utils.follows = "flake-utils"; };
  };

  outputs = { self, nixpkgs, flake-utils, herdr, server, llm, stt, tts, gateway-module, viewer, desktop }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        patchedPi = import ./nix/patches/pi-coding-agent { inherit pkgs; };
        # Keep the release package and the herdr-nix packaging revision pinned
        # together; an accidental lock/input update fails evaluation.
        herdrNixRev = "2bcfa02424385730d0c65cfa8cd355bb3afecef8";
        herdrPackage = assert herdr.sourceInfo.rev == herdrNixRev; herdr.packages.${system}.default;
        # Public immutable fleet worker runtime (see nix/worker-runtime).
        workerRuntime = import ./nix/worker-runtime {
          inherit pkgs patchedPi herdrPackage herdrNixRev;
          familiarRev = self.rev or self.dirtyRev or "unknown";
          extensionsSrc = ./integrations/pi/extensions;
        };
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
        # which injects private-instance voice packs into the Kokoro gguf.
        # Runs at runtime (run_tts), keeping mutable operator data out of the
        # world-readable Nix store.
        bakePython = pkgs.python3.withPackages (ps: with ps; [ gguf torch ]);
        impPackage = pkgs.buildGoModule {
          pname = "familiar-imp";
          version = "0.1.0";
          src = ./packages/imp;
          vendorHash = null;
          subPackages = [ "cmd/imp" ];
          doCheck = true;
          meta = with pkgs.lib; {
            description = "Private CLI-shaped model tool for Familiar residents";
            license = licenses.mit;
            mainProgram = "imp";
            platforms = platforms.unix;
          };
        };
        # Small CLI surface available both to resident Pi tool execution and to
        # foreground development shells. Keep language runtimes out of this set.
        residentCliTools = [ impPackage ] ++ (with pkgs; [ jq ripgrep fd netcat-openbsd ]);
        piShell = pkgs.mkShell (modelEnv // {
          FAMILIAR_SHELL = "pi";
          # familiar.sh still adds this immediately before launching resident
          # Pi so deployed/stale shells retain the existing confined path.
          FAMILIAR_IMP_BIN = "${impPackage}/bin";
          FAMILIAR_INTERACTIVE_SHELL = "${pkgs.bashInteractive}/bin/bash";
          PI_PACKAGE_DIR = "${patchedPi}/lib/node_modules/pi-monorepo";
          packages = [ patchedPi ] ++ residentCliTools ++ (with pkgs; [ age curl sqlite librsvg ffmpeg tmux util-linux git openssh ]);
        });
      in
      {
        packages = rec {
          pi-coding-agent = patchedPi;
          imp = impPackage;
          familiar-server = server.packages.${system}.default;
          familiar-llm = llm.packages.${system}.default;
          familiar-stt = stt.packages.${system}.default;
          familiar-gateway = gateway-module.packages.${system}.default;
          herdr = herdrPackage;
          familiar-worker-runtime = workerRuntime;
          golem-familiar-render = pkgs.buildGoModule {
            pname = "golem-familiar-render";
            version = "1";
            src = ./contrib/familiar/render;
            vendorHash = null;
            subPackages = [ "cmd/golem-familiar-render" ];
            # The renderer shells out to `tmux -S <socket> has-session` to verify
            # the exact local session behind each job, so tmux must be on PATH
            # in the packaged runtime.
            nativeBuildInputs = [ pkgs.makeWrapper ];
            postInstall = ''
              wrapProgram $out/bin/golem-familiar-render \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.tmux ]}
            '';
          };
          default = familiar-server;
        } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          familiar-tts = tts.packages.${system}.default;
          familiar-viewer = viewer.packages.${system}.default;
          familiar-desktop = desktop.packages.${system}.default;
        };
        checks = {
          imp = impPackage;
          imp-path-confinement = pkgs.runCommand "familiar-imp-path-confinement" {
            nativeBuildInputs = with pkgs; [ bash coreutils jq ];
          } ''
            bash ${self}/test/imp-path-confinement.test.sh ${self}/familiar.sh ${impPackage}/bin
            touch $out
          '';
          pi-invoke-command = patchedPi;
          worker-runtime = pkgs.runCommand "familiar-worker-runtime-check" {
            nativeBuildInputs = with pkgs; [ nodejs_24 ];
          } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            node ${self}/test/worker-runtime.mjs ${workerRuntime} ${self}/integrations/pi/extensions
            touch $out
          '';
          resident-tool-inventory = pkgs.runCommand "familiar-resident-tool-inventory" {
            PI_PACKAGE_DIR = "${patchedPi}/lib/node_modules/pi-monorepo";
            nativeBuildInputs = with pkgs; [ nodejs_24 ];
          } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            node ${self}/test/resident-tool-inventory.mjs
            touch $out
          '';
          resident-shell-tools = pkgs.runCommand "familiar-resident-shell-tools" {
            nativeBuildInputs = residentCliTools;
          } ''
            ${pkgs.bash}/bin/bash ${self}/test/resident-shell-tools.test.sh
            touch $out
          '';
        } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
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
          golem-familiar-render = flake-utils.lib.mkApp { drv = self.packages.${system}.golem-familiar-render; };
        } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          familiar-viewer = flake-utils.lib.mkApp { drv = viewer.packages.${system}.default; };
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
            FAMILIAR_INTERACTIVE_SHELL = "${pkgs.bashInteractive}/bin/bash";
            # Dev mode serves source assets directly; override only ProggyClean
            # with the same generated font installed by the gateway package.
            FAMILIAR_GATEWAY_PATCHED_FONT = "${gateway-module.packages.${system}.patched-font}/share/fonts/truetype/ProggyCleanNerdFontMono-Regular.ttf";
            packages = with pkgs; [ nodejs_22 python3 gnumake gcc curl ]
              ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ viewer.packages.${system}.default ];
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
          # Native viewer connection needs Presence's runtime tools and palette
          # resolver, but not the much larger pi/agent development environment.
          connect = pkgs.mkShell {
            FAMILIAR_SHELL = "connect";
            packages = with pkgs; [ jq tmux util-linux ];
          };
          # Browser-level terminal regression harness (test/e2e).  The
          # playwright-test wrapper points PLAYWRIGHT_BROWSERS_PATH at the
          # matching nixpkgs browser closure, so it never runs `npx install`.
          e2e = pkgs.mkShell {
            FAMILIAR_SHELL = "e2e";
            PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
            packages = with pkgs; [
              nodejs_22 playwright-test playwright-driver
              tmux util-linux curl kitty imagemagick
              gateway-module.packages.${system}.default
            ] ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
              viewer.packages.${system}.default
            ];
          };
        } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          viewer = pkgs.mkShell {
            FAMILIAR_SHELL = "viewer";
            ZIG = "${pkgs.zig_0_15}/bin/zig";
            packages = with pkgs; [ zig_0_15 cargo rustc rustfmt clippy tmux ];
          };
        };
      }
    );
}
