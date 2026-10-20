# Environment & Resource Onboarding — help the user understand, choose, and set up tools

Use this guide when:

- The user just installed `filmkit` and asks **"我接下来还要装什么？/ 需要什么 API 或本地模型？"**
- The user wants to make a video (or start `script-development.md` Stage 0)
  but **has no concept of what local models, CLI tools, or cloud APIs filmkit
  works with**, or what resources their own machine/accounts already have.
- `filmkit doctor` reports missing binaries, unset env vars, or failed
  healthchecks, and the user needs to decide **whether to install the tool or
  switch to a different route** and **how to set it up step by step**.

## Core mental model to explain in 3 sentences

When a user is new, clear up this misconception first:

1. **filmkit 本身是“总装编译器”，不内置大模型。** 它只硬性依赖 `ffmpeg`/`ffprobe`；依靠内置的
   `filmkit/static` 和 `filmkit/ffmpeg`，哪怕零外部 AI 工具、零 API Key，也能把现成图片/视频/音频合成为成片。
2. **所有 AI 生图、配音、写歌、动效、生视频都是“按需插拔的 Profile”。** 用不用、用本地免费模型还是云端付费 API，完全取决于你手头有什么硬件和账号。
3. **`filmkit doctor` 只检查当前 `filmkit.yaml` 里引用了的 Profile。** 刚 `filmkit init` 的项目默认只引用内置 Profile，所以跑 `doctor` 全绿只代表 `ffmpeg` 正常，不代表外部工具已装好——需要我们先做一次**资源盘点**。

---

## Step 1 — Audit the user's machine automatically (do not make them guess)

Before asking the user technical questions, run a **read-only local probe** so
you already know their OS, chip, RAM, and which tools are on `PATH`:

```bash
uname -ms                                          # Darwin arm64 (Apple Silicon) vs x86_64 / Linux
sysctl -n hw.memsize 2>/dev/null || free -h        # RAM size (decides local 1.7B TTS / Whisper large-v3 comfort)
for b in ffmpeg ffprobe qwen3-tts-ai imagine scorekit colab colab-comfy npx python3 uv brew zig; do
  printf "%-14s %s\n" "$b:" "$(command -v "$b" || echo MISSING)"
done
filmkit doctor                                     # checks ffmpeg + compose filters (including libass `subtitles`)
```

Also check (without ever printing values!) which API keys or runtime variables
are already present in the current shell:

```bash
for v in ARK_API_KEY GEMINI_API_KEY IMAGINE_API_KEY AZURE_OPENAI_APIKEY QWEN3_TTS_HOME HYPERFRAMES_PYTHON; do
  eval "val=\${$v:-}"
  printf "%-22s %s\n" "$v:" "$([ -n "$val" ] && echo SET || echo not-set)"
done
```

Summarize what you found in plain language ("你的机器是 Apple Silicon Mac，内存 32GB，非常适合跑本地免费语音和字幕模型；目前 `ffmpeg` 已就绪，但还没有装配音和生图工具"), then ask **at most 3 plain-language questions** about resources you cannot see from the shell:

1. **你想做什么类型的视频？**（口播科普/图文解说、带动态图表的知识视频、还是需要 AI 生成动态画面/人物演出的剧情短片？）
2. **你倾向于“纯本地白嫖（0 API 费用）”还是“愿意用少量云端 API / Colab 算力换取 AI 视频画面”？**
3. **你手头是否已经有现成的账号或 Key？**
   - 生图/多模态：OpenAI / Azure OpenAI / Google AI Studio (`GEMINI_API_KEY`)？
   - 视频生成：火山引擎方舟 (`ARK_API_KEY`) / Google AI Studio (`GEMINI_API_KEY`) / Google Colab 账号（有计算单元 CU）？

---

## Step 2 — Recommend the right Starter Kit (推荐配装套餐)

Never tell a beginner to install all 8 Profiles. Recommend **one** Starter Kit
that matches their hardware, budget, and video goal:

| 套餐 | 适合谁 / 视频类型 | 硬件与费用 | 组合清单（Profiles） |
| --- | --- | --- | --- |
| **Tier 0：极简零依赖套** | 已有现成录屏、实拍片段、PPT 导出图或现成录音，只想自动剪辑合成 | 任意电脑 · **¥0** | `filmkit/static` + `filmkit/ffmpeg`（仅需 `ffmpeg`） |
| **Tier A：纯本地免费全能套（推荐新手首选）** | 知识口播、法普/科普、图文卡片、代码/图表动效、自动配音+精准字幕+原创 BGM | Apple Silicon Mac (16GB+) · **¥0（全本地模型）** | `qwentts`（本地中文多音色/情绪/克隆配音）+ `hyperframes`（HTML 动效渲染 + 本地 Whisper `large-v3` 字幕转录 + 抠像）+ `imagine text`（本地透明花字/标题卡）+ `scorekit`（本地合成器原创音乐） |
| **Tier B：本地配音 + 云端 AI 插画套** | 故事解说、绘本风、历史/商业叙事、需要大量风格统一的高质量配图 | 任意电脑 + 生图 API Key · **极低成本（按张计费）** | Tier A 全部能力 + `imagine generate`（接入 OpenAI / Azure Flux / MAI-Image 等生图模型，`validate` 阶段 `--dry-run` 零费用预检） |
| **Tier C：AI 视频生成与角色一致性套** | 剧情短片、角色连续动作、电影感镜头、参考图驱动视频 | 按下方三选一 · **按次/按 CU 计费** | 在 Tier A/B 基础上，按用户已有账号三选一：<br>① **`colab-comfy`**：有 Google Colab CU → 跑 MiniMax H3 Ref2VA（最多 3 张参考图锁死角色一致性，带发音，单批 3 镜约 0.5–0.8 CU）<br>② **`gemini-omni`**：有 `GEMINI_API_KEY` → 跑 `gemini-omni-1.1-flash`（支持本地首尾帧插值过渡）<br>③ **`seedance`**：有火山引擎 `ARK_API_KEY` → 跑豆包 Seedance 1.0 Pro（1–30s 高清镜头，参考图需公网 URL） |

### How to help the user choose individual capabilities

When the user asks *"配音用哪个？"* or *"生视频选哪个？"*, compare them with this matrix:

- **中文旁白配音（TTS）怎么选？**
  - **首选 `qwentts`**（Apple Silicon Mac）：本地免费，支持 `customvoice`（`Vivian`, `Serena`, `Uncle_Fu`, `Dylan`, `Eric` 等多音色 + `instruct` 语气指令 + `emotionIntensity`）、`voice-design`（一句话描述捏声音）、`base`（几秒参考音频克隆声音）。
  - **备选 `hyperframes` (`task: tts`)**：跨平台（CPU/CoreML/CUDA），基于 Kokoro-82M，轻量快速，但**中文只有 1 个女声（`zf_xiaobei`）**；适合不需要多角色和复杂情绪的纯旁白。
- **动态画面怎么选？**
  - **文字动效 / 数据图表 / 排版卡点**：选 **`hyperframes`**（写 HTML/CSS/动画，本地 Chrome 渲染，免费可反复改）或 **`remotion`**（写 React TSX，本地渲染，免费）。**千万别用 AI 视频模型去生成带大段文字或精确图表的画面**（AI 视频会写错字且烧钱）。
  - **人物连续剧情 / 固定长相角色说话与动作**：选 **`colab-comfy` (`h3-ref2va`)**（支持最多 3 张本地参考图 `<Picture 1..3>`）。
  - **首尾帧丝滑变形 / 本地图片转视频**：选 **`gemini-omni`**（`firstFrame` / `lastFrame` 直接读本地图片，无需上传图床）。
  - **长镜头（5–30s）自然风景 / 氛围空镜 / 单图生视频**：选 **`seedance`**（画质稳、时长上限高，但参考图必须是公网 `https://` URL）。

---

## Step 3 — Step-by-step Setup Recipes (手把手搞定环境)

Only walk the user through the recipes they actually chose. After each recipe,
verify it immediately so problems are caught one at a time.

### 1. 基础底座：`ffmpeg` / `ffprobe`（必装）与烧录字幕 `libass`

- **作用**：视频归一化、拼接、转场、混音、旁白闪避（`duck`）、章节写入与成片校验。
- **安装（macOS）**：
  ```bash
  brew install ffmpeg
  ```
- **避坑（竖屏烧录字幕 `mode: burn`）**：
  Homebrew 默认的 `ffmpeg` 有时不包含 `libass`（`filmkit doctor` 会显示 `✗ filter subtitles`）。
  - 如果 `subtitles` 滤镜为 `✗`：
    - **方案 1（零重装，推荐）**：用 `mode: sidecar` 导出 `.srt` 字幕，或用 `imagine text` 生成透明 PNG 花字叠加。
    - **方案 2（装带 libass 的 ffmpeg）**：
      ```bash
      brew tap homebrew-ffmpeg/ffmpeg
      brew install homebrew-ffmpeg/ffmpeg/ffmpeg --with-libass
      ```

### 2. 本地王牌配音：`qwentts`（Apple Silicon Mac 强烈推荐，免费）

- **作用**：本地 Qwen3-TTS 语音合成（预置音色+情绪控制 / 声音克隆 / 文本捏声）。
- **前置要求**：macOS + Apple Silicon (M1/M2/M3/M4)，建议 16GB+ 内存，已装 `uv` (`brew install uv`) 和 `git`。
- **三步搞定**：
  ```bash
  # 1) 创建 MLX Python 运行时（默认路径 $HOME/mlx-audio-qwen3-tts）
  export QWEN3_TTS_HOME="$HOME/mlx-audio-qwen3-tts"
  uv venv "$QWEN3_TTS_HOME/.venv" --python 3.12
  uv pip install --python "$QWEN3_TTS_HOME/.venv/bin/python" -U mlx-audio

  # 2) 按需下载模型权重（每个约 3GB；常用预置音色下第一个 CustomVoice 即可）
  "$QWEN3_TTS_HOME/.venv/bin/hf" download \
    mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit \
    --local-dir "$QWEN3_TTS_HOME/models/qwen3-tts-12hz-1.7b-customvoice-8bit"
  # 如需声音克隆（model: base）再下：mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit -> .../qwen3-tts-12hz-1.7b-base-8bit
  # 如需文本捏声（model: voice-design）再下：mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit -> .../qwen3-tts-12hz-1.7b-voicedesign-8bit

  # 3) 安装 qwentts CLI 到 PATH（假设克隆在 ~/github/qwentts）
  mkdir -p ~/.local/bin
  git clone https://github.com/talkincode/qwentts ~/github/qwentts
  ln -sf ~/github/qwentts/skills/qwentts/scripts/qwen3-tts-ai ~/.local/bin/qwen3-tts-ai
  ```
- **验证命令**：
  ```bash
  qwen3-tts-ai --print-models
  ```
  *(注意：`--print-models` 只证明脚本与运行时就绪，不会加载 3GB 权重；请确保第 2 步对应目录里有模型文件。)*

### 3. 本地生图与透明文字卡：`imagine`（强烈推荐）

- **作用**：
  1. `task: text`：在本地将文字渲染为带透明通道的 PNG（标题卡、花字、角标、AI 声明，**完全免费**，解决 ffmpeg 无 `drawtext` 问题）。
  2. `task: generate`：统一调用 OpenAI / Azure Flux / MAI-Image 等 API 生图。
- **安装（含 `resvg` 文字渲染支持，macOS）**：
  ```bash
  brew install zig resvg
  git clone https://github.com/talkincode/imagine ~/github/imagine
  cd ~/github/imagine && zig build -Dsvg-overlay=true -Doptimize=ReleaseSafe
  ln -sf ~/github/imagine/zig-out/bin/imagine ~/.local/bin/imagine
  ```
  *(避坑：编译时必须带 `-Dsvg-overlay=true`，否则 `imagine text` 会报错缺少 resvg 支持。)*
- **配置生图模型与 Key（仅 `task: generate` 需要）**：
  按 `imagine` 文档编辑 `~/.imagine/config.toml` 或在 `~/.zshenv` 中配置对应后端的环境变量（如 `AZURE_OPENAI_APIKEY` / `IMAGINE_*`）。
- **验证命令**：
  ```bash
  imagine models --json     # 看到 "ready": true 即表示生图模型已就绪
  ```

### 4. 本地 HTML 动效 + 免费语音/字幕全链路：`hyperframes`

- **作用**：
  - `task: render`：把 `./video` 目录下的 HTML 动效合成为视频片段（需要本机装有 Google Chrome）。
  - `task: tts`：本地 Kokoro 语音合成。
  - `task: transcribe` + `task: subtitles`：本地将旁白音频转录为词级时间戳并生成 `.srt` 字幕。
  - `task: matte-image`：本地抠图出透明 PNG。
- **安装**：
  ```bash
  # 在你的视频项目的 ./video 子目录内安装 hyperframes：
  mkdir -p video && cd video && npm init -y && npm install hyperframes && cd ..

  # 如需用它的本地 TTS，准备 Python venv 并写入 ~/.zshenv：
  python3 -m venv ~/.venvs/hyperframes
  ~/.venvs/hyperframes/bin/pip install kokoro-onnx soundfile
  export HYPERFRAMES_PYTHON="$HOME/.venvs/hyperframes/bin/python"
  ```
- **中文转录必看避坑**：
  使用 `task: transcribe` 转录中文旁白时，`params` 里**必须显式写 `language: zh` 和 `model: large-v3`**（默认 `small.en` 是纯英文模型，会把中文听成英文乱码）。
- **验证命令**：
  ```bash
  (cd video && npx --no-install hyperframes doctor --json)
  ```

### 5. 本地 React 编程动效：`remotion`（可选，程序员偏好）

- **作用**：用 React TSX 组件渲染视频片段或单帧海拔/封面（`task: render` / `task: still`）。
- **安装与验证**：
  ```bash
  # 在项目的 ./video 目录内安装 Remotion：
  mkdir -p video && cd video && npm init -y && npm install remotion @remotion/cli && cd ..
  (cd video && npx --no-install remotion versions)
  ```

### 6. 本地原创配乐编译器：`scorekit`（可选，免费无版权风险）

- **作用**：把声明式音乐文件（`./music/theme.yaml`）编译为音频，并可导出段落时间点供 `fit: exact` 做画面踩点。
- **安装与验证**：
  ```bash
  brew install fluid-synth                      # 合成器后端
  git clone https://github.com/talkincode/scorekit ~/github/scorekit
  cd ~/github/scorekit && bun install
  ln -sf ~/github/scorekit/bin/scorekit.ts ~/.local/bin/scorekit
  scorekit --json doctor
  ```

### 7. 云端视频生成 API：`gemini-omni` 与 `seedance`（按需二选一）

无需安装本地大模型，只需配置环境变量 Key：

- **路线 A：Google AI Studio (`gemini-omni`)**
  - 获取 Key：前往 Google AI Studio 申请 API Key。
  - 配置环境（**推荐使用 `filmkit vault` 加密存储**，自动注入子进程）：
    ```bash
    echo "你的_KEY" | filmkit vault set GEMINI_API_KEY
    # 或写入 ~/.zshenv (非交互式子进程可用)
    # echo 'export GEMINI_API_KEY="你的_KEY"' >> ~/.zshenv
    ```
- **路线 B：火山引擎方舟 (`seedance`)**
  - 获取 Key：在火山引擎方舟控制台开通 `doubao-seedance-1-0-pro-250528`（或创建推理接入点 `ep-...`）并获取 API Key。
  - 配置环境：
    ```bash
    echo "你的_KEY" | filmkit vault set ARK_API_KEY
    # 或写入 ~/.zshenv
    # echo 'export ARK_API_KEY="你的_KEY"' >> ~/.zshenv
    ```

> **安全铁律**：永远使用 `filmkit vault set` 或环境变量安全存储 Key；切勿把 Key 写进 `filmkit.yaml` 或直接在命令行参数中暴露。`filmkit doctor` 只报告变量是否已设置（`set` / `not set`），绝不打印值。

### 8. 云端 Colab GPU 批量生视频：`colab-comfy`（角色一致性首选）

- **作用**：借用 Google Colab 的 L4/A100 GPU 运行固定版本的 ComfyUI MiniMax H3 Ref2VA 工作流（支持最多 3 张本地参考图 + 自动生成配套声音 + 严格预算闸门 + 自动关停防漏费）。
- **前置要求**：有 Google Colab 账号及可用计算单元（CU），本机已安装官方 `colab` CLI（`>=0.7.4`）。
- **四步搞定**：
  ```bash
  # 1) 在 filmkit 仓库目录下把辅助工具链接到 PATH
  ln -sf "<filmkit-repo>/tools/colab-comfy/bin/colab-comfy.ts" ~/.local/bin/colab-comfy

  # 2) 完成 Google Colab ADC 登录授权（浏览器弹窗登录一次）
  colab --auth adc sessions

  # 3) 在你的视频项目中忽略缓存与账本目录
  echo ".colab-comfy/" >> .gitignore

  # 4) 运行体检（免费、只读，不会开启云端会话）
  colab-comfy doctor
  ```

---

## Step 4 — Wire chosen Profiles into the project and run `filmkit doctor`

Once the user's chosen tools are installed, connect them to the project so
`filmkit doctor` and `filmkit validate` guard them from now on:

```bash
# 1) Copy only the Profiles this project will actually use from the filmkit repo:
mkdir -p profiles
cp <filmkit-repo>/profiles/qwentts.yaml ./profiles/
cp <filmkit-repo>/profiles/imagine.yaml ./profiles/
```

Add them under `profiles:` in `filmkit.yaml`:

```yaml
profiles:
  - ref: filmkit/static
  - ref: filmkit/ffmpeg
  - ref: ./profiles/qwentts.yaml
  - ref: ./profiles/imagine.yaml
```

Then run the final check:

```bash
filmkit doctor
```

When every line in `filmkit doctor` is `✓`, record the available palette in
`script/bible.md` (if developing a script) and proceed. If any check is `✗` and
the user decides **not** to install that tool right now, remove its `ref` from
`profiles:` and switch those scenes to an open route in their Starter Kit.
