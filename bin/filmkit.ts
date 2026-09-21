#!/usr/bin/env bun
import { main } from "../src/cli.ts";

const r = main(process.argv.slice(2));
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.exitCode);
