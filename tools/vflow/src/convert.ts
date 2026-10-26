// vflow bundle -> a new filmkit.yaml, plus the list of files that still have to
// be fetched. Pure and deterministic: the same bundle always yields the same
// text, byte for byte. Nothing here touches the disk or the network.
//
// What is taken (and where it goes):
//   shot description, prompts.video   -> scenes[].intent.description / .action
//   shot material images              -> assets[] (kind from MIME) + intent.references
//   pinned subject reference packs    -> assets[] + intent.references (approved entries only)
//   selected.video                    -> scenes[].produces.video (a ready clip), else a placeholder
// Everything else vflow knows is either kept as provenance in
// metadata.annotations or listed in `ignored`; filmkit's impl/params are never
// guessed — choosing a tool and writing its params is the agent's job.

import YAML from "yaml";
import { type Bundle, type Shot, type Subject, subjectKey } from "./bundle.ts";
import { fail, invalid } from "./errors.ts";

/** A shot with no durationFrames still needs a planned length; estimated, flagged, and `min` lets real media decide. */
export const DEFAULT_SHOT_SECONDS = 3;

export interface FetchItem {
  assetId: string;
  sha256: string;
  mimeType: string;
  sizeBytes: number;
  /** Film-relative paths (`./assets/...`) the bytes must land at. */
  targets: string[];
}

export interface Conversion {
  yaml: string;
  scenes: number;
  assets: number;
  fetch: FetchItem[];
  warnings: string[];
  /** vflow content this reader deliberately does not import. */
  ignored: string[];
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/ogg": "ogv",
};
const extOf = (mime: string): string => EXT[mime.toLowerCase()] ?? "bin";
const kindOf = (mime: string): "image" | "video" | "audio" | "file" => {
  const top = mime.toLowerCase().split("/")[0];
  return top === "image" || top === "video" || top === "audio" ? top : "file";
};

/** filmkit identifier: ^[a-z0-9][a-z0-9-]{0,62}$ (a local copy of the importers' slug on purpose: output must not shift if core changes it). */
function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return out === "" ? "item" : /^[a-z0-9]/.test(out) ? out : `x-${out}`;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function convertBundle(bundle: Bundle, source: string): Conversion {
  const { composition: comp } = bundle;
  const warnings: string[] = [];
  const used = new Set<string>(); // scene ids and asset names share one namespace in filmkit
  const assetNames = new Map<string, string>(); // vflow asset id -> film asset name
  const filmAssets: Record<string, { uri: string; kind: string }> = {};
  const fetchItems = new Map<string, FetchItem>();

  const manifestEntry = (assetId: string, field: string) => {
    const entry = bundle.assets.get(assetId);
    if (!entry) fail(invalid(`asset "${assetId}" is not in the bundle's asset manifest`, { field, hint: "export the composition from vflow again (the manifest lists every referenced asset)" }));
    return entry;
  };
  const wantFile = (assetId: string, target: string, field: string) => {
    const entry = manifestEntry(assetId, field);
    const item = fetchItems.get(assetId) ?? { assetId, sha256: entry.sha256, mimeType: entry.mimeType, sizeBytes: entry.sizeBytes, targets: [] };
    if (!item.targets.includes(target)) item.targets.push(target);
    fetchItems.set(assetId, item);
  };
  /** Register a reference image/asset once; returns its film asset name. */
  const useAsset = (assetId: string, field: string): string => {
    const known = assetNames.get(assetId);
    if (known) return known;
    const entry = manifestEntry(assetId, field);
    const name = uniqueId(`ref-${slug(assetId)}`.slice(0, 60), used);
    const uri = `./assets/vflow/${entry.sha256.slice(0, 16)}.${extOf(entry.mimeType)}`;
    assetNames.set(assetId, name);
    filmAssets[name] = { uri, kind: kindOf(entry.mimeType) };
    wantFile(assetId, uri, field);
    return name;
  };

  const sceneIds = comp.sequence.map((shotId, i) => {
    const s = slug(shotId);
    return uniqueId(s === "item" ? `shot-${String(i + 1).padStart(2, "0")}` : s, used);
  });

  const subjectNotes: Record<string, unknown> = {};
  const shotNotes: Record<string, unknown> = {};
  const scenes: unknown[] = [];
  const estimated: string[] = [];
  const skippedPack = new Set<string>();
  const skipped = { dependsOn: 0, candidateVideos: 0, candidateAudios: 0, referenceVideos: 0, selectedAudio: 0 };

  comp.sequence.forEach((shotId, i) => {
    const sceneId = sceneIds[i]!;
    const shot = comp.shots[shotId] as Shot;
    const at = `composition.shots.${shotId}`;

    // ---- shot materials ----
    const refs: string[] = [];
    const push = (name: string) => {
      if (!refs.includes(name)) refs.push(name);
    };
    const materials: unknown[] = [];
    const addMaterial = (list: Shot["references"], via: "references" | "candidates", field: string) => {
      list.forEach((m, j) => {
        const name = useAsset(m.asset, `${at}.${field}[${j}].asset`);
        push(name);
        materials.push({ ref: name, asset: m.asset, via, ...(m.role ? { role: m.role } : {}), ...(m.notes ? { notes: m.notes } : {}) });
      });
    };
    addMaterial(shot.references, "references", "references.images");
    addMaterial(shot.candidateImages, "candidates", "candidates.images");

    // ---- pinned subjects -> approved reference pack of the resolved variant ----
    const subjectUse: unknown[] = [];
    shot.subjects.forEach((b, j) => {
      const key = subjectKey(b.subjectId, b.subjectRevision);
      const subject = bundle.subjects.get(key) as Subject | undefined;
      const field = `${at}.subjects[${j}]`;
      if (!subject) fail(invalid(`subject ${key} is not in the bundle's dependencies`, { field, hint: "export the composition from vflow again (dependencies.subjects carries every pinned revision)" }));
      const variantNames = Object.keys(subject.variants);
      const variant = b.variant ?? subject.defaultVariant;
      let packRefs: unknown[] = [];
      if (variantNames.length > 0) {
        if (!variant || !subject.variants[variant]) {
          fail(invalid(`subject ${key} has no variant "${variant ?? "(none)"}" to resolve`, { field, hint: `variants: ${variantNames.join(", ")}` }));
        }
        packRefs = subject.variants[variant].referencePack.flatMap((e, k) => {
          if (e.status !== "approved") {
            skippedPack.add(key);
            return [];
          }
          const name = useAsset(e.asset, `dependencies.subjects.${key}.variants.${variant}.referencePack[${k}].asset`);
          push(name);
          return [{ ref: name, asset: e.asset, ...(e.view ? { view: e.view } : {}), ...(e.purpose ? { purpose: e.purpose } : {}) }];
        });
      }
      subjectNotes[key] ??= {
        name: subject.name,
        kind: subject.kind,
        ...(subject.description ? { description: subject.description } : {}),
        ...(subject.invariants.length ? { invariants: subject.invariants } : {}),
        ...(variantNames.length ? { variants: Object.fromEntries(variantNames.map((n) => [n, subject.variants[n]!.description])) } : {}),
      };
      subjectUse.push({ subject: key, ...(variant ? { variant } : {}), refs: packRefs });
    });

    // ---- selected video: a ready clip, else a placeholder the agent fills ----
    let videoExt = "mp4";
    let hasSelected = false;
    if (shot.selectedVideo) {
      const entry = manifestEntry(shot.selectedVideo, `${at}.selected.video`);
      if (kindOf(entry.mimeType) === "video") {
        videoExt = extOf(entry.mimeType);
        hasSelected = true;
        wantFile(shot.selectedVideo, `./assets/${sceneId}.${videoExt}`, `${at}.selected.video`);
      } else {
        warnings.push(`${at}.selected.video is ${entry.mimeType}, not a video; left as a placeholder`);
      }
    }

    // ---- duration ----
    let duration = DEFAULT_SHOT_SECONDS;
    if (shot.durationFrames && shot.durationFrames > 0) duration = round6(shot.durationFrames / comp.format.fps);
    else estimated.push(shotId);

    const intent: Record<string, unknown> = {};
    if (shot.description) intent.description = shot.description;
    if (shot.prompts.video) intent.action = shot.prompts.video;
    if (refs.length) intent.references = refs;
    scenes.push({
      id: sceneId,
      duration,
      durationPolicy: "min",
      ...(Object.keys(intent).length ? { intent } : {}),
      impl: { profile: "filmkit/static", task: "clip" },
      produces: { video: `./assets/${sceneId}.${videoExt}` },
    });

    const prompts = { ...(shot.prompts.image ? { image: shot.prompts.image } : {}), ...(shot.prompts.audio ? { audio: shot.prompts.audio } : {}) };
    shotNotes[sceneId] = {
      shot: shotId,
      ...(materials.length ? { materials } : {}),
      ...(subjectUse.length ? { subjects: subjectUse } : {}),
      ...(Object.keys(prompts).length ? { prompts } : {}),
      ...(hasSelected ? { selectedVideo: shot.selectedVideo } : {}),
    };

    skipped.dependsOn += shot.skipped.dependsOn;
    skipped.candidateVideos += shot.skipped.candidateVideos;
    skipped.candidateAudios += shot.skipped.candidateAudios;
    skipped.referenceVideos += shot.skipped.referenceVideos;
    skipped.selectedAudio += shot.skipped.selectedAudio;
  });

  if (estimated.length) {
    warnings.push(`${estimated.length} shot(s) have no durationFrames and are estimated at ${DEFAULT_SHOT_SECONDS}s (${estimated.join(", ")}); durationPolicy: min lets the produced clip decide`);
  }
  for (const key of [...skippedPack].sort()) warnings.push(`subject ${key}: candidate reference-pack entries were skipped (only approved ones are imported)`);
  if (bundle.generation === "v2" && comp.materials > 0) {
    warnings.push(`${comp.materials} pinned authoring material(s) are not imported (only subject reference packs are read)`);
  }

  const ignored: string[] = [];
  const note = (n: number, what: string) => {
    if (n > 0) ignored.push(`${what}: ${n}`);
  };
  note(comp.audioTracks, "audioTracks");
  note(skipped.candidateVideos, "candidates.videos");
  note(skipped.candidateAudios, "candidates.audios");
  note(skipped.referenceVideos, "references.videos");
  note(skipped.selectedAudio, "selected.audio");
  note(skipped.dependsOn, "dependsOn edges");
  note(Object.keys(comp.shots).length - comp.sequence.length, "shots not in sequence");

  const name = slug(comp.id);
  const film = {
    apiVersion: "filmkit/v1alpha1",
    kind: "Film",
    metadata: {
      name,
      title: comp.title ?? comp.id,
      annotations: {
        "vflow.source": { protocol: bundle.apiVersion, project: comp.project, composition: comp.id, ...(bundle.revision !== undefined ? { revision: bundle.revision } : {}) },
        ...(Object.keys(subjectNotes).length ? { "vflow.subjects": subjectNotes } : {}),
        "vflow.shots": shotNotes,
      },
    },
    profiles: [{ ref: "filmkit/static" }],
    assets: filmAssets,
    output: {
      container: "mp4",
      video: { width: comp.format.width, height: comp.format.height, fps: comp.format.fps, codec: "h264" },
      audio: { codec: "aac", sampleRate: 48000, channels: 2 },
    },
    scenes,
  };

  const header = `# Generated by \`vflow-pull\` from ${source}. Edit freely: filmkit never reads vflow again,\n# and never writes this file back. impl/params are yours to choose (see intent.references).\n`;
  return {
    yaml: header + YAML.stringify(film, { lineWidth: 0 }),
    scenes: scenes.length,
    assets: Object.keys(filmAssets).length,
    fetch: [...fetchItems.values()],
    warnings,
    ignored,
  };
}
