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
        desktop = pkgs.stdenvNoCC.mkDerivation {
          pname = "familiar-desktop";
          # package.json is the single source of truth for the client version.
          version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
          src = ./.;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            mkdir -p $out/share/familiar-desktop $out/bin
            cp -R src package.json build $out/share/familiar-desktop/
            makeWrapper ${pkgs.electron}/bin/electron $out/bin/familiar-desktop \
              --add-flags $out/share/familiar-desktop
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
