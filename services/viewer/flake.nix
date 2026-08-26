{
  description = "Familiar native terminal viewer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # build.zig.zon contains lazy dependencies which Zig still resolves
        # while loading the package graph. The generated manifest fetches each
        # dependency as a fixed-output derivation and lays out an offline cache.
        zigPackageCache = pkgs.callPackage ./vendor/libghostty-vt/build.zig.zon.nix {
          name = "familiar-viewer-zig-package-cache";
          linkFarm = name: entries: pkgs.runCommand name { } ''
            mkdir -p "$out"
            ${pkgs.lib.concatMapStringsSep "\n" (entry: ''
              cp -rL ${entry.path} "$out/${entry.name}"
            '') entries}
          '';
        };
        viewer = pkgs.rustPlatform.buildRustPackage {
          pname = "familiar-viewer";
          version = "0.1.0";
          src = ./.;
          cargoLock.lockFile = ./Cargo.lock;
          nativeBuildInputs = with pkgs; [ makeWrapper zig_0_15 ];
          # Zig is invoked by Cargo's build.rs; do not let nixpkgs' Zig setup
          # hook replace buildRustPackage's Cargo phases.
          dontUseZigBuild = true;
          dontUseZigCheck = true;
          dontUseZigInstall = true;
          env.ZIG = "${pkgs.zig_0_15}/bin/zig";
          preBuild = ''
            export ZIG_GLOBAL_CACHE_DIR="$TMPDIR/zig-cache"
            mkdir -p "$ZIG_GLOBAL_CACHE_DIR/p"
            cp -R ${zigPackageCache}/* "$ZIG_GLOBAL_CACHE_DIR/p/"
          '';
          postInstall = ''
            install -Dm444 ${../../assets/familiar-mark.png} \
              "$out/share/familiar/familiar-mark.png"
            wrapProgram "$out/bin/familiar-viewer" \
              --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.tmux ]} \
              --set-default FAMILIAR_MARK_PNG "$out/share/familiar/familiar-mark.png"
          '';
          meta = with pkgs.lib; {
            description = "Familiar native terminal viewer";
            license = licenses.mit;
            mainProgram = "familiar-viewer";
            platforms = [ "x86_64-linux" "aarch64-linux" ];
          };
        };
        fmt = pkgs.runCommand "familiar-viewer-fmt" {
          nativeBuildInputs = with pkgs; [ cargo rustfmt ];
          src = ./.;
        } ''
          cp -R "$src" source
          chmod -R u+w source
          cd source
          cargo fmt --check
          touch "$out"
        '';
      in {
        packages.default = viewer;
        apps.default = flake-utils.lib.mkApp { drv = viewer; };
        checks = {
          package = viewer;
          inherit fmt;
        };
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [ zig_0_15 cargo rustc rustfmt clippy tmux ];
          ZIG = "${pkgs.zig_0_15}/bin/zig";
        };
      });
}
