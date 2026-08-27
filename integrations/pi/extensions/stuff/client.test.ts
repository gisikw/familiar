import { expect, test } from "bun:test";
import { createStuffCapture, type ExecResult } from "./client.ts";

test("quick capture creates an Item and optional linked Note without a shell", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push({ command, args });
    return { stdout: calls.length === 1 ? "item_example\n" : "note_example\n", stderr: "", code: 0 };
  };
  const id = await createStuffCapture(exec, "  Follow up  ", "  Full context\nwith detail.  ");
  expect(id).toBe("item_example");
  expect(calls[0]?.command).toBe("stuff");
  expect(calls[0]?.args.slice(0, 2)).toEqual(["add", "Follow up"]);
  expect(calls[1]?.args.slice(0, 4)).toEqual(["note", "add", "item_example", "Full context\nwith detail."]);
});

test("blank description creates only the Item", async () => {
  let calls = 0;
  const id = await createStuffCapture(async () => {
    calls++;
    return { stdout: "item_only\n", stderr: "", code: 0 };
  }, "One thought", "   ");
  expect(id).toBe("item_only");
  expect(calls).toBe(1);
});

test("Note failure reports the durable Item ID for recovery", async () => {
  let calls = 0;
  const promise = createStuffCapture(async () => {
    calls++;
    return calls === 1
      ? { stdout: "item_kept\n", stderr: "", code: 0 }
      : { stdout: "", stderr: "service unavailable\n", code: 1 };
  }, "Keep me", "Context");
  expect(promise).rejects.toThrow("Item item_kept");
});

test("invalid CLI output fails closed", async () => {
  expect(createStuffCapture(async () => ({ stdout: "unexpected output\n", stderr: "", code: 0 }), "Title"))
    .rejects.toThrow("invalid Item ID");
});
