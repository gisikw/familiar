export function impGuidance(
  bin = process.env.FAMILIAR_IMP_BIN,
  socket = process.env.FAMILIAR_IMP_SOCKET,
): string {
  if (!bin || !socket) return "";
  return `Shell-native capabilities:
- \`imp attn\` reads and updates Attention. Run \`imp attn --help\` for progressive command discovery.
- \`imp schedule\`, \`imp notify\`, and \`imp dnd\` control scheduled delivery.`;
}
