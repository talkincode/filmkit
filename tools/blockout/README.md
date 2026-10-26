# blockout

An **L0 white-model reference** from one small, explicit scene declaration: people and props as capsules and
primitives, a few walls, a keyframed camera — rendered by **Blender** or by **Three.js (via HyperFrames)** from the
*same* declaration.

A blockout is a **motion / blocking reference**: where people and the camera go, what hides what, who holds what, how
long it takes. It is **not an identity reference and not a first frame**, and every manifest says so
(`purpose.notFor: ["identity", "first-frame"]`).

`blockout` is a standalone Bun/TypeScript helper next to `colab-comfy` and `vflow-pull`. It is **not** part of filmkit
core: nothing under `src/` knows about it. filmkit only sees `profiles/blender.yaml` (a plain `runtime.type: cli`
Profile) and, for the Three.js engine, the existing `profiles/hyperframes.yaml`. No model, no credential, no LLM, no
network at render time. All video processing is ffmpeg; all rendering is Blender or HyperFrames' headless Chrome. The
only code of ours that touches pixels' *meaning* is the evaluator that decides where everything is at time `t`.

## Requirements and install

| need | for | notes |
| --- | --- | --- |
| `bun`, `ffmpeg`, `ffprobe` | everything | filmkit's own dependencies |
| Blender ≥ 5 | `--engine blender` | developed and verified with **5.2.3 LTS**; found via `--blender`, `BLOCKOUT_BLENDER`, `PATH`, `/Applications/Blender.app` |
| HyperFrames CLI + Chrome | `--engine three` | verified with **0.8.204** (`HYPERFRAMES_PIN` in `src/version.ts`); found via `--hyperframes`, `BLOCKOUT_HYPERFRAMES`, the project's or this tool's `node_modules`, `PATH` |

three.js itself is **vendored and pinned** in `vendor/three/` (0.181.2, MIT, sha256 in `VENDOR.json`, verified on every
use). Nothing is downloaded behind your back: a missing tool is exit `3` with where it looked and what to do.

```bash
bun install                                                       # in the filmkit repo (ajv)
ln -sf "$PWD/tools/blockout/bin/blockout.ts" ~/.local/bin/blockout
blockout doctor                                                   # which engines are ready, and why not
# the Three.js engine needs the pinned HyperFrames somewhere stable:
npm install --prefix ~/.local/share/blockout hyperframes@0.8.204
export BLOCKOUT_HYPERFRAMES=~/.local/share/blockout/node_modules/.bin/hyperframes
```

A path you name (`--blender`, `--hyperframes`, or their env vars) is the **only** candidate: if it does not work that is
an error, never a quiet switch to some other installation.

## Replay it (these are the commands `scripts/e2e-blockout.sh` runs)

```bash
S=tools/blockout/examples/handoff.json            # 3 s, 24 fps, 640x360: a camera move, a walk behind a partition, a mug handed over

blockout validate $S                                       # structure, references, ranges, camera sanity (+ warnings)
blockout validate $S --handoff                             # ... and the complete upstream binding (shot AND scene, variants) is present
blockout validate $S --engine blender --native             # ... and Blender opens the .blend generated from it
blockout validate $S --engine three --native               # ... and `hyperframes check` accepts the generated project
blockout eval $S --time 1.25                               # the evaluated state at an absolute time (JSON)
blockout check $S                                          # ground contact, held props, occlusion, framing, penetrations

blockout render $S --engine blender --out out/blender      # reference.mp4 overview.png keyframes/ source.tar.gz manifest.json
blockout render $S --engine three   --out out/three
blockout render $S --engine blender --out out/blender --force   # replace an existing bundle, all or nothing

blockout project $S --engine three --out video             # just the source project: an ordinary HyperFrames project
cd video && npm install && npx hyperframes check && npx hyperframes render --format png-sequence --fps 24 --output frames
```

Replaying from the **source archive** (what `source.tar.gz` is for):

```bash
mkdir -p replay && tar xzf out/blender/source.tar.gz -C replay
blender -b replay/source/blender/scene.blend -o //render/f_#### -a      # the plain Blender CLI render path
```

## The declaration (`blockout/v1alpha1`)

One JSON file, closed (unknown fields are rejected), validated against `schema/scene.schema.json`
(`blockout schema`) plus semantic checks. Errors carry `field` and `line`.

**Conventions** — world is right-handed, **Z up, meters**; `+X` right, `+Y` forward. Rotations are **degrees, Euler XYZ
in the extrinsic sense** (about the parent's X, then Y, then Z; `R = Rz·Ry·Rx`). A subject at `rot [0,0,0]` faces `+Y`;
`rot [0,0,90]` faces `-X`. A joint rotation is about the joint's own origin, in its parent's frame; for a limb hanging
down, **positive X swings it forward**. Time is **absolute**: frame `i` shows time `i/fps`, and the video has exactly
`durationFrames` frames. Keyframes sit on **integer frames**.

```jsonc
{
  "apiVersion": "blockout/v1alpha1", "kind": "BlockoutScene", "id": "counter-handoff",
  "binding": {                                   // what this stands in for upstream, pinned by revision
    "composition": { "id": "kitchen-story", "revision": "12" },
    "shot":        { "id": "s3-handoff",    "revision": "4" },        // at least one of shot | scene; both are allowed
    "scene":       { "id": "scene-kitchen", "revision": "6" },
    "environment": { "id": "kitchen", "revision": "2", "variant": "day" }   // id+revision together and/or variant
  },
  "timing": { "fps": 24, "durationFrames": 72 },
  "frame":  { "width": 640, "height": 360 },     // even numbers
  "environment": {
    "background": "#202020",
    "floor":  { "size": [10, 8] },                                      // the z = 0 slab
    "walls":  [{ "id": "wall-back", "from": [-5, 4], "to": [5, 4], "height": 2.6, "thickness": 0.15 }],
    "blocks": [{ "id": "partition", "shape": { "type": "box", "size": [1.6, 0.25, 2.2] }, "pos": [-0.2, -1.5, 1.1] }]
  },
  "subjects": [{
    "id": "ann", "binding": { "id": "char-ann", "revision": "7", "variant": "apron" },   // binding.id = the upstream id
    "kind": "humanoid", "height": 1.7,                                  // humanoid | capsule
    "keyframes": [
      { "frame": 0,  "pos": [-3.4, 0.3, 0], "rot": [0, 0, 0] },
      { "frame": 8,  "joints": { "shoulderR": [35, 0, 0], "elbowR": [50, 0, 0] } },
      { "frame": 14, "pos": [-3.4, 0.3, 0], "rot": [0, 0, -90], "interp": "smooth" }
    ]
  }],
  "props": [{
    "id": "mug", "binding": { "id": "prop-mug", "revision": "1", "variant": "default" },
    "shape": { "type": "cylinder", "radius": 0.04, "height": 0.1 },
    "keyframes": [{ "frame": 0, "pos": [-3.196, 0.737, 1.15] }],       // its own pose, when nobody holds it
    "attach": [{ "subject": "ann", "joint": "handR", "from": 8, "to": 55 },   // inclusive windows
               { "subject": "ben", "joint": "handR", "from": 56, "to": 71 }]
  }],
  "camera": { "sensorWidth": 36, "keyframes": [
    { "frame": 0,  "pos": [-1, -6.8, 1.6], "target": [-3, 0.6, 1.1], "focalLength": 40, "interp": "smooth" },
    { "frame": 71, "pos": [2.2, -6.2, 1.7], "target": [2, 0.2, 1.2], "focalLength": 55 }
  ]},
  "overview": { "frame": 0 },                                          // optional; default: auto-framed 3/4 view
  "stills": [0, 8, 26, 55, 71]                                         // optional; default: every declared keyframe frame
}
```

* **Shapes**: `box {size}`, `cylinder {radius,height}`, `sphere {radius}`, `capsule {radius,height}` (height includes both
  caps), all centered on their origin, axis along Z. `pos` of a block is its **center**.
* **Keyframes** are per-channel: a keyframe may set any of `pos`, `rot`, `joints.<name>` (camera: `pos`, `target`,
  `focalLength`, `roll`); each channel interpolates across the keyframes that set it, holds its first value before and its
  last after. `interp` (`linear` default, `hold`, `smooth` = smoothstep) describes the segment that **starts** at that
  keyframe. One keyframe per frame per list.
* **humanoid** is a fixed minimal capsule rig scaled by `height`: joints `spine neck shoulderL shoulderR elbowL elbowR hipL
  hipR kneeL kneeR`, attach points those plus `handL handR head`. At rest the feet touch `z = 0` and the head tops out at
  `height`. **capsule** is one capsule (`radius`, default `0.12·height`) plus a facing marker; no joints.
* **Camera**: look-at from `pos` to `target` with `roll`; horizontal sensor fit (`sensorWidth` mm), `focalLength` mm
  interpolated linearly. Looking straight up or down is an error, checked on **every frame**, not only on keyframes.
* **Binding**: `composition` (required), `shot` and/or `scene` (at least one, both allowed), `environment`
  (`id`+`revision` together and/or a `variant`), and each subject/prop's `binding` (`id` + `revision`, optional `variant`).
  `revision` is an opaque string (vflow's integer revisions are written as decimal strings, e.g. `"12"`). All of it is
  copied into the manifest; blockout never resolves it. A pure-geometry scene may stop at composition + shot. **A hand-off
  to an upstream system needs them all**: `blockout validate --handoff` / `render --handoff` fail (exit 2, one error per
  missing field, before any work) unless the declaration carries composition, shot **and** scene, `environment.variant`,
  and a `variant` on every subject and prop; without the flag the manifest still says what is missing
  (`handoff.complete`, `handoff.missing`).
* **attach**: while a window is active the prop is placed in the held joint's frame (`offset`, `rot`); outside it the
  prop follows its own keyframes. The analysis reports the jump where the rule changes.
* Every subject gets a dark disc on the floor (`shadow: false` to drop it): where a person stands is readable even when
  they step behind something.

## Time evaluation is the contract

`runtime/blockout-core.js` is dependency-free and is the only code that knows what a declaration *means*: it compiles the
declaration and `evaluate(compiled, t)` returns, for absolute time `t`, the camera, every node's `(position, quaternion)`
and each subject's joint/hand frames. It is a **pure function of `(scene, t)`**: no state, no clock, no randomness, so
seeking anywhere, in any order, gives the same answer (`blockout eval --time/--frame` prints it; unit tests shuffle and
repeat). `t = i/fps` is snapped so frame `i` is exactly integer frame `i`; sub-frame times interpolate.

Both engines are **appliers** of that result:

* **Three.js**: the project ships a byte-for-byte copy of `blockout-core.js` and `blockout-three.js`, which on every
  `hf-seek` evaluates `t` and sets mesh transforms. No GSAP timeline, no `requestAnimationFrame`, no clock.
* **Blender**: Bun runs the same evaluator for every frame and writes `bake.json` (meshes, colors, per-frame poses,
  camera). The Python inside Blender (`runtime/blender/*.py`, native on purpose: it is the only language Blender
  speaks) just creates objects and keys what the bake lists, linearly. It contains no scene logic.

Meshes come from the same generator in the core too, so both engines draw the same triangles.

## Output bundle

`render` writes beside each other, in `--out DIR` (or `--video F --manifest G` in one directory):

```
reference.mp4            H.264 yuv420p, BT.709 tagged, exactly durationFrames frames at the declared fps
overview.png             layout still: set, subjects at overview.frame, ground paths, camera path and start/end frusta
keyframes/kf-0026.png    lossless stills of the frames you declared (file name = frame number)
source.tar.gz            deterministic ustar+gzip: scene.json (your bytes), README, and the engine's project
manifest.json            written last: its presence means the bundle is whole
```

`manifest.json` (`blockout-manifest/v1alpha1`; all `path`s are relative to the manifest; fields are only ever added):

```jsonc
{ "schema": "blockout-manifest/v1alpha1",
  "tool": { "name": "blockout", "version": "0.1.0" },
  "purpose": { "use": ["motion", "blocking"], "notFor": ["identity", "first-frame"] },
  "scene": { "id": "counter-handoff", "sha256": "…" },              // sha256 of the declaration's bytes
  "binding": { "composition": {id,revision}, "shot": {id,revision}, "scene": {id,revision},   // shot and/or scene, as declared
               "environment": { "id": "kitchen", "revision": "2", "variant": "day" },          // as declared (id+revision and/or variant)
               "subjects": [{ "id": "ann", "bindingId": "char-ann", "revision": "7", "variant": "apron", "role": "character", "kind": "humanoid" }],
               "props":    [{ "id": "mug", "bindingId": "prop-mug", "revision": "1", "variant": "default", "role": "prop", "kind": "cylinder" }] },
  "handoff": { "complete": true, "missing": [] },        // complete = composition + shot + scene + environment.variant + every variant
  "engine": { "name": "blender"|"three", "version": "5.2.3", "renderer": "BLENDER_WORKBENCH",
              "pins": { "blender": "5.2.3 LTS (e13b728c6880)", "ffmpeg": "9.0.2", "blockoutProtocol": "blockout/v1alpha1" } },
              // three: pins = { three, three.module.min.js, three.core.min.js (sha256), hyperframes, hyperframesTested, ffmpeg, … }
  "render": { "width": 640, "height": 360, "fps": 24, "durationFrames": 72, "durationSeconds": 3 },
  "artifacts": [   // order: reference-video, overview, keyframe × N (ascending frame), source-archive
    { "role": "reference-video", "path": "reference.mp4", "mime": "video/mp4", "size": 69977, "sha256": "…", "assetId": "blockout-<sha256>",
      "use": ["motion", "blocking"], "width": 640, "height": 360, "fps": 24, "frames": 72, "durationSeconds": 3 },
    { "role": "overview", "path": "overview.png", "mime": "image/png", "size": …, "sha256": "…", "use": ["blocking"] },
    { "role": "keyframe", "path": "keyframes/kf-0008.png", "frame": 8, "timeSeconds": 0.3333, "mime": "image/png", "size": …, "sha256": "…", "use": ["blocking"] },
    { "role": "source-archive", "path": "source.tar.gz", "mime": "application/gzip", "size": …, "sha256": "…",
      "files": [{ "path": "source/scene.json", "size": …, "sha256": "…" }, …] } ],
  "verification": {
    "frames": { "expected": 72, "images": 72, "video": 72 },        // rendered PNGs, and frames ffprobe decoded
    "video":  { "width": 640, "height": 360, "fps": 24, "codec": "h264", "pixelFormat": "yuv420p" },
    "seek":   { "status": "verified", "frames": [40, 31, 21], "identical": true, "method": "…", "stateMaxError": 0 } },
              // frames are visited OUT OF ORDER. With --seek-samples 0: { "status": "skipped", "frames": [], "identical": null,
              // "method": "skipped …; not verified" } — a skipped check is never reported as identical: true
  "analysis": { "groundContact": […], "attachments": […], "occlusions": […], "framing": […], "penetrations": […], "warnings": […] } }
```

`assetId` is `blockout-<sha256 of the file's bytes>`: content-addressed, so the same bytes always get the same id.

`analysis` is derived from the declaration alone (identical for both engines, `blockout check` prints it):
`groundContact` (lowest point range, grounded/airborne/below-floor frames per subject and prop), `attachments` (each hold
window and the jump at pick-up/release, `teleport` when > 0.25 m), `occlusions` (frames where a subject is partly or
wholly hidden from the camera, and by which set piece), `framing` (frames a subject is off screen), `penetrations`
(subject footprint inside a wall or block). Occluders are tested by their **bounding boxes** (exact for boxes and walls,
conservative for the rest): white-model blocking evidence, not physics.

## What `render` verifies before anything lands

1. the engine produced exactly `durationFrames` frames, each exactly `width × height`;
2. ffprobe **decodes** the encoded video: frame count, fps, size equal the declaration;
3. **random seek**: `--seek-samples N` (default 3) frames, chosen by a PRNG seeded with the declaration's hash and visited
   **out of order**, are rendered again on their own — Three.js: `hyperframes snapshot --at <t>`; Blender: `frame_set(f)` in a
   fresh process, where every object's world pose is also compared with the evaluator's — and compared with the
   sequentially rendered frame by **decoded-pixel sha256**. Any difference is a tool failure. `--seek-samples 0` skips the
   check and says so: `verification.seek` becomes `{ status: "skipped", frames: [], identical: null }`, never
   `identical: true`; `render --handoff` refuses `0`;
4. no delivered PNG carries a local path (Blender's metadata stamps are switched off and this is asserted).

## Failure behavior

Everything is built in a staging directory inside `DIR` (`.blockout-staging-*`) and moved into place only after it all
exists and verifies; `manifest.json` last. **A failure leaves `DIR` exactly as it was** (nothing half-written, staging
removed, Blender/ffmpeg children stopped on SIGINT/SIGTERM → exit 130/143). Existing files are **never overwritten**:
that is exit `1` before any work starts; `--force` replaces the bundle transactionally (every file that would be replaced
is set aside and restored if landing fails; the whole `keyframes/` directory is swapped).

Exit codes, as everywhere in filmkit: `0` ok · `1` io (unreadable file, refused overwrite) · `2` invalid input (the
declaration, flags) · `3` missing dependency (Blender, HyperFrames/Chrome, ffmpeg) · `4` tool failure (Blender or
HyperFrames or ffmpeg failed, verification failed). `--json` gives errors as `{"errors":[{code,message,field?,line?,hint?}]}`
on stderr and a result object on stdout.

## With filmkit

*Blender engine* → `profiles/blender.yaml` (task `render`). The reference is a generated **asset** (kind `video`), not a
scene: a node in `scenes` joins the final build sequence, a reference must not. The real scene points at it from its
intent. The node's `produces` are `video: …/reference.mp4` and `file: …/manifest.json` in the same directory; the rest
lands beside them:

```yaml
profiles: [{ ref: filmkit/static }, { ref: ./profiles/blender.yaml }]
assets:
  motion-ref:
    kind: video
    impl: { profile: blender, task: render, params: { scene: ./blockout/s3-handoff.json } }
    produces: { video: ./build/blockout/s3/reference.mp4, file: ./build/blockout/s3/manifest.json }
scenes:
  - id: s3
    duration: 3
    intent: { description: the handoff, references: [motion-ref] }
    impl: { profile: filmkit/static, task: clip, params: {} }
    produces: { video: ./assets/final-s3.mp4 }
```

`filmkit validate` delegates to `blockout validate --native` (the declaration, then Blender opening its own project);
`filmkit run motion-ref` renders; editing the declaration makes the asset stale (the `./` path is content-hashed) and
leaves the real scene alone; a stale asset re-runs with `params.flags: [--force]`. filmkit never reads the declaration or
the `.blend`. A deliberately authored **white-model animatic** is a separate Film that uses the same `reference.mp4` as
its scene's `produces.video`; it does not belong in the film the reference is meant to inform.

*Three.js engine* needs no Profile of its own: `blockout project --engine three --out ./video` is an ordinary HyperFrames
project (vendored three.js, `data-fps`, `data-duration = frames/fps`, no GSAP, no network), and the existing
`profiles/hyperframes.yaml` `render` task renders it, again as an **asset** (`params: { project: ./video, fps: 24 }`).
Tested: `filmkit validate` (`hyperframes check`) and `filmkit run` give an mp4 with exactly the declared frames.

The bundle is a **reference**, not a clip: use `produces.video` as a reference input (its manifest travels with it), never
as a final scene.

## Two engines, one declaration — and what is not identical

Geometry, camera, poses and timing agree by construction; the tests measure it (silhouettes of every keyframe and the
overview overlap with IoU > 0.97, the white figures > 0.8). **Shading differs**: Workbench "paint" studio lighting vs a
Lambert hemisphere + sun in Three.js, and edge anti-aliasing differs. Treat either engine's video as the reference of
*motion and layout*, and do not mix frames of the two in one reference set.

## Limits (v1alpha1, on purpose)

Camera `target` is a point, not "follow this node" (keyframe it); rotations are Euler (no slerp, no gimbal handling);
the humanoid is one fixed rig, no skinning, no IK, no physics; fps is an integer 1–120, duration ≤ 3600 frames, frame
size even and ≤ 3840; PNG keyframes come from the render, there is no frame-range export; Blender's `.blend` is not
byte-deterministic (the media are); the HyperFrames CLI prints anonymous telemetry on its own schedule — blockout does not
change that, and nothing in a project fetches anything at render time.

## Layout

```
bin/blockout.ts                CLI entry            src/cli.ts        commands, --json, exit codes
runtime/blockout-core.js       THE evaluator, meshes, humanoid rig, overview camera (shared by both engines, shipped verbatim)
runtime/blockout-three.js      applies the evaluation to a Three.js scene on every hf-seek
runtime/blender/*.py           native Python inside Blender: build, overview, random-seek check, native validate
src/scene.ts                   JSON Schema + semantic validation   src/json-source.ts  paths with line numbers
src/analysis.ts                contact / occlusion / attach facts   src/engines/*     project writers + renderers
src/bundle.ts                  staging, encode, manifest, transactional landing
vendor/three/                  pinned three.js 0.181.2 (+ VENDOR.json sha256)
schema/scene.schema.json       the declaration's JSON Schema        examples/handoff.json  the shipped scene
test/                          unit: evaluator, validation, analysis, archive, landing
../../tests/blockout.test.ts   end to end: real Blender, real HyperFrames, real ffmpeg, through filmkit
../../scripts/e2e-blockout.sh  the same with every tool required (installs the pinned HyperFrames)
```
