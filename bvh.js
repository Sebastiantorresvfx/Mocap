// BVH exporter
// Strategy: define a humanoid hierarchy, compute bone direction vectors
// per frame from MediaPipe landmarks, derive ZYX Euler rotations from
// the bone direction relative to its rest direction.
//
// This produces a valid BVH that opens in Blender, Maya, Cascadeur,
// MotionBuilder, etc. Root translation is exported but optional (lock toggle).

import { LM, REST_POSE } from "./skeletonDef.js";

// Joint definitions for BVH hierarchy.
// Each joint: name, parent landmark index (or null for ROOT/Hips synthesis),
// and the landmark it represents (for position lookup).
//
// Rest offsets are computed from REST_POSE.

const HIPS = "Hips";

// Hierarchy:
// Hips (root) -> Spine -> Chest -> Neck -> Head
// Hips -> Chest -> LeftShoulder -> LeftArm -> LeftForeArm -> LeftHand
// Hips -> Chest -> RightShoulder -> RightArm -> RightForeArm -> RightHand
// Hips -> LeftUpLeg -> LeftLeg -> LeftFoot -> LeftToeBase
// Hips -> RightUpLeg -> RightLeg -> RightFoot -> RightToeBase

// Each entry: { name, parent, head, tail }
// "head" is the landmark index for the joint position itself (or "midHip", "midShoulder")
// "tail" is the landmark index of the child end (used for direction)
const BONES = [
  { name: "Hips",          parent: null,            head: "midHip",      tail: "midShoulder" },
  { name: "Spine",         parent: "Hips",          head: "midHip",      tail: "midShoulder" },
  { name: "Chest",         parent: "Spine",         head: "midShoulder", tail: "neck" },
  { name: "Neck",          parent: "Chest",         head: "neck",        tail: LM.NOSE },
  { name: "Head",          parent: "Neck",          head: LM.NOSE,       tail: "headTop" },

  { name: "LeftShoulder",  parent: "Chest",         head: "midShoulder", tail: LM.LEFT_SHOULDER },
  { name: "LeftArm",       parent: "LeftShoulder",  head: LM.LEFT_SHOULDER, tail: LM.LEFT_ELBOW },
  { name: "LeftForeArm",   parent: "LeftArm",       head: LM.LEFT_ELBOW, tail: LM.LEFT_WRIST },
  { name: "LeftHand",      parent: "LeftForeArm",   head: LM.LEFT_WRIST, tail: LM.LEFT_INDEX },

  { name: "RightShoulder", parent: "Chest",         head: "midShoulder", tail: LM.RIGHT_SHOULDER },
  { name: "RightArm",      parent: "RightShoulder", head: LM.RIGHT_SHOULDER, tail: LM.RIGHT_ELBOW },
  { name: "RightForeArm",  parent: "RightArm",      head: LM.RIGHT_ELBOW, tail: LM.RIGHT_WRIST },
  { name: "RightHand",     parent: "RightForeArm",  head: LM.RIGHT_WRIST, tail: LM.RIGHT_INDEX },

  { name: "LeftUpLeg",     parent: "Hips",          head: LM.LEFT_HIP,   tail: LM.LEFT_KNEE },
  { name: "LeftLeg",       parent: "LeftUpLeg",     head: LM.LEFT_KNEE,  tail: LM.LEFT_ANKLE },
  { name: "LeftFoot",      parent: "LeftLeg",       head: LM.LEFT_ANKLE, tail: LM.LEFT_FOOT_INDEX },
  { name: "LeftToeBase",   parent: "LeftFoot",      head: LM.LEFT_FOOT_INDEX, tail: null },

  { name: "RightUpLeg",    parent: "Hips",          head: LM.RIGHT_HIP,   tail: LM.RIGHT_KNEE },
  { name: "RightLeg",      parent: "RightUpLeg",    head: LM.RIGHT_KNEE,  tail: LM.RIGHT_ANKLE },
  { name: "RightFoot",     parent: "RightLeg",      head: LM.RIGHT_ANKLE, tail: LM.RIGHT_FOOT_INDEX },
  { name: "RightToeBase",  parent: "RightFoot",     head: LM.RIGHT_FOOT_INDEX, tail: null },
];

// helpers ---------------------------------------------------------------
function getPoint(frame, key) {
  if (typeof key === "number") {
    const p = frame.points[key];
    return [p.x, p.y, p.z];
  }
  if (key === "midHip") {
    const a = frame.points[LM.LEFT_HIP], b = frame.points[LM.RIGHT_HIP];
    return [(a.x + b.x)/2, (a.y + b.y)/2, (a.z + b.z)/2];
  }
  if (key === "midShoulder") {
    const a = frame.points[LM.LEFT_SHOULDER], b = frame.points[LM.RIGHT_SHOULDER];
    return [(a.x + b.x)/2, (a.y + b.y)/2, (a.z + b.z)/2];
  }
  if (key === "neck") {
    // ~25% from midShoulder toward nose
    const ms = getPoint(frame, "midShoulder");
    const n = frame.points[LM.NOSE];
    return [ms[0]*0.85 + n.x*0.15, ms[1]*0.85 + n.y*0.15, ms[2]*0.85 + n.z*0.15];
  }
  if (key === "headTop") {
    // extend nose direction up
    const n = frame.points[LM.NOSE];
    const ms = getPoint(frame, "midShoulder");
    const dx = n.x - ms[0], dy = n.y - ms[1], dz = n.z - ms[2];
    return [n.x + dx*0.4, n.y + dy*0.4, n.z + dz*0.4];
  }
  return [0,0,0];
}

function getRestPoint(key) {
  if (typeof key === "number") return REST_POSE[key];
  if (key === "midHip") {
    const a = REST_POSE[LM.LEFT_HIP], b = REST_POSE[LM.RIGHT_HIP];
    return [(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
  }
  if (key === "midShoulder") {
    const a = REST_POSE[LM.LEFT_SHOULDER], b = REST_POSE[LM.RIGHT_SHOULDER];
    return [(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
  }
  if (key === "neck") {
    const ms = getRestPoint("midShoulder");
    const n = REST_POSE[LM.NOSE];
    return [ms[0]*0.85 + n[0]*0.15, ms[1]*0.85 + n[1]*0.15, ms[2]*0.85 + n[2]*0.15];
  }
  if (key === "headTop") {
    const n = REST_POSE[LM.NOSE];
    const ms = getRestPoint("midShoulder");
    const d = [n[0]-ms[0], n[1]-ms[1], n[2]-ms[2]];
    return [n[0]+d[0]*0.4, n[1]+d[1]*0.4, n[2]+d[2]*0.4];
  }
  return [0,0,0];
}

function sub(a,b){ return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function len(v){ return Math.hypot(v[0], v[1], v[2]) || 1e-9; }
function norm(v){ const l = len(v); return [v[0]/l, v[1]/l, v[2]/l]; }
function cross(a,b){ return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }

// Build a 3x3 rotation matrix from rest-direction r to current-direction c.
// Returns matrix in row-major.
function rotFromTo(r, c) {
  const a = norm(r), b = norm(c);
  const v = cross(a, b);
  const s = len(v);
  const co = dot(a, b);
  if (s < 1e-6) {
    if (co > 0) return [1,0,0, 0,1,0, 0,0,1];
    // 180° flip — rotate around any perpendicular axis
    let perp = Math.abs(a[0]) < 0.9 ? [1,0,0] : [0,1,0];
    const axis = norm(cross(a, perp));
    return rotAxisAngle(axis, Math.PI);
  }
  const axis = [v[0]/s, v[1]/s, v[2]/s];
  const angle = Math.atan2(s, co);
  return rotAxisAngle(axis, angle);
}

function rotAxisAngle(axis, theta) {
  const c = Math.cos(theta), s = Math.sin(theta), C = 1 - c;
  const [x,y,z] = axis;
  return [
    c + x*x*C,    x*y*C - z*s, x*z*C + y*s,
    y*x*C + z*s, c + y*y*C,    y*z*C - x*s,
    z*x*C - y*s, z*y*C + x*s, c + z*z*C
  ];
}

function matMul(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      r[i*3+j] = a[i*3]*b[j] + a[i*3+1]*b[3+j] + a[i*3+2]*b[6+j];
  return r;
}

function matTranspose(m) {
  return [m[0],m[3],m[6], m[1],m[4],m[7], m[2],m[5],m[8]];
}

// Extract ZYX intrinsic Euler angles (degrees) from rotation matrix
// BVH typical channel order Zrot Xrot Yrot — we'll output as Z X Y rotation order
// which is what most BVH consumers (Blender, Maya) handle natively.
function matToEulerZXY(m) {
  // For ZXY intrinsic order: R = Rz * Rx * Ry
  // Standard derivation
  const sx = -m[5]; // -m[1][2]? careful with row-major
  // Using row-major where m[row*3+col]:
  // m[0]=R00 m[1]=R01 m[2]=R02
  // m[3]=R10 m[4]=R11 m[5]=R12
  // m[6]=R20 m[7]=R21 m[8]=R22
  // For intrinsic ZXY: R = Rz(z) * Rx(x) * Ry(y)
  // R02 =  cos(x)*sin(y)
  // R12 = -sin(x)
  // R22 =  cos(x)*cos(y)
  // R10 =  sin(z)*cos(x) ...  let me use a robust formula.
  const R02 = m[2], R12 = m[5], R22 = m[8];
  const R10 = m[3], R11 = m[4];
  const R01 = m[1];

  let x = Math.asin(-Math.max(-1, Math.min(1, R12)));
  let y, z;
  if (Math.abs(R12) < 0.9999) {
    y = Math.atan2(R02, R22);
    z = Math.atan2(R10, R11);
  } else {
    y = 0;
    z = Math.atan2(-R01, m[0]);
  }
  const D = 180 / Math.PI;
  return [z * D, x * D, y * D];
}

// ----------------------------------------------------------------------
// HIERARCHY building
// ----------------------------------------------------------------------
function buildHierarchy() {
  const byName = new Map();
  for (const b of BONES) byName.set(b.name, { ...b, children: [] });
  for (const b of byName.values()) {
    if (b.parent) byName.get(b.parent).children.push(b);
  }
  return byName;
}

function computeOffset(b, byName) {
  // offset from parent head to this head, in rest pose
  if (!b.parent) return [0, 0, 0];
  const parent = byName.get(b.parent);
  const parentHead = getRestPoint(parent.head);
  const myHead = getRestPoint(b.head);
  return [
    (myHead[0] - parentHead[0]) * 100,   // BVH typically uses cm
    (myHead[1] - parentHead[1]) * 100,
    (myHead[2] - parentHead[2]) * 100,
  ];
}

function computeEndOffset(b) {
  if (!b.tail) return [0, 0, 5];   // small stub
  const head = getRestPoint(b.head);
  const tail = getRestPoint(b.tail);
  return [
    (tail[0] - head[0]) * 100,
    (tail[1] - head[1]) * 100,
    (tail[2] - head[2]) * 100,
  ];
}

function writeJoint(b, byName, depth, lines) {
  const indent = "  ".repeat(depth);
  const isRoot = b.name === "Hips";
  const offset = computeOffset(b, byName);

  if (isRoot) {
    lines.push(`ROOT ${b.name}`);
    lines.push(`{`);
    lines.push(`${indent}  OFFSET 0.000000 0.000000 0.000000`);
    lines.push(`${indent}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`);
  } else {
    lines.push(`${indent}JOINT ${b.name}`);
    lines.push(`${indent}{`);
    lines.push(`${indent}  OFFSET ${offset.map(v => v.toFixed(6)).join(" ")}`);
    lines.push(`${indent}  CHANNELS 3 Zrotation Xrotation Yrotation`);
  }

  // Children (or End Site if leaf)
  if (b.children.length === 0) {
    const end = computeEndOffset(b);
    lines.push(`${indent}  End Site`);
    lines.push(`${indent}  {`);
    lines.push(`${indent}    OFFSET ${end.map(v => v.toFixed(6)).join(" ")}`);
    lines.push(`${indent}  }`);
  } else {
    for (const child of b.children) writeJoint(child, byName, depth + 1, lines);
  }

  lines.push(`${indent}}`);
}

// ----------------------------------------------------------------------
// MOTION computation
// ----------------------------------------------------------------------

// For each frame, compute a global rotation per joint (as 3x3 matrix),
// then convert each to local rotation = parent_global^-1 * this_global.
function computeFrameRotations(frame, byName) {
  const globals = new Map();   // name -> 3x3 matrix
  const order = ["Hips","Spine","Chest","Neck","Head",
    "LeftShoulder","LeftArm","LeftForeArm","LeftHand",
    "RightShoulder","RightArm","RightForeArm","RightHand",
    "LeftUpLeg","LeftLeg","LeftFoot","LeftToeBase",
    "RightUpLeg","RightLeg","RightFoot","RightToeBase"];

  for (const name of order) {
    const b = byName.get(name);
    if (!b.tail) {
      // leaf with no tail (toe end) — inherit parent's rotation
      globals.set(name, globals.get(b.parent) || identity());
      continue;
    }
    const restDir = sub(getRestPoint(b.tail), getRestPoint(b.head));
    const curDir = sub(getPoint(frame, b.tail), getPoint(frame, b.head));
    if (len(curDir) < 1e-6) {
      globals.set(name, globals.get(b.parent) || identity());
      continue;
    }
    const R = rotFromTo(restDir, curDir);
    globals.set(name, R);
  }

  // local rotations
  const locals = new Map();
  for (const name of order) {
    const b = byName.get(name);
    const G = globals.get(name);
    if (!b.parent) {
      locals.set(name, G);
    } else {
      const Pg = globals.get(b.parent);
      const Pinv = matTranspose(Pg);   // rotation matrix inverse = transpose
      locals.set(name, matMul(Pinv, G));
    }
  }
  return locals;
}

function identity() { return [1,0,0, 0,1,0, 0,0,1]; }

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------
export function exportBVH(frames, fps) {
  const byName = buildHierarchy();
  const root = byName.get("Hips");

  const lines = [];
  lines.push("HIERARCHY");
  writeJoint(root, byName, 0, lines);
  lines.push("MOTION");
  lines.push(`Frames: ${frames.length}`);
  lines.push(`Frame Time: ${(1.0 / fps).toFixed(7)}`);

  const order = ["Hips","Spine","Chest","Neck","Head",
    "LeftShoulder","LeftArm","LeftForeArm","LeftHand",
    "RightShoulder","RightArm","RightForeArm","RightHand",
    "LeftUpLeg","LeftLeg","LeftFoot","LeftToeBase",
    "RightUpLeg","RightLeg","RightFoot","RightToeBase"];

  for (const f of frames) {
    const locals = computeFrameRotations(f, byName);
    const row = [];
    // Hips position (cm)
    const hipPos = getPoint(f, "midHip");
    row.push((hipPos[0] * 100).toFixed(4));
    row.push((hipPos[1] * 100).toFixed(4));
    row.push((hipPos[2] * 100).toFixed(4));

    for (const name of order) {
      const M = locals.get(name);
      const [z, x, y] = matToEulerZXY(M);
      row.push(z.toFixed(4));
      row.push(x.toFixed(4));
      row.push(y.toFixed(4));
    }
    lines.push(row.join(" "));
  }

  return lines.join("\n");
}
