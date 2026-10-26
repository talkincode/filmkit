// Gets the files a conversion needs onto disk, all-or-nothing:
// downloads go to a staging directory next to the target, are verified by the
// client (size + sha256), and only then renamed into place. A failure removes
// the staging directory, so a failed pull leaves no `.part` files and no
// half-landed assets. Files already on disk with the right content are kept
// (that is what makes a re-run cheap).

import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Client } from "./client.ts";
import { type FetchItem } from "./convert.ts";
import { fail, io } from "./errors.ts";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Assets are content-addressed under this directory; anything else is a scene clip the user may have replaced. */
const CACHE_DIR = "assets/vflow/";

interface Group {
  sha256: string;
  sizeBytes: number;
  /** First asset id with these bytes; any of them serves the same content. */
  assetId: string;
  targets: string[];
}

export interface FetchResult {
  /** Distinct downloads (by content). */
  downloaded: { assetId: string; bytes: number; targets: string[] }[];
  /** Targets that already held the right bytes. */
  present: string[];
}

/** Group by content: two asset ids with identical bytes are downloaded once and copied. */
function groupByContent(items: FetchItem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const g = groups.get(item.sha256) ?? { sha256: item.sha256, sizeBytes: item.sizeBytes, assetId: item.assetId, targets: [] };
    for (const t of item.targets) if (!g.targets.includes(t)) g.targets.push(t);
    groups.set(item.sha256, g);
  }
  return [...groups.values()];
}

export async function fetchFiles(opts: { client: Client; project: string; items: FetchItem[]; dir: string; force: boolean }): Promise<FetchResult> {
  const { client, project, dir, force } = opts;
  const abs = (target: string) => resolve(dir, target);
  const present: string[] = [];
  const todo: Group[] = [];
  const conflicts: string[] = [];

  // Decide everything that can be decided offline before the first request.
  for (const g of groupByContent(opts.items)) {
    let missing = false;
    for (const target of g.targets) {
      const path = abs(target);
      if (!existsSync(path)) {
        missing = true;
      } else if ((await sha256File(path)) === g.sha256) {
        present.push(target);
      } else if (relative(dir, path).split("\\").join("/").startsWith(CACHE_DIR) || force) {
        missing = true; // a wrong file at a content-addressed path is corrupt: replace it
      } else {
        conflicts.push(target);
      }
    }
    if (missing) todo.push(g);
  }
  if (conflicts.length) {
    fail(io(`refusing to overwrite ${conflicts.join(", ")}: the file exists with different content`, { hint: "move it away, or pass --force to replace it" }));
  }

  const downloaded: FetchResult["downloaded"] = [];
  if (todo.length === 0) return { downloaded, present };

  const cache = join(dir, "assets", "vflow");
  // mkdir -p reports the topmost directory it had to create: on failure that whole
  // branch is removed again, so a failed run leaves the project as it found it.
  const createdRoot = mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(join(cache, ".pull-"));
  let landed = false;
  try {
    const staged: { group: Group; file: string }[] = [];
    for (const [i, g] of todo.entries()) {
      const file = join(staging, `${i}.part`);
      await client.download(project, g.assetId, file, { sha256: g.sha256, sizeBytes: g.sizeBytes });
      staged.push({ group: g, file });
    }
    // Everything verified: move into place.
    for (const { group, file } of staged) {
      const [first, ...rest] = group.targets;
      for (const target of rest) {
        const path = abs(target);
        mkdirSync(dirname(path), { recursive: true });
        copyFileSync(file, `${path}.tmp-${process.pid}`);
        renameSync(`${path}.tmp-${process.pid}`, path);
      }
      mkdirSync(dirname(abs(first!)), { recursive: true });
      renameSync(file, abs(first!));
      downloaded.push({ assetId: group.assetId, bytes: group.sizeBytes, targets: group.targets });
    }
    landed = true;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (!landed && createdRoot) rmSync(createdRoot, { recursive: true, force: true });
  }
  return { downloaded, present };
}
