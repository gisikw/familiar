{ pkgs }:
let
  base = pkgs.pi-coding-agent;
  lockedBaseVersion = "0.84.1";
  targetVersion = "1.0.0";
  targetCommit = "a13d35a742c6ef8462812a28fbe1d8c8b7431c32";
  targetSrc = pkgs.fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi";
    rev = targetCommit;
    hash = "sha256-CGznIVHXG6gr2F8vzHcR/v4P9xJgZHeMTt/CJ/kB78o=";
  };
  targetModelData = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${targetVersion}.tgz";
    hash = "sha256-85uZwpuFmPF1sQhA5dKoGYPnwM5crk19+DoQB0R9LCs=";
  };
in
assert pkgs.lib.assertMsg (base.version == lockedBaseVersion)
  "Familiar Pi adaptation: unverified locked nixpkgs base ${base.version}; expected ${lockedBaseVersion}. Review the 1.0.0 recipe adaptation before updating.";
assert pkgs.lib.assertMsg (base.src.outputHash == "sha256-lg+I4S/aAjazjhGZU567ow+rksoNiqOqjHl//TjAMes=")
  "Familiar Pi adaptation: locked nixpkgs base source changed; review the recipe and patch ordering.";
base.overrideAttrs (old:
assert pkgs.lib.assertMsg ((old.patches or []) == [] && (old.prePatch or "") == "")
  "Familiar Pi adaptation: upstream nixpkgs now patches Pi; review patch ordering and inputs.";
{
  version = targetVersion;
  src = targetSrc;
  npmDepsHash = "sha256-ndEvWdB6sa5nNNtabk2OMZKUFG9x3op185deZHxFnXk=";
  # overrideAttrs runs after buildNpmPackage formed its fetched dependency tree,
  # so replace that derived input as well as documenting its vendor hash.
  npmDeps = pkgs.fetchNpmDeps {
    name = "pi-coding-agent-${targetVersion}-npm-deps";
    src = targetSrc;
    hash = "sha256-ndEvWdB6sa5nNNtabk2OMZKUFG9x3op185deZHxFnXk=";
  };
  modelData = targetModelData;

  # Pi 1.0.0 added codemode, mcp and durable workspaces (plus a bundled
  # coding-agent CLI built by scripts/build-coding-agent-bundle.mjs) and its
  # TypeScript 7 devDependency is the native compiler. Upstream's root
  # `build:offline` script owns the workspace order (chord, tui, telemetry,
  # codemode, mcp, ai, durable, agent, protocol, client, server, coding-agent)
  # and checks the restored model data instead of fetching it. This mirrors
  # nixpkgs' exact 1.0.0 recipe while the locked nixpkgs still packages 0.84.1.
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
    echo 'Verifying Familiar Pi 1.0.0 patch inputs (fail closed)'
    sha256sum --check --strict ${./upstream.sha256}
  '';
  # Order is contractual: command fencing, then the provider-only
  # pre-resolution bootstrap (which relies on loader queuing).
  patches = [ ./invoke-command.patch ./model-bootstrap.patch ];

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
    runHook postCheck
  '';

  # Pi 1.0.0's package recipe adds codemode and mcp to the copied runtime workspaces.
  # Validate installed output unconditionally after reproducing that install step.
  postInstall = ''
    local nm="$out/lib/node_modules/pi-monorepo/node_modules"

    for ws in @earendil-works/chord:packages/chord \
              @earendil-works/pi-ai:packages/ai \
              @earendil-works/pi-agent-core:packages/agent \
              @earendil-works/pi-client:packages/client \
              @earendil-works/pi-codemode:packages/codemode \
              @earendil-works/pi-mcp:packages/mcp \
              @earendil-works/pi-protocol:packages/protocol \
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
