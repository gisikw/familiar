import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const types = read("packages/coding-agent/src/core/extensions/types.ts");
const loader = read("packages/coding-agent/src/core/extensions/loader.ts");
const services = read("packages/coding-agent/src/core/agent-session-services.ts");
const main = read("packages/coding-agent/src/main.ts");

for (const needle of [
  "registerModelBootstrap(handler: ModelBootstrapHandler): void;",
  'source: "cli" | "session" | "default" | "list";',
  "modelBootstraps: ModelBootstrapHandler[];",
]) if (!types.includes(needle)) throw new Error(`missing bootstrap type: ${needle}`);
if (!loader.includes("extension.modelBootstraps.push(handler)")) throw new Error("factory registration is not extension-owned");
if (!services.includes("await handler(Object.freeze({ ...request }))")) throw new Error("bootstrap handlers are not awaited");
const bootstrap = services.indexOf("export async function bootstrapExtensionModels");
const flush = services.indexOf("flushExtensionProviders(services);", bootstrap);
if (bootstrap < 0 || flush < bootstrap) throw new Error("bootstrap registrations are not flushed");
const invoke = main.indexOf("await bootstrapExtensionModels(services, bootstrapRequest)");
const scope = main.indexOf("const modelPatterns =", invoke);
if (invoke < 0 || scope < invoke) throw new Error("bootstrap must precede CLI/scope model resolution");
if (main.includes("process.argv")) throw new Error("bootstrap must use parsed exact identities, not process.argv");
console.log("model bootstrap source shape: ok");
