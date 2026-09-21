# filmkit

**Agent 导向的视频编排编译器。** 用一份 YAML 编排文件声明一部视频——场景序列、时间轴、每个场景由哪个工具怎么实现、成片规格——由 Agent 调用工具产出素材，filmkit 校验编排、推导时间轴、给出工作单，并用 ffmpeg 把全部产物合成为成片。全程命令行，无 GUI，是一条流水线而不是一个编辑器。

```text
filmkit.yaml ─► validate ─► plan ─► (agent / filmkit run 产出场景产物) ─► build ─► final.mp4
```

> 状态：`v1alpha1` 第一轮已可用（validate / plan / run / build / status / doctor / init / schema）。协议字段仍可能变化。

## 快速开始

```bash
bun install
bun bin/filmkit.ts init demo && cd demo
bun ../bin/filmkit.ts validate
bun ../bin/filmkit.ts plan          # 告诉你还缺什么、谁来做
bun ../bin/filmkit.ts run bgm       # cli 类 Profile 由 filmkit 执行
bun ../bin/filmkit.ts build         # ffmpeg 合成并用 ffprobe 校验 output
bun ../bin/filmkit.ts status
```

已有 Hyperstory 项目时可以直接转换：

```bash
bun bin/filmkit.ts import hyperstory ./schema.json --out filmkit.yaml
bun bin/filmkit.ts plan          # 列出还缺的文件与需要产出的场景
```

唯一硬性依赖是 `ffmpeg` / `ffprobe`（`filmkit doctor` 会检查）。Agent 使用说明在 [skills/filmkit/SKILL.md](skills/filmkit/SKILL.md)。

随仓库分发的 Profile：`profiles/remotion.yaml`（Remotion 段渲染 / 单帧）、`profiles/imagine.yaml`（图片生成 / 文本图层）、`profiles/scorekit.yaml`（音乐生成），都是可选的。`fit: exact` 可校验音乐段落边界是否对齐画面剪辑点，段落信息由中立的 `filmkit/cues-v1` 文件承载。

## 开发

```bash
bun test                        # 真实 ffmpeg 端到端 + 单元测试（85 例）
bun run check                   # tsc --noEmit + skill/CLI 一致性
bash scripts/e2e-remotion.sh    # 用真实 Remotion CLI 跑完整链路（联网装包）
```

## 文档

- [docs/roadmap.md](docs/roadmap.md) — 项目画像、功能清单、非目标（铁律）、方向、验收矩阵
- [AGENTS.md](AGENTS.md) — Agent 编码规范（最高优先级）、核心边界、验收矩阵硬规则
- [docs/spec.md](docs/spec.md) — `filmkit/v1alpha1` 编排文件、Profile、Lock 与 CLI 契约的字段级规范

## 质量与验收

一级功能的验证覆盖登记在 [docs/roadmap.md 的验收矩阵](docs/roadmap.md#验收矩阵业务能力覆盖矩阵)。覆盖底线：每个一级功能至少一条 Happy Path E2E；高风险功能至少一条失败路径；修改系统状态的操作至少验证一次失败后的恢复；新增一级功能必须同步新增 E2E 并登记进矩阵，否则变更不完整。

## License

[MIT](LICENSE)
