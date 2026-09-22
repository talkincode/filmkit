// Worker process for `runtime.type: http` tasks.
//
// `filmkit run` stays synchronous, so the network work happens here: the parent
// hands over the resolved spec and table on **stdin** (never argv — a resolved
// Authorization header must not be visible in `ps`), this process reads the
// credentials from its own inherited environment, performs the calls and writes
// the file atomically. It prints one JSON line describing what it did.
import { FilmkitError, formatDetail } from "./errors.ts";
import { runHttpJob, type HttpJob } from "./http.ts";

const input = await new Response(Bun.stdin.stream()).text();
let job: HttpJob;
try {
  job = JSON.parse(input) as HttpJob;
} catch (err) {
  process.stderr.write(`filmkit http worker: bad job on stdin: ${(err as Error).message}\n`);
  process.exit(1);
}

try {
  const result = await runHttpJob(job);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (err) {
  if (err instanceof FilmkitError) {
    process.stdout.write(`${JSON.stringify({ errors: err.errors })}\n`);
    process.exit(err.exitCode);
  }
  process.stdout.write(`${JSON.stringify({ errors: [{ code: "io", message: (err as Error).message }] })}\n`);
  process.exit(1);
}
void formatDetail;
