# colab-comfy

Run fixed ComfyUI API workflows on a Google Colab GPU (L4 by default) as ordinary filmkit nodes.
First template: **MiniMax H3 Ref2VA** (reference image(s) + prompt → video with audio), with an optional **VSA gate**
(sparsity 0.5 / 0.75).

`colab-comfy` is a standalone Bun/TypeScript helper plus a small Python payload that runs inside the Colab VM
(standard library only). It is **not** part of filmkit core: nothing under `src/` knows about Colab, ComfyUI, sessions
or CU. filmkit only sees `profiles/colab-comfy.yaml`, a plain `runtime.type: cli` Profile.

Why a helper and not core: a Colab session costs ~8 minutes of setup, so many clips must share one session, while
filmkit runs one node at a time (`AGENTS.md`: no scheduling, no cost estimation in core). Batching, sessions and cost
live here; filmkit keeps its own rules.

## Install

```bash
bun install                                              # in the filmkit repo
ln -sf "$PWD/tools/colab-comfy/bin/colab-comfy.ts" ~/.local/bin/colab-comfy
colab-comfy doctor                                       # ready? (see below)
cp profiles/colab-comfy.yaml <project>/profiles/         # then: profiles: [{ ref: ./profiles/colab-comfy.yaml }]
echo ".colab-comfy/" >> <project>/.gitignore            # clip cache, ledger and session transcripts live there
```

Requirements: the `colab` CLI (verified against 0.7.4) authenticated with Application Default Credentials
(`colab --auth adc sessions` must work), `bun`, `tar`, ffmpeg/ffprobe (filmkit's own dependency). Python is needed only
by the tests that run the VM scripts locally.

`.colab-comfy/` is **project-local state** and should be gitignored in user projects:
`cache/<k2>/<key>/{clip.mp4,meta.json}` (generated clips; each cost CU), `ledger.jsonl`, `sessions/<name>.json`,
`active.json` (exists only while a session might be alive), `batch.lock`.

## Two-phase flow

```
filmkit plan ──► colab-comfy batch ──► filmkit run <id> (×N) ──► filmkit build
                 (spends CU, one session)   (free: copies from the cache, writes the lock)
```

1. **`colab-comfy batch --film filmkit.yaml [--yes] [--budget CU]`** reads `filmkit plan --json`, selects every pending
   `colab-comfy` node, estimates CU, applies the gate, opens **one** session, generates every clip, downloads each as soon
   as it finishes, **always** stops the session and verifies it is gone, writes the ledger, then runs `filmkit run <id>`
   for each node. Those runs are cache hits and cost nothing; they are what writes the produce files and the lock.
2. **`filmkit run <id>`** invokes `colab-comfy materialize`: a local copy from the cache into `produces.video` plus a
   deterministic run record in `produces.file` (seed, workflow/template hashes, ComfyUI + node commits, weight
   revisions, GPU, CU). On a cache miss it refuses with exit 5 (filmkit maps it to `invalid-input`, like its own paid
   replay guard); `COLAB_COMFY_YES=1 filmkit run <id>` instead runs a batch of one under the same budget gate.

Re-running costs nothing: ready nodes never appear in `plan`, and the cache key is a hash of the resolved workflow, so a
node that did not change is never regenerated. Changing the prompt, seed, duration, resolution, sparsity or a
reference image makes the key (and the node) stale; changing only `pick` re-materializes for free.

### Candidates

`candidates: N` makes the batch render seeds `seed … seed+N-1`. The batch reports `needs-pick` with the cache paths of
every candidate. Review them, set `pick: k` in `filmkit.yaml` (a human or the agent decides — the tool never picks), then
`filmkit run <id>`. Losing candidates stay in the cache until `colab-comfy cache prune --keep-referenced`.

### Commands

```
colab-comfy validate <job flags> --out P --record R   offline, free; the Profile's delegated validate
colab-comfy batch --estimate [--film F]               CU estimate + gate; makes no colab call at all
colab-comfy batch [--yes] [--budget CU] [--gpu L4] [--rate CU_PER_H] [--max-wall SEC] [--nodes a,b] [--no-materialize] [--json]
colab-comfy materialize <job flags> --out P --record R   used by `filmkit run`
colab-comfy reap [--dry-run]                          stop OUR leaked fk-* sessions (never anyone else's)
colab-comfy doctor [--json]                           { ready, checks[] }
colab-comfy cache ls | prune --keep-referenced | prune --yes [--dry-run]
colab-comfy guard …                                   internal: the detached watchdog started by batch
```

Exit codes: `0` ok, `1` io, `2` invalid input (including `needs-pick`), `3` missing dependency (no `colab`, auth failure,
a foreign session is active), `4` tool failure (Colab/ComfyUI failure, a job failed, `SESSION_LEAK`), `5` needs
confirmation (budget / batch / cache-miss spend), `130` / `143` interrupted (the session was still stopped).

### doctor

`colab-comfy doctor --json` → `{ ready, checks: [...] }`; exit 0 when ready, 3 otherwise. Read-only and free (it never opens a
session). Checks: `colab-on-path`, `colab-version` (`colab version`), `colab-auth` (the probe `colab --auth adc sessions`
succeeds), `leftover-sessions` (**warning only**: lists active `fk-*` sessions, fix with `colab-comfy reap`), `templates`
(the template and its manifest load and are consistent). The Profile declares
`healthcheck: [colab-comfy, doctor, --json]` with `healthcheckExpect: {path: ready, equals: true}`, so
`filmkit doctor` in a project that references the Profile reports it and exits 3 when it is not ready.

### cache

`cache ls` lists entries (node, candidate, seed, size, which lock node references it). "Referenced" means the entry is the
winner of a run record that `filmkit.lock.yaml` lists under a node's `produces`. `cache prune --keep-referenced` removes
everything else (losing candidates, clips of superseded prompts, incomplete downloads). Bare `prune` would delete clips that
each cost CU, so it needs `--yes`. `--dry-run` previews. Prune is refused while `active.json` exists.

## Operating rules (from the Colab skill; enforced by the helper where code can enforce them)

- **Stop when done.** Every session is stopped in a `finally`, after failures, and on SIGINT/SIGTERM/SIGHUP; then
  `colab sessions` must no longer list it (`colab stop`'s exit code is not evidence). A session that is still listed after
  3 attempts is `SESSION_LEAK` (exit 4, loud). Never leave a session "for later": waiting for the user, a review or the next
  shot means stop first (models can be re-downloaded; an idle GPU burns CU).
- **One session at a time, one task at a time.** A foreign active session aborts the batch (exit 3) and is never touched.
  `batch.lock` prevents two batches per project.
- **Estimate CU first.** `batch` prints the estimate and refuses (exit 5) when a batch has more than one job without
  `--yes`, when the estimate exceeds the budget (default 1.0 CU; `--yes` does **not** raise it, only `--budget` does), or on
  a non-L4 GPU without `--yes` and an explicit `--rate`. Over 1 CU, batches and A100/H100 always need the user's
  confirmation: report the estimate, wait for approval, then pass `--yes`.
- **Never print tokens.** ADC stays on the host and is used only by `colab`. Every captured line goes through a redactor
  (OAuth/JWT/`Bearer`/`hf_…`/`colab-runtime-proxy-token=…` patterns). Secrets are never passed with `colab exec --env`
  (they would appear in tracebacks); an optional `HF_TOKEN` is uploaded as a 0600 file that the VM deletes after setup.
  `jobs.json`, `status.json`, records and the ledger contain none.
- **ADC auth.** `colab --auth adc …` (override with `COLAB_COMFY_AUTH`; `COLAB_CLI_CONFIG` → `colab --config`).
  Interactive OAuth is something only the user can do; the helper never fakes credentials.
- **Report.** After a real run, report: session name, start/end (Asia/Shanghai), GPU, CU used, **stop confirmed**.
  `scripts/e2e-colab-comfy.sh` prints exactly that.

### Four layers against a leaked session

1. In-process `try/finally` plus signal handlers (first signal: salvage ≤ 60 s then stop; second: stop now).
2. A detached guard process (`colab-comfy guard`) bound to the helper's pid and a deadline; it stops the session within
   two ticks of the helper being SIGKILLed.
3. A VM-side watchdog: idle TTL / hard deadline → `google.colab.runtime.unassign()` (verified in M0), with a
   `release.request` fallback that the next poll cell executes.
4. `colab-comfy reap` for a periodic sweep of leftover `fk-*` sessions recorded in `active.json`.

## CU estimate

```
CU = (startup + firstLoad + teardown + Σ_jobs( warm[variant] · scale + download )) / 3600 · rate · margin
scale = (w·h·frames) / (1344·768·124)
```

Coefficients live in `estimates.json` (calibrated from the proven Ref2VA kit's measurements):

| Coefficient | Value |
|---|---|
| startup (session + pip + 48 GB weights) | 480 s |
| first model load | 120 s |
| teardown | 120 s |
| download per clip | 10 s |
| warm generation at 1344×768×124: dense / VSA 0.75 / VSA 0.5 | 260 / 190 / 220 s |
| L4 rate | 1.7 CU/h |
| margin | 1.2 |

Frames are `5 + 17k ≥ ceil(duration · 24)`; width/height are multiples of 32.

| Example | Estimate |
|---|---|
| EP03 test: 3 clips (dense 107 f, VSA 0.75 141 f, VSA 0.5 141 f at 704×1280) | ≈ 0.77 CU |
| one clip (dense, 4 s, 704×1280) | ≈ 0.52 CU (the 12-minute fixed cost dominates) |

The rate of 1.7 is conservative (the reference session measured about 1.37 CU/h). `colab usage` reports the balance with
two decimals, so the actual CU per session has 0.01 resolution; per-clip `attributedCU` splits the session CU by
generation seconds. Each real run appends estimate-vs-actual to `ledger.jsonl` for recalibration.

## Verified CLI surface (colab 0.7.4, summary of `M0-FINDINGS.md`)

The helper's parsing and lifecycle rest on behaviour measured on a real session (CPU runtime, ≈0.01 CU), not on assumption:

- **No JSON output anywhere.** `sessions`, `status`, `usage`, `new` print human-readable lines prefixed `[colab]` /
  `[NAME]`; parsing is regex-tolerant and isolated in `src/colab.ts`. `usage` shows the balance with 2 decimals.
- **`colab exec` runs the file inside the session's IPython kernel; its exit code is always 0**, even on an exception or
  `sys.exit(7)`. Success is decided only by parsing an `FKSTATUS {json}` marker line from stdout.
- **`exec --timeout` is unreliable** (did not cut execution off). Every exec gets a host-side timeout; killing the local
  client leaves the CLI believing the session is BUSY and the next exec hangs, so on timeout the helper runs
  `colab restart-kernel` (recovered in 1 s). VM scripts sent through exec return in seconds; real work runs as a detached
  `setsid nohup` runner that survives `restart-kernel`, observed by short kick/poll cells.
- **`exec --env` prepends `os.environ[K]='V'` to the code** (visible in tracebacks) → never used for secrets.
- **upload/download:** single files only; return codes are meaningful. Upload into a missing remote directory fails with
  rc 1 and a 500 whose message contains the full runtime URL with `colab-runtime-proxy-token=…` → remote dirs are created
  first and redaction covers that token pattern. Download needs the local parent directory to exist.
- **stop is idempotent** (rc 0 and `Session 'NAME' not found.` for a missing session) → verification uses
  `colab sessions` (+ `usage` "Active assignments"), never stop's exit code. `new` returns once the runtime is READY.
- **Self-release works:** `google.colab.runtime.unassign()` from an exec'd cell released the VM within 10 s, which makes the
  VM-side watchdog real. No idle auto-stop is documented or was observed: do not rely on Colab reclaiming idle sessions.
- **Pins resolved without Colab** (`templates/h3-ref2va@1/manifest.json`): ComfyUI `Comfy-Org/ComfyUI` @ `ce1e922d…`,
  `Kablex/ComfyUI-Ref2VA-VSA` @ `323a0a5f…`, six weight files with HF revision, size and sha256 (48.28 GB total). Node
  constraints from source: `length` = 5 + 17k, width/height multiples of 32, refs 0-based `ref_image_0…`, output found at
  `history[pid].outputs[*].images[*]` with `metadata.kind == "video"`.

## Real run (M8, 2026-10-18, Asia/Shanghai)

`scripts/e2e-colab-comfy.sh <work> --refs /workspace/weila-ep03/h3/job --yes --budget 1.0` on the bot box (colab 0.7.4, ADC),
EP03 test film (s1a dense 107 f, s3a VSA 0.75 141 f, s4a VSA 0.5 124 f; all 704×1280). Result: **pass**, exit 0.

| Item | Value |
|---|---|
| Session | `fk-ep03-h3-test-202610180501`, L4 (driver 580.82.07, 23034 MiB), 13:01:21 → 13:22:15 CST |
| Stack | Python 3.13.15, torch 2.11.0+cu130, CUDA 13.0, comfy-kitchen 0.2.38; ComfyUI `ce1e922d…`, node `323a0a5f…` (pins verified); 6 weights size-verified |
| CU | estimate 0.75 → actual **0.51** (349.19 → 348.68; ratio 0.68, ≈1.46 CU/h effective) |
| Phases | `new` 4 s; setup 183 s (pip 31 s, 48 GB HF download 140 s); ComfyUI start ≈ 24 s; gen 1013 s; teardown 4 s |
| s1a dense 107 f | 318 s wall (incl. first TE/UNet/VAE load), sampler 4 × ~35 s/it, peak 22294 MiB |
| s3a VSA 0.75 141 f | 354 s wall, sampler 4 × ~36 s/it (+~80 s model re-init with the gate), peak 22326 MiB |
| s4a VSA 0.5 124 f | 340 s wall, sampler 4 × ~38 s/it (+~67 s re-init), peak 22278 MiB |
| Clips | 704×1280, 24 fps, h264 + aac; 4.458 / 5.875 / 5.167 s (trimmed to the scene by `durationPolicy: exact`) |
| Stop | helper: stop + `sessions` verified; independent `colab sessions` → none, `usage` → 0 active assignments |
| Re-run | second `batch --estimate` → nothing to generate; `filmkit run s1a` → lock byte-identical, no session |

Findings for recalibration (not applied yet; one data point):
- Setup is much faster than the 480 s assumed (≈ 225 s from `new` to the first submit).
- Each job re-initialises the model (~70–80 s) because the prompt/VSA patch changes, so "warm" generation at portrait
  704×1280 is ~320–355 s per clip, and VSA gave **no** speed-up over dense at this shape on L4 (all ~35–38 s/it).
- 3 of 41 `fk_poll.py` execs hit the 60 s host timeout during model loads; each was recovered by `restart-kernel` as
  designed (A2) and the next poll succeeded. A burst of 3 in a row would abort the batch as `session-lost`.

## Machine-readable schemas

`schema/run-record.schema.json` (the `produces.file` run record), `schema/jobs.schema.json` (host → VM `jobs.json`),
`schema/status.schema.json` (VM → host `status.json`, one `FKSTATUS` line per poll). Tests validate real documents
produced by the real code against them.

## Tests

```bash
bun test tools/colab-comfy        # unit + lifecycle: fake `colab` shim, real VM scripts (python3), mock ComfyUI
bun test tests/colab-comfy.test.ts  # filmkit-level E2E (validate/plan/run/status/build/doctor) with the shim
bash scripts/e2e-colab-comfy.sh   # REAL run, spends ~0.8 CU; refuses without --yes (see its header)
```

Nothing in `bun test` contacts Google, Hugging Face or GitHub, or spends anything.

## Residual risks

- **Host down *and* VM self-release failing** (e.g. `unassign()` not honoured from the detached runner): only Colab's own
  idle reclaim remains, which is undocumented. The VM watchdog also asks the next poll cell to unassign, but if the host is
  gone nobody polls. Report any such event to the user and run `colab-comfy reap` / `colab sessions` on the next opportunity.
- **Weight revisions in the manifest are the current `main` revisions at pin time** (the earlier test session downloaded HEAD
  without recording them). The first real run verifies sizes (set `verifySha256` for full hashes).
- **Not reproducible bit-for-bit:** generated pixels are not guaranteed identical across GPUs/driver versions. The lock records
  the actual bytes; the run record names GPU, driver, torch, CUDA and commits.
- **VSA at portrait resolution on L4 is untested** until the real EP03 run; an OOM there is a valid finding (recorded, the
  session still stops).
- **`colab usage` has 2-decimal resolution:** actual-CU numbers for sub-0.05 CU sessions are noisy.
- **EP03 used FL2VA** (first frame + driving audio); this template is Ref2VA, so it proves the pipeline and cost model, not lip-sync.
  An FL2VA template (`h3-fl2va@1`) is a follow-up.
- **Bypassing `filmkit run`** (writing produces by hand or from another script) leaves the node `stale` forever, because only
  `run` writes a fresh `paramsHash`. Always materialize through `filmkit run`.
