# 动态白模参考：L0 边界与工作流

白模是 **camera_motion / blocking / action_timing / framing** 的参考，不是角色身份图、服装图、环境外观图，也不是最终镜头。简化纹理和细节，不简化镜头所依赖的尺度、接触点、遮挡物和运动。

## 职责与事实来源

- 外部 Three.js / Blender：制作与渲染。场景、人物/道具几何、动作和摄影机从固定输入生成；不得在 vflow Worker 中执行。
- vflow：`motion_reference` 类型化资料，复用资料修订、审阅、批准、固定来源、输入准备与实际使用证据。设计者通过 MCP/工作台观察与改进；它不是三维编辑器。
- filmkit：`tools/vflow/` 按需读取参考；核心仍只看普通资产、intent 与不透明 Profile 参数，不认识白模或 vflow 领域模型。

## 每镜交付

1. 无标签的摄影机视角 `reference.mp4`：固定尺寸、fps、帧数；不烧入说明文字。
2. `overview.png`：布局审阅视图，不自动作为生成输入。
3. `keyframes/`：镜头内明确 `momentFrame` 的独立帧，用途仍是运动/布局而非身份或首尾帧。
4. 原始工程归档：重做与核验所需的场景声明、源代码/工程与运行依赖记录。
5. `manifest.json`：composition/scene/subject 的固定修订、environmentVariant、产物 SHA-256/大小/MIME、引擎版本和时间规格。

产物生成不等于参考批准。只有外部检查和有证据的审阅完成后，才由 vflow 明确批准。

## 可执行入口

```bash
# 在 filmkit 仓库内；Blender/HyperFrames 为可选外部工具，安装说明见工具 README。
bun tools/blockout/bin/blockout.ts render ./shot.json --engine blender --out ./reference
bun tools/blockout/bin/blockout.ts render ./shot.json --engine three --out ./reference-three
bun tools/vflow/bin/vflow-pull.ts package-motion ./reference/manifest.json --binding ./vflow-bindings.json --out ./motion-package.json
```

`vflow-bindings.json` 明确给出资料 id/title、usage、provenance。渲染包必须 `handoff.complete=true`；composition/shot 与场景取 `binding.scene`，环境取 `environment.variant`，主体取显式 role/bindingId/revision/variant（几何 kind 不映射为主体类型）。可额外给 compositionId/compositionRevision/shotId、scene@revision、environmentVariant、主体绑定作断言，不一致就拒绝。多个用途时需逐帧指定 keyframeUsages。工具核对源绑定、真实视频帧数与哈希，只生成候选资料和上传清单，不写 vflow、不批准。参考默认应是生成型 `assets`，由最终场景的 `intent.references` 引用；需要白模 animatic 时另建明确用于评审的 Film。

## 使用路径

1. 读取 vflow 当前编排、固定场景/主体版本及项目工作流。
2. 在外部白模工具里显式写出空间、动作、运镜和时刻；生成上述产物。
3. 通过 vflow 现有上传入口登记不可变资产，创建 `motion_reference` 候选资料。固定 compositionId/compositionRevision/shotId、scene@revision/environmentVariant、全部主体@revision/variant。
4. 完整播放参考视频；逐项检查尺度/支撑、接触、遮挡、轴线/机位、节奏、无说明文字、与源工程和关键帧对应。未知/失败项不能批准；修改内容需重审。
5. 明确批准资料后，通过 `set_authoring` 在编排中固定批准修订。不会静默改旧镜头或修改 selected 输出。
6. 准备外部生成输入：必须声明已核实的视频能力和用途。不能接收视频时，显式选择关键帧及用途/顺序；不自动丢图、不把白模当身份或首尾帧。
7. 外部执行后记录真实使用的资产顺序、哈希和用途。`matchesPlan` 是输入证据的一致性，不是模型遵守动作或输出视觉质量的保证。
8. filmkit 从导出 bundle 只读取用。视频/overview/关键帧列为普通参考资产，源归档只用于观察和重做；所有固定版本、用途与来源留在 `metadata.annotations["vflow.shots"].motionReferences`。不得自动填入最终 produces 或 Profile params。

## 可重放与漂移

- 位置、朝向、姿态与镜头状态由绝对帧时刻计算；乱序 seek 不依赖上一帧、墙上时间或随机值。
- 动画使用同一坐标/单位约定；模拟若使用，先烘焙并固定其输入。
- motion fps 可不同于成片 fps；对齐比较 `durationFrames/fps`，不是直接比较帧数。
- vflow 导出包含固定的基准编排；消费者在 `set_authoring` 创建后续修订后，仍可比对基准镜头是否改变。
- 缺基准、时长/镜头漂移、缺资产、未批准资料，不宣称参考仍有效。更改设计需要新资料/审阅，而不是悄悄更新旧来源。

## 验收边界

机器验证产物大小/哈希、尺寸/fps/帧数、随机 seek 状态、固定依赖、权限、导出与输入包一致性、失败无半成品；**空间/动作是否真正表达设计意图仍是完整播放的人审点**。测试中的合成审阅不构成线上项目或真实参考的批准。

真实双引擎与跨项目验证：`BLOCKOUT_HYPERFRAMES=/path/to/hyperframes VFLOW_DIR=../vflow bash scripts/e2e-blockout-vflow.sh`。该脚本实际渲染后，将产物通过本地 vflow 的上传/资料/审阅/批准/输入/evidence/export 接口走到 filmkit；审阅模拟属于测试夹具，不是线上批准。省略 seek 检查时标记未核验，不能据此生成合格的 L0 handoff。

禁止：在核心引入 Blender/Three.js 特定字段、在 vflow 加渲染服务/3D 编辑器、把候选升级为权威参考、把白模误当最终镜头、根据目标模型名猜输入能力。
