{
  description = "Familiar Interface Gateway";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        gateway = pkgs.buildNpmPackage {
          pname = "familiar-gateway";
          version = "0.1.0";
          src = ./.;
          npmDepsHash = "sha256-h1Ztyscvv/O8bzeBY1lPjhXd2esELhlmWQ4tUEMpc+o=";
          nodejs = pkgs.nodejs_22;
          dontNpmBuild = true;
          nativeBuildInputs = with pkgs; [ makeWrapper python3 gnumake gcc ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/familiar-gateway $out/bin
            cp -R src web vendor fonts package.json node_modules $out/lib/familiar-gateway/
            makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/familiar-gateway \
              --add-flags "--experimental-transform-types $out/lib/familiar-gateway/src/main.ts"
            runHook postInstall
          '';
          meta = with pkgs.lib; {
            description = "Familiar Interface Gateway";
            license = licenses.mit;
            mainProgram = "familiar-gateway";
            platforms = platforms.unix;
          };
        };
      in {
        packages.default = gateway;
        apps.default = flake-utils.lib.mkApp { drv = gateway; };
        checks.default = gateway;
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [ nodejs_22 python3 gnumake gcc curl ];
        };
      });
}
