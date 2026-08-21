{
  description = "Standalone Familiar STT proxy";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        transcribe-cpp = pkgs.stdenv.mkDerivation {
          pname = "transcribe-cpp";
          version = "unstable-2026-08-16";
          src = pkgs.fetchFromGitHub {
            owner = "handy-computer";
            repo = "transcribe.cpp";
            rev = "856d7c10a1a864b900e066b7c9801edf373f5148";
            hash = "sha256-b1IbHL8uNR8MO/qgtrgHpvap1kb3f08xBA6V7oITLMM=";
          };
          nativeBuildInputs = with pkgs; [ cmake pkg-config ];
          buildInputs = with pkgs; [ openblas ];
          installPhase = ''mkdir -p $out/bin; cp bin/transcribe-cli $out/bin/'';
        };
        familiar-stt-unwrapped = pkgs.buildGoModule {
          pname = "familiar-stt";
          version = "0.1.0";
          src = ./.;
          vendorHash = null;
          subPackages = [ "cmd/familiar-stt" ];
          doCheck = true;
          preCheck = "go test ./...";
        };
        familiar-stt = pkgs.symlinkJoin {
          name = "familiar-stt-0.1.0";
          paths = [ familiar-stt-unwrapped ];
          nativeBuildInputs = [ pkgs.makeWrapper ];
          postBuild = ''wrapProgram $out/bin/familiar-stt --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ffmpeg transcribe-cpp pkgs.coreutils ]}'';
        };
      in {
        packages = { default = familiar-stt; inherit familiar-stt transcribe-cpp; };
        apps.default = flake-utils.lib.mkApp { drv = familiar-stt; };
        checks = {
          unit = familiar-stt-unwrapped;
          package = familiar-stt;
          runtime-tools = pkgs.runCommand "stt-runtime-tools" { nativeBuildInputs = [ pkgs.ffmpeg transcribe-cpp ]; } ''
            ffmpeg -version >/dev/null
            transcribe-cli --help >/dev/null 2>&1 || test $? -le 1
            touch $out
          '';
        };
        devShells.default = pkgs.mkShell { packages = [ pkgs.go pkgs.ffmpeg transcribe-cpp ]; };
      });
}
