# Changelog

Notable changes per release. The protocol version (`filmkit/v1alpha1`) is separate
from the package version: the package may add Profiles and commands without
changing the protocol.

## Unreleased

- **Deprecate and remove `filmkit import hyperstory`.** The legacy Hyperstory Video Composition
  Schema importer has been removed in favour of `filmkit import script` and standard filmkit
  orchestration. Invoking `filmkit import hyperstory` now fails with exit code 2 (`invalid-input`)
  and a helpful hint pointing to `script`.
- **`colab-comfy`: 3:4 / 4:3 sizes.** `h3-ref2va` now also accepts `resolution: 768x1024` and
  `1024x768` (Profile enum and `RESOLUTIONS` in `tools/colab-comfy/src/job.ts`; a test keeps the two
  lists identical). Both fit the pixel·frame cap at every allowed duration; CU is estimated with the
  existing pixel-proportional formula (EP04 13 clips at 768×1024: A100 1.85 dense / 1.74 VSA 0.75).

## 0.4.0 — colab-comfy: batched H3 Ref2VA on Colab GPUs with a hard CU budget

- **`colab-comfy` profile + helper (no change to `src/`).** `profiles/colab-comfy.yaml`
  (`h3-ref2va`: MiniMax H3 Ref2VA with an optional VSA sparsity gate) runs fixed ComfyUI
  API workflows on a Google Colab GPU. Because a Colab session is expensive to open, batching,
  sessions and cost live in a standalone helper, `tools/colab-comfy/` (Bun/TypeScript + a
  stdlib-only Python payload for the VM), and filmkit still only runs one node at a time:
  `colab-comfy batch` estimates CU, applies a hard budget gate (`--yes`, `--budget`), runs
  **one** session for every pending node, downloads each clip into `.colab-comfy/cache`,
  always stops and verifies the session (four layers: `finally`/signals, detached guard, VM
  watchdog, `reap`), then `filmkit run <id>` materializes each node from the cache for free and
  writes the lock. `produces.file` carries a deterministic run record (seed, hashes, pinned
  ComfyUI/node commits and weight revisions, GPU, CU). Also `colab-comfy doctor` (the Profile's
  healthcheck), `cache ls|prune`, and `reap`. Tested against a fake `colab` shim and a mock
  ComfyUI; `scripts/e2e-colab-comfy.sh` is the real run (spends ~0.8 CU, refuses without
  `--yes`). Roadmap feature 26; operating rules and the verified `colab` 0.7.4 CLI surface in
  `tools/colab-comfy/README.md`. Repo plumbing: `tools/` added to `tsconfig.json`,
  `package.json` `files` and `check:tracked`.
- **`colab-comfy`: GPU choice, real-rate budget guard, settled cost (since the first cut above).**
  `--gpu auto` is the new default: it estimates **L4** and **A100** only (never H100, never
  high-mem) and opens the cheaper one (ties → L4; A100 wins from ~5–6 portrait clips); an explicit
  `--gpu L4` / `--gpu A100` is honoured as given, A100 needs `--yes`, and `--rate` with `auto` is
  refused. If the A100 is unavailable at `colab new`, the helper falls back to L4 only when the L4
  estimate also fits `--budget` and `colab sessions` shows nothing left over (logged, recorded as
  `gpuFallback`; still exactly one session). Right after `new`, the live `Usage rate` from
  `colab usage` re-projects the estimate (abort before upload if it no longer fits) and moves the
  deadline, which the detached guard re-reads from `active.json`. After the verified stop the
  balance is polled until it settles (two equal, plausible readings; 30 s interval, 210 s max);
  otherwise the actual CU is recorded as provisional (`usageSettled: false` in the session result,
  ledger, clip cost and run record).
- **`colab-comfy`: calibrated estimates (`estimates.json` → `colab-comfy/estimates@2`).** Per-GPU
  rate, startup, first load, per-clip init, warm time per variant and teardown, fitted to real
  runs; the 1.2 safety margin stays. L4 1.71 CU/h (EP03 3 clips ≈ 0.74 CU), A100 5.30 CU/h (one
  clip ≈ 0.63 CU instead of the old ~1.8). Uncalibrated GPUs use the L4 timings and need `--rate`
  plus `--yes`.
- **`colab-comfy`: validated on real Colab hardware.** M8 real run (EP03 test film, L4, 3/3 clips
  704×1280, estimate 0.75 → actual 0.51 CU, stop verified by an independent `colab sessions`, re-run
  free and lock byte-identical) and a one-shot A100-SXM4-40GB benchmark (0.60 CU settled). Fixes from
  it: the `hf` CLI is resolved next to `sys.executable`, e2e `colab` calls get a host timeout, the
  fake `colab` kills the VM runner on stop (flaky E3/E5), Python bytecode is never committed.
- **Skill: plan a publishing cover.** When a video is prepared for publication, the filmkit skill
  now plans a separate platform cover/thumbnail (`assets.cover`), distinct from an opening title
  card; `build` does not create it, and delivery is not publish-ready without it.

## 0.3.0 — storyboard review sheet, knowledge-video batch, ffmpeg 8+ builds

- **构建传图改走内联 `-filter_complex`。** ffmpeg 8+ 移除了 `-filter_complex_script`，三处组 argv（场景片段、垫片、合成）改传内联 filtergraph；执行走 argv 数组，无 shell 转义问题。`build/*.filter` 文件与 `compose.filtergraph.txt` 照常写出，前者现为纯调试产物。确定性、原子落位与退出码契约不变。
- **知识视频包：章节、旁白避让、烧录字幕、`import script`。** `timeline.chapters`（`{ title, scene | start }`）经 `build/chapters.txt`（ffmetadata，确定性）以 `-map_chapters` 注入成片并由 ffprobe 校验；音频轨 `duck: { amount }` 以主轨混音为 sidechain 做旁白避让（`amount` 为干湿比，0 关闭）；字幕轨 `mode: burn` 经 libass 烧进画面（sidecar 照常写出供校对，缺 libass 时 `doctor` 报告、`build` 以退出 3 在执行前失败）；`filmkit import script <notes.md>` 把口播稿 markdown（`#` 标题 + `##` 小节 + 首图）转为可直接 `plan` 的 filmkit.yaml（字符数估时长、`durationPolicy: min`、缺图占位）。协议见 spec §1.8.3 / §2.6 / §5 / §9，矩阵见 roadmap 功能 22–25。
- **`filmkit run` 付费重放保护（`runtime.type: http`）。** 已 `ready`（产物在位且 `impl.params` 未变）的 http 节点再次 `filmkit run <id>` 不再静默重调供应商：默认退出 `2`，不发起任何请求、不写产物、不写 lock，错误明示费用未知并要求 `--force`（`filmkit run <id> --force`）作为第二次购买的显式授权。`missing` / `partial` / `stale` 仍可直接执行（`plan` 列出即待办）；本地 `cli` 节点不受限。规范见 `docs/spec.md` §3.5 / §6，纪律见 skill "Cost discipline"。
- **`filmkit storyboard` — the Storyboard Sheet.** Before the first paid
  generation (and again before the final build), derive the film plus current
  produces into a regular JSON document (`build/storyboard.json`) and render it
  through a built-in template into a static single-file review sheet
  (`build/storyboard.html`): a proportional timeline strip, one card per shot
  with status/blocked stamps, intent, params and executor, inline image
  previews, native audio/video playback, embedded subtitle text, and explicit
  placeholders for every produce that does not exist yet. URLs stay relative,
  so the sheet opens from `file://` and travels with the project.
- The command observes only: it never runs a tool, never delegates task
  `validate`, never writes the lock, and carries no timestamps — same film and
  same produces give byte-identical output (spec §6.3). Both artifacts are
  rendered in memory first, then written via `.tmp` + rename, so a failure
  leaves the previous sheet intact and no litter.
- Skill: a storyboard gate now sits in the core loop between `plan` and
  producing. Default protocol is shot-by-shot confirmation with the user on
  the sheet; if the user explicitly waives confirmation, the agent reviews
  every shot against the sheet itself and proceeds — but the HTML is always
  kept regenerated so a human can preview later either way.
- Iron rule sharpened (AGENTS.md, roadmap): previews/reviews are *files*
  (`build --draft`, `storyboard`'s static HTML) — no GUI, no server, no JS in
  the artifact; anything that wants to become editable or hosted is a
  violation.

## 0.2.0 — declarative video generation APIs

**Video generation APIs, built in and declarative.** `filmkit run` now executes
`runtime.type: http` Profiles: a request, an optional poll loop for async APIs,
and where the file comes from — all declared in the Profile, with no provider
field or provider branch anywhere in filmkit's code (spec §3.5).

- Two Profiles ship: `seedance` (Volcengine Ark, async task + poll + download)
  and `gemini-omni` (Google Interactions API, synchronous, video returned inline
  as base64).
- Keys come from the environment by name only (`ARK_API_KEY`,
  `GEMINI_API_KEY`): `doctor` reports whether they are set, the worker process
  reads them, and they never reach an argv, a log line, the lock file or any
  output.
- Placeholders stay static: `${env.NAME}`, `${params.x?}`, `${inputs.id}`,
  `${create.<path>}` (values from the previous response), plus `${base64:...}`
  and `${mimeType:...}` for APIs that want file bytes inline. An unset `?`
  placeholder drops its key or array element, so an optional first frame simply
  does not appear in the request.
- Failures map to the documented exit codes (401/403 → 3, 4xx → 2, 429/5xx and
  network errors → 4); polling waits for one task to finish and never retries a
  failed request; the file lands atomically via a `.part` file.
- Skill: mandatory pre-flight — `filmkit doctor` runs before any work, and a
  non-green report must be relayed to the user as *what is missing / what it
  blocks in this film / the options*, never worked around silently. New
  "Cost discipline" section for paid generation: confirm params before the
  first paid run, run only what `plan` lists (`run` does not check status),
  order the film cheap → expensive, plan `produces` paths before producing.
- `isOnPath` scans the live PATH instead of `Bun.which`, which answers from the
  snapshot taken at process start: tools added to PATH after startup (how the
  test suite installs its stubs) were invisible, and a dev machine that had
  the real tool installed masked the miss — clean CI runners failed `doctor`
  tests for binaries that were never there.
- Release engineering: pushing a `v*.*.*` tag drives a GitHub Actions workflow
  — consistency checks + the full test suite, a versioned source payload with
  `checksums.txt`, build-provenance attestation, the GitHub Release, and a
  rendered Homebrew formula pushed to `talkincode/homebrew-tap`
  (`brew install talkincode/tap/filmkit`).
- Verified with a real local HTTP server in tests (both shapes) and one real
  Gemini call that corrected the Profile (the API requires `model` explicitly).
  `scripts/e2e-video-apis.sh` runs a keyed smoke test and prints the raw response
  when a shape does not match.

## 0.1.0 — first release

The first usable version: a `filmkit.yaml` orchestration file, a compiler that
validates it and plans work, a `run` for command-line tools, and a `build` that
composes the film with ffmpeg. Everything below was verified against real tools
(`ffmpeg`, `scorekit`, `Remotion`, `HyperFrames`, `imagine`, `qwentts`).

**Protocol** ([docs/spec.md](docs/spec.md))

- Three documents: `kind: Film` (scenes, timeline, output spec), `kind: Profile`
  (tool capability registration), `kind: Lock` (what was actually produced).
  Core schemas reject unknown fields; free-form data lives in
  `metadata.annotations` and `impl.params`.
- Timeline is derived, not hand-written: scene starts come from the previous
  scene's end and its transition; `durationPolicy` (`auto` / `exact` / `min`)
  reconciles planned and actual lengths; overlay, audio and subtitle tracks span
  the film.
- `${vars.x}` is the only substitution in a film; Profile argv templates add
  `${params.x?}`, `${produces.*}`, `${inputs.*}` and a declared, enumerated
  `flags` array for valueless tool switches.
- Determinism: the same film and the same produces give a byte-identical
  `build/compose.filtergraph.txt`; failures never leave a partial film or a
  changed lock.

**Commands** — `init`, `schema`, `validate`, `plan`, `run`, `build`
(`--draft`, `--dry-run`), `status`, `doctor`, `import hyperstory`, plus
`--version`. Every command supports `--json` (errors carry `field` and YAML line)
and exit codes `0` ok / `1` io / `2` invalid input / `3` missing dependency /
`4` external tool failure.

**Composition** — normalize every produce to the output spec, cut/crossfade
along the timeline, mix audio and overlay tracks (including alpha pictures onto
`output.background`), merge subtitles (per-scene or whole-film), verify the film
with ffprobe, and record it in the lock.

**Profiles shipped** (copy into a project and reference as `./profiles/<name>.yaml`)

| Profile | Covers |
| --- | --- |
| `filmkit/static`, `filmkit/ffmpeg` (built in) | files placed by hand; a generic ffmpeg invocation |
| `hyperframes` | `render` a composition, `check` as the content gate, plus local `tts`, `transcribe`, `subtitles` and `matte-image` |
| `remotion` | `render` a composition (project cwd, props hand-off), `still` for a frame |
| `imagine` | `generate` an image (with a free `--dry-run` pre-flight), `text` for text cards |
| `qwentts` | Chinese narration: preset voices with emotion, reference-audio cloning, voice design |
| `scorekit` | compile a scene DSL into music, with `fit: exact` cue checking against the picture cuts |

**Reserved for later** (the schema accepts them and `validate` refuses them with
a clear message): `tracks[].stems`, subtitle `mode: burn`, `profiles[].source`,
and an MCP surface.

**Known boundaries**: ffmpeg/ffprobe and Bun are hard requirements; every other
tool is optional and reported by `doctor`. Image generation is not reproducible
(the lock records the bytes you got). `qwentts` runs on macOS + Apple Silicon
only. Nothing downloads models or media behind your back.
