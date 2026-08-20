// Tests for the unified Familiar theme resolver + generated consumer artifacts.
// Run with: node --experimental-transform-types --test src/theme/resolve.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTheme,
  toCss,
  toResttyTheme,
  ansiList,
  ThemeError,
  type Theme,
} from "./resolve.ts";

// A clean env with no FAMILIAR_THEME_* keys, so tests are hermetic regardless
// of the ambient shell.
function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("FAMILIAR_THEME_")) env[k] = v;
  }
  return { ...env, ...overrides };
}

test("default theme preserves the current dark visual + Kevin's accent", () => {
  const t = resolveTheme(cleanEnv());
  assert.equal(t.name, "familiar-dark");
  assert.equal(t.roles.background, "#1e1e2e");
  assert.equal(t.roles.text, "#cdd6f4");
  assert.equal(t.roles.accent, "#32b08d"); // oklch(0.68 0.12 170)
  assert.equal(t.roles.cursor, "#32b08d");
});

test("ansiList returns 16 entries in SGR order", () => {
  const t = resolveTheme(cleanEnv());
  const list = ansiList(t);
  assert.equal(list.length, 16);
  assert.equal(list[0], "#45475a"); // black
  assert.equal(list[1], "#f38ba8"); // red
  assert.equal(list[15], "#a6adc8"); // brightWhite
  for (const c of list) assert.match(c, /^#[0-9a-f]{6}$/);
});

test("FAMILIAR_THEME_* env overrides roles and ansi (camel->SNAKE)", () => {
  const t = resolveTheme(
    cleanEnv({
      FAMILIAR_THEME_ACCENT: "#ff0000",
      FAMILIAR_THEME_SELECTION_BG: "#123456",
      FAMILIAR_THEME_ANSI_BRIGHT_BLACK: "#010203",
      FAMILIAR_THEME_NAME: "custom",
    }),
  );
  assert.equal(t.name, "custom");
  assert.equal(t.roles.accent, "#ff0000");
  assert.equal(t.roles.selectionBg, "#123456");
  assert.equal(t.ansi.brightBlack, "#010203");
});

test("shorthand #rgb expands to #rrggbb", () => {
  const t = resolveTheme(cleanEnv({ FAMILIAR_THEME_ACCENT: "#abc" }));
  assert.equal(t.roles.accent, "#aabbcc");
});

test("invalid color fails clearly with ThemeError", () => {
  assert.throws(
    () => resolveTheme(cleanEnv({ FAMILIAR_THEME_ACCENT: "notacolor" })),
    (err: unknown) => err instanceof ThemeError && /accent/.test((err as Error).message),
  );
});

test("generated CSS snapshot (default theme)", () => {
  const css = toCss(resolveTheme(cleanEnv()));
  // Stable, load-bearing lines. Full-string compare would be brittle; assert
  // the contract instead: back-compat aliases + fm-* roles + ansi indices.
  assert.match(css, /--term-bg: #1e1e2e;/);
  assert.match(css, /--frame-fg: #cdd6f4;/);
  assert.match(css, /--accent: #32b08d;/);
  assert.match(css, /--fm-background: #1e1e2e;/);
  assert.match(css, /--fm-accent: #32b08d;/);
  assert.match(css, /--fm-selection-bg: #45475a;/);
  assert.match(css, /--fm-ansi-0: #45475a;/);
  assert.match(css, /--fm-ansi-15: #a6adc8;/);
  // exactly 16 ansi vars
  assert.equal((css.match(/--fm-ansi-\d+:/g) || []).length, 16);
});

test("restty GhosttyTheme has rgb semantic colors + 256 palette with 0..15 filled", () => {
  const rt = toResttyTheme(resolveTheme(cleanEnv())) as {
    name: string;
    colors: {
      background: { r: number; g: number; b: number };
      cursor: { r: number; g: number; b: number };
      selectionBackground: { r: number; g: number; b: number };
      palette: ({ r: number; g: number; b: number } | undefined)[];
    };
  };
  assert.equal(rt.name, "familiar-dark");
  // #1e1e2e -> 30,30,46
  assert.deepEqual(rt.colors.background, { r: 30, g: 30, b: 46 });
  // #32b08d -> 50,176,141
  assert.deepEqual(rt.colors.cursor, { r: 50, g: 176, b: 141 });
  assert.equal(rt.colors.palette.length, 256);
  assert.deepEqual(rt.colors.palette[0], { r: 69, g: 71, b: 90 }); // #45475a
  assert.equal(rt.colors.palette[16], undefined); // only 0..15 filled
});

test("default parity: every role and ansi entry is a valid 6-digit hex", () => {
  const t = resolveTheme(cleanEnv());
  const all: Theme = t;
  for (const [k, v] of Object.entries(all.roles)) {
    assert.match(v, /^#[0-9a-f]{6}$/, `role ${k}`);
  }
  for (const [k, v] of Object.entries(all.ansi)) {
    assert.match(v, /^#[0-9a-f]{6}$/, `ansi ${k}`);
  }
});
