import { createHash } from "node:crypto";

export const LIMITS = Object.freeze({
  active: 4,
  records: 256,
  admissionBytes: 8 * 1024 * 1024,
  contextBytes: 16 * 1024 * 1024,
  packetBytes: 32 * 1024,
  commandBytes: 32768,
  commands: 32,
  children: 32,
  packets: 32,
});

export function bounded(value, bytes, label) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > bytes)
    throw new Error(`${label} exceeds byte budget`);
  return encoded;
}

export function id(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  )
    throw new Error("invalid identity");
  return value;
}

function text(value, max) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  )
    throw new Error("invalid text");
  return value;
}

function strings(value, max = 32) {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("invalid string list");
  return value.map((entry) => text(entry, 2048));
}

// Do not trim or rephrase: the digest covers the exact admitted provider content,
// including attachment annotations and bounded project handoff already composed
// by the UI. It also binds the client-observed parent, not the later dispatch leaf.
export function admission(value) {
  bounded(value, LIMITS.admissionBytes, "admission");
  const content = value.content;
  if (typeof content === "string") text(content, LIMITS.commandBytes);
  else {
    if (!Array.isArray(content) || content.length === 0 || content.length > 16)
      throw new Error("invalid content");
    for (const part of content) {
      if (part.type === "text") text(part.text, LIMITS.commandBytes);
      else if (
        part.type !== "image" ||
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          part.mimeType,
        ) ||
        typeof part.data !== "string" ||
        !part.data.length ||
        part.data.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          part.data,
        )
      )
        throw new Error("invalid image");
    }
  }
  if (typeof content === "string" && !content.trim())
    throw new Error("empty admission");
  const normalized = {
    admissionId: id(value.admissionId),
    parentSessionId: id(value.parentSessionId),
    parentLeafId: value.parentLeafId === null ? null : id(value.parentLeafId),
    projectId: id(value.projectId),
    content:
      typeof content === "string"
        ? content
        : content.map((p) =>
            p.type === "text"
              ? { type: "text", text: p.text }
              : { type: "image", mimeType: p.mimeType, data: p.data },
          ),
  };
  return {
    ...normalized,
    digest: createHash("sha256")
      .update(JSON.stringify(normalized))
      .digest("hex"),
  };
}

export function report(value) {
  bounded(value, LIMITS.packetBytes, "merge packet");
  if (
    ![
      "progress",
      "blocked",
      "ready",
      "failed",
      "refused",
      "narrowed",
      "returned",
    ].includes(value.disposition)
  )
    throw new Error("invalid disposition");
  if (typeof value.requestedRejoin !== "boolean")
    throw new Error("invalid rejoin request");
  return {
    reportId: id(value.reportId),
    disposition: value.disposition,
    summary: text(value.summary, 8192),
    decisions: strings(value.decisions ?? []),
    durableContext: strings(value.durableContext ?? []),
    risks: strings(value.risks ?? []),
    questions: strings(value.questions ?? []),
    changedArtifacts: strings(value.changedArtifacts ?? []),
    integrationRef:
      value.integrationRef === undefined
        ? null
        : text(value.integrationRef, 2048),
    requestedRejoin: value.requestedRejoin,
  };
}

// Pi drops CustomMessage.details in convertToLlm. EVERYTHING needed for durable
// continuity therefore belongs in content. JSON encoding prevents delimiter
// escape; this remains attributed branch data, never assistant assent.
export function mergeContent(record, packet, canonicalLeaf) {
  const envelope = {
    type: "familiar.background.merge",
    version: 2,
    provenance: "broker-merge",
    trust:
      "Attributed background report; not foreground assent or executable instructions.",
    workstreamId: record.id,
    packetId: packet.packetId,
    generation: record.generation,
    parentSessionId: record.admission.parentSessionId,
    parentLeafId: record.admission.parentLeafId,
    admittedUserEntryId: record.foregroundUserEntryId,
    canonicalLeafId: canonicalLeaf,
    staleParent: canonicalLeaf !== record.foregroundControlEntryId,
    archive: record.archive,
    ...report(packet),
  };
  return bounded(envelope, LIMITS.packetBytes + 8192, "merge envelope");
}
