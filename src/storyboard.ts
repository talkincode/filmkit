// `filmkit storyboard`: derive a regular review document from the film plus the
// files that currently exist, write it as build/storyboard.json, and render a
// static single-file HTML sheet (build/storyboard.html) through the built-in
// template (spec §6.3). Observation only — no Profile task runs, the lock is
// never touched — and deterministic: same film + same produces give
// byte-identical output, so a sheet can be diffed, shared and re-opened
// without a server.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { inputPath, isUrl, primaryProduce } from "./film.ts";
import { FilmkitError, io, toolFailure } from "./errors.ts";
import { executorFor, type PlanNode } from "./plan.ts";
import type { Analysis, MissingFile } from "./project.ts";
import type { ProduceState } from "./state.ts";
import { STORYBOARD_TEMPLATE } from "./storyboard/template.ts";
import {
  isGeneratedAsset,
  PRODUCE_PRIORITY,
  type AssetKind,
  type Intent,
  type NodeStatus,
  type Probe,
  type ProduceType,
  type Track,
  type Transition,
} from "./types.ts";

export const STORYBOARD_JSON = "build/storyboard.json";
export const STORYBOARD_HTML = "build/storyboard.html";

/** Subtitle files up to this size are embedded as text so cues can be proofed on the sheet. */
const SUBTITLE_TEXT_LIMIT = 200 * 1024;

/** One file reference as it appears on the sheet: what it is, where it is, whether it is there. */
export interface StoryboardMedia {
  /** Produce type or asset kind (`video | image | audio | subtitle | font | file`); absent when unresolvable. */
  kind?: string;
  /** Path exactly as the film writes it (project-relative), or an http(s) URL. */
  path: string;
  /** True when the media can be shown: local file in place, or a URL. */
  exists: boolean;
  /** Preview path relative to build/storyboard.html; set only when `exists`. */
  href?: string;
  bytes?: number;
  /** ffprobe duration, when this file is a probed node produce. */
  duration?: number;
  /** Raw `.srt` content (capped), so subtitles can be proofed on the sheet. */
  text?: string;
}

export interface StoryboardScene {
  /** Position along the timeline (0-based; sequence order, not declaration order). */
  index: number;
  id: string;
  start: number;
  end: number;
  duration: number;
  estimated: boolean;
  /** Seconds of background inserted before this scene by an explicit `start` (spec §2.1). */
  gapBefore: number;
  /** Incoming transition (cut for the first scene). */
  transition: Transition;
  /** Raw observed status; `blocked` is tracked separately because it is cross-cutting. */
  status: NodeStatus;
  /** An input node is not ready yet, so `build` will refuse until it is. */
  blocked: boolean;
  intent?: Intent;
  profile: { name: string; version: string; runtime: string };
  task: string;
  executor: PlanNode["executor"];
  params: Record<string, unknown>;
  /** The scene's narration asset (spec §1.7 `scenes[].audio`). */
  audio?: string;
  audioMode?: string;
  inputs: (StoryboardMedia & { id: string })[];
  /** Sorted by PRODUCE_PRIORITY, so `video` always previews above `subtitle`. */
  produces: StoryboardMedia[];
}

export interface StoryboardAsset {
  id: string;
  kind: AssetKind;
  /** `file` = a placed uri; `node` = generated (has impl, status and executor). */
  source: "file" | "node";
  exists: boolean;
  uri?: string;
  license?: string;
  status?: NodeStatus;
  blocked?: boolean;
  profile?: { name: string; version: string; runtime: string };
  task?: string;
  executor?: PlanNode["executor"];
  params?: Record<string, unknown>;
  media: StoryboardMedia[];
}

export type StoryboardTrack = Track & { media?: StoryboardMedia[] };

export interface Storyboard {
  film: string;
  filmSha256: string;
  /** metadata.title, falling back to metadata.name. */
  title: string;
  description?: string;
  output: { path: string; container: string; width: number; height: number; fps: number };
  artifacts: { json: string; html: string };
  timeline: { total: number; scenes: { id: string; start: number; end: number; duration: number; estimated: boolean }[] };
  summary: {
    shots: number;
    /** Raw `ready` count; a ready shot may still be blocked (see `blocked`). */
    ready: number;
    blocked: number;
    missing: number;
    partial: number;
    stale: number;
    estimated: number;
    missingFiles: number;
    /** Across scenes[].produces + assets[].media (inputs are references to those, not extra files). */
    media: { present: number; total: number };
  };
  scenes: StoryboardScene[];
  assets: StoryboardAsset[];
  tracks: StoryboardTrack[];
  missingFiles: MissingFile[];
}

/** Build the storyboard document. Pure observation: probes nothing new, runs nothing (spec §6.3). */
export function makeStoryboard(a: Analysis): Storyboard {
  const { film, dir, path: filmPath, profiles } = a.loaded;

  const mediaOf = (kind: string | undefined, path: string, probe?: Probe): StoryboardMedia => {
    const m: StoryboardMedia = { ...(kind ? { kind } : {}), path, exists: false };
    if (isUrl(path)) {
      // URLs are never "missing" (filmkit does not download them, spec §1.5); the browser shows them directly.
      m.exists = true;
      m.href = path;
      return m;
    }
    const abs = resolve(dir, path);
    let bytes: number | undefined;
    try {
      const st = statSync(abs);
      if (!st.isFile()) return m;
      bytes = st.size;
    } catch {
      return m;
    }
    m.exists = true;
    m.bytes = bytes;
    if (probe?.duration !== undefined) m.duration = probe.duration;
    if (kind === "subtitle" && bytes <= SUBTITLE_TEXT_LIMIT) {
      try {
        m.text = readFileSync(abs, "utf8");
      } catch {
        // A cue file we cannot read still gets its link below; the sheet must not fail over a preview nicety.
      }
    }
    m.href = toPosix(relative(resolve(dir, dirname(STORYBOARD_HTML)), abs));
    return m;
  };

  const sortedProduces = (state: { produces: Partial<Record<ProduceType, ProduceState>> }): StoryboardMedia[] =>
    (Object.entries(state.produces) as [ProduceType, ProduceState][])
      .sort((x, y) => PRODUCE_PRIORITY.indexOf(x[0]) - PRODUCE_PRIORITY.indexOf(y[0]))
      .map(([type, p]) => mediaOf(type, p.path, p.probe));

  const inputMedia = (id: string): (StoryboardMedia & { id: string }) | undefined => {
    const path = inputPath(film, id);
    if (path === undefined) return undefined; // validated films cannot reach here; do not invent a row
    let kind: string | undefined;
    const asset = film.assets[id];
    if (asset) kind = asset.kind;
    else {
      const scene = film.scenes.find((s) => s.id === id);
      kind = scene ? primaryProduce(scene.produces)?.type : undefined;
    }
    const node = a.state.nodes.get(id);
    const probe = node ? (Object.values(node.produces).find((p) => p.path === path)?.probe) : undefined;
    return { id, ...mediaOf(kind, path, probe) };
  };

  const assetMedia = (id: string): StoryboardMedia | undefined => {
    const asset = film.assets[id];
    if (!asset) return undefined;
    if (isGeneratedAsset(asset)) {
      const prim = primaryProduce(asset.produces);
      if (!prim) return undefined;
      return mediaOf(prim.type, prim.path, a.state.nodes.get(id)?.produces[prim.type]?.probe);
    }
    return mediaOf(asset.kind, asset.uri);
  };

  const scenes: StoryboardScene[] = a.timeline.scenes.map((p, index) => {
    const s = p.scene;
    const st = a.state.nodes.get(s.id)!;
    const lp = profiles.get(s.impl.profile)!;
    const task = lp.profile.tasks[s.impl.task]!;
    return {
      index,
      id: s.id,
      start: p.start,
      end: p.end,
      duration: p.duration,
      estimated: p.estimated,
      gapBefore: p.gapBefore,
      transition: p.transition,
      status: st.status,
      blocked: a.blocked.has(s.id),
      ...(s.intent ? { intent: s.intent } : {}),
      profile: { name: lp.profile.metadata.name, version: lp.profile.metadata.version, runtime: lp.profile.runtime.type },
      task: s.impl.task,
      executor: executorFor(lp.profile, task),
      params: s.impl.params,
      ...(s.audio ? { audio: s.audio, ...(s.audioMode ? { audioMode: s.audioMode } : {}) } : {}),
      inputs: st.node.inputs.map(inputMedia).filter((m): m is StoryboardMedia & { id: string } => m !== undefined),
      produces: sortedProduces(st),
    };
  });

  const assets: StoryboardAsset[] = Object.entries(film.assets).map(([id, asset]) => {
    if (isGeneratedAsset(asset)) {
      const st = a.state.nodes.get(id)!;
      const lp = profiles.get(asset.impl.profile)!;
      const task = lp.profile.tasks[asset.impl.task]!;
      const media = sortedProduces(st);
      return {
        id,
        kind: asset.kind,
        source: "node",
        exists: media.length > 0 && media.every((m) => m.exists),
        status: st.status,
        blocked: a.blocked.has(id),
        profile: { name: lp.profile.metadata.name, version: lp.profile.metadata.version, runtime: lp.profile.runtime.type },
        task: asset.impl.task,
        executor: executorFor(lp.profile, task),
        params: asset.impl.params,
        media,
      };
    }
    const media = [mediaOf(asset.kind, asset.uri)];
    return {
      id,
      kind: asset.kind,
      source: "file",
      exists: media.every((m) => m.exists),
      uri: asset.uri,
      ...(asset.license ? { license: asset.license } : {}),
      media,
    };
  });

  const tracks: StoryboardTrack[] = film.timeline.tracks.map((t) => {
    const media: StoryboardMedia[] = [];
    if (t.kind === "subtitles") {
      if (t.source !== "scenes") {
        const m = assetMedia(t.source);
        if (m) media.push(m);
      }
    } else {
      const m = assetMedia(t.asset);
      if (m) media.push(m);
    }
    return { ...t, ...(media.length ? { media } : {}) };
  });

  const count = (s: NodeStatus) => scenes.filter((x) => x.status === s).length;
  const mediaFiles = [...scenes.flatMap((s) => s.produces), ...assets.flatMap((x) => x.media)];
  const statusCounts = { ready: count("ready"), missing: count("missing"), partial: count("partial"), stale: count("stale") };

  return {
    film: filmPath,
    filmSha256: a.filmSha256,
    title: film.metadata.title ?? film.metadata.name,
    ...(film.metadata.description ? { description: film.metadata.description } : {}),
    output: {
      path: film.output.path,
      container: film.output.container,
      width: film.output.video.width,
      height: film.output.video.height,
      fps: film.output.video.fps,
    },
    artifacts: { json: STORYBOARD_JSON, html: STORYBOARD_HTML },
    timeline: {
      total: a.timeline.total,
      scenes: scenes.map(({ id, start, end, duration, estimated }) => ({ id, start, end, duration, estimated })),
    },
    summary: {
      shots: scenes.length,
      ...statusCounts,
      blocked: scenes.filter((x) => x.blocked).length,
      estimated: scenes.filter((x) => x.estimated).length,
      missingFiles: a.missingFiles.length,
      media: { present: mediaFiles.filter((m) => m.exists).length, total: mediaFiles.length },
    },
    scenes,
    assets,
    tracks,
    missingFiles: a.missingFiles,
  };
}

// ---------------------------------------------------------------- rendering

export function renderStoryboardHtml(sb: Storyboard): string {
  const values: Record<string, string> = {
    title: esc(sb.title),
    lede: sb.description ? `<p class="lede">${esc(sb.description)}</p>` : "",
    chips: headerChips(sb).join(""),
    film: esc(sb.film),
    filmSha: esc(sb.filmSha256.slice(0, 16)) + "…",
    outputPath: esc(sb.output.path),
    total: `${fmt(sb.timeline.total)}s`,
    strip: stripHtml(sb),
    sceneCount: `${sb.summary.shots} · ${sb.summary.ready} ready`,
    scenes: sb.scenes.map((sc) => sceneCard(sc)).join("\n"),
    assetsSection: assetsSection(sb),
    tracksSection: tracksSection(sb),
    missingSection: missingSection(sb),
    jsonPath: esc(STORYBOARD_JSON),
  };
  // Only the template's own placeholders are substituted: film text (prompts in
  // params) may legitimately contain {{...}}, which must pass through verbatim.
  const keys = [...new Set([...STORYBOARD_TEMPLATE.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))];
  let html = STORYBOARD_TEMPLATE;
  for (const key of keys) {
    if (!(key in values)) throw new FilmkitError(toolFailure(`storyboard template: no value for placeholder {{${key}}}`));
    html = html.split(`{{${key}}}`).join(values[key]!);
  }
  return html;
}

function headerChips(sb: Storyboard): string[] {
  const s = sb.summary;
  const blockedNote = s.blocked ? ` · ${s.blocked} blocked` : "";
  return [
    `<li class="chip">${sb.output.width}×${sb.output.height} · ${sb.output.fps}fps · ${sb.output.container}</li>`,
    `<li class="chip"><b>${s.shots}</b> shots · ${s.ready} ready${blockedNote}</li>`,
    `<li class="chip">media <b>${s.media.present}/${s.media.total}</b> in place</li>`,
    `<li class="chip">${fmt(sb.timeline.total)}s · ${s.estimated} estimated</li>`,
    `<li class="chip">${s.missingFiles} missing files</li>`,
  ];
}

/** Proportional strip: blocks positioned by absolute time, so crossfades visibly overlap and gaps show as hatched runs. */
function stripHtml(sb: Storyboard): string {
  const total = sb.timeline.total;
  if (total <= 0) return "";
  const pct = (t: number) => `${Math.round((t / total) * 100000) / 1000}`;
  const blocks: string[] = [];
  for (const sc of sb.scenes) {
    if (sc.gapBefore > 0) {
      const left = sc.start - sc.gapBefore;
      blocks.push(`<span class="blk gap" style="left:${pct(left)}%;width:${pct(sc.gapBefore)}%" title="gap ${fmt(sc.gapBefore)}s"></span>`);
    }
    const cls = `blk ${sc.blocked ? "st-blocked" : `st-${sc.status}`}${sc.estimated ? " est" : ""}`;
    const label = `${sc.id} · ${fmt(sc.start)}–${fmt(sc.end)}s · ${sc.blocked ? "blocked" : sc.status}`;
    blocks.push(
      `<a class="${cls}" style="left:${pct(sc.start)}%;width:${pct(sc.duration)}%" href="#shot-${escAttr(sc.id)}" title="${escAttr(label)}">` +
        `<span class="sid">${esc(sc.id)}</span><span class="rng">${fmt(sc.start)}–${fmt(sc.end)}</span></a>`,
    );
  }
  return blocks.join("");
}

function sceneCard(sc: StoryboardScene): string {
  const num = String(sc.index + 1).padStart(2, "0");
  const stamps = [
    `<span class="stamp st-${sc.status}">${sc.status}</span>`,
    ...(sc.blocked ? [`<span class="stamp st-blocked">blocked</span>`] : []),
  ].join("");
  const tc =
    `${fmt(sc.start)} → ${fmt(sc.end)} · ${fmt(sc.duration)}s` +
    (sc.estimated ? ` <span class="est-mark">estimated</span>` : "");

  const intentBits: string[] = [];
  const it = sc.intent;
  if (it?.description) intentBits.push(`<p class="desc">${esc(it.description)}</p>`);
  if (it?.action) intentBits.push(`<p><span class="lbl">action</span>${esc(it.action)}</p>`);
  if (it?.narration?.text) intentBits.push(`<p><span class="lbl">narration</span>${esc(it.narration.text)}</p>`);
  if (it?.caption) intentBits.push(`<p><span class="lbl">caption</span>${esc(it.caption)}</p>`);
  const refs = [...(it?.references ?? []), ...(it?.narration?.voiceRef ? [it.narration.voiceRef] : [])];
  if (refs.length) {
    intentBits.push(`<div class="refs">${refs.map((r) => `<a href="#asset-${escAttr(r)}">${esc(r)}</a>`).join("")}</div>`);
  }
  const intent = intentBits.length ? `<div class="intent">${intentBits.join("")}</div>` : "";

  const metaInner = [
    `${esc(sc.profile.name)}@${esc(sc.profile.version)}`,
    `task ${esc(sc.task)}`,
    ...(sc.transition.type === "crossfade" ? [`↳ crossfade ${fmt(sc.transition.duration ?? 0)}s`] : []),
    ...(sc.gapBefore > 0 ? [`gap +${fmt(sc.gapBefore)}s`] : []),
    ...(sc.audio ? [`audio: ${esc(sc.audio)}${sc.audioMode ? ` (${esc(sc.audioMode)})` : ""}`] : []),
  ]
    .map((x) => `<span>${x}</span>`)
    .join("");
  const meta = `${metaInner}<span class="exec">${esc(sc.executor)}</span>`;

  const inputs = sc.inputs.length
    ? `<h4>inputs 输入</h4><div class="files"><ul>${sc.inputs.map(inputRow).join("")}</ul></div>`
    : "";
  const params = Object.keys(sc.params).length
    ? `<details class="params"><summary>impl.params</summary><pre>${esc(JSON.stringify(sc.params, null, 2))}</pre></details>`
    : "";

  return `<article class="card" id="shot-${escAttr(sc.id)}">
  <div class="chead">
    <div class="no">${num}</div>
    <div class="who"><h3>${esc(sc.id)}</h3><div class="tc">${tc}</div></div>
    <div>${stamps}</div>
  </div>
  ${intent}
  <h4>produces 产物</h4>
  ${sc.produces.map(mediaFigure).join("")}
  ${inputs}
  <div class="meta">${meta}</div>
  ${params}
</article>`;
}

function inputRow(m: StoryboardMedia & { id: string }): string {
  const mark = m.exists ? `<span class="io-ok">✓</span>` : `<span class="io-no">✗</span>`;
  const kind = m.kind ? ` <span>(${esc(m.kind)})</span>` : "";
  const target = m.href ? `<a href="${escAttr(m.href)}">${esc(m.path)}</a>` : `<span>${esc(m.path)}</span>`;
  return `<li>${mark} <code>${esc(m.id)}</code>${kind} → ${target}</li>`;
}

/** One media entry as a preview figure, or an explicit placeholder when the file is not there yet. */
function mediaFigure(m: StoryboardMedia): string {
  const caps = [
    `<code>${esc(m.path)}</code>`,
    ...(m.duration !== undefined ? [`${m.duration.toFixed(2)}s`] : []),
    ...(m.bytes !== undefined ? [humanBytes(m.bytes)] : []),
  ];
  const cap = `<figcaption>${caps.join(" · ")}</figcaption>`;
  if (!m.exists) {
    return `<div class="ph">尚未产出 · ${esc(m.kind ?? "file")}<small>${esc(m.path)}<br>not produced yet</small></div>`;
  }
  const href = escAttr(m.href ?? "");
  switch (m.kind) {
    case "image":
      return `<figure class="media"><img loading="lazy" src="${href}" alt="${escAttr(m.path)}">${cap}</figure>`;
    case "video":
      return `<figure class="media"><video controls preload="metadata" src="${href}"></video>${cap}</figure>`;
    case "audio":
      return `<figure class="media"><audio controls preload="metadata" src="${href}"></audio>${cap}</figure>`;
    case "subtitle":
      return m.text !== undefined
        ? `<figure class="media"><details class="srt"><summary>字幕文本 subtitles</summary><pre>${esc(m.text)}</pre></details>${cap}</figure>`
        : `<figure class="media"><a class="filelink" href="${href}">${esc(m.path)}</a>${cap}</figure>`;
    default:
      return `<figure class="media"><a class="filelink" href="${href}">${esc(m.path)}</a>${cap}</figure>`;
  }
}

function assetsSection(sb: Storyboard): string {
  if (!sb.assets.length) return "";
  const cards = sb.assets.map((a) => {
    const shown = a.source === "node" && a.status ? a.status : a.exists ? "ready" : "missing";
    const stamps = [
      `<span class="stamp st-${shown}">${shown}</span>`,
      ...(a.blocked ? [`<span class="stamp st-blocked">blocked</span>`] : []),
    ].join("");
    const meta = [
      `${esc(a.kind)} · ${a.source === "node" ? "generated" : "file"}`,
      ...(a.uri ? [esc(a.uri)] : []),
      ...(a.license ? [`license ${esc(a.license)}`] : []),
      ...(a.profile ? [`${esc(a.profile.name)}@${esc(a.profile.version)} · task ${esc(a.task ?? "")}`] : []),
    ]
      .map((x) => `<span>${x}</span>`)
      .join("");
    const exec = a.executor ? `<span class="exec">${esc(a.executor)}</span>` : "";
    const params = a.params && Object.keys(a.params).length
      ? `<details class="params"><summary>impl.params</summary><pre>${esc(JSON.stringify(a.params, null, 2))}</pre></details>`
      : "";
    return `<article class="card" id="asset-${escAttr(a.id)}">
  <div class="chead">
    <div class="who"><h3>${esc(a.id)}</h3><div class="tc">asset</div></div>
    <div>${stamps}</div>
  </div>
  ${a.media.map(mediaFigure).join("")}
  <div class="meta">${meta}${exec}</div>
  ${params}
</article>`;
  });
  return `<h2>资产 assets <span class="count">${sb.assets.length}</span></h2>
<div class="grid assets">${cards.join("\n")}</div>`;
}

function tracksSection(sb: Storyboard): string {
  if (!sb.tracks.length) return "";
  const rows = sb.tracks.map((t) => {
    const ref = t.kind === "subtitles" ? t.source : t.asset;
    const window = t.kind === "subtitles" ? "—" : `${fmt(t.from)} → ${t.to === "end" ? "end" : `${fmt(t.to)}s`}`;
    let settings: string;
    if (t.kind === "audio") {
      const bits = [`fit ${t.fit}`, `vol ${t.volume}`];
      if (t.fadeIn) bits.push(`fadeIn ${t.fadeIn}`);
      if (t.fadeOut) bits.push(`fadeOut ${t.fadeOut}`);
      if (t.cues) bits.push(`cues ${t.cues}`);
      settings = bits.map(esc).join(" · ");
    } else if (t.kind === "overlay") {
      settings = [t.position, `w ${t.width ?? "auto"}`, `op ${t.opacity}`].map(esc).join(" · ");
    } else {
      settings = `source ${esc(t.source)} · ${esc(t.mode)}`;
    }
    const media = t.media?.[0];
    const cell = !media
      ? ""
      : media.exists
        ? mediaFigure(media)
        : `<span class="io-no">✗</span> <code>${esc(media.path)}</code>`;
    return `<tr><td>${esc(t.id)}</td><td>${esc(t.kind)}</td><td>${window}</td><td>${esc(ref)}</td><td>${settings}</td><td>${cell}</td></tr>`;
  });
  return `<h2>轨道 tracks <span class="count">${sb.tracks.length}</span></h2>
<table class="tracks"><thead><tr><th>id</th><th>kind</th><th>window</th><th>ref</th><th>settings</th><th>media</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table>`;
}

function missingSection(sb: Storyboard): string {
  if (!sb.missingFiles.length) return "";
  const items = sb.missingFiles
    .map(
      (m) =>
        `<li><code>${esc(m.path)}</code><span class="fld">${esc(m.field)}</span><span class="who">${
          m.usedBy.length ? `needed by ${m.usedBy.map(esc).join(", ")}` : "declared but unused"
        }</span></li>`,
    )
    .join("");
  return `<h2>缺失文件 missing files <span class="count">${sb.missingFiles.length}</span></h2>
<ul class="missing">${items}</ul>`;
}

// ---------------------------------------------------------------- output

export interface StoryboardResult {
  data: Storyboard;
  json: string;
  html: string;
}

/**
 * Write both artifacts. Everything is rendered in memory first, then both files
 * go through .tmp + rename: a failure leaves the previous sheet intact and
 * never a truncated file (AGENTS.md rule 4). The lock is never written.
 */
export function writeStoryboard(a: Analysis): StoryboardResult {
  const data = makeStoryboard(a);
  const html = renderStoryboardHtml(data);
  const jsonText = JSON.stringify(data, null, 2) + "\n";
  const jsonAbs = resolve(a.loaded.dir, STORYBOARD_JSON);
  const htmlAbs = resolve(a.loaded.dir, STORYBOARD_HTML);
  const jsonTmp = `${jsonAbs}.tmp`;
  const htmlTmp = `${htmlAbs}.tmp`;
  try {
    mkdirSync(dirname(jsonAbs), { recursive: true });
    writeFileSync(jsonTmp, jsonText, "utf8");
    writeFileSync(htmlTmp, html, "utf8");
    renameSync(jsonTmp, jsonAbs);
    renameSync(htmlTmp, htmlAbs);
  } catch (err) {
    rmSync(jsonTmp, { force: true });
    rmSync(htmlTmp, { force: true });
    throw new FilmkitError(
      io(`cannot write storyboard artifacts: ${(err as Error).message}`, {
        hint: `targets: ${STORYBOARD_JSON}, ${STORYBOARD_HTML}`,
      }),
    );
  }
  return { data, json: STORYBOARD_JSON, html: STORYBOARD_HTML };
}

/** Text-mode summary; the per-shot detail lives in the sheet itself. */
export function formatStoryboard(sb: Storyboard): string {
  const s = sb.summary;
  const lines: string[] = [
    `storyboard: ${sb.artifacts.json} + ${sb.artifacts.html}`,
    `timeline: ${fmt(sb.timeline.total)}s · ${s.shots} shots: ${s.ready} ready, ${s.missing} missing, ${s.partial} partial, ${s.stale} stale · ${s.blocked} blocked · media ${s.media.present}/${s.media.total} in place · ${s.missingFiles} missing files`,
  ];
  for (const sc of sb.scenes) {
    const marks = sc.produces.map((p) => `${p.exists ? "✓" : "✗"} ${p.kind ?? "file"}`).join("  ");
    lines.push(`- ${sc.id.padEnd(14)} ${fmt(sc.start)} -> ${fmt(sc.end)}  ${(sc.blocked ? "blocked" : sc.status).padEnd(8)} ${marks}`);
  }
  if (s.missingFiles) for (const m of sb.missingFiles) lines.push(`- missing file  ${m.path} (${m.field})`);
  lines.push(`open ${sb.artifacts.html} in a browser to proof every shot`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- helpers

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

function escAttr(s: string): string {
  return esc(s);
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}