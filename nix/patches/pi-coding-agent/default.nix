{ pkgs }:
let
  base = pkgs.pi-coding-agent;
  expectedVersion = "0.84.1";
in
assert pkgs.lib.assertMsg (base.version == expectedVersion)
  "Familiar invokeCommand patch: unverified Pi version ${base.version}; expected ${expectedVersion}. Review nix/patches/pi-coding-agent before updating.";
assert pkgs.lib.assertMsg (base.src.outputHash == "sha256-lg+I4S/aAjazjhGZU567ow+rksoNiqOqjHl//TjAMes=")
  "Familiar invokeCommand patch: unverified upstream source hash; review required.";
base.overrideAttrs (old:
assert pkgs.lib.assertMsg ((old.patches or []) == [] && (old.prePatch or "") == "")
  "Familiar invokeCommand patch: upstream now patches Pi; review patch ordering and inputs.";
{
  # Verify pristine inputs BEFORE any upstream or downstream patch/prePatch hook.
  # Full-file hashes intentionally reject unrelated changes too: review is required.
  prePatch = ''
    echo 'Verifying Familiar Pi 0.84.1 patch inputs (fail closed)'
    sha256sum --check --strict ${./upstream.sha256}
  '' + (old.prePatch or "");
  patches = (old.patches or []) ++ [ ./invoke-command.patch ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node ${./invoke-command.test.mjs} "$PWD/packages/coding-agent"
    runHook postCheck
  '';
  # Also validate the installed JS/declarations unconditionally in postInstall.
  # doCheck=false / doInstallCheck=false must not silently bypass this contract.
  postInstall = (old.postInstall or "") + ''
    piRoot="$out/lib/node_modules/pi-monorepo"
    node ${./invoke-command.test.mjs} "$piRoot"
    grep -F 'invokeCommand(name: string, args?: string): Promise<void>;' \
      "$piRoot/dist/core/extensions/types.d.ts"
  '';
})
