// Types for blockout-core.js (the plain-JS module the Three.js project ships verbatim).

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export interface Pose { pos: Vec3; quat: Quat }

export type ShapeType = "box" | "cylinder" | "sphere" | "capsule";
export type Shape =
  | { type: "box"; size: Vec3 }
  | { type: "cylinder"; radius: number; height: number }
  | { type: "sphere"; radius: number }
  | { type: "capsule"; radius: number; height: number };
export interface RawMesh { positions: Vec3[]; faces: number[][]; smooth: boolean }
export type NodeShape = Shape | { type: "mesh"; mesh: RawMesh };

export type Interp = "linear" | "hold" | "smooth";

export interface SceneKeyframe {
  frame: number;
  interp?: Interp;
  pos?: Vec3;
  rot?: Vec3;
  joints?: Record<string, Vec3>;
}
export interface CameraKeyframe {
  frame: number;
  interp?: Interp;
  pos?: Vec3;
  target?: Vec3;
  focalLength?: number;
  roll?: number;
}
export interface Binding { id: string; revision: string }
/** A subject or prop's upstream identity; variant = the costume/state it stands in for. */
export interface EntityBinding extends Binding { variant?: string }
export interface EnvironmentBinding { id?: string; revision?: string; variant?: string }

export interface BlockoutScene {
  apiVersion: "blockout/v1alpha1";
  kind: "BlockoutScene";
  id: string;
  binding: {
    composition: Binding;
    shot?: Binding;
    scene?: Binding;
    environment?: EnvironmentBinding;
  };
  timing: { fps: number; durationFrames: number };
  frame: { width: number; height: number };
  environment?: {
    background?: string;
    floor?: { size: [number, number]; center?: [number, number]; color?: string };
    walls?: { id: string; from: [number, number]; to: [number, number]; height: number; thickness: number; color?: string }[];
    blocks?: { id: string; shape: Shape; pos: Vec3; rotZ?: number; color?: string }[];
  };
  subjects?: {
    id: string;
    binding: EntityBinding;
    kind: "humanoid" | "capsule";
    height: number;
    radius?: number;
    color?: string;
    shadow?: boolean;
    keyframes: SceneKeyframe[];
  }[];
  props?: {
    id: string;
    binding: EntityBinding;
    shape: Shape;
    color?: string;
    keyframes?: SceneKeyframe[];
    attach?: { subject: string; joint: string; from: number; to: number; offset?: Vec3; rot?: Vec3 }[];
  }[];
  camera: { sensorWidth?: number; keyframes: CameraKeyframe[] };
  overview?: { frame?: number; pos?: Vec3; target?: Vec3; focalLength?: number };
  stills?: number[];
}

type Keys = { frame: number; value: number[]; interp: Interp }[] | null;

export interface CompiledNode {
  id: string;
  group: "environment" | "subject" | "shadow" | "prop" | "helper";
  ref?: string;
  shape: NodeShape;
  color: string;
  dynamic?: boolean;
  static?: Pose;
}
export interface RigPart { name: string; joint: string | null; shape: Shape; offset: Vec3 }
export interface CompiledSubject {
  id: string;
  kind: "humanoid" | "capsule";
  height: number;
  shadow: boolean;
  rig: { joints: { name: string; parent: string | null; offset: Vec3 }[]; points: { name: string; parent: string; offset: Vec3 }[]; parts: RigPart[] } | null;
  parts: RigPart[];
  pos: Keys;
  rot: Keys;
  joints: Record<string, Keys>;
}
export interface CompiledProp {
  id: string;
  shape: Shape;
  pos: Keys;
  rot: Keys;
  attach: { subject: string; joint: string; from: number; to: number; offset: Vec3; rot: Vec3 }[];
}
export interface CompiledScene {
  id: string;
  fps: number;
  durationFrames: number;
  width: number;
  height: number;
  background: string;
  nodes: CompiledNode[];
  subjects: CompiledSubject[];
  props: CompiledProp[];
  camera: { sensorWidth: number; pos: Keys; target: Keys; focalLength: Keys; roll: Keys };
  overview: { frame: number; pos: Vec3 | null; target: Vec3 | null; focalLength: number | null };
}
export interface CameraState {
  pos: Vec3;
  quat: Quat;
  target: Vec3;
  focalLength: number;
  roll: number;
  fovY: number;
  sensorWidth: number;
}
export interface SubjectFrames {
  root: Pose;
  joints: Record<string, Pose>;
  points: Record<string, Pose>;
}
export interface Evaluated {
  time: number;
  frame: number;
  camera: CameraState;
  nodes: Record<string, Pose>;
  frames: Record<string, SubjectFrames>;
}

export const PROTOCOL: "blockout/v1alpha1";
export const JOINTS: string[];
export const ATTACH_POINTS: string[];
export const SHAPE_TYPES: string[];
export const INTERPS: string[];

export function compileScene(scene: BlockoutScene): CompiledScene;
export function evaluate(c: CompiledScene, t: number): Evaluated;
export function freePropPose(c: CompiledScene, propId: string, frame: number): Pose;
export function overviewCamera(c: CompiledScene): CameraState;
export function overviewHelpers(c: CompiledScene): CompiledNode[];
export function meshForShape(shape: NodeShape): RawMesh;
export function buildMesh(shape: Shape): RawMesh;
export function humanoidRig(height: number): NonNullable<CompiledSubject["rig"]>;
export function shapeHalfExtents(shape: Shape): Vec3;
export function lowestZ(shape: Shape, pose: Pose): number;
export function eulerToQuat(rot: Vec3): Quat;
export function qmul(a: Quat, b: Quat): Quat;
export function qrotate(q: Quat, v: Vec3): Vec3;
export function snapFrame(f: number): number;
export function frameAtTime(c: CompiledScene, t: number): number;
export function timeAtFrame(c: CompiledScene, f: number): number;
export function vadd(a: Vec3, b: Vec3): Vec3;
export function vsub(a: Vec3, b: Vec3): Vec3;
export function vscale(a: Vec3, s: number): Vec3;
export function vdot(a: Vec3, b: Vec3): number;
export function vcross(a: Vec3, b: Vec3): Vec3;
export function vlen(a: Vec3): number;
export function vnorm(a: Vec3): Vec3;
