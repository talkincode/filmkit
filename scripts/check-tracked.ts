// Guard against the failure mode that hid src/build/*.ts for five rounds: an
// unanchored `.gitignore` pattern (`build/`) matching a *source* directory, so
// the files exist for everyone who ran the tests locally and are missing for
// everyone who clones the repository.
//
// Any file under the tracked source, docs, profile and skill directories that
// git ignores is a bug: either the pattern is too broad or the file belongs
// somewhere else.

import { execFileSync } from "node:child_process";

const tracked = ["src", "bin", "scripts", "profiles", "skills", "tests", "docs"];

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let ignored: string[] = [];
try {
  ignored = git(["ls-files", "--others", "--ignored", "--exclude-standard", ...tracked])
    .split("\n")
    .filter(Boolean);
} catch (err) {
  console.error(`could not ask git which files are ignored: ${(err as Error).message}`);
  process.exit(1);
}

if (ignored.length > 0) {
  console.error("these files are ignored by .gitignore but live in tracked directories,");
  console.error("so a fresh clone would be missing them:");
  for (const file of ignored) {
    let reason = "";
    try {
      reason = git(["check-ignore", "-v", file]);
    } catch {
      // ignore
    }
    console.error(`  ${file}${reason ? `\n    ← ${reason}` : ""}`);
  }
  process.exit(1);
}

console.log(`no tracked-directory file is ignored (${tracked.join(", ")})`);
