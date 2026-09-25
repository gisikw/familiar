import { expect, test } from "bun:test";
import { deliveredIds } from "./index.ts";

// Regression: Pi persists sendMessage() as top-level `custom_message` entries.
// Missing them meant soft events were never acked and redelivered forever.
test("deliveredIds recognizes persisted custom_message and legacy message shapes", () => {
  const ids = deliveredIds([
    { type: "custom_message", customType: "scheduler-event", details: { id: "soft-1" } },
    { type: "custom_message", customType: "familiar.merge.v1", details: { id: "merge-1" } },
    { type: "message", message: { customType: "scheduler-event", details: { id: "legacy-1" } } },
    { type: "custom_message", customType: "other", details: { id: "nope" } },
  ]);
  expect([...ids].sort()).toEqual(["legacy-1", "merge-1", "soft-1"]);
});
