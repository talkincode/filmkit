# filmkit 协议规范 `filmkit/v1alpha1`

本文档是 `filmkit.yaml`（`kind: Film`）、Profile 文档（`kind: Profile`）、账本（`kind: Lock`）以及 CLI 输入输出契约的字段级规范。它是 JSON Schema（`filmkit schema`）与实现的直接依据；两者冲突时以本文档为准并修正实现。

约定：**MUST / MUST NOT / SHOULD** 按 RFC 2119 理解。标注 **保留** 的字段或取值已进入协议但本版本不实现——Schema 接受它们并在 `validate` 阶段以 `invalid-input` 拒绝。

v1alpha1 当前保留未实现：`tracks[].stems`、字幕 `mode: burn`、`profiles[].source`。

## 0. 通用规则

- 文件格式为 YAML 1.2，单文档。所有路径为相对路径，相对于 `filmkit.yaml` 所在目录（下称 **项目目录**）。绝对路径 MUST 被拒绝（不可移植）。
- 核心 Schema 拒绝未知字段。自由键值只允许在 `metadata.annotations` 与 `impl.params` 中出现。
- 标识符（`metadata.name`、场景 `id`、资产名、轨道 `id`、Profile 名的路径段）MUST 匹配 `^[a-z0-9][a-z0-9-]{0,62}$`。
- 时长与时间点单位为秒，MUST 为非负有限数；音量为线性增益倍率 `0..4`；透明度 `0..1`。
- `${vars.<name>}` 是唯一的替换机制，见 §1.3。

## 1. `kind: Film`

```yaml
apiVersion: filmkit/v1alpha1
kind: Film
metadata:   {...}   # §1.1  必填
vars:       {...}   # §1.3  可选
profiles:   [...]   # §1.4  必填，至少一项
assets:     {...}   # §1.5  可选
output:     {...}   # §1.6  必填
scenes:     [...]   # §1.7  必填，至少一项
timeline:   {...}   # §1.8  可选
```

### 1.1 `metadata`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | 标识符 | 是 | 项目名，用于默认输出文件名 |
| `title` | string | 否 | 人读标题 |
| `description` | string | 否 | |
| `labels` | map<string,string> | 否 | 键与值都是 string；键匹配标识符规则 |
| `annotations` | map<string,any> | 否 | 自由键值，filmkit 不读取 |

### 1.2 `apiVersion` / `kind`

`apiVersion` MUST 为 `filmkit/v1alpha1`；`kind` MUST 为 `Film`。不匹配时报 `invalid-input`，`field: apiVersion`。

### 1.3 `vars` 与替换

`vars` 是 `map<标识符, string|number|boolean>`。Film 文档中任何 string 值里出现的 `${vars.<name>}` 在 Schema 校验**之后**、语义校验**之前**被静态替换为对应值的字符串形式。

- 未定义的变量 → `invalid-input`，`field` 指向出现该引用的字段。
- 任何其它形如 `${...}` 的片段（如 `${a.b}`、`${vars.x[0]}`、`${vars.x || y}`）→ `invalid-input`。不支持表达式、条件、循环、路径索引。
- 替换不递归：变量值中的 `${...}` 按字面保留并在语义校验中被拒绝。
- `vars` 自身、`metadata.annotations`、`impl.params` 中的值也参与替换。
- 例外：`impl.params` 内允许出现 §3.4 的占位符（`${produces.*}`、`${inputs.*}`、`${node.*}`、`${film.*}`、`${output.*}`），它们原样保留，交由 Profile 的 argv 模板在 `run` / `validate` 时解析。这仍然是静态替换，不是表达式。

### 1.4 `profiles`

数组，每项：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `ref` | string | 是 | 见解析规则 |
| `source` | string | 否 | **保留**。远程来源；v1alpha1 拒绝非空值 |

`ref` 解析顺序（首个命中者胜出）：

1. 以 `./` 或 `../` 开头 → 项目目录下的 Profile 文件路径。
2. `filmkit/<name>` → 内置 Profile（§3）。
3. `<name>@<version>` → `$FILMKIT_HOME/profiles/<name>@<version>.yaml`；`$FILMKIT_HOME` 默认 `~/.filmkit`。
4. 其它形式 → `invalid-input`。

加载后的 Profile 以 `metadata.name` 登记。同一 Film 内两个 Profile 同名 → `invalid-input`（`field: profiles[i].ref`）。

### 1.5 `assets`

`map<资产名, Asset>`。Asset 二选一：

**现成资产**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `uri` | string | 是 | 相对路径，或 `http://` / `https://` URL |
| `kind` | `image` \| `video` \| `audio` \| `subtitle` \| `font` \| `file` | 是 | |
| `license` | string | 否 | 仅记录 |

URL 资产在 v1alpha1 中只允许被 `impl.params` / 模板引用，不允许被 `timeline.tracks` 直接使用（`build` 不下载；报 `invalid-input`）。

**生成型资产**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `kind` | 同上 | 是 | |
| `impl` | Impl（§1.7.2） | 是 | |
| `produces` | Produces（§1.7.3） | 是 | MUST 含与 `kind` 对应的产物 |
| `inputs` | [string] | 否 | 资产名或场景 id |

同时出现 `uri` 与 `impl` → `invalid-input`。生成型资产是 DAG 中的节点，与场景享有同一套 `plan` / `run` / lock 机制。

### 1.6 `output`

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `path` | string | 否 | `./build/<metadata.name>.mp4` | 成片路径 |
| `container` | `mp4` \| `mov` \| `mkv` \| `webm` | 是 | MUST 与 `path` 扩展名一致 |
| `video.width` | int ≥ 16, 偶数 | 是 | | |
| `video.height` | int ≥ 16, 偶数 | 是 | | |
| `video.fps` | number > 0 | 是 | | 允许 `29.97`；写入 lock 时保留原值 |
| `video.codec` | `h264` \| `hevc` \| `vp9` \| `av1` \| `prores` | 是 | | |
| `video.pixelFormat` | string | 否 | `yuv420p` | |
| `video.quality` | int 0..63 | 否 | `18` | 对 h264/hevc 为 CRF，vp9/av1 为 CRF，prores 忽略 |
| `audio.codec` | `aac` \| `opus` \| `pcm_s16le` \| `flac` | 是 | | MUST 与容器兼容 |
| `audio.sampleRate` | `44100` \| `48000` \| `96000` | 是 | | |
| `audio.channels` | `1` \| `2` | 是 | | |
| `audio.bitrate` | string | 否 | `192k` | 对有损编码 |
| `duration.planned` | number | 否 | | 计划总长，仅用于 `validate` 提示与 `tolerance` 比对 |
| `duration.tolerance` | number | 否 | `0.5` | `build` 后成片实际时长与推导时长的允许偏差 |
| `fit` | `contain` \| `cover` | 否 | `contain` | 产物画幅与成片不一致时的归一化方式：`contain` 加黑边，`cover` 裁切 |
| `background` | string | 否 | `black` | `contain` 时的填充色，ffmpeg 颜色语法 |

### 1.7 `scenes`

有序数组，每项为 Scene：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | 标识符 | 是 | 全局唯一（与资产名共享命名空间） |
| `duration` | number > 0 | 见下 | 计划时长 |
| `durationPolicy` | `auto` \| `exact` \| `min` | 否，默认 `auto` | §2.2 |
| `start` | number ≥ 0 | 否 | 显式起点覆盖，§2.1 |
| `transition` | Transition（§1.8.1） | 否 | 进入本场景的转场，覆盖 `timeline.transition.default`；首场景忽略 |
| `intent` | Intent（§1.7.1） | 否 | 面向 Agent 的意图描述，filmkit 只校验形状 |
| `inputs` | [string] | 否 | 资产名或场景 id；形成 DAG 边 |
| `impl` | Impl | 是 | |
| `produces` | Produces | 是 | |
| `audioMode` | `replace` \| `mix` \| `keep` | 否 | §2.3 |

`duration` 必填条件：`durationPolicy` 为 `exact` 或 `min`，或 `produces` 中既无 `video` 也无 `audio`（此时无法推出自然时长）。

#### 1.7.1 `intent`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `description` | string | 这一幕是什么 |
| `action` | string | 这一幕怎么演 |
| `caption` | string | 画面主字幕文本（仅记录；不自动渲染） |
| `narration.text` | string | 旁白文本 |
| `narration.voiceRef` | string | 资产名，MUST 存在且 `kind: audio` |
| `references` | [string] | 资产名列表 |

`intent` 对 filmkit 是只读的：它不进入 filtergraph，不影响哈希。它存在的目的是让翻译 `params` 的 Agent 与写意图的 Agent 可以不是同一个。

#### 1.7.2 `impl`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `profile` | string | 是 | 已登记的 Profile `metadata.name` |
| `task` | string | 是 | 该 Profile `tasks` 中的键 |
| `params` | object | 否，默认 `{}` | 对核心不透明；以该 task 的 `paramsSchema` 校验 |

`params` 中的 string 值若以 `./` 或 `../` 开头，`validate` 会检查文件存在（用于工具原生文档引用）；不存在 → `invalid-input`。

#### 1.7.3 `produces`

`map<产物类型, 相对路径>`，产物类型 ∈ `video | image | audio | subtitle | file`。至少一项。规则：

- `video` 与 `image` 互斥。
- `subtitle` MUST 为 `.srt`。
- 路径 MUST 位于项目目录内（不得以 `../` 逃出）。
- 两个节点的 `produces` MUST NOT 指向同一路径。
- 所引用 task 若声明了 `produces`（§3.4），场景 `produces` MUST 覆盖其中每一项。

**主产物**：`video` > `image` > `audio` > `subtitle` > `file`，第一个存在者。`${inputs.<id>}` 与 lock 中的“主哈希”均指主产物。

### 1.8 `timeline`

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `sequence` | [场景 id] | 否 | `scenes` 顺序 | 主轨顺序；MUST 是 `scenes` id 的一个排列（不多不少） |
| `transition.default` | Transition | 否 | `{type: cut}` | |
| `tracks` | [Track] | 否 | `[]` | 叠加轨 |

#### 1.8.1 Transition

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `cut` \| `crossfade` | |
| `duration` | number > 0 | `crossfade` 必填；`cut` MUST NOT 出现 |

约束：转场时长 MUST 小于相邻两场景各自推导时长的一半。

#### 1.8.2 Track（按 `kind` 区分）

公共字段：`id`（标识符，轨间唯一）、`kind`、`from`（默认 `0`）、`to`（数字或字符串 `end`，默认 `end`）。`from < to`；`to` 不超过总长（`end` 例外）。

**`kind: audio`**

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `asset` | 资产名 | 必填 | `kind: audio` 的现成或生成型资产 |
| `fit` | `loop` \| `trim` \| `exact` | `loop` | `loop`：循环铺满 `[from,to)`；`trim`：只播一遍，短则静音；`exact`：不循环不补齐，按 `cues` 校验段落对齐（§7） |
| `cues` | string | — | `filmkit/cues-v1` 文件路径；`fit: exact` 必填，其它取值出现即报错 |
| `tolerance` | number ≥ 0 | `0.05` | `fit: exact` 的对齐容差，秒 |
| `volume` | number 0..4 | `1` | |
| `fadeIn` | number ≥ 0 | `0` | |
| `fadeOut` | number ≥ 0 | `0` | 在 `to` 处结束 |
| `stems` | any | — | **保留** |

**`kind: subtitles`**

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `source` | `scenes` | 必填 | 收集每个场景 `produces.subtitle`，按场景起点偏移合并 |
| `mode` | `sidecar` \| `embed` \| `burn` | `sidecar` | `sidecar`：写出 `<output stem>.srt`；`embed`：同时封装为字幕流（mp4/mov→`mov_text`，mkv/webm→`srt`/`webvtt`）；`burn` **保留**（需 libass） |

`from`/`to` 对字幕轨无意义，MUST NOT 出现。同一 Film 最多一条字幕轨。

**`kind: overlay`**

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `asset` | 资产名 | 必填 | `kind: image` |
| `position` | `top-left` \| `top-right` \| `bottom-left` \| `bottom-right` \| `center` | `top-right` | |
| `margin` | int ≥ 0 | `32` | 像素，`center` 忽略 |
| `width` | int > 0 | 原始尺寸 | 缩放到该宽度，等比 |
| `opacity` | number 0..1 | `1` | |

## 2. 时间轴推导

### 2.1 主轨

设 `sequence = [s₁ … sₙ]`，`dᵢ` 为场景 `sᵢ` 的**推导时长**（§2.2），`tᵢ` 为进入 `sᵢ` 的转场时长（`cut` 为 0，`t₁ = 0`）。

```
start₁ = 0
startᵢ = startᵢ₋₁ + dᵢ₋₁ − tᵢ         (i > 1)
endᵢ   = startᵢ + dᵢ
total  = endₙ
```

显式 `start`：若场景声明了 `start`，MUST 满足 `start ≥ startᵢ₋₁ + dᵢ₋₁ − tᵢ`（不早于推导值）；大于时中间以 `output.background` 纯色垫片补齐（无音频）。小于 → `invalid-input`。

### 2.2 场景推导时长

**自然时长** `natural`：`produces.video` 与 `produces.audio` 中存在者的探测时长的最大值；两者都不存在时 `natural = duration`。产物缺失（尚未生成）时用 `duration` 替代并在 `plan` 中标注 `estimated: true`。

| `durationPolicy` | 推导时长 `d` | 产物长于 `d` | 产物短于 `d` |
| --- | --- | --- | --- |
| `auto` | `natural` | — | — |
| `exact` | `duration` | 裁掉 | 视频定格末帧、音频补静音 |
| `min` | `max(duration, natural)` | — | 视频定格末帧、音频补静音 |

`image` 产物没有自然时长，总是铺满 `d`。

### 2.3 场景音频

`produces.video` 自带音轨记为 `V.a`，`produces.audio` 记为 `A`。

| `audioMode` | 场景音频 |
| --- | --- |
| `replace`（有 `A` 时默认） | `A` |
| `mix` | `V.a + A`（等增益） |
| `keep`（无 `A` 时默认） | `V.a`；无 `V.a` 则静音 |

`mix` 或 `keep` 在无 `V.a` 时不是错误，但 `keep` 且声明了 `A` → `invalid-input`（意图矛盾）。

### 2.4 归一化

每个场景在拼接前被归一化为**中间片段**：`output` 的分辨率（按 `fit`）、`fps`、`pixelFormat`、采样率、声道数、SAR 1:1，音频缺失时补静音；长度恰为 `d`。中间片段的容器与编码由实现决定，但 MUST 无损于最终规格（不得低于成片质量）。

### 2.5 转场

`cut`：首尾相接。`crossfade`：视频用 `xfade`（`fade`），音频用 `acrossfade`，时长 `tᵢ`，位置按 §2.1。

### 2.6 叠加轨

- `audio`：在 `[from,to)` 内按 `fit` 铺设，施加 `volume`、`fadeIn`、`fadeOut`；全部音频轨与主轨音频求和（不做响度归一化——那是创意决策）。
- `subtitles`：合并规则见 §5。
- `overlay`：在 `[from,to)` 内叠加。

## 3. `kind: Profile`

```yaml
apiVersion: filmkit/v1alpha1
kind: Profile
metadata:
  name: scorekit           # 标识符，可含一个 "/"（仅内置使用 filmkit/ 前缀）
  version: "0.7"           # 任意字符串
  description: ...
runtime:      {...}        # §3.1
capabilities: {...}        # §3.2
tasks:        {...}        # §3.3
```

非内置 Profile 的 `metadata.name` MUST NOT 以 `filmkit/` 开头。

### 3.1 `runtime`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | `none` \| `cli` \| `skill` \| `mcp` \| `http` | `none`：无生产步骤，产物由人或 Agent 直接放置；`cli`：可由 `filmkit run` 执行；其余由 Agent 执行 |
| `binary` | string | `cli` 必填；`doctor` 在 `PATH` 探测 |
| `skill` | string | `type: skill` 时的 skill 名 |
| `requires.env` | [string] | 所需环境变量**名**；`doctor` 只报告是否设置 |
| `requires.binaries` | [string] | 额外二进制 |
| `healthcheck` | [string] | argv；`doctor` 执行，退出 0 视为健康。仅 `cli` |
| `exitCodes` | map<string,ExitClass> | 工具退出码 → `ok` \| `io` \| `invalid-input` \| `missing-dependency` \| `tool-failure`；未映射的非零码归为 `tool-failure` |

### 3.2 `capabilities`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `produces` | [产物类型] | 该工具能产出的类型 |
| `consumes` | [产物类型] | 可选 |

### 3.3 `tasks`

`map<任务名, Task>`，至少一项：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `description` | string | |
| `paramsSchema` | JSON Schema (Draft 2020-12) | 必填；MUST 可编译。`additionalProperties` 未声明时 filmkit 视为 `false` |
| `produces` | [产物类型] | 使用该任务的节点 MUST 声明这些产物 |
| `validate` | [string] | argv 模板；`filmkit validate` 执行，非零视为该节点无效。仅 `cli` |
| `invocation` | [string] | argv 模板；`filmkit run` 执行。仅 `cli`。缺失时 `run` 拒绝 |

### 3.4 模板占位符

`validate` / `invocation` / `healthcheck` 的每个 argv 元素可含以下占位符，静态替换，无表达式：

| 占位符 | 值 |
| --- | --- |
| `${params.<key>}` | `impl.params` 顶层标量；非标量或缺失 → `invalid-input` |
| `${produces.<type>}` | 节点 `produces` 中的路径 |
| `${inputs.<id>}` | 资产 `uri` 或场景主产物路径 |
| `${node.id}` | 节点 id |
| `${film.dir}` | 项目目录绝对路径 |
| `${output.width}` / `${output.height}` / `${output.fps}` | 成片规格 |

其它 `${...}` → `invalid-input`。命令在项目目录中执行，继承当前环境。

### 3.5 内置 Profile

**`filmkit/static`** — `runtime.type: none`。任务 `clip`：`paramsSchema` 为空对象，`produces` 不强制（`image` 或 `video`，可配 `audio` / `subtitle`）。用于图片+旁白、现成素材、Agent 用非登记方式产出的文件。归一化在 `build` 中完成。

**`filmkit/ffmpeg`** — `runtime.type: cli`，`binary: ffmpeg`。任务 `exec`：`paramsSchema` = `{ args: [string] }`，`invocation: ["ffmpeg", "-hide_banner", "-y", ...${params.args}]`。这是唯一允许展开数组参数的地方：`${params.args}` 作为单独 argv 元素出现时按元素展开。`exitCodes: {"0": ok}`，其余 `tool-failure`。

## 4. `kind: Lock` — `filmkit.lock.yaml`

由 `status` / `run` / `build` 写入，原子替换。内容完全由输入决定（无时间戳）。

```yaml
apiVersion: filmkit/v1alpha1
kind: Lock
film: { path: filmkit.yaml, sha256: ... }
nodes:
  <id>:
    kind: scene | asset
    status: ready | missing | stale | partial
    profile: { name, version }
    task: ...
    paramsHash: sha256(canonical JSON of impl.params)
    produces:
      <type>: { path, sha256, probe: { duration, width, height, fps, sampleRate, channels, hasAudio, hasVideo } }
timeline:
  total: ...
  scenes: [{ id, start, end, duration, estimated }]
build:                         # 仅 build 成功后
  filmSha256: ...              # build 时 filmkit.yaml 的哈希；status 用它判断成片是否过期
  output: { path, sha256, probe }
  filtergraph: { path: build/compose.filtergraph.txt, sha256 }
  ffmpeg: { version }
  draft: false
```

状态判定：`missing` 任一 `produces` 不存在；`partial` 部分存在；`stale` 全部存在但 `paramsHash` 与上次记录不同；否则 `ready`。首次见到（无记录）且全部存在 → `ready`（接纳）。

## 5. 字幕合并

输入：每个场景的 `produces.subtitle`（SRT，UTF-8）。输出：`<output stem>.srt`。

- 每条 cue 时间加上该场景 `startᵢ`；超出 `[startᵢ, endᵢ)` 的部分裁剪；完全超出者丢弃并在 `build` 输出中警告。
- 重新编号；按开始时间稳定排序。
- 毫秒精度，不做四舍五入以外的调整。

## 6. CLI 契约

全部命令：`--json` 把错误以 JSON 写到 stderr、结果以 JSON 写到 stdout；`--film <path>` 指定编排文件（默认 `./filmkit.yaml`）。

退出码：`0` ok · `1` io · `2` invalid-input · `3` missing-dependency · `4` tool-failure。

错误 JSON：

```json
{ "errors": [ { "code": "invalid-input", "message": "...", "field": "scenes[1].impl.params.scene", "line": 42, "column": 9, "hint": "..." } ] }
```

`field` 使用 `a.b[0].c` 记法；`line` / `column` 指向 YAML 源中该字段的值。多个错误时退出码取最严重者（4 > 3 > 2 > 1）。

| 命令 | 读 | 写 | 说明 |
| --- | --- | --- | --- |
| `init [dir]` | — | 骨架 | 目标目录非空则拒绝（`io`） |
| `schema [--profile\|--lock]` | — | stdout | JSON Schema |
| `validate` | film, profiles, 文件存在性 | — | 三层校验 + task `validate` 委托 |
| `plan` | film, profiles, 产物探测 | — | 工作单，见 §6.1 |
| `run <id>` | 同上 | 产物, lock | 仅 `cli` + `invocation` |
| `build [--draft]` | 同上 | 中间片段, 成片, filtergraph, srt, lock | |
| `status` | 同上 | lock | |
| `doctor` | profiles | — | |
| `import hyperstory <schema.json> [--out <path>] [--force]` | hyperstory schema | 新的 filmkit.yaml | 单向导入，见 §8 |

### 6.1 `plan` 输出

```json
{
  "film": "filmkit.yaml",
  "timeline": { "total": 31.2, "scenes": [ { "id": "s1", "start": 0, "end": 8, "duration": 8, "estimated": false } ] },
  "missingFiles": [ { "path": "./assets/bgm.mp3", "field": "assets.bgm.uri", "usedBy": ["track:music"] } ],
  "nodes": [
    {
      "id": "s2", "kind": "scene", "status": "missing",
      "profile": { "name": "hyperframes", "version": "1", "runtime": "cli" },
      "task": "render", "params": { ... },
      "inputs": { "cover": "assets/cover.png" },
      "produces": { "video": "build/s2/clip.mp4" },
      "executor": "filmkit run" | "agent",
      "intent": { ... }
    }
  ]
}
```

`nodes` 按拓扑序，只含 `status ≠ ready` 的节点。`executor: "filmkit run"` 当且仅当 Profile 为 `cli` 且 task 有 `invocation`。

`missingFiles` 是 film 引用但尚未就位的文件（现成资产的 `uri`、`./` 开头的 `impl.params` 值、`fit: exact` 的 `cues`）：`plan` 把它们列为待办而不阻塞；`validate` 与 `build` 把它们当作 `invalid-input` 错误。

### 6.2 `build` 产物

- `build/clips/<id>.<ext>` 中间片段
- `build/compose.filtergraph.txt` — 归一化与合成阶段的全部 filtergraph 与 argv，纯文本，路径相对项目目录；同一 Film + 同一产物集合 → 逐字相同
- `<output.path>`；`--draft` 时为 `<stem>.draft.<ext>`，分辩率缩至宽 ≤ 480 且不做规格校验
- 有字幕轨时 `<stem>.srt`

成片先写入 `build/.tmp/` 再重命名到目标；ffprobe 校验失败时目标不落位，退出 `tool-failure`，lock 不写。

## 7. 音频段落（`filmkit/cues-v1`）与 `fit: exact` 卡点

`cues` 文件描述一个音频文件自身的段落边界，单位秒，相对该文件起点。它是**中立格式**：filmkit 从不读取任何工具自带的时序文档（scorekit `meta.json`、HyperFrames 工程等），由产出方（通常是 Agent 读工具输出后）写出。

```json
{ "version": "filmkit/cues-v1",
  "cues": [ { "id": "open", "start": 0, "end": 24.87 },
            { "id": "body", "start": 24.87, "end": 49.74 } ] }
```

结构规则：`version` MUST 为 `filmkit/cues-v1`；`cues` 非空；每项 `0 ≤ start < end`；按 `start` 非降序且不重叠；`id`/`label` 可选。

`fit: exact` 的校验（`validate` 与 `build` 都执行，因为 build 不能依赖 validate 刚跑过）：

1. 场景时长必须全部已知（存在 `estimated` 时跳过——切点还是估计值，校验没有意义）。
2. **切点**定义为：首个场景的 `0`、其后每个场景的 `start + 转场时长/2`（`cut` 为 0）、以及全片总长。
3. 除第一段外，每条 cue 的 `from + cue.start` MUST 落在某个切点的 ±`tolerance` 内（默认 `0.05` 秒；超差报错给出偏移量与期望值）。
4. 音乐 MUST 覆盖所声明的区间：`from + 最后一条 cue.end ≥ from + span − tolerance`。`exact` 既不循环也不补静音——不够长是错误，不是静音填充。

语义：`fit: exact` 用于"音乐段落边界对齐画面剪辑点"。素材本身仍由 `build` 归一化（重采样、声道、按 `[from, to)` 裁切）。

## 8. `import hyperstory`

`filmkit import hyperstory <schema.json>` 单向转换 Hyperstory 的 Video Composition Schema（见 `skills/hyperstory/references/video-composition-schema.md`），写出新的 `filmkit.yaml`：

| 输入 | 输出 |
| --- | --- |
| `title` / `render` / `defaults.imageFit` | `metadata.title` / `output.video` / `output.fit` |
| `cover` + `coverDuration` | 首个场景（`durationPolicy: exact`，`produces.image`） |
| `scenes[].image` / `video` / `voice` / `subtitle` | 对应 `produces`（`impl: filmkit/static`） |
| `scenes[].duration`（+ 有旁白） | `duration` 与 `durationPolicy: min`；无旁白且无视频时 `exact`；有视频无旁白时 `auto` |
| `scenes[].description` / `action` / `caption` / `voiceText` | `intent` |
| `audio.bgm` / `audio.voiceMap` | `assets` + 一条 `fit: loop` 音频轨 |
| `defaults.bgmVolume` / `bgmFadeOutDuration` | 该轨的 `volume` / `fadeOut` |
| 存在字幕 | 一条 `sidecar` 字幕轨 |

无法表达的字段（视觉/字幕/运动/转场风格、`videoPrompt`、`videoInstruct`、`voiceSpeed`、`videoAudio.volume`、计划总时长）写入 `metadata.annotations` 并在导入报告中逐条 warning；**不猜测任何工具的参数字段**。目标文件已存在时拒绝写入，除非 `--force`。导入结果 MUST 立即能被 `plan` 使用（引用文件缺失只出现在 `missingFiles`）。

## 9. 稳定性

- `v1alpha1` 期间字段可变；进入 `v1` 后只做加法。
- 标注 **保留** 的字段在被实现前不改变含义。
