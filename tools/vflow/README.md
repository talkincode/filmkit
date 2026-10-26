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
| pinned subjects (characters, props): the **approved** reference pack of the resolved variant (`variant`, else `defaultVariant`) | the same `assets` + `intent.references`; the subject's name, description and invariants go to `metadata.annotations` |
| `selected.video`, if the designers already picked one | the scene's `produces.video` (a ready clip), else a placeholder `./assets/<scene>.mp4` that `plan` lists as "place files" |
| `durationFrames` / `format.fps` | `scenes[].duration` in seconds, `durationPolicy: min`; no `durationFrames` → 3 s, estimated and flagged |
| `format` | `output.video` (container h264/aac/48 kHz stereo are defaults — edit freely) |

`impl` is always `filmkit/static` and `params` empty: **choosing a tool and writing its params is the agent's job**
(see `intent.references`, and the per-shot provenance in `metadata.annotations["vflow.shots"]`: roles, notes, views,
the original shot id, `prompts.image`/`prompts.audio`). For example `colab-comfy`'s `h3-ref2va` takes at most three
reference images, while a shot can carry more — which three is a creative decision this tool does not make.

Listed as **not imported** (never silently dropped): `audioTracks`, video/audio candidates, reference videos,
`selected.audio`, `dependsOn` edges, shots outside `sequence`, and the v2 reference-authoring materials. filmkit
makes its own music, narration and transitions.

Both vflow protocol generations are read (`vflow/v1`, `vflow/v2`, and the pre-rename `video-compose/*` ids);
anything else is refused with `field: apiVersion`. Unknown fields are ignored; the fields it does read are checked
strictly, with paths (`composition.shots.shot-003.subjects[0]`).

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

## Credentials

vflow sits behind Cloudflare Access; headless clients use a **service token**. Set `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` in the environment, or store them once with `filmkit vault set <NAME>` (environment wins,
then the vault — the same precedence as `filmkit run`). They travel only in request headers and appear in no output.
Plain `http://` is refused except for `localhost`, so a token never crosses a cleartext link.

What the vflow side must have in place (configuration, not code):

- the token exists in Cloudflare Access and is mapped in the Worker to an owner (`allowedServiceTokens`; an unmapped
  token fails closed), and
- the project's owner added that token's actor (e.g. `agent-…`) as a project member — `reader` is enough, this tool
  only reads. vflow projects are private by default, so a token that is not a member sees a 404.

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
