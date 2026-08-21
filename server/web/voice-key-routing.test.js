import { describe, expect, test } from "bun:test";
import {
  installVoiceKeyRouter,
  isEditableElement,
  isVoiceToggle,
} from "./voice-key-routing.js";

class OrderedTarget {
  listeners = [];
  addEventListener(type, fn, capture) { this.listeners.push({ type, fn, capture }); }
  removeEventListener(type, fn) {
    this.listeners = this.listeners.filter((x) => x.type !== type || x.fn !== fn);
  }
  keydown(init) {
    const event = {
      key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      repeat: false, defaultPrevented: false, immediate: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.immediate = true; },
      ...init,
    };
    for (const entry of this.listeners) {
      if (entry.type !== "keydown") continue;
      entry.fn(event);
      if (event.immediate) break;
    }
    return event;
  }
}

function setup(activeElement = null, isTerminalInput = () => false) {
  const target = new OrderedTarget();
  const calls = [];
  let active = false;
  const voice = {
    toggle() { calls.push("toggle"); active = !active; },
    cancel() { calls.push("cancel"); active = false; },
    isActive() { return active; },
  };
  installVoiceKeyRouter(target, {
    getVoice: () => voice,
    getActiveElement: () => activeElement,
    isTerminalInput,
  });
  // This models restty's downstream key listener/PTY send and is intentionally
  // registered after Familiar's capture reservation.
  target.addEventListener("keydown", (event) => calls.push(`pty:${event.key}`), true);
  return { target, calls };
}

describe("voice key routing", () => {
  test("plain F8 is the exact cross-platform binding", () => {
    expect(isVoiceToggle({ key: "F8", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(true);
    expect(isVoiceToggle({ key: "F8", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
    expect(isVoiceToggle({ key: " ", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
  });

  test("F8 is intercepted before restty/PTY delivery", () => {
    const { target, calls } = setup();
    const event = target.keydown({ key: "F8" });
    expect(calls).toEqual(["toggle"]);
    expect(event.defaultPrevented).toBe(true);
    expect(event.immediate).toBe(true);
  });

  test("second F8 stops while key repeat is swallowed without toggling", () => {
    const { target, calls } = setup();
    target.keydown({ key: "F8" });
    target.keydown({ key: "F8", repeat: true });
    target.keydown({ key: "F8" });
    expect(calls).toEqual(["toggle", "toggle"]);
  });

  test("Escape cancels active voice before PTY, but passes while idle", () => {
    const { target, calls } = setup();
    target.keydown({ key: "Escape" });
    expect(calls).toEqual(["pty:Escape"]);
    target.keydown({ key: "F8" });
    target.keydown({ key: "Escape" });
    expect(calls).toEqual(["pty:Escape", "toggle", "cancel"]);
  });

  test("unrelated keys still reach the PTY unchanged", () => {
    const { target, calls } = setup();
    const event = target.keydown({ key: "x", ctrlKey: true });
    expect(calls).toEqual(["pty:x"]);
    expect(event.defaultPrevented).toBe(false);
  });

  test("restty's focused hidden textarea is terminal focus, not focus-guarded", () => {
    const ime = { tagName: "TEXTAREA" };
    const { target, calls } = setup(ime, (element) => element === ime);
    target.keydown({ key: "F8" });
    expect(calls).toEqual(["toggle"]);
  });

  test("real inputs and contenteditable retain F8", () => {
    for (const element of [
      { tagName: "input" }, { tagName: "TEXTAREA" }, { tagName: "select" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      expect(isEditableElement(element)).toBe(true);
      const { target, calls } = setup(element);
      target.keydown({ key: "F8" });
      expect(calls).toEqual(["pty:F8"]);
    }
  });
});
