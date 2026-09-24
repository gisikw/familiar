import { serviceCall } from "../lib/familiar-services.ts";
import type { DndActor, DndState, ItemType, Priority, QueueItem } from "./policy.ts";

export interface EnqueueEnvelope {
  priority?: Priority;
  type?: ItemType;
  summary: string;
  body?: string;
  source?: string;
  suggested_deadline?: number;
  id?: string;
}

export interface EnqueueResult { item: QueueItem; created: boolean }

/** Thin client for the worklist and DND state owned by familiar-services. */
export class WorklistClient {
  constructor(private readonly socketPath?: string) {}
  list(): Promise<QueueItem[]> { return serviceCall("worklist.list", {}, this.socketPath); }
  enqueue(envelope: EnqueueEnvelope): Promise<EnqueueResult> { return serviceCall("worklist.enqueue", envelope as unknown as Record<string, unknown>, this.socketPath); }
  ack(id: string): Promise<QueueItem> { return serviceCall("worklist.ack", { id }, this.socketPath); }
  withdraw(id: string): Promise<QueueItem> { return serviceCall("worklist.withdraw", { id }, this.socketPath); }
  getDnd(): Promise<DndState | null> { return serviceCall("dnd.get", {}, this.socketPath); }
  setDnd(enabled: boolean, setBy: DndActor, durationMs?: number): Promise<DndState | null> {
    return serviceCall("dnd.set", { enabled, set_by: setBy, ...(durationMs === undefined ? {} : { duration_ms: durationMs }) }, this.socketPath);
  }
}
