export function stuffGuidance(enabled = process.env.FAMILIAR_USE_STUFF): string {
  return enabled === "true"
    ? "Durable context: the `stuff` CLI stores inert Items and linked Notes. Run `stuff --help` to discover its commands; Stuff records work but does not dispatch or orchestrate it."
    : "";
}

export function impGuidance(
  bin = process.env.FAMILIAR_IMP_BIN,
  socket = process.env.FAMILIAR_IMP_SOCKET,
): string {
  if (!bin || !socket) return "";
  return `Shell-native capabilities:
- \`imp plate\` reads and updates the shared Plate. Run \`imp plate --help\` for progressive command discovery.
- \`imp agent\` dispatches and controls durable Familiar Agents. Run \`imp agent --help\` for progressive command discovery.
- While both orchestration systems are available, prefer the advertised Golem tools for routine delegation. Use \`imp agent\` when Kevin explicitly asks for Familiar Agents or when validating that system.
- Never silently fall back between agent systems, blindly retry an uncertain mutation, or mint a new dispatch key after a lost reply; inspect status and reconcile first.`;
}
