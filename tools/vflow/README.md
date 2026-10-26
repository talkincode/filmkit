# vflow-pull

Read a [vflow](https://github.com/talkincode/vflow) composition into a filmkit project.

vflow is where story designers (and their agents, over MCP) design and iterate: shots, descriptions, material
images, characters and props with reference sheets. filmkit is the compiler that turns files into a video. This
helper is the one-way bridge between them: **filmkit reads what it needs from vflow; vflow is never written to.**

`vflow-pull` is a standalone Bun/TypeScript helper, like `colab-comfy`. It is **not** part of filmkit core:
nothing under `src/` knows about vflow, and filmkit itself still does not parse any tool's native documents. The
helper reuses two small pieces of core on purpose — the vault's credential lookup and the film loader (to prove
every generated film is legal) — and changes neither.

## What it takes

| from vflow | in the filmkit project |
| --- | --- |
| shot `description`, `prompts.video` | `scenes[].intent.description` / `intent.action` (in `sequence` order) |
| shot material images (`references.images`, `candidates.images`) | `assets` (kind from MIME) + `intent.references`, files under `assets/vflow/<sha256>.<ext>` |
| shot reference videos (`references.videos`) | `kind: video` input assets + `intent.references`; role/notes stay in `vflow.shots.referenceVideos`. Legacy unreviewed references are labelled `approval: unverified`, not claimed approved or promoted to final clips. |
| pinned subjects (characters, props): the **approved** reference pack of the resolved variant (`variant`, else `defaultVariant`) | the same `assets` + `intent.references`; the subject's name, description and invariants go to `metadata.annotations` |
| `selected.video`, if the designers already picked one | the scene's `produces.video` (a ready clip), else a placeholder `./assets/<scene>.mp4` that `plan` lists as "place files" |
| v2 `motion_reference` materials, pinned by exact id/revision and approved | motion video, overview, keyframes and source archive as ordinary assets; `vflow.shots.motionReferences` retains scene/subject versions, motion-only purpose and source provenance. Archive is not a model input, no white-model asset becomes final footage. |
| `durationFrames` / `format.fps` | `scenes[].duration` in seconds, `durationPolicy: min`; no `durationFrames` → 3 s, estimated and flagged |
| `format` | `output.video` (container h264/aac/48 kHz stereo are defaults — edit freely) |

`impl` is always `filmkit/static` and `params` empty: **choosing a tool and writing its params is the agent's job**
(see `intent.references`, and the per-shot provenance in `metadata.annotations["vflow.shots"]`: roles, notes, views,
the original shot id, `prompts.image`/`prompts.audio`). For example `colab-comfy`'s `h3-ref2va` takes at most three
reference images, while a shot can carry more — which three is a creative decision this tool does not make.

Listed as **not imported** (never silently dropped): `audioTracks`, video/audio candidates,
`selected.audio`, `dependsOn` edges, shots outside `sequence`, and v2 reference-authoring materials other than approved motion references. filmkit
makes its own music, narration and transitions.

Both vflow protocol generations are read (`vflow/v1`, `vflow/v2`, and the pre-rename `video-compose/*` ids);
anything else is refused with `field: apiVersion`. Unknown fields are ignored; the fields it does read are checked
strictly, with paths (`composition.shots.shot-003.subjects[0]`).

For approved dynamic references the bundle must contain the pinned composition baseline. Design changes
(description, prompts, dependencies, duration, format), subject/variant or scene-version drift are refused;
candidate/selected output changes alone do not invalidate a design. Reference fps may differ from composition
fps: durations are compared in seconds. Candidate motion revisions are skipped with a warning, never claimed
approved. See [L0 dynamic-reference workflow](../../docs/blockout.md).

## Install

```bash
bun install                                              # in the filmkit repo
ln -sf "$PWD/tools/vflow/bin/vflow-pull.ts" ~/.local/bin/vflow-pull
vflow-pull help
```

## Use

```bash
export VFLOW_BASE_URL=https://vflow.talkincode.net      # or --base
vflow-pull pull --project demo --composition episode-001 [--revision 6] --out filmkit.yaml
```

`pull` exports the composition, downloads the files it needs (each verified against vflow's own sha256 and size),
and writes a **new** `filmkit.yaml` plus `vflow/<composition>@<revision>.bundle.json` (the exact export, kept as the
record of what was imported). An existing film is refused unless `--force`. Then it is an ordinary filmkit project:
`filmkit plan` lists one `place files` node per shot (or none, for shots that already had a selected clip).

Pin `--revision` when you want a reproducible import: the same bundle always yields a byte-identical `filmkit.yaml`.
After the import the film is yours; filmkit never reads vflow again and a later `pull` is a new file (or `--force`).

**The MCP route.** If your agent already talks to vflow over MCP, take the structure from there and only the bytes
over REST — MCP cannot carry asset bytes, and passing an image through a model's context is not a transport:

```bash
# the agent saves the composition_export result (the wrapper object is fine) as bundle.json, then:
vflow-pull convert bundle.json --out filmkit.yaml        # offline; lists the files still missing
vflow-pull fetch bundle.json --dir .                     # bytes only, verified
```

## Offline white-model handoff to vflow

After `blockout render`, make a local package for the existing vflow upload and material APIs:

```bash
vflow-pull package-motion out/manifest.json --binding vflow-bindings.json --out motion-package.json
```

Bindings must explicitly supply `id`, `title`, `compositionId`, `compositionRevision`, `shotId`,
`scene: {id,revision}`, `environmentVariant`, `subjects: [{kind,id,revision,variant}]`, `usage` and `provenance`.
They must match the rendered bundle's composition/shot, scene geometry and subject revision set. The helper
re-hashes every artifact and uses ffprobe to check the actual decoded video, not just the declared metadata;
a skipped/empty seek check is not considered verified. If usage has several purposes, also provide
`keyframeUsages: [{momentFrame,purpose}]`; it will not guess which kind of motion each frame expresses.

The result is `{document, uploads, warning}`: an **unreviewed** `motion_reference` candidate and a list of
bundle-relative files with stable role/moment/hash-based IDs, MIME, size and SHA-256. Identical bytes in distinct
roles still have distinct IDs (overview and keyframe are not the same semantic asset). Upload them using
vflow's existing two-stage upload API, then submit `document` through `authoring_document_put` and deliberately
review/approve/pin it. This command makes no network write, grants no approval and sends nothing to a model.
See `docs/blockout.md` and the fixture bindings for a full example.

## Credentials

vflow sits behind Cloudflare Access. Two ways in, tried in this order:

1. **Your own login (for designers reading their own projects).** Log in once with
   `cloudflared access login https://vflow.talkincode.net` (a browser SSO round trip); `vflow-pull` then asks
   `cloudflared access token` for your Access token and sends it as `cf-access-token`. Nothing to set up on the
   vflow side: vflow projects are private to their owner, and you are the owner. The login lasts about a day; when
   it expires the refusal says so and prints the login command. (Only for `https://` origins.)
2. **A service token (for headless agents).** `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in the
   environment, or stored once with `filmkit vault set <NAME>` (environment wins, then the vault — the same
   precedence as `filmkit run`). If set, it takes precedence over the login.

Either way the value travels only in request headers and appears in no output; the tool stores nothing. Plain
`http://` is refused except for `localhost`, so a credential never crosses a cleartext link.

What the vflow side must have in place for a **service token** (configuration, not code):

- the token exists in Cloudflare Access and is mapped in the Worker to an owner (`allowedServiceTokens`; an unmapped
  token fails closed), and
- the project's owner added that token's actor (e.g. `agent-…`) as a project member — `reader` is enough, this tool
  only reads. A token that is not a member sees a 404.

## Failure behaviour

A failed `pull` leaves the project exactly as it was: the film is generated and checked for legality in memory first
(odd `format` sizes, unknown references …), every download is verified before it lands, staging is removed, and the
film and the record are written last by temp file + rename. A file the user already placed at a scene's path is never
overwritten without `--force`. Files that landed and verified stay (they are content-addressed), so a re-run is cheap.

Exit codes follow filmkit: `0` ok, `1` io (e.g. refusing to overwrite), `2` invalid input (unknown apiVersion, bad
ids, 404), `3` missing dependency (no or rejected credentials — Access answers with a 302/401/403), `4` tool failure
(network, 5xx, truncated or tampered download). `--json` gives `{"errors":[{code,message,field?,hint?}]}` on stderr.

## Verify

```bash
bun test tools/vflow                         # converter fixtures are real vflow exports; stub-server end to end incl. a built video
VFLOW_DIR=~/github/vflow bash scripts/e2e-vflow.sh
```

The script starts vflow's own acceptance server (`scripts/ui-test-server.ts`: real REST routes and domain,
in-memory, loopback only), pulls a v1 and a v2 project, compares the landed bytes with what vflow serves, builds a
video, and checks that a failing pull changes nothing. It refuses to run if something already listens on `:4179`.

`VFLOW_DIR=~/github/vflow bun scripts/e2e-motion-reference.ts` exercises the real vflow MCP prepare/evidence
and REST export/content interfaces, then pulls an approved motion video's keyframes, overview and source into
filmkit without producing final footage. It uses only local synthetic fixtures, no production data or model calls.
