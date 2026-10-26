// vflow-pull end to end: the real CLI entry point against a vflow-shaped stub,
// real ffmpeg media, and the real filmkit commands on the result. The happy path
// ends in a finished video; every failure path asserts the project directory is
// exactly as it was (AGENTS.md acceptance rules 2 and 4).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { main } from "../src/cli.ts";
import { vaultDelete, vaultSet } from "../../../src/vault.ts";
import { media, project, type Project } from "../../../tests/helpers.ts";
import { sha256, startStub, type Stub, TOKEN } from "./stub-vflow.ts";

const PROJECT = "demo";
const COMPOSITION = "ep";
let home: string;
let png: Uint8Array;
let clip: Uint8Array;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "vflow-home-"));
  process.env.FILMKIT_HOME = home; // never touch the developer's real vault
  const dir = mkdtempSync(join(tmpdir(), "vflow-media-"));
  media.png(join(dir, "a.png"));
  media.mp4(join(dir, "a.mp4"), 1);
  png = readFileSync(join(dir, "a.png"));
  clip = readFileSync(join(dir, "a.mp4"));
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** A bundle in vflow's real export shape, built from real bytes so the manifest hashes are true. */
function makeBundle() {
  const png2 = new Uint8Array(png).map((b, i) => (i === png.length - 1 ? b ^ 1 : b)); // different bytes, same type
  const asset = (id: string, bytes: Uint8Array, mimeType: string) => ({ id, sha256: sha256(bytes), mimeType, sizeBytes: bytes.length });
  const shot = (over: Record<string, unknown>) => ({
    description: "",
    durationFrames: 24,
    dependsOn: [],
    subjects: [],
    references: { images: [], videos: [] },
    prompts: {},
    candidates: { images: [], videos: [], audios: [] },
    selected: { video: null, audio: null },
    ...over,
  });
  const bundle = {
    apiVersion: "vflow/v1",
    revision: 1,
    composition: {
      apiVersion: "vflow/v1",
      id: COMPOSITION,
      project: PROJECT,
      title: "End to end",
      format: { width: 320, height: 180, fps: 24 },
      audioTracks: [],
      sequence: ["shot-001", "shot-002"],
      shots: {
        "shot-001": shot({
          description: "A hero walks in",
          prompts: { video: "slow push-in" },
          references: { images: [{ asset: "mat-a", role: "framing" }] },
          subjects: [{ subjectId: "hero", subjectRevision: 1 }],
          selected: { video: "clip-1", audio: null },
        }),
        "shot-002": shot({ description: "Same clip, second shot", selected: { video: "clip-1", audio: null } }),
      },
    },
    dependencies: {
      subjects: [
        {
          id: "hero",
          kind: "character",
          revision: 1,
          status: "approved",
          name: "Hero",
          defaultVariant: "default",
          definition: { description: "a tall hero", invariants: ["red scarf"] },
          variants: { default: { description: "default look", referencePack: [{ asset: "hero-front", status: "approved" }] } },
        },
      ],
      assets: [asset("clip-1", clip, "video/mp4"), asset("hero-front", png2, "image/png"), asset("mat-a", png, "image/png")],
    },
  };
  return { bundle, assets: { "clip-1": clip, "hero-front": png2, "mat-a": png } as Record<string, Uint8Array> };
}

let p: Project;
let stub: Stub;
beforeEach(() => {
  p = project();
  const { bundle, assets } = makeBundle();
  stub = startStub({ bundle, assets, project: PROJECT, composition: COMPOSITION });
});
afterEach(() => {
  stub.stop();
  p.cleanup();
});

type Env = Record<string, string | undefined>;
async function run(args: string[], env: Env = { CF_ACCESS_CLIENT_ID: TOKEN.id, CF_ACCESS_CLIENT_SECRET: TOKEN.secret }) {
  const saved: Env = {};
  const keys = ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "VFLOW_BASE_URL"];
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return await main(args);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
const pullArgs = (extra: string[] = []) => ["pull", "--base", stub.url, "--project", PROJECT, "--composition", COMPOSITION, "--out", p.path("filmkit.yaml"), ...extra];

/** Every file under the project, relative, sorted — to prove a failed run changed nothing. */
function tree(dir = p.dir, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? [`${prefix}${e.name}/`, ...tree(join(dir, e.name), `${prefix}${e.name}/`)] : [`${prefix}${e.name}`]))
    .sort();
}
const contentRequests = () => stub.requests.filter((r) => r.includes("/content"));
const noSecrets = (r: { stdout: string; stderr: string }) => {
  for (const text of [r.stdout, r.stderr]) {
    expect(text).not.toContain(TOKEN.secret);
    expect(text).not.toContain(TOKEN.id);
  }
};

describe("pull: happy path", () => {
  test("exports, fetches verified bytes, writes the film — and filmkit builds a video from it", async () => {
    const r = await run(pullArgs(["--json"]));
    expect(r.exitCode).toBe(0);
    noSecrets(r);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ scenes: 2, assets: 2, downloaded: 3, present: 0, missingFiles: [] });
    expect(out.ignored).toEqual([]);

    // two assets, same bytes shared by two scenes: one request per distinct content
    expect(contentRequests()).toHaveLength(3);
    const film = YAML.parse(readFileSync(p.path("filmkit.yaml"), "utf8"));
    expect(film.scenes.map((s: any) => s.produces.video)).toEqual(["./assets/shot-001.mp4", "./assets/shot-002.mp4"]);
    expect(sha256(readFileSync(p.path("assets/shot-001.mp4")))).toBe(sha256(clip));
    expect(sha256(readFileSync(p.path("assets/shot-002.mp4")))).toBe(sha256(clip));
    for (const a of Object.values<any>(film.assets)) expect(existsSync(p.path(a.uri))).toBe(true);
    expect(film.scenes[0].intent).toMatchObject({ description: "A hero walks in", action: "slow push-in" });
    expect(film.scenes[0].intent.references).toHaveLength(2); // the shot material + the hero's approved reference
    expect(existsSync(p.path("vflow/ep@1.bundle.json"))).toBe(true);
    expect(readdirSync(p.path("assets/vflow")).filter((f) => f.startsWith(".pull-"))).toEqual([]); // staging is gone

    // The point of it all: the project is a legal, buildable film.
    expect(p.json("validate").exitCode).toBe(0);
    const built = p.json<{ output: { path: string } }>("build");
    expect(built.exitCode).toBe(0);
    expect(existsSync(p.path("build/ep.mp4"))).toBe(true);
  });

  test("pulling again is cheap and reproducible: nothing re-downloaded, the film byte-identical", async () => {
    await run(pullArgs());
    const first = readFileSync(p.path("filmkit.yaml"), "utf8");
    const before = contentRequests().length;
    const r = await run(pullArgs(["--force", "--json"]));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ downloaded: 0 });
    expect(contentRequests()).toHaveLength(before);
    expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toBe(first);
  });

  test("--revision pins the export", async () => {
    expect((await run(pullArgs(["--revision", "1"]))).exitCode).toBe(0);
    expect(stub.requests[0]).toContain("export?format=json&revision=1");
  });

  test("convert then fetch (the MCP route: structure from a saved bundle, bytes over REST) ends in the same place", async () => {
    const { bundle } = makeBundle();
    writeFileSync(p.path("bundle.json"), JSON.stringify({ bundle, serialized: "x" }));
    const c = await run(["convert", p.path("bundle.json"), "--out", p.path("filmkit.yaml"), "--json"]);
    expect(c.exitCode).toBe(0);
    expect(JSON.parse(c.stdout).missingFiles).toHaveLength(4); // 2 clips + 2 images, none fetched yet
    expect(stub.requests).toEqual([]); // convert is offline

    const f = await run(["fetch", p.path("bundle.json"), "--base", stub.url, "--dir", p.dir, "--json"]);
    expect(f.exitCode).toBe(0);
    expect(JSON.parse(f.stdout)).toMatchObject({ downloaded: 3, missingFiles: [] });
    expect(p.json("validate").exitCode).toBe(0);
  });
});

describe("pull: failures leave the project exactly as it was", () => {
  test("no credentials: Access redirects, exit 3 with the variable names, nothing written, no secret in output", async () => {
    const before = tree();
    const r = await run(pullArgs(["--json"]), {});
    expect(r.exitCode).toBe(3);
    const err = JSON.parse(r.stderr).errors[0];
    expect(err.code).toBe("missing-dependency");
    expect(err.hint).toContain("CF_ACCESS_CLIENT_ID");
    expect(tree()).toEqual(before);
    noSecrets(r);
  });

  test("a token vflow does not accept is exit 3 too, and the secret never reaches the output", async () => {
    const r = await run(pullArgs(), { CF_ACCESS_CLIENT_ID: TOKEN.id, CF_ACCESS_CLIENT_SECRET: "wrong-secret-VALUE" });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).not.toContain("wrong-secret-VALUE");
    expect(r.stderr).toContain("not accepted");
    expect(tree()).toEqual([]);
  });

  test("only one half of the token is invalid input, not a silent anonymous request", async () => {
    const r = await run(pullArgs(), { CF_ACCESS_CLIENT_ID: TOKEN.id });
    expect(r.exitCode).toBe(2);
    expect(stub.requests).toEqual([]);
  });

  test("bytes that do not match vflow's own manifest are refused: exit 4, nothing kept", async () => {
    stub.behavior.corrupt = "hero-front";
    const r = await run(pullArgs());
    expect(r.exitCode).toBe(4);
    expect(r.stderr).toContain("integrity check failed");
    expect(tree()).toEqual([]); // not even the assets that did verify, no staging, no film, no record
  });

  test("a download cut off half way is exit 4 and leaves no partial file", async () => {
    stub.behavior.truncate = "clip-1";
    const r = await run(pullArgs());
    expect(r.exitCode).toBe(4);
    expect(tree()).toEqual([]);
  });

  test("an unknown revision is invalid input (404), nothing written", async () => {
    const r = await run(pullArgs(["--revision", "9"]));
    expect(r.exitCode).toBe(2);
    expect(tree()).toEqual([]);
  });

  test("a server error is a tool failure; an unreachable server too", async () => {
    stub.behavior.status = 503;
    expect((await run(pullArgs())).exitCode).toBe(4);
    stub.stop();
    expect((await run(pullArgs())).exitCode).toBe(4);
    expect(tree()).toEqual([]);
  });

  test("an existing film is refused before any request; --force replaces it", async () => {
    p.write("filmkit.yaml", "mine\n");
    const r = await run(pullArgs());
    expect(r.exitCode).toBe(1);
    expect(stub.requests).toEqual([]);
    expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toBe("mine\n");
    expect((await run(pullArgs(["--force"]))).exitCode).toBe(0);
  });

  test("a clip the user already placed at a scene's path is never overwritten without --force", async () => {
    p.write("assets/shot-001.mp4", "my own clip");
    const before = tree();
    const r = await run(pullArgs());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("assets/shot-001.mp4");
    expect(readFileSync(p.path("assets/shot-001.mp4"), "utf8")).toBe("my own clip");
    expect(contentRequests()).toEqual([]);
    expect(tree()).toEqual(before);
  });

  test("a bundle that cannot become a legal film writes nothing and downloads nothing", async () => {
    stub.stop();
    const { bundle, assets } = makeBundle();
    bundle.composition.format.width = 321; // filmkit needs even dimensions
    stub = startStub({ bundle, assets, project: PROJECT, composition: COMPOSITION });
    const r = await run(pullArgs());
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("not legal for filmkit");
    expect(contentRequests()).toEqual([]);
    expect(tree()).toEqual([]);
  });

  test("credentials never cross a cleartext connection to anywhere but localhost", async () => {
    const r = await run(["pull", "--base", "http://vflow.example.org", "--project", PROJECT, "--composition", COMPOSITION, "--out", p.path("filmkit.yaml")]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("https");
    expect(stub.requests).toEqual([]);
  });
});

describe("cli surface", () => {
  test("missing required options and unknown commands are invalid input", async () => {
    expect((await run(["pull"])).exitCode).toBe(2);
    expect((await run(["nope"])).exitCode).toBe(2);
    expect((await run(["pull", "--project", "x", "--composition", "y"], {})).exitCode).toBe(2); // no --base, no VFLOW_BASE_URL
    expect((await run(["convert", p.path("missing.json")])).exitCode).toBe(1);
  });

  test("VFLOW_BASE_URL stands in for --base", async () => {
    const r = await run(["pull", "--project", PROJECT, "--composition", COMPOSITION, "--out", p.path("filmkit.yaml")], {
      CF_ACCESS_CLIENT_ID: TOKEN.id,
      CF_ACCESS_CLIENT_SECRET: TOKEN.secret,
      VFLOW_BASE_URL: stub.url,
    });
    expect(r.exitCode).toBe(0);
  });

  test("credentials come from the filmkit vault when the environment has none, and the environment wins when both exist", async () => {
    vaultSet("CF_ACCESS_CLIENT_ID", [], TOKEN.id);
    vaultSet("CF_ACCESS_CLIENT_SECRET", [], "stale-vault-secret");
    try {
      // vault only (and wrong): refused
      expect((await run(pullArgs(), {})).exitCode).toBe(3);
      // environment overrides the vault's wrong secret
      expect((await run(pullArgs(), { CF_ACCESS_CLIENT_SECRET: TOKEN.secret })).exitCode).toBe(0);
    } finally {
      vaultDelete("CF_ACCESS_CLIENT_ID");
      vaultDelete("CF_ACCESS_CLIENT_SECRET");
    }
    // and the right pair in the vault alone is enough
    vaultSet("CF_ACCESS_CLIENT_ID", [], TOKEN.id);
    vaultSet("CF_ACCESS_CLIENT_SECRET", [], TOKEN.secret);
    try {
      expect((await run(pullArgs(["--force"]), {})).exitCode).toBe(0);
    } finally {
      vaultDelete("CF_ACCESS_CLIENT_ID");
      vaultDelete("CF_ACCESS_CLIENT_SECRET");
    }
  });

  test("convert refuses to overwrite an existing film, and leaves it alone", async () => {
    const { bundle } = makeBundle();
    writeFileSync(p.path("bundle.json"), JSON.stringify(bundle));
    p.write("filmkit.yaml", "mine\n");
    const r = await run(["convert", p.path("bundle.json"), "--out", p.path("filmkit.yaml")]);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(p.path("filmkit.yaml"), "utf8")).toBe("mine\n");
  });

  test("help lists every command", async () => {
    const r = await run(["help"]);
    for (const c of ["pull", "convert", "fetch"]) expect(r.stdout).toContain(`vflow-pull ${c}`);
  });
});
