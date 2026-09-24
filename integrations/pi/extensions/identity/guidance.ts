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
- \`imp attn\` reads and updates Attention. Run \`imp attn --help\` for progressive command discovery.`;
}
