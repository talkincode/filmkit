---
name: filmkit
description: >
  Orchestrate and compose a video with filmkit, an agent-oriented video
  orchestration compiler. Use when the user wants to plan, assemble, or
  render a video from scenes (images, clips, narration, subtitles, music) via
  a filmkit.yaml, when a project already contains filmkit.yaml, or when the
  user mentions filmkit, a video orchestration file, scene timeline, or
  composing generated assets into a final MP4 without a GUI. Not for creating
  the individual assets themselves (use the tool's own skill: HyperFrames,
  qwentts, imagine, scorekit …) — filmkit tells you which files to produce and
  composes them.
---

# filmkit — compile a video from filmkit.yaml

filmkit is a **compiler and ledger, not an editor**. You (the agent) write
`filmkit.yaml` describing scenes, their implementation, the timeline and the
output spec; you produce each scene's files with whatever tool the scene's
Profile names; filmkit validates, derives the timeline, tells you what is
missing, and composes everything with ffmpeg into a spec-conformant video.

```text
filmkit.yaml ─► validate ─► plan ─► (produce files / filmkit run) ─► build ─► final.mp4
                                                                       └─► filmkit.lock.yaml
```

Full protocol: `docs/spec.md` in the filmkit repository. Schemas: `filmkit schema`.

## Setup check

```bash
filmkit doctor            # ffmpeg/ffprobe + every Profile the project references
```

Exit `3` means a dependency is missing; the report says which. filmkit never
prints environment variable values, only whether they are set.

## Core loop

1. **Start a project**: `filmkit init <dir>` writes a `filmkit.yaml` that
   validates and builds as-is (two placeholder cards + generated sine BGM).
   Edit it; do not start from an empty file.
2. **Validate after every edit**: `filmkit --json validate`. Errors carry a
   `field` path and YAML `line`. Fix until exit `0`. While referenced files are
   still missing, `validate` reports them; `plan` lists them under
   `missingFiles` so you can keep working.
3. **Ask what to do**: `filmkit --json plan`. It lists only nodes that are
   `missing`, `partial`, `stale` or `blocked`, in dependency order, each with:
   - `executor`: `filmkit run` (a cli Profile with an invocation — just run
     `filmkit run <id>`), `agent` (you produce the files with the named
     tool/skill), or `place files` (`filmkit/static`: copy the files into
     `produces` paths yourself).
   - `params`, `inputs` (resolved paths) and `produces` (where files must land).
   - `intent` — what the scene is meant to be. Translate `intent` into the
     tool's own parameters; filmkit never does that for you.
   - `timeline.scenes[].estimated: true` marks durations still taken from the
     plan because the scene's media does not exist yet.
4. **Produce**, then go back to step 3 until `plan` says `nothing to do`.
5. **Build**: `filmkit build --draft` for a fast low-res preview, `filmkit build`
   for the final. Output is verified with ffprobe against `output`; on any
   mismatch nothing is written to the target path.
6. **Check**: `filmkit status` writes `filmkit.lock.yaml` and shows which
   produces exist and whether the build is up to date.

## Writing filmkit.yaml

Minimal shape (defaults omitted — see `filmkit schema` for everything):

```yaml
apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: demo, title: Demo }
profiles:
  - ref: filmkit/static           # builtin: files placed by you
  - ref: filmkit/ffmpeg           # builtin: generic ffmpeg invocation
  - ref: ./profiles/qwentts.yaml  # your own Profile for a tool
assets:
  bgm: { kind: audio, uri: ./assets/bgm.mp3 }        # existing file
  logo: { kind: image, uri: ./assets/logo.png }
output:
  container: mp4
  video: { width: 1080, height: 1920, fps: 30, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
scenes:
  - id: s1
    duration: 6
    durationPolicy: min             # auto | exact | min  (see below)
    intent:
      description: Opening shot
      narration: { text: "…" }
    impl: { profile: filmkit/static, task: clip }
    produces:
      image: ./assets/s1.png
      audio: ./build/s1/voice.wav
      subtitle: ./build/s1/voice.srt
  - id: s2
    transition: { type: crossfade, duration: 0.5 }
    impl: { profile: filmkit/static, task: clip }
    produces: { video: ./build/s2/clip.mp4 }
timeline:
  tracks:
    - { id: music, kind: audio, asset: bgm, fit: loop, volume: 0.15, fadeOut: 3 }
    - { id: subs, kind: subtitles, source: scenes, mode: sidecar }
    - { id: mark, kind: overlay, asset: logo, position: top-right, width: 160, opacity: 0.8 }
```

Rules that matter most:

- **Ids** (`metadata.name`, scene ids, asset names, track ids) are
  `^[a-z0-9][a-z0-9-]*$` and share one namespace.
- **Paths are relative to filmkit.yaml** and must stay inside the project.
  `produces` paths must be unique across nodes.
- **Scene order = `scenes` order** unless `timeline.sequence` says otherwise.
  Start times are derived; only set `start:` to insert a deliberate gap.
- **`durationPolicy`**: `auto` uses the produced media's real length;
  `exact` forces `duration` (trims or freezes/pads); `min` uses the longer
  of `duration` and the media (the right choice for narration-driven scenes).
- **Audio per scene**: `produces.audio` replaces the clip's own sound by
  default (`audioMode: replace`); `mix` sums both; `keep` uses the clip's.
- **Generated assets**: an asset may have `impl` + `produces` instead of `uri`;
  it becomes a node in `plan` like a scene (this is how scorekit-generated
  music or a TTS voice file enters the project).
- **`${vars.x}`** is the only substitution in the film. Inside `impl.params`
  you may also write `${produces.audio}`, `${inputs.<id>}` etc.; the Profile's
  argv template resolves them at `run` time. No expressions, ever.
- **`intent` is for you, not for filmkit.** It never affects the build.

## Importing an existing Hyperstory project

```bash
filmkit import hyperstory ./schema.json --out filmkit.yaml   # never overwrites without --force
```

The conversion is one-way and intentionally lossy: fields filmkit cannot express
(style hints, `videoPrompt`, `voiceSpeed`, `videoAudio.volume`, planned
duration) are kept in `metadata.annotations` and reported as warnings. Scenes
become `filmkit/static` nodes, so your next steps are the same as any project:
`filmkit plan`, place or produce the files, then `filmkit build`. Point a scene
at a video-generation Profile yourself when it needs generated footage.

## Music that must hit the picture cuts (`fit: exact`)

```yaml
timeline:
  tracks:
    - { id: music, kind: audio, asset: scorekit-theme, fit: exact, cues: ./build/music/theme.cues.json }
```

`cues` is a neutral `filmkit/cues-v1` file **you** write from whatever the music
tool reports (scorekit's `meta.json` `sections[].seconds`, a DAW export, …);
filmkit never reads a tool's own timing document:

```json
{ "version": "filmkit/cues-v1",
  "cues": [ { "id": "open", "start": 0, "end": 24.87 },
            { "id": "body", "start": 24.87, "end": 49.74 } ] }
```

`validate` and `build` then check that every internal boundary lands on a
picture cut (scene start, or the middle of a crossfade) within `tolerance`
(default 0.05s) and that the piece covers the span it was asked to cover. A
failure names the cue, the measured offset and the expected cut. `exact` never
loops or pads: if the music is short, lengthen it or use `fit: loop`.

## Profiles: registering a tool

A Profile is a small YAML document (`kind: Profile`) that declares what a tool
can do and the JSON Schema of each task's params. Reference it from
`profiles[].ref` as `./path.yaml`, `<name>@<version>` (from
`~/.filmkit/profiles/`), or a builtin `filmkit/<name>`.

```yaml
apiVersion: filmkit/v1alpha1
kind: Profile
metadata: { name: scorekit, version: "0.7" }
runtime:
  type: cli                          # none | cli | skill | mcp | http
  binary: scorekit
  healthcheck: ["scorekit", "--json", "doctor"]
  exitCodes: { "0": ok, "2": invalid-input, "3": missing-dependency, "4": tool-failure }
tasks:
  build:
    paramsSchema:
      type: object
      required: [scene]
      properties: { scene: { type: string } }
    validate:   ["scorekit", "--json", "validate", "${params.scene}"]
    invocation: ["scorekit", "build", "${params.scene}", "-o", "${produces.audio}"]
```

- A ready-made Profile for scorekit ships in the filmkit repository
  (`profiles/scorekit.yaml`); copy it into your project and reference it as
  `./profiles/scorekit.yaml`.
- `runtime.type: cli` + `invocation` → `filmkit run <id>` executes it.
  Anything else (`skill`, `mcp`, `http`) is yours to execute; `plan` says
  `executor: agent`.
- When a tool has its own document format (a scorekit scene, a HyperFrames
  project), **reference the file from `params`, never inline it**. A
  `./`-prefixed param must exist; a `validate` template lets filmkit delegate
  content checks to the tool.
- `paramsSchema` closes unknown properties by default, so typos in `params`
  fail at `validate`, not at render time.

## Do not

- Do not edit `filmkit.lock.yaml`; `status`, `run` and `build` own it.
- Do not put tool-specific knobs anywhere except `impl.params`.
- Do not hand-write scene `start` values to "fix" overlaps — fix durations or
  transitions instead; overlaps are a validation error for a reason.
- Do not bypass `plan`: `build` refuses to compose while any node is not
  `ready`, and that is the intended guard against stale or missing footage.
- Do not expect filmkit to download URLs, call skills, or invent prompts.

## Command reference

| Command | What it does |
| --- | --- |
| `filmkit init [dir]` | Skeleton project; refuses a non-empty directory |
| `filmkit schema [--profile\|--lock]` | JSON Schema of Film / Profile / Lock |
| `filmkit validate [--no-delegate]` | Schema + references + timeline + Profile paramsSchema (+ tool `validate`) |
| `filmkit plan` | Work order (nodes not ready, topological order) |
| `filmkit run <id>` | Execute one cli node; records result in the lock |
| `filmkit build [--draft] [--dry-run]` | Normalize, compose, verify; `--dry-run` only writes `build/compose.filtergraph.txt` |
| `filmkit status` | Observe produces, write lock, report |
| `filmkit doctor` | Environment + Profile requirements |
| `filmkit import hyperstory <schema.json> [--out <path>] [--force]` | Convert a Hyperstory schema into a new filmkit.yaml |

Global options: `--film <path>` (default `./filmkit.yaml`), `--json`.
Exit codes: `0` ok · `1` io · `2` invalid input · `3` missing dependency · `4` external tool failure.
