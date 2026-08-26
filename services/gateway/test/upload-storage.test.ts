import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeDroppedFile } from "../src/upload.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("private upload storage", () => {
  test("uses a private owned directory and atomically publishes mode 0600 files", () => {
    const root = mkdtempSync(join(tmpdir(), "familiar-upload-test-"));
    dirs.push(root);
    const drops = join(root, "state", "uploads");
    mkdirSync(drops, { recursive: true, mode: 0o755 });
    chmodSync(drops, 0o755);

    const stored = storeDroppedFile(Buffer.from("private screenshot"), "shot.png", drops);

    expect(lstatSync(drops).mode & 0o777).toBe(0o700);
    expect(lstatSync(drops).uid).toBe(process.getuid());
    expect(lstatSync(stored).mode & 0o777).toBe(0o600);
    expect(readFileSync(stored, "utf8")).toBe("private screenshot");
    expect(readdirSync(drops)).toEqual([stored.split("/").at(-1)!]);
    expect(stored.endsWith("__shot.png")).toBe(true);
  });

  test("refuses a symlink as the drops directory", () => {
    const root = mkdtempSync(join(tmpdir(), "familiar-upload-test-"));
    dirs.push(root);
    const target = join(root, "target");
    const link = join(root, "uploads");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link, "dir");

    expect(() => storeDroppedFile(Buffer.from("secret"), "secret.txt", link)).toThrow("must not be a symlink");
    expect(readdirSync(target)).toEqual([]);
  });
});
