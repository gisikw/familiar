{ pkgs }:
let
  base = pkgs.pi-coding-agent;
  lockedBaseVersion = "0.84.1";
  targetVersion = "1.5.0";
  targetCommit = "f9a26365568127461c47a07a37dcb42c140a3ac5";
  targetSrc = pkgs.fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi";
    rev = targetCommit;
    hash = "sha256-eH3RuypmXeayuZ9lEag6KW3m2LSM4bDc4ogyHxjZMNI=";
  };
  targetModelData = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${targetVersion}.tgz";
    hash = "sha256-4yD+e9K5J3grqaN9NW/lg38aqWpGQyYQ4bO5zLdI6lw=";
  };
in
assert pkgs.lib.assertMsg (base.version == lockedBaseVersion)
  "Familiar Pi adaptation: unverified locked nixpkgs base ${base.version}; expected ${lockedBaseVersion}. Review the ${targetVersion} recipe adaptation before updating.";
assert pkgs.lib.assertMsg (base.src.outputHash == "sha256-lg+I4S/aAjazjhGZU567ow+rksoNiqOqjHl//TjAMes=")
  "Familiar Pi adaptation: locked nixpkgs base source changed; review the recipe and patch ordering.";
base.overrideAttrs (old:
assert pkgs.lib.assertMsg ((old.patches or []) == [] && (old.prePatch or "") == "")
  "Familiar Pi adaptation: upstream nixpkgs now patches Pi; review patch ordering and inputs.";
{
  version = targetVersion;
  src = targetSrc;
  npmDepsHash = "sha256-koVd02HEhEAOkcvIuUg4X1A6P6P0B+wJp4DJLwkH62w=";
  # overrideAttrs runs after buildNpmPackage formed its fetched dependency tree,
  # so replace that derived input as well as documenting its vendor hash.
  npmDeps = pkgs.fetchNpmDeps {
    name = "pi-coding-agent-${targetVersion}-npm-deps";
    src = targetSrc;
    hash = "sha256-koVd02HEhEAOkcvIuUg4X1A6P6P0B+wJp4DJLwkH62w=";
  };
  modelData = targetModelData;

  # Upstream's root `build:offline` script owns the workspace order (1.5.0:
  # telemetry, schema, chord, tui, codemode, mcp, ai, durable, env, agent,
  # coding-agent; protocol/client/server are gone since 1.2) and checks the
  # restored model data instead of fetching it. This mirrors nixpkgs' exact
  # 1.5.0 recipe while the locked nixpkgs still packages 0.84.1.
  buildPhase = ''
    runHook preBuild

    npm run build:offline

    runHook postBuild
  '';
  dontNpmPrune = true;
  preInstall = ''
    npm prune --omit=dev --no-save
  '';

  # Verify pristine inputs BEFORE downstream patches. Whole-file hashes
  # intentionally fail closed on unrelated source movement.
  prePatch = ''
    echo 'Verifying Familiar Pi ${targetVersion} patch inputs (fail closed)'
    sha256sum --check --strict ${./upstream.sha256}
  '';
  # Order is contractual: command fencing, then the provider-only
  # pre-resolution bootstrap (which relies on loader queuing).
  # cache-write-1h-delta.patch is retired: upstream pi-ai reads the
  # message_delta cache_creation 1h split itself (present by 1.1.0). Its
  # behavior test still runs against the installed output below.
  patches = [ ./invoke-command.patch ./model-bootstrap.patch ./manual-short-compaction.patch ];

  postPatch = ''
    node ${./invoke-command-shape.test.mjs}
    node ${./model-bootstrap-shape.test.mjs}
    node ${./mid-turn-compaction.test.mjs}
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node ${./invoke-command.test.mjs} "$PWD/packages/coding-agent"
    node ${./model-bootstrap.test.mjs} "$PWD/packages/coding-agent"
    node ${./model-bootstrap-cli.test.mjs} "$PWD/packages/coding-agent"
    node ${./manual-short-compaction.test.mjs} "$PWD/packages/coding-agent"
    runHook postCheck
  '';

  # nixpkgs' 1.5.0 recipe copies these runtime workspaces (durable and env added,
  # client and protocol removed upstream). pi-schema is added here on top of
  # nixpkgs: pi-ai's validation imports it at runtime, and the installed-output
  # tests below load the unbundled packages (the CLI bundle alone would hide it).
  # Validate installed output unconditionally after reproducing that install step.
  postInstall = ''
    local nm="$out/lib/node_modules/pi-monorepo/node_modules"

    for ws in @earendil-works/chord:packages/chord \
              @earendil-works/pi-ai:packages/ai \
              @earendil-works/pi-agent-core:packages/agent \
              @earendil-works/pi-codemode:packages/codemode \
              @earendil-works/pi-durable:packages/durable \
              @earendil-works/pi-env:packages/env \
              @earendil-works/pi-mcp:packages/mcp \
              @earendil-works/pi-schema:packages/schema \
              @earendil-works/pi-telemetry:packages/telemetry \
              @earendil-works/pi-tui:packages/tui; do
      IFS=: read -r pkg src <<< "$ws"
      rm "$nm/$pkg"
      cp -r "$src" "$nm/$pkg"
    done

    find "$nm" -type l -lname '*/packages/*' -delete
    find "$nm/.bin" -xtype l -delete

    ${pkgs.lib.optionalString pkgs.stdenvNoCC.hostPlatform.isDarwin ''
      # Keep nixpkgs' 1.0.0 Darwin cleanup: these are foreign Linux binaries
      # which otherwise make audit-tmpdir inspect ELF RPATHs with patchelf.
      rm -rf \
        "$nm/@anthropic-ai/sandbox-runtime/dist/vendor/seccomp" \
        "$nm/@anthropic-ai/sandbox-runtime/vendor/seccomp"
    ''}

    piRoot="$out/lib/node_modules/pi-monorepo"
    node ${./invoke-command.test.mjs} "$piRoot"
    node ${./model-bootstrap.test.mjs} "$piRoot"
    node ${./model-bootstrap-cli.test.mjs} "$piRoot"
    node ${./mid-turn-compaction.test.mjs} "$piRoot"
    node ${./manual-short-compaction.test.mjs} "$piRoot"
    node ${./cache-write-1h-delta.test.mjs} "$piRoot"
    grep -F 'invokeExtensionCommand(name: string, args?: string): Promise<void>;' \
      "$piRoot/dist/core/extensions/types.d.ts"
    grep -F 'registerModelBootstrap(handler: ModelBootstrapHandler): void;' \
      "$piRoot/dist/core/extensions/types.d.ts"
    grep -F 'bootstrapExtensionModels' \
      "$piRoot/dist/core/agent-session-services.d.ts"
    if grep -E 'invokeCommand\(|invokeExtensionCommandFromPrompt' "$piRoot/dist/core/extensions/types.d.ts"; then
      echo 'Unexpected broad API alias or public idle bypass' >&2
      exit 1
    fi
  '';
})
