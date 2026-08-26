# Parse and flatten familiar.toml using Nix's built-in TOML parser. The output
# is a length-framed stream consumed without eval by familiar-config.sh:
#   NAME "\n" BYTE_LENGTH "\n" VALUE
let
  rawConfig = builtins.fromTOML (builtins.readFile (builtins.getEnv "FAMILIAR_CONFIG_PATH"));
  pluginTables = rawConfig.plugins or {};
  pluginNames = builtins.attrNames pluginTables;
  golem = pluginTables.golem or {};
  golemKeys = builtins.attrNames golem;
  allowedGolemKeys = [ "env" "git" "path" "rev" ];
  unknownGolemKeys = builtins.filter (key: !(builtins.elem key allowedGolemKeys)) golemKeys;
  rawPluginEnv = golem.env or {};
  pluginEnv = if builtins.isAttrs rawPluginEnv then rawPluginEnv else { __invalid = 0; };
  badPluginEnv = builtins.filter (key:
    builtins.match "[A-Z_][A-Z0-9_]*" key == null || !(builtins.isString pluginEnv.${key})
  ) (builtins.attrNames pluginEnv);
  pathForm = golem ? path;
  gitForm = golem ? git || golem ? rev;
  pluginConfigValid =
    (pluginNames == [] || pluginNames == [ "golem" ])
    && unknownGolemKeys == []
    && builtins.isAttrs rawPluginEnv
    && badPluginEnv == []
    && (pluginNames == [] || pathForm != gitForm)
    && ((golem ? git) == (golem ? rev))
    && (!(golem ? rev) || (builtins.isString golem.rev && builtins.match "[0-9a-fA-F]{40}" golem.rev != null));
  config = if pluginConfigValid then rawConfig else throw "invalid [plugins.golem] source or environment configuration";
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
  scalar = path: value:
    let kind = builtins.typeOf value;
    in if kind == "string" then value
       else if kind == "bool" then (if value then "true" else "false")
       else if kind == "int" || kind == "float" then builtins.toJSON value
       else if kind == "list" then builtins.toJSON value
       else throw "unsupported value at ${builtins.concatStringsSep "." path}: ${kind}";
  flatten = path: value:
    if builtins.isAttrs value then
      builtins.concatLists (map (key: flatten (path ++ [ key ]) value.${key})
        (builtins.attrNames value))
    else if builtins.length path < 2 then
      throw "top-level key must live under a canonical table; see familiar.toml.example"
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
