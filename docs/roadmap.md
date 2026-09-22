# filmkit 项目画像与方向

> 本文档回答两件事：filmkit 应该做成什么样，以及绝不能变成什么样。它是北极星和护栏，不是施工图。字段级规范放在 [docs/spec.md](spec.md)，Agent 行为规约放在 [AGENTS.md](../AGENTS.md)。

## 项目概述

filmkit 是一个 **Agent 导向的视频编排编译器**。Agent 用一份 YAML 编排文件（`filmkit.yaml`）声明一部视频：项目元数据、场景序列与时间轴、每个场景由哪个工具怎么实现、产物落在哪里、成片是什么规格。各场景的素材由 Agent 调用外部工具（HyperFrames、Seedance、TTS、scorekit、ffmpeg……）产出；filmkit 负责校验编排、推导时间轴、给出工作单、执行可模板化的命令行工具，最后把全部产物归一化、按时间轴拼接、混音、叠字幕水印，编码成满足规格的成片。全程命令行，无 GUI，是一条流水线而不是一个编辑器。

它服务的用户是编码 Agent 及其背后的人：让“做一支视频”从“读一堆 skill 的 prose、手拼 ffmpeg 命令、靠肉眼校对”变成“写一份可校验的文件、按工作单产出素材、跑一次 build”。它填补的是现有 skill 生态的缺口：`hyperstory`、`legal-visual-director`、`video-story-producer` 各自维护互不兼容的中间格式，工具绑定靠自然语言，校验靠 Agent 自查，任意一个 Agent 都无法接手另一个 Agent 半途的项目。

已确立的技术边界：Bun + TypeScript 实现 CLI；ffmpeg/ffprobe 是唯一硬性外部依赖；协议格式为 YAML，由 JSON Schema 描述。设计基因与同作者的 [scorekit](https://github.com/talkincode/scorekit) 一致——编译器而非生成器、确定性输出、`--json` 机器可读错误、统一退出码、`schema`/`doctor` 子命令、拒绝未知字段。

- 架构图

```text
                 ┌────────────────────────────────────────────────────┐
                 │  filmkit.yaml  (意图 / spec, Agent 编写, git 管理)    │
                 │   metadata · vars · profiles · assets · scenes      │
                 │   timeline · output                                 │
                 └──────────────┬─────────────────────────────────────┘
                                │ 引用
   ┌──────────────┐   ┌─────────▼──────────┐   ┌───────────────────────┐
   │ Profile 文档  │◄──│  filmkit CLI        │──►│ filmkit.lock.yaml     │
   │ (工具能力登记) │   │  validate · plan    │   │ (实际产物 / status,    │
   │ 本地 / 全局    │   │  run · build        │   │  filmkit 写, Agent 只读)│
   └──────────────┘   │  status · doctor    │   └───────────────────────┘
                      │  schema · import    │
                      └───┬───────────┬────┘
            plan 工作单    │           │ run (仅 cli 类 profile) / build
                          ▼           ▼
   ┌──────────────────────────┐   ┌──────────────────────────────────┐
   │ Agent 调用外部工具产出素材   │   │ ffmpeg / ffprobe                 │
   │ HyperFrames · Seedance ·   │   │ 归一化 → 拼接/转场 → 叠加轨 →      │
   │ TTS · imagine · scorekit … │   │ 编码 → 探测校验 output            │
   └─────────────┬────────────┘   └───────────────┬──────────────────┘
                 │ 产物落到 produces.path            │
                 ▼                                  ▼
           build/<scene>/…                    build/final.mp4
```

## 项目画像（目标状态）

做好之后，filmkit 是这样的：

**任意 Agent 都能接手同一个项目。** 一个 filmkit 项目的全部真相只在三处：`filmkit.yaml`（想要什么）、被引用的 Profile 文档（可用工具能做什么、参数长什么样）、`filmkit.lock.yaml`（实际产出了什么）。Agent 不需要读任何 skill 的 prose 就能从 `filmkit plan` 的输出知道下一步做什么、用哪个工具、参数守什么约、产物放哪。换一个 Agent、换一台机器、隔一个月回来，`filmkit status` 一眼看出哪些场景缺产物、哪些过期、成片是否满足规格。

**编排文件是意图，不是日志。** `filmkit.yaml` 只描述期望状态；实际路径、实际时长、哈希、工具版本只进 lock 文件。Agent 改意图和 filmkit 记结果永远不在同一个文件里，因此编排文件始终可 diff、可 review、可回滚。

**核心封闭，边缘开放，两者都可校验。** 框架层字段（元数据、资产、场景、时间轴、成片规格）由 filmkit 的 JSON Schema 严格校验，未知字段直接拒绝。工具层参数（`impl.params`）对 filmkit 不透明，但必须通过所引用 Profile 声明的 JSON Schema。工具自带声明文件（scorekit scene、HyperFrames 项目、Remotion 项目）时，编排文件引用它而不内嵌它，内容校验委托给该工具。filmkit 永远不理解任何工具的领域语义。

**时间轴由声明推导，不靠手填。** 场景序列顺序即主轨顺序，起点由前一场景结束与转场时长推出；叠加轨（BGM、字幕、水印）跨场景按时间范围铺设。场景实际产物与计划时长不一致时，按每个场景声明的策略（`auto` / `exact` / `min`）处理，而不是在合成时才发现错位。音乐可以声明为循环铺满（零耦合），也可以声明为精确卡点——后者 filmkit 会机器验证音乐段落边界与场景切点的偏差。

**合成稳定到无聊。** 每个产物先被归一化到成片规格（分辨率、帧率、像素格式、采样率），再进入拼接。`build` 生成的 ffmpeg filtergraph 是纯文本产物，可读、可 diff、可作为回归快照。同一编排文件 + 同一产物集合，永远得到同一份 filtergraph。失败不留半成品：成片先写临时位置再原子落位。

**轻。** 一个 `bunx filmkit`，一个 ffmpeg，就能用内置 `filmkit/static` 把“图片 + 旁白 + 字幕 + BGM 文件”做成片。scorekit、Seedance、HyperFrames 全是可选 Profile，缺哪个 `doctor` 就报哪个，但从不阻止不需要它们的项目出片。

品质冲突时的优先级：**正确（成片确实满足声明的规格）→ 可校验（错误在 validate/plan 阶段暴露而不是 build 之后）→ 确定性 → 轻量 → 功能广度 → 便利性**。宁可在 validate 时多报一个错，也不在 build 后静默产出一支错位的视频。宁可少支持一种转场，也不在核心里塞进任何理解某个工具的逻辑。

一份最小编排文件的样子（示意，非规范；规范以 `docs/spec.md` 为准）：

```yaml
apiVersion: filmkit/v1alpha1
kind: Film
metadata: { name: demo, title: 示例 }
profiles:
  - ref: filmkit/static
assets:
  bgm: { uri: ./assets/bgm.mp3, kind: audio }
output:
  container: mp4
  video: { width: 1080, height: 1920, fps: 30, codec: h264 }
  audio: { codec: aac, sampleRate: 48000, channels: 2 }
scenes:
  - id: s1
    duration: 6
    durationPolicy: min
    intent: { description: 开场, narration: { text: "……" } }
    impl: { profile: filmkit/static, task: clip, params: {} }
    produces: { image: ./assets/s1.png, audio: ./build/s1/voice.wav, subtitle: ./build/s1/voice.srt }
timeline:
  transition: { default: { type: crossfade, duration: 0.4 } }
  tracks:
    - { id: bgm, kind: audio, asset: bgm, fit: loop, volume: 0.15, fadeOut: 3 }
    - { id: subs, kind: subtitles, source: scenes }
```

## 当前能力清单

第一轮开发已落地（Bun + TypeScript，`bin/filmkit.ts`；真实 ffmpeg 端到端测试 `tests/*.test.ts`）：

- **协议与 Schema**：`kind: Film` / `Profile` / `Lock` 三份 JSON Schema（`src/schema/*.json`，`filmkit schema` 导出），字段级规范 `docs/spec.md`。核心拒绝未知字段；`${vars.x}` 静态替换（`src/vars.ts`）。
- **Profile 解析**：`./path`、`filmkit/<builtin>`、`<name>@<version>`（`$FILMKIT_HOME/profiles/`）；内置 `filmkit/static`（无生产步骤）与 `filmkit/ffmpeg`（通用 argv）。每个 task 的 `paramsSchema` 编译并用于校验 `impl.params`（`src/profile.ts`）。
- **validate**：Schema → 引用完整性/命名空间/产物路径唯一/DAG 无环 → 时间轴推导检查 → `impl.params` 对 `paramsSchema` → cli Profile 的 `validate` 模板委托（`src/film.ts`、`src/project.ts`）。错误带 `field` 与 YAML 行号，`--json` 机器可读。
- **时间轴推导**：主轨顺序、转场、显式 `start` 垫片、`durationPolicy` `auto|exact|min`、叠加轨范围检查（`src/timeline.ts`）。
- **plan**：拓扑序工作单，只列 `missing|partial|stale|blocked`，附 `executor`（`filmkit run` / `agent` / `place files`）、参数、输入路径、`intent`、已解析时长（`src/plan.ts`）。
- **run**：仅 cli + `invocation`；退出码按 Profile `exitCodes` 映射；失败时清理新建产物、不写 lock（`src/run.ts`）。
- **build**：归一化每场景为中间片段（分辨率/fps/像素格式/采样率/声道/时长）→ `concat` / `xfade`+`acrossfade` → 音频轨（loop/trim、volume、fade、delay）→ 图片叠加轨 → 字幕合并（sidecar / embed）→ 编码 → ffprobe 校验 `output` → 原子落位 → lock。`build/compose.filtergraph.txt` 逐字确定；`--draft`、`--dry-run`（`src/build/`）。
- **status / lock**：探测产物写 `filmkit.lock.yaml`（无时间戳），报告就绪与成片是否过期（`src/status.ts`、`src/lock.ts`）。
- **doctor**：ffmpeg/ffprobe 与所需 filter；按 Profile 探测二进制、环境变量（仅报告是否设置）、`healthcheck`（`src/doctor.ts`）。
- **init**：可直接 `validate` → `run bgm` → `build` 出片的骨架（`src/init.ts`）。
- **filmkit skill**：`skills/filmkit/SKILL.md`；`scripts/check-skill-cli.ts` 守护其与 CLI `--help` 一致。
- **音乐卡点（`fit: exact`）**：`filmkit/cues-v1` 中立段落文件（`src/cues.ts`）+ 切点对齐校验（转场取中点，容差默认 0.05s，可按轨覆盖）；`validate` 与 `build` 都执行。切点定义与规则见 `docs/spec.md` §7。
- **`import hyperstory`**：Video Composition Schema → 新 filmkit.yaml（`src/import.ts`）；无法表达的字段写入 `metadata.annotations` 并逐条 warning；默认拒绝覆盖已存在的 film。
- **qwentts 集成**：随仓库分发 `profiles/qwentts.yaml`（`speak` task：CustomVoice 预置音色 + 情绪力度、Base 参考音频克隆、VoiceDesign 文本描述建声）。`doctor` 用工具自带的 `--print-models` 做廉价体检（不加载模型）；模型权重缺失由工具在 `run` 时以自己的提示暴露。真实端到端：`scripts/e2e-qwentts.sh`。
- **旁白与字幕链**：`scenes[].audio`（场景引用独立 TTS 节点产出的旁白，形成隐式依赖）+ `tracks[].kind: subtitles` 的 `source` 可以是资产名（整片 SRT 按原时间轴使用）。配套 `profiles/hyperframes.yaml` 的 `tts` / `transcribe` / `subtitles` / `matte-image` 四个 task（本地模型、无需云端凭据），以及"被交给某目录的工具不会因为兄弟节点写入而变 stale"的输入哈希规则。真实端到端：`scripts/e2e-hyperframes.sh --narration`。
- **HyperFrames 集成**：随仓库分发 `profiles/hyperframes.yaml`（`render` task：composition → 片段，`--variables-file` 走 `./` 路径参数，存在性 + 内容哈希 + 绝对路径）。`validate` 委托给工具自己的 `hyperframes check`（lint + runtime + layout + motion + 对比度，一次浏览器会话 ≈8s），`exitCodes` 保持字面语义（1 = 工具失败，hint 里带工具发现的问题）。协议侧只加了 `healthcheckExpect.select`：`doctor --json` 永远退出 0，且它的 `ok=false` 可能只反映可选能力（TTS/BGM/whisper），所以要挑出真正决定渲染的检查（Chrome）。真实端到端脚本：`scripts/e2e-hyperframes.sh`；stub 测试：`tests/hyperframes.test.ts`。
- **文字卡（`imagine text`）**：本机 ffmpeg 没有 `drawtext`/libass，文字进画面的路径是「`imagine text` 出透明 PNG → 场景图或叠加轨」。为此让带 alpha 的静帧场景合成到 `output.background`（而不是压平成黑），并补了像素级 E2E：`scripts/e2e-imagine-text.sh`（`--build` 会用 zig + libresvg 现搭一个支持 resvg 的 imagine）。中文断行、字体、canvas 高度这些坑写进了 skill。
- **imagine 集成**：随仓库分发 `profiles/imagine.yaml`（`generate`：一条 prompt → 一张图；`text`：文本层 → 透明 PNG，需 resvg 构建）。`generate` 的 `validate` 用工具自己的 `--dry-run` 做**零 API 消耗**的预检；协议侧新增 `runtime.healthcheckExpect`（`imagine models --json` 无可用模型时仍退出 0）。不变量：生成像素不可复现，lock 记录实际字节；多方案探索（`-n`、模型 A/B）留在 Agent 侧，不进节点。
- **Remotion 集成**：随仓库分发 `profiles/remotion.yaml`（`render` / `still` 两个 task）。为此协议新增 `tasks[].cwd`（Remotion 必须在项目目录内执行）、`${name?}` 可选占位符（可选工具参数）、`runtime.healthcheckCwd`（Remotion 装在项目 `node_modules` 里）、以及"引用路径的内容哈希纳入陈旧判定"（改 TSX/props 会让节点 stale）。真实端到端脚本：`scripts/e2e-remotion.sh`；stub 测试：`tests/remotion.test.ts`。
- **scorekit 集成**：随仓库分发 `profiles/scorekit.yaml`（`cli` 类，`validate` 委托 `scorekit --json validate`，`invocation` 调 `scorekit build`）。真实 scorekit 的端到端测试见 `tests/scorekit.test.ts`（未安装时跳过）。

尚未实现（协议已保留字段，`validate` 明确拒绝）：`tracks[].stems`、字幕 `mode: burn`、`profiles[].source`、`filmkit mcp`。

## 功能清单（目标能力）

以下是 filmkit 的一级功能。每一项都是验收矩阵中的一行；新增一级功能必须同步登记。

1. **编排文件协议（`kind: Film`）** — `apiVersion`、`metadata`、`vars`、`profiles`、`assets`、`scenes`、`timeline`、`output` 的字段语义与 JSON Schema。`assets` 条目二选一：`uri`（现成文件或 URL）或 `impl + produces`（生成型资产，与场景共用同一套生产机制）。`vars` 只支持 `${vars.x}` 静态替换。
2. **工具能力登记协议（`kind: Profile`）** — 声明 `runtime`（`skill` / `cli` / `mcp` / `http`）、二进制名、所需环境变量名、`healthcheck`、退出码映射、`capabilities`、每个 `task` 的 `paramsSchema`、可选的 `validate` 与 `invocation` 命令模板。解析顺序：项目本地路径 → `~/.filmkit/profiles/<name>@<version>` → 内置。
3. **内置 Profile** — `filmkit/static`（无生产步骤：图片或视频 + 可选音频/字幕由人或 Agent 直接放置，build 时归一化）、`filmkit/ffmpeg`（通用 argv 模板）。保证零外部生成工具也能出片。
4. **`filmkit validate`** — 三层：核心 Schema → 引用完整性（profile / task / asset / scene 引用存在、无环、时间轴不重叠不越界、转场不长于相邻场景、合成规格一致）→ `impl.params` 对 Profile `paramsSchema`，并按 Profile 的 `validate` 模板委托工具校验其原生文档。
5. **时间轴推导** — 主轨顺序（`timeline.sequence` 或 `scenes` 顺序）、转场、显式 `start` 覆盖、`durationPolicy`（`auto` / `exact` / `min`）、叠加轨时间范围、字幕按场景起点偏移合并。
6. **`filmkit plan`** — 拓扑排序的工作单：缺产物或过期（`impl.params` 哈希变化）的节点，附 Profile、参数、输入实际路径、已解析的场景秒数与总时长（只读派生值，不进 yaml）。`fit: exact` 的生成型资产排在主轨解析之后。
7. **`filmkit run <node>`** — 仅对 `runtime.type: cli` 且声明 `invocation` 的 Profile 执行命令模板，映射退出码，校验 `produces` 落地。其它类型明确报错并指向 Agent 执行。
8. **`filmkit build [--draft]`** — 归一化每个产物到 `output` 规格 → 按时间轴拼接与转场 → 叠加轨（音频混合 / 字幕 / 水印）→ 编码 → ffprobe 校验成片满足 `output`（含时长容差）。写出 `build/compose.filtergraph.txt`。`--draft` 低分辨率快速迭代。失败不留半成品。
9. **音乐卡点校验（`fit: exact`）** — 生成型音频资产附带段落元数据（如 scorekit `meta.json` 的 sections）时，校验每个段落边界与对应场景切点偏差不超过容差，超差报错。
10. **`filmkit status` 与 lock 账本** — 通过探测 `produces.path` 自动生成 `filmkit.lock.yaml`（状态、哈希、探测到的媒体参数、Profile 版本、参数哈希、时间）；`status` 输出意图与账本的 diff。
11. **`filmkit doctor`** — ffmpeg/ffprobe 版本与能力（如 libass、xfade）；按项目引用的 Profile 探测二进制与环境变量是否就位，并委托 Profile `healthcheck`；从不打印环境变量的值。
12. **`filmkit schema [--profile]`** — 导出 Film / Profile 的 JSON Schema。
13. **`filmkit init`** — 项目骨架、内置 Profile、示例编排文件。
14. **`filmkit import hyperstory <schema.json>`** — 单向导入现有 Video Composition Schema，导入结果必须通过 `validate`。
20. **qwentts 集成** — 随仓库分发的 `profiles/qwentts.yaml`：`speak`（文本 → 旁白音频），覆盖三条路线（CustomVoice 预置音色 + `emotionIntensity`/`instruct`；`model: base` + `referenceAudio`/`refText` 克隆；`voice-design` 用描述建声），参数收口到 `paramsSchema`。模型权重、`QWEN3_TTS_HOME`/`QWEN3_TTS_MODELS_DIR` 运行时与私人音色库都由工具自己管理（Profile 头部照 qwentts README 写明安装步骤），filmkit 只声明 binary 与 `--print-models` 体检。
19. **旁白与字幕链** — 文本 → 语音 → 转录 → SRT → 成片，全程本地工具。协议侧：`scenes[].audio` 引用旁白资产（与 `produces.audio` 互斥，形成隐式依赖）；字幕轨 `source` 支持整片 SRT 资产；`./` 路径参数指向另一节点的产物时自动成为依赖而不是"缺失文件"；目录哈希跳过所有已声明产物。Profile 侧：`tts`（Kokoro）、`transcribe` + `subtitles`（两段式，因为工具要两步）、`matte-image`（抠像出 alpha PNG）。
18. **HyperFrames 集成** — 随仓库分发的 `profiles/hyperframes.yaml`：`render`（一个 composition → 一个片段，可选 `quality`/`composition`/`format`/`fps`/`variables`/`strict`），项目目录即 `cwd`，变量文件作为 `./` 路径参数（检查 + 哈希 + 绝对路径）；`validate` 委托 `hyperframes check` 作为项目内容闸门；`doctor` 断言 `checks[]` 里的 Chrome 项。附带 `scripts/e2e-hyperframes.sh` 与 stub 测试。渲染前先 `hyperframes preview` 取得人工批准，是工具自身的约定，Profile 头部写明。
17. **imagine 集成** — 随仓库分发的 `profiles/imagine.yaml`：`generate`（prompt → 一张图，`--dry-run` 预检、退出码映射、可选 flag）与 `text`（文本 → 透明 PNG，需 resvg 构建）。明确两件事：生成结果不可复现（lock 记录实际产物），以及多方案探索不进节点（Agent 侧先跑，选定后再引用唯一的文件）。
16. **Remotion 集成** — 随仓库分发的 `profiles/remotion.yaml`：`render`（composition → 片段）与 `still`（帧 → 图片）两个 task，`cwd` 指向 Remotion 项目目录，`props` 以 `./` 路径参数传递（存在性检查 + 内容哈希 + 绝对路径）；配套 `scripts/e2e-remotion.sh` 用真实 Remotion CLI 走完整链路。协议侧新增 `tasks[].cwd`、`${params.x?}` 可选占位符、`runtime.healthcheckCwd` 与"引用路径内容哈希"。
15. **filmkit skill（使用说明书）** — 面向 Agent 的 SKILL.md：何时 `validate` / `plan` / `run` / `build`，如何读 Profile 把 `intent` 翻译成 `params`，禁止事项（不手改 lock、不在 `params` 外塞工具参数、不内嵌工具原生文档）。文中命令必须与 CLI `--help` 一致。

跨功能约定（适用于全部命令）：`--json` 输出机器可读错误，含 `field` 路径与行号；退出码 `0` ok、`1` io、`2` invalid input、`3` missing dependency、`4` external tool failure。

## 非目标（铁律）

- **不自研任何视频/音频处理。** 缩放、转码、混音、淡入淡出、字幕渲染、转场全部委托 ffmpeg/ffprobe；filmkit 只生成 filtergraph 与命令。原因：这是 ffmpeg 已解决的问题，自研只增加故障面。
- **不理解任何工具的领域语义。** 核心 Schema 不引入只有某一个工具才能满足的字段；`impl.params` 对核心不透明；工具原生文档（scorekit scene、HyperFrames 项目等）只被引用、不被内嵌或解析。出现“通用视频生成参数层”的冲动时，视为违规。
- **不做 Agent runtime。** filmkit 不调用 skill、MCP 或 LLM，不生成 prompt，不做任何创意决策；`runtime.type` 为 `skill` / `mcp` 的节点由 Agent 执行。filmkit 是编译器与账本，不是调度器。
- **`runtime.type: http` 必须是声明式、无厂商语义的。** filmkit 可以按 Profile 声明的 create/poll/output 调用生成 API（Seedance、Gemini Omni 等），但核心代码 MUST NOT 出现厂商字段或厂商分支，MUST NOT 自动重试，密钥只声明环境变量名、值只在子进程内读取。任何"为某家 API 写一个客户端类"的改动都违反此条。
- **无 GUI、无时间轴编辑器、无预览服务器、无常驻进程。** 预览用 `build --draft` 的文件替代。
- **不持有、不存储、不打印凭据。** Profile 只声明所需环境变量的名字；`doctor` 只报告存在与否。
- **意图与结果分离，永不写回。** filmkit 不修改 `filmkit.yaml`（`import`、`init` 生成新文件除外）；结果只进 lock 文件。
- **不引入模板表达式语言。** 只有 `${vars.x}` 静态替换；不支持表达式、条件、循环、路径索引。派生值（如已解析时长）只出现在 `plan` 输出里。
- **不做版本控制、资产库、素材市场或远程 registry。** 编排文件由 git 管理；Profile 由本地目录管理，`ref` 预留 `source` 字段但不实现远程分发。
- **不做并发调度与重试策略。** `run` 一次执行一个节点；失败即报错退出，重试由调用方决定。
- **不弱化确定性换取便利。** 任何把时间、随机、环境相关值引入 filtergraph 或 lock 哈希的改动都是违规。

## 方向与意图

- **让现有 skill 消费 filmkit 格式。** `hyperstory`、`legal-visual-director`、`video-story-producer` 各自的中间格式收敛到 filmkit 编排文件，各 skill 只保留创意与领域规则。服务于“任意 Agent 都能接手”的画像；`import hyperstory` 是第一步。
- **音乐与画面的结构性同步。** 从 `fit: loop` 到 `fit: exact` 卡点，再到基于分轨（stems）的按场景静音/让路（旁白段落压鼓组）。服务于“没有 GUI 也能做到 GUI 里要手拖的事”。`tracks[].stems` 为此预留位置，首批不实现。
- **MCP 面。** 与 scorekit 一致，`filmkit mcp` 用 stdio 包装每个 CLI 命令，让不便调用 shell 的 Agent 也能用。方向明确，非首批。
- **更多内置无依赖 Profile。** 在不违反“不自研处理”铁律的前提下，用 ffmpeg 覆盖常见的纯 ffmpeg 场景（Ken Burns、字幕卡、纯色垫片），扩大“零外部生成工具也能出片”的范围。
- **Profile 的公共积累。** 为常用工具（HyperFrames、Seedance、LTXV、qwentts、imagine、scorekit）维护经过 `doctor`/`validate` 验证的 Profile 文档，随 filmkit 分发。分发方式保持本地目录，不做远程 registry。

## 完成的样子

> 当以下可观察的结果同时成立，filmkit 才算达成画像。

- 一个 Agent 只凭 `filmkit init` 生成的骨架、`filmkit plan` 的输出和被引用的 Profile 文档，不读任何 skill prose，就能完成一支包含旁白、字幕、BGM、至少两个场景与一次转场的成片，且 `filmkit status` 报告成片满足 `output`。
- 用 `legal-visual-director` 现有的一支真实视频作为样本，走完 `import` → `plan` → 产出 → `build`，人工比对成片与原片在场景顺序、时长、字幕位置上一致。
- 故意提供不满足规格的产物（错分辨率、缺音轨、时长与 `exact` 计划不符、音乐段落与切点错位），每一种都在 `validate`/`plan`/`build` 的对应阶段被机器拦下，错误信息定位到具体字段或节点。
- 同一编排文件与产物集合在两台机器上 `build`，`compose.filtergraph.txt` 逐字相同。
- 任一 `build`/`run` 中途失败（外部工具退出非零、磁盘写入失败），项目目录中没有半成品成片，lock 文件仍与失败前一致。
- 仓库自身是完整的：`git clone` 一份干净副本后 `bun install && bun test` 全绿，`filmkit init → run → build` 能出片。`bun run check` 里的 `check:tracked` 守护"源码目录里没有被 .gitignore 吞掉的文件"——曾经因为 `.gitignore` 写成未锚定的 `build/`，`src/build/*.ts` 五轮没进仓库，而本地测试因为文件就在磁盘上一直是绿的。
- 核心数据流（校验 → 时间轴推导 → 工作单 → 合成 → 探测）有自动化测试守护，回归能被 CI 挡下。具体的测试分层由实现者决定；golden 快照、fixture 集与真实 ffmpeg 端到端是建议手段而非强制。
- filmkit skill 中出现的每个子命令与参数都能在 CLI `--help` 中找到，且有脚本守护这一一致性。

## 验收矩阵（业务能力覆盖矩阵）

> 覆盖底线（硬性规定）：
>
> 1. 每个一级功能至少有一条 Happy Path E2E。
> 2. 每个高风险功能至少覆盖一条失败路径。
> 3. 每个涉及权限的功能至少验证两种角色。
> 4. 每个会修改系统状态的操作至少验证一次失败后的恢复或回滚。
> 5. 每次新增一级业务功能，必须同步新增对应的 E2E 并更新本矩阵。

风险级别判据：高 = 执行外部命令、写入或覆盖文件、可能产出错误成片而不被发现；中 = 只读但结果驱动后续动作；低 = 纯只读输出。本项目没有权限系统，“权限角色覆盖”整体不适用，若未来引入即生效。

| 一级功能 | 风险级别 | Happy Path E2E | 失败路径 | 权限角色覆盖 | 失败恢复/回滚 | 证据（测试路径/用例） |
| --- | --- | --- | --- | --- | --- | --- |
| 1. 编排文件协议（Film Schema） | 中 | ✅ | ✅ 未知字段 / apiVersion / video+image 互斥 / YAML 语法 | 不适用（本地 CLI） | 不适用（只读） | `tests/validate.test.ts` "schema layer"; `tests/pipeline.test.ts` "schema exports load in a Draft 2020-12 validator" |
| 2. Profile 协议与解析 | 中 | ✅ 本地路径 / builtin / `name@version` | ✅ 保留名 / 坏 paramsSchema / 非 cli 声明 invocation / 缺 binary / 版本不存在 | 不适用 | 不适用（只读） | `tests/pipeline.test.ts` "profiles" 三例 |
| 3. 内置 Profile（static / ffmpeg） | 高 | ✅ init 骨架 `run bgm` + `build` | ✅ ffmpeg 非零退出 | 不适用 | ✅ 失败无产物残留、lock 不变 | `tests/pipeline.test.ts` "init output validates and builds", "run > failure: tool exits non-zero" |
| 4. validate | 中 | ✅ | ✅ 未登记 profile / 未知 task / params 违约 / 悬空引用 / 重复 id / 重复产物路径 / 环 / sequence / 保留特性 / 编码容器不兼容 / 变量 / 委托校验失败 | 不适用 | ✅ 只读：不产生 lock 与 build 目录 | `tests/validate.test.ts` 全部; `tests/pipeline.test.ts` "a local cli profile with validate + invocation" |
| 5. 时间轴推导 | 高 | ✅ min / auto / exact 混合 + crossfade 起点 | ✅ 转场过长 / 显式 start 早于推导 / duration 必填 | 不适用 | 不适用（纯计算） | `tests/unit.test.ts` "sceneDuration"; `tests/pipeline.test.ts` "plan > lists only unready nodes", "exact policy trims a longer clip; explicit start inserts a gap" |
| 6. plan | 中 | ✅ 拓扑序、executor、estimated | ✅ params 变化只标记该节点及下游 stale/blocked | 不适用 | 不适用（只读） | `tests/pipeline.test.ts` "plan" 三例 |
| 7. run | 高 | ✅ 产物落地、lock 记录 | ✅ 非 cli 节点 / 未知 id / 命令成功但未产出 | 不适用 | ✅ 工具失败：删除新建产物，lock 逐字不变 | `tests/pipeline.test.ts` "run" 五例 |
| 8. build | 高 | ✅ 混搭输入归一化 + crossfade + bgm loop + overlay + srt 合并，ffprobe 全参数断言 | ✅ 节点未就绪拒绝 / ffprobe 报规格不符拒绝落位 | 不适用 | ✅ ffmpeg 中途失败：目标与临时文件均不存在，lock 不变 | `tests/pipeline.test.ts` "build" 八例（含确定性：filtergraph 两次逐字相同） |
| 9. 音乐卡点校验（fit: exact） | 高 | ✅ 对齐通过并出片；真实 scorekit 渲染 → cues → 合成 | ✅ 边界超差 / 音乐过短 / 文件缺失 / 版本错 / 重叠 / 顺序错 / `cues` 与 `fit` 不匹配 | 不适用 | 不适用（校验不写状态） | `tests/cues.test.ts` 全部；`tests/scorekit.test.ts` "scene -> ogg -> cues -> composed film"（真实工具）与三个 stub 用例 |
| 10. status / lock 账本 | 高 | ✅ 写 lock、幂等、过期检测 | ✅ 损坏 lock 报错而非静默替换 | 不适用 | ✅ 原子写（临时文件 + rename，`src/lock.ts`）；损坏 lock 不被覆盖 | `tests/pipeline.test.ts` "status" 三例 |
| 11. doctor | 低 | ✅ | ✅ 缺二进制 / 缺 env → 退出 3，且不打印 env 值 | 不适用 | 不适用（只读） | `tests/pipeline.test.ts` "doctor" 两例 |
| 12. schema 导出 | 低 | ✅ 三份 Schema 可被 Draft 2020-12 校验器编译 | 不适用（无失败分支） | 不适用 | 不适用（只读） | `tests/pipeline.test.ts` "schema exports load" |
| 13. init | 中 | ✅ 骨架直接 validate/run/build 通过 | ✅ 非空目录拒绝 | 不适用 | ✅ 拒绝时不写任何文件 | `tests/pipeline.test.ts` "init + schema" |
| 14. import hyperstory | 中 | ✅ schema → filmkit.yaml → plan → 补齐文件 → validate → build 出片 | ✅ 空 scenes / 无时长 / 无图无视频 / 未知 kind / 文件不存在 / 拒绝覆盖 | 不适用 | ✅ 目标已存在时拒绝写入且不修改原文件；`--force` 才覆盖 | `tests/import.test.ts` 五例 |
| 16. Remotion 集成（render / still + cwd + 可选占位符 + 输入哈希） | 高 | ✅ stub 全链路（validate→plan→run→build）与真实 Remotion 端到端（`scripts/e2e-remotion.sh`） | ✅ cwd 缺失/逃出项目 / 未声明参数名 / 缺 props / 错 flag | 不适用 | ✅ run 失败无产物残留、lock 不变（沿用 run 的恢复路径） | `tests/remotion.test.ts` 八例；`scripts/e2e-remotion.sh`（真实 Remotion 4.0.526） |
| 17. imagine 集成（generate / text + 文字卡 + dry-run 预检 + healthcheckExpect） | 高 | ✅ stub 全链路（validate 用 --dry-run 零消耗、run 出图、build 合成）；文字卡：透明 PNG → 卡片场景合成到 `output.background`（像素断言）与叠加轨窗口；真实 `imagine text`（resvg 构建）端到端 | ✅ 未声明参数 / 缺凭据（tool-failure，无产物残留）/ 工具 usage error（invalid-input）/ 无就绪模型 / healthcheck 非 JSON / 无 resvg 的构建（工具自己的建议进 hint） | 不适用 | ✅ run 失败无产物残留、lock 不变 | `tests/imagine.test.ts` 六例；`tests/text-cards.test.ts` 五例；`scripts/e2e-imagine-text.sh --build` |
| 18. HyperFrames 集成（render + check 委托 + healthcheckExpect.select） | 高 | ✅ stub 全链路（validate 委托 check、run 渲染、build 合成）与真实 HyperFrames 端到端（`scripts/e2e-hyperframes.sh`，0.8.58） | ✅ 未声明/越界参数 / 项目内容问题（check 退出 1，带工具 findings）/ 渲染失败（无产物、lock 不变）/ 缺 Chrome（doctor 退出 3）/ 缺变量文件 | 不适用 | ✅ run 失败无产物残留、lock 逐字不变 | `tests/hyperframes.test.ts` 六例；`scripts/e2e-hyperframes.sh` |
| 19. 旁白与字幕链（scenes[].audio + subtitles.source + tts/transcribe/subtitles/matte-image） | 高 | ✅ stub 全链路（文本→语音→转录→SRT→成片）与真实端到端（`scripts/e2e-hyperframes.sh --narration`：真 TTS + 真转录 + 句子级字幕 + 2.99s 成片） | ✅ 场景音频引用非 audio 资产/未知资产/与 produces.audio 冲突 / 字幕轨指向非 subtitle 资产 / 字幕文件缺失 / 转录工具失败（无产物残留） | 不适用 | ✅ run 失败无产物残留、lock 不变 | `tests/narration.test.ts` 四例；`scripts/e2e-hyperframes.sh --narration` |
| 20. qwentts 集成（speak + 三条音色路线） | 高 | ✅ stub 五例（含克隆路线、缺失参考音频、工具失败、参数拼错、doctor 体检）与真实端到端（`scripts/e2e-qwentts.sh`：真 Qwen3-TTS 合成 4.72s，场景时长跟随旁白，成片 4.72s） | ✅ 未声明参数 / 参考音频缺失（missingFiles）/ 模型权重缺失（tool-failure，无产物残留）/ 旧版 CLI（脚本会提示重新 symlink） | 不适用 | ✅ run 失败无产物残留、lock 不变 | `tests/qwentts.test.ts` 五例；`scripts/e2e-qwentts.sh` |
| 15. filmkit skill 与 CLI 一致性 | 低 | ✅ `bun run check:skill` | 不适用 | 不适用 | 不适用（文档） | `scripts/check-skill-cli.ts` |

本矩阵当前没有 `❌ 缺口`：15 个一级功能都有 Happy Path E2E，高风险功能都有失败路径，写状态的操作都有失败恢复用例。下一步要做的是扩大证据面，而不是补空行——例如 `import` 结果对 golden 快照比对、真实 HyperFrames/Seedance Profile 的端到端、`stems`/`mcp` 落地时各自新增矩阵行。
