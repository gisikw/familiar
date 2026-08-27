export function stuffGuidance(enabled = process.env.FAMILIAR_USE_STUFF): string {
  return enabled === "true"
    ? "Durable context: the `stuff` CLI stores inert Items and linked Notes. Run `stuff --help` to discover its commands; Stuff records work but does not dispatch or orchestrate it."
    : "";
}
