# familiar-worker-runtime: the smallest public, immutable runtime a fleet
# worker node needs to launch Familiar's patched Pi under Herdr.
#
# One buildEnv-style closure with a single `bin` directory (a fleet-only Pi
# launcher, pinned Herdr, and worker tools), plus
# `share/familiar-worker/` carrying the public Tiamat extension sources, a
# versioned default profile template, and machine-readable runtime metadata.
#
# Deliberately absent: secrets, token files, private instance configuration,
# session/auth state, a repository checkout, and anything host specific. Node
# activation (stable `current` pointer, pane shell, token-file reference) is a
# fleet-side concern and is not modelled here.
{ pkgs, patchedPi, herdrPackage, herdrNixRev, familiarRev, extensionsSrc }:
let
  inherit (pkgs) lib;
  schema = 1;
  # Public extension material shipped with the runtime: the Tiamat provider
  # extension a worker needs to reach the controller's model router. The file
  # set is derived at build time by the same `workerProfileArtifact()` walker
  # the Agents controller uses for generated per-job profiles (the exact
  # relative-import graph reachable from `tiamat/index.ts`, `.ts` regular
  # files only), so the runtime ships precisely what a controller would send
  # and there is no hand-maintained module list that can drift. The Tiamat
  # README rides along as documentation.
  extensions = pkgs.runCommand "familiar-worker-extensions" {
    nativeBuildInputs = [ pkgs.nodejs_24 ];
    src = extensionsSrc;
  } ''
    export HOME="$TMPDIR/home"; mkdir -p "$HOME"
    node --input-type=module - "$src" "$out" <<'EOF'
    import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
    import { dirname, join } from "node:path";
    import { pathToFileURL } from "node:url";
    const [src, out] = process.argv.slice(2);
    const { workerProfileArtifact } = await import(pathToFileURL(join(src, "agents/transport.mjs")).href);
    const artifact = workerProfileArtifact("tiamat/index.ts", src);
    for (const [name, source] of Object.entries(artifact.files)) {
      mkdirSync(join(out, dirname(name)), { recursive: true });
      writeFileSync(join(out, name), source);
    }
    copyFileSync(join(src, "tiamat/README.md"), join(out, "tiamat/README.md"));
    EOF
  '';
  # Practical worker tools: what the resident `pi` shell and the isolated
  # `agents` shell already make explicit, minus resident-only media/secret
  # tooling. Process basics differ per platform: procps/util-linux are Linux
  # packages; Darwin keeps its system `ps`/`pgrep` under /bin and /usr/bin.
  workerTools = with pkgs; [
    bashInteractive coreutils findutils gnugrep gnused gawk
    git jq ripgrep fd python3 openssh
  ] ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux (with pkgs; [ procps util-linux ]);
  # Fleet workers must never accidentally start a provider-less Pi. Keep the
  # patched package itself immutable and invoke it by its exact store path;
  # tests and the resident shell continue to use patchedPi directly.
  piEntrypoint = pkgs.writeShellScriptBin "pi" ''
    if [ -z "''${FAMILIAR_TIAMAT_URL:-}" ]; then
      echo "Failed to start pi: missing FAMILIAR_TIAMAT_URL" >&2
      exit 1
    fi
    if [ -z "''${FAMILIAR_TIAMAT_TOKEN_FILE:-}" ]; then
      echo "Failed to start pi: missing FAMILIAR_TIAMAT_TOKEN_FILE" >&2
      exit 1
    fi
    if [ ! -f "$FAMILIAR_TIAMAT_TOKEN_FILE" ]; then
      echo "Failed to start pi: FAMILIAR_TIAMAT_TOKEN_FILE is not a regular file" >&2
      exit 1
    fi
    if [ ! -r "$FAMILIAR_TIAMAT_TOKEN_FILE" ]; then
      echo "Failed to start pi: FAMILIAR_TIAMAT_TOKEN_FILE is not readable" >&2
      exit 1
    fi
    if [ ! -s "$FAMILIAR_TIAMAT_TOKEN_FILE" ]; then
      echo "Failed to start pi: FAMILIAR_TIAMAT_TOKEN_FILE is empty" >&2
      exit 1
    fi
    exec ${patchedPi}/bin/pi "$@"
  '';
  components = [ piEntrypoint herdrPackage ] ++ workerTools;
  componentRecord = p: {
    name = lib.getName p;
    version = lib.getVersion p;
    store_path = "${p}";
  };
  metadata = {
    inherit schema;
    name = "familiar-worker-runtime";
    familiar_rev = familiarRev;
    system = pkgs.stdenv.hostPlatform.system;
    pi = {
      version = patchedPi.version;
      upstream_commit = patchedPi.src.rev;
      patches = map baseNameOf patchedPi.patches;
      store_path = "${patchedPi}";
      entrypoint = "bin/pi";
      fail_closed_tiamat = true;
    };
    herdr = componentRecord herdrPackage // {
      nix_input_revision = herdrNixRev;
    };
    tools = map componentRecord workerTools;
    extensions = [ "tiamat" ];
    profile_template = "share/familiar-worker/profile/settings.json";
  };
in
pkgs.buildEnv {
  name = "familiar-worker-runtime";
  paths = components;
  pathsToLink = [ "/bin" ];
  # Collisions are a packaging error, never something to paper over.
  ignoreCollisions = false;
  postBuild = ''
    share="$out/share/familiar-worker"
    mkdir -p "$share/profile"
    ln -s ${extensions} "$share/extensions"
    # Versioned default worker profile: only the public extension path and
    # resource-loading policy. Providers/credentials arrive through the
    # node's FAMILIAR_TIAMAT_URL / FAMILIAR_TIAMAT_TOKEN_FILE references at
    # launch, never through this file. The path is the immutable store path
    # of this output; a node that prefers a stable pointer rewrites it.
    ${pkgs.jq}/bin/jq -n --arg ext "$share/extensions/tiamat" '{
      extensions: [$ext],
      defaultProjectTrust: "never",
      lastChangelogVersion: ${builtins.toJSON patchedPi.version}
    }' > "$share/profile/settings.json"
    ${pkgs.jq}/bin/jq . ${pkgs.writeText "familiar-worker-runtime.json" (builtins.toJSON metadata)} \
      > "$share/runtime.json"
  '';
  passthru = {
    inherit metadata extensions workerTools piEntrypoint;
    pi = patchedPi;
    herdr = herdrPackage;
  };
  meta = {
    description = "Immutable public Familiar worker runtime: patched Pi, pinned Herdr, and worker tools";
    platforms = lib.platforms.unix;
    mainProgram = "pi";
  };
}
