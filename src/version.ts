// One place that knows filmkit's own version, so `--version`, `doctor` and the
// release notes cannot drift apart.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";
