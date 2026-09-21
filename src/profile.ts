// Profile loading and reference resolution (spec §1.4, §3).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import staticProfileText from "./profiles/static.yaml" with { type: "text" };
import ffmpegProfileText from "./profiles/ffmpeg.yaml" with { type: "text" };
import { FilmkitError, invalid } from "./errors.ts";
import { compileParamsSchema, validateAgainstSchema } from "./schema.ts";
import type { Profile } from "./types.ts";
import { loadYamlFile, parseYamlText, type YamlSource } from "./yaml.ts";
import type { ValidateFunction } from "ajv/dist/2020.js";

export interface LoadedProfile {
  profile: Profile;
  /** Where it came from, for error messages and doctor output. */
  origin: string;
  builtin: boolean;
  src: YamlSource;
  /** Compiled paramsSchema per task. */
  paramsValidators: Record<string, ValidateFunction>;
}

const BUILTIN_TEXT: Record<string, string> = {
  "filmkit/static": staticProfileText,
  "filmkit/ffmpeg": ffmpegProfileText,
};

export const BUILTIN_PROFILE_NAMES = Object.keys(BUILTIN_TEXT);

export function filmkitHome(): string {
  return process.env.FILMKIT_HOME ?? join(homedir(), ".filmkit");
}

/** Resolve a `profiles[].ref` to a Profile document, following spec §1.4. */
export function resolveProfileRef(ref: string, filmDir: string, field: string): LoadedProfile {
  if (ref.startsWith("./") || ref.startsWith("../")) {
    const path = resolve(filmDir, ref);
    if (!existsSync(path)) throw new FilmkitError(invalid(`profile file not found: ${ref}`, { field }));
    return loadProfileSource(loadYamlFile(path), ref, false);
  }
  if (ref.startsWith("filmkit/")) {
    const text = BUILTIN_TEXT[ref];
    if (!text) {
      throw new FilmkitError(
        invalid(`unknown builtin profile "${ref}"`, { field, hint: `builtins: ${BUILTIN_PROFILE_NAMES.join(", ")}` }),
      );
    }
    return loadProfileSource(parseYamlText(text, `<builtin ${ref}>`), `builtin`, true);
  }
  const m = /^([a-z0-9][a-z0-9-]{0,62})@([^/\\]+)$/.exec(ref);
  if (m) {
    const path = join(filmkitHome(), "profiles", `${m[1]}@${m[2]}.yaml`);
    if (!existsSync(path)) {
      throw new FilmkitError(
        invalid(`profile "${ref}" not found in ${dirname(path)}`, { field, hint: `expected file ${basename(path)}` }),
      );
    }
    return loadProfileSource(loadYamlFile(path), path, false);
  }
  if (isAbsolute(ref)) {
    throw new FilmkitError(invalid(`absolute profile paths are not allowed: ${ref}`, { field }));
  }
  throw new FilmkitError(
    invalid(`unrecognized profile ref "${ref}"`, {
      field,
      hint: "use ./path.yaml, filmkit/<builtin>, or <name>@<version>",
    }),
  );
}

export function loadProfileSource(src: YamlSource, origin: string, builtin: boolean): LoadedProfile {
  validateAgainstSchema("profile", src);
  const profile = src.value as Profile;
  if (!builtin && profile.metadata.name.startsWith("filmkit/")) {
    throw new FilmkitError(
      invalid(`${src.path}: profile names starting with "filmkit/" are reserved for builtins`, { field: "metadata.name" }),
    );
  }
  const paramsValidators: Record<string, ValidateFunction> = {};
  for (const [taskName, task] of Object.entries(profile.tasks)) {
    if (profile.runtime.type !== "cli" && (task.invocation || task.validate)) {
      throw new FilmkitError(
        invalid(`${src.path}: tasks.${taskName} declares invocation/validate but runtime.type is "${profile.runtime.type}"`, {
          field: `tasks.${taskName}`,
        }),
      );
    }
    paramsValidators[taskName] = compileParamsSchema(task.paramsSchema, `tasks.${taskName}.paramsSchema`, src);
  }
  return { profile, origin, builtin, src, paramsValidators };
}
