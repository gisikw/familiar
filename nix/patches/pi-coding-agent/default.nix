{ pkgs }:
let
  base = pkgs.pi-coding-agent;
  lockedBaseVersion = "0.84.1";
  targetVersion = "0.85.1";
  targetCommit = "d981de1229ef899957bbe968bc8dcda02a21f477";
  targetSrc = pkgs.fetchFromGitHub {
    owner = "earendil-works";
    repo = "pi";
    rev = targetCommit;
    hash = "sha256-gU8BSiqqOYt2RRuQONHHGvZeSM5KFQVrwif9bmuUXUc=";
  };
  targetModelData = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-${targetVersion}.tgz";
    hash = "sha256-r30RmGF5RFzm/oizfVfeIvgjwP/TplyuMcVVt/XpklM=";
  };
in
assert pkgs.lib.assertMsg (base.version == lockedBaseVersion)
  "Familiar Pi adaptation: unverified locked nixpkgs base ${base.version}; expected ${lockedBaseVersion}. Review the 0.85.1 recipe adaptation before updating.";
assert pkgs.lib.assertMsg (base.src.outputHash == "sha256-lg+I4S/aAjazjhGZU567ow+rksoNiqOqjHl//TjAMes=")
  "Familiar Pi adaptation: locked nixpkgs base source changed; review the recipe and patch ordering.";
base.overrideAttrs (old:
assert pkgs.lib.assertMsg ((old.patches or []) == [] && (old.prePatch or "") == "")
  "Familiar Pi adaptation: upstream nixpkgs now patches Pi; review patch ordering and inputs.";
{
  version = targetVersion;
  src = targetSrc;
  npmDepsHash = "sha256-jzlsZIQzfl1FCZZ5//dHFWwMfBZQ4nRD6KB4HHifPqE=";
  # overrideAttrs runs after buildNpmPackage formed its fetched dependency tree,
  # so replace that derived input as well as documenting its vendor hash.
  npmDeps = pkgs.fetchNpmDeps {
    name = "pi-coding-agent-${targetVersion}-npm-deps";
    src = targetSrc;
    hash = "sha256-jzlsZIQzfl1FCZZ5//dHFWwMfBZQ4nRD6KB4HHifPqE=";
  };
  modelData = targetModelData;

  # Pi 0.85.1 added chord/server workspace dependencies and requires pruning
  # only after all workspace builds. Keep this synchronized with nixpkgs' exact
  # 0.85.1 recipe while the repository's locked nixpkgs still packages 0.84.1.
  buildPhase = ''
    runHook preBuild

    npx tsgo -p packages/chord/tsconfig.build.json
    npx tsgo -p packages/tui/tsconfig.build.json
    npx tsgo -p packages/telemetry/tsconfig.build.json
    npx tsgo -p packages/ai/tsconfig.build.json
    npx tsgo -p packages/agent/tsconfig.build.json
    npx tsgo -p packages/protocol/tsconfig.build.json
    npx tsgo -p packages/client/tsconfig.build.json
    npx tsgo -p packages/server/tsconfig.build.json
    npm run build --workspace=packages/coding-agent

    runHook postBuild
  '';
  dontNpmPrune = true;
  preInstall = ''
    npm prune --omit=dev --no-save
  '';

  # Verify pristine inputs BEFORE downstream patches. Whole-file hashes
  # intentionally fail closed on unrelated source movement.
  prePatch = ''
    echo 'Verifying Familiar Pi 0.85.1 patch inputs (fail closed)'
    sha256sum --check --strict ${./upstream.sha256}
  '';
  # Order is contractual: direct command fencing first, owner runtime control second.
  patches = [ ./invoke-command.patch ./runtime-control.patch ];

  postPatch = ''
    node ${./invoke-command-shape.test.mjs}
    node ${./mid-turn-compaction.test.mjs}
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node ${./invoke-command.test.mjs} "$PWD/packages/coding-agent"
    runHook postCheck
  '';

  # Pi 0.85.1's package recipe adds chord to the copied runtime workspaces.
  # Validate installed output unconditionally after reproducing that install step.
  postInstall = ''
    local nm="$out/lib/node_modules/pi-monorepo/node_modules"

    for ws in @earendil-works/chord:packages/chord \
              @earendil-works/pi-ai:packages/ai \
              @earendil-works/pi-agent-core:packages/agent \
              @earendil-works/pi-client:packages/client \
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
      # Keep nixpkgs' 0.85.1 Darwin cleanup: these are foreign Linux binaries
      # which otherwise make audit-tmpdir inspect ELF RPATHs with patchelf.
      rm -rf \
        "$nm/@anthropic-ai/sandbox-runtime/dist/vendor/seccomp" \
        "$nm/@anthropic-ai/sandbox-runtime/vendor/seccomp"
    ''}

    piRoot="$out/lib/node_modules/pi-monorepo"
    node ${./invoke-command.test.mjs} "$piRoot"
    node ${./runtime-control.test.mjs} "$piRoot"
    node ${./mid-turn-compaction.test.mjs} "$piRoot"
    grep -F 'invokeExtensionCommand(name: string, args?: string): Promise<void>;' \
      "$piRoot/dist/core/extensions/types.d.ts"
    grep -F 'commitRuntimeControl(sessionId: string, leafId: string | null' \
      "$piRoot/dist/core/extensions/types.d.ts"
    if grep -E 'invokeCommand\(|invokeExtensionCommandFromPrompt' "$piRoot/dist/core/extensions/types.d.ts"; then
      echo 'Unexpected broad API alias or public idle bypass' >&2
      exit 1
    fi
  '';
})
