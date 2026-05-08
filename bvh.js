// BVH exporter (v2) — consumes per-frame solved rotations.

import { q } from "./quat.js";
import { JOINT_ORDER, PARENT } from "./solver.js";

function buildRestOffsets(calib) {
  const L = calib.lengths;
  const cm = (m) => m * 100;
  // Anatomical layout in BVH-cm. Y is up, X is right, Z is forward.
  // Hierarchy: Hips (origin) → Spine → Chest → Neck → Head
  //                        ↘ LeftShoulder → LeftArm → LeftForeArm → LeftHand
  //                        ↘ RightShoulder → ...
  //          Hips → LeftUpLeg → LeftLeg → LeftFoot → LeftToe
  //               → RightUpLeg → ...
  // Offsets are from parent's local origin to this joint's origin in
  // the rest pose. Local axis: +Y down the bone. So when a child has
  // its own bone, we put it along parent's +Y.
  // For "split" joints (clavicle), the geometric offset can be sideways.
  return {
    Hips:          [0, 0, 0],
    // Spine at midpoint of torso (split spine into two segments)
    Spine:         [0, cm(L.torso) * 0.5, 0],
    Chest:         [0, cm(L.torso) * 0.5, 0],
    Neck:          [0, cm(L.neck), 0],
    Head:          [0, cm(L.head), 0],

    // Shoulders: from chest, sideways (roughly anatomical)
    LeftShoulder:  [-cm(L.clav_L), 0, 0],
    LeftArm:       [0, 0, 0],
    LeftForeArm:   [0, cm(L.upperArm_L), 0],
    LeftHand:      [0, cm(L.foreArm_L), 0],

    RightShoulder: [cm(L.clav_R), 0, 0],
    RightArm:      [0, 0, 0],
    RightForeArm:  [0, cm(L.upperArm_R), 0],
    RightHand:     [0, cm(L.foreArm_R), 0],

    // Hips fan out sideways to UpLeg
    LeftUpLeg:     [-cm(L.pelvis_L), 0, 0],
    LeftLeg:       [0, cm(L.thigh_L), 0],
    LeftFoot:      [0, cm(L.shin_L), 0],
    LeftToe:       [0, cm(L.foot_L), 0],

    RightUpLeg:    [cm(L.pelvis_R), 0, 0],
    RightLeg:      [0, cm(L.thigh_R), 0],
    RightFoot:     [0, cm(L.shin_R), 0],
    RightToe:      [0, cm(L.foot_R), 0],
  };
}

const END_OFFSETS = {
  Head:      [0, 10, 0],
  LeftHand:  [0, -8, 0],
  RightHand: [0, -8, 0],
  LeftToe:   [0, 0, 5],
  RightToe:  [0, 0, 5],
};

function buildChildren() {
  const children = {};
  for (const j of JOINT_ORDER) children[j] = [];
  for (const j of JOINT_ORDER) {
    const p = PARENT[j];
    if (p) children[p].push(j);
  }
  return children;
}

function writeJoint(name, offsets, children, depth, lines, isRoot) {
  const indent = "  ".repeat(depth);
  const offset = offsets[name] || [0, 0, 0];
  if (isRoot) {
    lines.push(`ROOT ${name}`);
    lines.push(`{`);
    lines.push(`${indent}  OFFSET ${offset.map(x => x.toFixed(6)).join(" ")}`);
    lines.push(`${indent}  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation`);
  } else {
    lines.push(`${indent}JOINT ${name}`);
    lines.push(`${indent}{`);
    lines.push(`${indent}  OFFSET ${offset.map(x => x.toFixed(6)).join(" ")}`);
    lines.push(`${indent}  CHANNELS 3 Zrotation Xrotation Yrotation`);
  }
  const kids = children[name] || [];
  if (kids.length === 0) {
    const end = END_OFFSETS[name] || [0, 0, 5];
    lines.push(`${indent}  End Site`);
    lines.push(`${indent}  {`);
    lines.push(`${indent}    OFFSET ${end.map(x => x.toFixed(6)).join(" ")}`);
    lines.push(`${indent}  }`);
  } else {
    for (const c of kids) writeJoint(c, offsets, children, depth + 1, lines, false);
  }
  lines.push(`${indent}}`);
}

export function exportBVH(solved, fps, calib) {
  const offsets = buildRestOffsets(calib);
  const children = buildChildren();
  const lines = [];
  lines.push("HIERARCHY");
  writeJoint("Hips", offsets, children, 0, lines, true);
  lines.push("MOTION");
  lines.push(`Frames: ${solved.length}`);
  lines.push(`Frame Time: ${(1.0 / fps).toFixed(7)}`);

  for (const frame of solved) {
    const row = [];
    row.push((frame.hipPos[0] * 100).toFixed(4));
    row.push((frame.hipPos[1] * 100).toFixed(4));
    row.push((frame.hipPos[2] * 100).toFixed(4));
    for (const name of JOINT_ORDER) {
      const qq = frame.local[name] || q.identity();
      const [z, x, y] = q.toEulerZXY(qq);
      row.push(z.toFixed(4));
      row.push(x.toFixed(4));
      row.push(y.toFixed(4));
    }
    lines.push(row.join(" "));
  }
  return lines.join("\n");
}
