# Changelog

Notable changes per release. The protocol version (`filmkit/v1alpha1`) is separate
from the package version: the package may add Profiles and commands without
changing the protocol.

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
