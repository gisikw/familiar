/**
 * Tests for artifact directory management.
 * 
 * Run: nix develop .#stt -c bun test integrations/pi/extensions/subagent/artifact-dir.test.ts
 */

import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ensureArtifactDir,
  getArtifactDir,
  validateArtifactPath,
  artifactInstruction,
  prepareArtifactDir,
} from "./artifact-dir.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-test-"));
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
});

describe("validateArtifactPath", () => {
  test("allows path within root", () => {
    const root = path.join(tempDir, "artifacts");
    const candidate = path.join(root, "job-123");
    expect(validateArtifactPath(root, candidate)).toBe(true);
  });

  test("rejects path traversal with ..", () => {
    const root = path.join(tempDir, "artifacts");
    const candidate = path.join(root, "..", "escape");
    expect(validateArtifactPath(root, candidate)).toBe(false);
  });

  test("rejects absolute path outside root", () => {
    const root = path.join(tempDir, "artifacts");
    const candidate = "/etc/passwd";
    expect(validateArtifactPath(root, candidate)).toBe(false);
  });

  test("rejects path equal to root (must be child)", () => {
    const root = path.join(tempDir, "artifacts");
    expect(validateArtifactPath(root, root)).toBe(false);
  });

  test("allows nested children", () => {
    const root = path.join(tempDir, "artifacts");
    const candidate = path.join(root, "job-123", "data", "nested");
    expect(validateArtifactPath(root, candidate)).toBe(true);
  });
});

describe("ensureArtifactDir", () => {
  test("creates new directory with correct mode", () => {
    const root = path.join(tempDir, "artifacts");
    const result = ensureArtifactDir({
      root,
      jobId: "sub-20260820-test-1234",
      isNew: true,
    });

    expect(result.created).toBe(true);
    expect(result.error).toBeUndefined();
    expect(fs.existsSync(result.dir)).toBe(true);

    // Verify mode is restrictive (0700)
    const stat = fs.statSync(result.dir);
    expect((stat.mode & 0o777) === 0o700).toBe(true);
  });

  test("idempotent: reuses existing directory", () => {
    const root = path.join(tempDir, "artifacts");
    const jobId = "sub-20260820-test-2345";

    const first = ensureArtifactDir({ root, jobId, isNew: true });
    expect(first.created).toBe(true);

    const second = ensureArtifactDir({ root, jobId, isNew: false });
    expect(second.created).toBe(false);
    expect(second.dir).toBe(first.dir);
    expect(second.error).toBeUndefined();
  });

  test("rejects traversal attacks", () => {
    const root = path.join(tempDir, "artifacts");
    const result = ensureArtifactDir({
      root,
      jobId: "../escape",
      isNew: true,
    });

    expect(result.created).toBe(false);
    expect(result.error).toBeDefined();
  });

  test("creates parent root directory if missing", () => {
    const root = path.join(tempDir, "new", "path", "artifacts");
    expect(fs.existsSync(root)).toBe(false);

    const result = ensureArtifactDir({
      root,
      jobId: "sub-20260820-test-3456",
      isNew: true,
    });

    expect(result.created).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
  });

  test("root directory also has mode 0700", () => {
    const root = path.join(tempDir, "artifacts-new");
    ensureArtifactDir({
      root,
      jobId: "sub-20260820-test-4567",
      isNew: true,
    });

    const stat = fs.statSync(root);
    expect((stat.mode & 0o777) === 0o700).toBe(true);
  });
});

describe("getArtifactDir", () => {
  test("returns deterministic path for job", () => {
    const root = path.join(tempDir, "artifacts");
    const jobId = "sub-20260820-test-5678";

    const dir = getArtifactDir(root, jobId);
    expect(dir).toBe(path.join(root, jobId));
  });

  test("same job always returns same path", () => {
    const root = path.join(tempDir, "artifacts");
    const jobId = "sub-20260820-test-6789";

    const dir1 = getArtifactDir(root, jobId);
    const dir2 = getArtifactDir(root, jobId);
    expect(dir1).toBe(dir2);
  });

  test("different jobs get different paths", () => {
    const root = path.join(tempDir, "artifacts");

    const dir1 = getArtifactDir(root, "job-1");
    const dir2 = getArtifactDir(root, "job-2");
    expect(dir1).not.toBe(dir2);
  });
});

describe("artifactInstruction", () => {
  test("includes artifact directory path", () => {
    const dir = "/tmp/artifacts/job-123";
    const instruction = artifactInstruction(dir, "pi");

    expect(instruction).toContain(dir);
    expect(instruction).toContain("artifacts");
  });

  test("mentions code changes belong in worktree", () => {
    const instruction = artifactInstruction("/tmp/artifacts/job-123", "pi");
    expect(instruction).toContain("worktree");
  });

  test("mentions verdict should list artifact paths", () => {
    const instruction = artifactInstruction("/tmp/artifacts/job-123", "pi");
    expect(instruction).toContain("verdict");
    expect(instruction).toContain("artifact");
  });

  test("includes separator and formatting", () => {
    const instruction = artifactInstruction("/tmp/artifacts/job-123", "pi");
    expect(instruction).toContain("---");
    expect(instruction).toContain("**");
  });
});

describe("prepareArtifactDir", () => {
  test("creates directory and returns instruction with path", () => {
    const root = path.join(tempDir, "artifacts");
    const result = prepareArtifactDir(root, "sub-20260820-test-7890", true);

    expect(result.dir).toBeDefined();
    expect(result.instruction).toBeDefined();
    expect(result.instruction).toContain(result.dir);
    expect(result.error).toBeUndefined();
  });

  test("creates directory when isNew=true", () => {
    const root = path.join(tempDir, "artifacts");
    const jobId = "sub-20260820-test-8901";

    const result = prepareArtifactDir(root, jobId, true);
    expect(fs.existsSync(result.dir)).toBe(true);
  });

  test("reuses directory when isNew=false", () => {
    const root = path.join(tempDir, "artifacts");
    const jobId = "sub-20260820-test-9012";

    // Create the directory first
    fs.mkdirSync(path.join(root, jobId), { recursive: true });

    const result = prepareArtifactDir(root, jobId, false);
    expect(fs.existsSync(result.dir)).toBe(true);
  });

  test("includes error when directory creation fails (e.g., invalid path)", () => {
    // Use a job ID that would escape the root
    const root = path.join(tempDir, "artifacts");
    const result = prepareArtifactDir(root, "../escape", true);

    expect(result.dir).toBeDefined();
    expect(result.error).toBeDefined();
    // Instruction is still provided as fallback
    expect(result.instruction).toBeDefined();
  });

  test("non-fatal errors: instruction still included", () => {
    const root = path.join(tempDir, "artifacts");
    const result = prepareArtifactDir(root, "../escape", true);

    expect(result.instruction).toContain("artifacts");
    expect(result.instruction).toContain("verdict");
  });
});

describe("integration: old jobs without artifact_dir field", () => {
  test("resurrection finds same artifact dir via deterministic path", () => {
    const root = path.join(tempDir, "artifacts");
    const jobId = "sub-20260820-test-old";

    // Initial dispatch
    const first = prepareArtifactDir(root, jobId, true);
    const firstPath = first.dir;

    // Later resurrection (e.g., after restart)
    const second = prepareArtifactDir(root, jobId, false);
    const secondPath = second.dir;

    expect(firstPath).toBe(secondPath);
  });

  test("fallback path is computed correctly", () => {
    const root = path.join(tempDir, "artifacts");
    const jobId = "sub-20260820-test-fallback";

    const dir = getArtifactDir(root, jobId);
    expect(dir).toBe(path.join(root, jobId));
  });
});
