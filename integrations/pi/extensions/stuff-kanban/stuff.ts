export const LANES = ["open", "in_progress", "ready_for_review", "done"] as const;
export type Lane = (typeof LANES)[number];

export interface StuffItem {
  id: string;
  name: string;
  revision: string;
  metadata: unknown;
  created_at?: string;
  updated_at?: string;
  view_id?: string;
}

export interface KanbanBoard {
  batch: StuffItem;
  items: StuffItem[];
}

export type ExecResult = { stdout: string; stderr: string; code: number | null };
export type StuffExec = (command: string, args: string[]) => Promise<ExecResult>;

export async function loadBoard(batchId: string, options: { exec: StuffExec }): Promise<KanbanBoard> {
  assertItemId(batchId, "batch ID");
  const batch = await getItem(options.exec, batchId);
  const ids = isPlainObject(batch.metadata) ? batch.metadata.item_ids : undefined;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && isItemId(id))) {
    throw new Error(`Stuff batch ${batchId} has no valid metadata.item_ids array`);
  }
  const uniqueIds = [...new Set(ids)];
  const items = await Promise.all(uniqueIds.map((id) => getItem(options.exec, id)));
  return { batch, items };
}

export async function getItem(exec: StuffExec, id: string): Promise<StuffItem> {
  assertItemId(id, "Item ID");
  const result = await exec("stuff", ["get", id]);
  if (result.code !== 0) throw cliError(`stuff get ${id} failed`, result.stderr);
  return parseItem(result.stdout, id);
}

export async function moveItem(exec: StuffExec, item: StuffItem, lane: Lane): Promise<StuffItem> {
  if (!LANES.includes(lane)) throw new Error(`Unsupported Stuff lane: ${lane}`);
  if (!isPlainObject(item.metadata)) throw new Error(`Cannot safely move ${item.id}: metadata is not an object`);
  if (!item.revision) throw new Error(`Cannot safely move ${item.id}: revision is missing`);

  const metadata = { ...item.metadata, status: lane };
  const result = await exec("stuff", [
    "update", item.id,
    "--meta", JSON.stringify(metadata),
    "--revision", item.revision,
  ]);
  if (result.code !== 0) throw cliError(`stuff update ${item.id} failed`, result.stderr);
  return parseItem(result.stdout, item.id);
}

export function laneOf(item: StuffItem): Lane {
  const status = isPlainObject(item.metadata) ? item.metadata.status : undefined;
  return typeof status === "string" && (LANES as readonly string[]).includes(status)
    ? status as Lane
    : "open";
}

function parseItem(json: string, expectedId: string): StuffItem {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`stuff returned invalid JSON for ${expectedId}`);
  }
  if (!isPlainObject(value) || value.id !== expectedId || typeof value.name !== "string" ||
      typeof value.revision !== "string" || !("metadata" in value)) {
    throw new Error(`stuff returned an invalid Item envelope for ${expectedId}`);
  }
  return value as unknown as StuffItem;
}

function isItemId(id: string): boolean {
  return /^item_[a-z0-9]+$/.test(id);
}

function assertItemId(id: string, label: string): void {
  if (!isItemId(id)) throw new Error(`Invalid Stuff ${label}: ${id}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cliError(prefix: string, stderr: string): Error {
  const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 300);
  return new Error(detail ? `${prefix}: ${detail}` : prefix);
}
