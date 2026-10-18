// Stand-in for `filmkit plan --json` in lifecycle tests: prints <cwd>/plan.json. The real filmkit is
// exercised by batch-estimate.test.ts and (M6) tests/colab-comfy.test.ts; here we only need a plan,
// and starting the real CLI (validate delegation included) would dominate the runtime of every test.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args[0] === "plan" && args.includes("--json")) {
  process.stdout.write(readFileSync(join(process.cwd(), "plan.json"), "utf8"));
  process.exit(0);
}
process.stderr.write(`fake-filmkit: unsupported ${args.join(" ")}\n`);
process.exit(2);
