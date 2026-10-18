// Stand-in for `filmkit` in lifecycle tests. `plan --json` prints <cwd>/plan.json; `run <id> --json` records the
// call in <cwd>/filmkit-run.log and succeeds (batch step 8). The real filmkit (plan, run, status, build, and the
// materialize it spawns) is exercised by batch-estimate.test.ts and tests/colab-comfy.test.ts; here we only need a
// plan, and starting the real CLI would dominate the runtime of every test.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "plan" && args.includes("--json")) {
  process.stdout.write(readFileSync(join(process.cwd(), "plan.json"), "utf8"));
  process.exit(0);
}
if (args[0] === "run" && args[1] && args.includes("--json")) {
  appendFileSync(join(process.cwd(), "filmkit-run.log"), `${args[1]} yes=${process.env.COLAB_COMFY_YES ?? ""}\n`);
  process.stdout.write(JSON.stringify({ id: args[1], produces: {} }) + "\n");
  process.exit(0);
}
process.stderr.write(`fake-filmkit: unsupported ${args.join(" ")}\n`);
process.exit(2);
