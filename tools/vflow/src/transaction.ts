// Install a verified batch with rollback, including existing files. Temp sources
// live on the project filesystem. Nothing is exposed until all downloads succeed;
// a failed rename/write restores previous files instead of leaving half a pull.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail, io, PullError } from "./errors.ts";

/** Leave backups available if filesystem faults prevent restoration itself. */
export class RecoveryError extends PullError {}

export function commitFiles(files: { source: string; target: string }[], staging: string): void {
  const installed: { target: string; backup?: string; landed: boolean }[] = [];
  const createdDirs: string[] = [];
  try {
    // Reject occupied paths before any file is installed, even with --force.
    for (const f of files) {
      if (existsSync(f.target) && !lstatSync(f.target).isFile()) throw new Error(`target is not a regular file: ${f.target}`);
    }
    for (const [i, f] of files.entries()) {
      const made = mkdirSync(dirname(f.target), { recursive: true });
      if (made) createdDirs.push(made);
      const item: { target: string; backup?: string; landed: boolean } = { target: f.target, landed: false };
      installed.push(item);
      if (existsSync(f.target)) {
        item.backup = join(staging, `backup-${i}`);
        renameSync(f.target, item.backup);
      }
      renameSync(f.source, f.target);
      item.landed = true;
    }
  } catch (err) {
    const recoveryErrors: string[] = [];
    for (const f of installed.reverse()) {
      try {
        if (f.landed) rmSync(f.target);
        if (f.backup) renameSync(f.backup, f.target);
      } catch (recovery) { recoveryErrors.push((recovery as Error).message); }
    }
    // Only remove directories this call created, and only after restoration.
    for (const dir of createdDirs.reverse()) {
      try { removeEmptyTree(dir); } catch (recovery) { recoveryErrors.push((recovery as Error).message); }
    }
    if (recoveryErrors.length) throw new RecoveryError([io(`cannot install vflow pull: ${(err as Error).message}`, { hint: `rollback failed; preserve staging ${staging}: ${recoveryErrors.join("; ")}` })]);
    fail(io(`cannot install vflow pull: ${(err as Error).message}`));
  }
}

function removeEmptyTree(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) removeEmptyTree(join(dir, e.name));
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}
