import { describe, expect, test } from "bun:test";
import { Firehose } from "./firehose.ts";

type Event = { event: string; [key: string]: unknown };

function fixture() {
  const published: Event[] = [];
  const revised: Event[] = [];
  let locks = 0;
  const hub = {
    inflight: undefined,
    publish(event: Event) { published.push(event); },
    revise(event: Event) { revised.push(event); this.inflight = event; },
    lockInflight() { locks++; this.inflight = undefined; },
    anyAudioListener() { return true; },
  };
  const segments: string[] = [];
  const audio = { register(_messageId: number, _index: number, text: string) { segments.push(text); } };
  const echoes = { claim() { return undefined; } };
  return {
    firehose: new Firehose(hub as never, audio as never, echoes as never),
    published,
    revised,
    segments,
    locks: () => locks,
  };
}

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("private continuity egress", () => {
  test("handoff-orientation output never reaches transcript or audio playout", () => {
    const f = fixture();
    f.firehose.onMessageStart({ customType: "handoff-orientation", content: "private prompt" });
    f.firehose.onMessageStart(assistant(""));
    const message = assistant("private orientation output");
    f.firehose.onMessageUpdate(message, { type: "text_end", partial: message });
    f.firehose.onMessageEnd(message);

    expect(f.published).toEqual([]);
    expect(f.revised).toEqual([]);
    expect(f.segments).toEqual([]);
    expect(f.locks()).toBe(1);
  });

  test("a following ordinary user turn reopens transcript and segmentation", () => {
    const f = fixture();
    f.firehose.onMessageStart({ customType: "handoff-orientation", content: "private prompt" });
    f.firehose.onMessageStart(assistant(""));
    f.firehose.onMessageEnd(assistant("private orientation output"));

    f.firehose.onMessageStart({ role: "user", content: [{ type: "text", text: "hello" }] });
    f.firehose.onMessageStart(assistant(""));
    const response = assistant("This ordinary answer is long enough to become a spoken segment.");
    f.firehose.onMessageUpdate(response, { type: "text_end", partial: response });
    f.firehose.onMessageEnd(response);

    expect(f.published.some(event => event.event === "message" && event.role === "user")).toBe(true);
    expect(f.published.some(event => event.event === "message" && event.role === "assistant")).toBe(true);
    expect(f.published.some(event => event.event === "segment")).toBe(true);
    expect(f.segments).toEqual(["This ordinary answer is long enough to become a spoken segment."]);
  });
});

describe("authoritative assistant parts", () => {
  test("revisions and locked messages preserve ordered text/tool/text parts", () => {
    const f = fixture();
    f.firehose.onMessageStart(assistant(""));
    const partial = {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
        { type: "text", text: "done" },
      ],
    };
    f.firehose.onMessageUpdate(partial, { type: "text_end", partial });
    f.firehose.onMessageEnd(partial);

    const expected = [
      { type: "text", text: "checking" },
      { type: "tool", id: "call-1", name: "bash", args: '{"command":"pwd"}' },
      { type: "text", text: "done" },
    ];
    expect(f.revised[0]).toMatchObject({ content: "checkingdone", parts: expected });
    expect(f.published.find(event => event.event === "message")).toMatchObject({
      content: "checkingdone", parts: expected,
    });
  });

  test("tool liveness identifies its owning assistant message", () => {
    const f = fixture();
    f.firehose.onMessageStart(assistant(""));
    f.firehose.onToolStart("call-2", "read", { path: "/tmp/x" });
    expect(f.published).toEqual([{
      event: "tool", id: "call-2", name: "read", args: '{"path":"/tmp/x"}', message_id: 1,
    }]);
  });
});
