// Constrained Forward Kinematics solver
// Strategy: per frame, compute world-space joint orientations from a fixed
// rest skeleton + analytical 2-bone IK on each limb. Bones are rigid by
// construction, so end-effectors trace pure arcs.

import { LM, REST_POSE } from "./skeletonDef.js";
import { q, v } from "./quat.js";

// ---------- Calibration ----------
// Compute bone lengths + a clean rest skeleton from captured frames.

export function calibrateSkeleton(frames, userHeightM) {
  // Bones we track: pairs of landmark indices.
  // We compute the median length for each bone across high-confidence frames.
  const BONES = [
    ["torso",      "midHip",            "midShoulder"],
    ["neck",       "midShoulder",       "neckBase"],
    ["head",       "neckBase",          LM.NOSE],

    ["clav_L",     "midShoulder",       LM.LEFT_SHOULDER],
    ["upperArm_L", LM.LEFT_SHOULDER,    LM.LEFT_ELBOW],
    ["foreArm_L",  LM.LEFT_ELBOW,       LM.LEFT_WRIST],
    ["hand_L",     LM.LEFT_WRIST,       LM.LEFT_INDEX],

    ["clav_R",     "midShoulder",       LM.RIGHT_SHOULDER],
    ["upperArm_R", LM.RIGHT_SHOULDER,   LM.RIGHT_ELBOW],
    ["foreArm_R",  LM.RIGHT_ELBOW,      LM.RIGHT_WRIST],
    ["hand_R",     LM.RIGHT_WRIST,      LM.RIGHT_INDEX],

    ["pelvis_L",   "midHip",            LM.LEFT_HIP],
    ["thigh_L",    LM.LEFT_HIP,         LM.LEFT_KNEE],
    ["shin_L",     LM.LEFT_KNEE,        LM.LEFT_ANKLE],
    ["foot_L",     LM.LEFT_ANKLE,       LM.LEFT_FOOT_INDEX],

    ["pelvis_R",   "midHip",            LM.RIGHT_HIP],
    ["thigh_R",    LM.RIGHT_HIP,        LM.RIGHT_KNEE],
    ["shin_R",     LM.RIGHT_KNEE,       LM.RIGHT_ANKLE],
    ["foot_R",     LM.RIGHT_ANKLE,      LM.RIGHT_FOOT_INDEX],
  ];

  const samples = {};
  for (const [name] of BONES) samples[name] = [];

  for (const f of frames) {
    if (f.rest) continue;
    for (const [name, ai, bi] of BONES) {
      const a = getPoint(f, ai);
      const b = getPoint(f, bi);
      const sa = getScore(f, ai);
      const sb = getScore(f, bi);
      if (sa < 0.5 || sb < 0.5) continue;
      const L = v.len(v.sub(b, a));
      if (isFinite(L) && L > 0.01) samples[name].push(L);
    }
  }

  const lengths = {};
  for (const [name] of BONES) {
    const s = samples[name];
    if (s.length === 0) {
      lengths[name] = defaultLength(name);
      continue;
    }
    s.sort((a, b) => a - b);
    lengths[name] = s[Math.floor(s.length / 2)];
  }

  // Scale all lengths so total height = userHeightM.
  // Total height ≈ head + neck + torso + thigh + shin + foot height contribution.
  const measuredHeight =
    lengths.head + lengths.neck + lengths.torso +
    Math.max(lengths.thigh_L, lengths.thigh_R) +
    Math.max(lengths.shin_L, lengths.shin_R) +
    0.08; // ankle to floor
  const scale = userHeightM / Math.max(measuredHeight, 0.1);
  for (const k of Object.keys(lengths)) lengths[k] *= scale;

  return { lengths, scale };
}

function defaultLength(name) {
  // Sane fallbacks for a 1.75m person (in metres)
  const defaults = {
    torso: 0.50, neck: 0.12, head: 0.18,
    clav_L: 0.18, clav_R: 0.18,
    upperArm_L: 0.30, upperArm_R: 0.30,
    foreArm_L: 0.27, foreArm_R: 0.27,
    hand_L: 0.10, hand_R: 0.10,
    pelvis_L: 0.10, pelvis_R: 0.10,
    thigh_L: 0.45, thigh_R: 0.45,
    shin_L: 0.43, shin_R: 0.43,
    foot_L: 0.18, foot_R: 0.18,
  };
  return defaults[name] ?? 0.2;
}

// ---------- Helpers ----------

function getPoint(f, key) {
  if (typeof key === "number") {
    const p = f.points[key];
    return [p.x, p.y, p.z];
  }
  if (key === "midHip") {
    const a = f.points[LM.LEFT_HIP], b = f.points[LM.RIGHT_HIP];
    return [(a.x + b.x)/2, (a.y + b.y)/2, (a.z + b.z)/2];
  }
  if (key === "midShoulder") {
    const a = f.points[LM.LEFT_SHOULDER], b = f.points[LM.RIGHT_SHOULDER];
    return [(a.x + b.x)/2, (a.y + b.y)/2, (a.z + b.z)/2];
  }
  if (key === "neckBase") {
    const ms = getPoint(f, "midShoulder");
    const n = f.points[LM.NOSE];
    return [ms[0]*0.85 + n.x*0.15, ms[1]*0.85 + n.y*0.15, ms[2]*0.85 + n.z*0.15];
  }
  return [0, 0, 0];
}

function getScore(f, key) {
  if (typeof key === "number") return f.points[key].score;
  if (key === "midHip") {
    return Math.min(f.points[LM.LEFT_HIP].score, f.points[LM.RIGHT_HIP].score);
  }
  if (key === "midShoulder") {
    return Math.min(f.points[LM.LEFT_SHOULDER].score, f.points[LM.RIGHT_SHOULDER].score);
  }
  if (key === "neckBase") return getScore(f, "midShoulder");
  return 0;
}

// ---------- Per-frame solver ----------
// For each frame: compute root (hip) world position + a quaternion for each
// joint (parent-relative). Bones rigid; end-effectors must trace arcs.

const JOINT_ORDER = [
  "Hips","Spine","Chest","Neck","Head",
  "LeftShoulder","LeftArm","LeftForeArm","LeftHand",
  "RightShoulder","RightArm","RightForeArm","RightHand",
  "LeftUpLeg","LeftLeg","LeftFoot","LeftToe",
  "RightUpLeg","RightLeg","RightFoot","RightToe",
];

export function solveFrame(frame, calib) {
  // Targets in world space (where MediaPipe says each joint should be)
  const T = {
    midHip:      getPoint(frame, "midHip"),
    midShoulder: getPoint(frame, "midShoulder"),
    neckBase:    getPoint(frame, "neckBase"),
    head:        getPoint(frame, LM.NOSE),
    LS: getPoint(frame, LM.LEFT_SHOULDER),
    LE: getPoint(frame, LM.LEFT_ELBOW),
    LW: getPoint(frame, LM.LEFT_WRIST),
    LH: getPoint(frame, LM.LEFT_INDEX),
    RS: getPoint(frame, LM.RIGHT_SHOULDER),
    RE: getPoint(frame, LM.RIGHT_ELBOW),
    RW: getPoint(frame, LM.RIGHT_WRIST),
    RH: getPoint(frame, LM.RIGHT_INDEX),
    LHi: getPoint(frame, LM.LEFT_HIP),
    LK: getPoint(frame, LM.LEFT_KNEE),
    LA: getPoint(frame, LM.LEFT_ANKLE),
    LT: getPoint(frame, LM.LEFT_FOOT_INDEX),
    RHi: getPoint(frame, LM.RIGHT_HIP),
    RK: getPoint(frame, LM.RIGHT_KNEE),
    RA: getPoint(frame, LM.RIGHT_ANKLE),
    RT: getPoint(frame, LM.RIGHT_FOOT_INDEX),
  };

  // Hip world transform: position from midHip, orientation from
  // hip-line × spine-line.
  const hipPos = T.midHip.slice();
  const hipRight = v.norm(v.sub(T.RHi, T.LHi));    // +X (character right)
  const hipUpRaw = v.norm(v.sub(T.midShoulder, T.midHip)); // ~+Y
  // Make orthogonal: forward = right × up; up = forward × right
  const hipForward = v.norm(v.cross(hipRight, hipUpRaw));
  const hipUp      = v.norm(v.cross(hipForward, hipRight));
  const hipQ = qFromBasis(hipRight, hipUp, hipForward);

  // We solve in world space first (each segment's world quaternion),
  // then convert to parent-relative at the end.
  const W = {}; // world quaternion per joint
  W.Hips = hipQ;

  // Spine and chest: simple 1-bone solves up to neck base, split into
  // two segments evenly (Spine = half, Chest = half).
  const spineAxisRest = [0, 1, 0]; // rest direction = +Y in local hip frame
  const spineDirWorld = v.norm(v.sub(T.midShoulder, T.midHip));
  const spineQworld = qLookRotation(spineDirWorld, hipForward);
  W.Spine = spineQworld;
  W.Chest = spineQworld;

  // Neck and head
  const neckDir = v.norm(v.sub(T.neckBase, T.midShoulder));
  W.Neck = qLookRotation(neckDir, hipForward);
  const headDir = v.norm(v.sub(T.head, T.neckBase));
  W.Head = qLookRotation(headDir, hipForward);

  // Clavicles (just point shoulder direction)
  W.LeftShoulder  = qLookRotation(v.norm(v.sub(T.LS, T.midShoulder)), hipUp);
  W.RightShoulder = qLookRotation(v.norm(v.sub(T.RS, T.midShoulder)), hipUp);

  // Arms — analytical 2-bone IK.
  // We know upper arm length and forearm length (rigid). Given shoulder
  // position and wrist target, place elbow such that the bones stay
  // rigid AND the elbow pole points away from the chest.
  solveArm(W, T.LS, T.LE, T.LW, calib.lengths.upperArm_L, calib.lengths.foreArm_L, hipForward, "LeftArm", "LeftForeArm");
  solveArm(W, T.RS, T.RE, T.RW, calib.lengths.upperArm_R, calib.lengths.foreArm_R, hipForward, "RightArm", "RightForeArm");

  // Hands: orient toward index finger
  W.LeftHand  = qLookRotation(v.norm(v.sub(T.LH, T.LW)), hipUp);
  W.RightHand = qLookRotation(v.norm(v.sub(T.RH, T.RW)), hipUp);

  // Legs — analytical 2-bone IK
  solveArm(W, T.LHi, T.LK, T.LA, calib.lengths.thigh_L, calib.lengths.shin_L, [0,0,-1], "LeftUpLeg", "LeftLeg");
  solveArm(W, T.RHi, T.RK, T.RA, calib.lengths.thigh_R, calib.lengths.shin_R, [0,0,-1], "RightUpLeg", "RightLeg");

  // Feet: orient toward toe
  W.LeftFoot  = qLookRotation(v.norm(v.sub(T.LT, T.LA)), [0, 1, 0]);
  W.RightFoot = qLookRotation(v.norm(v.sub(T.RT, T.RA)), [0, 1, 0]);
  W.LeftToe   = W.LeftFoot;
  W.RightToe  = W.RightFoot;

  return { hipPos, world: W };
}

// 2-bone analytical IK.
// Given root, mid (current target — used only as pole hint), end, and
// the two bone lengths, compute the solver's preferred bend such that
// |root→mid|=L1 and |mid→end|=L2 exactly.
// Output: world quaternions for upper bone and lower bone.
function solveArm(W, root, midObs, end, L1, L2, poleHint, upperKey, lowerKey) {
  const total = v.sub(end, root);
  let totalLen = v.len(total);
  // Clamp: can't be longer than L1 + L2
  const maxLen = (L1 + L2) * 0.999;
  if (totalLen > maxLen) totalLen = maxLen;
  if (totalLen < 1e-6) {
    W[upperKey] = q.identity();
    W[lowerKey] = q.identity();
    return;
  }
  const dir = v.norm(total);

  // Law of cosines: angle at root between (root→mid) and (root→end)
  const cosA = (L1*L1 + totalLen*totalLen - L2*L2) / (2 * L1 * totalLen);
  const A = Math.acos(Math.min(1, Math.max(-1, cosA)));

  // Pole vector: from observed elbow, projected perpendicular to dir.
  // Falls back to poleHint if observation is degenerate.
  const obs = v.sub(midObs, root);
  const obsPerp = v.sub(obs, v.scale(dir, v.dot(obs, dir)));
  let pole;
  if (v.len(obsPerp) > 1e-4) {
    pole = v.norm(obsPerp);
  } else {
    // Use poleHint projected perpendicular
    const hp = v.sub(poleHint, v.scale(dir, v.dot(poleHint, dir)));
    pole = v.len(hp) > 1e-4 ? v.norm(hp) : v.norm(v.cross(dir, [0, 1, 0]));
  }

  // Upper bone direction: rotate `dir` toward `pole` by angle A
  const upperDir = v.norm(v.add(v.scale(dir, Math.cos(A)), v.scale(pole, Math.sin(A))));
  // Lower bone direction: from upper end to `end`
  const upperEnd = v.add(root, v.scale(upperDir, L1));
  const lowerDir = v.norm(v.sub(end, upperEnd));

  W[upperKey] = qLookRotation(upperDir, pole);
  W[lowerKey] = qLookRotation(lowerDir, pole);
}

// Build a quaternion that orients the local +Y axis along `dir` and
// keeps `up` in the local YZ plane (best-effort).
function qLookRotation(dir, up) {
  const y = v.norm(dir);
  let upn = v.norm(up);
  // Make `up` perpendicular to `y`
  const proj = v.dot(upn, y);
  let upPerp = v.sub(upn, v.scale(y, proj));
  if (v.len(upPerp) < 1e-4) {
    // up parallel to dir; pick any perpendicular
    upPerp = Math.abs(y[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const p2 = v.sub(upPerp, v.scale(y, v.dot(upPerp, y)));
    upPerp = p2;
  }
  const z = v.norm(upPerp);
  const x = v.norm(v.cross(y, z));
  // re-orthogonalize
  const z2 = v.norm(v.cross(x, y));
  return qFromBasis(x, y, z2);
}

// Quaternion from orthonormal basis (right=X, up=Y, forward=Z columns).
function qFromBasis(rX, rY, rZ) {
  // Build rotation matrix and convert to quaternion (Shoemake)
  const m00 = rX[0], m01 = rY[0], m02 = rZ[0];
  const m10 = rX[1], m11 = rY[1], m12 = rZ[1];
  const m20 = rX[2], m21 = rY[2], m22 = rZ[2];
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1.0) * 2;
    qw = 0.25 * S;
    qx = (m21 - m12) / S;
    qy = (m02 - m20) / S;
    qz = (m10 - m01) / S;
  } else if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1.0 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / S;
    qx = 0.25 * S;
    qy = (m01 + m10) / S;
    qz = (m02 + m20) / S;
  } else if (m11 > m22) {
    const S = Math.sqrt(1.0 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / S;
    qx = (m01 + m10) / S;
    qy = 0.25 * S;
    qz = (m12 + m21) / S;
  } else {
    const S = Math.sqrt(1.0 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / S;
    qx = (m02 + m20) / S;
    qy = (m12 + m21) / S;
    qz = 0.25 * S;
  }
  return q.normalize([qx, qy, qz, qw]);
}

// ---------- Hierarchy ----------
// Convert world quaternions to parent-relative.
const PARENT = {
  Hips: null,
  Spine: "Hips", Chest: "Spine", Neck: "Chest", Head: "Neck",
  LeftShoulder: "Chest", LeftArm: "LeftShoulder",
  LeftForeArm: "LeftArm", LeftHand: "LeftForeArm",
  RightShoulder: "Chest", RightArm: "RightShoulder",
  RightForeArm: "RightArm", RightHand: "RightForeArm",
  LeftUpLeg: "Hips", LeftLeg: "LeftUpLeg",
  LeftFoot: "LeftLeg", LeftToe: "LeftFoot",
  RightUpLeg: "Hips", RightLeg: "RightUpLeg",
  RightFoot: "RightLeg", RightToe: "RightFoot",
};

export function worldToLocal(world) {
  const local = {};
  for (const name of JOINT_ORDER) {
    const W = world[name] || q.identity();
    const p = PARENT[name];
    if (!p) {
      local[name] = W;
    } else {
      const Wp = world[p] || q.identity();
      // local = inverse(parent_world) * world
      local[name] = q.mul(q.inv(Wp), W);
    }
  }
  return local;
}

export { JOINT_ORDER, PARENT };
