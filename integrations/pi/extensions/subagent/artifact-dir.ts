/**
 * Artifact directory management for subagents.
 * 
 * Every job gets a deterministic, collision-safe directory for substantial
 * non-code artifacts (research, design, evidence). Code changes belong in
 * the worktree; artifacts go to the artifact directory.
 * 
 * Safety invariants:
 *   - Paths are validated to prevent traversal attacks
 *   - Directories created with mode 0700 for privacy
 *   - Old jobs lacking artifact_dir field get deterministic fallback
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface ArtifactDirConfig {
  /** Root artifacts directory, typically state/artifacts */
  root: string;
  /** Job ID for deterministic per-job path */
  jobId: string;
  /** Whether this is a fresh creation (true) or resurrection (false) */
  isNew: boolean;
}

export interface ArtifactDirResult {
  /** Absolute path to this job's artifact directory */
  dir: string;
  /** Whether the directory was created by this call */
  created: boolean;
  /** Error if creation failed (non-fatal; job can proceed) */
  error?: string;
}

/**
 * Validate that a path does not escape its intended root via traversal.
 * Returns true if safe, false otherwise.
 */
export function validateArtifactPath(root: string, candidate: string): boolean {
  try {
    const resolved = path.resolve(candidate);
    const rootResolved = path.resolve(root);
    // Must be within root and not be root itself
    return resolved.startsWith(rootResolved + path.sep);
  } catch {
    return false;
  }
}

/**
 * Create or verify the artifact directory for a job.
 * 
 * Path is deterministic: <root>/<job-id>/
 * This survives restart/resurrection and avoids collisions.
 */
export function ensureArtifactDir(config: ArtifactDirConfig): ArtifactDirResult {
  const jobPath = path.join(config.root, config.jobId);

  // Validate path safety
  if (!validateArtifactPath(config.root, jobPath)) {
    return {
      dir: jobPath, // still return the intended path for fallback
      created: false,
      error: "artifact path traversal detected",
    };
  }

  try {
    // Create root if it doesn't exist
    if (!fs.existsSync(config.root)) {
      fs.mkdirSync(config.root, { recursive: true, mode: 0o700 });
    }

    // Create or verify job directory
    const created = !fs.existsSync(jobPath);
    if (created) {
      fs.mkdirSync(jobPath, { recursive: true, mode: 0o700 });
    } else if (config.isNew) {
      // Collision on a fresh dispatch (extremely rare). Log but proceed.
      // The directory will be reused, which is safe.
    }

    return { dir: jobPath, created };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      dir: jobPath,
      created: false,
      error: `failed to create artifact directory: ${msg}`,
    };
  }
}

/**
 * Get artifact directory for a job, with deterministic fallback for old jobs.
 * 
 * Old jobs (before artifact_dir was added) get: <root>/<job-id>/
 * This is deterministic so resurrection finds the same directory.
 */
export function getArtifactDir(root: string, jobId: string): string {
  return path.join(root, jobId);
}

/**
 * Generate the mandatory artifact instruction for the prompt footer.
 * Tells the child exactly where to write substantial artifacts.
 */
export function artifactInstruction(artifactDir: string, kind: string): string {
  // Only pi agents can reliably harvest from their transcript;
  // others write to files anyway
  const baseInstruction =
    `Write substantial non-code artifacts — research, design, evidence, specs, ` +
    `analysis — to files in this directory (not /tmp or the repo root): ` +
    `${artifactDir}`;

  return (
    `\n\n---\n` +
    `**Artifacts:** ${baseInstruction}\n` +
    `**Code:** Changes belong in the worktree; they are the primary artifact.\n` +
    `**Verdict:** Your final verdict must list any artifact paths created.`
  );
}

/**
 * Prepare artifact directory before launch, returning the config to embed
 * in DispatchCommand and append to the prompt.
 */
export function prepareArtifactDir(
  artifactRoot: string,
  jobId: string,
  isNew: boolean = true
): { dir: string; instruction: string; error?: string } {
  const result = ensureArtifactDir({
    root: artifactRoot,
    jobId,
    isNew,
  });

  if (result.error) {
    // Non-fatal: include the error but still provide the intended path
    return {
      dir: result.dir,
      instruction: artifactInstruction(result.dir, "pi"),
      error: result.error,
    };
  }

  return {
    dir: result.dir,
    instruction: artifactInstruction(result.dir, "pi"),
  };
}
