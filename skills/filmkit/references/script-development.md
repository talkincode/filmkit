# From idea to final script — interactive script development

Use this when the user arrives with a **topic or idea** ("我想做一个关于…的视频")
rather than a finished script, and wants help turning it into something
filmkit can produce. You lead an interview: analyse, offer directions, let the
user choose, and narrow step by step until every scene is decided — then hand
the result to filmkit.

Division of labour (do not blur it): **all creative work happens here, with
you and the user.** filmkit itself never writes copy, picks a voice, or
invents a prompt; it validates and composes what you decided. Every decision
you make below must end up as something filmkit can check: a scene, a
duration, a Profile task with `params`, an asset with a `license`, an
annotation.

The rule that makes this skill different from generic screenwriting advice:
**design inside the toolbox.** A beautiful idea that needs a transition
filmkit cannot render, a character the image tool cannot keep consistent, or a
12-second shot from a tool capped at 6.6s is a script bug. Catch it while it
is still words — the "Toolbox limits" table below is the checklist.

## The interview protocol

1. **One decision at a time, 2–4 options each.** Put your recommendation
   first and say *why it fits this film and this toolbox* (cost, consistency,
   available tools). Free-text answers are always allowed.
2. **Analyse before asking.** Every question comes with your reading of the
   idea, so the user reacts to something concrete instead of a blank form.
3. **Write every decision down** in `script/bible.md` (template below) the
   moment it is made, with a one-line reason. The bible is the hand-off: any
   agent must be able to resume the interview from it without the chat.
4. **"你来定 / you decide"** means: pick the recommended option, record it as
   *agent-decided*, and keep going — but still stop at the three hard gates
   (direction, final script, storyboard before paid runs).
5. **Going back is allowed, and priced.** Before the first paid generation,
   any change is free. After it, say which produced nodes the change turns
   `stale` and what they cost to redo (see "Cost discipline" in SKILL.md).
6. **Summarise at each stage end** in ≤ 5 lines: what was decided, what is
   next, what is still open.

## Stage 0 — Intake and toolbox scan

Ask only what changes the design (skip anything already known):

| Question | Why it matters |
| --- | --- |
| Platform and aspect (抖音/视频号 9:16, B站/YouTube 16:9, 小红书 3:4 …) | Fixes `output.video`, which video tools are usable, cover size |
| Target length | Caps the narration word count and the shot count |
| Audience and goal (科普 / 带货 / 品牌 / 剧情 / 法普 …) | Drives hook type, tone, compliance needs |
| Budget for paid generation (none / small / normal) | Decides between local-only and paid video routes |
| Language of narration and subtitles | Decides voice tools and subtitle model |
| Existing material (photos, footage, logo, voice samples, brand fonts) | Free, consistent, and already licensed — use it first |

Then scan what is actually installed. `filmkit doctor` only checks Profiles
the film references, so create the project first and reference the candidate
Profiles (copied from the filmkit repository's `profiles/`):

```bash
filmkit init my-film && cd my-film      # refuses a non-empty directory: init before writing script/
mkdir -p profiles script refs
# copy candidate profiles, add each to profiles[] in filmkit.yaml, then:
filmkit doctor
```

The doctor report defines your **palette**. Tell the user which routes are
open, blocked, or paid (SKILL.md "Setup check" has the reporting format) —
before proposing directions, so you never propose a film the machine
cannot make.

**When the user is new to filmkit and has no idea what local models, tools, or
API keys exist (or when candidate Profiles are not installed yet):** stop and
run the onboarding flow in
[environment-onboarding.md](environment-onboarding.md) before Stage 1. Probe
their hardware (chip/RAM) and existing binaries/env vars automatically, explain
in plain language what their machine can run for free vs what needs an API key
or Colab CU, recommend a **Starter Kit** (Tier 0/A/B/C), and guide them through
installing and verifying the chosen tools until `filmkit doctor` is green.

## Stage 1 — Topic analysis and direction

Analyse the idea before offering anything:

- **Core message** in one sentence (the logline). If you cannot write it, the
  topic is still too wide — offer narrower cuts as the first question.
- **Audience tension**: what the viewer already believes, fears, or wants,
  and the gap this video closes.
- **Claims that need sources.** List every factual, legal, medical or
  financial claim the video will make. Research them (or mark them
  `needs-source`) now; a wrong fact found after paid renders is the most
  expensive kind.
- **Sensitive ground**: real people, brands, minors, health, finance, law,
  politics — each adds compliance work in Stage 9.

Then offer **3 directions**, each a short card:

```text
方向 A（推荐）：<一句话 logline>
  类型/结构：<反转叙事 | 问题-拆解-结论 | 角色故事 | 清单 | 对比实验 …>
  情绪基调：<冷静克制 | 紧张悬疑 | 温暖治愈 | 幽默 …>
  画面路线：<静帧+旁白 | 文字卡动效 | AI 视频 | 实拍素材+图文 …>  ← must be open in the palette
  时长/镜头数：<约 60s / 10–12 镜>
  成本：<本地免费 | 少量付费（约 N 个视频节点）>
  风险：<一致性 / 事实核查 / 版权 …>
```

Directions must differ in kind (structure, tone, visual route), not just in
wording. **Hard gate:** the user picks one (or merges two) before Stage 2.

## Stage 2 — Structure and emotional hooks

Build a beat sheet on the time budget:

- **Hook (first 1–3 s)**: pick one mechanism and write it as both a line and
  a picture — question that hurts, counter-intuitive claim, visible stakes,
  conflict in progress, result-first ("这是 3 个月后的样子"). The opening
  frame must work **with sound off**, so the hook needs an on-screen text
  version too.
- **Retention beats**: a new piece of information, a turn, or a visual change
  every 5–8 s on short vertical video (longer on 16:9). Mark each beat.
- **Payoff and close**: the promised answer, then one call to action. Do not
  promise in the hook what the video does not deliver.
- **Length check**: narration drives duration. Estimate Chinese at about
  **4 characters per second** (the same rule `filmkit import script` uses) and
  English at about 2.5 words per second; if the beat sheet's narration
  exceeds the target length, cut words, not seconds.

Record the beat sheet in the bible as a table: beat · seconds · purpose ·
narration draft · picture idea.

## Stage 3 — Visual style (画风)

Fix **one** style and write it as a reusable block, not adjectives scattered
over prompts:

```text
风格块（每个生成 prompt 末尾原样追加）:
  介质：<写实摄影 | 日系动画 | 3D 渲染 | 扁平插画 | 纪实新闻 | 动态图形>
  色彩：主色 #0b1729，强调色 #f2b134，整体低饱和
  光线：<侧逆光、硬光、夜景霓虹 …>
  镜头：<35mm、浅景深、轻微手持 …>
  质感：<胶片颗粒、纸张纹理 …>
  禁止：<文字、水印、多余手指、品牌标识 …>
```

Choose the style together with the **visual route**, because the route
decides what is possible:

| Route | Moves? | Good for | Watch out |
| --- | --- | --- | --- |
| Stills (`imagine generate` / placed files) | **No** — a still is static for its whole duration | Explainers, quotes, low budget | filmkit has no built-in Ken Burns; motion needs one of the routes below |
| HTML / React compositions (HyperFrames, Remotion) | Yes, designed | Text animation, charts, kinetic type, branded templates, custom transitions | Someone must author the composition; local and free to re-render |
| AI video (Seedance, Gemini Omni, colab-comfy) | Yes, generated | Cinematic shots, character action | Paid, not reproducible, per-shot limits (table below) |
| Existing footage | Yes | Real people/places, testimony | Rights must be clear (Stage 9) |

Mixing routes is fine, but keep the style block identical across them and
show the user one **style test** (a single still, free or cheap) before
committing the whole film.

## Stage 4 — Characters, props and reference images (角色道具 / 参考图)

For each recurring character or key prop, write a sheet in the bible:

```text
角色 id: lawyer-li            # ^[a-z0-9][a-z0-9-]*$ — becomes an asset id
固定描述: 35 岁女性，齐肩黑发，深灰西装，银色细框眼镜，左手腕旧皮表
可变: 表情、姿态
道具: 牛皮纸档案袋（红色封条）
参考图: ./refs/lawyer-li.png   来源: imagine 生成 / 用户提供 / 授权图库
```

Consistency is the hardest thing to get from generators. Decide the
mechanism per route **now**:

- **Make one master reference first** (front view, neutral light, plain
  background), get the user's approval, then derive every shot from it.
- `colab-comfy` (`h3-ref2va`): up to three reference images (`ref`, `ref2`,
  `ref3`), referred to in the prompt as `<Picture 1>` … — the strongest
  consistency route.
- `gemini-omni`: `firstFrame` / `lastFrame` local images — start the shot
  from an approved still.
- `seedance`: `image` must be a **public URL** (filmkit uploads nothing).
  If the user cannot host files, this route has no reference input.
- `imagine generate` has **no reference-image input**: consistency comes only
  from repeating the fixed description verbatim, which drifts. Prefer it for
  backgrounds, objects and one-off shots; for a recurring face, generate
  once and reuse that file.
- Declare each reference as an asset with a `license` and list it in the
  scenes that use it (`intent.references`): `validate` checks the asset
  exists and the storyboard links it from the shot. The real dependency is
  the `./refs/…` path inside the route's params — that is what `plan`
  reports as a missing file until the reference is in place.

Never use a real person's likeness, a celebrity, a trademarked character, or
a web image as a reference without the rights to do so.

## Stage 5 — Scene design and shot list (场景设计 / 分镜)

Turn beats into shots. One row per shot, in the bible:

| id | 秒 | 景别/运镜 | 画面（主体 + 动作 + 环境） | 旁白 | 屏幕文字 | 声音 | 路线 (profile/task) | 参考 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hook | 3 | 特写，缓推 | 档案袋上的红色封条被撕开 | "这份合同，签了就回不了头。" | 签了就回不了头 | BGM 起 | colab-comfy/h3-ref2va | lawyer-li |

Rules that keep the shot list producible:

- **Ids are lowercase ASCII** (`hook`, `s01-office`), unique across scenes and
  assets — Chinese titles go into `intent.description`, not the id.
- **Respect per-route shot limits** (table below). A shot longer than its
  route's maximum is split into two shots, or moved to a route that allows
  it.
- **Narration decides narrated shots' length** (`durationPolicy: min`);
  silent generated shots use `exact` to trim to the cut.
- **Write narration for the ear and the TTS, not the page.** Keep clauses short
  (≤ 15 Chinese chars per breath so each subtitle cue fits one line on 9:16);
  write out ambiguous numbers, units and abbreviations (`百分之七十` rather
  than `70%` when TTS stumbles, phonetic hints for polyphones); put the punch
  word at the end of the clause and land the visual cut or `caption` on it.
  Do not paste the whole spoken sentence onto a text card — `caption` / card
  text holds the 4–8 char takeaway while subtitles carry the speech.
- **Every shot names its route and references.** "We'll see" is not a route.
- **Keep the aspect consistent**: pick `output.video` first, then only routes
  that can produce that aspect; a mismatch letterboxes (`fit: contain`) or
  crops (`fit: cover`).

## Stage 6 — Shot transitions and editing rhythm (分镜头切换风格)

filmkit composes exactly two transitions between scenes:

- `cut` (default), and
- `crossfade` with a `duration` **shorter than half of both adjacent
  scenes** (validate refuses anything longer).

Everything else is designed *inside* a clip, so plan it as part of a shot:

| Wanted effect | How to get it with this toolbox |
| --- | --- |
| Match cut / continuity | End shot A and start shot B on the same still: `gemini-omni` `lastFrame` of A = `firstFrame` of B |
| Whip pan, zoom-through, glitch, wipe | Author it in a HyperFrames/Remotion composition, or generate a short dedicated transition shot |
| Cuts on the beat | Music with sections + `fit: exact` and a `cues` file; `validate` checks every boundary lands on a cut |
| Dissolve / time passing | `crossfade` (keep it short) |

Agree on a **rhythm rule** with the user (e.g. "hook 3 s, body 2–4 s per
shot, one crossfade at the chapter change, everything else cuts") and write
it into the bible.

## Stage 7 — Voice design and selection (音色)

Offer only voices the palette can produce:

- `qwentts`, `model: customvoice` — presets with emotion control:
  Chinese `Vivian`, `Serena`, `Uncle_Fu`, `Dylan`, `Eric`; English `Ryan`,
  `Aiden`; Japanese `Ono_Anna`; Korean `Sohee`. Tune with `instruct`
  ("沉稳、专业、略带压迫感"), `emotionIntensity`, `speed`.
- `qwentts`, `model: voice-design` — describe a new voice in `instruct`.
- `qwentts`, `model: base` — clone from `referenceAudio`. **Only with the
  speaker's consent**; `refText` only when you know the exact words, never
  invented.
- HyperFrames `tts` (Kokoro) — local and quick, but **one Chinese voice**
  (`zf_xiaobei`).

Match voice to the direction's tone and audience, then **audition before
committing**: render the same one-line sample (the hook line) with 2–3
candidates — local and free — and let the user listen. Record the chosen
voice params in the bible and reuse them verbatim for every line of that
speaker.

Dialogue: each line is its own TTS asset, wired into its scene with
`scenes[].audio`. A scene carries **one** narration audio, so two speakers
inside one shot means splitting the shot at the speaker change (or
pre-mixing the lines into one file yourself). Do not imitate a recognisable
real person's voice.

## Stage 8 — Music, sound and on-screen text

- **Music**: `scorekit` writes original music (no licensing question,
  sections available for `fit: exact`); a licensed track is fine if its
  licence permits this use — record it in the asset's `license`. Set BGM
  `volume` and `duck` explicitly: filmkit does no loudness normalisation.
- **Sound effects**: no shipped Profile generates SFX. Use licensed files, or
  the audio of generated clips (`colab-comfy` clips carry audio; choose
  `audioMode: mix` or `keep` on that scene).
- **Subtitles**: vertical platforms usually need burned captions
  (`mode: burn`), which require ffmpeg's libass — `filmkit doctor` reports
  the `subtitles` filter. Without it, deliver `sidecar` subtitles or styled
  `imagine text` PNG overlays.
- **On-screen text** (hook text, titles, lower thirds) goes through
  `imagine text` (transparent PNG, needs a resvg build). Overlay anchors are
  only `top-left`, `top-right`, `bottom-left`, `bottom-right`, `center`
  (+ `margin`): keep text clear of the platform UI on vertical video (the
  bottom and right edges carry buttons and captions). The font must contain
  the CJK glyphs **and** allow commercial use — prefer open-licence fonts
  (e.g. Source Han Sans / 思源黑体, SIL OFL) over system fonts whose licence
  may not cover publishing.

## Stage 9 — Cover, credits and copyright (封面 / 版权声明)

**Cover** — a separate image, not the first scene (SKILL.md "Publishing
cover"). Design it with the hook: one strong subject from the style, a title
of a few large words, the same palette. Confirm the platform's current size
and safe area before producing it, and declare it as its own asset so `plan`
lists it.

**Copyright and compliance plan** — write it into the bible and implement it
as scenes, overlays and asset metadata:

- **AI-generated content label.** Many platforms and jurisdictions require
  visible labelling of synthetic content (for example China's
  《人工智能生成合成内容标识办法》, in force since 2025-09-01). Check the
  current rules for the target platform, then implement the label: an
  `imagine text` overlay (e.g. "本视频含 AI 生成内容") and/or an end card, plus
  the publishing description text. Do not present this as legal advice.
- **Provenance ledger.** Every asset gets a `license` value: source, licence,
  author/URL (`"original: scorekit"`, `"CC BY 4.0 — author — url"`,
  `"user-provided, rights confirmed"`). Generated assets say which tool made
  them.
- **Provider watermarks.** `seedance` adds Ark's watermark unless
  `watermark: false`; decide deliberately and record why.
- **Rights checks**: voice cloning consent, likeness of real people, logos
  and trademarks, music licence scope (platform, commercial, duration), font
  licences, reference images.
- **Disclaimers**: knowledge, legal, medical or financial content gets a
  disclaimer line (on screen and in the description); list the sources
  verified in Stage 1.
- **Credits / end card**: an `imagine text` card scene with author, tools,
  music and font credits, and the AI label.

## Stage 10 — Final script and hand-off to filmkit

**Hard gate:** present the complete script — logline, beat sheet, shot list
with narration, voice, music, text, cover and compliance plan — and get the
user's approval. Then write it down in two files:

- `script/bible.md` — the decisions and their reasons (template below).
- `script/script.md` — the final shooting script: title, then the shot list
  table with final narration and on-screen text.

Transfer it into `filmkit.yaml` (write the YAML directly; `filmkit init`
already gave you a valid skeleton):

| Script element | filmkit field |
| --- | --- |
| Title, logline | `metadata.title`, `metadata.description` |
| Platform, aspect, fps | `output.video`, `output.fit`, `output.background` |
| Shot | one `scenes[]` entry; id = shot id |
| Picture description, action, on-screen text | `intent.description`, `intent.action`, `intent.caption` |
| Narration line, voice | `intent.narration.text`, a TTS asset (`params.text` + the bible's voice params) wired with `scenes[].audio` |
| Route | `impl.profile` / `impl.task` / `impl.params` (style block appended to each prompt) |
| Character / prop references | assets with `license`, listed in `intent.references`, passed in the route's ref params |
| Transition | `scenes[].transition` (`cut` / `crossfade`) |
| Music, ducking, beat cuts | audio track (`volume`, `duck`, `fit`, `cues`) |
| Subtitles, text overlays, AI label | subtitles track, overlay tracks, card scenes |
| Hook type, style block, rhythm rule, compliance plan | `metadata.annotations` (`script.*` keys) |
| Cover | `assets.cover` |

`intent` accepts only `description`, `action`, `caption`, `narration` and
`references`; anything else (mood, hook, style) belongs in
`metadata.annotations`, or `validate` rejects the film.

Narration-only explainer? `filmkit import script` can build the skeleton from
a markdown file — but it turns **every non-image line under a `##` heading
into narration**. Feed it a narration-only file (`# 标题`, then per shot
`## heading`, the spoken words, and at most a `![](./refs/…)` line), never
the bible or the shot table:

```bash
filmkit import script script/narration.md --out filmkit.yaml --force   # replaces the init skeleton
```

The imported film references only the builtin Profiles: add back the
`profiles[]` entries from Stage 0, then fill in each scene's route and
params from the shot list.

Then continue with the normal loop in SKILL.md: `filmkit validate`, then
`filmkit plan`, then `filmkit storyboard` — the storyboard walk-through is the
third hard gate, before any paid run. Produce cheap → expensive: narration
and music first (they fix the durations), stills and references next, paid
video last.

## Toolbox limits — check every shot against this

| Tool / feature | Limit that bites scripts |
| --- | --- |
| Transitions | `cut` or `crossfade` only; crossfade < half of both neighbours |
| Still image scene | Static for its whole duration; no built-in pan/zoom |
| `imagine generate` | No reference-image input; pixels differ on every run; size strings depend on the backend |
| `imagine text` | Needs a resvg-enabled build; CJK needs a font with the glyphs; multi-line text can clip (add `padding`) |
| `seedance` | 1–30 s, integer seconds (`frames` for fractions); ratios 16:9, 9:16, 1:1, 4:3, 3:4, 21:9, 9:21; reference image only as a public URL; watermark on by default; paid |
| `gemini-omni` | 16:9 or 9:16 only; no duration parameter (trim with `durationPolicy: exact`); paid |
| `colab-comfy` `h3-ref2va` | ≤ 6.6 s at 24 fps (rounded up — use `exact`); resolutions 1344x768, 768x1344, 1280x704, 704x1280, 1024x768, 768x1024; ≤ 3 refs; paid in Colab CU |
| `qwentts` | macOS + Apple Silicon; cloning needs consent and a reference clip |
| Scene audio | One narration audio per scene (`scenes[].audio` or `produces.audio`): split shots at speaker changes |
| HyperFrames `tts` / `transcribe` | One Chinese voice; Chinese transcription needs `model: large-v3` |
| Burned subtitles | Need ffmpeg libass (`subtitles` filter in `doctor`) |
| Overlays | Anchors: four corners or center, plus margin |
| Audio | No loudness normalisation, no SFX generator |
| Network | filmkit downloads nothing; every input is a local file (except Seedance's own URL fetch) |

## `script/bible.md` template

```markdown
# <片名> — 创作圣经

状态: stage-5 shot list (in progress)        ← where the interview stands

## 基本信息
平台/比例: 抖音 9:16 1080x1920 30fps | 目标时长: 60s | 受众: … | 预算: 少量付费
可用路线 (filmkit doctor, 2026-10-20): qwentts ✓  imagine ✓  colab-comfy ✗ (未装 colab)  libass ✗

## 决策记录
| # | 阶段 | 决策 | 理由 | 决定者 |
| 1 | 方向 | 方向 A：反转叙事 | 受众痛点强，适合静帧+少量视频 | 用户 |
| 2 | 画风 | 写实摄影风格块（见下） | 风格测试图已确认 | 用户 |
| 3 | 音色 | qwentts customvoice Eric, instruct "沉稳克制" | 试听 3 选 1 | 用户 |

## Logline / 节拍表 / 风格块 / 角色 / 分镜表 / 音乐与字幕 / 封面 / 版权与合规
…
## 待办与未决
- needs-source: "超过 70% 的…" 数据出处
```

Keep `状态` current: it is the first thing the next agent reads.
