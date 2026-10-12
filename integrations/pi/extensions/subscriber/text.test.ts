import { describe, expect, test } from "bun:test";
import { speakable, stripChips } from "./text.ts";

describe("inline default chips are not spoken", () => {
  test("drops a trailing default", () => {
    expect(speakable("Want it carded? [yes]")).toBe("Want it carded?");
    expect(speakable("I'd drop it. [drop it]\nNext line.")).toBe("I'd drop it.\nNext line.");
    expect(speakable("[yes]")).toBe("");
  });
  test("leaves links, citations, checkboxes and mid-line brackets alone", () => {
    expect(speakable("see [the doc](https://x.y)")).toBe("see the doc");
    expect(stripChips("as shown [1]")).toBe("as shown [1]");
    expect(stripChips("- [x]")).toBe("- [x]");
    expect(stripChips("pick [yes] or no")).toBe("pick [yes] or no");
    expect(stripChips("too long [one two three four five]")).toBe("too long [one two three four five]");
  });
});
