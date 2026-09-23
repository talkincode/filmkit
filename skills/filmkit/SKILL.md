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
filmkit.yaml ─► validate ─► plan ─► storyboard ─► (produce files / filmkit run) ─► build ─► final.mp4
                                                                                         └─► filmkit.lock.yaml
```

Full protocol: `docs/spec.md` in the filmkit repository. Schemas: `filmkit schema`.

## Setup check — first, every session

Before writing or editing a film — and again whenever you add a
`profiles[].ref` — run the doctor **in the project directory** (it reads the
film to know which Profiles to check):

```bash
filmkit doctor            # ffmpeg/ffprobe + every Profile the project references
filmkit --json doctor     # the same report, machine-readable
```

It reports presence only — filmkit never prints environment variable values:
ffmpeg/ffprobe and the filters `build` needs, each referenced Profile's
binaries, required env vars, `healthcheck` and `healthcheckExpect`. Exit `3`
means a dependency is missing; the report says which.

**When the report is not all green, tell the user before doing anything
else.** For each problem give all three parts:

1. **What is missing**, exactly as doctor names it: binary, `env` var,
   filter, or a failed healthcheck.
2. **What it blocks in this film** — which Profile, therefore which
   scene/asset nodes cannot be produced, and the consequence downstream
   (`ARK_API_KEY` unset → every `seedance` node; no usable narration tool →
   scenes depending on narration stay `estimated` and `blocked`; a missing
   compose filter → `build` cannot run at all).
3. **The options** — install/fix it, export the variable in the shell that
   runs filmkit, or point those nodes at another Profile, stating what the
   substitute costs in quality, money or time.

Do not silently route around a missing dependency with a different tool:
choosing the substitute is the user's call. Re-run `filmkit doctor` after
anything is fixed.

Two gaps doctor cannot see, worth checking yourself when symptoms match:

- **Shell provenance**: doctor sees only the environment of the shell that
  started it — a key defined in `~/.zshenv` is absent in a plain `sh` child.
  If it reports `not set` and you know it is set, re-run from a shell that
  has it (`zsh -c '…'`).
- **ffmpeg features beyond the compose filters**: `drawtext`/libass are not
  in doctor's list; without them text and captions must go through
  `imagine text` PNGs (see below) — say so when reporting impact.

## Core loop

Start every session at **Setup check** above — never work blind. Then:

1. **Start a project**: `filmkit init <dir>` writes a `filmkit.yaml` that
   validates and builds as-is (two placeholder cards + generated sine BGM).
   Edit it; do not start from an empty file.
2. **Validate after every edit**: `filmkit --json validate`. Errors carry a
   `field` path and YAML `line`. Fix until exit `0`. While referenced files are
   still missing, `validate` reports them; `plan` lists them under
   `missingFiles` so you can keep working.
3. **Ask what to do**: `filmkit --json plan`. It lists only nodes that are
   `missing`, `partial`, `stale` or `blocked`, in dependency order, each with:
   - `executor`: `filmkit run` (a cli Profile with an invocation, or an http
     Profile — just run `filmkit run <id>`), `agent` (you produce the files with the named
     tool/skill), or `place files` (`filmkit/static`: copy the files into
     `produces` paths yourself).
   - `params`, `inputs` (resolved paths) and `produces` (where files must land).
   - `intent` — what the scene is meant to be. Translate `intent` into the
     tool's own parameters; filmkit never does that for you.
   - `timeline.scenes[].estimated: true` marks durations still taken from the
     plan because the scene's media does not exist yet.
4. **Storyboard before you spend**: `filmkit storyboard` writes
   `build/storyboard.json` + `build/storyboard.html` — every shot with its
   window, status, intent, params and live previews of whatever already
   exists. **Before the first paid generation** (and again before the final
   build) walk the user through that sheet, shot by shot. Confirmation is the
   default; if the user explicitly says no confirmation is needed, review every
   shot yourself against the sheet and keep going — but always leave
   `build/storyboard.html` regenerated so a human can preview later. Details:
   "Storyboard: proof every shot before you spend" below.
5. **Produce**, then go back to step 3 until `plan` says `nothing to do`.
   Produce exactly the nodes `plan` lists — a node it did not list is already
   done, and for http that second run is refused without `--force` (see "Cost
   discipline" below). Before the first `filmkit run` of a node whose Profile calls a
   paid API, confirm its `params` with the user (via the storyboard sheet).
6. **Build**: `filmkit build --draft` for a fast low-res preview, `filmkit build`
   for the final. Output is verified with ffprobe against `output`; on any
   mismatch nothing is written to the target path.
7. **Check**: `filmkit status` writes `filmkit.lock.yaml` and shows which
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

## Rendering a scene with Remotion

A ready-made Profile ships in the filmkit repository (`profiles/remotion.yaml`):

```yaml
scenes:
  - id: s1
    duration: 4
    durationPolicy: min
    impl:
      profile: remotion
      task: render
      params:
        project: ./video                    # Remotion project dir, relative to filmkit.yaml
        entry: src/index.ts                 # project-relative (Remotion's own vocabulary)
        composition: SceneOne
        props: ./video/props/s1.json         # you write it; filmkit checks + hashes it
    produces: { video: ./build/s1.mp4 }
```

What happens under the hood, and what it means for you:

- The commands run **inside `./video`** (`tasks[].cwd`), because Remotion's CLI only
  resolves from its own project. Every path filmkit hands over — `produces`,
  `inputs`, and `./`-prefixed params like `props` — is passed as an **absolute
  path**; strings without `./` (`entry`) are passed through untouched.
- `props` is the hand-off channel: read the resolved scene seconds and the
  `output` spec from `filmkit plan`, write them into the props JSON, and the
  composition renders exactly what the film asks for. Never let filmkit or you
  write the TSX — that is the composition author's job.
- Values inside the props file and the whole `project` directory (minus
  `node_modules`) are folded into the node's staleness key: edit the TSX or the
  props and `filmkit plan` marks the scene `stale`, so `build` cannot recycle an
  old clip. Re-run the scene with `filmkit run <id>`.
- Optional flags are dropped when unset: `crf`, `scale`, `frames`, `concurrency`,
  `log`, `imageFormat`. Setting an undeclared param fails `validate`.
- Use `task: still` when you want a single frame as an image (covers, posters).
- Keep compositions deterministic — no `Date.now()`, unseeded randomness or
  render-time network calls — or the lock's hashes stop meaning anything.
- A `durationPolicy: exact` scene is better served by rendering the exact frame
  range (`frames: "0-99"`) than by letting filmkit trim afterwards.

## Rendering a scene with HyperFrames

`profiles/hyperframes.yaml` wraps an HTML composition project:

```yaml
scenes:
  - id: s1
    duration: 3
    durationPolicy: min
    impl:
      profile: hyperframes
      task: render
      params:
        project: ./video                    # HyperFrames project dir; becomes the command's cwd
        quality: draft                      # draft while iterating; omit for the tool's default
        variables: ./video/vars/s1.json      # you write it; filmkit checks + hashes it
    produces: { video: ./build/s1.mp4 }
```

- `filmkit validate` delegates the node to **`hyperframes check`** — lint,
  runtime, layout, motion and contrast in one browser session (~8s per node).
  That gate runs inside `./video`; `filmkit validate --no-delegate` is the fast
  structural pass. `check` exiting 1 is reported as a tool failure whose hint
  carries the tool's own findings, so read the hint before touching the project.
- `filmkit run s1` renders. Paths cross the cwd boundary absolute (output and the
  variables file); `composition`, when set, stays project-relative.
- `durationPolicy: min` is the usual choice: the composition declares its own
  `data-duration`, and the narration decides whether the film needs more.
- Match the composition to the film: `data-width/height` and `--fps` (pass the
  film's `output.fps`) keep the compose stage from re-scaling or retiming.
- HyperFrames' own convention is to preview in Studio before rendering; keep
  that: render only once the composition has been approved, and prefer
  `quality: draft` while iterating.
- Editing anything inside `./video` or the variables file marks the scene
  `stale`, so `build` cannot silently reuse the previous take.

## Generating images with imagine

`profiles/imagine.yaml` wraps [imagine](https://github.com/talkincode/imagine):

```yaml
scenes:
  - id: s1
    duration: 6
    durationPolicy: exact
    impl:
      profile: imagine
      task: generate
      params:
        model: MAI-Image-2.6      # from `imagine models`; omit when only one model is configured
        prompt: 深夜律所走廊，一束光落在文件柜上，纪录片风格
        size: 1024x1536
    produces: { image: ./build/s1.png }
```

- `filmkit validate` runs the task with `--dry-run`, which prints the request body
  **without calling the API**: unknown models and bad flags cost nothing.
- `filmkit run s1` performs the real call. Credentials belong to imagine (its own
  config file or `IMAGINE_*` / `AZURE_OPENAI_APIKEY`); filmkit never stores or
  prints a key, and `doctor` only reports whether a *ready* model exists.
- Generated pixels are **not reproducible**: the same params give different
  images. The lock records the bytes you actually got, so re-running is a
  deliberate act, not something `build` does on its own.
- Exploring variants (`-n 4`, comparing models) is your job, not a node: run
  imagine directly, pick a winner, then point `produces.image` at it (or let the
  scene reference the chosen file with `filmkit/static`).
- `task: text` renders a styled text layer to a **transparent PNG** — the way to
  get text into a film when the local ffmpeg has no `drawtext`/libass (see the
  next section). It needs an imagine build with resvg support.

## Narration and subtitles (all local)

Two narration backends ship as Profiles; both are local, no cloud keys.

`profiles/qwentts.yaml` (Qwen3-TTS) is the richer one for Chinese: preset voices
with emotion control, voice cloning from a reference clip, and voice design from
a description. One node produces the narration:

```yaml
assets:
  voice:
    kind: audio
    impl:
      profile: qwentts
      task: speak
      params:
        text: "这件事，我们不急着下结论。先确认事实，再判断责任。"
        model: customvoice          # or base (clone from referenceAudio), voice-design
        voice: Serena               # Vivian, Uncle_Fu, Dylan, Eric, Ryan, Aiden, Sohee…
        emotionIntensity: low       # auto | flat | low | medium | high | extreme
        instruct: "亲切、稳定、专业，语气克制但有起伏"
        speed: 0.98
    produces: { audio: ./build/voice/s1.wav }
```

Cloning route: `model: base` with `referenceAudio` (a `./` path, or a file from a
voice library — the qwentts repo ships one sample under `skills/qwentts/speakers/`
and keeps personal libraries in its gitignored `myspeakers/`) and `refText` only
when you know the exact words — never invent it.
`qwen3-tts-ai` must be on PATH (symlink it from the qwentts repo) and its model
weights must be present. Setup is the tool's own — macOS + Apple Silicon,
`QWEN3_TTS_HOME` runtime, Hugging Face model downloads, and the repo ships the
Agent skill too (`npx skills add talkincode/qwentts`); the qwentts README has the
commands. `filmkit doctor` runs the tool's cheap `--print-models` check, which
proves the script runs and prints the resolved runtime/model paths, but cannot
see whether the weights exist, so a missing model surfaces at `filmkit run` with
the tool's own message.

`profiles/hyperframes.yaml` covers the whole chain (narration + transcription +
subtitles) with local models — three nodes, each one command, wired by `./`
paths:

```yaml
assets:
  voice:                                   # 1. text -> speech
    kind: audio
    impl: { profile: hyperframes, task: tts, params: { text: "深夜的律所走廊…", voice: zf_xiaobei, lang: zh } }
    produces: { audio: ./build/voice/s1.wav }
  transcript:                              # 2. speech -> word-level transcript
    kind: file
    impl: { profile: hyperframes, task: transcribe, params: { input: ./build/voice/s1.wav, dir: ./build/voice, language: zh, model: large-v3 } }
    produces: { file: ./build/voice/transcript.json }
  captions:                                # 3. transcript -> .srt
    kind: subtitle
    impl: { profile: hyperframes, task: subtitles, params: { transcript: ./build/voice/transcript.json } }
    produces: { subtitle: ./build/voice/s1.srt }

scenes:
  - id: s1
    durationPolicy: min        # the narration decides how long the scene lasts
    audio: voice               # this scene's narration comes from the asset above
    impl: { profile: filmkit/static, task: clip }
    produces: { image: ./assets/card.png }

timeline:
  tracks:
    - { id: subs, kind: subtitles, source: captions, mode: sidecar }
```

What to know:

- `scenes[].audio` names the narration asset (mutually exclusive with
  `produces.audio`) and makes the scene wait for it: `plan` shows the scene as
  `blocked` until the tts node has run.
- `subtitles.source: <asset>` uses a whole-film SRT on its own timeline; the
  default `source: scenes` instead collects per-scene SRTs and shifts them.
  Cues that run past the film are clipped and reported as build warnings.
- Chain staleness works through content: re-run the narration and the
  transcription node becomes `stale` (it reads the wav by `./` path).
- `tts` needs `kokoro-onnx` + `soundfile` in a venv (`HYPERFRAMES_PYTHON`), and
  `transcribe` needs whisper-cpp. Chinese needs `model: large-v3` — the default
  `small.en` turns Chinese speech into English gibberish. Both are reported by
  the tool with the exact fix when missing.
- `matte-image` cuts a background out of a still (PNG with alpha) for overlays
  and card scenes.

### Wrapping your own local tool

Nothing above is tool-specific: any command becomes a Profile. This is the shape
for a local wrapper that is not on `PATH` (the pattern, not a shipped profile —
bundled profiles must be reproducible by strangers):

```yaml
apiVersion: filmkit/v1alpha1
kind: Profile
metadata: { name: local-tts, version: "1" }
runtime:
  type: cli
  binary: python3            # or an absolute path to your wrapper
tasks:
  speak:
    paramsSchema: { type: object, required: [text, voice], properties: { text: { type: string }, voice: { type: string }, speed: { type: number } } }
    produces: [audio]
    invocation: ["$HOME/.local/bin/my-tts", "--text", "${params.text}", "--voice", "${params.voice}", "--out", "${produces.audio}"]
```

Swap `binary`/`invocation` for your command, keep `paramsSchema` closed, and
filmkit gives you validation, exit-code mapping, staleness and `plan` for free.

## Storyboard: proof every shot before you spend

Before the first paid generation — and again once every produce is in place,
before the final build — turn the film into a **Storyboard Sheet** and check
it shot by shot:

```bash
filmkit storyboard        # writes build/storyboard.json + build/storyboard.html
filmkit --json storyboard # the same JSON on stdout, byte-identical to the file
```

Two artifacts from one command:

- **`build/storyboard.json`** — the film as regular data: every shot with its
  timeline window, `status` (`ready|missing|partial|stale`) + `blocked`,
  `intent`, `params`, profile/task/executor, and for *every* file it touches a
  uniform `{kind, path, exists, href?}` entry (`href` relative to the HTML,
  present only when the file is there). Subtitle files are embedded as text so
  you can proof cues without opening them. It never writes the lock and never
  runs a tool.
- **`build/storyboard.html`** — a single self-contained page (inline CSS, no
  JS, no network): a proportional timeline strip, one card per shot with
  images previewed inline, audio/video played back through native controls,
  and missing produces shown as explicit placeholders — never a broken
  element. Open it with `file://`; it copies cleanly to anyone with the
  project directory.

**Confirmation protocol — default is to confirm:**

1. Generate the sheet and walk the user through it **shot by shot** — order
   and durations on the strip, then per shot: does `intent` say what the shot
   is for, are `params` the values we want to send (prompt, model, size/ratio,
   duration), does existing media preview/play correctly, what is still a
   placeholder. For paid Profiles this *is* the param confirmation from
   "Cost discipline": the sheet shows node id, params and cost drivers in one
   place.
2. Wait for the user's go-ahead before the first paid run. Editing after a run
   means repurchasing (see below), so disagreements are cheapest to catch here.
3. **If the user explicitly says not to ask** ("不用确认 / don't wait for me"):
   do the same review *yourself* against the sheet — check every shot's
   intent, params and timeline, and state briefly what you verified — then
   proceed without waiting. Confirmation waived, review not waived.
4. Either way, **keep `build/storyboard.html` regenerated** (re-run
   `filmkit storyboard` after each production round and before the final
   build): it is the artifact a human opens later to preview what was made,
   whether or not they were asked in the moment.

The sheet reflects the files on disk at generation time — a shot that turned
`ready` after your last run only previews correctly once you re-run
`filmkit storyboard`. It is a review artifact: never hand-edit it, and never
treat a stale sheet as current state (`filmkit status` owns that truth).

## Cost discipline: confirm params, plan paths, never re-buy

Some Profiles spend money per run — `seedance`, `gemini-omni`,
`imagine generate`, any `runtime.type: http`. Everything else (ffmpeg,
scorekit, qwentts, HyperFrames, Remotion, static files) is local and free.
Three code facts decide what a run costs:

- `plan` lists only nodes that are not `ready` — a produced node with
  unchanged params never reappears in the work order.
- `filmkit run <id>` executes a `missing` / `partial` / `stale` http node, but
  **refuses a `ready` http node without `--force`**: handing it a ready node
  exits `2` before any provider request, with no file or lock changes. Cost is
  unknown from the Profile, so every re-execution counts as a new purchase —
  pass `filmkit run <id> --force` only to authorize it explicitly. Local `cli`
  nodes stay re-runnable (free and idempotent).
- Staleness is content-based: editing `impl.params`, or the bytes of any
  `./` path inside them (`props`, `variables`, `firstFrame`, a prompt file),
  marks the node `stale`; a non-ready node in turn marks everything
  downstream of it `blocked`.

Therefore, while orchestrating:

1. **Confirm generation params before the first paid run.** Show the user
   the node id, model, duration, ratio/size and final prompt, and get the
   go-ahead: params are free to edit until the first run and a repurchase
   after it. The Storyboard Sheet (see "Storyboard: proof every shot before
   you spend" above) is the natural place for this: `filmkit storyboard`
   puts every shot's `params` next to its `intent` on one reviewable page —
   confirmed with the user, or reviewed by you when they have waived
   confirmation. Duration and model drive the cost; a wrong ratio wastes the
   whole call. `filmkit validate` is free and, where the Profile declares
   it, delegates to the tool's own dry-run (imagine prints the request body
   without calling the API) — use it until the request shape is certainly
   right.
2. **Run only what `plan` lists.** Never re-run a node to “check it
   worked”, to refresh a file, or because the output looked odd — inspect
   first (`filmkit status`), then decide with the user and re-run
   deliberately. For a `ready` http node that means an explicit second
   purchase: `filmkit run <id> --force`, after the user agrees to spend again.
3. **Order the film cheap → expensive.** Settle durations, edit points,
   narration, music cues and stills while everything is local; freeze the
   timeline before the first paid video generation. An upstream edit after
   that marks downstream paid nodes stale and produces them again.
4. **Plan `produces` paths before producing.** One predictable root per
   node (`./build/<node-id>/…`), unique across the film (`validate`
   enforces this) and never a directory a sibling tool rewrites wholesale.
   Stable paths keep paid files resumable across sessions, make overwrite
   hazards visible in review, and turn `plan`'s `produces:` lists into a
   literal cost inventory: every listed path that does not exist yet is
   work somebody still has to pay for.
5. **Verify the first paid node before batching the rest.** Check duration,
   ratio and content of the first returned file; a systematic mistake
   caught after one node costs one node, not the whole film.
6. **filmkit never retries a failed run.** Each retry is a deliberate second
   purchase — and after a network-level failure of an async API, check
   whether the remote task already completed before asking again.

## Generating video with an API (Seedance, Gemini Omni)

Two Profiles call a generation API directly — `filmkit run` performs the request,
waits for an async task when the provider needs one, and writes the file:

```yaml
scenes:
  - id: s1
    duration: 5
    durationPolicy: min
    impl:
      profile: seedance            # or gemini-omni
      task: text-to-video
      params:
        model: doubao-seedance-1-0-pro-250528
        prompt: 一名侦探走进昏暗的房间，镜头缓慢推进
        ratio: "16:9"
        duration: 5
    produces: { video: ./build/s1.mp4 }
```

- Keys are environment variables the Profile names: `ARK_API_KEY` for Seedance,
  `GEMINI_API_KEY` for Gemini Omni. `filmkit doctor` says whether they are set and
  never prints them; `run` reads them in a worker process, so they do not appear
  in `ps`, logs, the lock file or any output. Never paste a key into a film.
- Every run costs money and takes tens of seconds — confirm `params` with
  the user before the first run and follow "Cost discipline" above. Prefer a
  draft resolution while iterating, and keep prompts specific about camera
  movement and subject motion — vague prompts give weak video.
- Image-to-video: Gemini Omni takes `firstFrame` / `lastFrame` as `./` paths and
  sends their bytes inline; Seedance takes `image: https://…` and fetches it
  itself, so that URL must be publicly reachable (filmkit uploads nothing).
- These are the only Profiles that need a network key. Everything else
  (`ffmpeg`, `scorekit`, `qwentts`, HyperFrames, Remotion) stays local.
- If the provider's response shape changes, `filmkit run` reports what actually
  came back — fix the path in the Profile (`http.output`) rather than guessing.

## Text cards and captions without ffmpeg's drawtext

Two patterns, both just existing filmkit features:

**A text card as a scene** — the PNG is the scene's picture, so the card holds
for the scene's duration and the film's `output.background` shows through:

```yaml
scenes:
  - id: card
    duration: 2.5
    durationPolicy: exact
    impl:
      profile: imagine
      task: text
      params:
        text: "深夜律所走廊\n源头，是内鬼"   # literal \n is a line break
        width: 640
        font: PingFang SC                     # a real font family; CJK needs one that has the glyphs
        size: 52
        color: "#ffffff"
        stroke: "#0b1729"
        strokeWidth: 3
        align: center
        lineHeight: 1.5
        padding: 24
    produces: { image: ./build/txt/card.png }
output:
  background: "0x0b1729"                      # transparent areas composite onto this
```

**Text over footage** — a generated asset used by an overlay track, with a time
window, position, width and opacity:

```yaml
assets:
  lower-third:
    kind: image
    impl: { profile: imagine, task: text, params: { text: "源头，是内鬼｜第 2 集", width: 640, font: PingFang SC, size: 34, align: left, padding: 12 } }
    produces: { image: ./build/txt/lower-third.png }
timeline:
  tracks:
    - { id: lower, kind: overlay, asset: lower-third, position: bottom-left, margin: 24, width: 520, opacity: 0.95, from: 0.4, to: 4.8 }
```

Notes that save a round trip:

- Prerequisite: `imagine text render` needs a resvg-enabled build
  (`zig build -Dsvg-overlay=true`; macOS: `brew install zig resvg`). The shipped
  profile header has the exact commands. Without it the task fails with the
  tool's own advice — `generate` keeps working.
- The PNG's height is derived from the text; multi-line CJK text can come out
  slightly clipped, so add `padding`, lower `size`, or check the PNG once.
- Transparent pictures composite onto `output.background` (a card scene), so
  pick a background that suits the cards; opaque images keep the plain
  scale+pad path.
- Burned *subtitles* (many cues, per-cue timing) are not implemented: render one
  PNG per cue with this task and declare one overlay track per cue with its
  `from`/`to`, or move the captions into a HyperFrames/Remotion segment.

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

- Ready-made Profiles ship in the filmkit repository and are meant to be copied
  into your project (`./profiles/<name>.yaml`): `hyperframes`, `remotion`,
  `imagine`, `scorekit`, `qwentts`. Each header documents the layout it assumes (mostly a
  `./video` project directory) and what it refuses to do.
- `runtime.healthcheckExpect: { select?, where?, path, equals }` asserts on the
  healthcheck's JSON output — for tools that exit 0 even when they cannot work
  (`imagine models --json` with no ready model; `hyperframes doctor --json`,
  whose `ok` also covers optional features). `select` reaches a nested array,
  `where` picks the one element to assert on.
- `exitCodes` is what decides how a failing `validate` template is classified:
  a validator that exits 1 for "bad input" must declare `"1": invalid-input`,
  otherwise its failure is reported as a tool failure.
- `runtime.type: cli` gives filmkit three knobs beyond `invocation`:
  `tasks[].cwd` (run the tool inside its own project directory),
  `runtime.healthcheckCwd` (check a tool that lives inside that directory), and
  `${params.x?}` (drop an argv element when the param is absent — this is how
  optional flags are exposed without conditionals).
- `runtime.type: cli` + `invocation` → `filmkit run <id>` executes it, as does
  `runtime.type: http` + `http` (a declared API call; a `ready` node needs
  `filmkit run <id> --force` to re-spend). Anything else (`skill`, `mcp`) is
  yours to execute; `plan` says `executor: agent`.
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
- Do not run a node `plan` did not list: a `ready` http node run by hand is
  refused without `--force` (`filmkit run <id> --force`), because it would
  repeat a paid API call with unknown cost.
- Do not silently edit a produced node's `impl.params` (or a file they
  reference): it turns the node `stale`, blocks its dependents, and
  producing them again costs money — surface it to the user first.

## Command reference

| Command | What it does |
| --- | --- |
| `filmkit init [dir]` | Skeleton project; refuses a non-empty directory |
| `filmkit schema [--profile\|--lock]` | JSON Schema of Film / Profile / Lock |
| `filmkit validate [--no-delegate]` | Schema + references + timeline + Profile paramsSchema (+ tool `validate`) |
| `plan` | Work order (nodes not ready, topological order) |
| `filmkit storyboard` | Storyboard Sheet: `build/storyboard.json` + reviewable `build/storyboard.html` |
| `filmkit run <id> [--force]` | Execute one cli or http node; records result in the lock. A `ready` http node needs `--force` to re-spend |
| `filmkit build [--draft] [--dry-run]` | Normalize, compose, verify; `--dry-run` only writes `build/compose.filtergraph.txt` |
| `filmkit status` | Observe produces, write lock, report |
| `filmkit doctor` | Environment + Profile requirements |
| `filmkit import hyperstory <schema.json> [--out <path>] [--force]` | Convert a Hyperstory schema into a new filmkit.yaml |

Global options: `--version`, `--film <path>` (default `./filmkit.yaml`), `--json`.
Exit codes: `0` ok · `1` io · `2` invalid input · `3` missing dependency · `4` external tool failure.
