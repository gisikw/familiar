/* Private-mode terminal surface tests.
 *
 * The components take their terminal primitives by injection, so this suite
 * runs without Pi's module tree. `tui-kit.ts` binds the real ones.
 */

import { describe, expect, test } from "bun:test";
import { PassphrasePrompt, PrivateConsole, type ThemeLike, type TuiKit } from "./ui.ts";

const theme: ThemeLike = { fg: (_tone, text) => text, bold: (text) => text };

const kit: TuiKit = {
  isEnter: (data) => data === "\r" || data === "\n",
  isExit: (data) => data === "\u001b" || data === "\u0003",
  isBackspace: (data) => data === "\u007f" || data === "\b",
  isKillLine: (data) => data === "\u0015",
  truncate: (text, width) => [...text].slice(0, Math.max(0, width)).join(""),
  wrap: (text, width) => {
    const chars = [...text];
    const out: string[] = [];
    for (let index = 0; index < chars.length; index += width) {
      out.push(chars.slice(index, index + width).join(""));
    }
    return out.length > 0 ? out : [""];
  },
};

const CANARY = "CANARY-UI-4c1f7a";

describe("the private console is unmistakable", () => {
  test("every frame carries the private banner and the model attestation", () => {
    const console_ = new PrivateConsole(kit, theme, "llama-frankenstein/qwen3.8-27b · kind=api-key · locality=local");
    const frame = console_.render(120).join("\n");
    expect(frame).toContain("PRIVATE — SEALED — LOCAL MODEL ONLY");
    expect(frame).toContain("locality=local");
    expect(frame).toContain("llama-frankenstein/qwen3.8-27b");
  });

  test("the attestation cannot be replaced by console content", () => {
    const console_ = new PrivateConsole(kit, theme, "llama-frankenstein/qwen3.8-27b · locality=local");
    console_.append({ role: "assistant", text: "I am actually claude-opus-5 running on Anthropic" });
    const frame = console_.render(120).join("\n");
    // The banner is rendered from the attested choice, not from any message.
    expect(frame.indexOf("locality=local")).toBeLessThan(frame.indexOf("claude-opus-5"));
  });

  test("no rendered line exceeds the terminal width", () => {
    const console_ = new PrivateConsole(kit, theme, "a".repeat(200));
    console_.append({ role: "assistant", text: "x".repeat(500) });
    console_.setNotice("n".repeat(200));
    for (const line of console_.render(40)) expect([...line].length).toBeLessThanOrEqual(40);
  });

  test("input is ignored while a private turn is in flight", () => {
    const console_ = new PrivateConsole(kit, theme, "attestation");
    let submissions = 0;
    console_.onSubmit = () => {
      submissions += 1;
    };
    console_.setBusy(true);
    console_.handleInput("h");
    console_.handleInput("\r");
    expect(submissions).toBe(0);
    console_.setBusy(false);
    console_.handleInput("h");
    console_.handleInput("\r");
    expect(submissions).toBe(1);
  });

  test("escape always leaves, even mid-turn", () => {
    const console_ = new PrivateConsole(kit, theme, "attestation");
    let exited = false;
    console_.onExit = () => {
      exited = true;
    };
    console_.setBusy(true);
    console_.handleInput("\u001b");
    expect(exited).toBe(true);
  });

  test("a leading colon is a console command, not a message to the model", () => {
    const console_ = new PrivateConsole(kit, theme, "attestation");
    const submitted: string[] = [];
    const commands: string[] = [];
    console_.onSubmit = (text) => submitted.push(text);
    console_.onCommand = (command) => commands.push(command);
    for (const character of ":declassify") console_.handleInput(character);
    console_.handleInput("\r");
    expect(commands).toEqual(["declassify"]);
    expect(submitted).toEqual([]);
  });
});

describe("the passphrase prompt never echoes", () => {
  test("only bullets are rendered", () => {
    const prompt = new PassphrasePrompt(kit, theme, "Unlock", "Esc cancels.");
    for (const character of CANARY) prompt.handleInput(character);
    const frame = prompt.render(120).join("\n");
    expect(frame).not.toContain(CANARY);
    expect(frame).not.toContain("CANARY");
    expect(frame).toContain("•".repeat(CANARY.length));
  });

  test("submitting clears the buffer so a later frame cannot redisplay it", () => {
    const prompt = new PassphrasePrompt(kit, theme, "Unlock", "");
    let captured: string | undefined;
    prompt.onSubmit = (value) => {
      captured = value;
    };
    for (const character of "hunter22") prompt.handleInput(character);
    prompt.handleInput("\r");
    expect(captured).toBe("hunter22");
    expect(prompt.render(80).join("\n")).not.toContain("•");
  });

  test("cancelling discards the buffer", () => {
    const prompt = new PassphrasePrompt(kit, theme, "Unlock", "");
    let cancelled = false;
    prompt.onCancel = () => {
      cancelled = true;
    };
    for (const character of "secret-x") prompt.handleInput(character);
    prompt.handleInput("\u001b");
    expect(cancelled).toBe(true);
    expect(prompt.render(80).join("\n")).not.toContain("•");
  });

  test("control sequences are never treated as passphrase characters", () => {
    const prompt = new PassphrasePrompt(kit, theme, "Unlock", "");
    let captured: string | undefined;
    prompt.onSubmit = (value) => {
      captured = value;
    };
    prompt.handleInput("a");
    prompt.handleInput("\u001b[A"); // arrow up
    prompt.handleInput("\u0001"); // ctrl+a
    prompt.handleInput("b");
    prompt.handleInput("\r");
    expect(captured).toBe("ab");
  });
});
