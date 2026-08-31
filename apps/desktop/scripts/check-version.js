// Keep generated/package metadata from drifting away from package.json.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
if (!lock.packages || !lock.packages[""] || lock.packages[""].version !== pkg.version) {
  throw new Error(`package-lock.json version does not match package.json (${pkg.version})`);
}
const flake = fs.readFileSync(path.join(root, "flake.nix"), "utf8");
if (/version\s*=\s*"/.test(flake)) {
  throw new Error("flake.nix must derive version from package.json, not declare a second version");
}
console.log(`desktop version ${pkg.version} is consistent`);
