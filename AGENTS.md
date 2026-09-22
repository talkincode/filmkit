# filmkit Agent Spec

项目画像、功能清单、非目标（铁律）和完整验收矩阵在 [docs/roadmap.md](docs/roadmap.md)。改动任何东西之前先读它：项目概述解释 filmkit 是什么，非目标解释它永远不做什么。字段级协议规范在 [docs/spec.md](docs/spec.md)。

本文件分三部分：**Agent 编码规范**（最高优先级，约束怎么写代码）、**核心边界**（MUST 级，约束 filmkit 是什么/不是什么）、**验收矩阵硬规则**（MUST 级，约束什么算做完）。

---

# Agent 编码规范 (Agent Coding Guidelines)

> [!IMPORTANT]
> **最高优先级规则 (Highest Priority Guideline)**
>
> 本文档中定义的 **Agent 编码规范 (Agent Coding Guidelines)** 拥有**最高优先级**。所有 Agent 在本仓库进行任何代码编写、修改、重构或测试时，必须无条件优先遵循本准则。
> 当审美纯洁度、抽象偏好或大规模重构冲动与本准则冲突时，以本准则为准。

## Agent Coding Guidelines

The goal is not "beautiful code."

The goal is code with **clear structure, explicit logic, strong verifiability, and low-cost changeability** — code that the next agent or person can understand, trace, safely modify, and verify without having watched it being written.

### The four questions

Every change is judged by these. Ask them before you start and before you finish:

1. Can someone quickly understand the structure this change touches?
2. Can they accurately trace the logic and state changes from input to output?
3. Can they safely modify this part without breaking something elsewhere?
4. Can they verify the change is correct, using evidence you left behind?

If any answer is no, the change is not done.

### Priority

**Correctness → Structure → Logic → Verifiability → Locality → Performance → Elegance**

When two rules below conflict, the one higher in this list wins. In particular: fixing a root cause that spans modules beats a local patch that leaves the wrong rule in place (Structure > Locality). Say so explicitly when you do this.

---

### 1. Understand before you change

* Read the code you are about to modify and the code that calls it. Know what currently happens before deciding what should happen.
* Before adding anything — a helper, a config option, a state field, an abstraction layer — look for the existing equivalent. Reuse the project's existing conventions and sources of truth.
* If you introduce a new concept, state why the existing ones were insufficient.
* Match the project's existing idioms, even where you would personally choose differently. Consistency within the codebase beats consistency with your preferences.

### 2. Prefer clear structure

* Every module has one responsibility you can state in a sentence or two. If you can't, the boundary is wrong.
* Inputs, outputs, dependencies, and sources of state are visible at the module boundary.
* No hidden dependencies, ambient global state, or side effects that reach across modules.
* Prefer self-contained modules over cross-layer coupling.

### 3. Prefer explicit logic

* Data flow is traceable from input to output by reading the code, without running it.
* State changes are explicit and localized; a reader can find every place a piece of state is written.
* Do not introduce indirection or dynamic mechanisms (reflection, metaprogramming, plugin systems, implicit dispatch) that the project does not already use.
* Prefer direct code over abstractions that exist only to look elegant. Some duplication is better than the wrong abstraction.

### 4. Keep changes local — but fix the rule, not the symptom

* Solve the task with the smallest change that fixes the actual cause.
* One requirement should touch as few modules as possible.
* Do not refactor, reformat, or "improve" code unrelated to the task. Leave it as you found it.
* When the fix requires touching several modules because the *rule* is wrong (not just one instance of it), do it — and identify the root cause in your summary so reviewers can see why the change is broader than the symptom.

### 5. Make behavior verifiable

* When behavior changes, add or update tests that exercise the real behavior. Tests exist to catch regressions, not to raise coverage.
* Verify the change the way it will actually be used: run the real command, hit the real endpoint, render the real output. Passing tests are evidence, not the finish line.
* Prefer deterministic, reproducible implementations. Avoid time-, order-, or environment-dependent behavior unless the task requires it.
* A completed change states *how* it was verified and why that method reflects real use.

### 6. Fail explicitly

* Validate inputs and assumptions at system boundaries.
* Errors are returned or logged with enough context to diagnose them. Unexpected states are surfaced, never silently swallowed.
* Never weaken an assertion, mock away a real code path, or catch-and-ignore to make a test pass. If a test is wrong, fix the test and say why it was wrong.

### 7. Protect the working system

* Preserve existing behavior and compatibility unless the change is intentionally breaking. If it is, say so.
* Prefer small, reviewable, reversible changes over large ones.
* Do not delete or rewrite code you do not understand. If something looks dead or wrong, confirm before removing it.

### 8. Decide visibly; ask when the decision isn't yours

* When more than one reasonable approach exists, compare them briefly and pick a clear winner. Record the reasoning where the next reader will find it (PR description, commit message, or a short comment at the decision point).
* When the tradeoff is a real product or architectural choice — not a technical detail — recommend a direction and stop to confirm before building it.
* If the available context doesn't let you proceed safely, ask one specific question instead of guessing.
* Leave behind what a reviewer needs: what changed, why, what was considered and rejected, and how it was verified.

---

### Definition of done

A change is complete when:

* the requested outcome actually works, verified in the way it will be used;
* it fits the surrounding system's existing structure and conventions;
* tests cover the changed behavior and none were weakened to pass;
* unrelated code is untouched;
* the reasoning behind non-obvious decisions is written down;
* the four questions at the top all answer yes.

---

# 核心边界 (MUST)

以下规则对应 `docs/roadmap.md` 的“非目标（铁律）”，是 filmkit 的身份边界。违反任何一条的改动都不完整，无论代码质量多高。

## filmkit 是什么

filmkit 是一个 **Agent 导向的视频编排编译器**：读 `filmkit.yaml`（意图）与 Profile 文档（工具能力登记），校验、推导时间轴、输出工作单、执行可模板化的 cli 工具、用 ffmpeg 把全部产物合成为满足 `output` 规格的成片，并把实际结果记入 `filmkit.lock.yaml`。它是编译器与账本，不是编辑器，不是调度器，不是 Agent runtime。

## 处理与语义边界

- MUST NOT 自研任何视频/音频处理（缩放、转码、混音、淡入淡出、字幕渲染、转场）。全部委托 ffmpeg/ffprobe；filmkit 只生成 filtergraph 与命令行。
- MUST NOT 在核心 Schema 中引入只有某一个工具才能满足的字段；`impl.params` 对核心 MUST 保持不透明，只用所引用 Profile 的 `paramsSchema` 校验。
- MUST NOT 内嵌或解析工具原生文档（scorekit scene、HyperFrames 项目、Remotion 项目等）。编排文件只引用其路径，内容校验委托给该工具的 `validate` 命令。
- MUST NOT 调用 skill、MCP 或 LLM，MUST NOT 生成 prompt 或做任何创意决策。`runtime.type` 为 `skill` / `mcp` 的节点由 Agent 执行。
- `runtime.type: http` 是唯一的例外，且必须是**声明式**的：`filmkit run` 按 Profile 里声明的 create / poll / output 调用生成 API（spec §3.5）。核心代码 MUST NOT 出现任何厂商字段或厂商分支；MUST NOT 自动重试；MUST NOT 生成 prompt（prompt 由 Agent 写进 `params`）。密钥只以环境变量**名字**声明，值只在子进程内读取，MUST NOT 出现在 argv、日志、lock 或任何输出中。

## 状态与确定性

- MUST 保持意图与结果分离：filmkit MUST NOT 修改 `filmkit.yaml`（`init` / `import` 生成新文件除外）；实际路径、哈希、探测参数、工具版本只写入 `filmkit.lock.yaml`。
- MUST 保证确定性：同一编排文件 + 同一产物集合 → 逐字相同的 `compose.filtergraph.txt`。MUST NOT 把时间戳、随机值或环境相关值引入 filtergraph 或 lock 哈希。
- MUST 保证失败不留半成品：`build` / `run` 的输出先写临时位置再原子落位；外部工具失败时目标路径不存在、lock 文件与失败前一致。
- MUST NOT 引入模板表达式语言。`${vars.x}` 静态替换是唯一允许的替换机制；不支持表达式、条件、循环、路径索引。派生值（如已解析时长）只出现在 `plan` 输出中。

## 产品形态

- MUST NOT 引入 GUI、时间线编辑器、预览服务器、常驻进程或后台守护。预览与评审用产出的文件替代：成片用 `build --draft`，分镜用 `storyboard` 生成的静态单文件 HTML/JSON（`file://` 可开、无 JS、无网络、无服务端——是文档不是应用）。
- MUST NOT 持有、存储或打印凭据。Profile 只声明所需环境变量的名字；`doctor` 只报告存在与否。
- MUST NOT 实现版本控制、资产库、素材市场或远程 Profile registry。
- MUST NOT 实现并发调度或重试策略。`run` 一次执行一个节点，失败即退出。
- 内置 `filmkit/static` + 现成文件 MUST 能独立出片；scorekit、Seedance、HyperFrames 等一切外部生成工具 MUST 保持可选，缺失时 `doctor` 报告但不阻止不依赖它们的项目。

## 协议稳定性

- 核心 Schema MUST 拒绝未知字段；自由 KV 只允许出现在 `metadata.annotations` 与 `impl.params`。
- `apiVersion` 进入 `v1` 后 MUST 只做加法：不重定义字段语义、不移除字段；破坏性变更必须升 `apiVersion`。
- 所有命令 MUST 支持 `--json` 机器可读错误（含 `field` 路径与行号），退出码 MUST 遵守：`0` ok、`1` io、`2` invalid input、`3` missing dependency、`4` external tool failure。

## 工程约定

- 实现语言与运行时：Bun + TypeScript。MUST NOT 引入第二运行时。
- 唯一硬性外部依赖是 ffmpeg/ffprobe。任何新增的外部依赖 MUST 先在 `docs/roadmap.md` 的非目标或方向中找到依据。
- filmkit skill（`skills/filmkit/SKILL.md`）中出现的每个子命令与参数 MUST 能在 CLI `--help` 中找到；两者的一致性 MUST 有脚本守护。

---

# 验收矩阵（硬性规定）

完整矩阵只维护在 [docs/roadmap.md](docs/roadmap.md) 的“验收矩阵”一节（单一事实来源，本文件不复制）。以下五条为 MUST 级：

1. 每个一级功能 MUST 至少有一条 Happy Path E2E 测试。
2. 每个高风险功能 MUST 至少覆盖一条失败路径。
3. 每个涉及权限的功能 MUST 至少验证两种角色（本项目当前没有权限系统，整体“不适用”；若未来引入即生效）。
4. 每个会修改系统状态（写文件、执行外部命令）的操作 MUST 至少验证一次失败后的恢复：失败不得留下损坏的半成品产物或不一致的 lock 文件。
5. 新增一级业务功能时，MUST 同步新增对应的 E2E 测试并更新 `docs/roadmap.md` 的验收矩阵，否则变更不完整。
