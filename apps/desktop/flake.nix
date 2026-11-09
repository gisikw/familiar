{
  description = "Familiar desktop client";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # Electron names the app (and so the Wayland app_id / X11 WM_CLASS)
        # after package.json's "name"; the launcher entry has to match it
        # for GNOME to group the window under the Familiar icon.
        appName = (builtins.fromJSON (builtins.readFile ./package.json)).name;
        desktopItem = pkgs.makeDesktopItem {
          name = "familiar";
          desktopName = "Familiar";
          comment = "Familiar desktop client";
          exec = "familiar-desktop %U";
          icon = "familiar";
          categories = [ "Network" "Utility" ];
          startupWMClass = appName;
        };
        desktop = pkgs.stdenvNoCC.mkDerivation {
          pname = "familiar-desktop";
          # package.json is the single source of truth for the client version.
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = ./.;
          nativeBuildInputs = [ pkgs.makeWrapper pkgs.copyDesktopItems ];
          desktopItems = [ desktopItem ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/familiar-desktop $out/bin
            cp -R src package.json build $out/share/familiar-desktop/
            for size in 16 32 48 64 128 256 512; do
              install -Dm644 build/icons/icon_$size.png \
                $out/share/icons/hicolor/''${size}x''${size}/apps/familiar.png
            done
            # --ozone-platform-hint=auto: native Wayland under GNOME/KDE,
            # X11 elsewhere (the nixpkgs wrapper also honours NIXOS_OZONE_WL).
            makeWrapper ${pkgs.electron}/bin/electron $out/bin/familiar-desktop \
              --add-flags $out/share/familiar-desktop \
              --add-flags "--ozone-platform-hint=auto"
            runHook postInstall
          '';
          meta = with pkgs.lib; {
            description = "Familiar Electron desktop client";
            license = licenses.mit;
            mainProgram = "familiar-desktop";
            platforms = platforms.linux;
          };
        };
      in {
        packages.default = desktop;
        apps.default = flake-utils.lib.mkApp { drv = desktop; };
        checks.default = desktop;
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 ];
        };
      });
}
