# Parse and flatten familiar.toml using Nix's built-in TOML parser. The output
# is a length-framed stream consumed without eval by familiar-config.sh:
#   NAME "\n" BYTE_LENGTH "\n" VALUE
let
  config = builtins.fromTOML (builtins.readFile (builtins.getEnv "FAMILIAR_CONFIG_PATH"));
  chars = s: builtins.genList (i: builtins.substring i 1 s) (builtins.stringLength s);
  upper = s: builtins.replaceStrings
    (chars "abcdefghijklmnopqrstuvwxyz") (chars "ABCDEFGHIJKLMNOPQRSTUVWXYZ") s;
  normalize = s:
    builtins.concatStringsSep "" (map (c:
      if builtins.match "[A-Z0-9_]" c != null then c else "_"
    ) (chars (upper s)));
  hasPrefix = prefix: value:
    builtins.substring 0 (builtins.stringLength prefix) value == prefix;
  envName = path:
    let flat = normalize (builtins.concatStringsSep "_" path);
    in if hasPrefix "FAMILIAR_" flat then flat else "FAMILIAR_${flat}";
  credentialNames = [
    "FAMILIAR_ANTHROPIC_CLAUDE_CREDENTIALS_JSON"
    "FAMILIAR_ANTHROPIC_CLAUDE_OAUTH_TOKEN"
  ];
  isCredentialPath = path: builtins.elem (envName path) credentialNames;
  scalar = path: value:
    let
      kind = builtins.typeOf value;
      joined = builtins.concatStringsSep "." path;
    in if isCredentialPath path && kind != "string" then
         throw "credential setting must be a TOML string"
       else if kind == "string" then value
       else if kind == "bool" then (if value then "true" else "false")
       else if kind == "int" || kind == "float" then builtins.toJSON value
       else if kind == "list" then builtins.toJSON value
       else throw "unsupported value at ${builtins.concatStringsSep "." path}: ${kind}";
  flatten = path: value:
    if builtins.isAttrs value && isCredentialPath path then
      throw "credential setting must be a TOML string"
    else if builtins.isAttrs value then
      builtins.concatLists (map (key: flatten (path ++ [ key ]) value.${key})
        (builtins.attrNames value))
    else [ { name = envName path; value = scalar path value; } ];
  entries = flatten [ ] config;
  names = map (entry: entry.name) entries;
  uniqueNames = builtins.attrNames (builtins.listToAttrs
    (map (name: { inherit name; value = true; }) names));
  checked = if builtins.length names == builtins.length uniqueNames then entries
    else throw "configuration keys collide after environment-name normalization";
  frame = entry:
    "${entry.name}\n${toString (builtins.stringLength entry.value)}\n${entry.value}";
in builtins.concatStringsSep "" (map frame checked)
